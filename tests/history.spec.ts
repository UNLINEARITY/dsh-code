/** Global input recall: persistence, dedup, and Codex shell-style navigation. */

import { describe, expect, it } from 'vitest'
import {
  appendHistoryContent,
  beginRecall,
  parseHistoryFile,
  recallEntries,
  recallNewer,
  recallOlder,
  recordLocalEntry,
  serializeHistoryEntry,
} from '../src/history.ts'

describe('history persistence', () => {
  it('serializes one entry per JSON line, preserving multi-line drafts', () => {
    expect(serializeHistoryEntry('hello')).toBe('"hello"')
    expect(serializeHistoryEntry('line1\nline2')).toBe('"line1\\nline2"')
    expect(parseHistoryFile('"hello"\n"line1\\nline2"\n')).toEqual(['hello', 'line1\nline2'])
  })

  it('drops invalid and empty lines, collapses adjacent duplicates, caps the newest', () => {
    expect(parseHistoryFile('"a"\nbogus\n"a"\n"b"\n')).toEqual(['a', 'b'])
    expect(parseHistoryFile('"a"\n""\n"b"\n', 1)).toEqual(['b'])
    expect(parseHistoryFile('"1"\n"2"\n"3"\n', 2)).toEqual(['2', '3'])
    expect(parseHistoryFile('')).toEqual([])
    expect(parseHistoryFile('"a"\n"a"\n"a"\n')).toEqual(['a'])
  })

  it('appends one JSON line and caps the file content', () => {
    expect(appendHistoryContent('', 'hi')).toBe('"hi"\n')
    expect(appendHistoryContent('"a"\n', 'b')).toBe('"a"\n"b"\n')
    expect(appendHistoryContent('"1"\n"2"\n', '3', 2)).toBe('"2"\n"3"\n')
  })
})

describe('recall space', () => {
  it('records non-empty submissions and collapses adjacent duplicates', () => {
    expect(recordLocalEntry([], '')).toEqual([])
    expect(recordLocalEntry([], 'a')).toEqual(['a'])
    expect(recordLocalEntry(['a'], 'a')).toEqual(['a'])
    expect(recordLocalEntry(['a'], 'b')).toEqual(['a', 'b'])
  })

  it('builds the newest-first space with local entries winning over persistent twins', () => {
    expect(recallEntries(['old', 'mid'], ['mid', 'new'])).toEqual(['new', 'mid', 'old'])
    expect(recallEntries(['a', 'b'], [])).toEqual(['b', 'a'])
    expect(recallEntries([], [])).toEqual([])
    expect(recallEntries(['x', 'x'], ['x'])).toEqual(['x'])
  })
})

describe('recall navigation', () => {
  const state = beginRecall(['new', 'mid', 'old'], '')

  it('saves the current draft on the first Up and walks older, holding at the oldest', () => {
    const step1 = recallOlder(state, 'my draft')
    expect(step1.entry).toBe('new')
    expect(step1.state.index).toBe(0)
    expect(step1.state.savedDraft).toBe('my draft')
    const step2 = recallOlder(step1.state, 'new')
    expect(step2.entry).toBe('mid')
    const step3 = recallOlder(step2.state, 'mid')
    expect(step3.entry).toBe('old')
    const step4 = recallOlder(step3.state, 'old')
    expect(step4.entry).toBeUndefined()
    expect(step4.state.index).toBe(2)
  })

  it('walks newer back to the newest, then restores the saved draft past it', () => {
    const step1 = recallOlder(state, 'my draft')
    const step2 = recallOlder(step1.state, 'new')
    const step3 = recallOlder(step2.state, 'mid')
    expect(step3.entry).toBe('old')
    const back = recallNewer(step3.state)
    expect(back.entry).toBe('mid')
    const atNewest = recallNewer(back.state)
    expect(atNewest.entry).toBe('new')
    const past = recallNewer(atNewest.state)
    expect(past.entry).toBe('my draft')
    expect(past.state.index).toBeNull()
    expect(past.state.lastRecalled).toBeNull()
  })

  it('does not move on an empty recall space or outside browsing', () => {
    const empty = beginRecall([], '')
    expect(recallOlder(empty, '').entry).toBeUndefined()
    expect(recallNewer(empty).entry).toBeUndefined()
    const fresh = beginRecall(['only'], '')
    expect(recallNewer(fresh).entry).toBeUndefined()
  })
})
