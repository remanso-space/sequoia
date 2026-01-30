import { command } from "cmd-ts";
import {
	intro,
	outro,
	note,
	text,
	confirm,
	select,
	spinner,
	log,
} from "@clack/prompts";
import * as path from "path";
import { findConfig, generateConfigTemplate } from "../lib/config";
import { loadCredentials } from "../lib/credentials";
import { createAgent, createPublication } from "../lib/atproto";
import type { FrontmatterMapping } from "../lib/types";
import { exitOnCancel } from "../lib/prompts";

export const initCommand = command({
	name: "init",
	description: "Initialize a new publisher configuration",
	args: {},
	handler: async () => {
		intro("Sequoia Configuration Setup");

		// Check if config already exists
		const existingConfig = await findConfig();
		if (existingConfig) {
			const overwrite = exitOnCancel(
				await confirm({
					message: `Config already exists at ${existingConfig}. Overwrite?`,
					initialValue: false,
				}),
			);
			if (!overwrite) {
				log.info("Keeping existing configuration");
				return;
			}
		}

		note("Follow the prompts to build your config for publishing", "Setup");

		const siteUrl = exitOnCancel(
			await text({
				message: "Site URL (canonical URL of your site):",
				placeholder: "https://example.com",
			}),
		);

		if (!siteUrl) {
			log.error("Site URL is required");
			process.exit(1);
		}

		const contentDir = exitOnCancel(
			await text({
				message: "Content directory:",
				placeholder: "./src/content/blog",
			}),
		);

		const imagesDir = exitOnCancel(
			await text({
				message: "Cover images directory (leave empty to skip):",
				placeholder: "./src/assets",
			}),
		);

		// Public/static directory for .well-known files
		const publicDir = exitOnCancel(
			await text({
				message: "Public/static directory (for .well-known files):",
				placeholder: "./public",
			}),
		);

		// Output directory for inject command
		const outputDir = exitOnCancel(
			await text({
				message: "Build output directory (for link tag injection):",
				placeholder: "./dist",
			}),
		);

		// Path prefix for posts
		const pathPrefix = exitOnCancel(
			await text({
				message: "URL path prefix for posts:",
				placeholder: "/posts, /blog, /articles, etc.",
			}),
		);

		// Frontmatter mapping configuration
		log.info(
			"Configure your frontmatter field mappings (press Enter to use defaults):",
		);

		const titleField = exitOnCancel(
			await text({
				message: "Field name for title:",
				defaultValue: "title",
				placeholder: "title",
			}),
		);

		const descField = exitOnCancel(
			await text({
				message: "Field name for description:",
				defaultValue: "description",
				placeholder: "description",
			}),
		);

		const dateField = exitOnCancel(
			await text({
				message: "Field name for publish date:",
				defaultValue: "publishDate",
				placeholder: "publishDate, pubDate, date, etc.",
			}),
		);

		const coverField = exitOnCancel(
			await text({
				message: "Field name for cover image:",
				defaultValue: "ogImage",
				placeholder: "ogImage, coverImage, image, hero, etc.",
			}),
		);

		const tagsField = exitOnCancel(
			await text({
				message: "Field name for tags:",
				defaultValue: "tags",
				placeholder: "tags, categories, keywords, etc.",
			}),
		);

		let frontmatterMapping: FrontmatterMapping | undefined = {};

		if (titleField && titleField !== "title") {
			frontmatterMapping.title = titleField;
		}
		if (descField && descField !== "description") {
			frontmatterMapping.description = descField;
		}
		if (dateField && dateField !== "publishDate") {
			frontmatterMapping.publishDate = dateField;
		}
		if (coverField && coverField !== "ogImage") {
			frontmatterMapping.coverImage = coverField;
		}
		if (tagsField && tagsField !== "tags") {
			frontmatterMapping.tags = tagsField;
		}

		// Only keep frontmatterMapping if it has any custom fields
		if (Object.keys(frontmatterMapping).length === 0) {
			frontmatterMapping = undefined;
		}

		// Publication setup
		const publicationChoice = exitOnCancel(
			await select({
				message: "Publication setup:",
				options: [
					{ label: "Create a new publication", value: "create" },
					{ label: "Use an existing publication AT URI", value: "existing" },
				],
			}),
		);

		let publicationUri: string;
		let credentials = await loadCredentials();

		if (publicationChoice === "create") {
			// Need credentials to create a publication
			if (!credentials) {
				log.error(
					"You must authenticate first. Run 'sequoia auth' before creating a publication.",
				);
				process.exit(1);
			}

			const s = spinner();
			s.start("Connecting to ATProto...");
			let agent;
			try {
				agent = await createAgent(credentials);
				s.stop("Connected!");
			} catch (error) {
				s.stop("Failed to connect");
				log.error(
					"Failed to connect. Check your credentials with 'sequoia auth'.",
				);
				process.exit(1);
			}

			const pubName = exitOnCancel(
				await text({
					message: "Publication name:",
					placeholder: "My Blog",
				}),
			);

			if (!pubName) {
				log.error("Publication name is required");
				process.exit(1);
			}

			const pubDescription = exitOnCancel(
				await text({
					message: "Publication description (optional):",
					placeholder: "A blog about...",
				}),
			);

			const iconPath = exitOnCancel(
				await pathPrompt({
					message: "Icon image path (leave empty to skip):",
				}),
			);

			const showInDiscover = exitOnCancel(
				await confirm({
					message: "Show in Discover feed?",
					initialValue: true,
				}),
			);

			s.start("Creating publication...");
			try {
				publicationUri = await createPublication(agent, {
					url: siteUrl,
					name: pubName,
					description: pubDescription || undefined,
					iconPath: iconPath || undefined,
					showInDiscover,
				});
				s.stop(`Publication created: ${publicationUri}`);
			} catch (error) {
				s.stop("Failed to create publication");
				log.error(`Failed to create publication: ${error}`);
				process.exit(1);
			}
		} else {
			const uri = exitOnCancel(
				await text({
					message: "Publication AT URI:",
					placeholder: "at://did:plc:.../site.standard.publication/...",
				}),
			);

			if (!uri) {
				log.error("Publication URI is required");
				process.exit(1);
			}
			publicationUri = uri;
		}

		// Get PDS URL from credentials (already loaded earlier)
		const pdsUrl = credentials?.pdsUrl;

		// Generate config file
		const configContent = generateConfigTemplate({
			siteUrl: siteUrl,
			contentDir: contentDir || "./content",
			imagesDir: imagesDir || undefined,
			publicDir: publicDir || "./public",
			outputDir: outputDir || "./dist",
			pathPrefix: pathPrefix || "/posts",
			publicationUri,
			pdsUrl,
			frontmatter: frontmatterMapping,
		});

		const configPath = path.join(process.cwd(), "sequoia.json");
		await Bun.write(configPath, configContent);

		log.success(`Configuration saved to ${configPath}`);

		// Create .well-known/site.standard.publication file
		const resolvedPublicDir = path.isAbsolute(publicDir || "./public")
			? publicDir || "./public"
			: path.join(process.cwd(), publicDir || "./public");
		const wellKnownDir = path.join(resolvedPublicDir, ".well-known");
		const wellKnownPath = path.join(wellKnownDir, "site.standard.publication");

		// Ensure .well-known directory exists
		await Bun.write(path.join(wellKnownDir, ".gitkeep"), "");
		await Bun.write(wellKnownPath, publicationUri);

		log.success(`Created ${wellKnownPath}`);

		// Update .gitignore
		const gitignorePath = path.join(process.cwd(), ".gitignore");
		const gitignoreFile = Bun.file(gitignorePath);
		const stateFilename = ".sequoia-state.json";

		if (await gitignoreFile.exists()) {
			const gitignoreContent = await gitignoreFile.text();
			if (!gitignoreContent.includes(stateFilename)) {
				await Bun.write(
					gitignorePath,
					gitignoreContent + `\n${stateFilename}\n`,
				);
				log.info(`Added ${stateFilename} to .gitignore`);
			}
		} else {
			await Bun.write(gitignorePath, `${stateFilename}\n`);
			log.info(`Created .gitignore with ${stateFilename}`);
		}

		note(
			"Next steps:\n" +
				"1. Run 'sequoia publish --dry-run' to preview\n" +
				"2. Run 'sequoia publish' to publish your content",
			"Setup complete!",
		);

		outro("Happy publishing!");
	},
});
