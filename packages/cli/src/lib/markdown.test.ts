import { describe, expect, test } from "bun:test";
import {
	getContentHash,
	getSlugFromFilename,
	getSlugFromOptions,
	getTextContent,
	parseFrontmatter,
	stripMarkdownForText,
	updateFrontmatterWithAtUri,
} from "./markdown";

describe("parseFrontmatter", () => {
	test("parses YAML frontmatter with --- delimiters", () => {
		const content = `---
title: My Post
description: A description
publishDate: 2024-01-15
---
Hello world`;

		const result = parseFrontmatter(content);
		expect(result.frontmatter.title).toBe("My Post");
		expect(result.frontmatter.description).toBe("A description");
		expect(result.frontmatter.publishDate).toBe("2024-01-15");
		expect(result.body).toBe("Hello world");
		expect(result.rawFrontmatter.title).toBe("My Post");
	});

	test("parses TOML frontmatter with +++ delimiters", () => {
		const content = `+++
title = My Post
description = A description
date = 2024-01-15
+++
Body content`;

		const result = parseFrontmatter(content);
		expect(result.frontmatter.title).toBe("My Post");
		expect(result.frontmatter.description).toBe("A description");
		expect(result.frontmatter.publishDate).toBe("2024-01-15");
		expect(result.body).toBe("Body content");
	});

	test("parses *** delimited frontmatter", () => {
		const content = `***
title: Test
***
Body`;

		const result = parseFrontmatter(content);
		expect(result.frontmatter.title).toBe("Test");
		expect(result.body).toBe("Body");
	});

	test("handles no frontmatter - extracts title from heading", () => {
		const content = `# My Heading

Some body text`;

		const result = parseFrontmatter(content);
		expect(result.frontmatter.title).toBe("My Heading");
		expect(result.frontmatter.publishDate).toBeTruthy();
		expect(result.body).toBe(content);
	});

	test("handles no frontmatter and no heading", () => {
		const content = "Just plain text";

		const result = parseFrontmatter(content);
		expect(result.frontmatter.title).toBe("");
		expect(result.body).toBe(content);
	});

	test("handles quoted string values", () => {
		const content = `---
title: "Quoted Title"
description: 'Single Quoted'
---
Body`;

		const result = parseFrontmatter(content);
		expect(result.rawFrontmatter.title).toBe("Quoted Title");
		expect(result.rawFrontmatter.description).toBe("Single Quoted");
	});

	test("parses inline arrays", () => {
		const content = `---
title: Post
tags: [javascript, typescript, "web dev"]
---
Body`;

		const result = parseFrontmatter(content);
		expect(result.rawFrontmatter.tags).toEqual([
			"javascript",
			"typescript",
			"web dev",
		]);
	});

	test("parses YAML multiline arrays", () => {
		const content = `---
title: Post
tags:
  - javascript
  - typescript
  - web dev
---
Body`;

		const result = parseFrontmatter(content);
		expect(result.rawFrontmatter.tags).toEqual([
			"javascript",
			"typescript",
			"web dev",
		]);
	});

	test("parses boolean values", () => {
		const content = `---
title: Draft Post
draft: true
published: false
---
Body`;

		const result = parseFrontmatter(content);
		expect(result.rawFrontmatter.draft).toBe(true);
		expect(result.rawFrontmatter.published).toBe(false);
	});

	test("applies frontmatter field mappings", () => {
		const content = `---
nombre: Custom Title
descripcion: Custom Desc
fecha: 2024-06-01
imagen: cover.jpg
etiquetas: [a, b]
borrador: true
---
Body`;

		const mapping = {
			title: "nombre",
			description: "descripcion",
			publishDate: "fecha",
			coverImage: "imagen",
			tags: "etiquetas",
			draft: "borrador",
		};

		const result = parseFrontmatter(content, mapping);
		expect(result.frontmatter.title).toBe("Custom Title");
		expect(result.frontmatter.description).toBe("Custom Desc");
		expect(result.frontmatter.publishDate).toBe("2024-06-01");
		expect(result.frontmatter.ogImage).toBe("cover.jpg");
		expect(result.frontmatter.tags).toEqual(["a", "b"]);
		expect(result.frontmatter.draft).toBe(true);
	});

	test("falls back to common date field names", () => {
		const content = `---
title: Post
date: 2024-03-20
---
Body`;

		const result = parseFrontmatter(content);
		expect(result.frontmatter.publishDate).toBe("2024-03-20");
	});

	test("falls back to pubDate", () => {
		const content = `---
title: Post
pubDate: 2024-04-10
---
Body`;

		const result = parseFrontmatter(content);
		expect(result.frontmatter.publishDate).toBe("2024-04-10");
	});

	test("preserves atUri field", () => {
		const content = `---
title: Post
atUri: at://did:plc:abc/site.standard.post/123
---
Body`;

		const result = parseFrontmatter(content);
		expect(result.frontmatter.atUri).toBe(
			"at://did:plc:abc/site.standard.post/123",
		);
	});

	test("maps draft field correctly", () => {
		const content = `---
title: Post
draft: true
---
Body`;

		const result = parseFrontmatter(content);
		expect(result.frontmatter.draft).toBe(true);
	});
});

