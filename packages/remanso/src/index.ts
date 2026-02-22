#!/usr/bin/env node

import { run, subcommands } from "cmd-ts";
import { authCommand } from "./commands/auth";
import { githubCommand } from "./commands/github";
import { initCommand } from "./commands/init";
import { publishCommand } from "./commands/publish";
import { syncCommand } from "./commands/sync";

const app = subcommands({
	name: "remanso",
	description: "Publish private notes to Remanso (remanso.space)",
	version: "0.1.0",
	cmds: {
		auth: authCommand,
		init: initCommand,
		publish: publishCommand,
		sync: syncCommand,
		github: githubCommand,
	},
});

run(app, process.argv.slice(2));
