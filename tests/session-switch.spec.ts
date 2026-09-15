import { describe, expect, it, vi } from 'vitest'
import { SessionSwitchQueue, type IdleActivity } from '../src/session-switch.ts'

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  return { promise: new Promise<void>(done => { resolve = done }), resolve }
}

describe('session switch queue', () => {
  it('waits for idle and executes only the latest queued target', async () => {
    const idle = deferred()
    const activity: IdleActivity = { status: 'running', whenIdle: () => idle.promise }
    const execute = vi.fn(async () => {})
    const queue = new SessionSwitchQueue<string>(execute, () => {})
    expect(queue.request(activity, 'first')).toBe('queued')
    expect(queue.request(activity, 'latest')).toBe('queued')
    idle.resolve()
    await idle.promise
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith('latest')
  })

  it('reports an activation in flight so a submission can be refused, not lost', async () => {
    const activation = deferred()
    const queue = new SessionSwitchQueue<string>(() => activation.promise, () => {})
    expect(queue.activating).toBe(false)
    // Waiting for idle is NOT activation: the old session still runs, so a
    // submission there is still legitimate.
    queue.request({ status: 'idle', whenIdle: async () => {} }, 'target')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(queue.activating).toBe(true)
    activation.resolve()
    await activation.promise
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(queue.activating).toBe(false)
  })

  it('cancels waiting work and reports activation failures', async () => {
    const idle = deferred()
    const failed = vi.fn()
    const queue = new SessionSwitchQueue<string>(async () => { throw new Error('broken') }, failed)
    queue.request({ status: 'running', whenIdle: () => idle.promise }, 'cancelled')
    expect(queue.cancel()).toBe(true)
    idle.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(failed).not.toHaveBeenCalled()

    queue.request({ status: 'idle', whenIdle: async () => {} }, 'broken')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'broken' }))
  })
})
