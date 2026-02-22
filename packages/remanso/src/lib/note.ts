import type { Agent } from "@atproto/api";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import mimeTypes from "mime-types";
import type { BlogPost, BlobObject } from "../../../cli/src/lib/types";

const LEXICON = "space.remanso.note";
const MAX_CONTENT = 10000;

interface ImageRecord {
	image: BlobObject;
	alt?: string;
}

export interface NoteOptions {
	contentDir: string;
	imagesDir?: string;
	allPosts: BlogPost[];
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

export function isLocalPath(url: string): boolean {
	return (
		!url.startsWith("http://") &&
		!url.startsWith("https://") &&
		!url.startsWith("#") &&
		!url.startsWith("mailto:")
	);
}

function getImageCandidates(
	src: string,
	postFilePath: string,
	contentDir: string,
	imagesDir?: string,
): string[] {
	const candidates = [
		path.resolve(path.dirname(postFilePath), src),
		path.resolve(contentDir, src),
	];
	if (imagesDir) {
		candidates.push(path.resolve(imagesDir, src));
		const baseName = path.basename(imagesDir);
		const idx = src.indexOf(baseName);
		if (idx !== -1) {
			const after = src.substring(idx + baseName.length).replace(/^[/\\]/, "");
			candidates.push(path.resolve(imagesDir, after));
		}
	}
	return candidates;
}

async function uploadBlob(
	agent: Agent,
	candidates: string[],
): Promise<BlobObject | undefined> {
	for (const filePath of candidates) {
		if (!(await fileExists(filePath))) continue;

		try {
			const imageBuffer = await fs.readFile(filePath);
			if (imageBuffer.byteLength === 0) continue;
			const mimeType = mimeTypes.lookup(filePath) || "application/octet-stream";
			const response = await agent.com.atproto.repo.uploadBlob(
				new Uint8Array(imageBuffer),
				{ encoding: mimeType },
			);
			return {
				$type: "blob",
				ref: { $link: response.data.blob.ref.toString() },
				mimeType,
				size: imageBuffer.byteLength,
			};
		} catch {}
	}
	return undefined;
}

async function processImages(
	agent: Agent,
	content: string,
	postFilePath: string,
	contentDir: string,
	imagesDir?: string,
): Promise<{ content: string; images: ImageRecord[] }> {
	const images: ImageRecord[] = [];
	const uploadCache = new Map<string, BlobObject>();
	let processedContent = content;

	const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
	const matches = [...content.matchAll(imageRegex)];

	for (const match of matches) {
		const fullMatch = match[0];
		const alt = match[1] ?? "";
		const src = match[2]!;
		if (!isLocalPath(src)) continue;

		let blob = uploadCache.get(src);
		if (!blob) {
			const candidates = getImageCandidates(
				src,
				postFilePath,
				contentDir,
				imagesDir,
			);
			blob = await uploadBlob(agent, candidates);
			if (!blob) continue;
			uploadCache.set(src, blob);
		}

		images.push({ image: blob, alt: alt || undefined });
		processedContent = processedContent.replace(
			fullMatch,
			`![${alt}](${blob.ref.$link})`,
		);
	}

	return { content: processedContent, images };
}

export function resolveInternalLinks(
	content: string,
	allPosts: BlogPost[],
): string {
	const linkRegex = /(?<![!@])\[([^\]]+)\]\(([^)]+)\)/g;

	return content.replace(linkRegex, (fullMatch, text, url) => {
		if (!isLocalPath(url)) return fullMatch;

		// Normalize to a slug-like string for comparison
		const normalized = url
			.replace(/^(\.\.\/|\.\/)+/, "")
			.replace(/\/?$/, "")
			.replace(/\.mdx?$/, "")
			.replace(/\/index$/, "");

		const matchedPost = allPosts.find((p) => {
			if (!p.frontmatter.atUri) return false;
			return (
				p.slug === normalized ||
				p.slug.endsWith(`/${normalized}`) ||
				normalized.endsWith(`/${p.slug}`)
			);
		});

		if (!matchedPost) return text;

		const noteUri = matchedPost.frontmatter.atUri!.replace(
			/\/[^/]+\/([^/]+)$/,
			`/space.remanso.note/$1`,
		);
		return `[${text}](${noteUri})`;
	});
}

