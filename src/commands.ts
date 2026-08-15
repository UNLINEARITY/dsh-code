/**
 * Slash-command bridge: forwards terminal command lines into the shared
 * `ctx.commands` registry (the same surface the web composer dispatches
 * through) and exposes the live descriptor list as completion candidates.
 * The runner keeps only its own TUI-local commands (`/help`, `/quit`,
 * `/clear`, `/model`) ahead of the registry dispatch.
 *
 * @module @deepseek-ai/dsh-tui/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'

/** Descriptor list snapshot the completion menu renders from. */
export interface CommandsView {
  /** Name-sorted descriptors after scoped shadowing. */
  readonly descriptors: readonly CommandDescriptor[]
  /** Latest descriptor-read failure; the help panel exposes it in place. */
  readonly error?: string
  /** Subscribe to list changes (`commands/change`); returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Retarget the agent whose scoped view the list is read through. */
  setAgent(agent: Agent): void
}

/**
 * Watch the live command registry. Reads the current list immediately and
 * re-reads on every registry mutation or agent retarget; notification
 * failures are contained by the registry itself, so this watcher only ever
 * re-reads. Without a `commands` service the view stays empty and all lines
 * fall through to normal prompts.
 * @param ctx - context carrying the `commands` service (optional).
 * @returns the view the completion menu subscribes to.
 */
export function watchCommands(ctx: Context): CommandsView {
  const commands = ctx.get('commands')
  let agent: Agent | undefined
  let descriptors: readonly CommandDescriptor[] = []
  let error: string | undefined
  const listeners = new Set<() => void>()
  const refresh = (): void => {
    if (commands === undefined || agent === undefined) return
    try {
      descriptors = commands.list(agent)
      error = undefined
    } catch (cause: unknown) {
      // Keep the last good catalog, but change its identity so subscribers
      // can render the recoverable failure in /help.
      descriptors = [...descriptors]
      error = cause instanceof Error ? cause.message : String(cause)
    }
    for (const listener of listeners) listener()
  }
  if (commands !== undefined) {
    ctx.on('commands/change', () => refresh())
  }
  return {
    get descriptors(): readonly CommandDescriptor[] {
      return descriptors
    },
    get error(): string | undefined {
      return error
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setAgent(next: Agent): void {
      agent = next
      refresh()
    },
  }
}

/**
 * Whether one command line is a syntactically valid slash command.
 * @param line - the complete candidate line.
 * @returns true when the line parses as `/name` or `/name input`.
 */
export function isSlashLine(line: string): boolean {
  return /^\/[a-z][a-z0-9_-]*(?=$|[\t ])/u.test(line)
}
