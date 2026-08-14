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
})
