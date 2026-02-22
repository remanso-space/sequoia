import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PublisherState } from "../../../cli/src/lib/types";

export interface RemansoConfig {
	contentDir: string;
	publicationUri: string;
	pdsUrl?: string;
	identity?: string;
	ignore?: string[];
	imagesDir?: string;
}

const CONFIG_FILENAME = "remanso.json";
const STATE_FILENAME = ".remanso-state.json";

export const DEFAULT_IGNORE = ["**/node_modules/**", ".*/**", "_*/**"];

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

export async function findConfig(
	startDir: string = process.cwd(),
): Promise<string | null> {
	let currentDir = startDir;

	while (true) {
		const configPath = path.join(currentDir, CONFIG_FILENAME);

		if (await fileExists(configPath)) {
			return configPath;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) {
			return null;
		}
		currentDir = parentDir;
	}
}

export async function loadConfig(
	configPath?: string,
): Promise<{ config: RemansoConfig; configPath: string }> {
	const resolvedPath = configPath || (await findConfig());

	if (!resolvedPath) {
		throw new Error(
			`Could not find ${CONFIG_FILENAME}. Run 'remanso init' to create one.`,
		);
	}

	try {
		const content = await fs.readFile(resolvedPath, "utf-8");
		const config = JSON.parse(content) as RemansoConfig;

		if (!config.contentDir) throw new Error("contentDir is required in config");
		if (!config.publicationUri)
			throw new Error("publicationUri is required in config");

		return { config, configPath: resolvedPath };
	} catch (error) {
		if (error instanceof Error && error.message.includes("required")) {
			throw error;
		}
		throw new Error(`Failed to load config from ${resolvedPath}: ${error}`);
	}
}

export async function loadState(configDir: string): Promise<PublisherState> {
	const statePath = path.join(configDir, STATE_FILENAME);

	if (!(await fileExists(statePath))) {
		return { posts: {} };
	}

	try {
		const content = await fs.readFile(statePath, "utf-8");
		return JSON.parse(content) as PublisherState;
	} catch {
		return { posts: {} };
	}
}

export async function saveState(
	configDir: string,
	state: PublisherState,
): Promise<void> {
	const statePath = path.join(configDir, STATE_FILENAME);
	await fs.writeFile(statePath, JSON.stringify(state, null, 2));
}

export const STATE_FILENAME_EXPORT = STATE_FILENAME;
