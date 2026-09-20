/** The ask_user_question answerer: FIFO queue, answer resolution, abort. */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import { mountQuestionProvider } from '../src/questions.ts'

/** Context double capturing the `user-questions/request` waterfall listener. */
function harness(): { ctx: Context; ask: (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer> } {
  let listener:
    | ((request: AskUserQuestionRequest, next: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer>)
    | undefined
  const ctx = {
    on(name: string, handler: unknown): () => void {
      if (name === 'user-questions/request') {
        listener = handler as typeof listener
      }
      return () => {
        listener = undefined
      }
    },
  } as unknown as Context
  return {
    ctx,
    ask: (request: AskUserQuestionRequest) => {
      if (listener === undefined) throw new Error('waterfall listener never mounted')
      return listener(request, () => Promise.reject(new Error('deferred to the next answerer')))
    },
  }
}

function request(questions: AskUserQuestionRequest['questions'], signal?: AbortSignal): AskUserQuestionRequest {
  return { questions, signal }
}

/** Fake AbortSignal that records whether the provider still listens to it (once:true semantics). */
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

const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

describe('mountQuestionProvider', () => {
  it('shows one request at a time and resolves the submitted answers', async () => {
    const { ctx, ask } = harness()
    const store = mountQuestionProvider(ctx, () => true)
    const asked = ask(request([
      { id: 'q1', question: 'which one?', options: [{ label: 'A' }, { label: 'B' }] },
    ]))
    await settle()
    expect(store.getSnapshot().pending?.request.questions[0]?.question).toBe('which one?')

    let settled: AskUserQuestionAnswer | undefined
    void asked.then(answer => { settled = answer })
    store.submit(store.getSnapshot().pending!, { answers: [{ id: 'q1', selected: ['A'] }] })
    await settle()
    expect(settled).toEqual({ answers: [{ id: 'q1', selected: ['A'] }] })
    expect(store.getSnapshot().pending).toBeUndefined()
  })

  it('queues a second request until the first settles', async () => {
    const { ctx, ask } = harness()
    const store = mountQuestionProvider(ctx, () => true)
    const first = ask(request([{ id: 'a', question: 'first', options: [{ label: '1' }] }]))
    const second = ask(request([{ id: 'b', question: 'second', options: [{ label: '2' }] }]))
    const secondFailure = (second).catch((error: unknown) => error)
    await settle()
    const pending = store.getSnapshot().pending!
    expect(pending.request.questions[0]?.question).toBe('first')
    store.submit(pending, { answers: [{ id: 'a', selected: ['1'] }] })
    await settle()
    expect(store.getSnapshot().pending?.request.questions[0]?.question).toBe('second')
    void first
    store.cancel(store.getSnapshot().pending!)
    await settle()
    expect(store.getSnapshot().pending).toBeUndefined()
    expect(await secondFailure).toMatchObject({ code: 'ASK_ABORTED' })
  })

  it('rejects the provider promise with ASK_ABORTED on Esc cancel', async () => {
    const { ctx, ask } = harness()
    const store = mountQuestionProvider(ctx, () => true)
    const asked = ask(request([{ id: 'q', question: 'why', options: [{ label: 'x' }] }]))
    await settle()
    let failure: unknown
    void asked.catch(error => { failure = error })
    store.cancel(store.getSnapshot().pending!)
    await settle()
    expect(failure).toBeInstanceOf(UserQuestionError)
    expect((failure as UserQuestionError).code).toBe('ASK_ABORTED')
  })

  it('settles an already-aborted request without surfacing it', async () => {
    const { ctx, ask } = harness()
    const store = mountQuestionProvider(ctx, () => true)
    const controller = new AbortController()
    controller.abort()
    const asked = ask(request([{ id: 'q', question: 'never', options: [{ label: 'x' }] }], controller.signal))
    const failure = asked.catch((error: unknown) => error)
    await settle()
    expect(store.getSnapshot().pending).toBeUndefined()
    expect(await failure).toMatchObject({ code: 'ASK_ABORTED' })
  })

  it('defers requests for agents this terminal does not own', async () => {
    const { ctx, ask } = harness()
    const store = mountQuestionProvider(ctx, () => false)
    const agent = { id: 'other' } as unknown as Agent
    const asked = ask({ ...request([{ id: 'q', question: 'not mine', options: [{ label: 'x' }] }]), agent })
    await expect(asked).rejects.toThrow('deferred to the next answerer')
    expect(store.getSnapshot().pending).toBeUndefined()
  })

  it('detaches the request abort listener on submit', async () => {
    const { ctx, ask } = harness()
    const store = mountQuestionProvider(ctx, () => true)
    const controller = fakeSignal()
    const asked = ask(request([
      { id: 'q', question: 'q', options: [{ label: 'A' }] },
    ], controller.signal))
    await settle()
    const pending = store.getSnapshot().pending!
    expect(controller.attached()).toBe(true)
    store.submit(pending, { answers: [{ id: 'q', selected: ['A'] }] })
    expect(controller.attached()).toBe(false)
    // A late abort after the answer must not disturb the settled promise.
    controller.fireAbort()
    await expect(asked).resolves.toEqual({ answers: [{ id: 'q', selected: ['A'] }] })
  })

  it('detaches the request abort listener on cancel', async () => {
    const { ctx, ask } = harness()
    const store = mountQuestionProvider(ctx, () => true)
    const controller = fakeSignal()
    const asked = ask(request([
      { id: 'q', question: 'q', options: [{ label: 'A' }] },
    ], controller.signal))
    await settle()
    const pending = store.getSnapshot().pending!
    expect(controller.attached()).toBe(true)
    store.cancel(pending)
    expect(controller.attached()).toBe(false)
    controller.fireAbort()
    await expect(asked).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  })

  it('detaches the request abort listener when the abort fires', async () => {
    const { ctx, ask } = harness()
    const store = mountQuestionProvider(ctx, () => true)
    const controller = fakeSignal()
    const asked = ask(request([
      { id: 'q', question: 'q', options: [{ label: 'A' }] },
    ], controller.signal))
    await settle()
    expect(store.getSnapshot().pending).toBeDefined()
    expect(controller.attached()).toBe(true)
    controller.fireAbort()
    expect(controller.attached()).toBe(false)
    expect(store.getSnapshot().pending).toBeUndefined()
    await expect(asked).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  })
})

describe('question store subscription', () => {
  it('notifies subscribers on pending changes and stops on unsubscribe', async () => {
    const { ctx, ask } = harness()
    const store = mountQuestionProvider(ctx, () => true)
    let notifications = 0
    const unsubscribe = store.subscribe(() => { notifications += 1 })
    expect(store.getSnapshot().pending).toBeUndefined()

    const asked = ask(request([{ id: 'q1', question: 'which?', options: [{ label: 'A' }] }]))
    await settle()
    expect(notifications).toBeGreaterThan(0)
    expect(store.getSnapshot().pending?.request.questions[0]?.question).toBe('which?')

    const beforeClear = notifications
    store.submit(store.getSnapshot().pending!, { answers: [{ id: 'q1', selected: ['A'] }] })
    await settle()
    expect(notifications).toBeGreaterThan(beforeClear)
    expect(store.getSnapshot().pending).toBeUndefined()

    unsubscribe()
    void asked
  })

  it('submit and cancel ignore a stale pending object after the queue advances', async () => {
    const { ctx, ask } = harness()
    const store = mountQuestionProvider(ctx, () => true)
    const first = ask(request([{ id: 'a', question: 'first', options: [{ label: '1' }] }]))
    const second = ask(request([{ id: 'b', question: 'second', options: [{ label: '2' }] }]))
    const secondFailure = second.catch((error: unknown) => error)
    await settle()
    const stale = store.getSnapshot().pending!
    store.submit(stale, { answers: [{ id: 'a', selected: ['1'] }] })
    await settle()
    const active = store.getSnapshot().pending!
    expect(active.request.questions[0]?.id).toBe('b')

    // Neither operation may settle the newer request.
    store.submit(stale, { answers: [{ id: 'a', selected: ['1'] }] })
    store.cancel(stale)
    await settle()
    expect(store.getSnapshot().pending).toBe(active)

    store.cancel(active)
    await expect(first).resolves.toEqual({ answers: [{ id: 'a', selected: ['1'] }] })
    await expect(secondFailure).resolves.toMatchObject({ code: 'ASK_ABORTED' })
  })
})
