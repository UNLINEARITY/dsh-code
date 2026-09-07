/** Global input recall: persistence, dedup, and Codex shell-style navigation. */

import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeFileAtomically } from '../src/settings-file.ts'
import {
  beginRecall,
  historyLine,
  HISTORY_MAX_ENTRIES,
  needsCompaction,
  parseHistoryFile,
  recallEntries,
  recallNewer,
  recallOlder,
  recordLocalEntry,
  serializeHistoryEntry,
  serializeHistoryList,
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

  it('encodes one submission as one physical line, even for multi-line drafts', () => {
    expect(historyLine('hi')).toBe('"hi"\n')
    expect(historyLine('line1\nline2')).toBe('"line1\\nline2"\n')
    // The encoded form contains no physical newline except the trailing one.
    expect(historyLine('line1\nline2').slice(0, -1).includes('\n')).toBe(false)
  })

  it('flags files that drifted from the canonical capped form', () => {
    expect(needsCompaction('"a"\n"b"\n')).toBe(false)
    expect(needsCompaction('"a"\n"a"\n')).toBe(true)
    expect(needsCompaction('"a"\nbogus\n"b"\n')).toBe(true)
    expect(needsCompaction('"1"\n"2"\n"3"\n', 2)).toBe(true)
    expect(needsCompaction('"a"\n"b')).toBe(true)
    expect(needsCompaction('')).toBe(false)
    expect(needsCompaction('"a"\n"b"\n"a"\n')).toBe(false)
  })

  it('tolerates a crash-truncated trailing line', () => {
    expect(parseHistoryFile('"a"\n"b')).toEqual(['a'])
    expect(parseHistoryFile('"a"\n{"partial')).toEqual(['a'])
  })

  it('caps both persistent and local pools at HISTORY_MAX_ENTRIES (100)', () => {
    expect(HISTORY_MAX_ENTRIES).toBe(100)
    const many = Array.from({ length: 120 }, (_, index) => `e${index}`)
    expect(recordLocalEntry(many, 'new')).toHaveLength(100)
    expect(recordLocalEntry(many, 'new')[99]).toBe('new')
    expect(recordLocalEntry(many, 'new')[0]).toBe('e21')
    expect(parseHistoryFile(serializeHistoryList(many))).toHaveLength(100)
  })

  it('serializes a whole snapshot to one JSON line per entry and round-trips', () => {
    const entries = ['a', 'line1\nline2', 'c']
    expect(serializeHistoryList(entries)).toBe('"a"\n"line1\\nline2"\n"c"\n')
    expect(parseHistoryFile(serializeHistoryList(entries))).toEqual(entries)
    expect(serializeHistoryList([])).toBe('')
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

describe('concurrent history writers', () => {
  it('appends from two independent chains lose no entries and keep every line intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-history-'))
    try {
      const path = join(dir, 'history.jsonl')
      // Two terminals: separate write chains, each appending its own
      // entries to the same file without ever rewriting it.
      const chainFor = (own: string[]) => {
        let chain: Promise<void> = Promise.resolve()
        for (const entry of own) {
          chain = chain.then(() => appendFile(path, historyLine(entry), 'utf8'))
        }
        return chain
      }
      const aEntries = Array.from({ length: 20 }, (_, index) => `a${index}`)
      const bEntries = Array.from({ length: 20 }, (_, index) => `b${index}`)
      await Promise.all([chainFor(aEntries), chainFor(bEntries)])
      const parsed = parseHistoryFile(await readFile(path, 'utf8'))
      // Every entry from both writers survived; each writer keeps its own
      // order (each entry is one positioned write at this size).
      for (const entry of [...aEntries, ...bEntries]) {
        expect(parsed).toContain(entry)
      }
      const aOrder = parsed.filter(entry => entry.startsWith('a'))
      expect(aOrder).toEqual(aEntries)
      const bOrder = parsed.filter(entry => entry.startsWith('b'))
      expect(bOrder).toEqual(bEntries)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }, 30_000)

  it('a compaction rewrite keeps the canonical entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-history2-'))
    try {
      const path = join(dir, 'history.jsonl')
      // Adjacent duplicates and garbage accumulate in an append-only file.
      await writeFile(path, '"a"\n"a"\nbogus\n"b"\n"c"\n"c"\n', 'utf8')
      const raw = await readFile(path, 'utf8')
      expect(needsCompaction(raw)).toBe(true)
      // The production compaction writes through the shared atomic helper.
      const canonical = serializeHistoryList(parseHistoryFile(raw))
      await writeFileAtomically(path, canonical)
      expect(await readFile(path, 'utf8')).toBe(canonical)
      expect(parseHistoryFile(await readFile(path, 'utf8'))).toEqual(['a', 'b', 'c'])
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }, 30_000)
})
