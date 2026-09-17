import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { setLanguage } from '../src/i18n.ts'
import {
  acquireSessionDeletionLeases,
  collectDeletionSubtree,
  encodeProjectKey,
  encodeSessionSegment,
  formatRelativeTime,
  isSessionArtifactName,
  isSubagentSession,
  jsonlSessionRoot,
  matchSessionId,
  matchSessionRow,
  mergeSessionTitles,
  newestRootForCwd,
  sessionRowMatchesQuery,
  planSessionDeletion,
  projectSessionRows,
  releaseSessionDeletionLeases,
  sessionArtifactDirectory,
  sessionArtifactNames,
  sessionDirectoryFor,
  type SessionDeletionPersistence,
  type SessionRecord,
} from '../src/session-directory.ts'

function record(id: string, createdAt: number, extra: Partial<SessionHeader> = {}): SessionRecord {
  return { header: { version: 0, id, createdAt, ...extra } as SessionHeader, live: false, persisted: true }
}

describe('session directory', () => {
  it('defaults to root sessions across workspaces and sorts newest first', () => {
    const rows = projectSessionRows([
      record('old', 1, { cwd: 'C:\\a' }),
      record('child', 3, { cwd: 'C:\\a', parentSession: SessionId('old'), origin: 'subagent' }),
      record('new', 2, { cwd: 'C:\\b', agentPreset: 'code' }),
    ], { sessions: 'roots', cwd: 'all', sort: 'newest', currentCwd: 'C:\\a', query: '' })
    expect(rows.map(row => row.id)).toEqual(['new', 'old'])
    expect(rows[0]?.preset).toBe('code')
  })

  it('shows children read-only in all-conversations mode and filters by cwd/search', () => {
    const rows = projectSessionRows([
      record('root', 1, { cwd: 'C:\\repo' }),
      record('child-match', 2, { cwd: 'C:\\repo', parentSession: SessionId('root'), origin: 'subagent' }),
      record('elsewhere', 3, { cwd: 'C:\\other' }),
    ], { sessions: 'all', cwd: 'current', sort: 'oldest', currentCwd: 'C:\\repo', query: 'child' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'child-match', subagent: true, resumable: false })
  })

  it('merges only successful non-empty page titles', () => {
    const rows = projectSessionRows([record('a', 1), record('b', 2)], {
      sessions: 'roots', cwd: 'all', sort: 'oldest', currentCwd: '', query: '',
    })
    expect(mergeSessionTitles(rows, [
      { sessionId: 'a', status: 'fulfilled', value: { title: { title: 'Alpha' } } },
      { sessionId: 'b', status: 'rejected' },
    ])).toMatchObject([{ title: 'Alpha' }, { id: 'b' }])
  })

  it('matches the displayed title as well as id and path', () => {
    const rows = projectSessionRows([record('session-abc', 1, { cwd: 'C:\\repo' })], {
      sessions: 'roots', cwd: 'all', sort: 'newest', currentCwd: '', query: '',
    })
    const titled = mergeSessionTitles(rows, [
      { sessionId: 'session-abc', status: 'fulfilled', value: { title: { title: 'fix the login bug' } } },
    ])
    const row = titled[0]
    if (row === undefined) throw new Error('expected a titled session row')
    expect(sessionRowMatchesQuery(row, 'login')).toBe(true)
    expect(sessionRowMatchesQuery(row, 'session-abc')).toBe(true)
    expect(sessionRowMatchesQuery(row, 'nope')).toBe(false)
    expect(titled.filter(candidate => sessionRowMatchesQuery(candidate, 'login'))).toHaveLength(1)
  })
})

