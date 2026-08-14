/**
 * Observable transcript store: folds session events into the projection view
 * and notifies subscribers. The renderer subscribes through
 * `useSyncExternalStore`; the runner owns event feeding. The store owns no
 * timing — listeners fire synchronously after each applied event.
 *
 * @module @deepseek-ai/dsh-tui/store
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createTranscriptView, projectEvent, type TranscriptView } from './render/projection.ts'

/** The externally readable, event-fed transcript store for one session. */
export interface TranscriptStore {
  /** The current view; the same object identity until an event changes it. */
  getView(): TranscriptView
  /** Subscribe to view changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Fold one session event; ignored events change nothing and notify nobody. */
  apply(event: SessionEvent): void
}

/**
 * Create one transcript store.
 * @returns the store the runner feeds and the renderer subscribes to.
 */
export function createTranscriptStore(): TranscriptStore {
  let view = createTranscriptView()
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
  }
}
