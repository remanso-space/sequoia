import { describe, expect, test } from "bun:test";
import { resolveInternalLinks, findPostsWithStaleLinks } from "./litenote";
import type { BlogPost } from "../lib/types";

function makePost(
	slug: string,
	atUri?: string,
	options?: { content?: string; draft?: boolean; filePath?: string },
): BlogPost {
	return {
		filePath: options?.filePath ?? `content/${slug}.md`,
		slug,
		frontmatter: {
			title: slug,
			publishDate: "2024-01-01",
			atUri,
			draft: options?.draft,
		},
		content: options?.content ?? "",
		rawContent: "",
		rawFrontmatter: {},
	};
}

describe("resolveInternalLinks", () => {
	test("strips link for unpublished local path", () => {
		const posts = [makePost("other-post")];
		const content = "See [my post](./other-post)";
		expect(resolveInternalLinks(content, posts)).toBe("See my post");
	});

	test("rewrites published link to litenote atUri", () => {
		const posts = [
			makePost(
				"other-post",
				"at://did:plc:abc/site.standard.document/abc123",
			),
		];
		const content = "See [my post](./other-post)";
		expect(resolveInternalLinks(content, posts)).toBe(
			"See [my post](at://did:plc:abc/space.litenote.note/abc123)",
		);
	});

	test("leaves external links unchanged", () => {
		const posts = [makePost("other-post")];
		const content = "See [example](https://example.com)";
		expect(resolveInternalLinks(content, posts)).toBe(
			"See [example](https://example.com)",
		);
	});

	test("leaves anchor links unchanged", () => {
		const posts: BlogPost[] = [];
		const content = "See [section](#heading)";
		expect(resolveInternalLinks(content, posts)).toBe(
			"See [section](#heading)",
		);
	});

	test("handles .md extension in link path", () => {
		const posts = [
			makePost(
				"guide",
				"at://did:plc:abc/site.standard.document/guide123",
			),
		];
		const content = "Read the [guide](guide.md)";
		expect(resolveInternalLinks(content, posts)).toBe(
			"Read the [guide](at://did:plc:abc/space.litenote.note/guide123)",
		);
	});

	test("handles nested slug matching", () => {
		const posts = [
			makePost(
				"blog/my-post",
				"at://did:plc:abc/site.standard.document/rkey1",
			),
		];
		const content = "See [post](my-post)";
		expect(resolveInternalLinks(content, posts)).toBe(
			"See [post](at://did:plc:abc/space.litenote.note/rkey1)",
		);
	});

	test("does not rewrite image embeds", () => {
		const posts = [
			makePost(
				"photo",
				"at://did:plc:abc/site.standard.document/photo1",
			),
		];
		const content = "![alt](photo)";
		expect(resolveInternalLinks(content, posts)).toBe("![alt](photo)");
	});

	test("does not rewrite @mention links", () => {
		const posts = [
			makePost(
				"mention",
				"at://did:plc:abc/site.standard.document/m1",
			),
		];
		const content = "@[name](mention)";
		expect(resolveInternalLinks(content, posts)).toBe("@[name](mention)");
	});

	test("handles multiple links in same content", () => {
		const posts = [
			makePost(
				"published",
				"at://did:plc:abc/site.standard.document/pub1",
			),
			makePost("unpublished"),
		];
		const content =
			"See [a](published) and [b](unpublished) and [c](https://ext.com)";
		expect(resolveInternalLinks(content, posts)).toBe(
			"See [a](at://did:plc:abc/space.litenote.note/pub1) and b and [c](https://ext.com)",
		);
	});

	test("handles index path normalization", () => {
		const posts = [
			makePost(
				"docs",
				"at://did:plc:abc/site.standard.document/docs1",
			),
		];
		const content = "See [docs](./docs/index)";
		expect(resolveInternalLinks(content, posts)).toBe(
			"See [docs](at://did:plc:abc/space.litenote.note/docs1)",
		);
	});
});

describe("findPostsWithStaleLinks", () => {
	test("finds published post containing link to a newly created slug", () => {
		const posts = [
			makePost("post-a", "at://did:plc:abc/site.standard.document/a1", {
				content: "Check out [post B](./post-b)",
			}),
		];
		const result = findPostsWithStaleLinks(posts, ["post-b"], new Set());
		expect(result).toHaveLength(1);
		expect(result[0]!.slug).toBe("post-a");
	});

	test("excludes posts in the exclude set (current batch)", () => {
		const posts = [
			makePost("post-a", "at://did:plc:abc/site.standard.document/a1", {
				content: "Check out [post B](./post-b)",
			}),
		];
		const result = findPostsWithStaleLinks(
			posts,
			["post-b"],
			new Set(["content/post-a.md"]),
		);
		expect(result).toHaveLength(0);
	});

	test("excludes unpublished posts (no atUri)", () => {
		const posts = [
			makePost("post-a", undefined, {
				content: "Check out [post B](./post-b)",
			}),
		];
		const result = findPostsWithStaleLinks(posts, ["post-b"], new Set());
		expect(result).toHaveLength(0);
	});

	test("excludes drafts", () => {
		const posts = [
			makePost("post-a", "at://did:plc:abc/site.standard.document/a1", {
				content: "Check out [post B](./post-b)",
				draft: true,
			}),
		];
		const result = findPostsWithStaleLinks(posts, ["post-b"], new Set());
		expect(result).toHaveLength(0);
	});

	test("ignores external links", () => {
		const posts = [
			makePost("post-a", "at://did:plc:abc/site.standard.document/a1", {
				content: "Check out [post B](https://example.com/post-b)",
			}),
		];
		const result = findPostsWithStaleLinks(posts, ["post-b"], new Set());
		expect(result).toHaveLength(0);
	});

	test("ignores image embeds", () => {
		const posts = [
			makePost("post-a", "at://did:plc:abc/site.standard.document/a1", {
				content: "![post B](./post-b)",
			}),
		];
		const result = findPostsWithStaleLinks(posts, ["post-b"], new Set());
		expect(result).toHaveLength(0);
	});

	test("ignores @mention links", () => {
		const posts = [
			makePost("post-a", "at://did:plc:abc/site.standard.document/a1", {
				content: "@[post B](./post-b)",
			}),
		];
		const result = findPostsWithStaleLinks(posts, ["post-b"], new Set());
		expect(result).toHaveLength(0);
	});

	test("handles nested slug matching", () => {
		const posts = [
			makePost("post-a", "at://did:plc:abc/site.standard.document/a1", {
				content: "Check out [post](my-post)",
			}),
		];
		const result = findPostsWithStaleLinks(
			posts,
			["blog/my-post"],
			new Set(),
		);
		expect(result).toHaveLength(1);
	});

	test("does not match posts without matching links", () => {
		const posts = [
			makePost("post-a", "at://did:plc:abc/site.standard.document/a1", {
				content: "Check out [post C](./post-c)",
			}),
		];
		const result = findPostsWithStaleLinks(posts, ["post-b"], new Set());
		expect(result).toHaveLength(0);
	});
});
