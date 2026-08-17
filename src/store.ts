/**
 * Observable transcript store: folds session events into the projection view
 * and notifies subscribers. The renderer subscribes through
 * `useSyncExternalStore`; the runner owns event feeding.
 *
 * Notification coalescing: the fold stays synchronous — `getView()` always
 * returns the latest state the moment `apply` returns — but listener
 * notification is scheduled on a microtask and deduplicated, so N events
 * delivered inside one synchronous drain (the zai/GLM adapter drains its
 * token buffer in sub-millisecond bursts) produce ONE React re-render.
 * Synchronous per-event notification instead cascades one
 * `useSyncExternalStore` force-update per token inside a single flush; the
 * reconciler counts those as nested passive updates and floods React's
 * "Maximum update depth exceeded" warning past 50 events, besides rendering
 * the whole live tree once per token. A microtask keeps latency within the
 * same macrotask, before Ink's throttled paint.
 *
 * @module @deepseek-ai/dsh-tui/store
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createTranscriptView, projectEvent, projectEvents, type TranscriptView } from './render/projection.ts'

/** The externally readable, event-fed transcript store for one session. */
export interface TranscriptStore {
  /** The current view; the same object identity until an event changes it. */
  getView(): TranscriptView
  /** Subscribe to view changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Fold one session event; ignored events change nothing and notify nobody. */
  apply(event: SessionEvent): void
  /** Drop the folded view entirely (/clear): the next event starts a fresh one. */
  reset(): void
}

/**
 * Create one transcript store, optionally seeded with replayed history. The
 * seed folds synchronously BEFORE the first render, so a resumed session
 * paints its full transcript on mount (no live `session/event` fires for
 * constructor seeds — the store's `session/event` feed only carries new
 * appends).
 * @param replay - persisted events in `seq` order (e.g. a resumed session's
 * constructor seed); folded once and never re-notified.
 * @returns the store the runner feeds and the renderer subscribes to.
 */
export function createTranscriptStore(replay?: readonly SessionEvent[]): TranscriptStore {
  let view = replay === undefined ? createTranscriptView() : projectEvents(replay)
  const listeners = new Set<() => void>()
  let scheduled = false
  const notify = (): void => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      for (const listener of listeners) {
        listener()
      }
    })
  }
  return {
    getView: () => view,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    apply(event: SessionEvent): void {
      const next = projectEvent(view, event)
      if (next === view) return
      view = next
      notify()
    },
    reset(): void {
      view = createTranscriptView()
      notify()
    },
  }
}
