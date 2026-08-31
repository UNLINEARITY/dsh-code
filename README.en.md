# DSH-Code

English | [中文](README.md)

<p align="center"><img src="docs/pictures/dsh-1.png" width="95%" alt="DSH-Code welcome screen and model status"></p>

<p align="center"><img alt="Typing SVG" src="https://readme-typing-svg.herokuapp.com?font=JetBrains+Mono&amp;weight=500&amp;size=22&amp;duration=4000&amp;pause=700&amp;color=4176E6&amp;center=true&amp;vCenter=true&amp;width=680&amp;lines=DeepSeek+Harness+Code;Terminal+Coding+Interface+for+the+DSH+Core"></p>
<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek-Harness-4176E6?style=for-the-badge&amp;logo=deepseek&amp;logoColor=white&amp;labelColor=1c1917"></a>
  <a href="https://www.npmjs.com/package/@deepseek-ai/dsh"><img alt="dsh version" src="https://img.shields.io/badge/dsh-0.1.1--rc.2-4176E6?style=for-the-badge&amp;logo=deepseek&amp;logoColor=white&amp;labelColor=1c1917"></a>
  <a href="https://github.com/UNLINEARITY/dsh-code/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/UNLINEARITY/dsh-code?label=Stars&amp;style=for-the-badge&amp;logo=github&amp;logoColor=white&amp;color=4176E6&amp;labelColor=1c1917"></a>
  <a href="https://www.npmjs.com/package/dsh-code"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-code?label=npm&amp;style=for-the-badge&amp;logo=npm&amp;color=cb3837&amp;labelColor=1c1917"></a>
  <a href="https://github.com/UNLINEARITY/dsh-code/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/UNLINEARITY/dsh-code?label=License&amp;style=for-the-badge&amp;logo=opensourceinitiative&amp;color=4176E6&amp;labelColor=1c1917"></a>
</p>

---

## 1. Project overview

**DSH-Code is a terminal coding interface for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).** It is composed as an out-of-tree bundle on top of the official `@deepseek-ai/dsh-base` and uses the same Agent, Session, tool, command, skill, permission, sandbox, context-compaction, and plugin services as the Harness Web UI.

DeepSeek Harness registers models, tools, storage, policies, and interfaces as plugins through Cordis. Durable session events record the information required to restore conversations and runtime state. DSH-Code preserves that architecture while adding a terminal workflow suited to coding tasks. The interface follows terminal conventions familiar to developers, while runtime behavior remains governed by DSH services and configuration.

## 2. Quick start

Requires Node `^22.19 || >=24` and the preview `dsh` CLI (current release line: `@deepseek-ai/dsh@0.1.1-rc.2`). You can still enter the TUI, browse sessions, and use non-model features without configuring a model; press `a` in `/model` to manage API keys, OAuth, and device-code sign-in.

### 1. Install and update

Use the same commands for the initial installation and subsequent updates:

```sh
npm install -g @deepseek-ai/dsh@0.1.1-rc.2 dsh-code@1.0.2
npm install -g pnpm
dsh plugin --profile cli add dsh-code@1.0.2
```

> Note: pnpm ignores packages published less than 24 hours ago, so use the exact version `dsh-code@1.0.2` on release day; the version may be omitted after 24 hours. npm installation is not affected.
>
> Version alignment: dsh-code 1.0.2 targets dsh `0.1.1-rc.2`, with every Harness dependency pinned exactly to `0.1.1-rc.2`. Keep the global dsh CLI and dsh-code aligned instead of mixing release candidates. rc.2 removes the old DeepSeek setting `maxRequestImageBytes`.

### 2. Launch commands

Available launch commands:

```sh
dsh --profile cli
deepseek
dsh-code
```

`dsh --profile cli`, `deepseek`, and `dsh-code` are equivalent launch commands. `deepseek` and `dsh-code` are global aliases for `dsh --profile cli`, and all additional arguments are forwarded unchanged, for example `deepseek --resume abc123`.

> DeepSeek Harness is still a developer preview and may introduce compatibility-breaking changes. DSH-Code will continue to track the evolution of its plugin interfaces.

For installation, native-module, and plugin-loading issues, see [Troubleshooting](docs/problems.md).

## 3. Core features and usage

DSH-Code brings DSH Agents, models, tools, and durable sessions directly into the terminal, covering the complete workflow from writing code to reviewing changes.

### 1. Session management

- Create sessions with `/new`, or restore existing sessions with `/resume` and `--continue`
- Create a new work branch from a historical point with `/fork` while preserving the original session
- Search history by current directory, update time, and session scope
- Recall input history with Up/Down, or search previous prompts with `/history`
- Use persistent titles, Markdown export, context occupancy, token, cache, TTFT, and elapsed-time metrics
- Restore the session's Agent Preset and model selection when resuming it

