import * as fs from "node:fs/promises";
import { command, flag } from "cmd-ts";
import { select, spinner, log } from "@clack/prompts";
import * as path from "node:path";
import { loadConfig, loadState, saveState, findConfig } from "../lib/config";
import {
	loadCredentials,
	listAllCredentials,
	getCredentials,
} from "../lib/credentials";
import { getOAuthHandle, getOAuthSession } from "../lib/oauth-store";
import {
	createAgent,
	createDocument,
	updateDocument,
	uploadImage,
	resolveImagePath,
	createBlueskyPost,
	addBskyPostRefToDocument,
	deleteRecord,
	listDocuments,
} from "../lib/atproto";
import {
	scanContentDirectory,
	getContentHash,
	updateFrontmatterWithAtUri,
	resolvePostPath,
} from "../lib/markdown";
import type { BlogPost, BlobObject, StrongRef } from "../lib/types";
import { exitOnCancel } from "../lib/prompts";
import {
	createNote,
	updateNote,
	deleteNote,
	findPostsWithStaleLinks,
	type NoteOptions,
} from "../extensions/remanso";
import { fileExists } from "../lib/utils";

export const publishCommand = command({
	name: "publish",
	description: "Publish content to ATProto",
	args: {
		force: flag({
			long: "force",
			short: "f",
			description: "Force publish all posts, ignoring change detection",
		}),
		dryRun: flag({
			long: "dry-run",
			short: "n",
			description: "Preview what would be published without making changes",
		}),
		verbose: flag({
			long: "verbose",
			short: "v",
			description: "Show more information",
		}),
	},
	handler: async ({ force, dryRun, verbose }) => {
		// Load config
		const configPath = await findConfig();
		if (!configPath) {
			log.error("No publisher.config.ts found. Run 'publisher init' first.");
			process.exit(1);
		}

		const config = await loadConfig(configPath);
		const configDir = path.dirname(configPath);

		log.info(`Site: ${config.siteUrl}`);
		log.info(`Content directory: ${config.contentDir}`);

		// Load credentials
		let credentials = await loadCredentials(config.identity);

		// If no credentials resolved, check if we need to prompt for identity selection
		if (!credentials) {
			const identities = await listAllCredentials();
			if (identities.length === 0) {
				log.error(
					"No credentials found. Run 'sequoia login' or 'sequoia auth' first.",
				);
				log.info(
					"Or set ATP_IDENTIFIER and ATP_APP_PASSWORD environment variables.",
				);
				process.exit(1);
			}

			// Build labels with handles for OAuth sessions
			const options = await Promise.all(
				identities.map(async (cred) => {
					if (cred.type === "oauth") {
						const handle = await getOAuthHandle(cred.id);
						return {
							value: cred.id,
							label: `${handle || cred.id} (OAuth)`,
						};
					}
					return {
						value: cred.id,
						label: `${cred.id} (App Password)`,
					};
				}),
			);

			// Multiple identities exist but none selected - prompt user
			log.info("Multiple identities found. Select one to use:");
			const selected = exitOnCancel(
				await select({
					message: "Identity:",
					options,
				}),
			);

			// Load the selected credentials
			const selectedCred = identities.find((c) => c.id === selected);
			if (selectedCred?.type === "oauth") {
				const session = await getOAuthSession(selected);
				if (session) {
					const handle = await getOAuthHandle(selected);
					credentials = {
						type: "oauth",
						did: selected,
						handle: handle || selected,
					};
				}
			} else {
				credentials = await getCredentials(selected);
			}

			if (!credentials) {
				log.error("Failed to load selected credentials.");
				process.exit(1);
			}

			const displayId =
				credentials.type === "oauth"
					? credentials.handle || credentials.did
					: credentials.identifier;
			log.info(
				`Tip: Add "identity": "${displayId}" to sequoia.json to use this by default.`,
			);
		}

		// Resolve content directory
		const contentDir = path.isAbsolute(config.contentDir)
			? config.contentDir
			: path.join(configDir, config.contentDir);

		const imagesDir = config.imagesDir
			? path.isAbsolute(config.imagesDir)
				? config.imagesDir
				: path.join(configDir, config.imagesDir)
			: undefined;

		// Load state
		const state = await loadState(configDir);

		// Scan for posts
		const s = spinner();
		s.start("Scanning for posts...");
		const posts = await scanContentDirectory(contentDir, {
			frontmatterMapping: config.frontmatter,
			ignorePatterns: config.ignore,
			slugField: config.frontmatter?.slugField,
			removeIndexFromSlug: config.removeIndexFromSlug,
			stripDatePrefix: config.stripDatePrefix,
		});
		s.stop(`Found ${posts.length} posts`);

		// Detect deleted files: state entries whose local files no longer exist
		const scannedPaths = new Set(
			posts.map((p) => path.relative(configDir, p.filePath)),
		);
		const deletedEntries: Array<{ filePath: string; atUri: string }> = [];

		for (const [filePath, postState] of Object.entries(state.posts)) {
			if (!scannedPaths.has(filePath) && postState.atUri) {
				// Check if the file truly doesn't exist (not just excluded by ignore patterns)
				const absolutePath = path.resolve(configDir, filePath);
				if (!(await fileExists(absolutePath))) {
					deletedEntries.push({ filePath, atUri: postState.atUri });
				}
			}
		}

		// Detect unmatched PDS records: exist on PDS but have no matching local file
		const unmatchedEntries: Array<{ atUri: string; title: string }> = [];

		// Shared agent — created lazily, reused across deletion and publishing
		let agent: Awaited<ReturnType<typeof createAgent>> | undefined;
		async function getAgent(): Promise<
			Awaited<ReturnType<typeof createAgent>>
		> {
			if (agent) return agent;

			if (!credentials) {
				throw new Error("credentials not found");
			}

			const connectingTo =
				credentials.type === "oauth" ? credentials.handle : credentials.pdsUrl;
			s.start(`Connecting as ${connectingTo}...`);
			try {
				agent = await createAgent(credentials);
				s.stop(`Logged in as ${agent.did}`);
				return agent;
			} catch (error) {
				s.stop("Failed to login");
				log.error(`Failed to login: ${error}`);
				process.exit(1);
			}
		}

		// Determine which posts need publishing
		const postsToPublish: Array<{
			post: BlogPost;
			action: "create" | "update";
			reason: "content changed" | "forced" | "new post" | "missing state";
		}> = [];
		const draftPosts: BlogPost[] = [];

		for (const post of posts) {
			// Skip draft posts
			if (post.frontmatter.draft) {
				draftPosts.push(post);
				continue;
			}

			const contentHash = await getContentHash(post.rawContent);
			const relativeFilePath = path.relative(configDir, post.filePath);
			const postState = state.posts[relativeFilePath];

			if (force) {
				postsToPublish.push({
					post,
					action: post.frontmatter.atUri ? "update" : "create",
					reason: "forced",
				});
			} else if (!postState) {
				postsToPublish.push({
					post,
					action: post.frontmatter.atUri ? "update" : "create",
					reason: post.frontmatter.atUri ? "missing state" : "new post",
				});
			} else if (postState.contentHash !== contentHash) {
				// Changed post
				postsToPublish.push({
					post,
					action: post.frontmatter.atUri ? "update" : "create",
					reason: "content changed",
				});
			}
		}

		if (draftPosts.length > 0) {
			log.info(
				`Skipping ${draftPosts.length} draft post${draftPosts.length === 1 ? "" : "s"}`,
			);
		}

		// Fetch PDS records and detect unmatched documents
		async function fetchUnmatchedRecords() {
			const ag = await getAgent();
			s.start("Fetching documents from PDS...");
			const pdsDocuments = await listDocuments(ag, config.publicationUri);
			s.stop(`Found ${pdsDocuments.length} documents on PDS`);

			const pathPrefix = config.pathPrefix || "/posts";
			const postsByPath = new Map<string, BlogPost>();
			for (const post of posts) {
				postsByPath.set(`${pathPrefix}/${post.slug}`, post);
			}
			const deletedAtUris = new Set(deletedEntries.map((e) => e.atUri));
			for (const doc of pdsDocuments) {
				if (!postsByPath.has(doc.value.path) && !deletedAtUris.has(doc.uri)) {
					unmatchedEntries.push({
						atUri: doc.uri,
						title: doc.value.title || doc.value.path,
					});
				}
			}
		}

		if (postsToPublish.length === 0 && deletedEntries.length === 0) {
			await fetchUnmatchedRecords();

			if (unmatchedEntries.length === 0) {
				log.success("All posts are up to date. Nothing to publish.");
				return;
			}
		}

		// Bluesky posting configuration
		const blueskyEnabled = config.bluesky?.enabled ?? false;
		const maxAgeDays = config.bluesky?.maxAgeDays ?? 7;
		const cutoffDate = new Date();
		cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);

		if (postsToPublish.length > 0) {
			log.info(`\n${postsToPublish.length} posts to publish:\n`);

			for (const { post, action, reason } of postsToPublish) {
				const icon = action === "create" ? "+" : "~";
				const relativeFilePath = path.relative(configDir, post.filePath);
				const existingBskyPostRef = state.posts[relativeFilePath]?.bskyPostRef;

				let bskyNote = "";
				if (blueskyEnabled) {
					if (existingBskyPostRef) {
						bskyNote = " [bsky: exists]";
					} else {
						const publishDate = new Date(post.frontmatter.publishDate);
						if (publishDate < cutoffDate) {
							bskyNote = ` [bsky: skipped, older than ${maxAgeDays} days]`;
						} else {
							bskyNote = " [bsky: will post]";
						}
					}
				}

				let postUrl = "";
				if (verbose) {
					const postPath = resolvePostPath(
						post,
						config.pathPrefix,
						config.pathTemplate,
					);
					postUrl = `\n ${config.siteUrl}${postPath}`;
				}
				log.message(
					`  ${icon} ${post.filePath} (${reason})${bskyNote}${postUrl}`,
				);
			}
		}

		if (deletedEntries.length > 0) {
			log.info(
				`\n${deletedEntries.length} deleted local files to remove from PDS:\n`,
			);
			for (const { filePath } of deletedEntries) {
				log.message(`  - ${filePath}`);
			}
		}

		if (unmatchedEntries.length > 0) {
			log.info(
				`\n${unmatchedEntries.length} unmatched PDS records to delete:\n`,
			);
			for (const { title } of unmatchedEntries) {
				log.message(`  - ${title}`);
			}
		}

		if (dryRun) {
			if (blueskyEnabled) {
				log.info(`\nBluesky posting: enabled (max age: ${maxAgeDays} days)`);
			}
			log.info("\nDry run complete. No changes made.");
			return;
		}

		// Ensure agent is connected
		await getAgent();

		if (!agent) {
			throw new Error("agent is not connected");
		}

		// Fetch PDS records to detect unmatched documents (if not already done)
		if (unmatchedEntries.length === 0) {
			await fetchUnmatchedRecords();
		}

		// Publish posts
		let publishedCount = 0;
		let updatedCount = 0;
		let errorCount = 0;
		let bskyPostCount = 0;

		const context: NoteOptions = {
			contentDir,
			imagesDir,
			allPosts: posts,
		};

		// Pass 1: Create/update document records and collect note queue
		const noteQueue: Array<{
			post: BlogPost;
			action: "create" | "update";
			atUri: string;
		}> = [];

		for (const { post, action } of postsToPublish) {
			const trimmedContent = post.content.trim();
			const titleMatch = trimmedContent.match(/^# (.+)$/m);
			const title = titleMatch ? titleMatch[1] : post.frontmatter.title;
			s.start(`Publishing: ${title}`);

			// Init publish date
			if (!post.frontmatter.publishDate) {
				const [publishDate] = new Date().toISOString().split("T");
				post.frontmatter.publishDate = publishDate!;
			}

			try {
				// Handle cover image upload
				let coverImage: BlobObject | undefined;
				if (post.frontmatter.ogImage) {
					const imagePath = await resolveImagePath(
						post.frontmatter.ogImage,
						imagesDir,
						contentDir,
					);

					if (imagePath) {
						log.info(`  Uploading cover image: ${path.basename(imagePath)}`);
						coverImage = await uploadImage(agent, imagePath);
						if (coverImage) {
							log.info(`  Uploaded image blob: ${coverImage.ref.$link}`);
						}
					} else {
						log.warn(`  Cover image not found: ${post.frontmatter.ogImage}`);
					}
				}

				// Track atUri, content for state saving, and bskyPostRef
				let atUri: string;
				let contentForHash: string;
				let bskyPostRef: StrongRef | undefined;
				const relativeFilePath = path.relative(configDir, post.filePath);

				// Check if bskyPostRef already exists in state
				const existingBskyPostRef = state.posts[relativeFilePath]?.bskyPostRef;

				if (action === "create") {
					atUri = await createDocument(agent, post, config, coverImage);
					post.frontmatter.atUri = atUri;
					s.stop(`Created: ${atUri}`);

					// Update frontmatter with atUri
					const updatedContent = updateFrontmatterWithAtUri(
						post.rawContent,
						atUri,
					);
					await fs.writeFile(post.filePath, updatedContent);
					log.info(`  Updated frontmatter in ${path.basename(post.filePath)}`);

					// Use updated content (with atUri) for hash so next run sees matching hash
					contentForHash = updatedContent;
					publishedCount++;
				} else {
					atUri = post.frontmatter.atUri!;
					await updateDocument(agent, post, atUri, config, coverImage);
					s.stop(`Updated: ${atUri}`);

					// For updates, rawContent already has atUri
					contentForHash = post.rawContent;
					updatedCount++;
				}

				// Create Bluesky post if enabled and conditions are met
				if (blueskyEnabled) {
					if (existingBskyPostRef) {
						log.info(`  Bluesky post already exists, skipping`);
						bskyPostRef = existingBskyPostRef;
					} else {
						const publishDate = new Date(post.frontmatter.publishDate);

						if (publishDate < cutoffDate) {
							log.info(
								`  Post is older than ${maxAgeDays} days, skipping Bluesky post`,
							);
						} else {
							// Create Bluesky post
							try {
								const canonicalUrl = `${config.siteUrl}${resolvePostPath(post, config.pathPrefix, config.pathTemplate)}`;

								bskyPostRef = await createBlueskyPost(agent, {
									title: post.frontmatter.title,
									description: post.frontmatter.description,
									bskyPost: post.frontmatter.bskyPost,
									canonicalUrl,
									coverImage,
									publishedAt: post.frontmatter.publishDate,
								});

								// Update document record with bskyPostRef
								await addBskyPostRefToDocument(agent, atUri, bskyPostRef);
								log.info(`  Created Bluesky post: ${bskyPostRef.uri}`);
								bskyPostCount++;
							} catch (bskyError) {
								const errorMsg =
									bskyError instanceof Error
										? bskyError.message
										: String(bskyError);
								log.warn(`  Failed to create Bluesky post: ${errorMsg}`);
							}
						}
					}
				}

				// Update state (use relative path from config directory)
				const contentHash = await getContentHash(contentForHash);
				state.posts[relativeFilePath] = {
					contentHash,
					atUri,
					lastPublished: new Date().toISOString(),
					slug: post.slug,
					bskyPostRef,
				};

				noteQueue.push({ post, action, atUri });
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				s.stop(`Error publishing "${path.basename(post.filePath)}"`);
				log.error(`  ${errorMessage}`);
				errorCount++;
			}
		}

		// Pass 2: Create/update Remanso notes (atUris are now available for link resolution)
		for (const { post, action, atUri } of noteQueue) {
			try {
				if (action === "create") {
					await createNote(agent, post, atUri, context);
				} else {
					await updateNote(agent, post, atUri, context);
				}
			} catch (error) {
				log.warn(
					`Failed to create note for "${post.frontmatter.title}": ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		// Re-process already-published posts with stale links to newly created posts
		const newlyCreatedSlugs = noteQueue
			.filter((r) => r.action === "create")
			.map((r) => r.post.slug);

		if (newlyCreatedSlugs.length > 0) {
			const batchFilePaths = new Set(noteQueue.map((r) => r.post.filePath));
			const stalePosts = findPostsWithStaleLinks(
				posts,
				newlyCreatedSlugs,
				batchFilePaths,
			);

			for (const stalePost of stalePosts) {
				try {
					s.start(`Updating links in: ${stalePost.frontmatter.title}`);
					await updateNote(
						agent,
						stalePost,
						stalePost.frontmatter.atUri!,
						context,
					);
					s.stop(`Updated links: ${stalePost.frontmatter.title}`);
				} catch (error) {
					s.stop(`Failed to update links: ${stalePost.frontmatter.title}`);
					log.warn(
						`  ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		}

		// Delete records for removed files
		let deletedCount = 0;
		for (const { filePath, atUri } of deletedEntries) {
			try {
				const ag = await getAgent();
				s.start(`Deleting: ${filePath}`);
				await deleteRecord(ag, atUri);

				// Try to delete the corresponding Remanso note
				try {
					const noteAtUri = atUri.replace(
						"site.standard.document",
						"space.remanso.note",
					);
					await deleteNote(ag, noteAtUri);
				} catch {
					// Note may not exist, ignore
				}

				delete state.posts[filePath];
				s.stop(`Deleted: ${filePath}`);
				deletedCount++;
			} catch (error) {
				s.stop(`Failed to delete: ${filePath}`);
				log.warn(`  ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		// Delete unmatched PDS records (exist on PDS but no matching local file)
		let unmatchedDeletedCount = 0;
		for (const { atUri, title } of unmatchedEntries) {
			try {
				const ag = await getAgent();
				s.start(`Deleting unmatched: ${title}`);
				await deleteRecord(ag, atUri);

				// Try to delete the corresponding Remanso note
				try {
					const noteAtUri = atUri.replace(
						"site.standard.document",
						"space.remanso.note",
					);
					await deleteNote(ag, noteAtUri);
				} catch {
					// Note may not exist, ignore
				}

				s.stop(`Deleted unmatched: ${title}`);
				unmatchedDeletedCount++;
			} catch (error) {
				s.stop(`Failed to delete: ${title}`);
				log.warn(`  ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		// Save state
		await saveState(configDir, state);

		// Summary
		log.message("\n---");
		const totalDeleted = deletedCount + unmatchedDeletedCount;
		if (totalDeleted > 0) {
			log.info(`Deleted: ${totalDeleted}`);
		}
		log.info(`Published: ${publishedCount}`);
		log.info(`Updated: ${updatedCount}`);
		if (bskyPostCount > 0) {
			log.info(`Bluesky posts: ${bskyPostCount}`);
		}
		if (errorCount > 0) {
			log.warn(`Errors: ${errorCount}`);
		}
	},
});
