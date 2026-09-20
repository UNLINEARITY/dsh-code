# DSH-Code

English | [中文](README.md)

<p align="center"><img src="docs/pictures/dsh-1.png" width="95%" alt="DSH-Code welcome screen and model status"></p>

<p align="center"><img alt="Typing SVG" src="https://readme-typing-svg.herokuapp.com?font=JetBrains+Mono&amp;weight=500&amp;size=22&amp;duration=4000&amp;pause=700&amp;color=4176E6&amp;center=true&amp;vCenter=true&amp;width=680&amp;lines=DeepSeek+Harness+Code;Terminal+Coding+Interface+for+the+DSH+Core"></p>
<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek-Harness-4176E6?style=for-the-badge&amp;logo=deepseek&amp;logoColor=white&amp;labelColor=1c1917"></a>
  <a href="https://www.npmjs.com/package/@deepseek-ai/dsh"><img alt="dsh version" src="https://img.shields.io/badge/dsh-0.1.5--rc.2-4176E6?style=for-the-badge&amp;logo=deepseek&amp;logoColor=white&amp;labelColor=1c1917"></a>
  <a href="https://github.com/UNLINEARITY/dsh-code/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/UNLINEARITY/dsh-code?label=Stars&amp;style=for-the-badge&amp;logo=github&amp;logoColor=white&amp;color=4176E6&amp;labelColor=1c1917"></a>
  <a href="https://www.npmjs.com/package/dsh-code"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-code?label=npm&amp;style=for-the-badge&amp;logo=npm&amp;color=cb3837&amp;labelColor=1c1917"></a>
  <a href="https://github.com/UNLINEARITY/dsh-code/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/UNLINEARITY/dsh-code?label=License&amp;style=for-the-badge&amp;logo=opensourceinitiative&amp;color=4176E6&amp;labelColor=1c1917"></a>
</p>

---

## 1. Project overview

**DSH-Code is a terminal coding interface for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).** It is composed as an out-of-tree bundle on top of the official `@deepseek-ai/dsh-base` and uses the same Agent, Session, tool, command, skill, permission, sandbox, context-compaction, and plugin services as the Harness Web UI.

DeepSeek Harness registers models, tools, storage, policies, and interfaces as plugins through Cordis. Durable session events record the information required to restore conversations and runtime state. DSH-Code preserves that architecture while adding a terminal workflow suited to coding tasks. The interface follows terminal conventions familiar to developers, while runtime behavior remains governed by DSH services and configuration.

## 2. Quick start

Requires Node `^22.19 || >=24` and the preview `dsh` CLI (current release line: `@deepseek-ai/dsh@0.1.5-rc.2`). You can still enter the TUI, browse sessions, and use non-model features without configuring a model; press `Tab` in `/model` to manage API keys, OAuth, device-code sign-in, endpoints, and models.

### 1. Install and update

Install from npm (recommended). `/update` and `deepseek update --apply` both work afterwards: they check npm for a newer version and walk you through the upgrade.

```sh
npm install -g @deepseek-ai/dsh@0.1.5-rc.2 pnpm
npm install -g dsh-code@1.4.0
dsh plugin --profile cli add dsh-code@1.4.0
```

When npm is unreachable (restricted network, a mirror outage), install the GitHub Release tarball instead. CI builds it on every tag and attaches it to the release; lib is prebuilt, so the installing machine needs no toolchain:

```sh
npm install -g @deepseek-ai/dsh@0.1.5-rc.2 pnpm
npm install -g https://github.com/unlinearity/dsh-code/releases/download/1.3.0/dsh-code-1.3.0.tgz
dsh plugin --profile cli add https://github.com/unlinearity/dsh-code/releases/download/1.3.0/dsh-code-1.3.0.tgz
```

