/**
 * Observable transcript store contract: synchronous per-event notification,
 * view identity stability, subscribe/unsubscribe, reset, and seeded replay.
 * These tests pin the store's documented timing contract so a future
 * notification-coalescing change must consciously revisit it.
 */

import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createTranscriptStore } from '../src/store.ts'

function userEvent(text: string, seq: number): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 0,
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  } as SessionEvent
}

describe('transcript store', () => {
  it('notifies subscribers synchronously per applied event (documented contract)', () => {
    const store = createTranscriptStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.apply(userEvent('a', 1))
    // The listener has already run when `apply` returns: no microtask, no
    // timer — the fold and the notification happen in the same call stack.
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('delivers one notification per event in a synchronous burst (no store-side coalescing)', () => {
    // Burst coalescing is owned by the listener side (React's scheduler
    // reuses an already-scheduled sync callback, so N same-burst applies
    // already render once). The store itself must not drop or merge
    // notifications, or a non-React consumer would miss intermediate states.
    const store = createTranscriptStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.apply(userEvent('a', 1))
    store.apply(userEvent('b', 2))
    store.apply(userEvent('c', 3))
    expect(listener).toHaveBeenCalledTimes(3)
    expect(store.getView().entries).toHaveLength(3)
  })

  it('does not notify when an event leaves the view unchanged', () => {
    const store = createTranscriptStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.apply({ type: 'step/end', seq: 1, time: 0, data: { turn: 1, step: 1 } } as unknown as SessionEvent)
    expect(listener).not.toHaveBeenCalled()
  })

  it('returns the same view object until a changing event lands', () => {
    const store = createTranscriptStore()
    const before = store.getView()
    expect(store.getView()).toBe(before)
    store.apply({ type: 'plan/mode', seq: 1, time: 0, data: { active: true } } as unknown as SessionEvent)
    expect(store.getView()).not.toBe(before)
    const after = store.getView()
    expect(store.getView()).toBe(after)
  })

  it('unsubscribes cleanly and tolerates double unsubscribe', () => {
    const store = createTranscriptStore()
    const listener = vi.fn()
    const off = store.subscribe(listener)
    off()
    store.apply(userEvent('a', 1))
    expect(listener).not.toHaveBeenCalled()
    off() // no-op
    expect(store.getView().entries).toEqual([{ kind: 'user', text: 'a', notice: false }])
  })

  it('reset drops the folded view and notifies once', () => {
    const store = createTranscriptStore()
    store.apply(userEvent('a', 1))
    const listener = vi.fn()
    store.subscribe(listener)
    store.reset()
    expect(store.getView().entries).toEqual([])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('seeds a resumed session by folding the full log before any live event', () => {
    const store = createTranscriptStore([
      userEvent('hi', 1),
      userEvent('again', 2),
    ])
    expect(store.getView().entries).toEqual([
      { kind: 'user', text: 'hi', notice: false },
      { kind: 'user', text: 'again', notice: false },
    ])
    // The constructor seed does not notify: no listener exists yet, and the
    // fold happens before the first render (the app paints the full history).
    const listener = vi.fn()
    store.subscribe(listener)
    expect(listener).not.toHaveBeenCalled()
  })

  it('folds live applies onto the seeded view', () => {
    const store = createTranscriptStore([userEvent('hi', 1)])
    store.apply(userEvent('again', 2))
    expect(store.getView().entries).toEqual([
      { kind: 'user', text: 'hi', notice: false },
      { kind: 'user', text: 'again', notice: false },
    ])
  })

  it('multiple subscribers each receive every notification', () => {
    const store = createTranscriptStore()
    const first = vi.fn()
    const second = vi.fn()
    store.subscribe(first)
    store.subscribe(second)
    store.apply(userEvent('a', 1))
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })
})
