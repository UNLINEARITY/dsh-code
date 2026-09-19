/**
 * Session directory IO bound to one runner: picker projection with artifact
 * mtimes and titles, the guarded /delete path, and export rendering.
 *
 * These run against a real temporary JSONL artifact layout, so the deletion
 * path is exercised end to end (plan → layout check → leases → rm) without
 * mounting the Ink tree.
 */
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import {
  sessionDirectoryFor,
  type SessionDeletionLease,
  type SessionLogSnapshot,
  type SessionQueryService,
  type SessionRecord,
} from '../src/session-directory.ts'
import { createSessionIo } from '../src/runner/session-io.ts'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-session-io-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

const CWD = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app'

function header(id: string, createdAt: number, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: 0, id, createdAt, cwd: CWD, ...extra } as SessionHeader
}

function record(id: string, createdAt: number, extra: Partial<SessionHeader> = {}): SessionRecord {
  return { header: header(id, createdAt, extra), live: false, persisted: true }
}

/** Write one real session artifact directory holding `session.jsonl`. */
async function writeArtifact(id: string, cwd = CWD): Promise<string> {
  const dir = sessionDirectoryFor(root, cwd, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.jsonl'), '{}\n', 'utf8')
  return dir
}

/** A persistence double exposing the JSONL root and an injectable lease. */
function persistenceWith(open: (id: string) => Promise<SessionDeletionLease>) {
  return { config: { root }, open: (id: string) => open(id) }
}

function queryWith(overrides: Partial<SessionQueryService> & { records?: SessionRecord[] } = {}): SessionQueryService {
  const { records = [], ...rest } = overrides
  return {
    listSessions: async () => records,
    readTitleSnapshots: async () => [],
    readSession: async (id: string) => {
      throw new Error(`no transcript for ${id}`)
    },
    searchSessions: async () => ({ items: [] }),
    ...rest,
  }
}

const OPEN_OPTIONS = { sessions: 'roots', cwd: 'all', sort: 'newest', currentCwd: CWD, query: '' } as const

describe('createSessionIo loadSessions', () => {
  it('refuses when the profile mounts no session query engine', async () => {
    const io = createSessionIo({ sessionQuery: undefined, persistence: undefined, activeSessionId: () => undefined })
    await expect(io.loadSessions(OPEN_OPTIONS)).rejects.toThrow(/session query is unavailable/u)
  })

  it('sorts by artifact mtime, overriding the createdAt order', async () => {
    // The session with the OLDER createdAt gets the NEWER artifact, so a
    // createdAt sort and an mtime sort must disagree. Explicit mtimes keep
    // the assertion independent of filesystem timestamp resolution.
    const stale = await writeArtifact('created-newer-id')
    const fresh = await writeArtifact('created-older-id')
    const old = new Date('2020-01-01T00:00:00Z')
    const recent = new Date('2024-01-01T00:00:00Z')
    await utimes(join(stale, 'session.jsonl'), old, old)
    await utimes(join(fresh, 'session.jsonl'), recent, recent)
    const records = [record('created-newer-id', 900), record('created-older-id', 100)]
    const io = createSessionIo({
      sessionQuery: queryWith({ records }),
      persistence: persistenceWith(async () => ({ close: async () => {} })),
      activeSessionId: () => undefined,
    })
    const rows = await io.loadSessions(OPEN_OPTIONS)
    expect(rows.map(row => row.id)).toEqual(['created-older-id', 'created-newer-id'])
    expect(rows[0]?.updatedAt).toBe(recent.getTime())
    expect(rows[1]?.updatedAt).toBe(old.getTime())
  })

  it('falls back to createdAt when the artifact is gone', async () => {
    const records = [record('missing-id', 4242)]
    const io = createSessionIo({
      sessionQuery: queryWith({ records }),
      persistence: persistenceWith(async () => ({ close: async () => {} })),
      activeSessionId: () => undefined,
    })
    const rows = await io.loadSessions(OPEN_OPTIONS)
    expect(rows[0]?.updatedAt).toBe(4242)
  })

  it('merges titles and filters by the picker query', async () => {
    const records = [record('alpha-id', 1), record('beta-id', 2)]
    const io = createSessionIo({
      sessionQuery: queryWith({
        records,
        readTitleSnapshots: async ids => ids.map(sessionId => ({
          sessionId,
          status: 'fulfilled' as const,
          value: { title: { title: sessionId === 'alpha-id' ? 'Fix the parser' : 'Ship the release' } },
        })),
      }),
      persistence: persistenceWith(async () => ({ close: async () => {} })),
      activeSessionId: () => undefined,
    })
    const all = await io.loadSessions({ ...OPEN_OPTIONS, query: '' })
    expect(all.map(row => [row.id, row.title])).toEqual([
      ['beta-id', 'Ship the release'],
      ['alpha-id', 'Fix the parser'],
    ])
    const filtered = await io.loadSessions({ ...OPEN_OPTIONS, query: 'parser' })
    expect(filtered.map(row => row.id)).toEqual(['alpha-id'])
  })

  it('skips the title fold entirely for an empty directory', async () => {
    let titleReads = 0
    const io = createSessionIo({
      sessionQuery: queryWith({
        records: [],
        readTitleSnapshots: async () => {
          titleReads += 1
          return []
        },
      }),
      persistence: undefined,
      activeSessionId: () => undefined,
    })
    expect(await io.loadSessions(OPEN_OPTIONS)).toEqual([])
    expect(titleReads).toBe(0)
  })
})

describe('createSessionIo deleteSession', () => {
  it('refuses when the profile mounts no session query engine', async () => {
    const io = createSessionIo({ sessionQuery: undefined, persistence: undefined, activeSessionId: () => undefined })
    expect(await io.deleteSession('anything')).toMatch(/session query is unavailable/u)
  })

  it('refuses to delete the session the terminal is currently using', async () => {
    const io = createSessionIo({
      sessionQuery: queryWith({ records: [record('live-id', 1)] }),
      persistence: persistenceWith(async () => ({ close: async () => {} })),
      activeSessionId: () => 'live-id',
    })
    expect(await io.deleteSession('live-id')).toMatch(/cannot delete the session you are using/u)
  })

  it('refuses the whole deletion when the backend exposes no artifact root', async () => {
    const dir = await writeArtifact('orphan-id')
    const io = createSessionIo({
      sessionQuery: queryWith({ records: [record('orphan-id', 1)] }),
      persistence: { open: async () => ({ close: async () => {} }) },
      activeSessionId: () => undefined,
    })
    expect(await io.deleteSession('orphan-id')).toMatch(/no deletable artifact/u)
    // Nothing was touched, so the artifact still exists.
    expect((await readdir(dir)).length).toBeGreaterThan(0)
  })

  it('removes the subtree children-first and releases every lease', async () => {
    const parentDir = await writeArtifact('11111111-parent')
    const childDir = await writeArtifact('22222222-child')
    const records = [
      record('11111111-parent', 1),
      record('22222222-child', 2, { parentSession: '11111111-parent' as SessionHeader['parentSession'], origin: 'subagent' }),
    ]
    const opened: string[] = []
    const closed: string[] = []
    const io = createSessionIo({
      sessionQuery: queryWith({ records }),
      persistence: persistenceWith(async id => {
        opened.push(id)
        return { close: async () => { closed.push(id) } }
      }),
      activeSessionId: () => undefined,
    })
    expect(await io.deleteSession('11111111-parent')).toBe('deleted 2 sessions')
    // The plan is children-first, so leases and removals both descend.
    expect(opened).toEqual(['22222222-child', '11111111-parent'])
    expect(closed).toEqual(['11111111-parent', '22222222-child'])
    // The artifact files are gone; the session directories are gone with them.
    await expect(stat(join(parentDir, 'session.jsonl'))).rejects.toThrow()
    await expect(stat(join(childDir, 'session.jsonl'))).rejects.toThrow()
  })

  it('reports a foreign-process holder instead of deleting anything', async () => {
    const dir = await writeArtifact('33333333-held')
    const io = createSessionIo({
      sessionQuery: queryWith({ records: [record('33333333-held', 1)] }),
      persistence: persistenceWith(async id => {
        throw new SessionAlreadyOwnedError(id as never)
      }),
      activeSessionId: () => undefined,
    })
    expect(await io.deleteSession('33333333-held')).toMatch(/open in this or another process/u)
    expect((await readdir(dir))).toContain('session.jsonl')
  })

  it('contains an unexpected lease failure and leaves the artifact in place', async () => {
    const dir = await writeArtifact('44444444-broken')
    const io = createSessionIo({
      sessionQuery: queryWith({ records: [record('44444444-broken', 1)] }),
      persistence: persistenceWith(async () => {
        throw new Error('disk on fire')
      }),
      activeSessionId: () => undefined,
    })
    expect(await io.deleteSession('44444444-broken')).toMatch(/cannot safely lock/u)
    expect((await readdir(dir))).toContain('session.jsonl')
  })

  it('reports a failed lease release after a completed deletion', async () => {
    await writeArtifact('55555555-parent')
    const io = createSessionIo({
      sessionQuery: queryWith({ records: [record('55555555-parent', 1)] }),
      persistence: persistenceWith(async () => ({
        close: async () => { throw new Error('unlock refused') },
      })),
      activeSessionId: () => undefined,
    })
    // releaseSessionDeletionLeases aggregates, so the wrapper message wins
    // while the failure still surfaces as a bounded notice line.
    expect(await io.deleteSession('55555555-parent')).toBe(
      'deleted 1 session; failed to release deletion locks: failed to release session deletion leases',
    )
  })
})

describe('createSessionIo loadSessionTranscript', () => {
  it('refuses when the profile mounts no session query engine', async () => {
    const io = createSessionIo({ sessionQuery: undefined, persistence: undefined, activeSessionId: () => undefined })
    await expect(io.loadSessionTranscript('x')).rejects.toThrow(/session query is unavailable/u)
  })

  it('renders the durable log as export Markdown', async () => {
    const snapshot: SessionLogSnapshot = {
      session: header('66666666-export', 1),
      events: [],
    }
    const io = createSessionIo({
      sessionQuery: queryWith({ readSession: async () => snapshot }),
      persistence: undefined,
      activeSessionId: () => undefined,
    })
    const markdown = await io.loadSessionTranscript('66666666-export')
    expect(markdown).toContain('66666666-export')
  })
})
