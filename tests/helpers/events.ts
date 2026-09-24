/**
 * v4-shaped durable-event fixtures.
 *
 * Session-log v4 brands envelope sequences (`SessionSeq`) and requires
 * `surfaceOp` on every surface message event; raw object literals in specs
 * read closest to the log shape without those mechanical fields. This
 * wrapper brands the sequence and defaults the append operation for the
 * five surface types (a literal may still pass its own `surfaceOp`).
 */

import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'

/** The surface message events whose envelopes mandatorily carry `surfaceOp`. */
const SURFACE_EVENT_TYPES = new Set([
  'system/message',
  'user/message',
  'developer/message',
  'assistant/message',
  'tool/result',
])

/** One loosely-typed fixture envelope before branding. */
export type FixtureEvent = {
  type: string
  seq: number
  time: number
  data: unknown
  surfaceOp?: unknown
  [key: string]: unknown
}

/** Brand a fixture envelope into a durable `SessionEvent`. */
export function fixtureEvent(event: FixtureEvent): SessionEvent {
  const branded = { ...event, seq: SessionSeq(event.seq) } as { surfaceOp?: unknown }
  if (SURFACE_EVENT_TYPES.has(event.type) && branded.surfaceOp === undefined) {
    branded.surfaceOp = { op: 'append' }
  }
  return branded as SessionEvent
}