> npm script prompts: npm 11.6+ may print `npm warn install-scripts` during a global install (unapproved build scripts for node-pty, koffi, and friends). The host ships prebuilt artifacts, so common platforms can ignore the warning; if a native-module error appears after installing, follow npm's own hint and rerun with `npm install -g --allow-scripts=<package list>`.
>
> Version alignment: dsh-code targets dsh `0.1.5-rc.2`, with every Harness dependency pinned exactly to `0.1.5-rc.2`. A local `link:` mount should be rebuilt with `git pull && pnpm install && pnpm build`; do not run the updater against a checkout.
>
> A GitHub tarball install can lead npm by one release (until the registry carries the same version). The updater only reads npm, so it reports that this install is newer and refuses to downgrade, instead of claiming everything is up to date; use `/update` once npm catches up.

### 2. Launch commands

Available launch commands:

```sh
dsh --profile cli
deepseek
dsh-code
```

`dsh --profile cli`, `deepseek`, and `dsh-code` are equivalent launch commands. `deepseek` and `dsh-code` are global aliases for `dsh --profile cli`, and all additional arguments are forwarded unchanged, for example `deepseek --resume abc123`.

> DeepSeek Harness is still a developer preview and may introduce compatibility-breaking changes. DSH-Code will continue to track the evolution of its plugin interfaces.

For installation, native-module, and plugin-loading issues, run `deepseek doctor` first, then see [Troubleshooting](docs/problems.md).

## 3. Core features and usage

DSH-Code brings DSH Agents, models, tools, and durable sessions directly into the terminal, covering the complete workflow from writing code to reviewing changes.

### 1. Session management

- Create sessions with `/new`, or restore existing sessions with `/resume` and `--continue`
- Create a new work branch from a historical point with `/fork` while preserving the original session
- Search history by current directory, update time, and session scope
- Recall input history with Up/Down (typed slash commands included), or search previous prompts and commands with `/history`
- Use persistent titles, Markdown export, context occupancy, token, cache, TTFT, and elapsed-time metrics; `/usage` reports the harness token meter's four disjoint buckets, the totals merged by model, and a per-turn breakdown
- The status bar's `in` counts only uncached input, and `cache` shows both the cache-read volume and the hit share — together they are the billed prompt side
- Restore the session's Agent Preset, model selection, and subagent list when resuming it; the welcome header shows both the dsh and dsh-code versions

<p align="center"><img src="docs/pictures/dsh-3.png" width="95%" alt="Searchable session resume picker"></p>

<p align="center"><img src="docs/pictures/dsh-4.png" width="95%" alt="Searchable prompt-history picker"></p>

### 2. Agents, models, and extensions

- Select an independent Agent Preset for each session to compose tools, prompt sections, skills, context compaction, plan mode, and subagent capabilities
- Use `/mode` to select `standard`, `ptc`, `minimal`, `cordis`, or a user-defined Preset (the legacy `code` id maps to `ptc`)
- Use `/model` to switch models and manage providers, API keys, OAuth/device-code sign-in, endpoints, available models, and context windows
- In the `/model` provider list, Enter manages a manual API key, `l` starts sign-in, and `o` logs out after confirmation
- Automatically load commands and skills available in DSH; use `/help` to find them and `/plugin` to inspect extension status
- Use plans, goals, todos, permissions, sandboxes, subagents, and additional instructions while a task is running

<p align="center"><img src="docs/pictures/dsh-2.png" width="95%" alt="Per-session Agent Preset picker"></p>

### 3. Model-switch animations

The composer plays Wave, Aurora, or Pulse when the model or reasoning effort changes under the following conditions:

| Scenario | Trigger | Animation text | Effect tier |
| --- | --- | --- | --- |
| Official DeepSeek model | Switch to the model, or change its reasoning effort | `deepseek` | Flash uses the single-band tier; other DeepSeek models use the multi-band tier |
| Other models | After changing the model or reasoning effort, the effective effort is strictly above `high` | `Into the Unknown` | Uses the same multi-band tier as non-Flash DeepSeek models |

Levels above `high` include `xhigh`, `x-high`, `very-high`, `max`, `maximum`, and `ultra`. For non-DeepSeek models, `high`, `medium`, `low`, and `off` do not trigger an animation.

