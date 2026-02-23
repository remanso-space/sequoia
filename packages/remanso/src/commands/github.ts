import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { command, flag } from "cmd-ts";
import { log, spinner, confirm, text } from "@clack/prompts";
import { exitOnCancel } from "../../../cli/src/lib/prompts";
import {
	getCredentials,
	listCredentials,
} from "../../../cli/src/lib/credentials";

export const WORKFLOW_YAML = `name: Publish to the PDS
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: remanso-space/remanso-cli@main
        with:
          identifier: \${{ secrets.ATP_IDENTIFIER }}
          app-password: \${{ secrets.ATP_APP_PASSWORD }}
`;

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

		// Parse SSH: git@github.com:owner/repo.git
		const sshMatch = remote.match(
			/git@github\.com:([^/]+)\/([^.]+)(?:\.git)?$/,
		);
		if (sshMatch) {
			return { owner: sshMatch[1]!, repo: sshMatch[2]! };
		}

		// Parse HTTPS: https://github.com/owner/repo.git
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

async function generateWorkflow(): Promise<void> {
	const workflowDir = path.dirname(WORKFLOW_PATH);

	if (await fileExists(WORKFLOW_PATH)) {
		const overwrite = exitOnCancel(
			await confirm({
				message: `${WORKFLOW_PATH} already exists. Overwrite?`,
				initialValue: false,
			}),
		);
		if (!overwrite) {
			log.info(`Keeping existing ${WORKFLOW_PATH}`);
			return;
		}
	}

	await fs.mkdir(workflowDir, { recursive: true });
	await fs.writeFile(WORKFLOW_PATH, WORKFLOW_YAML);
	log.success(`Created ${WORKFLOW_PATH}`);
}

async function setSecrets(): Promise<void> {
	const remote = detectGitHubRemote();
	if (!remote) {
		log.warn("Could not detect GitHub remote. Skipping secret setup.");
		log.info(
			"Add ATP_IDENTIFIER and ATP_APP_PASSWORD manually in your GitHub repo settings.",
		);
		return;
	}

	log.info(`GitHub repo: ${remote.owner}/${remote.repo}`);

	// Check if gh CLI is available
	const ghCheck = spawnSync("gh", ["--version"], { stdio: "pipe" });
	if (ghCheck.status !== 0) {
		log.warn("gh CLI not found. Cannot set secrets automatically.");
		log.info(
			"Install the GitHub CLI (https://cli.github.com/) or set secrets manually.",
		);
		return;
	}

	// Get identifier from stored credentials or prompt
	let identifier: string;
	let appPassword: string;

	const storedIds = await listCredentials();
	if (storedIds.length === 1 && storedIds[0]) {
		const creds = await getCredentials(storedIds[0]);
		if (creds) {
			identifier = creds.identifier;
			appPassword = creds.password;
			log.info(`Using stored credentials for: ${identifier}`);
		} else {
			identifier = exitOnCancel(
				await text({
					message: "ATProto handle (ATP_IDENTIFIER):",
					placeholder: "you.bsky.social",
				}),
			);
			appPassword = exitOnCancel(
				await text({
					message: "App Password (ATP_APP_PASSWORD):",
					placeholder: "xxxx-xxxx-xxxx-xxxx",
				}),
			);
		}
	} else if (storedIds.length > 1) {
		const { select } = await import("@clack/prompts");
		const selected = exitOnCancel(
			await select({
				message: "Select identity for GitHub secrets:",
				options: storedIds.map((id) => ({ value: id, label: id })),
			}),
		);
		const creds = await getCredentials(selected);
		if (!creds) {
			log.error("Could not load credentials for selected identity.");
			return;
		}
		identifier = creds.identifier;
		appPassword = creds.password;
	} else {
		identifier = exitOnCancel(
			await text({
				message: "ATProto handle (ATP_IDENTIFIER):",
				placeholder: "you.bsky.social",
			}),
		);
		appPassword = exitOnCancel(
			await text({
				message: "App Password (ATP_APP_PASSWORD):",
				placeholder: "xxxx-xxxx-xxxx-xxxx",
			}),
		);
	}

	const s = spinner();
	const repoFlag = `${remote.owner}/${remote.repo}`;

	s.start("Setting ATP_IDENTIFIER secret...");
	const r1 = spawnSync(
		"gh",
		[
			"secret",
			"set",
			"ATP_IDENTIFIER",
			"--body",
			identifier,
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
			appPassword,
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

export const githubCommand = command({
	name: "github",
	description:
		"Set up GitHub Actions workflow and secrets for automated publishing",
	args: {
		workflow: flag({
			long: "workflow",
			description: "Only generate the GitHub Actions workflow YAML",
		}),
		secrets: flag({
			long: "secrets",
			description: "Only set GitHub repository secrets via the gh CLI",
		}),
	},
	handler: async ({ workflow, secrets }) => {
		const doWorkflow = workflow || (!workflow && !secrets);
		const doSecrets = secrets || (!workflow && !secrets);

		if (doWorkflow) {
			await generateWorkflow();
		}

		if (doSecrets) {
			await setSecrets();
		}
	},
});
