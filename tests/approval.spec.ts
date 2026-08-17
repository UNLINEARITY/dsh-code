/** Approval answerer: waterfall claim, y/n resolution, foreign deferral, abort withdrawal. */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { mountApprovalAnswerer } from '../src/approval.ts'

type Listener = (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>

/** Minimal context double capturing the answerer listener registration. */
function fakeContext(): { ctx: Context; listener(): Listener } {
  let registered: Listener | undefined
  const ctx = {
    on(event: string, listener: Listener): () => void {
      if (event === 'approval/request') registered = listener
      return () => {}
    },
  } as unknown as Context
  return {
    ctx,
    listener: (): Listener => {
      if (registered === undefined) throw new Error('approval/request listener was not registered')
      return registered
    },
  }
}

const agent = { id: 'session-owned' } as unknown as Agent
const foreign = { id: 'session-other' } as unknown as Agent

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    agent,
    toolName: 'bash',
    reason: 'escalate sandbox to workspace-write: run the build',
    ...overrides,
  } as ApprovalRequest
}

/** Fake AbortSignal that records whether the answerer still listens to it (once:true semantics). */
function fakeSignal(): { signal: AbortSignal; attached(): boolean; fireAbort(): void } {
  let listener: (() => void) | undefined
  return {
    signal: {
      aborted: false,
      addEventListener: (_type: string, handler: () => void): void => { listener = handler },
      removeEventListener: (): void => { listener = undefined },
    } as unknown as AbortSignal,
    attached: (): boolean => listener !== undefined,
    fireAbort: (): void => {
      const handler = listener
      listener = undefined
      handler?.()
    },
  }
}

