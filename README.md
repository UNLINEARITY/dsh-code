# DSH-Code

English | [中文](README.zh.md)

<p align="center"><img alt="Typing SVG" src="https://readme-typing-svg.herokuapp.com?font=JetBrains+Mono&amp;weight=500&amp;size=22&amp;duration=4000&amp;pause=700&amp;color=4176E6&amp;center=true&amp;vCenter=true&amp;width=680&amp;lines=DeepSeek+Harness+Code;DSH+%E5%86%85%E6%A0%B8%E7%9A%84%E7%BB%88%E7%AB%AF%E7%BC%96%E7%A0%81%E7%95%8C%E9%9D%A2"></p>

<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek-Harness-4176E6?style=for-the-badge&amp;logo=deepseek&amp;logoColor=white&amp;labelColor=1c1917"></a>
  <a href="https://github.com/UNLINEARITY/dsh-code/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/UNLINEARITY/dsh-code?label=Stars&amp;style=for-the-badge&amp;logo=github&amp;logoColor=white&amp;color=4176E6&amp;labelColor=1c1917"></a>
  <a href="https://www.npmjs.com/package/dsh-code"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-code?label=npm&amp;style=for-the-badge&amp;logo=npm&amp;color=cb3837&amp;labelColor=1c1917"></a>
  <a href="https://github.com/UNLINEARITY/dsh-code/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/UNLINEARITY/dsh-code?label=License&amp;style=for-the-badge&amp;logo=opensourceinitiative&amp;color=4176E6&amp;labelColor=1c1917"></a>
</p>

<p align="center"><img src="docs/pictures/1.png" width="95%" alt="DSH-Code terminal with slash-command completion"></p>

**DSH-Code is a terminal coding interface for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).** It runs as an out-of-tree bundle over the official `@deepseek-ai/dsh-base` and uses the same Agent, Session, tool, command, skill, permission, sandbox, compaction, and plugin services as the Harness Web UI.

