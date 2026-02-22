import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { command } from "cmd-ts";
import {
	confirm,
	intro,
	log,
	note,
	outro,
	password,
	select,
	spinner,
	text,
} from "@clack/prompts";
import { AtpAgent } from "@atproto/api";
import { resolveHandleToPDS, createPublication, createAgent } from "../../../cli/src/lib/atproto";
import {
	loadCredentials,
	saveCredentials,
	getCredentials,
	listCredentials,
} from "../../../cli/src/lib/credentials";
import { exitOnCancel } from "../../../cli/src/lib/prompts";
import type { RemansoConfig } from "../lib/config";
import { WORKFLOW_YAML } from "./github";

const CONFIG_FILENAME = "remanso.json";
const STATE_FILENAME = ".remanso-state.json";
const WORKFLOW_PATH = ".github/workflows/remanso.yml";

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

function detectGitHubRemote(): { owner: string; repo: string } | null {
	try {
		const remote = execSync("git remote get-url origin", {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();

		const sshMatch = remote.match(/git@github\.com:([^/]+)\/([^.]+)(?:\.git)?$/);
		if (sshMatch) {
			return { owner: sshMatch[1]!, repo: sshMatch[2]! };
		}

		const httpsMatch = remote.match(
			/https:\/\/github\.com\/([^/]+)\/([^.]+?)(?:\.git)?$/,
		);
		if (httpsMatch) {
			return { owner: httpsMatch[1]!, repo: httpsMatch[2]! };
		}

		return null;
	} catch {
		return null;
	}
}

async function listPublications(
	agent: InstanceType<typeof AtpAgent>,
): Promise<Array<{ uri: string; name: string; url: string }>> {
	const results: Array<{ uri: string; name: string; url: string }> = [];
	let cursor: string | undefined;

	do {
		const response = await agent.com.atproto.repo.listRecords({
			repo: agent.did!,
			collection: "site.standard.publication",
			limit: 100,
			cursor,
		});

		for (const record of response.data.records) {
			const value = record.value as Record<string, unknown>;
			if (value.$type === "site.standard.publication") {
				results.push({
					uri: record.uri,
					name: (value.name as string) || record.uri,
					url: (value.url as string) || "",
				});
			}
		}

		cursor = response.data.cursor;
	} while (cursor);

	return results;
}

const onCancel = () => {
	outro("Setup cancelled");
	process.exit(0);
};

export const initCommand = command({
	name: "init",
	description: "Initialize a new Remanso notes configuration",
	args: {},
	handler: async () => {
		intro("Remanso Configuration Setup");

		// Step 1: Detect GitHub remote
		const remote = detectGitHubRemote();
		if (remote) {
			log.info(`Detected GitHub repo: ${remote.owner}/${remote.repo}`);
		} else {
			log.info(
				"No GitHub remote detected. You can add GitHub integration later with 'remanso github'.",
			);
		}

		// Check if config already exists
		if (await fileExists(CONFIG_FILENAME)) {
			const overwrite = exitOnCancel(
				await confirm({
					message: `${CONFIG_FILENAME} already exists. Overwrite?`,
					initialValue: false,
				}),
			);
			if (!overwrite) {
				log.info("Keeping existing configuration");
				outro("No changes made.");
				return;
			}
		}

		// Step 2: Load credentials or prompt for them
		let credentials = await loadCredentials();
		let pdsUrl: string | undefined;

		if (credentials?.type === "oauth") {
			log.warn("OAuth credentials detected but remanso requires App Passwords.");
			credentials = null;
		}

		if (!credentials) {
			const storedIds = await listCredentials();
			if (storedIds.length > 0) {
				// Offer to use stored credentials or add new ones
				const choice = exitOnCancel(
					await select({
						message: "Authentication:",
						options: [
							...storedIds.map((id) => ({
								value: id,
								label: `Use existing: ${id}`,
							})),
							{ value: "__new__", label: "Add new App Password" },
						],
					}),
				);

				if (choice !== "__new__") {
					credentials = await getCredentials(choice);
				}
			}

			if (!credentials) {
				// Prompt for new credentials
				note(
					"Create an App Password at: https://bsky.app/settings/app-passwords",
					"Authentication",
				);

				const identifier = exitOnCancel(
					await text({
						message: "Handle or DID:",
						placeholder: "yourhandle.bsky.social",
					}),
				);

				const appPassword = exitOnCancel(
					await password({
						message: "App Password:",
					}),
				);

				if (!identifier || !appPassword) {
					log.error("Handle and password are required");
					process.exit(1);
				}

				const s = spinner();
				s.start("Resolving PDS...");
				try {
					pdsUrl = await resolveHandleToPDS(identifier);
					s.stop(`Found PDS: ${pdsUrl}`);
				} catch (error) {
					s.stop("Failed to resolve PDS");
					log.error(`Failed to resolve PDS from handle: ${error}`);
					process.exit(1);
				}

				s.start("Verifying credentials...");
				try {
					const agent = new AtpAgent({ service: pdsUrl });
					await agent.login({ identifier, password: appPassword });
					s.stop(`Logged in as ${agent.session?.handle}`);

					credentials = {
						type: "app-password",
						pdsUrl,
						identifier,
						password: appPassword,
					};

					await saveCredentials(credentials);
					log.success("Credentials saved");
				} catch (error) {
					s.stop("Failed to login");
					log.error(`Failed to login: ${error}`);
					process.exit(1);
				}
			}
		}

		// Step 3: Connect and get DID
		const s = spinner();
		s.start("Connecting to ATProto...");
		let agent: Awaited<ReturnType<typeof createAgent>>;
		try {
			agent = await createAgent(credentials!);
			s.stop(`Connected as ${agent.did}`);
		} catch (error) {
			s.stop("Failed to connect");
			log.error(`Failed to connect: ${error}`);
			process.exit(1);
		}

		if (credentials?.type === "app-password") {
			pdsUrl = credentials.pdsUrl;
		}

		// Step 4: Publication — list existing or create new
		let publicationUri: string;

		s.start("Fetching existing publications...");
		let publications: Array<{ uri: string; name: string; url: string }> = [];
		try {
			publications = await listPublications(agent as unknown as InstanceType<typeof AtpAgent>);
			s.stop(`Found ${publications.length} existing publication(s)`);
		} catch {
			s.stop("Could not fetch publications");
		}

		const siteUrl = `https://remanso.space/pub/@${agent.did}`;

		if (publications.length > 0) {
			const pubChoice = exitOnCancel(
				await select({
					message: "Publication:",
					options: [
						...publications.map((p) => ({
							value: p.uri,
							label: `${p.name} (${p.uri})`,
						})),
						{ value: "__create__", label: "Create a new publication" },
					],
				}),
			);

			if (pubChoice === "__create__") {
				const pubName = exitOnCancel(
					await text({
						message: "Publication name:",
						placeholder: "My Notes",
						validate: (v) => (!v ? "Name is required" : undefined),
					}),
				);

				s.start("Creating publication...");
				try {
					publicationUri = await createPublication(agent, {
						url: siteUrl,
						name: pubName,
					});
					s.stop(`Publication created: ${publicationUri}`);
				} catch (error) {
					s.stop("Failed to create publication");
					log.error(`Failed to create publication: ${error}`);
					process.exit(1);
				}
			} else {
				publicationUri = pubChoice;
			}
		} else {
			// No publications — create one
			log.info("No existing publications found. Creating a new one.");
			const pubName = exitOnCancel(
				await text({
					message: "Publication name:",
					placeholder: "My Notes",
					validate: (v) => (!v ? "Name is required" : undefined),
				}),
			);

			s.start("Creating publication...");
			try {
				publicationUri = await createPublication(agent, {
					url: siteUrl,
					name: pubName,
				});
				s.stop(`Publication created: ${publicationUri}`);
			} catch (error) {
				s.stop("Failed to create publication");
				log.error(`Failed to create publication: ${error}`);
				process.exit(1);
			}
		}

		// Step 5: Content directory
		const contentDir = exitOnCancel(
			await text({
				message: "Content directory (where your .pub.md files live):",
				placeholder: ".",
				defaultValue: ".",
			}),
		);

		// Step 6: Write remanso.json
		const config: RemansoConfig = {
			contentDir: contentDir || ".",
			publicationUri,
		};

		if (pdsUrl && pdsUrl !== "https://bsky.social") {
			config.pdsUrl = pdsUrl;
		}

		const configContent = JSON.stringify(config, null, 2);
		await fs.writeFile(CONFIG_FILENAME, configContent);
		log.success(`Created ${CONFIG_FILENAME}`);

		// Step 7: Update .gitignore
		const gitignorePath = ".gitignore";
		if (await fileExists(gitignorePath)) {
			const gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
			if (!gitignoreContent.includes(STATE_FILENAME)) {
				await fs.writeFile(
					gitignorePath,
					`${gitignoreContent}\n${STATE_FILENAME}\n`,
				);
				log.info(`Added ${STATE_FILENAME} to .gitignore`);
			}
		} else {
			await fs.writeFile(gitignorePath, `${STATE_FILENAME}\n`);
			log.info(`Created .gitignore with ${STATE_FILENAME}`);
		}

		// Step 8: GitHub Action workflow
		const addWorkflow = exitOnCancel(
			await confirm({
				message: "Generate GitHub Actions workflow for automated publishing?",
				initialValue: true,
			}),
		);

		if (addWorkflow) {
			const workflowDir = path.dirname(WORKFLOW_PATH);

			if (await fileExists(WORKFLOW_PATH)) {
				const overwrite = exitOnCancel(
					await confirm({
						message: `${WORKFLOW_PATH} already exists. Overwrite?`,
						initialValue: false,
					}),
				);
				if (overwrite) {
					await fs.mkdir(workflowDir, { recursive: true });
					await fs.writeFile(WORKFLOW_PATH, WORKFLOW_YAML);
					log.success(`Updated ${WORKFLOW_PATH}`);
				}
			} else {
				await fs.mkdir(workflowDir, { recursive: true });
				await fs.writeFile(WORKFLOW_PATH, WORKFLOW_YAML);
				log.success(`Created ${WORKFLOW_PATH}`);
			}
		}

		// Step 9: GitHub secrets
		if (remote && credentials?.type === "app-password") {
			const ghCheck = spawnSync("gh", ["--version"], { stdio: "pipe" });
			const ghAvailable = ghCheck.status === 0;

			if (ghAvailable) {
				const setGhSecrets = exitOnCancel(
					await confirm({
						message: `Set GitHub secrets for ${remote.owner}/${remote.repo}?`,
						initialValue: true,
					}),
				);

				if (setGhSecrets) {
					const repoFlag = `${remote.owner}/${remote.repo}`;

					s.start("Setting ATP_IDENTIFIER secret...");
					const r1 = spawnSync(
						"gh",
						[
							"secret",
							"set",
							"ATP_IDENTIFIER",
							"--body",
							credentials.identifier,
							"--repo",
							repoFlag,
						],
						{ stdio: "pipe" },
					);
					if (r1.status === 0) {
						s.stop("ATP_IDENTIFIER set");
					} else {
						s.stop("Failed to set ATP_IDENTIFIER");
						log.warn(r1.stderr?.toString() || "Unknown error");
					}

					s.start("Setting ATP_APP_PASSWORD secret...");
					const r2 = spawnSync(
						"gh",
						[
							"secret",
							"set",
							"ATP_APP_PASSWORD",
							"--body",
							credentials.password,
							"--repo",
							repoFlag,
						],
						{ stdio: "pipe" },
					);
					if (r2.status === 0) {
						s.stop("ATP_APP_PASSWORD set");
					} else {
						s.stop("Failed to set ATP_APP_PASSWORD");
						log.warn(r2.stderr?.toString() || "Unknown error");
					}

					log.success(`Secrets configured for ${repoFlag}`);
				}
			} else {
				log.info(
					"Install the GitHub CLI (https://cli.github.com/) to set secrets automatically.",
				);
				log.info(
					`Or add ATP_IDENTIFIER and ATP_APP_PASSWORD manually in ${remote.owner}/${remote.repo} settings.`,
				);
			}
		}

		note(
			"Next steps:\n" +
				"1. Create notes with a .pub.md extension to publish them\n" +
				"2. Run 'remanso publish --dry-run' to preview\n" +
				"3. Run 'remanso publish' to publish\n" +
				(remote ? "4. Push to GitHub to trigger automated publishing" : ""),
			"Setup complete!",
		);

		outro("Happy publishing!");
	},
});
