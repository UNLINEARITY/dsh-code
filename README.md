# dsh-code

English | [中文](README.zh.md)

A Claude-Code-style interactive terminal (TUI) bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), installed as an out-of-tree plugin bundle over the official `@deepseek-ai/dsh-base` — the same plugin ecosystem the official web surface composes, nothing forked.

## What you get

- DeepSeek-blue banner: the whale wordmark rasterized half-block from the exact FishLogo path, in a compact content-hugging header
- Live transcript streamed from the durable session log: user prompts, streaming assistant text, compact tool-call rows with running/done/error marks, todo snapshots
- A blended status line: Claude-Code-style identity facts (model, working directory, git branch, session) beside the web composer's figures (turns/steps, llm and tool wall time, cache hit, token totals)
- `/help`, `/clear`, `/quit` local commands; Ctrl+C/Ctrl+D quits after flushing the session

## Install

Requires Node `^22.19 || >=24` and the `dsh` CLI (`npm i -g @deepseek-ai/dsh@next`).

```sh
dsh plugin --profile cli add dsh-code       # from npm, once published
dsh plugin --profile cli add github:unlinearity/dsh-code  # track this repo
dsh plugin --profile cli add file:C:/path/to/dsh-code     # local checkout
```

Then:

```sh
dsh --profile cli
```

Set `DEEPSEEK_API_KEY` in your environment (or a `.env` in the launch directory or `$DSH_HOME`).

Git-hosted plugins build on install via their install scripts, which pnpm blocks until allowed: if an `add` fails, append the key it prints under `allowBuilds` in `~/.dsh/profiles/cli/pnpm-workspace.yaml` and re-run.

## Develop

```sh
pnpm install
pnpm test         # vitest unit tests
pnpm typecheck
pnpm build        # tsdown bundles lib/*.mjs, tsc emits lib/types
pnpm run gen:whale   # regenerate src/whale-glyph.ts from the vendored logo path
```

The whale glyph is generated from the DeepSeek fish-logo path vendored in `scripts/fish-logo.ts` (source: [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), MIT).

## License

[MIT](LICENSE). The vendored fish-logo geometry is from DeepSeek Harness (MIT).