describe('session selection policy', () => {
  it('flags subagent conversations by durable lineage', () => {
    expect(isSubagentSession({ id: 'root', createdAt: 1 } as SessionHeader)).toBe(false)
    expect(isSubagentSession({ id: 'child', createdAt: 1, origin: 'subagent' } as SessionHeader)).toBe(true)
    expect(isSubagentSession({ id: 'fork', createdAt: 1, parentSession: 'root' } as SessionHeader)).toBe(false)
  })

  it('matches a session by exact id or unique prefix and rejects ambiguity', () => {
    const headers = [record('abc123', 1).header, record('abc124', 2).header, record('zzz', 3).header]
    expect(matchSessionId(headers, 'abc123').id).toBe('abc123')
    expect(matchSessionId(headers, 'zzz').id).toBe('zzz')
    expect(() => matchSessionId(headers, 'abc')).toThrow(/ambiguous/)
    expect(() => matchSessionId(headers, 'nope')).toThrow(/no persisted session matches/)
  })

  it('matches a picker row by exact id, unique prefix, or unique suffix', () => {
    const rows = projectSessionRows([
      record('session-abcdef12', 1),
      record('session-zzz99999', 2),
    ], { sessions: 'roots', cwd: 'all', sort: 'newest', currentCwd: '', query: '' })
    expect(matchSessionRow(rows, 'session-abcdef12').id).toBe('session-abcdef12')
    expect(matchSessionRow(rows, 'session-abc').id).toBe('session-abcdef12')
    expect(matchSessionRow(rows, 'abcdef12').id).toBe('session-abcdef12')
    expect(() => matchSessionRow(rows, 'session-')).toThrow(/ambiguous/)
    expect(() => matchSessionRow(rows, 'nope')).toThrow(/no persisted session matches/)
  })

  it('picks the newest root session pinned to the cwd, skipping subagents', () => {
    const headers = [
      record('old', 1, { cwd: 'C:\\repo' }).header,
      record('child', 5, { cwd: 'C:\\repo', parentSession: SessionId('old'), origin: 'subagent' }).header,
      record('newer', 3, { cwd: 'C:\\repo' }).header,
      record('other', 9, { cwd: 'C:\\elsewhere' }).header,
    ]
    expect(newestRootForCwd(headers, 'C:\\repo')?.id).toBe('newer')
    expect(newestRootForCwd(headers, 'C:\\absent')).toBeUndefined()
    // A directory whose only sessions are subagents yields nothing.
    expect(newestRootForCwd([record('only-child', 1, { cwd: 'C:\\repo', parentSession: SessionId('x'), origin: 'subagent' }).header], 'C:\\repo')).toBeUndefined()
  })
})

describe('session last-activity ordering', () => {
  it('sorts by the resolved updated map, falling back to createdAt', () => {
    const updated = new Map([['old', 100], ['new', 2]])
    const rows = projectSessionRows([
      record('old', 1, { cwd: 'C:\\a' }),
      record('new', 3, { cwd: 'C:\\a' }),
      record('mid', 2, { cwd: 'C:\\a' }),
    ], { sessions: 'roots', cwd: 'all', sort: 'newest', currentCwd: 'C:\\a', query: '' }, updated)
    // old has the newest activity (100) despite the oldest creation time.
    expect(rows.map(row => row.id)).toEqual(['old', 'new', 'mid'])
    expect(rows[0]?.updatedAt).toBe(100)
    // A bogus (stale) mtime degrades to createdAt inside the projection.
    const stale = new Map([['old', 0]])
    const degraded = projectSessionRows([record('old', 1), record('new', 2)], {
      sessions: 'roots', cwd: 'all', sort: 'newest', currentCwd: '', query: '',
    }, stale)
    expect(degraded[0]?.id).toBe('new')
  })
})

