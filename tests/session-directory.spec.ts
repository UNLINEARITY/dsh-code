import { describe, expect, it } from 'vitest'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import {
  isSubagentSession,
  matchSessionId,
  mergeSessionTitles,
  newestRootForCwd,
  projectSessionRows,
  type SessionRecord,
} from '../src/session-directory.ts'

function record(id: string, createdAt: number, extra: Partial<SessionHeader> = {}): SessionRecord {
  return { header: { version: 0, id, createdAt, ...extra } as SessionHeader, live: false, persisted: true }
}

describe('session directory', () => {
  it('defaults to root sessions across workspaces and sorts newest first', () => {
    const rows = projectSessionRows([
      record('old', 1, { cwd: 'C:\\a' }),
      record('child', 3, { cwd: 'C:\\a', parentSession: 'old' }),
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
    expect(isSubagentSession({ id: 'child', createdAt: 1, parentSession: 'root' } as SessionHeader)).toBe(true)
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
      record('child', 5, { cwd: 'C:\\repo', parentSession: 'old' }).header,
      record('newer', 3, { cwd: 'C:\\repo' }).header,
      record('other', 9, { cwd: 'C:\\elsewhere' }).header,
    ]
    expect(newestRootForCwd(headers, 'C:\\repo')?.id).toBe('newer')
    expect(newestRootForCwd(headers, 'C:\\absent')).toBeUndefined()
    // A directory whose only sessions are subagents yields nothing.
    expect(newestRootForCwd([record('only-child', 1, { cwd: 'C:\\repo', parentSession: 'x' }).header], 'C:\\repo')).toBeUndefined()
  })
})
