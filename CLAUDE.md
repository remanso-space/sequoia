# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sequoia is a CLI tool for publishing Markdown documents with frontmatter to the AT Protocol (Bluesky's decentralized social network). It converts blog posts into ATProto records (`site.standard.document`, `space.remanso.note`) and publishes them to a user's PDS.

Website: <https://sequoia.pub>

## Monorepo Structure

- **`packages/cli/`** — Main CLI package (the core product)
- **`docs/`** — Documentation website (Vocs-based, deployed to Cloudflare Pages)

Bun workspaces manage the monorepo.

## Commands

```bash
# Build CLI
bun run build:cli

# Run CLI in dev (build + link)
cd packages/cli && bun run dev

# Run tests
bun run test:cli

# Run a single test file
cd packages/cli && bun test src/lib/markdown.test.ts

# Lint (auto-fix)
cd packages/cli && bun run lint

# Format (auto-fix)
cd packages/cli && bun run format

# Docs dev server
bun run dev:docs
```

## Architecture

**Entry point:** `packages/cli/src/index.ts` — Uses `cmd-ts` for type-safe subcommand routing.

**Commands** (`src/commands/`):

- `publish` — Core workflow: scans markdown files, publishes to ATProto
- `sync` — Fetches published records state from ATProto
- `update` — Updates existing records
- `auth` — Multi-identity management (app-password + OAuth)
- `init` — Interactive config setup
- `inject` — Injects verification links into static HTML output
- `login` — Legacy auth (deprecated)

**Libraries** (`src/lib/`):

- `atproto.ts` — ATProto API wrapper (two client types: AtpAgent for app-password, OAuth client)
- `config.ts` — Loads `sequoia.json` config and `.sequoia-state.json` state files
- `credentials.ts` — Multi-identity credential storage at `~/.config/sequoia/credentials.json` (0o600 permissions)
- `markdown.ts` — Frontmatter parsing (YAML/TOML), content hashing, atUri injection

**Extensions** (`src/extensions/`):

- `remanso.ts` — Creates `space.remanso.note` records with embedded images

## Key Patterns

- **Config resolution:** `sequoia.json` is found by searching up the directory tree
- **Frontmatter formats:** YAML (`---`), TOML (`+++`), and alternative (`***`) delimiters
- **Credential types:** App-password (PDS URL + identifier + password) and OAuth (DID + handle)
- **Build:** `bun build src/index.ts --target node --outdir dist`

## Tooling

- **Runtime/bundler:** Bun
- **Linter/formatter:** Biome (tabs, double quotes)
- **Test runner:** Bun's native test runner
- **CLI framework:** `cmd-ts`
- **Interactive UI:** `@clack/prompts`

## Git Conventions

Never add 'Co-authored-by' lines to git commits unless explicitly asked.
