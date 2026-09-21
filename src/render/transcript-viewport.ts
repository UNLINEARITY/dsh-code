/** Physical-row viewport state for native scrollback plus a bottom-anchored tail. */

export interface TranscriptViewportCursor {
  readonly sessionKey: string
  readonly epoch: number
  readonly flushedRows: number
}

export interface TranscriptViewportInput {
  readonly sessionKey: string
  readonly epoch: number
  /** Physical durable transcript rows in the current rendered-history window. */
  readonly totalRows: number
  /** Maximum durable rows retained outside Static for the live viewport. */
  readonly retainedRows: number
}

export interface TranscriptViewportStep {
  readonly cursor: TranscriptViewportCursor
  /** Durable physical rows emitted through Static. */
  readonly staticRows: number
  /** Durable physical rows still available to the live viewport. */
  readonly liveRows: number
}

/**
 * Advance the monotonic physical-row flush cursor.
 *
 * Ordinary renders never pull a row back out of native scrollback. A source-
 * backed replay (epoch change) flushes the complete durable window exactly
 * once after the caller clears/remounts Static; subsequent durable rows start
 * a fresh retained tail. Session/reset shrink starts from the new source.
 */
export function advanceTranscriptViewport(
  previous: TranscriptViewportCursor,
  input: TranscriptViewportInput,
): TranscriptViewportStep {
  const total = Math.max(0, Math.floor(input.totalRows))
  const retained = Math.max(0, Math.floor(input.retainedRows))
  const desiredStatic = Math.max(0, total - retained)
  const staticRows = previous.sessionKey !== input.sessionKey
    ? desiredStatic
    : previous.epoch !== input.epoch
      ? total
      : total < previous.flushedRows
        ? desiredStatic
        : Math.max(previous.flushedRows, desiredStatic)
  return {
    cursor: { sessionKey: input.sessionKey, epoch: input.epoch, flushedRows: staticRows },
    staticRows,
    liveRows: total - staticRows,
  }
}

/** Real history rows that fit beside the currently painted stream/tool rows. */
export function visibleTranscriptRows(historyRows: number, occupiedRows: number, capacity: number): number {
  const history = Math.max(0, Math.floor(historyRows))
  const occupied = Math.max(0, Math.floor(occupiedRows))
  const available = Math.max(0, Math.floor(capacity) - occupied)
  return Math.min(history, available)
}
