/** Session directory IO exposed to the picker, /delete, and /export.
 *
 * The kernel persistence seam has NO deletion API by design — logs accumulate
 * "until removed externally" — so removal is planned, layout-checked, and
 * lease-guarded here before any file is touched. Every read goes through the
 * in-process session-query engine, so this module stays free of `app.ts` and
 * of the Ink tree.
 *
 * @module @deepseek-ai/dsh-code/runner/session-io
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import { buildExportMarkdown } from '../render/export.ts'
import {
  acquireSessionDeletionLeases,
  isSessionArtifactName,
  jsonlSessionRoot,
  mergeSessionTitles,
  planSessionDeletion,
  projectSessionRows,
  releaseSessionDeletionLeases,
  sessionArtifactDirectory,
  sessionDirectoryFor,
  sessionRowMatchesQuery,
  type SessionDeletionPersistence,
  type SessionDirectoryOptions,
  type SessionQueryService,
  type SessionRow,
} from '../session/session-directory.ts'
import { createTranscriptStore } from '../session/store.ts'

/**
 * The persistence surface this module needs: the JSONL backend's public
 * session root plus its per-session write handles. Typing the narrow shape
 * instead of the upstream service keeps the IO injectable from a test double.
 */
export interface SessionIoPersistence extends SessionDeletionPersistence {
  /** JSONL backend plugin config carrying the session root, when exposed. */
  readonly config?: { readonly root?: unknown }
}

/** Services the session IO closes over. */
export interface SessionIoServices {
  /** In-process session-query engine; absent in profiles without one. */
  readonly sessionQuery?: SessionQueryService
  /** The durable persistence service; absent in profiles without one. */
  readonly persistence?: SessionIoPersistence
  /** The session currently visible in the UI (self-deletion guard). */
  readonly activeSessionId: () => string | undefined
}

/** Session directory reads and the guarded /delete operation. */
export interface SessionIo {
  /** Project the session directory for the picker (query-filtered). */
  readonly loadSessions: (options: SessionDirectoryOptions, signal?: AbortSignal) => Promise<readonly SessionRow[]>
  /** Delete one session subtree, returning the outcome line. */
  readonly deleteSession: (id: string) => Promise<string>
  /** Render one session's whole transcript as export Markdown. */
  readonly loadSessionTranscript: (id: string, signal?: AbortSignal) => Promise<string>
}

/**
 * Bind the session IO to one runner's services.
 * @param services - the query engine, persistence, and the live-session probe.
 * @returns the picker/delete/export reads used by the app bridge.
 */
