# Remanso CLI

> [!NOTE]
> Remanso CLI is a fork from [Sequoia](https://sequoia.pub) made by [Steve Dylan](https://pds.ls/at://stevedylan.dev)

<!-- ![cover](https://sequoia.pub/og.png) -->

A CLI for publishing [Remanso notes](https://remanso.space) alongside [Standard.site](https://standard.site) documents to the [AT Protocol](https://atproto.com).

> [!NOTE]
> [Visit the docs for more info](https://sequoia.pub)

## Quickstart

Install the CLI

```bash
pnpm i -g remanso-cli
```

Authorize

```bash
remanso auth
```

Initialize in your blog repo

```bash
remanso init
```

Publish your posts

```bash
remanso publish
```

Inject link tags for verification (optional)

```bash
remanso inject
```

[Full documentation](https://sequoia.pub)

## Local Development

Make sure [Bun](https://bun.com) is installed

Clone the git repo and install dependencies

```bash
git clone git@tangled.org:stevedylan.dev/sequoia
cd sequoia
bun install
```

Move into `packages/cli` and build/test

```bash
cd packages/cli
bun dev
```

## License

MIT

## Contact

[ATProto](https://pds.ls/at://stevedylan.dev)
[Email](mailto:contact@stavedylan.dev)
