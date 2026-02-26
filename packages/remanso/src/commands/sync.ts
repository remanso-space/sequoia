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
import type { Agent } from "@atproto/api";
import { createAgent, listDocuments } from "../../../cli/src/lib/atproto";
import type { ListDocumentsResult } from "../../../cli/src/lib/atproto";
import type { BlogPost, AppPasswordCredentials } from "../../../cli/src/lib/types";
import {
	scanContentDirectory,
	getContentHash,
	getTextContent,
	updateFrontmatterWithAtUri,
} from "../../../cli/src/lib/markdown";
import { exitOnCancel } from "../../../cli/src/lib/prompts";

async function matchesPDS(
	localPost: BlogPost,
	doc: ListDocumentsResult,
	agent: Agent,
): Promise<boolean> {
	// Compare body text content
	const localTextContent = getTextContent(localPost, undefined);
	if (localTextContent.slice(0, 10000) !== doc.value.textContent) {
		return false;
	}

	// Compare document fields: title, description, tags
	const trimmedContent = localPost.content.trim();
	const titleMatch = trimmedContent.match(/^# (.+)$/m);
	const localTitle = titleMatch ? titleMatch[1] : localPost.frontmatter.title;
	if (localTitle !== doc.value.title) return false;

	const localDescription = localPost.frontmatter.description || undefined;
	if (localDescription !== doc.value.description) return false;

	const localTags =
		localPost.frontmatter.tags && localPost.frontmatter.tags.length > 0
			? localPost.frontmatter.tags
			: undefined;
	if (JSON.stringify(localTags) !== JSON.stringify(doc.value.tags)) {
		return false;
	}

	// Compare note-specific fields: theme, fontSize, fontFamily
	const noteUriMatch = doc.uri.match(/^at:\/\/([^/]+)\/[^/]+\/(.+)$/);
	if (noteUriMatch) {
		const repo = noteUriMatch[1]!;
		const rkey = noteUriMatch[2]!;
		try {
			const noteResponse = await agent.com.atproto.repo.getRecord({
				repo,
				collection: "space.remanso.note",
				rkey,
			});
			const noteValue = noteResponse.data.value as Record<string, unknown>;
			const localDiscoverable = localPost.frontmatter.discoverable ?? true;
			const noteDiscoverable = (noteValue.discoverable as boolean | undefined) ?? true;
			if (
				(localPost.frontmatter.theme || undefined) !==
					(noteValue.theme as string | undefined) ||
				(localPost.frontmatter.fontSize || undefined) !==
					(noteValue.fontSize as number | undefined) ||
				(localPost.frontmatter.fontFamily || undefined) !==
					(noteValue.fontFamily as string | undefined) ||
				localDiscoverable !== noteDiscoverable
			) {
				return false;
			}
		} catch {
			// Note record doesn't exist — treat as matching
		}
	}

	return true;
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

	const appPasswordIds = identities.filter((c) => c.type === "app-password");
	if (appPasswordIds.length === 0) {
		log.error(
			"No App Password credentials found. Run 'remanso auth' to set up one.",
		);
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

export const syncCommand = command({
	name: "sync",
	description: "Sync state from ATProto to restore .remanso-state.json",
	args: {
		updateFrontmatter: flag({
			long: "update-frontmatter",
			short: "u",
			description: "Update frontmatter atUri fields in local markdown files",
		}),
		dryRun: flag({
			long: "dry-run",
			short: "n",
			description: "Preview what would be synced without making changes",
		}),
	},
	handler: async ({ updateFrontmatter, dryRun }) => {
		// Load config
		const configPath = await findConfig();
		if (!configPath) {
			log.error("No remanso.json found. Run 'remanso init' first.");
			process.exit(1);
		}

		const { config, configPath: resolvedConfigPath } =
			await loadConfig(configPath);
		const configDir = path.dirname(resolvedConfigPath);

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

		// Create agent
		const s = spinner();
		s.start(`Connecting as ${(credentials as AppPasswordCredentials).pdsUrl}...`);
		let agent: Awaited<ReturnType<typeof createAgent>> | undefined;
		try {
			agent = await createAgent(credentials);
			s.stop(`Logged in as ${agent.did}`);
		} catch (error) {
			s.stop("Failed to login");
			log.error(`Failed to login: ${error}`);
			process.exit(1);
		}

		// Fetch documents from PDS
		s.start("Fetching documents from PDS...");
		const documents = await listDocuments(agent, config.publicationUri);
		s.stop(`Found ${documents.length} documents on PDS`);

		if (documents.length === 0) {
			log.info("No documents found for this publication.");
			return;
		}

		// Resolve content directory
		const contentDir = path.isAbsolute(config.contentDir)
			? config.contentDir
			: path.join(configDir, config.contentDir);

		// Scan local posts (all .md), then filter to .pub.md
		s.start("Scanning local content...");
		const allScanned = await scanContentDirectory(contentDir, {
			ignorePatterns: config.ignore,
		});
		const localPosts = allScanned.filter((p) =>
			p.filePath.endsWith(".pub.md"),
		);
		s.stop(`Found ${localPosts.length} publishable notes (.pub.md)`);

		// Build a map of path -> local post for matching
		// Use "/posts" prefix (same default as publish command)
		const pathPrefix = "/posts";
		const postsByPath = new Map<string, (typeof localPosts)[0]>();
		for (const post of localPosts) {
			postsByPath.set(`${pathPrefix}/${post.slug}`, post);
		}

		// Load existing state
		const state = await loadState(configDir);
		const originalPostCount = Object.keys(state.posts).length;

		// Track changes
		let matchedCount = 0;
		let unmatchedCount = 0;
		const frontmatterUpdates: Array<{ filePath: string; atUri: string }> = [];

		log.message("\nMatching documents to local files:\n");

		for (const doc of documents) {
			const docPath = doc.value.path;
			const localPost = postsByPath.get(docPath);

			if (localPost) {
				matchedCount++;
				log.message(`  ✓ ${doc.value.title}`);
				log.message(`    Path: ${docPath}`);
				log.message(`    URI: ${doc.uri}`);
				log.message(`    File: ${path.basename(localPost.filePath)}`);

				const contentMatchesPDS = await matchesPDS(localPost, doc, agent);
				const contentHash = contentMatchesPDS
					? await getContentHash(localPost.rawContent)
					: "";
				const relativeFilePath = path.relative(configDir, localPost.filePath);
				state.posts[relativeFilePath] = {
					contentHash,
					atUri: doc.uri,
					lastPublished: doc.value.publishedAt,
				};

				// Check if frontmatter needs updating
				if (updateFrontmatter && localPost.frontmatter.atUri !== doc.uri) {
					frontmatterUpdates.push({
						filePath: localPost.filePath,
						atUri: doc.uri,
					});
					log.message(`    → Will update frontmatter`);
				}
			} else {
				unmatchedCount++;
				log.message(`  ✗ ${doc.value.title} (no matching local file)`);
				log.message(`    Path: ${docPath}`);
				log.message(`    URI: ${doc.uri}`);
			}
			log.message("");
		}

		// Summary
		log.message("---");
		log.info(`Matched: ${matchedCount} documents`);
		if (unmatchedCount > 0) {
			log.warn(
				`Unmatched: ${unmatchedCount} documents (exist on PDS but not locally)`,
			);
			log.info(
				`Run 'remanso publish' to delete unmatched records from your PDS.`,
			);
		}

		if (dryRun) {
			log.info("\nDry run complete. No changes made.");
			return;
		}

		// Save updated state
		await saveState(configDir, state);
		const newPostCount = Object.keys(state.posts).length;
		log.success(
			`\nSaved .remanso-state.json (${originalPostCount} → ${newPostCount} entries)`,
		);

		// Update frontmatter if requested
		if (frontmatterUpdates.length > 0) {
			s.start(`Updating frontmatter in ${frontmatterUpdates.length} files...`);
			for (const { filePath, atUri } of frontmatterUpdates) {
				const content = await fs.readFile(filePath, "utf-8");
				const updated = updateFrontmatterWithAtUri(content, atUri);
				await fs.writeFile(filePath, updated);
				log.message(`  Updated: ${path.basename(filePath)}`);
			}
			s.stop("Frontmatter updated");
		}

		log.success("\nSync complete!");
	},
});