export function createSessionIo(services: SessionIoServices): SessionIo {
  const { sessionQuery, persistence } = services

  const loadSessions = async (options: SessionDirectoryOptions, signal?: AbortSignal): Promise<readonly SessionRow[]> => {
    if (sessionQuery === undefined) throw new Error('session query is unavailable in this profile')
    const records = await sessionQuery.listSessions(signal)
    // Last-activity timestamps for sorting (codex UpdatedAt default): the
    // newest generation artifact's mtime under the JSONL layout. 0.1.5 dropped
    // the persistence `locate()` query, so paths are derived from the
    // backend's public config root. Backends without a JSONL config (or
    // vanished directories) fall back to createdAt inside the projection.
    const root = jsonlSessionRoot(persistence)
    const updated = new Map<string, number>()
    if (root !== undefined) {
      await Promise.all(records.map(async record => {
        try {
          const dir = sessionDirectoryFor(root, record.header.cwd, record.header.id)
          const entries = await readdir(dir, { withFileTypes: true })
          const stats = await Promise.all(
            entries.filter(entry => entry.isFile() && isSessionArtifactName(entry.name))
              .map(entry => stat(join(dir, entry.name))),
          )
          const newest = Math.max(...stats.map(info => info.mtimeMs))
          if (Number.isFinite(newest)) updated.set(record.header.id, newest)
        } catch {
          // Artifact gone or unreadable: the projection falls back to createdAt.
        }
      }))
    }
    const projected = projectSessionRows(records, { ...options, query: '' }, updated)
    // Titles are the expensive fold. Fetch the first picker page when idle;
    // a non-empty query loads more so the displayed title can match.
    const titleBudget = options.query.trim() === '' ? 32 : Math.min(projected.length, 128)
    const page = projected.slice(0, titleBudget)
    if (page.length === 0) return projected
    const observations = await sessionQuery.readTitleSnapshots(page.map(row => row.id), signal)
    const titled = mergeSessionTitles(projected, observations)
    return titled.filter(row => sessionRowMatchesQuery(row, options.query))
  }

  /**
   * Delete one session subtree (/delete, codex semantics: subagent threads go
   * with their root). The kernel persistence seam has NO deletion API by
   * design — logs accumulate "until removed externally" — so this is the
   * controlled external removal, in three phases with a hard boundary
   * between planning and touching the filesystem:
   *
   * 1. `planSessionDeletion` collects the subtree and refuses when the root
   *    or ANY member is live (a live child would outlive its deleted
   *    parent), ordering the plan children-first.
   * 2. Every plan node must derive to a guarded artifact directory
   *    (`encodeSegment(id)` layout beneath the backend's config root).
   *    Backends without a derivable artifact (non-JSONL) refuse the WHOLE
   *    deletion here — no file has been touched yet, so a backend or layout
   *    surprise can never strand a half-deleted subtree.
   * 3. Acquire every node's public persistence write handle before touching
   *    files. The JSONL backend holds its cross-process kernel lease for each
   *    handle, so another terminal's live session refuses the whole deletion.
   * 4. Artifacts are removed children-first while every lease remains held:
   *    only an I/O error mid-delete can stop it short (reported with
   *    removed/total counts), leaving the shallowest lineage intact.
   *
   * @param id - the root session id to delete.
   * @returns the outcome line for the panel/notice.
   */
  const deleteSession = async (id: string): Promise<string> => {
    if (sessionQuery === undefined) return 'session query is unavailable in this profile'
    const activeId = services.activeSessionId()
    if (activeId !== undefined && activeId === id) return 'cannot delete the session you are using — switch or /new first'
    const records = await sessionQuery.listSessions()
    const plan = planSessionDeletion(records, id)
    if (!plan.ok) return plan.reason
    // Phase 2 completes the plan before the first rm: derive and
    // layout-check every node up front, so a refusal never leaves a
    // partially removed subtree behind.
    const root = jsonlSessionRoot(persistence)
    if (root === undefined || persistence === undefined) {
      return 'session backend exposes no deletable artifact (deletion is unsupported on this backend)'
    }
    const byId = new Map<string, (typeof records)[number]>(records.map(record => [record.header.id, record]))
    const dirs = new Map<string, string>()
    for (const node of plan.nodes) {
      const record = byId.get(node.id)
      if (record === undefined) return `no persisted session matches "${node.id}"`
      const dir = sessionArtifactDirectory(sessionDirectoryFor(root, record.header.cwd, node.id), node.id)
      if (dir === undefined) {
        return `refusing to delete: unexpected artifact layout for ${node.id.slice(-12)}`
      }
      dirs.set(node.id, dir)
    }
    let leases
    try {
      leases = await acquireSessionDeletionLeases(persistence, plan.nodes.map(node => node.id))
    } catch (error: unknown) {
      if (error instanceof SessionAlreadyOwnedError) {
        return `cannot delete ${error.sessionId.slice(-12)} — it is open in this or another process`
      }
      return `cannot safely lock sessions for deletion: ${error instanceof Error ? error.message : String(error)}`
    }

    let removed = 0
    let outcome: string | undefined
    for (const node of plan.nodes) {
      const dir = dirs.get(node.id)!
      try {
        // Remove every canonical generation artifact this build knows; other
        // sibling files are never ours to delete. The POSIX session.lock file
        // deliberately remains because unlinking a held flock inode would
        // forfeit the backend's exclusion guarantee.
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isFile() && isSessionArtifactName(entry.name)) {
            await rm(join(dir, entry.name), { force: true })
          }
        }
        await rm(dir, { force: true, recursive: false }).catch(() => {})
        removed += 1
      } catch (error: unknown) {
        outcome = `delete failed for ${node.id.slice(-12)} after ${removed} of ${plan.nodes.length}: ${error instanceof Error ? error.message : String(error)}`
        break
      }
    }
    outcome ??= `deleted ${removed} session${removed === 1 ? '' : 's'}`
    try {
      await releaseSessionDeletionLeases(leases)
    } catch (error: unknown) {
      return `${outcome}; failed to release deletion locks: ${error instanceof Error ? error.message : String(error)}`
    }
    return outcome
  }

  const loadSessionTranscript = async (id: string, signal?: AbortSignal): Promise<string> => {
    if (sessionQuery === undefined) throw new Error('session query is unavailable in this profile')
    const snapshot = await sessionQuery.readSession(id, signal)
    return buildExportMarkdown(createTranscriptStore(snapshot.events).getView(), snapshot.session.id)
  }
  return { loadSessions, deleteSession, loadSessionTranscript }
}
