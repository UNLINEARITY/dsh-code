/**
 * One live attachment to a subagent conversation: a transcript store seeded
 * from the child's durable log and then fed by the process-local event and
 * stream buses in real time. The parent's own store is never touched.
 *
 * @module @deepseek-ai/dsh-code/session/attach
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createTranscriptStore, type TranscriptStore } from './store.ts'

/** The bus surfaces one attachment reads; the runner wires these to ctx. */
export interface SubagentAttachmentServices {
  /** Seed: the child's full durable event log, oldest first. */
  load(id: string, signal?: AbortSignal): Promise<readonly SessionEvent[]>
  /** Durable events for exactly this child session, live. */
  subscribeEvents(id: string, onEvent: (event: SessionEvent) => void): () => void
  /** Token stream frames for exactly this child agent, live. */
  subscribeStream(id: string, onFrame: (frame: Parameters<TranscriptStore['applyStreamFrame']>[0]) => void): () => void
}

/** A live child view handed to the App while attached. */
export interface SubagentAttachment {
  readonly id: string
  readonly label: string
  readonly store: TranscriptStore
  /** Whether the durable seed has landed (frames are held back until then). */
  seeded(): boolean
  /** Drop the bus subscriptions; the store freezes at its last state. */
  dispose(): void
}

/** An inert empty store keeps the App's external-store hook unconditional. */
export const EMPTY_ATTACH_STORE: TranscriptStore = createTranscriptStore()

/**
 * Attach to one subagent conversation.
 *
 * Ordering contract: durable events carry a per-session sequence, so the seed
 * sets a watermark and live events at or below it are dropped as duplicates;
 * stream frames are held until the seed lands so a frame whose settlement
 * already arrived cannot resurrect a stale tail.
 */
export function createSubagentAttachment(services: SubagentAttachmentServices, id: string, label: string): SubagentAttachment {
  const store = createTranscriptStore()
  const controller = new AbortController()
  let watermark = -1
  let seeded = false
  const pending: SessionEvent[] = []
  const applyDurable = (event: SessionEvent): void => {
    const seq = Number(event.seq ?? -1)
    if (seq >= 0 && seq <= watermark) return
    if (seq >= 0) watermark = seq
    store.apply(event)
  }
  const offEvents = services.subscribeEvents(id, event => {
    if (!seeded) pending.push(event)
    else applyDurable(event)
  })
  const offFrames = services.subscribeStream(id, frame => {
    if (seeded) store.applyStreamFrame(frame)
  })
  services.load(id, controller.signal).then(events => {
    if (controller.signal.aborted) return
    for (const event of events) applyDurable(event)
    seeded = true
    for (const event of pending) applyDurable(event)
    pending.length = 0
  }, () => {
    // The live buses still feed the view; a failed seed leaves the watermark
    // unset so nothing durable is skipped, and the store shows what arrives.
    seeded = true
    for (const event of pending) applyDurable(event)
    pending.length = 0
  })
  return {
    id,
    label,
    store,
    seeded: () => seeded,
    dispose: () => {
      controller.abort()
      offEvents()
      offFrames()
    },
  }
}
