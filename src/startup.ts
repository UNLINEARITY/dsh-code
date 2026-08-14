/**
 * The interactive terminal app's command-line provider: parses `--resume`,
 * `--continue`, `--session`, and `--help`, then publishes
 * {@link TUI_STARTUP_SERVICE} for the runner to consume lazily. Follows the
 * headless bundle's startup shape (a commander action publishing a service
 * through {@link parseCmdline}).
 *
 * Semantics:
 * - `--resume <id|prefix>` — continue the persisted session whose id or unique
 *   id-prefix matches; the TUI replays its transcript and appends to the same
 *   durable log.
 * - `--continue` / `-c` — resume the most recently modified persisted session
 *   whose project directory matches the current working directory.
 * - `--session <id>` — create a new session under an explicit identity (the
 *   id must not exist yet).
 * - no flags — a fresh session with a minted id.
 *
 * @module @deepseek-ai/dsh-tui/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the invocation can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the terminal runner. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** How the runner obtains its session identity. */
export type TuiStartup =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'named'; readonly sessionId: string }
  | { readonly kind: 'resume'; readonly sessionId: string }
  | { readonly kind: 'latest' }

/**
 * This app's command: the launcher's flags this app owns, its description,
 * and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile cli')
    .description('Claude-Code-style interactive terminal for DeepSeek Harness.')
    .helpOption('-h, --help', 'show this help')
    .option('-r, --resume <session>', 'resume the persisted session with this id (or unique id prefix)')
    .option('-c, --continue', 'resume the most recent persisted session for this working directory')
    .option('--session <id>', 'create a new session under this explicit id')
    .addHelpText('after', `
Examples:
  dsh --profile cli                       fresh session, minted id
  dsh --profile cli --resume abc123       resume session by id prefix
  dsh --profile cli --continue            resume the latest local session
`)
}

/**
 * Parse the invocation and publish the startup service. Mutual exclusions are
 * usage errors rejected from the action before anything is provided.
 * @param ctx - plugin context carrying the command line and exit request.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    const options = program.opts<{ resume?: string; continue?: boolean; session?: string }>()
    const selected = [options.resume !== undefined, options.continue === true, options.session !== undefined]
    if (selected.filter(Boolean).length > 1) {
      program.error('error: --resume, --continue, and --session are mutually exclusive')
    }
    if (options.session !== undefined && options.session === '') {
      program.error('error: --session needs an id')
    }
    if (options.resume !== undefined && options.resume === '') {
      program.error('error: --resume needs a session id or id prefix')
    }
    const startup: TuiStartup = options.resume !== undefined
      ? { kind: 'resume', sessionId: options.resume }
      : options.continue === true
        ? { kind: 'latest' }
        : options.session !== undefined
          ? { kind: 'named', sessionId: options.session }
          : { kind: 'fresh' }
    ctx.provide(TUI_STARTUP_SERVICE, { startup } satisfies { startup: TuiStartup })
  })
  parseCmdline(ctx, program)
}
