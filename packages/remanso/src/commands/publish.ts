import * as fs from "node:fs/promises";
import { command, flag } from "cmd-ts";
import { log, spinner } from "@clack/prompts";
import * as path from "node:path";
import { findConfig, loadConfig, loadState, saveState } from "../lib/config";
import {
	loadCredentials,
	listAllCredentials,
	getCredentials,
} from "../../../cli/src/lib/credentials";
import {
	createAgent,
	createDocument,
	updateDocument,
	uploadImage,
	resolveImagePath,
	deleteRecord,
	listDocuments,
} from "../../../cli/src/lib/atproto";
import {
	scanContentDirectory,
	getContentHash,
	updateFrontmatterWithAtUri,
	resolvePostPath,
} from "../../../cli/src/lib/markdown";
import type {
	BlogPost,
	BlobObject,
	AppPasswordCredentials,
} from "../../../cli/src/lib/types";
import { exitOnCancel } from "../../../cli/src/lib/prompts";
import {
	createNote,
	updateNote,
	deleteNote,
	findPostsWithStaleLinks,
	type NoteOptions,
} from "../../../cli/src/extensions/remanso";

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function selectIdentity(): Promise<AppPasswordCredentials | null> {
	const { select } = await import("@clack/prompts");
	const identities = await listAllCredentials();

	if (identities.length === 0) {
		log.error(
			"No credentials found. Run 'remanso auth' to set up an App Password.",
		);
		process.exit(1);
	}

	// Filter to app-password only (remanso doesn't support OAuth)
	const appPasswordIds = identities.filter((c) => c.type === "app-password");
	if (appPasswordIds.length === 0) {
		log.error(
			"No App Password credentials found. Run 'remanso auth' to set up one.",
		);
		log.info("Note: OAuth credentials are not supported by remanso.");
		process.exit(1);
	}

	if (appPasswordIds.length === 1 && appPasswordIds[0]) {
		return await getCredentials(appPasswordIds[0].id);
	}

	log.info("Multiple identities found. Select one to use:");
	const selected = exitOnCancel(
		await select({
			message: "Identity:",
			options: appPasswordIds.map((c) => ({
				value: c.id,
				label: `${c.id} (App Password)`,
			})),
		}),
	);

	return await getCredentials(selected);
}

