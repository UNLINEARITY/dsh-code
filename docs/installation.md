# Installation and upgrade troubleshooting

English | [中文](installation_CN.md) · [README](../README.md)

Use this page for native-module failures, version alignment, settings migration, and dependency repair. Basic npm installation is in the [quick start](../README.md#2-quick-start).

## Native install scripts

If npm reports `npm warn install-scripts` or dsh fails to load a native module, rerun the npm command in the quick start with its `--allow-scripts` option. It approves the dependencies dsh needs for terminals, session storage, and the process sandbox, along with `@google/genai` and `protobufjs`.

## Version alignment

DSH-Code 2.2.0 requires Node.js 24.9.0 or later and exactly `@deepseek-ai/dsh@0.2.2-rc.5`. Upgrade dsh, DSH-Code, and any separately installed Harness profile plugins together. If your profile uses a local `link:` mount, update the host, then rebuild the checkout with `pnpm install --frozen-lockfile && pnpm build`.

The host supplies the session-query tool. If your `cli` profile already installs `@deepseek-ai/dsh-tool-session-query` separately, remove the duplicate with `dsh plugin --profile cli remove @deepseek-ai/dsh-tool-session-query`.

## Session migration

Sessions and startup arguments recorded under the legacy `code` preset map automatically to the upstream-renamed `ptc` — no manual migration. The session-log reader follows upstream to format v4: older logs migrate in the kernel on read (v3 to v4), and the original files on disk stay untouched.

## Settings migration

On the first boot of a dsh 0.1.7-targeting build, the host imports the retired global `settings.yaml` into the active profile once (the file is then renamed to `settings.yaml.imported`). Upgrade dsh and dsh-code together so no degraded boot falls in between. If provider/model configuration goes missing after an upgrade, the TUI detects it at startup and re-imports the stranded sections automatically through the host's own settings pipe — no manual steps, no re-login (credentials are unaffected). Only when the settings service is unwritable do you need the manual fallback: copy `settings.yaml.imported` to `settings.yaml` under the dsh home and restart.

## Dependency repair

After manually reinstalling dsh, run `deepseek repair-deps` with all dsh sessions closed. It backs up the host manifest and lockfile under `~/.dsh/backups/runtime-deps/`, applies scoped dependency fixes in the existing installation, verifies the versions each service loads, and audits the production dependency tree. `deepseek setup` and `deepseek update --apply` include this step. `deepseek repair-deps --check` checks active versions without changing files; `deepseek doctor` includes the same version check.

## Upgrade troubleshooting

Before upgrading `@deepseek-ai/dsh`, quit every running `dsh` / `deepseek` session: a global install replaces the files a running TUI is still reading, and that session dies with `read EIO`. After every install or upgrade, check the composition:

```sh
dsh --profile cli --dump-config   # must print no "skipping", "disabling", or "not found" lines
deepseek doctor
```

| Symptom | Cause | Fix |
|---|---|---|
| `npm warn install-scripts`, then `Failed to load native module` (`pty.node`, `koffi`) or a terminal / persistence plugin failing to load | npm 11.6+ skips the install scripts of global dependencies unless they are approved | Rerun the install with the approval list: `npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs @deepseek-ai/dsh@0.2.2-rc.5 pnpm` |
| A running session crashes with `read EIO` during an upgrade | The global install replaced files the session was reading | Quit every `dsh` session, rerun the install, then start again |
| `--dump-config` prints `skipping` or `disabling` with a peer-version mismatch | An installed profile plugin targets an older Harness release | Reinstall the plugin named in the message at version `0.2.2-rc.5`. Remove any separately installed `@deepseek-ai/dsh-tool-session-query` entry because the host supplies it |
| `patch: entry "<id>" not found` | `~/.dsh/profiles/cli/cordis.patch.yml` overrides a row the new line removed. 0.2.1 removed `tool-ralph`, `skill-badge`, and the `*-invariant` rows | Delete that entry from the profile patch |
| `Cannot find module '@deepseek-ai/dsh-invariants'` or `.../invariant` | The runtime invariant packages were removed in 0.2.1 | Delete rows naming `@deepseek-ai/dsh-invariants` or ending in `/invariant` from the profile patch |
| Every model request fails before it is sent with `unknown prompt variable "{{cwd}}"` | 0.2.1 removed the `{{cwd}}` prompt variable; the session directory now reaches the model as context | Remove the `{{cwd}}` clause from any `personaPrefix` / `suffix` in the profile patch |
| `tool-subagent` config rejects `backgroundMode`, `persona`, or `toolFilter` | 0.2.1 replaced these with managed subagent activations and Agent Presets | Delete those keys from the profile patch |
| Tools config rejects `mode: both` or `DSH_TOOLS_MODE=both` | Tool presentation accepts only `native` or `ptc` | Use `native` or `ptc` |
| `AUTH: Authentication Fails, Your api key ... is invalid` after upgrading, although the exported key works | Since 0.2.1 a key saved in `~/.dsh/.credentials.yaml` wins over an exported variable with the same name | Replace the saved key in `/model` (press Tab for provider management), or delete that name under `refs` in `~/.dsh/.credentials.yaml` to fall back to the exported variable |
| The DeepSeek group or another provider disappears from `/model` | API-key routes now hide their models until the credential is configured | Configure the key in `/model`, or export the variable the route's `apiKeyEnv` names |
| `/hooks` refuses with an install command | The host no longer bundles the hooks bridges | Run the printed command, e.g. `dsh plugin --profile cli add @deepseek-ai/dsh-hooks-claude-code@0.2.2-rc.5 @deepseek-ai/dsh-hook-protocol@0.2.2-rc.5`, then restart |

The Harness upgrade guides list every migration in detail: [docs/upgrade-guide](https://github.com/deepseek-ai/deepseek-harness/tree/main/docs/upgrade-guide). More problems and fixes: [Troubleshooting](problems.md).
