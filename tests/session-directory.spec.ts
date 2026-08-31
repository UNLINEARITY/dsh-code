import { describe, expect, it } from 'vitest'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import {
  collectDeletionSubtree,
  encodeSessionSegment,
  formatRelativeTime,
  isSubagentSession,
  matchSessionId,
  mergeSessionTitles,
  newestRootForCwd,
  planSessionDeletion,
  projectSessionRows,
  sessionArtifactDirectory,
  type SessionRecord,
} from '../src/session-directory.ts'

function record(id: string, createdAt: number, extra: Partial<SessionHeader> = {}): SessionRecord {
  return { header: { version: 0, id, createdAt, ...extra } as SessionHeader, live: false, persisted: true }
}

describe('session directory', () => {
  it('defaults to root sessions across workspaces and sorts newest first', () => {
    const rows = projectSessionRows([
      record('old', 1, { cwd: 'C:\\a' }),
      record('child', 3, { cwd: 'C:\\a', parentSession: 'old', origin: 'subagent' }),
      record('new', 2, { cwd: 'C:\\b', agentPreset: 'code' }),
    ], { sessions: 'roots', cwd: 'all', sort: 'newest', currentCwd: 'C:\\a', query: '' })
    expect(rows.map(row => row.id)).toEqual(['new', 'old'])
    expect(rows[0]?.preset).toBe('code')
  })

  it('shows children read-only in all-conversations mode and filters by cwd/search', () => {
    const rows = projectSessionRows([
      record('root', 1, { cwd: 'C:\\repo' }),
      record('child-match', 2, { cwd: 'C:\\repo', parentSession: 'root', origin: 'subagent' }),
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

  it('picks the newest root session pinned to the cwd, skipping subagents', () => {
    const headers = [
      record('old', 1, { cwd: 'C:\\repo' }).header,
      record('child', 5, { cwd: 'C:\\repo', parentSession: 'old', origin: 'subagent' }).header,
      record('newer', 3, { cwd: 'C:\\repo' }).header,
      record('other', 9, { cwd: 'C:\\elsewhere' }).header,
    ]
    expect(newestRootForCwd(headers, 'C:\\repo')?.id).toBe('newer')
    expect(newestRootForCwd(headers, 'C:\\absent')).toBeUndefined()
    // A directory whose only sessions are subagents yields nothing.
    expect(newestRootForCwd([record('only-child', 1, { cwd: 'C:\\repo', parentSession: 'x', origin: 'subagent' }).header], 'C:\\repo')).toBeUndefined()
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

  it('accepts only artifact files inside the id-named directory', () => {
    expect(sessionArtifactDirectory('C:\\root\\--repo--\\session-x\\session.jsonl', 'session-x'))
      .toBe('C:\\root\\--repo--\\session-x')
    expect(sessionArtifactDirectory('C:\\root\\--repo--\\session-x\\session.jsonl.zstd', 'session-x'))
      .toBe('C:\\root\\--repo--\\session-x')
    expect(sessionArtifactDirectory('C:\\root\\--repo--\\session-x\\notes.txt', 'session-x')).toBeUndefined()
    expect(sessionArtifactDirectory('C:\\root\\--repo--\\other\\session.jsonl', 'session-x')).toBeUndefined()
  })

  it('collects the deletion subtree across listing order', () => {
    const records = [
      record('root', 1),
      record('child', 2, { parentSession: 'root' }),
      record('grand', 3, { parentSession: 'child' }),
      record('sibling', 4, { parentSession: 'root' }),
      record('unrelated', 5),
    ]
    expect(collectDeletionSubtree(records, 'root')).toEqual(expect.arrayContaining(['root', 'child', 'grand', 'sibling']))
    expect(collectDeletionSubtree(records, 'child')).toEqual(['child', 'grand'])
    expect(collectDeletionSubtree(records, 'unrelated')).toEqual(['unrelated'])
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
      { ...record('child', 2, { parentSession: 'root' }), live: true },
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
      record('child', 2, { parentSession: 'root' }),
      record('grand', 3, { parentSession: 'child' }),
      record('sibling', 4, { parentSession: 'root' }),
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
    expect(formatRelativeTime(now, now)).toBe('now')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago')
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2d ago')
    expect(formatRelativeTime(now - 30 * 86_400_000, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
