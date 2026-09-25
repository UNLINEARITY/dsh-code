/** Slash-command parsing and completion candidates shared by the composer and help panel. */

import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { t, type MessageKey } from './i18n.ts'
import { rankByName } from './render/fuzzy.ts'
import type { SkillRow } from './skills.ts'

/** One TUI-owned slash command: label plus its i18n description key. */
export interface LocalCommand {
  readonly label: string
  readonly descriptionKey: MessageKey
}

/** One source of truth for TUI-owned slash commands in completion and `/help`. */
export const LOCAL_COMMANDS: readonly LocalCommand[] = [
  { label: '/help', descriptionKey: 'cmd.help' },
  { label: '/model', descriptionKey: 'cmd.model' },
  { label: '/effort', descriptionKey: 'cmd.effort' },
  { label: '/mode', descriptionKey: 'cmd.mode' },
  { label: '/permission', descriptionKey: 'cmd.permission' },
  { label: '/new', descriptionKey: 'cmd.new' },
  { label: '/fork', descriptionKey: 'cmd.fork' },
  { label: '/resume', descriptionKey: 'cmd.resume' },
  { label: '/search', descriptionKey: 'cmd.search' },
  { label: '/plugin', descriptionKey: 'cmd.plugin' },
  { label: '/update', descriptionKey: 'cmd.update' },
  { label: '/jobs', descriptionKey: 'cmd.jobs' },
  { label: '/statusline', descriptionKey: 'cmd.statusline' },
  { label: '/theme', descriptionKey: 'cmd.theme' },
  { label: '/language', descriptionKey: 'cmd.language' },
  { label: '/rainbow', descriptionKey: 'cmd.rainbow' },
  { label: '/animation', descriptionKey: 'cmd.animation' },
  { label: '/history', descriptionKey: 'cmd.history' },
  { label: '/queue', descriptionKey: 'cmd.queue' },
  { label: '/usage', descriptionKey: 'cmd.usage' },
  { label: '/agents', descriptionKey: 'cmd.agents' },
  { label: '/todos', descriptionKey: 'cmd.todos' },
  { label: '/subagent', descriptionKey: 'cmd.subagent' },
  { label: '/vscode-keys', descriptionKey: 'cmd.vscode-keys' },
  { label: '/delete', descriptionKey: 'cmd.delete' },
  { label: '/clear', descriptionKey: 'cmd.clear' },
  { label: '/export', descriptionKey: 'cmd.export' },
  { label: '/title', descriptionKey: 'cmd.title' },
  { label: '/copy', descriptionKey: 'cmd.copy' },
  { label: '/diff', descriptionKey: 'cmd.diff' },
  { label: '/review', descriptionKey: 'cmd.review' },
  { label: '/quit', descriptionKey: 'cmd.quit' },
] as const

export const LOCAL_COMMAND_NAMES: ReadonlySet<string> = new Set(LOCAL_COMMANDS.map(command => command.label.slice(1)))

/** TUI-local commands that reject trailing input instead of forwarding it as a prompt. */
export const BARE_LOCAL_COMMANDS: ReadonlySet<string> = new Set([
  'quit', 'help', 'clear', 'copy', 'update', 'statusline', 'theme',
  'history', 'queue', 'usage', 'agents', 'todos', 'subagent',
])

/** Split a slash line into the command name and any trailing input. */
export function slashNameAndArgs(text: string): { readonly name: string; readonly args: string } | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?:$|[\t ](.*))$/u.exec(text)
  if (match === null || match[1] === undefined) return undefined
  return { name: match[1], args: (match[2] ?? '').trim() }
}

/** One completion candidate row. */
export interface CompletionCandidate {
  readonly label: string
  readonly description: string
  readonly origin: 'command' | 'skill' | 'mention'
}

/** Wrap one completion-menu cursor step; an empty menu keeps the index at zero. */
export function stepCompletionIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return ((index + delta) % count + count) % count
}

/** Merge local commands, registry descriptors, and skills using dispatch shadowing order. */
export function completionCandidates(
  value: string,
  descriptors: readonly CommandDescriptor[],
  skills: readonly SkillRow[],
): readonly CompletionCandidate[] {
  if (!value.startsWith('/')) return []
  const prefix = value.slice(1).split(' ')[0] ?? ''
  const local: CompletionCandidate[] = LOCAL_COMMANDS.map(command => ({
    label: command.label,
    description: t(command.descriptionKey),
    origin: 'command',
  }))
  const registry = descriptors
    .filter(descriptor => !LOCAL_COMMAND_NAMES.has(descriptor.name))
    .map((descriptor): CompletionCandidate => ({
      label: `/${descriptor.name}`,
      description: descriptor.description,
      origin: 'command',
    }))
  const taken = new Set([...local, ...registry].map(candidate => candidate.label.slice(1)))
  const skillRows = skills
    .filter(skill => !taken.has(skill.name))
    .map((skill): CompletionCandidate => ({
      label: `/${skill.name}`,
      description: skill.modelInvocable ? `skill · ${skill.description}` : `skill (user only) · ${skill.description}`,
      origin: 'skill',
    }))
  const seen = new Set<string>()
  const all: CompletionCandidate[] = []
  for (const candidate of [...local, ...registry, ...skillRows]) {
    const name = candidate.label.slice(1)
    if (seen.has(name)) continue
    seen.add(name)
    all.push(candidate)
  }
  return rankByName(all.map(candidate => ({ name: candidate.label.slice(1), candidate })), prefix)
    .map(entry => entry.candidate)
}