describe('session deletion guards', () => {
  it('encodes session ids into safe path segments like the JSONL backend', () => {
    expect(encodeSessionSegment('session-abc')).toBe('session-abc')
    expect(encodeSessionSegment('../evil')).toBe('..~002Fevil')
    expect(encodeSessionSegment('a~b')).toBe('a~007Eb')
    expect(encodeSessionSegment('.')).toBe('~002E')
    expect(encodeSessionSegment('..')).toBe('~002E~002E')
  })

  it('accepts only directories named by the encoded id under a project grouping', () => {
    // The guard splits through node:path, so the fixtures follow the host
    // separator: windows drives on windows, posix roots elsewhere.
    const sep = process.platform === 'win32' ? '\\' : '/'
    const root = process.platform === 'win32' ? 'C:\\root\\--repo--' : '/root/--repo--'
    const dir = root + sep + 'session-x'
    expect(sessionArtifactDirectory(dir, 'session-x')).toBe(dir)
    expect(sessionArtifactDirectory(root + sep + 'other', 'session-x')).toBeUndefined()
    expect(sessionArtifactDirectory(root + sep + '..~002Fevil', 'session-x')).toBeUndefined()
  })

  it('derives the 0.1.5 multi-generation layout from the backend root', () => {
    // The JSONL backend groups sessions as <root>/<projectKey(cwd)>/
    // <encodeSegment(id)>/ with `_no-cwd` for a missing cwd; generations are
    // `session.jsonl` (v0) and `session.vN.jsonl`, each optionally zstd.
    expect(encodeProjectKey('C:/Users/unlin/repo')).toBe('--C-Users-unlin-repo--')
    expect(encodeProjectKey('C:\\Users\\unlin\\repo')).toBe('--C-Users-unlin-repo--')
    expect(sessionDirectoryFor('C:/root', 'C:/work/app', 'session-x'))
      .toBe(resolve('C:/root', '--C-work-app--', 'session-x'))
    expect(sessionDirectoryFor('C:/root', undefined, 'session-x'))
      .toBe(resolve('C:/root', '_no-cwd', 'session-x'))
    const names = sessionArtifactNames()
    for (const name of ['session.jsonl', 'session.jsonl.zstd', 'session.v1.jsonl', 'session.v1.jsonl.zstd', 'session.v3.jsonl', 'session.v3.jsonl.zstd']) {
      expect(names).toContain(name)
      expect(isSessionArtifactName(name)).toBe(true)
    }
    expect(isSessionArtifactName('notes.txt')).toBe(false)
    expect(isSessionArtifactName('session.v0.jsonl')).toBe(false)
  })

  it('exposes the JSONL root only for backends that carry one', () => {
    expect(jsonlSessionRoot({ config: { root: 'C:/sessions' } })).toBe('C:/sessions')
    expect(jsonlSessionRoot({})).toBeUndefined()
    expect(jsonlSessionRoot(undefined)).toBeUndefined()
    expect(jsonlSessionRoot({ config: { root: '' } })).toBeUndefined()
    expect(jsonlSessionRoot({ config: { root: 42 } })).toBeUndefined()
  })

  it('keeps a fork out of its origin session\'s deletion subtree', () => {
    const records = [
      record('root', 1),
      record('delegate', 2, { parentSession: SessionId('root'), origin: 'subagent' }),
      // A fork carries lineage but is an independent conversation: deleting
      // the session it branched from must not take its log with it.
      record('branch', 3, { parentSession: SessionId('root') }),
      record('branch-child', 4, { parentSession: SessionId('branch'), origin: 'subagent' }),
    ]
    expect(collectDeletionSubtree(records, 'root')).toEqual(expect.arrayContaining(['root', 'delegate']))
    expect(collectDeletionSubtree(records, 'root')).not.toContain('branch')
    expect(collectDeletionSubtree(records, 'root')).not.toContain('branch-child')
    // Deleting the fork itself still takes the subagents it delegated.
    expect(collectDeletionSubtree(records, 'branch')).toEqual(expect.arrayContaining(['branch', 'branch-child']))
  })

  it('collects the deletion subtree across listing order', () => {
    const records = [
      record('root', 1),
      record('child', 2, { parentSession: SessionId('root'), origin: 'subagent' }),
      record('grand', 3, { parentSession: SessionId('child'), origin: 'subagent' }),
      record('sibling', 4, { parentSession: SessionId('root'), origin: 'subagent' }),
      record('unrelated', 5),
    ]
    expect(collectDeletionSubtree(records, 'root')).toEqual(expect.arrayContaining(['root', 'child', 'grand', 'sibling']))
    expect(collectDeletionSubtree(records, 'child')).toEqual(['child', 'grand'])
    expect(collectDeletionSubtree(records, 'unrelated')).toEqual(['unrelated'])
  })
})