| Style | Flash | Other DeepSeek / `Into the Unknown` |
| --- | --- | --- |
| Wave | One blue crest sweeps from left to right, about 1.2 seconds | Two offset blue crests sweep across in sequence with trailing `· ✦ ✧` sparkles, about 1.5 seconds |
| Aurora | Two blue light bands drift across one another, about 1.5 seconds | Three differently hued light bands drift across one another, about 1.8 seconds |
| Pulse | One ring expands outward from the center of the composer, about 1.1 seconds | Two rings expand outward in sequence, about 1.45 seconds |

### 4. Coding workflow

- Use `@` to reference workspace files or existing sessions; selecting PNG, JPEG, WebP, or GIF files attaches the real image automatically
- Attach images through the initial prompt, repeated `--image` arguments, or by dragging one or more images into the terminal
- Inspect changes by file with `/diff`, and start a read-only code review with `/review` (a range picker; diffs use full-row green/red)
- `run_code` lists nested tool calls as they run; workflow runs list their member agents until they finish
- Copy the latest complete response with `/copy`, and inspect full history and tool details with Ctrl+O
- Handle tool approvals, structured questions, plan reviews, multiple selections, and custom answers
- Control what the Agent may do with permission Presets and sandboxes; add instructions or interrupt while a task is running

### 5. Queued and steered messages

While a turn is running you can keep typing. There are two ways to send what you type:

- **Queue** — it waits until the turn finishes and then runs as a new turn. Use it for "do this once you are done with that".
- **Steer** — it reaches the model before the next step of the running turn, as part of that request. Use it when the work has gone the wrong way and you want it corrected now.

The difference is **when the model sees it**: a queued message is read once the turn has finished, a steered one before the turn makes its next move.

How to send each way:

- Press `Tab` on an empty composer to switch between them. The prompt glyph (`❯` / `↳`), the placeholder text, and the notice shown on switching all say which one is selected. With text in the box, `Tab` still completes commands and references.
- `/queue` opens the queue panel: press `Enter` on a message to send it as steering instead, `e` to edit its text (attachments are kept as they are), or `d` to remove it.
- Press `Delete` on an empty composer to cancel the newest queued message.
- Pressing `Esc` to cancel the turn keeps **queued messages and sends them next**, while steered messages are dropped with the turn.

Every prompt in the transcript is a full-width coloured row, and the colour says how it was sent: the theme's bright brand colour for an ordinary message, its warning colour for a queued one, and its third accent for a steered one, each labelled with "queued" or "steered". The colour is computed from the theme, so switching themes or rerolling rainbow changes it too.

A message counts as queued or steered only when a turn was **already running** at the moment you sent it. A message sent while idle is an ordinary one even if the composer is set to steer, because it starts a new turn straight away.

See [Queued and steered messages](docs/message-queue.md) for the queue behaviour, the order the upstream queues are read in, and the colour values per theme.

### 6. Commands and key bindings

Start the TUI:

```sh
dsh --profile cli                    # create a standard session
dsh --profile cli --mode ptc         # start with the specified Agent Preset (standard/minimal/cordis/ptc)
dsh --profile cli --continue         # resume the latest session for the current directory
dsh --profile cli --resume abc123    # resume by id or unique prefix
dsh --profile cli --session my-id    # create a session with an explicit id
```

The following built-in commands are available inside the TUI. Additional Harness commands and user skills depend on the active profile and installed packages; use `/help` for the complete current list.

#### Sessions and history

| Command | Purpose |
| --- | --- |
| `/new [preset]` | Create a session, optionally selecting an Agent Preset |
| `/resume [id\|prefix]` | Search for or restore an existing session |
| `/search [query]` | Full-text search across persisted sessions (Enter resumes the hit) |
| `/resume cancel` | Cancel a pending session switch |
| `/fork [event-seq]` | Create a session branch from the latest completed turn or a specified event position |
| `/delete [id\|prefix]` | Delete a session and its subagent sessions |
| `/title <text>` | Change the current session title |
| `/export [path]` | Export the current session as Markdown |
| `/history` | Search and reuse previously submitted prompts and slash commands |
| `/clear` | Clear the current terminal display without deleting the durable session |

#### Agents, models, and permissions

| Command | Purpose |
| --- | --- |
| `/mode [preset]` | Inspect or select the current session's Agent Preset |
| `/model` | Switch models and manage providers, API keys, browser sign-in, endpoints, and available models |
| `/effort` | Adjust the current model's reasoning effort |
| `/permission [preset]` | Inspect or switch the permission Preset |
| `/subagent` | Select the model used when a subagent performs a task |

