/** Physical-row transcript viewport and native scrollback split. */

import { describe, expect, it } from 'vitest'
import { advanceTranscriptViewport, visibleTranscriptRows } from '../src/render/transcript-viewport.ts'

describe('advanceTranscriptViewport', () => {
  const initial = { sessionKey: 'session-a', epoch: 0, flushedRows: 0 }

  it('retains one bounded physical-row tail and flushes only overflow', () => {
    const first = advanceTranscriptViewport(initial, {
      sessionKey: 'session-a', epoch: 0, totalRows: 30, retainedRows: 16,
    })
    expect(first).toEqual({
      cursor: { sessionKey: 'session-a', epoch: 0, flushedRows: 14 },
      staticRows: 14,
      liveRows: 16,
    })
    const appended = advanceTranscriptViewport(first.cursor, {
      sessionKey: 'session-a', epoch: 0, totalRows: 35, retainedRows: 16,
    })
    expect(appended.staticRows).toBe(19)
    expect(appended.liveRows).toBe(16)
  })

  it('never pulls flushed rows back for temporary chrome changes', () => {
    const shrunk = advanceTranscriptViewport(
      { sessionKey: 'session-a', epoch: 0, flushedRows: 20 },
      { sessionKey: 'session-a', epoch: 0, totalRows: 30, retainedRows: 4 },
    )
    expect(shrunk.staticRows).toBe(26)
    const expanded = advanceTranscriptViewport(shrunk.cursor, {
      sessionKey: 'session-a', epoch: 0, totalRows: 30, retainedRows: 16,
    })
    expect(expanded.staticRows).toBe(26)
    expect(expanded.liveRows).toBe(4)
  })

  it('fully replays on an epoch change and resets on a new or cleared session', () => {
    const replay = advanceTranscriptViewport(
      { sessionKey: 'session-a', epoch: 0, flushedRows: 14 },
      { sessionKey: 'session-a', epoch: 1, totalRows: 30, retainedRows: 16 },
    )
    expect(replay.staticRows).toBe(30)
    expect(replay.liveRows).toBe(0)
    expect(advanceTranscriptViewport(replay.cursor, {
      sessionKey: 'session-b', epoch: 1, totalRows: 10, retainedRows: 16,
    }).staticRows).toBe(0)
    expect(advanceTranscriptViewport(replay.cursor, {
      sessionKey: 'session-a', epoch: 1, totalRows: 0, retainedRows: 16,
    }).staticRows).toBe(0)
  })
})

describe('visibleTranscriptRows', () => {
  it('fills every row not occupied by stream/tool content with real history', () => {
    expect(visibleTranscriptRows(20, 2, 16)).toBe(14)
    expect(visibleTranscriptRows(20, 16, 16)).toBe(0)
    expect(visibleTranscriptRows(5, 2, 16)).toBe(5)
  })
})
