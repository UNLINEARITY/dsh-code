/** Session identity resolution for one terminal runner invocation.
 *
 * Turns parsed startup flags into the session this process will run, and maps
 * a session id onto a filename-safe export default. Resolution reads persisted
 * headers, so it is the runner's only pre-composition persistence IO; the
 * remaining helpers are pure.
 *
 * @module @deepseek-ai/dsh-code/session-target
 */

import { randomUUID } from 'node:crypto'
import type { SessionId, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { isSubagentSession, matchSessionId, newestRootForCwd } from '../session/session-directory.ts'
import type { TuiStartup } from '../startup.ts'

/** The session identity this invocation will run, plus whether it is resumed. */
export interface Target {
  sessionId: string
  resume: boolean
  mode?: string
  cwd?: string
  seed?: readonly SessionEvent[]
  parentSession?: SessionId
  /** Marks the session as a subagent conversation in the durable header. */
  origin?: 'subagent'
  seedLength?: number
}

/**
 * Reduce a session id to a filename-safe /export default-name suffix. Session
 * ids are normally minted `session-<uuid>`, but `--session` accepts arbitrary
 * user text: path separators must never leak into the default export filename
 * (which would escape the session cwd).
 * @param id - the session id.
 * @returns at most the last 8 filename-safe characters.
 */
export function exportSessionIdSuffix(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(-8)
}

/**
 * Resolve the invocation's target session against the persisted headers.
 * @param startup - the parsed startup flags.
 * @param persistence - the persistence service; required for resume/latest.
 * @param cwd - the working directory `--continue` filters by.
 * @returns the target identity.
 * @throws with a user-facing message when the flags name nothing resolvable.
 */
export async function resolveTarget(startup: TuiStartup, persistence: SessionPersistence | undefined, cwd: string): Promise<Target> {
  if (startup.kind === 'fresh') return { sessionId: `session-${randomUUID()}`, resume: false, mode: startup.mode }
  if (startup.kind === 'named') {
    // The id must not exist yet: reject before any Agent composition when the
    // backend can tell us (a live collision is still caught by the session
    // store at create time).
    if (persistence !== undefined) {
      const headers: readonly SessionHeader[] = (await persistence.list()).map(snapshot => snapshot.header)
      if (headers.some(header => header.id === startup.sessionId)) {
        throw new Error(`session "${startup.sessionId}" already exists; use --resume to continue it`)
      }
    }
    return { sessionId: startup.sessionId, resume: false, mode: startup.mode }
  }
  if (persistence === undefined) {
    throw new Error('cannot resolve the requested session: session persistence is not configured')
  }
  const headers: readonly SessionHeader[] = (await persistence.list()).map(snapshot => snapshot.header)
  if (startup.kind === 'resume') {
    const matched = matchSessionId(headers, startup.sessionId)
    // Subagent conversations are read-only everywhere else; the CLI must not
    // be a back door into appending root turns to a child's durable log.
    if (isSubagentSession(matched)) {
      throw new Error('subagent conversations are read-only; resume a root session')
    }
    return { sessionId: matched.id, resume: true }
  }
  // --continue: the newest persisted ROOT session whose header pins this cwd.
  const newest = newestRootForCwd(headers, cwd)
  if (newest === undefined) throw new Error(`no persisted session for this directory (${cwd}); start one without --continue`)
  return { sessionId: newest.id, resume: true }
}