#### Coding, tasks, and background work

| Command | Purpose |
| --- | --- |
| `/diff [--staged\|ref]` | Inspect the working-tree, staged, or specified-ref Git diff by file |
| `/review [note]` | Bare /review opens a candidate picker (uncommitted changes / pick a branch / pick a commit / custom focus); any argument becomes a review note over the uncommitted diff (`/review in Chinese`). The diff is pasted into the current session under read-only permissions, and findings arrive with P0-P3 priorities and file anchors |
| `/todos` | View the complete todo list for the current session |
| `/queue` | See the messages waiting for the next turn: enter sends one as steering instead, `e` edits its text, `d` removes it; `↑↓`/`PageUp`/`PageDown`/`g`/`G` move |
| `/usage` | See this session's token usage: the four disjoint buckets (uncached input, cache write, cache read, output), the totals merged by model, and the per-turn breakdown |
| `/agents` | View subagent sessions created by the current session |
| `/jobs` | View background jobs and their runtime status |
| `/schedule` | Inspect active reminders (created through the model's schedule tools; read-only, overdue first) |
| `/copy` | Copy the latest complete assistant response |

#### Extensions, display, and exit

| Command | Purpose |
| --- | --- |
| `/plugin [query]` | Inspect loaded extensions and their status |
| `/update` | Checks npm for a newer version and confirms the upgrade. A GitHub tarball install can lead npm, in which case it says so and refuses to downgrade |
| `/statusline` | Select the items displayed in the status bar |
| `/vscode-keys` | Pass Ctrl+R through VS Code-family terminals (idempotent user-level keybindings.json write) |
| `/theme` | Switch colors: `dark` / `light` / `prismatic` / `rainbow` / `auto` |
| `/rainbow [seed]` | Reroll or pin the rainbow theme seed; a bare `/rainbow` rolls a new seed and switches to rainbow |
| `/language [en\|zh]` | Switch the interface language, default English; model prompts and factual status values stay in English |
| `/animation` | Toggle timed animations (shimmer/chase/blink/switch wave), `/animation [on\|off]` |
| `/help` | View key bindings, built-in commands, Harness commands, and user skills |
| `/quit` | Exit DSH-Code |

#### Input and key bindings

| Action | Purpose |
| --- | --- |
| `Enter` | Submit the current input |
| `Ctrl+J` / `Alt+Enter` | Insert a newline in the composer (with the enhanced keyboard protocol, `Shift+Enter` / `Ctrl+Enter` work too) |
| `Up` / `Down` | Recall the previous or next input-history entry |
| `Tab` | Complete commands, skills, or `@` references; on an empty composer, switch the next message between queue and steer |
| `@` | Reference workspace files or existing sessions; image files are sent as attachments |
| `Ctrl+O` | Inspect full history and tool details, with a kind label on each entry (user prompt / reply / tool call, and so on) |
| `Ctrl/Alt+R` | Fold or expand model reasoning; run /vscode-keys first in VS Code-family terminals to pass Ctrl+R through |
| `Shift+Tab` | Cycle permission Presets, and the plan station when `/plan` is available |
| `Delete` | Cancel the newest queued message when the composer is empty (steering is not in the queue; press `Esc` to end the turn instead) |
| `Ctrl+K` | Delete from the cursor to the end of the line |
| `Ctrl+U` | Clear the current input line |
| `Ctrl+A` / `Ctrl+E` | Move to the beginning or end of the current line |
| `Esc` | Close the current menu or interrupt the running turn; queued messages are kept and sent next, steered ones are dropped with the turn |
| `Ctrl+C` | Cancel a task, clear the input, or exit, depending on the current state |
| `Ctrl+D` | Exit DSH-Code |

#### Status indicators

| Indicator | Trigger |
| --- | --- |
| `✻ Deep diving...` | The turn is running while nothing is streaming (waiting for the first token, gaps during tool runs); an elapsed clock appears after 15 seconds |
| `✻ Thinking…` | Model reasoning is streaming; collapsed into the shimmer marker by default, expand with `Ctrl/Alt+R` |

## 4. How DSH-Code integrates with DSH

### 1. Runtime composition

DSH-Code reads the live Harness registries instead of maintaining a separate local copy. Model adapters, tool providers, skill sources, commands, permission policies, persistence backends, sandboxes, and subagent providers can all be added or replaced through DSH composition.

`/plugin` provides a read-only view of the current Cordis loader state.

### 2. Bundled and optional official plugins

The following official plugins ship with DSH-Code and are enabled in the composition by default:

- **Session search**: the model gets five read-only tools — `session_search`, `session_event_search`, `session_trace`, `session_event_trace`, `session_event_read` — over prior session logs (the index builds lazily on the first search; cross-session access is scoped by exact working directory; on Node 22 the first search prints a one-time `node:sqlite` experimental warning, which is expected).
- **Reminders**: `schedule` provides durable, restart-surviving reminders (created through the `schedule_create` / `schedule_list` / `schedule_delete` tools); the `/schedule` panel shows them read-only with overdue rows first. `time-context` injects a clock reading for the model (throttled to 30s).
- **Clock for reminders**: `time-context` injects the current time for the model (throttled to 30s), so phrasings like "remind me at 5 pm" work.

The following official plugins are installed but opt-in (append rows in the user layer `~/.dsh/profiles/cli/cordis.patch.yml`, or install as noted):

- **MCP servers** (`@deepseek-ai/dsh-mcp-client`, one row per server; tools register as `mcp__<server>__<tool>`):

  ```yaml
  - insert:
      - id: mcp-memory
        name: '@deepseek-ai/dsh-mcp-client'
        config:
          transport: stdio
          serverName: memory
          command: mcp-server-memory
  ```

  (HTTP transports use `transport: streamable-http` plus `url`; an unreachable server degrades to a reconnect loop and never breaks startup.)
- **Claude Code / Codex hooks bridges** (`@deepseek-ai/dsh-hooks-claude-code` / `-codex`): run existing hooks configurations at the interception seams; a missing hooks file is a silent no-op:

  ```yaml
  - insert:
      - id: hooks-claude
        name: '@deepseek-ai/dsh-hooks-claude-code'
        config:
          configPath: C:/Users/you/.claude/hooks.json
  ```
- **LSP navigation**: the composition carries `lsp` / `lsp-stdio` / `tool-lsp` rows in a disabled state — language-server binaries resolve at mount, and a missing binary would fail the whole composition boot. The host CLI does not bundle the three packages: install them into the profile first (`dsh plugin --profile cli add @deepseek-ai/dsh-lsp @deepseek-ai/dsh-lsp-stdio @deepseek-ai/dsh-tool-lsp`), then flip the three rows to `disabled: false` in the user layer and configure `lsp-stdio` `servers` (extension to language to server command); the model then gets the `lsp` tool (goToDefinition / findReferences / goToImplementation / hover).
- **Persistent terminals**: the PTY service and platform backends (pwsh dialect on Windows, bash on POSIX) mount by default, but the six model tools `terminal_open` / `terminal_send` / `terminal_read` / `terminal_signal` / `terminal_close` / `terminal_list` ship DISABLED — enabling them grants shell capability to every session, which the preset layer is supposed to gate, so deployments opt in explicitly. `@deepseek-ai/dsh-tool-terminal` is likewise not bundled by the host: run `dsh plugin --profile cli add @deepseek-ai/dsh-tool-terminal` first, then enable in the user layer:
  ```yaml
  - id: tool-terminal
    disabled: false
  ```
  (Background sends appear in the /jobs panel.)
- **tmux pane context** (`@deepseek-ai/dsh-tmux-context`): injects the current tmux pane into the model context when running inside tmux (`config: { refreshIntervalMs: 60000 }`); outside tmux every step degrades to a harmless no-op:
  ```yaml
  - insert:
      - id: tmux-context
        name: '@deepseek-ai/dsh-tmux-context'
        config:
          refreshIntervalMs: 60000
  ```
- **External CLI delegation**: `dsh plugin --profile cli add @deepseek-ai/dsh-subagent-claude-code` (or `-codex`) installs the dormant provider; following the upstream contract, copy the preset and enable the `tool-subagent-claude-code` / `tool-subagent-codex` row to let the model delegate tasks to the claude / codex CLIs.

### 3. Session-scoped Agent Presets

The Host owns the shared infrastructure—registries, persistence, session queries, permissions, and sandbox policies—while each session receives an isolated Agent scope composed by an **Agent Preset**:

- `standard` — a full-featured general-purpose coding Agent
- `ptc` — multi-operation workflows designed for PTC (formerly Code Mode); the legacy `code` id still works
- `minimal` — a single-tool composition keeping only the persistent shell
- `cordis` — the full Agent plus runtime inspection and Preset-authoring guidance
- user Presets — custom tools, prompt sections, skills, context compaction, plan mode, and subagent behavior

Use `/mode` before the first turn, or start directly with `--mode <preset>`. The selected Preset is written to the session and restored when the session resumes.

### 4. Session history and recovery

Prompts, streaming chunks, tool calls and results, model selections, plan state, permissions, titles, and Preset selections are all projected from durable Session events. Session recovery, export, history inspection, context metrics, and terminal replay use the same record.

React state stores only temporary interface details such as the input draft, cursor, active panel, selection, and scroll position.

```text
dsh profile
└─ Host plane: registries · persistence · queries · permissions · sandbox
   ├─ Agent session A + preset code
   ├─ Agent session B + preset minimal
   └─ DSH-Code TUI
      durable events → pure projection → append-only transcript
                                  └→ bounded panels → composer → status bar
```

## 5. Development

```sh
pnpm install
pnpm lint            # type-aware ESLint over src, tests, scripts, and the root configs
pnpm typecheck       # the build project (src)
pnpm typecheck:tests # the spec suite and scripts
pnpm test
pnpm test:coverage   # coverage report (trend visibility; no percentage gate)
pnpm build
pnpm verify          # lint + both typechecks + tests in one pass
pnpm run gen:whale   # regenerate src/whale-glyph.ts from the vendored logo path
```

`tsconfig.test.json` puts the specs inside a TypeScript project, so a fixture that drifts from the interface it fakes fails `pnpm typecheck:tests` instead of surfacing (or not) at runtime.

The whale glyph is generated from the DeepSeek FishLogo geometry vendored in `scripts/fish-logo.ts` (source: DeepSeek Harness, MIT).

### 1. Source development installation

For a local checkout:

```sh
dsh plugin --profile cli add file:C:/path/to/dsh-code
```

GitHub installation is available for source development:

```sh
dsh plugin --profile cli add github:unlinearity/dsh-code
```

The Git package builds during installation. If pnpm asks for an `allowBuilds` entry, copy the complete entry it prints into `~/.dsh/profiles/cli/pnpm-workspace.yaml`, then run the command again. The key contains the Git URL and commit, so it cannot be replaced with only `dsh-code`.

### 2. Uninstall

```sh
dsh plugin --profile cli remove dsh-code   # unmount the plugin from the cli profile
npm uninstall -g dsh-code                  # remove the global package and the deepseek / dsh-code commands
```

Both commands are required for a complete uninstall. The first only removes the profile mount, so the `deepseek` command still exists and reports "the cli profile does not mount dsh-code yet". The second removes the global npm package and its launch aliases. Uninstalling does not affect `@deepseek-ai/dsh` itself or any persisted session data.

### 3. References

- Runtime services, events, plugin scopes, and the persistence model follow **DeepSeek Harness**.
- Session navigation, overlay sizing, scrollback, bottom layout, and resize handling refer to **Codex CLI**.
- Slash-command discovery, turn steering, reasoning folds, approvals, and question flows refer to **Claude Code**.

DSH-Code is an independent MIT-licensed community project and is not affiliated with OpenAI or Anthropic.

Communities:

- [Linux DO](https://linux.do/): Learn AI at L Station!
- [DeepSeek Harness](https://www.deepseek.com/harness): the official DSH website

## License

[MIT](LICENSE). The vendored FishLogo geometry comes from DeepSeek Harness (MIT).