describe('approval answerer', () => {
  it('claims its own agent and resolves the answered outcome', async () => {
    const harness = fakeContext()
    const store = mountApprovalAnswerer(harness.ctx, candidate => candidate.id === agent.id, req => `cmd:${req.toolName}`)
    const settled = harness.listener()(request(), () => Promise.resolve<ApprovalOutcome>('unavailable'))

    const snapshot = store.getSnapshot()
    expect(snapshot.pending?.headline).toBe('escalate sandbox to workspace-write: run the build')
    expect(snapshot.pending?.command).toBe('cmd:bash')
    expect(snapshot.pending?.toolName).toBe('bash')
    expect(snapshot.answered).toBe(false)

    store.getSnapshot().pending?.answer('allowed-once')
    await expect(settled).resolves.toBe('allowed-once')
    expect(store.getSnapshot().pending).toBeUndefined()
  })

  it('rejects through the same answer channel', async () => {
    const harness = fakeContext()
    const store = mountApprovalAnswerer(harness.ctx, () => true, () => '')
    const settled = harness.listener()(request(), () => Promise.resolve<ApprovalOutcome>('unavailable'))
    store.getSnapshot().pending?.answer('rejected')
    await expect(settled).resolves.toBe('rejected')
  })

  it('latches: a second answer after submission is inert', async () => {
    const harness = fakeContext()
    const store = mountApprovalAnswerer(harness.ctx, () => true, () => '')
    const settled = harness.listener()(request(), () => Promise.resolve<ApprovalOutcome>('unavailable'))
    const pending = store.getSnapshot().pending
    pending?.answer('allowed-once')
    pending?.answer('rejected')
    await expect(settled).resolves.toBe('allowed-once')
  })

  it('defers foreign agents back into the waterfall', async () => {
    const harness = fakeContext()
    mountApprovalAnswerer(harness.ctx, candidate => candidate.id === agent.id, () => '')
    let nexted = 0
    const deferred = harness.listener()(
      request({ agent: foreign }),
      () => {
        nexted += 1
        return Promise.resolve<ApprovalOutcome>('unavailable')
      },
    )
    await expect(deferred).resolves.toBe('unavailable')
    expect(nexted).toBe(1)
  })

  it('never prompts for an already-aborted ask', async () => {
    const harness = fakeContext()
    const store = mountApprovalAnswerer(harness.ctx, () => true, () => '')
    const controller = new AbortController()
    controller.abort()
    const settled = harness.listener()(
      request({ signal: controller.signal }),
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )
    await expect(settled).resolves.toBe('cancelled')
    expect(store.getSnapshot().pending).toBeUndefined()
  })

  it('withdraws the bar when the ask aborts while pending', async () => {
    const harness = fakeContext()
    const store = mountApprovalAnswerer(harness.ctx, () => true, () => '')
    const controller = new AbortController()
    const settled = harness.listener()(
      request({ signal: controller.signal }),
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )
    expect(store.getSnapshot().pending).toBeDefined()
    controller.abort()
    expect(store.getSnapshot().pending).toBeUndefined()
    // A late answer is discarded by construction; settle through the service race.
    await expect(settled).resolves.toBe('cancelled')
  })

  it('detaches the abort listener when the ask settles normally', async () => {
    const harness = fakeContext()
    const store = mountApprovalAnswerer(harness.ctx, () => true, () => '')
    const controller = fakeSignal()
    const settled = harness.listener()(
      request({ signal: controller.signal }),
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )
    expect(controller.attached()).toBe(true)
    store.getSnapshot().pending?.answer('allowed-once')
    expect(controller.attached()).toBe(false)
    // A late abort after the answer must not disturb anything.
    controller.fireAbort()
    await expect(settled).resolves.toBe('allowed-once')
    expect(store.getSnapshot().pending).toBeUndefined()
  })

  it('detaches the abort listener when the ask is withdrawn', async () => {
    const harness = fakeContext()
    const store = mountApprovalAnswerer(harness.ctx, () => true, () => '')
    const controller = fakeSignal()
    const settled = harness.listener()(
      request({ signal: controller.signal }),
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )
    expect(controller.attached()).toBe(true)
    controller.fireAbort()
    expect(controller.attached()).toBe(false)
    await expect(settled).resolves.toBe('cancelled')
  })

  it('queues concurrent asks FIFO and advances the head on settle', async () => {
    const harness = fakeContext()
    const store = mountApprovalAnswerer(harness.ctx, () => true, req => `cmd:${req.toolName}`)
    const first = harness.listener()(request({ reason: 'first ask' }), () => Promise.resolve<ApprovalOutcome>('unavailable'))
    const second = harness.listener()(request({ reason: 'second ask' }), () => Promise.resolve<ApprovalOutcome>('unavailable'))

    // Only the queue head renders; the count surfaces the wait behind it.
    expect(store.getSnapshot().pending?.headline).toBe('first ask')
    expect(store.getSnapshot().queued).toBe(1)

    store.getSnapshot().pending?.answer('allowed-once')
    await expect(first).resolves.toBe('allowed-once')
    expect(store.getSnapshot().pending?.headline).toBe('second ask')
    expect(store.getSnapshot().queued).toBe(0)

    store.getSnapshot().pending?.answer('rejected')
    await expect(second).resolves.toBe('rejected')
    expect(store.getSnapshot().pending).toBeUndefined()
  })

  it('withdraws a queued (non-head) ask on abort without disturbing the head', async () => {
    const harness = fakeContext()
    const store = mountApprovalAnswerer(harness.ctx, () => true, () => '')
    const controller = new AbortController()
    const first = harness.listener()(request({ reason: 'first ask' }), () => Promise.resolve<ApprovalOutcome>('unavailable'))
    const second = harness.listener()(
      request({ reason: 'second ask', signal: controller.signal }),
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )
    expect(store.getSnapshot().queued).toBe(1)
    controller.abort()
    expect(store.getSnapshot().pending?.headline).toBe('first ask')
    expect(store.getSnapshot().queued).toBe(0)
    await expect(second).resolves.toBe('cancelled')
    store.getSnapshot().pending?.answer('rejected')
    await expect(first).resolves.toBe('rejected')
  })
})
