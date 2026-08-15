/** Lightweight session-directory projection for the /resume picker. */

import { basename, resolve } from 'node:path'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

export interface SessionRecord {
  readonly header: SessionHeader
  readonly live: boolean
  readonly persisted: boolean
}

export interface TitleObservationResult {
  readonly sessionId: string
  readonly status: 'fulfilled' | 'rejected'
  readonly value?: { readonly title?: { readonly title?: string; readonly text?: string } }
}

export interface SessionLogSnapshot {
  readonly session: SessionHeader
  readonly events: SessionEvent[]
}

/** Structural upstream SessionQuery surface used by the TUI. */
export interface SessionQueryService {
  listSessions(signal?: AbortSignal): Promise<SessionRecord[]>
  readTitleSnapshots(ids: readonly string[], signal?: AbortSignal): Promise<TitleObservationResult[]>
  readSession(id: string, signal?: AbortSignal): Promise<SessionLogSnapshot>
}

export type SessionScope = 'roots' | 'all'
export type CwdScope = 'all' | 'current'
export type SessionSort = 'newest' | 'oldest'

export interface SessionDirectoryOptions {
  readonly sessions: SessionScope
  readonly cwd: CwdScope
  readonly sort: SessionSort
  readonly currentCwd: string
  readonly query: string
}

export interface SessionRow {
  readonly id: string
  readonly createdAt: number
  readonly cwd: string
  readonly workspace: string
  readonly parent?: string
  readonly subagent: boolean
  readonly resumable: boolean
  readonly live: boolean
  readonly persisted: boolean
  readonly preset: string
  readonly title?: string
}

function samePath(left: string | undefined, right: string): boolean {
  if (left === undefined) return false
  return resolve(left).toLowerCase() === resolve(right).toLowerCase()
}

/** Filter/sort header-only records. No session log is loaded here. */
export function projectSessionRows(records: readonly SessionRecord[], options: SessionDirectoryOptions): SessionRow[] {
  const needle = options.query.trim().toLowerCase()
  return records
    .filter(record => options.sessions === 'all'
      || (record.header.parentSession === undefined && record.header.origin !== 'subagent'))
    .filter(record => options.cwd === 'all' || samePath(record.header.cwd, options.currentCwd))
    .map(record => {
      const cwd = record.header.cwd ?? ''
      const subagent = record.header.origin === 'subagent' || record.header.parentSession !== undefined
      return {
        id: record.header.id,
        createdAt: record.header.createdAt,
        cwd,
        workspace: cwd === '' ? '(no workspace)' : basename(cwd),
        parent: record.header.parentSession,
        subagent,
        resumable: !subagent,
        live: record.live,
        persisted: record.persisted,
        preset: record.header.agentPreset ?? 'standard',
      }
    })
    .filter(row => needle === '' || `${row.id} ${row.cwd} ${row.workspace} ${row.preset}`.toLowerCase().includes(needle))
    .sort((left, right) => options.sort === 'newest'
      ? right.createdAt - left.createdAt
      : left.createdAt - right.createdAt)
}

/** Merge page-local title observations without disturbing directory order. */
export function mergeSessionTitles(
  rows: readonly SessionRow[],
  observations: readonly TitleObservationResult[],
): SessionRow[] {
  const titles = new Map<string, string>()
  for (const observation of observations) {
    if (observation.status !== 'fulfilled') continue
    const title = observation.value?.title?.title ?? observation.value?.title?.text
    if (title !== undefined && title.trim() !== '') titles.set(observation.sessionId, title)
  }
  return rows.map(row => titles.has(row.id) ? { ...row, title: titles.get(row.id) } : row)
}
