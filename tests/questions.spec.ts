/** The ask_user_question provider: FIFO queue, answer resolution, abort. */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
  type UserQuestionProvider,
} from '@deepseek-ai/dsh-user-questions'
import { mountQuestionProvider } from '../src/questions.ts'

/** Context double whose `userQuestions` service hands out the provider. */
function harness(): { ctx: Context; provider: (() => UserQuestionProvider | undefined) } {
  let registered: UserQuestionProvider | undefined
  const service = {
    registerProvider(provider: UserQuestionProvider): () => void {
      registered = provider
      return () => {
        registered = undefined
      }
    },
  }
  const ctx = { get: (name: string): unknown => (name === 'userQuestions' ? service : undefined) } as unknown as Context
  return {
    ctx,
    provider: () => registered,
  }
}

function request(questions: AskUserQuestionRequest['questions'], signal?: AbortSignal): AskUserQuestionRequest {
  return { questions, signal }
}

const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

describe('mountQuestionProvider', () => {
  it('shows one request at a time and resolves the submitted answers', async () => {
    const { ctx, provider } = harness()
    const store = mountQuestionProvider(ctx)
    const asked = provider()?.ask(request([
      { id: 'q1', question: 'which one?', options: [{ label: 'A' }, { label: 'B' }] },
    ])) as Promise<AskUserQuestionAnswer>
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
    const { ctx, provider } = harness()
    const store = mountQuestionProvider(ctx)
    const first = provider()?.ask(request([{ id: 'a', question: 'first', options: [{ label: '1' }] }]))
    const second = provider()?.ask(request([{ id: 'b', question: 'second', options: [{ label: '2' }] }]))
    const secondFailure = (second as Promise<AskUserQuestionAnswer>).catch((error: unknown) => error)
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
    const { ctx, provider } = harness()
    const store = mountQuestionProvider(ctx)
    const asked = provider()?.ask(request([{ id: 'q', question: 'why', options: [{ label: 'x' }] }])) as Promise<AskUserQuestionAnswer>
    await settle()
    let failure: unknown
    void asked.catch(error => { failure = error })
    store.cancel(store.getSnapshot().pending!)
    await settle()
    expect(failure).toBeInstanceOf(UserQuestionError)
    expect((failure as UserQuestionError).code).toBe('ASK_ABORTED')
  })

  it('settles an already-aborted request without surfacing it', async () => {
    const { ctx, provider } = harness()
    const store = mountQuestionProvider(ctx)
    const controller = new AbortController()
    controller.abort()
    const asked = provider()?.ask(request([{ id: 'q', question: 'never', options: [{ label: 'x' }] }], controller.signal)) as Promise<AskUserQuestionAnswer>
    const failure = asked.catch((error: unknown) => error)
    await settle()
    expect(store.getSnapshot().pending).toBeUndefined()
    expect(await failure).toMatchObject({ code: 'ASK_ABORTED' })
  })

  it('stays permanently empty without a userQuestions service', () => {
    const ctx = { get: (): undefined => undefined } as unknown as Context
    const store = mountQuestionProvider(ctx)
    expect(store.getSnapshot().pending).toBeUndefined()
  })
})
