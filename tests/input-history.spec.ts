/**
 * Global input recall store: boot-time load with one canonical rewrite, and
 * serialized appends that survive a failed write.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createInputHistory } from '../src/runner/input-history.ts'
import { HISTORY_MAX_ENTRIES } from '../src/session/history.ts'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-recall-'))
})

afterEach(async () => {
  // A boot compaction rewrite renames a temp file; retry so cleanup never
  // races an in-flight write from a store the test did not flush.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('createInputHistory', () => {
  it('starts empty for a missing file and records the first submission', async () => {
    const path = join(dir, 'nested', 'history.jsonl')
    const history = createInputHistory(path, () => {})
    expect(history.entries()).toEqual([])
    history.record('first prompt')
    await history.flush()
    expect(history.entries()).toEqual(['first prompt'])
    // The parent directory is created on demand, so a fresh DSH home works.
    expect(await readFile(path, 'utf8')).toBe('"first prompt"\n')
  })

  it('ignores an empty submission instead of persisting a blank line', async () => {
    const path = join(dir, 'history.jsonl')
    const history = createInputHistory(path, () => {})
    history.record('')
    await history.flush()
    expect(history.entries()).toEqual([])
  })

  it('parses an existing file and keeps multi-line drafts on one line', async () => {
    const path = join(dir, 'history.jsonl')
    await writeFile(path, '"a"\n"line1\\nline2"\n', 'utf8')
    const history = createInputHistory(path, () => {})
    expect(history.entries()).toEqual(['a', 'line1\nline2'])
    history.record('c')
    await history.flush()
    expect(await readFile(path, 'utf8')).toBe('"a"\n"line1\\nline2"\n"c"\n')
  })

  it('rewrites the canonical form once at boot and keeps appends after it', async () => {
    const path = join(dir, 'history.jsonl')
    // Adjacent duplicates plus a garbage line: stale on disk, deduped on load.
    await writeFile(path, '"a"\n"a"\nbogus\n"b"\n', 'utf8')
    const history = createInputHistory(path, () => {})
    expect(history.entries()).toEqual(['a', 'b'])
    // The rewrite closure serializes the LIVE pool when it runs, so a
    // submission that arrives before it lands is written by the rewrite AND
    // by its own append. That duplicate is pre-existing and self-healing:
    // the next boot's parse collapses adjacent duplicates.
    history.record('c')
    await history.flush()
    expect(await readFile(path, 'utf8')).toBe('"a"\n"b"\n"c"\n"c"\n')
    // Reloading proves the duplicate heals at the next parse.
    const reloaded = createInputHistory(path, () => {})
    expect(reloaded.entries()).toEqual(['a', 'b', 'c'])
    await reloaded.flush()
  })

  it('drops records that arrive after the boot rewrite when nothing needs compaction', async () => {
    const path = join(dir, 'history.jsonl')
    // Already canonical: no rewrite is chained, so the append is the only write.
    await writeFile(path, '"a"\n', 'utf8')
    const history = createInputHistory(path, () => {})
    history.record('c')
    await history.flush()
    expect(await readFile(path, 'utf8')).toBe('"a"\n"c"\n')
  })

  it('caps the recall pool at the newest entries', async () => {
    const path = join(dir, 'history.jsonl')
    const history = createInputHistory(path, () => {})
    for (let index = 0; index < HISTORY_MAX_ENTRIES + 5; index += 1) history.record(`prompt ${index}`)
    await history.flush()
    const entries = history.entries()
    expect(entries).toHaveLength(HISTORY_MAX_ENTRIES)
    expect(entries.at(-1)).toBe(`prompt ${HISTORY_MAX_ENTRIES + 4}`)
    expect(entries[0]).toBe('prompt 5')
  })

  it('reports a failed append and keeps recording afterwards', async () => {
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'regular file', 'utf8')
    const messages: string[] = []
    const history = createInputHistory(join(blocker, 'history.jsonl'), message => {
      messages.push(message)
    })
    history.record('doomed')
    await history.flush()
    expect(messages).toHaveLength(1)
    // The in-memory pool still reflects what the user typed, so recall works
    // for the session even though the durable write failed.
    expect(history.entries()).toEqual(['doomed'])
  })

  it('degrades a corrupt file to the lines it could parse, silently', async () => {
    const path = join(dir, 'history.jsonl')
    await writeFile(path, '"kept"\nnot json\n', 'utf8')
    const messages: string[] = []
    const history = createInputHistory(path, message => {
      messages.push(message)
    })
    expect(history.entries()).toEqual(['kept'])
    expect(messages).toEqual([])
    await history.flush()
  })
})
