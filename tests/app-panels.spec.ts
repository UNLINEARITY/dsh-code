/** Bounded panel surfaces over the shared TTY harness. */

import { describe, expect, it, vi } from 'vitest'
import {
  type TodoItem,
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
import { fixtureEvent } from './helpers/events.ts'
import { setLanguage } from '../src/i18n.ts'

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

  it('keeps the one-line ask when the wrapped approval chrome cannot fit', async () => {
    // A 14-row terminal leaves panelViewport maxHeight 5: border, options,
    // footer, and one content row need 7. Painting the wrapped dialog there
    // exceeded the budget and hid the command entirely, so the ask must stay
    // on its compact line until the chrome fits.
    const harness = createTty(100, 14)
    const snapshot = Object.freeze({
      pending: {
        headline: `escalate sandbox to danger-full-access: ${'长'.repeat(40)}`,
        toolName: 'bash',
        command: JSON.stringify({ command: `echo ${'y'.repeat(200)}` }),
        answer: noop,
      },
      answered: false,
      queued: 0,
    })
    const instance = renderApp(harness, appProps({
      approval: { subscribe: () => unsubscribe, getSnapshot: () => snapshot },
    }))
    try {
      await wait()
      expect(harness.output.text).toContain('esc/n reject')
      expect(harness.output.text).not.toContain('Yes, proceed')
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
describe('interface language on live chrome', () => {
  it('translates the agents summary and the help title', async () => {
    setLanguage('zh')
    const agents = [
      Object.freeze({ id: 'child-session-1', label: 'explorer', state: 'running' as const, activity: 'tool grep', updatedAt: 3 }),
    ]
    const harness = createTty(100, 24)
    const instance = renderApp(harness, appProps({
      subagents: { subscribe: () => unsubscribe, getSnapshot: () => agents, getTotalSeen: () => agents.length },
    }))
    try {
      await wait()
      expect(harness.output.text).toContain('子代理 1 个运行中')
      expect(harness.output.text).toContain('共 1 个')
      harness.stdin.write('/help ')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('按键与命令')
      expect(harness.output.text).not.toContain('keys and commands')
    } finally {
      setLanguage('en')
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
      fixtureEvent({
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'track work' }], source: { kind: 'user' } }),
      }),
      fixtureEvent({ type: 'todo/write', seq: 2, time: 2, data: { todos } }),
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

describe('/mcp, /deliverables, and /goal panels', () => {
  it('/mcp lists configured servers and phases', async () => {
    const harness = createTty(100, 24)
    const instance = renderApp(harness, appProps({
      loadMcpServers: () => [
        { entryId: 'github', enabled: true, phase: 'active' },
        { entryId: 'broken', enabled: true, phase: 'failed' },
        { entryId: 'disabled-srv', enabled: false, phase: null },
      ],
    }))
    try {
      await wait()
      harness.stdin.write('/mcp')
      await wait()
      harness.output.text = ''
      harness.stdin.write('\r')
      await wait()
      const opened = harness.output.text
      expect(opened).toContain('/mcp · servers · 3')
      expect(opened).toContain('github · active')
      expect(opened).toContain('broken · failed')
      expect(opened).toContain('disabled-srv · not mounted')
    } finally {
      instance.unmount()
      await wait()
    }
  })

  it('/mcp shows the profile-layer pointer in the empty state', async () => {
    const harness = createTty(100, 24)
    const instance = renderApp(harness, appProps())
    try {
      await wait()
      harness.stdin.write('/mcp')
      await wait()
      harness.output.text = ''
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('no MCP servers configured')
    } finally {
      instance.unmount()
      await wait()
    }
  })

  it('/deliverables accumulates presented groups from the transcript', async () => {
    const harness = createTty(100, 30)
    const store = createTranscriptStore()
    store.apply({ type: 'deliverables/presented', seq: 1, time: 1, data: { turn: 1, callId: 'c1', files: [{ path: 'report.md' }, { path: 'slides.md' }] } } as never)
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      harness.stdin.write('/deliverables')
      await wait()
      harness.output.text = ''
      harness.stdin.write('\r')
      await wait()
      const opened = harness.output.text
      expect(opened).toContain('delivered files · 1')
      expect(opened).toContain('2 files')
      expect(opened).toContain('report.md')
      expect(opened).toContain('slides.md')
    } finally {
      instance.unmount()
      await wait()
    }
  })

  it('/goal shows the folded card and dispatches pause through the registry line', async () => {
    const harness = createTty(100, 30)
    const dispatched: string[] = []
    const store = createTranscriptStore()
    store.apply({ type: 'goal/change', seq: 1, time: 1, data: { operation: 'create', roundsStarted: 2, goal: { objective: 'ship the audit', phase: 'active', maxGoalRounds: 8 } } } as never)
    const instance = renderApp(harness, appProps({ store, dispatch: (line: string) => dispatched.push(line) }))
    try {
      await wait()
      harness.stdin.write('/goal')
      await wait()
      harness.output.text = ''
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('ship the audit')
      expect(harness.output.text).toContain('active · round 2/8')
      harness.stdin.write(' ')
      await wait()
      expect(dispatched).toEqual(['/goal pause'])
    } finally {
      instance.unmount()
      await wait()
    }
  })

  it('/goal offers the composer pointer in the empty state', async () => {
    const harness = createTty(100, 24)
    const instance = renderApp(harness, appProps())
    try {
      await wait()
      harness.stdin.write('/goal')
      await wait()
      harness.output.text = ''
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('no goal set')
    } finally {
      instance.unmount()
      await wait()
    }
  })
})

describe('batch-4 panel operations', () => {
  it('/jobs two-press kill dispatches and echoes the outcome', async () => {
    const harness = createTty(100, 30)
    const kills: string[] = []
    const clock = Date.now()
    const instance = renderApp(harness, appProps({
      loadJobs: () => [
        { id: 'bash-1', kind: 'bash', label: 'npm run watch', status: 'running', startedAt: clock - 5_000 },
        { id: 'bash-2', kind: 'bash', label: 'done job', status: 'completed', startedAt: clock - 60_000, finishedAt: clock - 30_000 },
      ],
      jobKill: async id => { kills.push(id); return `kill requested for ${id}` },
      jobOutput: async () => ['line one', 'line two'],
    }))
    try {
      await wait()
      harness.stdin.write('/jobs')
      await wait()
      harness.output.text = ''
      harness.stdin.write('\r')
      await wait()
      harness.stdin.write('\x7f')
      await wait()
      expect(harness.output.text).toContain('press again')
      expect(kills).toEqual([])
      harness.output.text = ''
      harness.stdin.write('\x7f')
      await wait()
      expect(kills).toEqual(['bash-1'])
      expect(harness.output.text).toContain('kill requested for bash-1')
    } finally {
      instance.unmount()
      await wait()
    }
  })

  it('/jobs o opens the retained output sub-view and esc returns', async () => {
    const harness = createTty(100, 30)
    const reads: string[] = []
    const clock = Date.now()
    const instance = renderApp(harness, appProps({
      loadJobs: () => [{ id: 'bash-7', kind: 'bash', label: 'build', status: 'completed', startedAt: clock - 60_000, finishedAt: clock }],
      jobOutput: async id => { reads.push(id); return ['hello from stdout'] },
    }))
    try {
      await wait()
      harness.stdin.write('/jobs')
      await wait()
      harness.output.text = ''
      harness.stdin.write('\r')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(reads).toEqual(['bash-7'])
      expect(harness.output.text).toContain('hello from stdout')
      harness.output.text = ''
      harness.stdin.write('\x1b')
      await wait()
      expect(harness.output.text).toContain('bash-7 · build')
    } finally {
      instance.unmount()
      await wait()
    }
  })

  it('/permission d persists the cursor row as the new-session default', async () => {
    const harness = createTty(100, 30)
    const saved: string[] = []
    const instance = renderApp(harness, appProps({
      loadPermissions: async () => [
        { id: 'read-only', description: 'read only' },
        { id: 'workspace-write', description: 'write workspace' },
      ],
      permissionDefault: {
        load: async () => 'read-only',
        set: async preset => { saved.push(preset); return `new sessions will start on ${preset}` },
      },
    }))
    try {
      await wait()
      harness.stdin.write('/permission')
      await wait()
      harness.output.text = ''
      harness.stdin.write('\r')
      await wait()
      await wait()
      expect(harness.output.text).toContain('read only ★')
      harness.stdin.write('\x1b[B')
      await wait()
      harness.output.text = ''
      harness.stdin.write(' ')
      await wait()
      await wait()
      expect(saved).toEqual(['workspace-write'])
      expect(harness.output.text).toContain('new sessions will start on workspace-write')
    } finally {
      instance.unmount()
      await wait()
    }
  })
})

describe('/hooks and /lsp wizard panels', () => {
  it('/hooks edits a path inline: enter, type, enter commits the write', async () => {
    const harness = createTty(100, 24)
    const written: { dialect: string; path: string }[] = []
    const instance = renderApp(harness, appProps({
      hooksStatus: () => [
        { dialect: 'claude-code', configPath: written.at(-1)?.path ?? '' },
        { dialect: 'codex', configPath: '' },
      ],
      hooksWrite: (dialect, configPath) => {
        written.push({ dialect, path: configPath })
        return `saved ${dialect}`
      },
    }))
    try {
      await wait()
      harness.stdin.write('/hooks')
      await wait()
      harness.output.text = ''
      harness.stdin.write('\r')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('✎ claude-code')
      harness.output.text = ''
      harness.stdin.write('/tmp/hooks.json')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(written).toEqual([{ dialect: 'claude-code', path: '/tmp/hooks.json' }])
      expect(harness.output.text).toContain('saved claude-code')
    } finally {
      instance.unmount()
      await wait()
    }
  })

  it('/lsp adds a server inline and removes one with a two-press backspace', async () => {
    const harness = createTty(120, 30)
    const servers = [{ extension: '.ts', language: 'typescript', command: 'tsserver' }]
    const writes: { extension: string; language: string; command: string }[] = []
    const removed: string[][] = []
    const instance = renderApp(harness, appProps({
      lspStatus: () => ({
        packages: [
          { pkg: '@deepseek-ai/dsh-lsp', present: true },
          { pkg: '@deepseek-ai/dsh-lsp-stdio', present: true },
          { pkg: '@deepseek-ai/dsh-tool-lsp', present: true },
        ],
        servers,
      }),
      lspWrite: entries => {
        writes.push(...entries)
        for (const entry of entries) {
          const index = servers.findIndex(server => server.extension === entry.extension)
          if (index < 0) servers.push(entry)
          else servers[index] = entry
        }
        return 'saved'
      },
      lspRemove: extensions => {
        removed.push([...extensions])
        for (const extension of extensions) {
          const index = servers.findIndex(server => server.extension === extension)
          if (index >= 0) servers.splice(index, 1)
        }
        return 'removed'
      },
      lspInstallCommand: () => 'dsh plugin --profile cli add …',
    }))
    try {
      await wait()
      harness.stdin.write('/lsp')
      await wait()
      harness.output.text = ''
      harness.stdin.write('\r')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('✎')
      harness.stdin.write('.py:python:pylsp')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(writes).toEqual([{ extension: '.py', language: 'python', command: 'pylsp' }])
    } finally {
      instance.unmount()
      await wait()
    }
  })

  it('/lsp names missing packages with the install command in the footer', async () => {
    const harness = createTty(120, 24)
    const instance = renderApp(harness, appProps({
      lspStatus: () => ({ packages: [{ pkg: '@deepseek-ai/dsh-lsp', present: false }], servers: [] }),
      lspInstallCommand: () => 'dsh plugin --profile cli add @deepseek-ai/dsh-lsp@0.1.7-rc.2',
    }))
    try {
      await wait()
      harness.stdin.write('/lsp')
      await wait()
      harness.output.text = ''
      harness.stdin.write('\r')
      await wait()
      const opened = harness.output.text
      expect(opened).toContain('✗ @deepseek-ai/dsh-lsp')
      expect(opened).toContain('dsh plugin --profile cli add')
    } finally {
      instance.unmount()
      await wait()
    }
  })
})

describe('/lsp panel removal', () => {
  it('backspace twice on a server row removes it', async () => {
    const harness = createTty(120, 30)
    const servers = [{ extension: '.ts', language: 'typescript', command: 'tsserver' }]
    const removed: string[][] = []
    const instance = renderApp(harness, appProps({
      lspStatus: () => ({
        packages: [
          { pkg: '@deepseek-ai/dsh-lsp', present: true },
          { pkg: '@deepseek-ai/dsh-lsp-stdio', present: true },
          { pkg: '@deepseek-ai/dsh-tool-lsp', present: true },
        ],
        servers,
      }),
      lspWrite: entries => {
        for (const entry of entries) servers.push(entry)
        return 'saved'
      },
      lspRemove: extensions => {
        removed.push([...extensions])
        for (const extension of extensions) {
          const index = servers.findIndex(server => server.extension === extension)
          if (index >= 0) servers.splice(index, 1)
        }
        return 'removed 1'
      },
      lspInstallCommand: () => 'dsh plugin --profile cli add …',
    }))
    try {
      await wait()
      harness.stdin.write('/lsp')
      await wait()
      harness.output.text = ''
      harness.stdin.write('\r')
      await wait()
      // Three package rows precede the .ts server row (one key per chunk).
      harness.stdin.write('\x1b[B')
      await wait()
      harness.stdin.write('\x1b[B')
      await wait()
      harness.stdin.write('\x1b[B')
      await wait()
      harness.output.text = ''
      harness.stdin.write('\x7f')
      await wait()
      expect(harness.output.text).toContain('press again')
      harness.stdin.write('\x7f')
      await wait()
      expect(removed).toEqual([['.ts']])
      expect(harness.output.text).toContain('removed 1')
    } finally {
      instance.unmount()
      await wait()
    }
  })
})
