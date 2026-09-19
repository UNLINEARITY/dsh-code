/** Bounded panel surfaces over the shared TTY harness. */

import { describe, expect, it, vi } from 'vitest'
import {
  type TodoItem,
  type SessionEvent,
  type QuestionSnapshot,
  type PendingQuestion,
  appProps,
  createTranscriptStore,
  createTty,
  createUserMessage,
  noop,
  renderApp,
  unsubscribe,
  wait,
} from './helpers/app-mount.ts'

describe('short-terminal surfaces', () => {
  it('keeps the approval ask visible and answerable on an 8-row terminal', async () => {
    const harness = createTty(100, 8)
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
    const instance = renderApp(harness, appProps({
      approval: { subscribe: () => unsubscribe, getSnapshot: () => snapshot },
    }))
    try {
      await wait()
      // The ask never disappears: one line states the absolute decisions.
      expect(harness.output.text).toContain('approval')
      expect(harness.output.text).toContain('y allow')
      harness.stdin.write('y')
      await wait()
      expect(answers).toEqual(['allowed-once'])
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('disables blind question picks when the options cannot render', async () => {
    const harness = createTty(100, 8)
    const submit = vi.fn()
    const cancel = vi.fn()
    const pending = {
      request: { questions: [{ id: 'pick', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] },
      resolve: noop,
      reject: noop,
    } as unknown as PendingQuestion
    const snapshot: QuestionSnapshot = { pending }
    const instance = renderApp(harness, appProps({
      questions: { subscribe: () => unsubscribe, getSnapshot: () => snapshot, submit, cancel },
    }))
    try {
      await wait()
      expect(harness.output.text).toContain('question · esc cancel')
      // Digit picks are disabled: the options are not on screen, so a blind
      // answer must not fire.
      harness.stdin.write('1')
      await wait()
      expect(submit).not.toHaveBeenCalled()
      expect(cancel).not.toHaveBeenCalled()
      harness.stdin.write('')
      await wait()
      expect(cancel).toHaveBeenCalledTimes(1)
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})
describe('mention discovery failures', () => {
  it('shows an explicit unavailable row instead of an empty menu when the search fails', async () => {
    const harness = createTty(100, 24)
    const instance = renderApp(harness, appProps({
      loadMentions: async () => {
        throw new Error('index offline')
      },
    }))
    try {
      await wait()
      harness.stdin.write('@src')
      await wait(200)
      expect(harness.output.text).toContain('workspace search unavailable')
      expect(harness.output.text).toContain('index offline')
      expect(harness.output.text).toContain('keep typing to retry')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})
describe('/agents panel', () => {
  it('opens from the composer and lists live feed rows with transcript entry', async () => {
    const agents = [
      Object.freeze({ id: 'child-session-1', label: 'explorer', state: 'running' as const, activity: 'tool grep', updatedAt: 3 }),
    ]
    const harness = createTty(100, 24)
    const instance = renderApp(harness, appProps({
      subagents: { subscribe: () => unsubscribe, getSnapshot: () => agents, getTotalSeen: () => agents.length },
      loadSubagents: async () => [{
        id: 'child-session-2', createdAt: 2, updatedAt: 2, cwd: 'C:\\repo', workspace: 'repo',
        parent: 'root', subagent: true, resumable: false, live: false, persisted: true, preset: 'standard',
      }],
    }))
    try {
      await wait()
      expect(harness.output.text).toContain('agents 1 live')
      harness.stdin.write('/agents')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('/agents · 1 live · 2 total')
      expect(harness.output.text).toContain('explorer · tool grep · live')
      harness.stdin.write('q')
      await wait()
      expect(harness.output.text.lastIndexOf('type a message')).toBeGreaterThan(harness.output.text.lastIndexOf('/agents ·'))
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})
describe('/usage panel', () => {
  const usage = {
    totals: { uncachedInputTokens: 15_553_400, outputTokens: 1_057_300, cacheReadTokens: 920_064_800, cacheWriteTokens: 0 },
    turns: [{
      turn: 3,
      model: 'deepseek-flash',
      usage: {
        uncachedInputTokens: 12_000,
        outputTokens: 900,
        totalTokens: 12_900,
        reasoningTokens: 120,
        routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }],
      },
    }, {
      turn: 4,
      model: 'glm-5.3',
      usage: {
        uncachedInputTokens: 4_000,
        outputTokens: 300,
        totalTokens: 4_300,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        routes: [{ provider: 'other', model: 'glm-5.3' }],
      },
    }],
  }

  it('shows the session totals, the per-model merge, and the per-turn table', async () => {
    // Tall enough for all three blocks: the panel's body is a bounded
    // viewport (`panelViewport`), so a short terminal shows only the top of it.
    const harness = createTty(100, 60)
    const instance = renderApp(harness, appProps({ loadUsage: async () => usage }))
    try {
      await wait()
      harness.stdin.write('/usage')
      await wait()
      // Measure the panel's own frame only, not the keystroke echo.
      harness.output.text = ''
      harness.stdin.write('\r')
      await wait()
      const opened = harness.output.text
      expect(opened).toContain('/usage — usage of this session')
      // The four buckets are listed apart: the uncached input is not the
      // billed prompt side, so the cached 920M can never hide inside it.
      expect(opened).toContain('15.6M')
      expect(opened).toContain('920M')
      expect(opened).toContain('98.3%')
      // Merged by model, biggest spender first, then the per-turn table.
      expect(opened).toContain('By model · 2')
      expect(opened.indexOf('deepseek-flash')).toBeLessThan(opened.indexOf('glm-5.3'))
      expect(opened).toContain('#3')
      expect(opened).toContain('#4')
      // The shared bounded-panel contract: strictly under the terminal height
      // and never a full-screen clear.
      const terminalRows = (harness.stdout as unknown as { rows?: number }).rows ?? 60
      expect(opened.split('\n').length).toBeLessThan(terminalRows)
      expect(opened).not.toContain('\x1b[2J')

      harness.stdin.write('q')
      await wait()
      expect(harness.output.text.lastIndexOf('type a message')).toBeGreaterThan(
        harness.output.text.lastIndexOf('/usage — usage of this session'),
      )
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('reports a loader failure instead of an empty panel', async () => {
    const harness = createTty(100, 30)
    const instance = renderApp(harness, appProps({
      loadUsage: () => Promise.reject(new Error('projection registry is unavailable')),
    }))
    try {
      await wait()
      harness.stdin.write('/usage')
      await wait()
      harness.output.text = ''
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('projection registry is unavailable')
      harness.stdin.write('\x1b')
      await wait()
      expect(harness.output.text.lastIndexOf('type a message')).toBeGreaterThan(
        harness.output.text.lastIndexOf('projection registry is unavailable'),
      )
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})
describe('/todos subpage', () => {
  it('opens the full todo list in a bounded scrollable panel and closes on q', async () => {
    const todos: TodoItem[] = Array.from({ length: 30 }, (_, index) => ({
      content: `todo-${String(index).padStart(2, '0')}`,
      status: index < 10 ? 'completed' : index < 20 ? 'in_progress' : 'pending',
    }))
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'track work' }], source: { kind: 'user' } }),
      } as SessionEvent,
      { type: 'todo/write', seq: 2, time: 2, data: { todos } } as SessionEvent,
    ])
    const harness = createTty(100, 24)
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      // The live summary line shows the counts and points at the subpage.
      expect(harness.output.text).toContain('todos 10/30')
      expect(harness.output.text).toContain('/todos')

      harness.stdin.write('/todos')
      await wait()
      // Drop the keystroke frames so the newline count measures the panel's
      // own frame only (same discipline as the Ctrl+O bounded-panel test).
      harness.output.text = ''
      harness.stdin.write('\r')
      await wait()
      const opened = harness.output.text
      expect(opened).toContain('todos · 10/30 done · 10 active · 10 pending')
      expect(opened).toContain('todo-00')
      // The panel stays strictly below the terminal height (the shared
      // viewport contract: at equality Ink clears and rewrites every frame),
      // and opening it never clears or replays the screen.
      const terminalRows = (harness.stdout as unknown as { rows?: number }).rows ?? 24
      expect(opened.split('\n').length).toBeLessThan(terminalRows)
      expect(opened).not.toContain('\x1b[2J')

      // G jumps to the tail, g back to the head; both stay inside the panel.
      harness.stdin.write('G')
      await wait()
      expect(harness.output.text).toContain('todo-29')
      harness.stdin.write('g')
      await wait()
      expect(harness.output.text).toContain('todo-00')

      // q closes the panel and the composer regains focus (the closing frame
      // repaints the composer after the panel's last frame).
      harness.stdin.write('q')
      await wait()
      expect(harness.output.text.lastIndexOf('type a message')).toBeGreaterThan(
        harness.output.text.lastIndexOf('todos · 10/30 done · 10 active'),
      )
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})
describe('/delete and /subagent', () => {
  it('opens a dedicated delete picker where enter can only select deletion', async () => {
    const harness = createTty(100, 24)
    const removed: string[] = []
    const switched: string[] = []
    const instance = renderApp(harness, appProps({
      loadSessions: async () => [{
        id: 's-1', createdAt: 1, updatedAt: 1, cwd: 'C:\\repo', workspace: 'repo',
        subagent: false, resumable: true, live: false, persisted: true, preset: 'standard',
      }],
      deleteSession: async (id: string) => {
        removed.push(id)
        return 'deleted 1 session'
      },
      switchSession: row => { switched.push(row.id) },
    }))
    try {
      await wait()
      harness.stdin.write('/delete')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('/delete')
      expect(harness.output.text).toContain('enter delete')
      expect(harness.output.text).not.toContain('enter resume')
      harness.stdin.write('\r')
      await wait()
      expect(switched).toEqual([])
      // The confirm prompt moves into the composer box (warn-styled).
      expect(harness.output.text).toContain('permanently delete')
      expect(harness.output.text).toContain('y delete · any other key cancels')
      harness.stdin.write('y')
      await wait()
      expect(removed).toEqual(['s-1'])
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('keeps deletion unavailable from the resume picker', async () => {
    const harness = createTty(100, 24)
    const removed: string[] = []
    const switched: string[] = []
    const instance = renderApp(harness, appProps({
      loadSessions: async () => [{
        id: 'resume-only', createdAt: 1, updatedAt: 1, cwd: 'C:\\repo', workspace: 'repo',
        subagent: false, resumable: true, live: false, persisted: true, preset: 'standard',
      }],
      deleteSession: async (id: string) => {
        removed.push(id)
        return 'deleted 1 session'
      },
      switchSession: row => { switched.push(row.id) },
    }))
    try {
      await wait()
      harness.stdin.write('/resume')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('enter resume')
      expect(harness.output.text).not.toContain('d delete')
      harness.stdin.write('d')
      await wait()
      expect(removed).toEqual([])
      expect(switched).toEqual([])
      harness.stdin.write('\r')
      await wait()
      expect(switched).toEqual(['resume-only'])
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('arms /delete <suffix> against the matching listing row', async () => {
    const harness = createTty(100, 24)
    const removed: string[] = []
    const instance = renderApp(harness, appProps({
      loadSessions: async () => [{
        id: 'session-abcdef12', createdAt: 1, updatedAt: 1, cwd: '/tmp/other', workspace: 'other',
        subagent: false, resumable: true, live: false, persisted: true, preset: 'standard',
        title: 'old thread',
      }],
      deleteSession: async (id: string) => {
        removed.push(id)
        return 'deleted 1 session'
      },
    }))
    try {
      await wait()
      harness.stdin.write('/delete abcdef12')
      await wait()
      harness.stdin.write('\r')
      await wait(180)
      expect(harness.output.text).toContain('permanently delete')
      expect(harness.output.text).toContain('old thread')
      harness.stdin.write('y')
      await wait()
      expect(removed).toEqual(['session-abcdef12'])
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('opens /subagent with the inherit row and applies a picked override', async () => {
    const harness = createTty(100, 24)
    const applied: string[] = []
    const instance = renderApp(harness, appProps({
      subagentModel: '',
      loadModels: async () => ({
        rows: [{ provider: 'acme', providerName: 'Acme', model: 'plain', modelName: 'Plain' }],
        failures: [],
      }),
      setSubagentModel: (row: { provider: string; model: string }) => {
        applied.push(`${row.provider}/${row.model}`)
        return `${row.provider}/${row.model}`
      },
    }))
    try {
      await wait()
      harness.stdin.write('/subagent')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('/subagent — model for delegated agents')
      expect(harness.output.text).toContain('inherit')
      harness.stdin.write('\x1b[B')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(applied).toEqual(['acme/plain'])
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})
