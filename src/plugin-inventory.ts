      /* * The keystone lock (user-ratified policy, 2026-09-28): ONLY the modules this
 * bundle's own patch names — every bare-disable row (the collision rows:
 * re-enabling one through the profile layer duplicates a service and breaks
 * boot), every insert the TUI needs to run, the preset-boundary tool rows —
 * plus the TUI's own rows and the llm-pi-ai provider layer. Everything else
 * the composition ships stays freely toggleable from /plugin, including core
 * base services: loader entry ids are path-prefixed (they never equal patch
 * row ids), so module names are the join key.
  * The keystone test recomputes this set from the repo patch files plus the
 * pinned base id-to-module fixture and fails CI on drift.
 */
export const KEYSTONE_MODULES: ReadonlySet<string> = new Set(["@deepseek-ai/dsh-agent-instructions", "@deepseek-ai/dsh-agent-preset-registry", "@deepseek-ai/dsh-command-compact", "@deepseek-ai/dsh-command-goal", "@deepseek-ai/dsh-compaction-basic", "@deepseek-ai/dsh-compaction-tool-result-pruner", "@deepseek-ai/dsh-cordis-host-runner", "@deepseek-ai/dsh-file-reference-local", "@deepseek-ai/dsh-llm-pi-ai", "@deepseek-ai/dsh-lsp", "@deepseek-ai/dsh-lsp-stdio", "@deepseek-ai/dsh-message-feedback", "@deepseek-ai/dsh-plan-mode", "@deepseek-ai/dsh-session-query-sqlite", "@deepseek-ai/dsh-session-reference", "@deepseek-ai/dsh-skill-filesystem", "@deepseek-ai/dsh-system-prompt", "@deepseek-ai/dsh-terminal", "@deepseek-ai/dsh-terminal-bash", "@deepseek-ai/dsh-time-context", "@deepseek-ai/dsh-tmux-context", "@deepseek-ai/dsh-tool-bash", "@deepseek-ai/dsh-tool-fs", "@deepseek-ai/dsh-tool-fs-search", "@deepseek-ai/dsh-tool-goal", "@deepseek-ai/dsh-tool-jobs", "@deepseek-ai/dsh-tool-lsp", "@deepseek-ai/dsh-tool-pwsh", "@deepseek-ai/dsh-tool-ralph", "@deepseek-ai/dsh-tool-session-query", "@deepseek-ai/dsh-tool-skill", "@deepseek-ai/dsh-tool-subagent", "@deepseek-ai/dsh-tool-subagent-control", "@deepseek-ai/dsh-tool-subagent-control/list-agents", "@deepseek-ai/dsh-tool-subagent/model-selection-settings", "@deepseek-ai/dsh-tool-terminal", "@deepseek-ai/dsh-tool-todo", "@deepseek-ai/dsh-tool-workflow", "@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-workflow-ptc", "@deepseek-ai/dsh-workspace-changes", "dsh-code", "dsh-code/session-query", "dsh-code/startup"])


import type { Context, FiberState } from '@deepseek-ai/cordis'

export type PluginPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null

export interface PluginRow {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly phase: PluginPhase
}

const PHASES: Record<number, PluginPhase> = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: null,
  5: 'unloading',
}

interface LoaderEntry {
  readonly id: string
  readonly disabled: boolean
  readonly options: { readonly group?: boolean; readonly name: string }
  readonly fiber?: { readonly state: FiberState }
}

/** Snapshot the live Loader; group-only rows are composition containers, not plugins. */
export function listPluginRows(ctx: Context): PluginRow[] {
  const loader = (ctx as unknown as { get(name: string): unknown }).get('loader') as
    | { entries(): Iterable<LoaderEntry> }
    | undefined
  if (loader === undefined) return []
  const rows: PluginRow[] = []
  for (const entry of loader.entries()) {
    if (entry.options.group === true) continue
    rows.push({
      entryId: entry.id,
      moduleName: entry.options.name,
      enabled: !entry.disabled,
      phase: entry.fiber === undefined ? null : PHASES[entry.fiber.state] ?? null,
    })
  }
  return rows
}
