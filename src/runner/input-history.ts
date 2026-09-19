/** Global input recall: the appended prompts and their durable JSONL file.
 *
 * One JSONL file under the DSH home. A missing file means an empty history and
 * unreadable or corrupt content degrades to the valid lines it could parse,
 * silently — recall is a convenience surface, never a gate.
 *
 * @module @deepseek-ai/dsh-code/input-history
 */

import { readFileSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  historyLine,
  HISTORY_MAX_ENTRIES,
  needsCompaction,
  parseHistoryFile,
  serializeHistoryList,
} from '../session/history.ts'
import { writeFileAtomically } from '../settings-file.ts'

/** Live recall state plus its serialized durable writes. */
export interface InputHistoryStore {
  /** The recall list, newest last; read live by the composer. */
  readonly entries: () => readonly string[]
  /** Append one submitted line and persist it; '' is ignored. */
  readonly record: (text: string) => void
  /** Await the pending writes (the quit flush). */
  readonly flush: () => Promise<void>
}

/**
 * Load the recall history and return its live store.
 *
 * Serialized history writes: each submission appends one JSON line at the end
 * of the file, so concurrent terminals add entries after each other instead of
 * overwriting snapshots they read at their own boot. A multi-line draft still
 * occupies one physical line (JSON escapes the newline), and a regular-length
 * line reaches the disk as one positioned write; an oversized paste may
 * interleave mid-line, which the next parse simply drops.
 *
 * @param path - absolute path of the JSONL recall file.
 * @param onFailure - receives the write failure message for a bounded notice.
 */
export function createInputHistory(path: string, onFailure: (message: string) => void): InputHistoryStore {
  let entries: readonly string[] = []
  let chain: Promise<void> = Promise.resolve()
  try {
    const raw = readFileSync(path, 'utf8')
    entries = parseHistoryFile(raw)
    // Stale lines (adjacent duplicates, dropped garbage, an over-cap tail)
    // accumulate in an append-only file; rewrite the canonical form once per
    // boot. The rewrite rides the same chain, so it lands before any
    // submission the user types next. An entry another terminal appends
    // inside the read-to-rename window is dropped — a millisecond-scale gap
    // at boot that recall tolerates by design.
    if (needsCompaction(raw)) {
      chain = chain.then(() => writeFileAtomically(path, serializeHistoryList(entries))).catch(() => {})
    }
  } catch {
    entries = []
  }
  return {
    entries: () => entries,
    record: (text: string): void => {
      if (text === '') return
      entries = [...entries, text].slice(-HISTORY_MAX_ENTRIES)
      chain = chain
        .then(() => mkdir(dirname(path), { recursive: true }))
        .then(() => appendFile(path, historyLine(text), 'utf8'))
        .catch((error: unknown) => {
          onFailure(error instanceof Error ? error.message : String(error))
        })
    },
    flush: () => chain,
  }
}