async function processNoteContent(
	agent: Agent,
	post: BlogPost,
	options: NoteOptions,
): Promise<{ content: string; images: ImageRecord[] }> {
	let content = post.content.trim();

	content = resolveInternalLinks(content, options.allPosts);

	const result = await processImages(
		agent,
		content,
		post.filePath,
		options.contentDir,
		options.imagesDir,
	);

	return result;
}

function parseRkey(atUri: string): string {
	const uriMatch = atUri.match(/^at:\/\/([^/]+)\/([^/]+)\/(.+)$/);
	if (!uriMatch) {
		throw new Error(`Invalid atUri format: ${atUri}`);
	}
	return uriMatch[3]!;
}

async function buildNoteRecord(
	agent: Agent,
	post: BlogPost,
	options: NoteOptions,
): Promise<Record<string, unknown>> {
	const publishDate = new Date(post.frontmatter.publishDate).toISOString();
	const trimmedContent = post.content.trim();
	const titleMatch = trimmedContent.match(/^# (.+)$/m);
	const title = titleMatch ? titleMatch[1] : post.frontmatter.title;

	const { content, images } = await processNoteContent(agent, post, options);

	const record: Record<string, unknown> = {
		$type: LEXICON,
		title,
		content: content.slice(0, MAX_CONTENT),
		createdAt: publishDate,
		publishedAt: publishDate,
	};

	if (images.length > 0) {
		record.images = images;
	}

	if (post.frontmatter.theme) {
		record.theme = post.frontmatter.theme;
	}

	if (post.frontmatter.fontSize) {
		record.fontSize = post.frontmatter.fontSize;
	}

	if (post.frontmatter.fontFamily) {
		record.fontFamily = post.frontmatter.fontFamily;
	}

	return record;
}

export async function deleteNote(agent: Agent, atUri: string): Promise<void> {
	const rkey = parseRkey(atUri);
	await agent.com.atproto.repo.deleteRecord({
		repo: agent.did!,
		collection: LEXICON,
		rkey,
	});
}

export async function createNote(
	agent: Agent,
	post: BlogPost,
	atUri: string,
	options: NoteOptions,
): Promise<void> {
	const rkey = parseRkey(atUri);
	const record = await buildNoteRecord(agent, post, options);

	await agent.com.atproto.repo.createRecord({
		repo: agent.did!,
		collection: LEXICON,
		record,
		rkey,
		validate: false,
	});
}

export async function updateNote(
	agent: Agent,
	post: BlogPost,
	atUri: string,
	options: NoteOptions,
): Promise<void> {
	const rkey = parseRkey(atUri);
	const record = await buildNoteRecord(agent, post, options);

	await agent.com.atproto.repo.putRecord({
		repo: agent.did!,
		collection: LEXICON,
		rkey: rkey!,
		record,
		validate: false,
	});
}

export function findPostsWithStaleLinks(
	allPosts: BlogPost[],
	newSlugs: string[],
	excludeFilePaths: Set<string>,
): BlogPost[] {
	const linkRegex = /(?<![!@])\[([^\]]+)\]\(([^)]+)\)/g;

	return allPosts.filter((post) => {
		if (excludeFilePaths.has(post.filePath)) return false;
		if (!post.frontmatter.atUri) return false;
		if (post.frontmatter.draft) return false;

		const matches = [...post.content.matchAll(linkRegex)];
		return matches.some((match) => {
			const url = match[2]!;
			if (!isLocalPath(url)) return false;

			const normalized = url
				.replace(/^(\.\.\/|\.\/)+/, "")
				.replace(/\/?$/, "")
				.replace(/\.mdx?$/, "")
				.replace(/\/index$/, "");

			return newSlugs.some(
				(slug) =>
					slug === normalized ||
					slug.endsWith(`/${normalized}`) ||
					normalized.endsWith(`/${slug}`),
			);
		});
	});
}
