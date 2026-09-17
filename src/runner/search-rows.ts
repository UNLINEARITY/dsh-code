/** Cross-session search rows for the /search panel.
 *
 * Owns the panel row shape and the pure mapping from a session-query hit, so
 * the row contract does not live inside the panel component that renders it
 * and the runner can build rows without importing the panel module.
 *
 * @module @deepseek-ai/dsh-code/search-rows
 */

import type { SessionHeader } from '@deepseek-ai/dsh-session'

/** One cross-session full-text search hit mapped from the session-query engine. */
export interface SearchRow {
  /** Session id (Enter resumes it through the switch machinery). */
  readonly id: string
  /** Display label: session title or the short id form. */
  readonly label: string
  /** Secondary facts line (workspace · preset markers). */
  readonly detail: string
  /** Bounded plain-text excerpt around the strongest match. */
  readonly snippet: string
  /** Match timestamp (relative labels derive from it). */
  readonly updatedAt: number
  /** Whether the hit is a delegated subagent conversation (not resumable). */
  readonly subagent: boolean
  /** Whether Enter may switch into it. */
  readonly resumable: boolean
}

/**
 * Map one cross-session full-text hit onto the /search panel's row (pure).
 * Labels fall back to the short id form — the engine's hit carries the
 * strongest matching event, not the title observation.
 */
export function searchHitToRow(hit: {
  header: SessionHeader
  bestMatch: { snippet: string; time: number }
}): SearchRow {
  const subagent = hit.header.origin === 'subagent'
  const cwd = hit.header.cwd ?? ''
  // Session cwds may arrive in either separator style regardless of the
  // observing host (a workspace synced from Windows), so split on both.
  const workspace = cwd.split(/[\\/]/u).filter(part => part !== '').at(-1) ?? ''
  const preset = hit.header.agentPreset ?? ''
  const flat = hit.bestMatch.snippet.replace(/\s+/gu, ' ').trim()
  return {
    id: hit.header.id,
    label: hit.header.id.slice(-12),
    detail: [workspace, preset].filter(part => part !== '').join(' · '),
    snippet: flat.length > 158 ? `${flat.slice(0, 157)}…` : flat,
    updatedAt: hit.bestMatch.time,
    subagent,
    resumable: !subagent,
  }
}