DSH-Code does not implement a separate agent loop. It adds a coding-focused TUI to the DSH runtime, drawing on the session handling of [Codex CLI](https://github.com/openai/codex) and the terminal interaction patterns of [Claude Code](https://code.claude.com/docs/en/overview).

---

## Overview

DeepSeek Harness treats models, tools, storage, policies, and interfaces as plugins registered through Cordis. Durable session events record the conversation and runtime state needed for replay.

DSH-Code keeps that structure and adds a terminal workflow for coding tasks.

| Reference | Used in DSH-Code |
| --- | --- |
| **DeepSeek Harness** | Plugin composition, scoped services, Agent Presets, durable sessions, tools, skills, policies, sandboxing, and delegation |
| **Codex CLI** | Session navigation, bounded overlays, history inspection, stable bottom layout, and resize handling |
| **Claude Code** | Slash-command discovery, thinking folds, approvals, questions, and turn steering |

The interface borrows familiar terminal conventions, while runtime behavior continues to come from DSH services and configuration.

## Quick start

Requires Node `^22.19 || >=24`, the preview `dsh` CLI, and `DEEPSEEK_API_KEY`.

```sh
npm install -g @deepseek-ai/dsh@next
npm install -g pnpm
dsh plugin --profile cli add dsh-code
dsh --profile cli
```

### Source development

For a local checkout:

```sh
dsh plugin --profile cli add file:C:/path/to/dsh-code
```

GitHub installation is available for source development:

```sh
dsh plugin --profile cli add github:unlinearity/dsh-code
```

The Git package builds during installation. If pnpm asks for an `allowBuilds` entry, copy the complete entry it prints into `~/.dsh/profiles/cli/pnpm-workspace.yaml`, then run the command again. The key includes the Git URL and commit, so do not replace it with only `dsh-code`.

> DeepSeek Harness is currently a developer preview and may introduce compatibility-breaking changes. DSH-Code tracks that evolving plugin surface.

For installation, native-module, and plugin-loading issues, see the [troubleshooting guide](docs/problems.md).

## How it works with DSH

### Runtime composition

DSH-Code reads the live Harness registries instead of maintaining separate copies. Model adapters, tool providers, skill sources, commands, permission policies, persistence backends, sandboxes, and subagent providers can be added or replaced through DSH composition.

`/plugin` provides a read-only view of the current Cordis loader state.

### Session-scoped Agent Presets

The Host owns shared infrastructure—registries, persistence, session queries, permissions, and sandbox policy—while each session receives an isolated Agent scope composed from an **Agent Preset**:

- `standard` — the full general-purpose coding agent
- `code` — Code Mode / PTC-oriented multi-operation workflows
- `minimal` — only persistent shell access and `str_replace_editor`
- `cordis` — the full agent plus runtime inspection and preset-authoring guidance
- user presets — your own tools, prompt sections, skills, compaction, plan mode, and subagent behavior

Use `/mode` before the first turn or start directly with `--mode <preset>`. The selected preset is written to the session and restored on resume.

### Session history and replay

Prompts, streamed chunks, tool calls, results, model choices, plan state, permissions, titles, and preset selections are projected from durable Session events. Resume, export, history inspection, context accounting, and terminal replay use the same record.

React state is limited to temporary interface details such as the input draft, cursor, open panel, selection, and scroll position.

```text
dsh profile
└─ Host plane: registries · persistence · query · permissions · sandbox
   ├─ Agent session A + preset code
   ├─ Agent session B + preset minimal
   └─ DSH-Code TUI
      durable events → pure projection → append-only transcript
                                  └→ bounded panels → composer → status
```

## Terminal behavior

DSH-Code keeps one Ink owner for the lifetime of the process. `/new` and `/resume` replace the active Agent, not the terminal itself. If a switch is requested while the Agent is busy, it waits for the turn to finish; the newest request wins, and a failed target leaves the current session untouched.

Dynamic content is deliberately bounded. Streaming output, thinking, approvals, questions, `/help`, `/model`, `/mode`, `/resume`, `/plugin`, and Ctrl+O all share terminal-aware viewport rules. The composer remains immediately above the status line. After a resize, the screen is redrawn from the stored transcript once the new width settles.

Use `/mode` before the first turn to inspect or select the session's Agent Preset.

<p align="center"><img src="docs/pictures/2.png" width="95%" alt="Per-session Agent Preset picker"></p>

Use `/resume` to search persisted sessions without replacing the TUI.

<p align="center"><img src="docs/pictures/3.png" width="95%" alt="Searchable session resume picker"></p>

## Common commands

```sh
dsh --profile cli                    # start a fresh standard session
dsh --profile cli --mode code        # start with an Agent Preset
dsh --profile cli --continue         # newest session for this directory
dsh --profile cli --resume abc123    # persisted session by id or unique prefix
dsh --profile cli --session my-id    # fresh session with an explicit id
```

Inside the TUI:

| Action | Purpose |
| --- | --- |
| `/new [preset]` | Create and enter another session without restarting the terminal |
| `/resume [id\|prefix]` | Search roots or all conversations; filter by cwd, order, and density |
| `/mode [preset]` | Inspect or select the blank session's Agent composition |
| `/model` | Switch among models advertised by the live LLM registry |
| `/plugin [query]` | Inspect loader entries, enabled state, module identity, and fiber phase |
| `/permission <name>` | Change the permission preset; Shift+Tab cycles presets |
| `/help` | Browse local commands, Harness commands, skills, and key bindings |
| `Ctrl+O` | Open the exclusive history detail view; switch entries and scroll all content |
| `Ctrl+R` | Fold or reveal model reasoning |
| `@` | Mention workspace files or bounded snapshots of persisted sessions |
| `Esc` / `Ctrl+C` | Close the topmost surface or interrupt the active turn |

## Features

### Agent and extensions

- Per-session Agent Presets for tools, prompt sections, skills, compaction, plan mode, and delegation
- Live slash-command and skill discovery from shared Harness registries
- Read-only Cordis loader diagnostics through `/plugin`
- Model routing through the live LLM registry, restored per persisted session
- Plans, goals, todos, permissions, sandbox state, subagents, and runtime steering

### Sessions and context

- `/new`, `/resume`, `--continue`, and explicit session identifiers without remounting Ink
- Codex-style searchable resume picker with root/conversation, cwd, order, and density filters
- Lazy title snapshots and explicitly loaded, fully scrollable transcripts
- Read-only subagent conversation inspection and bounded `@` session references
- Markdown export, persistent titles, context occupancy, cache, token, TTFT, and timing metrics

### Approvals and interaction

- One-shot tool approval bar for sandbox escalation and hook `ask` decisions
- Structured `ask_user_question` and plan-review menus with multi-select and custom answers
- Turn steering at the next step boundary plus explicit interruption semantics
- Independent Agent mode, plan state, permission preset, goal, and sandbox indicators

### Terminal rendering

- Append-only settled transcript with bounded mutable streaming output
- Folded thinking, terminal Markdown, compact tool summaries, and full structured details
- Ctrl+O exclusive history inspection with entry navigation and complete vertical scrolling
- Width-safe CJK/control-character handling, compact-terminal degradation, and debounced resize replay
- Stable bottom order: content or panel → notice → composer → status

## References

- Runtime services, events, plugin scopes, and persistence follow **DeepSeek Harness**.
- Session navigation, popup sizing, scrollback, bottom-pane layout, and resize behavior refer to **Codex CLI**.
- Slash discovery, turn steering, thinking folds, approvals, and question flows refer to **Claude Code**.

DSH-Code remains an independent MIT-licensed community project and is not affiliated with OpenAI or Anthropic.

## Develop

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm run gen:whale   # regenerate src/whale-glyph.ts from the vendored logo path
```

The whale glyph is generated from the DeepSeek FishLogo geometry vendored in `scripts/fish-logo.ts` (source: DeepSeek Harness, MIT).

## License

[MIT](LICENSE). The vendored FishLogo geometry is from DeepSeek Harness (MIT).
