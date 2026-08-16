/**
 * Observable transcript store: folds session events into the projection view
 * and notifies subscribers. The renderer subscribes through
 * `useSyncExternalStore`; the runner owns event feeding.
 *
 * Notifications stay synchronous per applied event on purpose: the view is
 * always current when `apply` returns, and the listener side owns burst
 * coalescing — React 18 (react-reconciler 0.29, used by Ink 5) reuses an
 * already-scheduled sync callback in `ensureRootIsScheduled`, so N `apply`s
 * inside one synchronous burst already render once with the final snapshot,
 * while events delivered across macrotasks (streaming chunks) each render
 * once for live UI. Deferring the notify here would either break the
 * documented synchronous contract or add streaming latency, without fixing
 * anything the scheduler does not already handle.
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
      for (const listener of listeners) {
        listener()
      }
    },
    reset(): void {
      view = createTranscriptView()
      for (const listener of listeners) {
        listener()
      }
    },
  }
}