describe('session deletion leases', () => {
  it('holds every write lease and releases them in reverse order', async () => {
    const events: string[] = []
    const persistence: SessionDeletionPersistence = {
      open: async (id, access) => {
        events.push(`open:${id}:${access}`)
        return { close: async () => { events.push(`close:${id}`) } }
      },
    }

    const leases = await acquireSessionDeletionLeases(persistence, ['root', 'child'])
    expect(events).toEqual(['open:root:write', 'open:child:write'])
    await releaseSessionDeletionLeases(leases)
    expect(events).toEqual(['open:root:write', 'open:child:write', 'close:child', 'close:root'])
  })

  it('rolls back acquired leases when a later session is already owned', async () => {
    const events: string[] = []
    const persistence: SessionDeletionPersistence = {
      open: async (id) => {
        events.push(`open:${id}`)
        if (id === 'child') throw new Error('already owned')
        return { close: async () => { events.push(`close:${id}`) } }
      },
    }

    await expect(acquireSessionDeletionLeases(persistence, ['root', 'child', 'grand']))
      .rejects.toThrow('already owned')
    expect(events).toEqual(['open:root', 'open:child', 'close:root'])
  })

  it('attempts every release and reports close failures together', async () => {
    const events: string[] = []
    const leases = ['root', 'child'].map(id => ({
      close: async () => {
        events.push(`close:${id}`)
        throw new Error(`close ${id}`)
      },
    }))

    await expect(releaseSessionDeletionLeases(leases)).rejects.toThrow('failed to release session deletion leases')
    expect(events).toEqual(['close:child', 'close:root'])
  })
})

describe('session deletion plan', () => {
  it('refuses an unknown root without producing any nodes', () => {
    const plan = planSessionDeletion([record('a', 1)], 'nope')
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toContain('no persisted session matches')
  })

  it('refuses a live root with the direct message', () => {
    const plan = planSessionDeletion([{ ...record('root', 1), live: true }], 'root')
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toBe('cannot delete a live session — it is open in this or another process')
  })

  it('refuses the whole subtree when any member is live', () => {
    const records = [
      record('root', 1),
      { ...record('child', 2, { parentSession: SessionId('root'), origin: 'subagent' }), live: true },
    ]
    const plan = planSessionDeletion(records, 'root')
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.reason).toContain('child session')
      expect(plan.reason).toContain('live')
    }
  })

  it('orders the plan children-first across the lineage', () => {
    const records = [
      record('root', 1),
      record('child', 2, { parentSession: SessionId('root'), origin: 'subagent' }),
      record('grand', 3, { parentSession: SessionId('child'), origin: 'subagent' }),
      record('sibling', 4, { parentSession: SessionId('root'), origin: 'subagent' }),
      record('unrelated', 5),
    ]
    const plan = planSessionDeletion(records, 'root')
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.nodes.map(node => node.id)).toEqual(['grand', 'child', 'sibling', 'root'])
      expect(plan.nodes.map(node => node.depth)).toEqual([2, 1, 1, 0])
    }
  })
})

describe('relative session time', () => {
  it('formats recent activity compactly and dates older entries', () => {
    const now = 1_700_000_000_000
    setLanguage('en')
    expect(formatRelativeTime(now, now)).toBe('now')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago')
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2d ago')
    expect(formatRelativeTime(now - 30 * 86_400_000, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('uses Chinese relative-time labels when the interface language is Chinese', () => {
    const now = 1_700_000_000_000
    try {
      setLanguage('zh')
      expect(formatRelativeTime(now, now)).toBe('刚刚')
      expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 分钟前')
      expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 小时前')
      expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2 天前')
    } finally {
      setLanguage('en')
    }
  })
})