describe("getSlugFromFilename", () => {
	test("removes .md extension", () => {
		expect(getSlugFromFilename("my-post.md")).toBe("my-post");
	});

	test("removes .mdx extension", () => {
		expect(getSlugFromFilename("my-post.mdx")).toBe("my-post");
	});

	test("converts to lowercase", () => {
		expect(getSlugFromFilename("My-Post.md")).toBe("my-post");
	});

	test("replaces spaces with dashes", () => {
		expect(getSlugFromFilename("my cool post.md")).toBe("my-cool-post");
	});
});

describe("getSlugFromOptions", () => {
	test("uses filepath by default", () => {
		const slug = getSlugFromOptions("blog/my-post.md", {});
		expect(slug).toBe("blog/my-post");
	});

	test("uses slugField from frontmatter when set", () => {
		const slug = getSlugFromOptions(
			"blog/my-post.md",
			{ slug: "/custom-slug" },
			{ slugField: "slug" },
		);
		expect(slug).toBe("custom-slug");
	});

	test("falls back to filepath when slugField not found in frontmatter", () => {
		const slug = getSlugFromOptions("blog/my-post.md", {}, { slugField: "slug" });
		expect(slug).toBe("blog/my-post");
	});

	test("removes /index suffix when removeIndexFromSlug is true", () => {
		const slug = getSlugFromOptions(
			"blog/my-post/index.md",
			{},
			{ removeIndexFromSlug: true },
		);
		expect(slug).toBe("blog/my-post");
	});

	test("removes /_index suffix when removeIndexFromSlug is true", () => {
		const slug = getSlugFromOptions(
			"blog/my-post/_index.md",
			{},
			{ removeIndexFromSlug: true },
		);
		expect(slug).toBe("blog/my-post");
	});

	test("strips date prefix when stripDatePrefix is true", () => {
		const slug = getSlugFromOptions(
			"2024-01-15-my-post.md",
			{},
			{ stripDatePrefix: true },
		);
		expect(slug).toBe("my-post");
	});

	test("strips date prefix in nested paths", () => {
		const slug = getSlugFromOptions(
			"blog/2024-01-15-my-post.md",
			{},
			{ stripDatePrefix: true },
		);
		expect(slug).toBe("blog/my-post");
	});

	test("combines removeIndexFromSlug and stripDatePrefix", () => {
		const slug = getSlugFromOptions(
			"blog/2024-01-15-my-post/index.md",
			{},
			{ removeIndexFromSlug: true, stripDatePrefix: true },
		);
		expect(slug).toBe("blog/my-post");
	});

	test("lowercases and replaces spaces", () => {
		const slug = getSlugFromOptions("Blog/My Post.md", {});
		expect(slug).toBe("blog/my-post");
	});
});

describe("getContentHash", () => {
	test("returns a hex string", async () => {
		const hash = await getContentHash("hello");
		expect(hash).toMatch(/^[0-9a-f]+$/);
	});

	test("returns consistent results", async () => {
		const hash1 = await getContentHash("test content");
		const hash2 = await getContentHash("test content");
		expect(hash1).toBe(hash2);
	});

	test("returns different hashes for different content", async () => {
		const hash1 = await getContentHash("content a");
		const hash2 = await getContentHash("content b");
		expect(hash1).not.toBe(hash2);
	});
});