<p align="center"><img src="docs/pictures/dsh-3.png" width="95%" alt="Searchable session resume picker"></p>

<p align="center"><img src="docs/pictures/dsh-4.png" width="95%" alt="Searchable prompt-history picker"></p>

### 2. Agents, models, and extensions

- Select an independent Agent Preset for each session to compose tools, prompt sections, skills, context compaction, plan mode, and subagent capabilities
- Use `/mode` to select `standard`, `code`, `minimal`, `cordis`, or a user-defined Preset
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
- Inspect changes by file with `/diff`, and start a read-only code review with `/review`
- Copy the latest complete response with `/copy`, and inspect full history and tool details with Ctrl+O
- Handle tool approvals, structured questions, plan reviews, multiple selections, and custom answers
- Control what the Agent may do with permission Presets and sandboxes; add instructions or interrupt while a task is running

### 5. Commands and key bindings

Start the TUI:

```sh
dsh --profile cli                    # create a standard session
dsh --profile cli --mode code        # start with the specified Agent Preset
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
| `/resume cancel` | Cancel a pending session switch |
| `/fork [event-seq]` | Create a session branch from the latest completed turn or a specified event position |
| `/delete [id\|prefix]` | Delete a session and its subagent sessions |
| `/title <text>` | Change the current session title |
| `/export [path]` | Export the current session as Markdown |
| `/history` | Search and reuse previously submitted prompts |
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
| `/review [--staged\|ref]` | Review Git changes with read-only permissions |
| `/todos` | View the complete todo list for the current session |
| `/agents` | View subagent sessions created by the current session |
| `/jobs` | View background jobs and their runtime status |
| `/copy` | Copy the latest complete assistant response |

#### Extensions, display, and exit

| Command | Purpose |
| --- | --- |
| `/plugin [query]` | Inspect loaded extensions and their status |
| `/statusline` | Select the items displayed in the status bar |
| `/vscode-keys` | Pass Ctrl+R through VS Code-family terminals (idempotent user-level keybindings.json write) |
| `/theme` | Switch the terminal color theme |
| `/help` | View key bindings, built-in commands, Harness commands, and user skills |
| `/quit` | Exit DSH-Code |

#### Input and key bindings

| Action | Purpose |
| --- | --- |
| `Enter` | Submit the current input |
| `Up` / `Down` | Recall the previous or next input-history entry |
| `Tab` | Complete commands, skills, or `@` references |
| `@` | Reference workspace files or existing sessions; image files are sent as attachments |
| `Ctrl+O` | Inspect full history and tool details |
| `Ctrl/Alt+R` | Fold or expand model reasoning; run /vscode-keys first in VS Code-family terminals to pass Ctrl+R through |
| `Shift+Tab` | Cycle through permission Presets |
| `Delete` | Cancel the newest queued message when the composer is empty |
| `Ctrl+K` | Delete from the cursor to the end of the line |
| `Ctrl+U` | Clear the current input line |
| `Ctrl+A` / `Ctrl+E` | Move to the beginning or end of the current line |
| `Esc` | Close the current menu or interrupt the running turn |
| `Ctrl+C` | Cancel a task, clear the input, or exit, depending on the current state |
| `Ctrl+D` | Exit DSH-Code |

## 4. How DSH-Code integrates with DSH

### 1. Runtime composition

DSH-Code reads the live Harness registries instead of maintaining a separate local copy. Model adapters, tool providers, skill sources, commands, permission policies, persistence backends, sandboxes, and subagent providers can all be added or replaced through DSH composition.

`/plugin` provides a read-only view of the current Cordis loader state.

### 2. Session-scoped Agent Presets

The Host owns the shared infrastructure—registries, persistence, session queries, permissions, and sandbox policies—while each session receives an isolated Agent scope composed by an **Agent Preset**:

- `standard` — a full-featured general-purpose coding Agent
- `code` — multi-operation workflows designed for Code Mode / PTC
- `minimal` — only a persistent shell and `str_replace_editor`
- `cordis` — the full Agent plus runtime inspection and Preset-authoring guidance
- user Presets — custom tools, prompt sections, skills, context compaction, plan mode, and subagent behavior

Use `/mode` before the first turn, or start directly with `--mode <preset>`. The selected Preset is written to the session and restored when the session resumes.

### 3. Session history and recovery

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
pnpm test
pnpm typecheck
pnpm build
pnpm run gen:whale   # regenerate src/whale-glyph.ts from the vendored logo path
```

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
