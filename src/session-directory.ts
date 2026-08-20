/** Lightweight session-directory projection for the /resume picker. */

import { basename, dirname, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
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
  /** Last-activity timestamp: artifact mtime when known, else createdAt. */
  readonly updatedAt: number
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

/** True only for delegated subagents; ordinary forks also carry lineage. */
export function isSubagentSession(header: SessionHeader): boolean {
  return header.origin === 'subagent'
}

function comparablePath(value: string): string {
  const resolved = resolve(value)
  // Codex's paths_match_after_normalization pattern: canonicalize through the
  // filesystem when the path exists (resolving symlinks, subst drives, and
  // junctions that plain `resolve` keeps distinct), falling back to lexical
  // resolution when the directory no longer does.
  const fold = (path: string): string => CASE_INSENSITIVE_FS ? path.toLowerCase() : path
  try {
    return fold(realpathSync(resolved))
  } catch {
    return fold(resolved)
  }
}

/** Platform-consistent path equality for session cwd comparisons. */
function samePath(left: string | undefined, right: string): boolean {
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

/**
 * Filter/sort header-only records. No session log is loaded here. Sorting is
 * by LAST ACTIVITY (`updated` — artifact mtime when the caller resolved one,
 * else createdAt), matching the codex resume picker's default UpdatedAt
 * ordering: a session you kept talking in outranks one created later but idle.
 * @param records - the header-only records.
 * @param options - filter/sort options.
 * @param updated - per-session last-activity timestamps, when resolved.
 */
export function projectSessionRows(
  records: readonly SessionRecord[],
  options: SessionDirectoryOptions,
  updated?: ReadonlyMap<string, number>,
): SessionRow[] {
  const needle = options.query.trim().toLowerCase()
  return records
    .filter(record => options.sessions === 'all' || !isSubagentSession(record.header))
    .filter(record => options.cwd === 'all' || samePath(record.header.cwd, options.currentCwd))
    .map(record => {
      const cwd = record.header.cwd ?? ''
      const subagent = isSubagentSession(record.header)
      const activity = updated?.get(record.header.id)
      return {
        id: record.header.id,
        createdAt: record.header.createdAt,
        updatedAt: activity === undefined || !Number.isFinite(activity) || activity < record.header.createdAt
          ? record.header.createdAt
          : activity,
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
      ? right.updatedAt - left.updatedAt || right.createdAt - left.createdAt
      : left.updatedAt - right.updatedAt || left.createdAt - right.createdAt)
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

/**
 * Encode a session id the way the JSONL backend does for its on-disk layout
 * (`encodeSegment`: safe units literal, everything else `~XXXX`). Used ONLY to
 * validate that a `locate()` path really is this session's directory before
 * any deletion touches the filesystem — a local copy of the pure upstream
 * contract, kept in sync with `session-persistence-jsonl/src/format.ts`.
 */
export function encodeSessionSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/u.test(ch)) {
      out += ch
    } else {
      out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
    }
  }
  return out
}

/** The session-log artifact names the JSONL backend may create. */
export const SESSION_ARTIFACT_NAMES: readonly string[] = ['session.jsonl', 'session.jsonl.zstd']

/**
 * Guard one `locate()` artifact path before deletion (codex's scoped-path
 * check, adapted to the JSONL layout): the file must be a `session.jsonl`
 * artifact sitting in the directory named exactly `encodeSegment(id)`.
 * @param artifact - the path the persistence backend located.
 * @param id - the session id the artifact claims to belong to.
 * @returns the owning session directory, or undefined when the layout is unexpected.
 */
export function sessionArtifactDirectory(artifact: string, id: string): string | undefined {
  if (basename(artifact) !== 'session.jsonl' && basename(artifact) !== 'session.jsonl.zstd') return undefined
  const dir = dirname(artifact)
  if (basename(dir) !== encodeSessionSegment(id)) return undefined
  return dir
}

/**
 * Collect one session's deletion subtree: the id plus every record whose
 * parent chain leads to it (codex deletes subagent threads with their root).
 * @param records - the full directory listing.
 * @param id - the root session id to delete.
 * @returns the ids to delete, root first.
 */
export function collectDeletionSubtree(records: readonly SessionRecord[], id: string): string[] {
  const parentOf = new Map<string, string | undefined>()
  for (const record of records) parentOf.set(record.header.id, record.header.parentSession)
  const doomed = new Set<string>([id])
  // Iterate to a fixed point: children may be listed before their parents.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const candidate of parentOf.keys()) {
      if (doomed.has(candidate)) continue
      let ancestor = parentOf.get(candidate)
      let depth = 0
      while (ancestor !== undefined && depth < 64) {
        if (doomed.has(ancestor)) {
          doomed.add(candidate)
          break
        }
        ancestor = parentOf.get(ancestor)
        depth += 1
      }
    }
  }
  return [...doomed]
}

/**
 * Codex-style relative time for session rows ("now", "5m ago", "3h ago",
 * "2d ago"; older than a week falls back to the local date).
 * @param timestamp - epoch milliseconds of the last activity.
 * @param now - the pinned reference clock (one value per list render).
 */
export function formatRelativeTime(timestamp: number, now: number): string {
  const seconds = Math.round((now - timestamp) / 1000)
  if (seconds < 0) return 'now'
  if (seconds < 60) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  const date = new Date(timestamp)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}
