/** Structured questions and the approval dialog. */

import { describe, expect, it, vi } from 'vitest'
import {
  type QuestionSnapshot,
  type PendingQuestion,
  App,
  appProps,
  createElement,
  createSplitStdin,
  createTty,
  noop,
  render,
  renderApp,
  unsubscribe,
  wait,
} from './helpers/app-mount.ts'

describe('structured question custom answers', () => {
  it('accepts pasted multiline text without adding a newline shortcut', async () => {
    const harness = createTty(100, 24)
    const submit = vi.fn()
    const pending = {
      request: { questions: [{ id: 'details', question: 'Provide details' }] },
      resolve: noop,
      reject: noop,
    } as unknown as PendingQuestion
    const snapshot: QuestionSnapshot = { pending }
    const instance = renderApp(harness, appProps({
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => snapshot,
        submit,
        cancel: noop,
      },
    }))
    try {
      await wait()
      harness.stdin.write('\x1b[200~first line\nsecond line\x1b[201~')
      await wait(180)
      harness.stdin.write('\r')
      await wait()
      expect(submit).toHaveBeenCalledWith(pending, {
        answers: [{ id: 'details', selected: [], custom: 'first line\nsecond line' }],
      })
    } finally {
      instance.unmount()
    }
  })
})
describe('structured question multi-select', () => {
  it('toggles options with space and submits the full selection', async () => {
    const harness = createTty(100, 24)
    const submit = vi.fn()
    const pending = {
      request: {
        questions: [{
          id: 'pick',
          question: 'Which ones?',
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
          multiSelect: true,
        }],
      },
      resolve: noop,
      reject: noop,
    } as unknown as PendingQuestion
    const snapshot: QuestionSnapshot = { pending }
    const instance = renderApp(harness, appProps({
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => snapshot,
        submit,
        cancel: noop,
      },
    }))
    try {
      await wait()
      harness.stdin.write(' ')
      await wait()
      expect(harness.output.text).toContain('◉')
      harness.stdin.write('\x1b[B')
      await wait()
      harness.stdin.write(' ')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(submit).toHaveBeenCalledWith(pending, {
        answers: [{ id: 'pick', selected: ['A', 'B'] }],
      })
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('toggles options by their number keys and submits the set', async () => {
    const harness = createTty(100, 24)
    const submit = vi.fn()
    const pending = {
      request: {
        questions: [{
          id: 'pick',
          question: 'Which ones?',
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
          multiSelect: true,
        }],
      },
      resolve: noop,
      reject: noop,
    } as unknown as PendingQuestion
    const snapshot: QuestionSnapshot = { pending }
    const instance = renderApp(harness, appProps({
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => snapshot,
        submit,
        cancel: noop,
      },
    }))
    try {
      await wait()
      harness.stdin.write('1')
      await wait()
      harness.stdin.write('3')
      await wait()
      expect(harness.output.text).toContain('◉ 1. A')
      expect(harness.output.text).toContain('◉ 3. C')
      harness.stdin.write('\r')
      await wait()
      expect(submit).toHaveBeenCalledWith(pending, {
        answers: [{ id: 'pick', selected: ['A', 'C'] }],
      })
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('picks a single-select option immediately by its number key', async () => {
    const harness = createTty(100, 24)
    const submit = vi.fn()
    const pending = {
      request: {
        questions: [{
          id: 'pick',
          question: 'Which one?',
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
        }],
      },
      resolve: noop,
      reject: noop,
    } as unknown as PendingQuestion
    const snapshot: QuestionSnapshot = { pending }
    const instance = renderApp(harness, appProps({
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => snapshot,
        submit,
        cancel: noop,
      },
    }))
    try {
      await wait()
      harness.stdin.write('2')
      await wait()
      expect(submit).toHaveBeenCalledTimes(1)
      expect(submit).toHaveBeenCalledWith(pending, {
        answers: [{ id: 'pick', selected: ['B'] }],
      })
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('answers a coalesced space-then-enter chunk as toggle plus submit', async () => {
    const harness = createTty(100, 24)
    const submit = vi.fn()
    const pending = {
      request: {
        questions: [{
          id: 'pick',
          question: 'Which ones?',
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
          multiSelect: true,
        }],
      },
      resolve: noop,
      reject: noop,
    } as unknown as PendingQuestion
    const snapshot: QuestionSnapshot = { pending }
    const stdinProxy = createSplitStdin(harness.stdin)
    const instance = render(createElement(App, appProps({
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => snapshot,
        submit,
        cancel: noop,
      },
    })), {
      // Ink types the stdin slot as the full NodeJS.ReadStream; the split proxy is
      // a deliberately partial PassThrough double that carries only what Ink touches.
      stdin: stdinProxy.stdin as unknown as NodeJS.ReadStream,
      stdout: harness.stdout,
      stderr: harness.stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      await wait()
      // One write, two keypresses: the exact shape that lost both keys.
      harness.stdin.write(' \r')
      await wait()
      expect(submit).toHaveBeenCalledWith(pending, {
        answers: [{ id: 'pick', selected: ['A'] }],
      })
    } finally {
      stdinProxy.dispose()
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('handles printable CSI-u space and number keys through the production stdin proxy', async () => {
    const harness = createTty(100, 24)
    const submit = vi.fn()
    const pending = {
      request: {
        questions: [{
          id: 'pick',
          question: 'Which ones?',
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
          multiSelect: true,
        }],
      },
      resolve: noop,
      reject: noop,
    } as unknown as PendingQuestion
    const snapshot: QuestionSnapshot = { pending }
    const stdinProxy = createSplitStdin(harness.stdin)
    const instance = render(createElement(App, appProps({
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => snapshot,
        submit,
        cancel: noop,
      },
    })), {
      // Ink types the stdin slot as the full NodeJS.ReadStream; the split proxy is
      // a deliberately partial PassThrough double that carries only what Ink touches.
      stdin: stdinProxy.stdin as unknown as NodeJS.ReadStream,
      stdout: harness.stdout,
      stderr: harness.stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      await wait()
      harness.stdin.write('\x1b[32u')
      await wait()
      harness.stdin.write('\x1b[50u')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(submit).toHaveBeenCalledWith(pending, {
        answers: [{ id: 'pick', selected: ['A', 'B'] }],
      })
    } finally {
      stdinProxy.dispose()
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('cancels the question panel on Ctrl+C instead of handing the key to the composer', async () => {
    const harness = createTty(100, 24)
    const cancel = vi.fn()
    const pending = {
      request: {
        questions: [{
          id: 'pick',
          question: 'Which one?',
          options: [{ label: 'A' }, { label: 'B' }],
        }],
      },
      resolve: noop,
      reject: noop,
    } as unknown as PendingQuestion
    const snapshot: QuestionSnapshot = { pending }
    const instance = renderApp(harness, appProps({
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => snapshot,
        submit: noop,
        cancel,
      },
    }))
    try {
      await wait()
      harness.stdin.write('\x03')
      await wait()
      expect(cancel).toHaveBeenCalledWith(pending)
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('switches between multiple questions without losing selections', async () => {
    const harness = createTty(100, 24)
    const submit = vi.fn()
    const pending = {
      request: {
        questions: [
          {
            id: 'first',
            question: 'First?',
            options: [{ label: 'A' }, { label: 'B' }],
            multiSelect: true,
          },
          {
            id: 'second',
            question: 'Second?',
            options: [{ label: 'C' }, { label: 'D' }],
            multiSelect: true,
          },
        ],
      },
      resolve: noop,
      reject: noop,
    } as unknown as PendingQuestion
    const snapshot: QuestionSnapshot = { pending }
    const instance = renderApp(harness, appProps({
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => snapshot,
        submit,
        cancel: noop,
      },
    }))
    try {
      await wait()
      harness.stdin.write('1')
      await wait()
      harness.stdin.write('\x1b[C')
      await wait()
      expect(harness.output.text).toContain('❓ question 2/2')
      harness.stdin.write('2')
      await wait()
      harness.stdin.write('\x1b[D')
      await wait()
      expect(harness.output.text).toContain('❓ question 1/2')
      expect(harness.output.text).toContain('◉ 1. A')
      // The first selection is already part of the per-question draft; only
      // the final question needs Enter to submit the full ordered answer set.
      harness.stdin.write('\x1b[C')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(submit).toHaveBeenCalledWith(pending, {
        answers: [
          { id: 'first', selected: ['A'] },
          { id: 'second', selected: ['D'] },
        ],
      })
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})
describe('approval dialog', () => {
  it('renders the Codex-style option list and answers through quick keys', async () => {
    const answers: string[] = []
    const snapshot = Object.freeze({
      pending: {
        headline: 'run the build?',
        toolName: 'bash',
        command: 'pnpm build',
        answer: (outcome: string): void => {
          answers.push(outcome)
        },
      },
      answered: false,
      queued: 0,
    })
    const harness = createTty(100, 24)
    const instance = renderApp(harness, appProps({
      approval: { subscribe: () => unsubscribe, getSnapshot: () => snapshot },
    }))
    try {
      await wait()
      expect(harness.output.text).toContain('run the build?')
      expect(harness.output.text).toContain('pnpm build')
      expect(harness.output.text).toContain('1. Yes, proceed (y)')
      expect(harness.output.text).toContain('2. No, and tell it what to do differently (n)')
      expect(harness.output.text).toContain('3. No, continue without running it (d)')
      harness.stdin.write('y')
      await wait()
      expect(answers).toEqual(['allowed-once'])
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('confirms the default selection on Enter and rejects on Esc', async () => {
    const answers: string[] = []
    const snapshot = Object.freeze({
      pending: {
        headline: 'run the build?',
        toolName: 'bash',
        command: 'pnpm build',
        answer: (outcome: string): void => {
          answers.push(outcome)
        },
      },
      answered: false,
      queued: 0,
    })
    const harness = createTty(100, 24)
    const instance = renderApp(harness, appProps({
      approval: { subscribe: () => unsubscribe, getSnapshot: () => snapshot },
    }))
    try {
      await wait()
      // Enter confirms the default-selected first option (Yes).
      harness.stdin.write('\r')
      await wait()
      expect(answers).toEqual(['allowed-once'])
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
    const second = createTty(100, 24)
    const answers2: string[] = []
    const snapshot2 = Object.freeze({
      pending: {
        headline: 'run the build?',
        toolName: 'bash',
        command: 'pnpm build',
        answer: (outcome: string): void => {
          answers2.push(outcome)
        },
      },
      answered: false,
      queued: 0,
    })
    const instance2 = renderApp(second, appProps({
      approval: { subscribe: () => unsubscribe, getSnapshot: () => snapshot2 },
    }))
    try {
      await wait()
      // Esc is Codex's cancel: an explicit rejection.
      second.stdin.write('\x1b')
      await wait()
      expect(answers2).toEqual(['rejected'])
    } finally {
      instance2.unmount()
      second.stdin.destroy()
      second.stdout.destroy()
    }
  })
})
