/**
 * The terminal approval answerer: one `approval/request` waterfall listener
 * that renders the pending question as a y/n bar and resolves the decision
 * back into the waterfall. Mirrors the web host's composer takeover — the
 * service (audit pair, policy gate, fail-closed defaults) all live in
 * dsh-base; this module only answers for agents this TUI owns.
 *
 * Vocabulary note: a client answerer may only ever resolve `'allowed-once'`
 * or `'rejected'`; `'cancelled'` belongs to the request signal and
 * `'unavailable'` to the fail-closed waterfall default.
 *
 * @module @deepseek-ai/dsh-code/approval
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'

/** The answer values a client answerer may resolve with. */
export type ApprovalAnswer = 'allowed-once' | 'rejected'

/** One pending approval question, derived from the request for rendering. */
export interface PendingApproval {
  /** The asker's human-readable explanation, or a generic fallback. */
  headline: string
  /** The tool the question is about. */
  toolName: string
  /** Command-line preview resolved from the paired streaming tool call. */
  command: string
  /** Resolve the ask; calling twice is inert (one-shot latch). */
  answer(outcome: ApprovalAnswer): void
}

/** The pending-question snapshot the renderer subscribes to. */
export interface ApprovalSnapshot {
  /** The pending question, or undefined when none is being asked. */
  pending: PendingApproval | undefined
  /** Presentational: an answer was submitted, the ask has not settled yet. */
  answered: boolean
}

/** Store the pending question lands in; the renderer reads, the answerer writes. */
export interface ApprovalStore {
  /** Subscribe to pending-state changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Read the current snapshot (identity-stable between changes). */
  getSnapshot(): ApprovalSnapshot
}

/**
 * Create the approval store and mount the answerer listener on the context.
 * The listener claims only requests for `owns`-owned agents and defers every
 * other request back into the waterfall (`next()`), so sibling answerers stay
 * usable. An aborted ask never reaches the human. Plugin teardown removes the
 * listener; the service then fails its own question closed.
 * @param ctx - plugin context whose event bus carries `approval/request`.
 * @param owns - agents this terminal answers for.
 * @param preview - resolves a tool-call preview for a pending request (the
 * request contract carries no arguments; the UI self-serves from the
 * transcript projection via `callId`).
 * @returns the store the renderer subscribes to.
 */
export function mountApprovalAnswerer(
  ctx: Context,
  owns: (agent: Agent) => boolean,
  preview: (request: ApprovalRequest) => string,
): ApprovalStore {
  let snapshot: ApprovalSnapshot = { pending: undefined, answered: false }
  const listeners = new Set<() => void>()
  const set = (next: ApprovalSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  ctx.on('approval/request', (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
    if (!owns(request.agent)) return next()
    // An already-aborted ask never reaches the human (mirrors the host bridge).
    if (request.signal?.aborted === true) return Promise.resolve<ApprovalOutcome>('cancelled')

    let resolved = false
    let settle!: (outcome: ApprovalOutcome) => void
    const withdraw = (): void => {
      if (resolved) return
      resolved = true
      set({ pending: undefined, answered: false })
      // The service's signal race would conclude 'cancelled' anyway; settle
      // the same way so this listener never dangles a pending promise.
      settle('cancelled')
    }
    if (request.signal !== undefined) {
      request.signal.addEventListener('abort', withdraw, { once: true })
    }
    const pending: PendingApproval = {
      headline: request.reason ?? `tool ${request.toolName} asks for your approval`,
      toolName: request.toolName,
      command: preview(request),
      answer: (outcome: ApprovalAnswer): void => {
        // One-shot latch: a second keypress after submission is inert.
        if (resolved) return
        resolved = true
        set({ pending, answered: true })
        settle(outcome)
      },
    }
    set({ pending, answered: false })

    return new Promise<ApprovalOutcome>((resolve) => {
      settle = resolve
    }).then((outcome) => {
      if (outcome !== 'cancelled') set({ pending: undefined, answered: false })
      return outcome
    })
  })

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot(): ApprovalSnapshot {
      return snapshot
    },
  }
}