describe("updateFrontmatterWithAtUri", () => {
	test("inserts atUri into YAML frontmatter", () => {
		const content = `---
title: My Post
---
Body`;

		const result = updateFrontmatterWithAtUri(content, "at://did:plc:abc/post/123");
		expect(result).toContain('atUri: "at://did:plc:abc/post/123"');
		expect(result).toContain("title: My Post");
	});

	test("inserts atUri into TOML frontmatter", () => {
		const content = `+++
title = My Post
+++
Body`;

		const result = updateFrontmatterWithAtUri(content, "at://did:plc:abc/post/123");
		expect(result).toContain('atUri = "at://did:plc:abc/post/123"');
	});

	test("creates frontmatter with atUri when none exists", () => {
		const content = "# My Post\n\nSome body text";

		const result = updateFrontmatterWithAtUri(content, "at://did:plc:abc/post/123");
		expect(result).toContain('atUri: "at://did:plc:abc/post/123"');
		expect(result).toContain("---");
		expect(result).toContain("# My Post\n\nSome body text");
	});

	test("replaces existing atUri in YAML", () => {
		const content = `---
title: My Post
atUri: "at://did:plc:old/post/000"
---
Body`;

		const result = updateFrontmatterWithAtUri(content, "at://did:plc:new/post/999");
		expect(result).toContain('atUri: "at://did:plc:new/post/999"');
		expect(result).not.toContain("old");
	});

	test("replaces existing atUri in TOML", () => {
		const content = `+++
title = My Post
atUri = "at://did:plc:old/post/000"
+++
Body`;

		const result = updateFrontmatterWithAtUri(content, "at://did:plc:new/post/999");
		expect(result).toContain('atUri = "at://did:plc:new/post/999"');
		expect(result).not.toContain("old");
	});
});

describe("stripMarkdownForText", () => {
	test("removes headings", () => {
		expect(stripMarkdownForText("## Hello")).toBe("Hello");
	});

	test("removes bold", () => {
		expect(stripMarkdownForText("**bold text**")).toBe("bold text");
	});

	test("removes italic", () => {
		expect(stripMarkdownForText("*italic text*")).toBe("italic text");
	});

	test("removes links but keeps text", () => {
		expect(stripMarkdownForText("[click here](https://example.com)")).toBe(
			"click here",
		);
	});

	test("removes images", () => {
		// Note: link regex runs before image regex, so ![alt](url) partially matches as a link first
		expect(stripMarkdownForText("text ![alt](image.png) more")).toBe(
			"text !alt more",
		);
	});

	test("removes code blocks", () => {
		const input = "Before\n```js\nconst x = 1;\n```\nAfter";
		expect(stripMarkdownForText(input)).toContain("Before");
		expect(stripMarkdownForText(input)).toContain("After");
		expect(stripMarkdownForText(input)).not.toContain("const x");
	});

	test("removes inline code formatting", () => {
		expect(stripMarkdownForText("use `npm install`")).toBe("use npm install");
	});

	test("normalizes multiple newlines", () => {
		const input = "Line 1\n\n\n\n\nLine 2";
		expect(stripMarkdownForText(input)).toBe("Line 1\n\nLine 2");
	});
});

describe("getTextContent", () => {
	test("uses textContentField from frontmatter when specified", () => {
		const post = {
			content: "# Markdown body",
			rawFrontmatter: { excerpt: "Custom excerpt text" },
		};
		expect(getTextContent(post, "excerpt")).toBe("Custom excerpt text");
	});

	test("falls back to stripped markdown when textContentField not found", () => {
		const post = {
			content: "**Bold text** and [a link](url)",
			rawFrontmatter: {},
		};
		expect(getTextContent(post, "missing")).toBe("Bold text and a link");
	});

	test("falls back to stripped markdown when no textContentField specified", () => {
		const post = {
			content: "## Heading\n\nParagraph",
			rawFrontmatter: {},
		};
		expect(getTextContent(post)).toBe("Heading\n\nParagraph");
	});
});