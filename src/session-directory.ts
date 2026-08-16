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

/** Case-insensitive filesystems (Windows, macOS) compare paths by lowercased form. */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

/** True when the header describes a subagent conversation (durable lineage). */
export function isSubagentSession(header: SessionHeader): boolean {
  return header.origin === 'subagent' || header.parentSession !== undefined
}

function comparablePath(value: string): string {
  const resolved = resolve(value)
  return CASE_INSENSITIVE_FS ? resolved.toLowerCase() : resolved
}

/** Platform-consistent path equality for session cwd comparisons. */
export function samePath(left: string | undefined, right: string): boolean {
  if (left === undefined) return false
  return comparablePath(left) === comparablePath(right)
}

/**
 * Unique header match by exact id or unique id prefix (root and subagent
 * headers alike); the caller applies any lineage gate.
 * @param headers - the persisted headers.
 * @param wanted - the id or id prefix.
 * @returns the uniquely matched header.
 * @throws when nothing matches or the prefix is ambiguous.
 */
export function matchSessionId(headers: readonly SessionHeader[], wanted: string): SessionHeader {
  const exact = headers.filter(header => header.id === wanted)
  const matches = exact.length > 0 ? exact : headers.filter(header => header.id.startsWith(wanted))
  if (matches.length === 0) throw new Error(`no persisted session matches "${wanted}"`)
  if (matches.length > 1) {
    throw new Error(`session prefix "${wanted}" is ambiguous (${matches.length} matches): use more of the id`)
  }
  return matches[0]!
}

/** The newest persisted ROOT session pinned to this cwd, or undefined. */
export function newestRootForCwd(headers: readonly SessionHeader[], cwd: string): SessionHeader | undefined {
  const local = headers
    .filter(header => !isSubagentSession(header) && samePath(header.cwd, cwd))
    .sort((left, right) => right.createdAt - left.createdAt)
  return local[0]
}

/** Filter/sort header-only records. No session log is loaded here. */
export function projectSessionRows(records: readonly SessionRecord[], options: SessionDirectoryOptions): SessionRow[] {
  const needle = options.query.trim().toLowerCase()
  return records
    .filter(record => options.sessions === 'all' || !isSubagentSession(record.header))
    .filter(record => options.cwd === 'all' || samePath(record.header.cwd, options.currentCwd))
    .map(record => {
      const cwd = record.header.cwd ?? ''
      const subagent = isSubagentSession(record.header)
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
