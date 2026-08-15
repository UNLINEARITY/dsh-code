/**
 * Global input recall: persistent cross-session entries plus this process's
 * submissions, with Codex `ChatComposerHistory` semantics — empty submissions
 * are ignored, adjacent duplicates collapse, the recall space skips
 * persistent entries that duplicate a local one (local wins), and Up/Down
 * navigation is gated so interior cursor movement never hijacks the draft.
 *
 * @module @deepseek-ai/dsh-tui/history
 */

/** Maximum entries retained in the persistent history file. */
export const HISTORY_MAX_ENTRIES = 500

/** Encode one entry for the history file (JSON keeps multi-line drafts intact). */
export function serializeHistoryEntry(text: string): string {
  return JSON.stringify(text)
}

/**
 * Parse a persisted history file (one JSON entry per line): invalid lines
 * drop out, empty entries are ignored, adjacent duplicates collapse, and the
 * result keeps only the newest `max` entries.
 * @param raw - file content, empty for a missing file.
 * @param max - entry cap.
 * @returns persistent entries, oldest first.
 */
export function parseHistoryFile(raw: string, max = HISTORY_MAX_ENTRIES): readonly string[] {
  const kept: string[] = []
  for (const line of raw.split('\n')) {
    if (line === '') continue
    let text: unknown
    try {
      text = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof text !== 'string' || text === '') continue
    if (kept.length > 0 && kept[kept.length - 1] === text) continue
    kept.push(text)
  }
  return kept.slice(-max)
}

/**
 * Append one entry to the persistent file content: JSON line, capped to the
 * newest `max` entries with a trailing newline.
 * @param current - existing file content.
 * @param text - submission to persist.
 * @param max - entry cap.
 * @returns the new file content.
 */
export function appendHistoryContent(current: string, text: string, max = HISTORY_MAX_ENTRIES): string {
  const entries = [...parseHistoryFile(current, max), text].slice(-max)
  return entries.map(serializeHistoryEntry).join('\n') + '\n'
}

/**
 * Record one in-session submission: empty text is ignored and an adjacent
 * duplicate collapses (Codex `record_local_submission` semantics).
 * @param local - current in-session entries, oldest first.
 * @param text - the submitted prompt.
 * @returns the updated local list.
 */
export function recordLocalEntry(local: readonly string[], text: string): readonly string[] {
  if (text === '') return local
  if (local.length > 0 && local[local.length - 1] === text) return local
  return [...local, text]
}

/**
 * Build the recall space, newest first: local entries, then persistent
 * entries whose text is not duplicated locally (the local copy wins and the
 * persistent twin is skipped — Codex's replay-seed dedup, applied to the
 * whole local set).
 * @param persistent - cross-session entries, oldest first.
 * @param local - this process's submissions, oldest first.
 * @returns recall entries, newest first.
 */
export function recallEntries(persistent: readonly string[], local: readonly string[]): readonly string[] {
  const localSet = new Set(local)
  return [...persistent.filter(entry => !localSet.has(entry)), ...local].reverse()
}

/** Shell-style recall navigation over a fixed recall space. */
export interface RecallState {
  /** Recall entries, newest first (frozen at navigation start). */
  entries: readonly string[]
  /** Current recall index; null when not browsing. */
  index: number | null
  /** Draft saved when browsing started; restored on Down past the newest. */
  savedDraft: string
  /** The recalled text currently in the composer (the boundary gate's anchor). */
  lastRecalled: string | null
}

/** Fresh navigation state over one recall space. */
export function beginRecall(entries: readonly string[], draft: string): RecallState {
  return { entries, index: null, savedDraft: draft, lastRecalled: null }
}

/** The outcome of one recall step. */
export interface RecallStep {
  state: RecallState
  /** The text to place in the composer; undefined means "no movement". */
  entry: string | undefined
}

/**
 * Move one entry older (Up, toward index +1 in the newest-first space). The
 * first Up saves the current draft so Down past the newest can restore it
 * (Claude-Code shell recall — the draft is never lost); the oldest entry
 * stays put.
 * @param state - current navigation state.
 * @param draft - the composer text to preserve when browsing starts.
 */
export function recallOlder(state: RecallState, draft: string): RecallStep {
  if (state.index === null) {
    const entry = state.entries[0]
    if (entry === undefined) return { state, entry: undefined }
    return { state: { ...state, index: 0, savedDraft: draft, lastRecalled: entry }, entry }
  }
  if (state.index >= state.entries.length - 1) return { state, entry: undefined }
  const entry = state.entries[state.index + 1]
  return { state: { ...state, index: state.index + 1, lastRecalled: entry }, entry }
}

/** Move one entry newer (Down, toward index 0); past the newest, browsing ends and the saved draft returns. */
export function recallNewer(state: RecallState): RecallStep {
  if (state.index === null) return { state, entry: undefined }
  const next = state.index - 1
  if (next < 0) {
    return { state: { ...state, index: null, lastRecalled: null }, entry: state.savedDraft }
  }
  const entry = state.entries[next]
  return { state: { ...state, index: next, lastRecalled: entry }, entry }
}
