import { describe, expect, it } from 'vitest'
import { KNOWN_SESSION_EVENT_TYPES, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  IGNORED_SESSION_EVENT_TYPES,
  OTHER_SURFACE_SESSION_EVENT_TYPES,
  TRANSCRIPT_SESSION_EVENT_TYPES,
  sessionEventDisposition,
} from '../src/render/projection-events.ts'
import { createTranscriptStore } from '../src/session/store.ts'

describe('session event projection compatibility policy', () => {
  it('classifies every event known by the pinned Harness line exactly once', () => {
    const classified = [
      ...TRANSCRIPT_SESSION_EVENT_TYPES,
      ...OTHER_SURFACE_SESSION_EVENT_TYPES,
      ...IGNORED_SESSION_EVENT_TYPES,
    ]
    expect(new Set(classified).size).toBe(classified.length)
    expect([...classified].sort()).toEqual([...KNOWN_SESSION_EVENT_TYPES].sort())
  })

  it('distinguishes transcript, other-surface, ignored, and plugin events', () => {
    expect(sessionEventDisposition('assistant/message')).toBe('transcript')
    expect(sessionEventDisposition('model/selection')).toBe('other-surface')
    expect(sessionEventDisposition('hook/result')).toBe('ignored')
    expect(sessionEventDisposition('third-party/example')).toBe('unknown')
  })

  it('keeps non-transcript and unknown events silent in the live store', () => {
    const store = createTranscriptStore()
    const before = store.getView()
    store.apply({ type: 'compaction/start', seq: 1, time: 1, data: { turn: 1 } } as unknown as SessionEvent)
    store.apply({ type: 'model/selection', seq: 2, time: 2, data: { provider: 'p', model: 'm' } } as unknown as SessionEvent)
    store.apply({ type: 'third-party/example', seq: 3, time: 3, data: {} } as unknown as SessionEvent)
    expect(store.getView()).toBe(before)
  })

  it('routes transcript events through the existing reducer', () => {
    const store = createTranscriptStore()
    const before = store.getView()
    store.apply({ type: 'turn/start', seq: 1, time: 10, data: { turn: 1 } } as SessionEvent)
    const after = store.getView()
    expect(after).not.toBe(before)
    expect(after.busy).toBe(true)
    expect(after.stats.turns).toBe(1)
  })
})
