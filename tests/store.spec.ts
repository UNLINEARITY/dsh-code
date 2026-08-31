/**
 * Observable transcript store contract: synchronous folding with
 * burst-coalesced notification, view identity stability, subscribe/
 * unsubscribe, reset, and seeded replay. These tests pin the store's
 * documented timing contract so a future notification change must
 * consciously revisit it.
 */

import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createTranscriptStore } from '../src/store.ts'

/** Outwait the frame-throttled notification (immediate or ~16ms-deferred). */
const settle = async (): Promise<void> => {
  await new Promise<void>(resolve => setTimeout(resolve, 25))
}

function userEvent(text: string, seq: number): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 0,
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  } as SessionEvent
}

describe('transcript store', () => {
  it('folds synchronously and notifies at the setImmediate boundary', async () => {
    const store = createTranscriptStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.apply(userEvent('a', 1))
    // The fold is synchronous: getView already reflects the event.
    expect(store.getView().entries).toHaveLength(1)
    expect(listener).not.toHaveBeenCalled()
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('hands out immutable snapshots: later folds never mutate a read view', () => {
    const store = createTranscriptStore()
    store.apply(userEvent('a', 1))
    const first = store.getView()
    store.apply(userEvent('b', 2))
    store.apply(userEvent('c', 3))
    const second = store.getView()
    expect(first.entries).toHaveLength(1)
    expect(second.entries).toHaveLength(3)
    expect(first.entries).not.toBe(second.entries)
  })

  it('keeps view identity and stays silent for ignored events', async () => {
    const store = createTranscriptStore()
    store.apply(userEvent('a', 1))
    const before = store.getView()
    const listener = vi.fn()
    store.subscribe(listener)
    await settle()
    listener.mockClear()
    store.apply({ type: 'unknown/kind', seq: 9, time: 0, data: {} } as unknown as SessionEvent)
    expect(store.getView()).toBe(before)
    await settle()
    expect(listener).not.toHaveBeenCalled()
  })

  it('frame-throttles dense bursts and repaints the whole frame at once', async () => {
    const store = createTranscriptStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.apply(userEvent('a', 1))
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
    // A burst INSIDE the 16ms frame budget must not schedule per-event
    // paints: it defers to the next frame boundary and renders once, with
    // the folded view already carrying every event of the frame.
    store.apply(userEvent('b', 2))
    store.apply(userEvent('c', 3))
    store.apply(userEvent('d', 4))
    await settle()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(store.getView().entries).toHaveLength(4)
  })

  it('coalesces one synchronous burst into a single notification', async () => {
    // The zai/GLM adapter drains token buffers in sub-millisecond bursts;
    // per-event notification cascades into React's nested-passive-update
    // warning, so a burst must render once with the final view.
    const store = createTranscriptStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.apply(userEvent('a', 1))
    store.apply(userEvent('b', 2))
    store.apply(userEvent('c', 3))
    expect(listener).not.toHaveBeenCalled()
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getView().entries).toHaveLength(3)
  })

  it('notifies separately for events split across macrotasks', async () => {
    const store = createTranscriptStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.apply(userEvent('a', 1))
    await settle()
    store.apply(userEvent('b', 2))
    await settle()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('does not notify when an event leaves the view unchanged', async () => {
    const store = createTranscriptStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.apply({ type: 'step/end', seq: 1, time: 0, data: { turn: 1, step: 1 } } as unknown as SessionEvent)
    await settle()
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

  it('unsubscribes cleanly and tolerates double unsubscribe', async () => {
    const store = createTranscriptStore()
    const listener = vi.fn()
    const off = store.subscribe(listener)
    off()
    store.apply(userEvent('a', 1))
    await settle()
    expect(listener).not.toHaveBeenCalled()
    off() // no-op
    expect(store.getView().entries).toEqual([{ kind: 'user', text: 'a', notice: false }])
  })

  it('reset drops the folded view and notifies once', async () => {
    const store = createTranscriptStore()
    store.apply(userEvent('a', 1))
    const listener = vi.fn()
    store.subscribe(listener)
    store.reset()
    expect(store.getView().entries).toEqual([])
    await settle()
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

  it('multiple subscribers each receive every notification', async () => {
    const store = createTranscriptStore()
    const first = vi.fn()
    const second = vi.fn()
    store.subscribe(first)
    store.subscribe(second)
    store.apply(userEvent('a', 1))
    await settle()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })
})
