/**
 * User-invocable skill watch for the `/` completion menu: the in-process
 * equivalent of the web ui-skill trigger source. Skills are NOT commands —
 * picking one lands the literal `/name ` text in the input, and submitting
 * it as a normal prompt lets the host's tool-skill pre-step inject the body
 * (the only entry point for model-disabled skills). Command descriptors win
 * on a name collision; see the runner's dispatch.
 *
 * @module @deepseek-ai/dsh-code/skills
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isUserInvocable } from '@deepseek-ai/dsh-skill'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'

/** One completion-menu row derived from a user-invocable skill. */
export interface SkillRow {
  /** Skill name; the literal `/name` text is what a pick lands. */
  name: string
  /** Human-readable description (suffixed when model-invocation is off). */
  description: string
  /** Whether the model may also invoke this skill by name. */
  modelInvocable: boolean
}

/** The skill-catalog snapshot the completion menu subscribes to. */
export interface SkillsView {
  /** Name-sorted user-invocable rows; empty until the first load lands. */
  readonly rows: readonly SkillRow[]
  /** Subscribe to catalog changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Retarget the agent whose workspace the catalog is read for. */
  setAgent(agent: Agent): void
}

/** Internal shape shared by {@link watchSkills} and its test doubles. */
interface SkillsWatch extends SkillsView {
  setAgent(agent: Agent): void
}

function toRows(skills: readonly SkillSummary[]): readonly SkillRow[] {
  return skills
    .filter(skill => isUserInvocable(skill))
    .map(skill => ({
      name: skill.name,
      description: skill.description,
      modelInvocable: skill.invocation.modelInvocable === true,
    }))
    .sort((left, right) => left.name < right.name ? -1 : 1)
}

/**
 * Watch the user-invocable skill catalog for one agent's workspace. The first
 * load starts when the owning agent is known (`setAgent`); `skills/change`
 * and agent retargets re-read. Read failures keep the last good rows (the
 * next change notification is the retry surface) — a missing `skills`
 * service leaves the view permanently empty.
 * @param ctx - context carrying the `skills` service (optional).
 * @returns the view the completion menu subscribes to.
 */
export function watchSkills(ctx: Context): SkillsWatch {
  const skills = ctx.get('skills')
  let agent: Agent | undefined
  let rows: readonly SkillRow[] = []
  const listeners = new Set<() => void>()

  const reload = (): void => {
    if (skills === undefined || agent === undefined) return
    skills.list({
      cwd: agent.session.header.cwd,
      scope: agent,
    }).then((summaries: readonly SkillSummary[]) => {
      const next = toRows(summaries)
      if (next.length === rows.length && next.every((row, index) => row.name === rows[index]?.name)) return
      rows = next
      for (const listener of listeners) listener()
    }, () => {
      // Discovery failure keeps the last good rows; the next skills/change
      // notification is the retry surface (mirrors the web directory).
    })
  }

  if (skills !== undefined) {
    ctx.on('skills/change', reload)
  }

  const view: SkillsWatch = {
    get rows(): readonly SkillRow[] {
      return rows
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setAgent(next: Agent): void {
      agent = next
      reload()
    },
  }
  return view
}
