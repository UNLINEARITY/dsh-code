/** Submission vocabulary and the startup input gate for the terminal runner.
 *
 * Pure over the handles they are given: the queue mutations and the session
 * guard are decisions the runner applies, and the gate only orders deliveries,
 * so every branch is testable without composing an Agent.
 *
 * @module @deepseek-ai/dsh-code/submissions
 */

import { createUserMessage, MessageId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentStatus, Inbox } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { QueueMutation } from '../ui/ui-contract.ts'

/** One composer submission waiting behind the startup delivery. */
export interface QueuedSubmission {
  readonly text: string
  /** `steer` inserts into the running turn; `followup` waits for the next one. */
  readonly mode: 'followup' | 'steer'
  readonly images: readonly ContentBlock[]
}

/** What one requested queue mutation did; the runner maps it to one notice. */
export type QueueMutationOutcome =
  | 'removed'
  | 'edited'
  | 'steered'
  | 'unavailable'
  | 'empty'
  | 'steerUnavailable'

/**
 * Replace one queued message's text while keeping its attachments. A queue
 * edit rewrites what the user typed, not what they attached: image and file
 * blocks ride through in delivery order (text first, then attachments, the
 * shape {@link deliverLine} submits). Dropping them here would silently strip
 * an attachment the user already confirmed, so this is the edit's single
 * definition and the panel's read-only marker only mirrors it.
 */
export function queueEditContent(content: readonly ContentBlock[], text: string): ContentBlock[] {
  const attachments = content.filter(block => block.type !== 'text')
  return [{ type: 'text', text }, ...attachments]
}

/**
 * Apply one terminal queue mutation to the live inbox. The decision and the
 * inbox change are pure over the supplied handles so every branch is testable
 * without an agent; steering itself is injected because it wakes the driver
 * rather than mutating the inbox. The durable inbox splices remain the UI's
 * single source of truth — this helper never reports a state the inbox did not
 * actually reach.
 * @param inbox - the live agent inbox (pending lists plus its mutators).
 * @param status - the agent's lifecycle status; steering needs `running`.
 * @param messageId - identity of the queued message to mutate.
 * @param action - the requested mutation.
 * @param steer - submits the removed message as next-step steering.
 * @returns the outcome the caller reports.
 */
export function applyQueueMutation(
  inbox: Pick<Inbox, 'nextTurn' | 'append' | 'remove' | 'replace'>,
  status: AgentStatus,
  messageId: string,
  action: QueueMutation,
  steer: (message: UserMessage) => void,
): QueueMutationOutcome {
  const id = MessageId(messageId)
  const message = inbox.nextTurn.find(candidate => candidate.id === id)
  if (message === undefined) return 'unavailable'
  switch (action.kind) {
    case 'remove':
      return inbox.remove(id) ? 'removed' : 'unavailable'
    case 'edit':
      if (action.text.trim() === '') return 'empty'
      inbox.replace(id, createUserMessage({
        content: queueEditContent(message.content, action.text),
        source: message.source,
      }))
      return 'edited'
    case 'steer':
      if (status !== 'running') return 'steerUnavailable'
      // Steer promotes the message out of next-turn, so a failing submit must
      // put it back: the row the user was looking at never just disappears.
      if (!inbox.remove(id)) return 'unavailable'
      try {
        steer(message)
      } catch (error: unknown) {
        inbox.append('next-turn', message)
        throw error
      }
      return 'steered'
  }
}

/**
 * Cancel the active turn while keeping the next-turn queue, then wake the
 * driver again so the preserved messages actually run. `cancel` clears
 * pending work by default and never wakes the driver on its own, so the queue
 * is captured first and re-submitted afterwards: a waking submission latches
 * the wake while the aborted activity converges to idle, which is what turns
 * "preserved" into "sent next" instead of "parked forever". Next-step
 * steering is deliberately dropped — it belonged to the cancelled turn.
 * @param agent - the live agent handle.
 * @returns how many queued messages were preserved across the abort.
 */
export function cancelPreservingQueue(agent: Pick<Agent, 'inbox' | 'cancel' | 'followup'>): number {
  const queued = [...agent.inbox.nextTurn]
  agent.cancel({ kind: 'user' })
  for (const message of queued) agent.followup(message)
  return queued.length
}

/**
 * Whether a tagged submission still belongs to the active session. Attachment
 * prepares resolve on the microtask timeline, while a queued session switch
 * remounts the app asynchronously — the composing instance's unmount cleanup
 * runs too late to abort, so the delivery itself carries the composing
 * session's full id and the runner drops it here when the world moved on.
 * An untagged (synchronous) or pending-session ('') submission always passes.
 */
export function submissionBelongsToSession(origin: string | undefined, activeSessionId: string | undefined): boolean {
  return origin === undefined || origin === '' || origin === activeSessionId
}

/**
 * Order-preserving gate for composer input while the startup prompt/images
 * are still preparing. Anything submitted before the startup delivery settles
 * queues and flushes afterwards in submit order, so the initial request can
 * never be overtaken by typing that raced a slow image preparation. The flush
 * also runs when the startup delivery fails: user input is never stranded.
 */
export class StartupInputGate {
  private readonly queued: QueuedSubmission[] = []
  private pending = false
  constructor(private readonly deliver: (submission: QueuedSubmission) => void) {}

  /** Submit one line: delivered now while idle, queued behind the startup delivery otherwise. */
  submit(submission: QueuedSubmission): void {
    if (this.pending) this.queued.push(submission)
    else this.deliver(submission)
  }

  /**
   * Run the startup delivery — the callback receives the direct-delivery sink
   * for the startup prompt itself — then flush everything that queued behind
   * it, in order, even when the callback rejects.
   */
  async run(startup: (deliver: (submission: QueuedSubmission) => void) => Promise<void>): Promise<void> {
    this.pending = true
    try {
      await startup(submission => this.deliver(submission))
    } finally {
      this.pending = false
      const queued = this.queued.splice(0)
      for (const submission of queued) this.deliver(submission)
    }
  }
}
