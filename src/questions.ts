/**
 * The terminal ask_user_question provider: registers the single UI provider
 * on `ctx.userQuestions` and drives it with a FIFO queue — one question
 * request on screen at a time, everything else waiting — then resolves the
 * collected answers back into the tool's promise. The community TUI proved
 * this exact pipeline shape; here the dialog is an Ink bar instead of a
 * pi-tui inline modal.
 *
 * Plan reviews (`exit_plan_mode`) arrive through the same service with an
 * `intent: { kind: 'plan-review' }` — the renderer highlights the approve
 * option; the answer encoding is identical either way.
 *
 * @module @deepseek-ai/dsh-code/questions
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'

/** One question request waiting on the human, with its settle channels. */
export interface PendingQuestion {
  /** The request the renderer walks through question by question. */
  request: AskUserQuestionRequest
  /** Resolve the provider promise with the collected answers. */
  resolve(answers: AskUserQuestionAnswer): void
  /** Reject the provider promise as aborted (also used for Esc cancel). */
  reject(error: Error): void
  /** Detach the request's abort listener once the question settles (internal). */
  detachAbort?(): void
}

/** The pending-question snapshot the renderer subscribes to. */
export interface QuestionSnapshot {
  /** The active request, or undefined when nothing is being asked. */
  pending: PendingQuestion | undefined
}

/** Store the pending question lands in; the renderer reads, the provider writes. */
export interface QuestionStore {
  /** Subscribe to pending-state changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Read the current snapshot (identity-stable between changes). */
  getSnapshot(): QuestionSnapshot
  /** Submit the collected answers for the active request and advance the queue. */
  submit(pending: PendingQuestion, answers: AskUserQuestionAnswer): void
  /** Cancel the active request (Esc) — rejects ASK_ABORTED and advances the queue. */
  cancel(pending: PendingQuestion): void
}

const ABORT_ERROR = new UserQuestionError(
  'ask_user_question was interrupted before the user answered',
  'ASK_ABORTED',
)

/**
 * Mount the single `ctx.userQuestions` UI provider over a FIFO queue.
 * @param ctx - context carrying the `userQuestions` service (dsh-base).
 * @returns the store the renderer subscribes to; a context without the
 * service yields a permanently empty store.
 */
export function mountQuestionProvider(ctx: Context): QuestionStore {
  const service = ctx.get('userQuestions')
  let snapshot: QuestionSnapshot = { pending: undefined }
  let active: PendingQuestion | undefined
  const queue: PendingQuestion[] = []
  const listeners = new Set<() => void>()
  const set = (next: QuestionSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  /** Settle the active request and show the next queued one, if any. */
  const advance = (): void => {
    const next = queue.shift()
    active = next
    set({ pending: next })
  }

  if (service !== undefined) {
    service.registerProvider({
      ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
        return new Promise((resolve, reject) => {
          // Abort settles through the same channel as an Esc cancel: the
          // owning tool/step died, so the answer must not linger.
          const onAbort = (): void => {
            if (active === pending) {
              active = undefined
              set({ pending: undefined })
              advance()
            } else {
              const at = queue.indexOf(pending)
              if (at >= 0) queue.splice(at, 1)
            }
            reject(ABORT_ERROR)
          }
          // Detach on every settle so an answered/cancelled question never
          // retains a listener on the owning tool call's signal.
          const detachAbort = (): void => {
            if (request.signal !== undefined) request.signal.removeEventListener('abort', onAbort)
          }
          const pending: PendingQuestion = {
            request,
            resolve,
            reject,
            detachAbort,
          }
          if (request.signal?.aborted === true) {
            reject(ABORT_ERROR)
            return
          }
          request.signal?.addEventListener('abort', onAbort, { once: true })
          if (active === undefined) {
            active = pending
            set({ pending })
          } else {
            queue.push(pending)
          }
        })
      },
    })
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot(): QuestionSnapshot {
      return snapshot
    },
    submit(pending: PendingQuestion, answers: AskUserQuestionAnswer): void {
      if (active !== pending) return
      active = undefined
      set({ pending: undefined })
      pending.detachAbort?.()
      pending.resolve(answers)
      advance()
    },
    cancel(pending: PendingQuestion): void {
      if (active !== pending) return
      active = undefined
      set({ pending: undefined })
      pending.detachAbort?.()
      pending.reject(ABORT_ERROR)
      advance()
    },
  }
}
