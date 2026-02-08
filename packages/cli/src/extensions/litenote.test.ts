import { describe, expect, test } from "bun:test";
import { resolveInternalLinks } from "./litenote";
import type { BlogPost } from "../lib/types";

function makePost(slug: string, atUri?: string): BlogPost {
	return {
		filePath: `content/${slug}.md`,
		slug,
		frontmatter: {
			title: slug,
			publishDate: "2024-01-01",
			atUri,
		},
		content: "",
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