export const publishCommand = command({
	name: "publish",
	description: "Publish .pub.md notes to ATProto / Remanso",
	args: {
		force: flag({
			long: "force",
			short: "f",
			description: "Force publish all notes, ignoring change detection",
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
			log.error("No remanso.json found. Run 'remanso init' first.");
			process.exit(1);
		}

		const { config, configPath: resolvedConfigPath } =
			await loadConfig(configPath);
		const configDir = path.dirname(resolvedConfigPath);

		log.info(`Content directory: ${config.contentDir}`);
		log.info(`Publication: ${config.publicationUri}`);

		// Load credentials (app-password only)
		let credentials = await loadCredentials(config.identity);

		if (credentials?.type === "oauth") {
			log.error(
				"OAuth credentials are not supported by remanso. Run 'remanso auth' to set up an App Password.",
			);
			process.exit(1);
		}

		if (!credentials) {
			credentials = await selectIdentity();
		}

		if (!credentials) {
			log.error("Failed to load credentials.");
			process.exit(1);
		}

		const appCreds = credentials as AppPasswordCredentials;

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

		// Scan for posts (all .md files), then filter to .pub.md
		const s = spinner();
		s.start("Scanning for notes...");
		const allScanned = await scanContentDirectory(contentDir, {
			ignorePatterns: config.ignore,
		});
		const posts = allScanned.filter((p) => p.filePath.endsWith(".pub.md"));
		s.stop(`Found ${posts.length} publishable notes (.pub.md)`);

		// Detect deleted files: state entries whose local files no longer exist
		const scannedPaths = new Set(
			posts.map((p) => path.relative(configDir, p.filePath)),
		);
		const deletedEntries: Array<{ filePath: string; atUri: string }> = [];

		for (const [filePath, postState] of Object.entries(state.posts)) {
			if (!scannedPaths.has(filePath) && postState.atUri) {
				const absolutePath = path.resolve(configDir, filePath);
				if (!(await fileExists(absolutePath))) {
					deletedEntries.push({ filePath, atUri: postState.atUri });
				}
			}
		}

		// Detect unmatched PDS records
		const unmatchedEntries: Array<{ atUri: string; title: string }> = [];

		// Shared agent — created lazily
		let agent: Awaited<ReturnType<typeof createAgent>> | undefined;
		async function getAgent(): Promise<
			Awaited<ReturnType<typeof createAgent>>
		> {
			if (agent) return agent;

			s.start(`Connecting as ${appCreds.pdsUrl}...`);
			try {
				agent = await createAgent(appCreds);
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
				postsToPublish.push({
					post,
					action: post.frontmatter.atUri ? "update" : "create",
					reason: "content changed",
				});
			}
		}

		if (draftPosts.length > 0) {
			log.info(
				`Skipping ${draftPosts.length} draft note${draftPosts.length === 1 ? "" : "s"}`,
			);
		}

		// Fetch PDS records to detect unmatched documents
		async function fetchUnmatchedRecords() {
			const ag = await getAgent();
			s.start("Fetching documents from PDS...");
			const pdsDocuments = await listDocuments(ag, config.publicationUri);
			s.stop(`Found ${pdsDocuments.length} documents on PDS`);

			const pathPrefix = "/posts";
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
				log.success("All notes are up to date. Nothing to publish.");
				return;
			}
		}

		if (postsToPublish.length > 0) {
			log.info(`\n${postsToPublish.length} notes to publish:\n`);

			for (const { post, action, reason } of postsToPublish) {
				const icon = action === "create" ? "+" : "~";
				let postUrl = "";
				if (verbose) {
					postUrl = `\n  ${post.filePath}`;
				}
				log.message(`  ${icon} ${post.filePath} (${reason})${postUrl}`);
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
			log.info("\nDry run complete. No changes made.");
			return;
		}

		// Ensure agent is connected
		await getAgent();

		if (!agent) {
			throw new Error("agent is not connected");
		}

		// Derive siteUrl from DID
		const siteUrl = `https://remanso.space/pub/${agent.did}`;
		log.info(`Site URL: ${siteUrl}`);

		// Fetch PDS records to detect unmatched documents (if not already done)
		if (unmatchedEntries.length === 0) {
			await fetchUnmatchedRecords();
		}

		// Build the publisher config object for createDocument/updateDocument
		const publisherConfig = {
			siteUrl,
			contentDir,
			publicationUri: config.publicationUri,
			imagesDir,
			pdsUrl: config.pdsUrl,
			pathPrefix: "",
		};

		// Publish posts
		let publishedCount = 0;
		let updatedCount = 0;
		let errorCount = 0;

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

				let atUri: string;
				let contentForHash: string;
				const relativeFilePath = path.relative(configDir, post.filePath);

				if (action === "create") {
					atUri = await createDocument(
						agent,
						post,
						publisherConfig as Parameters<typeof createDocument>[2],
						coverImage,
					);
					post.frontmatter.atUri = atUri;
					s.stop(`Created: ${atUri}`);

					// Update frontmatter with atUri
					const updatedContent = updateFrontmatterWithAtUri(
						post.rawContent,
						atUri,
					);
					await fs.writeFile(post.filePath, updatedContent);
					log.info(`  Updated frontmatter in ${path.basename(post.filePath)}`);

					contentForHash = updatedContent;
					publishedCount++;
				} else {
					atUri = post.frontmatter.atUri!;
					await updateDocument(
						agent,
						post,
						atUri,
						publisherConfig as Parameters<typeof updateDocument>[3],
						coverImage,
					);
					s.stop(`Updated: ${atUri}`);

					contentForHash = post.rawContent;
					updatedCount++;
				}

				// Update state
				const contentHash = await getContentHash(contentForHash);
				state.posts[relativeFilePath] = {
					contentHash,
					atUri,
					lastPublished: new Date().toISOString(),
					slug: post.slug,
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

		// Pass 2: Create/update Remanso notes
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

		// Re-process already-published posts with stale links
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

		// Delete unmatched PDS records
		let unmatchedDeletedCount = 0;
		for (const { atUri, title } of unmatchedEntries) {
			try {
				const ag = await getAgent();
				s.start(`Deleting unmatched: ${title}`);
				await deleteRecord(ag, atUri);

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
		if (errorCount > 0) {
			log.warn(`Errors: ${errorCount}`);
		}
	},
});
