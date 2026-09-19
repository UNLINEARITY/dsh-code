/**
 * Resolve the runner's startup flags from the loose plugin config.
 *
 * The Cordis config schema is deliberately loose (`kind` is an unvalidated
 * string, narrowed here), so this is the single place that maps a config row
 * onto the `TuiStartup` the runner consumes — pure, and unit-testable without
 * a plugin context.
 *
 * @module @deepseek-ai/dsh-code/runner/startup-config
 */

import { parseThemeName } from '../theme.ts'
import type { TuiStartup } from '../startup.ts'

/** The config row shape this resolver narrows; satisfied by the plugin schema. */
export interface StartupConfigRow {
  /** How this invocation obtains its session identity. */
  readonly kind: string
  readonly sessionId?: string
  readonly mode?: string
  readonly theme?: string
  readonly prompt?: string
  readonly images?: readonly string[]
}

/**
 * Narrow one config row to a startup.
 *
 * `resume`/`named` without a session id degrade to a fresh launch, an invalid
 * theme string narrows to the dark default (and is therefore still present),
 * and `mode` only survives on the kinds that can pre-compose a session.
 * @param config - the validated plugin config.
 * @returns the startup the runner will resolve a target from.
 */
export function resolveStartupConfig(config: { readonly startup: StartupConfigRow }): TuiStartup {
  const row = config.startup
  // The CLI validated --theme at parse time; the loose config schema falls
  // back to dark for anything unexpected.
  const theme = row.theme === undefined ? undefined : parseThemeName(row.theme)
  const input = {
    ...(theme === undefined ? {} : { theme }),
    ...(row.prompt === undefined ? {} : { prompt: row.prompt }),
    ...(row.images === undefined ? {} : { images: [...row.images] }),
  }
  if (row.kind === 'resume' && row.sessionId !== undefined) {
    return { kind: 'resume', sessionId: row.sessionId, ...input }
  }
  if (row.kind === 'latest') return { kind: 'latest', ...input }
  const mode = row.mode === undefined ? {} : { mode: row.mode }
  if (row.kind === 'named' && row.sessionId !== undefined) {
    return { kind: 'named', sessionId: row.sessionId, ...mode, ...input }
  }
  return { kind: 'fresh', ...mode, ...input }
}
