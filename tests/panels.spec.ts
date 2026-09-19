/** Long exclusive-panel regression over real Ink TTY streams. */

import { PassThrough } from 'node:stream'
import chalk from 'chalk'
import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import { App, type AppProps } from '../src/app.ts'
import { HistoryPanel, JobsPanel, ModePanel, PermissionPanel, ResumePanel, SearchPanel, type JobRow, type SearchRow } from '../src/panels/kernel-panels.ts'
import { editQuery } from '../src/ui/query-editor.ts'
import { createTranscriptStore } from '../src/session/store.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DEFAULT_STATUSLINE_ITEMS } from '../src/render/status.ts'
import type { ModelRow } from '../src/models.ts'
import type { ApprovalSnapshot } from '../src/approval.ts'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { PendingQuestion, QuestionSnapshot } from '../src/questions.ts'
import type { ReviewSelection } from '../src/git-workflow.ts'

const wait = async (): Promise<void> => new Promise(resolve => setTimeout(resolve, 100))

// useSyncExternalStore compares getSnapshot results by identity: these
// doubles must return one frozen object forever, or React spins into an
// infinite re-render loop (Maximum update depth exceeded).
const approvalSnapshot = Object.freeze({ pending: undefined, answered: false, queued: 0 })
/** Shared identity-stable empty subagent feed snapshot (getSnapshot contract). */
const EMPTY_AGENTS = Object.freeze([])
const questionSnapshot = Object.freeze({ pending: undefined })

/** Inert void double for the shared App props below. */
const noop = (): void => {}

/**
 * The complete {@link AppProps} surface with inert doubles; a panel test only
 * overrides the props its scenario drives. Typing the factory through the
 * real interface keeps every fixture honest when App gains a required prop
 * instead of letting the object literals drift silently.
 */
function appProps(overrides: Partial<AppProps> = {}): AppProps {
  return {
    store: createTranscriptStore(),
    approval: { subscribe: () => noop, getSnapshot: () => approvalSnapshot },
    questions: { subscribe: () => noop, getSnapshot: () => questionSnapshot, submit: noop, cancel: noop },
    subagents: { subscribe: () => noop, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
    commands: { descriptors: [], subscribe: () => noop, setAgent: noop },
    skills: { rows: [], subscribe: () => noop, setAgent: noop },
    model: 'test/model',
    cwd: 'dsh-cli',
    workspaceRoot: 'C:\\repo\\dsh-cli',
    branch: 'main',
    sessionId: '12345678',
    // The runner passes '' until the first session exists (index.ts).
    sessionKey: '',
    resumed: false,
    mode: 'standard',
    permission: 'workspace-write',
    dispatch: noop,
    steer: noop,
    interrupt: () => false,
    quit: noop,
    loadModels: async () => ({ rows: [], failures: [] }),
    loadMentions: async () => [],
    inspectImages: async () => [],
    prepareImages: async () => [],
    inspectFiles: async () => [],
    prepareFiles: async () => [],
    selectModel: () => 'test/model',
    subagentModel: '',
    setSubagentModel: () => '',
    clearSubagentModel: noop,
    deleteSession: async () => '',
    cycleMode: () => '',
    setPermission: id => id,
    exportTranscript: async () => {},
    renameTitle: () => '',
    copyLastResponse: async () => '',
    loadGitDiff: async () => ({ title: 'git diff', files: [] }),
    reviewChanges: noop,
    loadPresets: async () => [],
    switchMode: async id => id,
    loadPermissions: async () => [],
    createSession: noop,
    forkSession: noop,
    loadSessions: async () => [],
    loadSessionTranscript: async () => '',
    loadUsage: async () => ({ turns: [] }),
    loadSubagents: async () => [],
    switchSession: noop,
    cancelSessionSwitch: () => false,
    loadPlugins: () => [],
    loadJobs: () => [],
    // /update is out of scope here: a probe must fail loudly if a panel opens it.
    probeUpdate: () => Promise.reject(new Error('update probe not wired in panel tests')),
    applyUpdate: async () => 0,
    onBridgeReady: noop,
    statusline: DEFAULT_STATUSLINE_ITEMS,
    saveStatusline: noop,
    saveLanguage: noop,
    history: [],
    recordHistory: noop,
    applyEditorKeys: async () => '',
    ...overrides,
  }
}

describe('exclusive panel height budgets', () => {
  it('bounds long approval and plan-review content without clearing the terminal', async () => {
    let rawModeChanges = 0
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        rawModeChanges += 1
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 80,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const approvalListeners = new Set<() => void>()
    const questionListeners = new Set<() => void>()
    let approvalSnapshot: ApprovalSnapshot = { pending: undefined, answered: false, queued: 0 }
    let questionSnapshot: QuestionSnapshot = { pending: undefined }
    let questionCancelCount = 0
    const noop = (): void => {}
    const instance = render(createElement(App, appProps({
      store: createTranscriptStore(),
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: {
        subscribe: (listener: () => void) => {
          approvalListeners.add(listener)
          return () => approvalListeners.delete(listener)
        },
        getSnapshot: () => approvalSnapshot,
      },
      questions: {
        subscribe: (listener: () => void) => {
          questionListeners.add(listener)
          return () => questionListeners.delete(listener)
        },
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: () => {
          questionCancelCount += 1
        },
      },
      commands: { descriptors: [], subscribe: () => noop, setAgent: noop },
      skills: { rows: [], subscribe: () => noop, setAgent: noop },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => Array.from({ length: 40 }, (_, index) => ({ id: `mode-${index}`, trust: 'user' as const, path: `C:\\presets\\mode-${index}\\agent.yml`, description: `preset ${index}` })),
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => Array.from({ length: 80 }, (_, index) => ({
        id: `session-${index}`, createdAt: index, updatedAt: index, cwd: 'C:\\repo', workspace: 'repo', subagent: false,
        resumable: true, live: false, persisted: true, preset: 'standard', title: `Conversation ${index}`,
      })),
      loadSessionTranscript: async id => `# ${id}\n${Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n')}`,
      loadUsage: async () => ({ turns: [] }),
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => Array.from({ length: 100 }, (_, index) => ({
        entryId: `plugin-${index}`, moduleName: `@test/plugin-${index}`, enabled: true, phase: 'active' as const,
      })),
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      onBridgeReady: noop,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      output = ''
      approvalSnapshot = {
        pending: {
          headline: Array.from({ length: 100 }, (_, index) => `approval reason ${index}`).join('\n'),
          toolName: 'shell_command',
          command: Array.from({ length: 100 }, (_, index) => `command ${index}`).join('\n'),
          answer: noop,
        },
        answered: false,
        queued: 0,
      }
      approvalListeners.forEach(listener => listener())
      await wait()
      expect(output).toContain('Yes, proceed')
      expect(output).toContain('approval reason 0')
      expect(output).toContain('keys go to the approval prompt · esc rejects')
      expect(output.lastIndexOf('keys go to the approval prompt · esc rejects')).toBeLessThan(output.lastIndexOf('test/model'))
      expect(output).not.toContain('\x1b[2J')

      approvalSnapshot = { pending: undefined, answered: false, queued: 0 }
      approvalListeners.forEach(listener => listener())
      questionSnapshot = { pending: undefined }
      questionListeners.forEach(listener => listener())
      await wait()

      output = ''
      stdin.write('/resume')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('/resume')
      expect(output).toContain('keys go to /resume · esc closes')
      expect(output.lastIndexOf('keys go to /resume · esc closes')).toBeLessThan(output.lastIndexOf('test/model'))
      expect(output).not.toContain('\x1b[2J')
      stdin.write('G')
      await wait()
      expect(output).toContain('Conversation 79')
      output = ''
      stdin.write('t')
      await wait()
      expect(output).toContain('transcript · session-79')
      stdin.write('G')
      await wait()
      expect(output).toContain('line 199')
      stdin.write('t')
      await wait()
      stdin.write('q')
      await wait()

      output = ''
      stdin.write('/plugin')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('loader inspector')
      expect(output).toContain('keys go to /plugin · esc closes')
      expect(output.lastIndexOf('keys go to /plugin · esc closes')).toBeLessThan(output.lastIndexOf('test/model'))
      expect(output).not.toContain('\x1b[2J')
      stdin.write('q')
      await wait()

      output = ''
      stdin.write('/mode')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('current standard')
      expect(output).toContain('keys go to /mode · esc closes')
      expect(output.lastIndexOf('keys go to /mode · esc closes')).toBeLessThan(output.lastIndexOf('test/model'))
      expect(output).not.toContain('\x1b[2J')
      stdin.write('q')
      await wait()

      approvalSnapshot = { pending: undefined, answered: false, queued: 0 }
      approvalListeners.forEach(listener => listener())
      await wait()
      output = ''
      const pending = {
        request: {
          questions: [{
            id: 'plan',
            header: 'Review this long plan',
            question: 'Should the agent continue?',
            detail: Array.from({ length: 200 }, (_, index) => `plan line ${index}`).join('\n'),
            options: Array.from({ length: 50 }, (_, index) => ({ label: `option ${index}`, description: `description ${index}` })),
            multiSelect: false,
            intent: { kind: 'plan-review', approve: 'option 0' },
          }],
        },
        resolve: noop,
        reject: noop,
      } as unknown as PendingQuestion
      questionSnapshot = { pending }
      questionListeners.forEach(listener => listener())
      await wait()
      expect(output).toContain('plan review')
      expect(output).toContain('keys go to the question · esc cancels')
      expect(output.lastIndexOf('keys go to the question · esc cancels')).toBeLessThan(output.lastIndexOf('test/model'))
      expect(output).not.toContain('\x1b[2J')

      // Moving a question choice updates local focus and may reveal a distant
      // option. It must not create an effect-driven update loop or erase the
      // terminal while the modal owns input.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        output = ''
        const rawModeChangesBeforeSelection = rawModeChanges
        for (let index = 0; index < 8; index += 1) {
          stdin.write('\x1b[B')
          await wait()
        }
        expect(output).toContain('option 8')
        expect(output).not.toContain('\x1b[2J')
        expect(rawModeChanges).toBe(rawModeChangesBeforeSelection)
        expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('Maximum update depth exceeded')

        // Codex treats choices and the custom editor as two focus layers. A
        // custom draft can return to the preserved choice with Tab, an empty
        // Backspace, or one Escape; only the following Escape cancels.
        stdin.write('c')
        await wait()
        stdin.write('temporary answer')
        await wait()
        output = ''
        stdin.write('\t')
        await wait()
        expect(output).toContain('option 8')

        stdin.write('c')
        await wait()
        output = ''
        stdin.write('\x7f')
        await wait()
        expect(output).toContain('option 8')

        stdin.write('c')
        await wait()
        output = ''
        stdin.write('\x1b')
        await wait()
        expect(output).toContain('option 8')
        expect(questionCancelCount).toBe(0)

        stdin.write('\x1b')
        await wait()
        expect(questionCancelCount).toBe(1)
        expect(rawModeChanges).toBe(rawModeChangesBeforeSelection)
        expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('Maximum update depth exceeded')
      } finally {
        errorSpy.mockRestore()
      }
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('edits statusline items live from /statusline without clearing the terminal', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const approvalListeners = new Set<() => void>()
    const questionListeners = new Set<() => void>()
    const approvalSnapshot: ApprovalSnapshot = { pending: undefined, answered: false, queued: 0 }
    const questionSnapshot: QuestionSnapshot = { pending: undefined }
    const noop = (): void => {}
    const saved: string[][] = []
    let currentItems: readonly string[] = DEFAULT_STATUSLINE_ITEMS
    const instance = render(createElement(App, appProps({
      store: createTranscriptStore(),
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: {
        subscribe: (listener: () => void) => {
          approvalListeners.add(listener)
          return () => approvalListeners.delete(listener)
        },
        getSnapshot: () => approvalSnapshot,
      },
      questions: {
        subscribe: (listener: () => void) => {
          questionListeners.add(listener)
          return () => questionListeners.delete(listener)
        },
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => noop, setAgent: noop },
      skills: { rows: [], subscribe: () => noop, setAgent: noop },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\repo\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      loadUsage: async () => ({ turns: [] }),
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: currentItems,
      saveStatusline: items => {
        currentItems = items
        saved.push([...items])
      },
      history: [],
      recordHistory: noop,
      onBridgeReady: noop,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      expect(output).toContain('test/model')

      output = ''
      stdin.write('/statusline')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('/statusline')
      expect(output).toContain('provider/model serving this session')
      expect(output).toContain('keys go to /statusline · esc closes')
      expect(output.lastIndexOf('keys go to /statusline · esc closes')).toBeLessThan(output.lastIndexOf('test/model'))
      expect(output).not.toContain('\x1b[2J')
      // Accumulated frames (input echo + open panel) each carry the two-row
      // status chrome and the padded composer band (two blank rows), so the
      // newline total may exceed the row count by that per-frame surplus;
      // the single-frame height stays bounded.
      expect(output.split('\n').length).toBeLessThanOrEqual(stdout.rows + 2)

      // Space at the first row (model) disables it: the live footer loses
      // the model fact and the runner-side save receives the exact set.
      output = ''
      stdin.write(' ')
      await wait()
      expect(saved).toHaveLength(1)
      expect(saved[0]).not.toContain('model')
      expect(saved[0]).toHaveLength(DEFAULT_STATUSLINE_ITEMS.length - 1)
      expect(output).not.toContain('\x1b[2J')

      // Down to cwd, disable it too; then reorder model-free expectations
      // stay order-stable: cwd follows the disabled model slot.
      stdin.write('\x1b[B')
      await wait()
      stdin.write(' ')
      await wait()
      expect(saved).toHaveLength(2)
      expect(saved[1]).not.toContain('cwd')

      // Esc closes the picker; the composer and status chrome remain.
      output = ''
      stdin.write('\x1b')
      await wait()
      expect(output).toContain('type a message')
      expect(output).not.toContain('customize the status line')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})

describe('queued messages and global recall', () => {
  it('renders queued inbox rows and cancels the newest with Delete on an empty composer', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const approvalListeners = new Set<() => void>()
    const questionListeners = new Set<() => void>()
    const approvalSnapshot: ApprovalSnapshot = { pending: undefined, answered: false, queued: 0 }
    const questionSnapshot: QuestionSnapshot = { pending: undefined }
    const noop = (): void => {}
    const steering = createUserMessage({
      content: [{ type: 'text', text: 'fix the build' }],
      source: { kind: 'user' },
    })
    const queued = createUserMessage({
      content: [{ type: 'text', text: 'then run tests' }],
      source: { kind: 'user' },
    })
    const later = createUserMessage({
      content: [{ type: 'text', text: 'then inspect the diff' }],
      source: { kind: 'user' },
    })
    const cancelled: string[] = []
    const updates: Array<{ messageId: string; kind: string; text?: string }> = []
    const store = createTranscriptStore([
      {
        type: 'agent/inbox/spliced',
        seq: 1,
        time: 0,
        data: { target: 'next-step', start: 0, inserted: [steering] },
      } as never,
      {
        type: 'agent/inbox/spliced',
        seq: 2,
        time: 0,
        data: { target: 'next-turn', start: 0, inserted: [queued, later] },
      } as never,
    ])
    const instance = render(createElement(App, appProps({
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      store,
      approval: {
        subscribe: (listener: () => void) => {
          approvalListeners.add(listener)
          return () => approvalListeners.delete(listener)
        },
        getSnapshot: () => approvalSnapshot,
      },
      questions: {
        subscribe: (listener: () => void) => {
          questionListeners.add(listener)
          return () => questionListeners.delete(listener)
        },
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => noop, setAgent: noop },
      skills: { rows: [], subscribe: () => noop, setAgent: noop },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\repo\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      loadUsage: async () => ({ turns: [] }),
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      updateQueued: (messageId, action) => {
        updates.push({ messageId, kind: action.kind, ...action.kind === 'edit' ? { text: action.text } : {} })
        if (action.kind === 'remove') cancelled.push(messageId)
      },
      onBridgeReady: noop,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // Next-step steering uses ↳; next-turn queue uses ❯.
      expect(output).toContain('↳ fix the build')
      expect(output).toContain('❯ then run tests')

      // /queue is an exclusive next-turn panel: it follows inbox order,
      // not transcript append order, and never exposes next-step steering.
      output = ''
      stdin.write('/queue')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('2 queued')
      expect(output).toContain('1. then run tests')
      expect(output).toContain('2. then inspect the diff')

      // The panel edits one exact row, then permits promotion only once the
      // durable view says a turn is running.
      stdin.write('e')
      await wait()
      stdin.write('\x7f')
      await wait()
      stdin.write('\r')
      await wait()
      expect(updates).toContainEqual({ messageId: queued.id, kind: 'edit', text: 'then run test' })
      store.apply({ type: 'turn/start', seq: 3, time: 1, data: { turn: 1 } } as never)
      await wait()
      stdin.write('\r')
      await wait()
      expect(updates).toContainEqual({ messageId: queued.id, kind: 'steer' })
      stdin.write('\x1b')
      await wait()

      // Reopen the panel: `d` is its only removal key. Ink reports the
      // forward-delete sequence and a bare Backspace as the same `key.delete`,
      // so a Delete binding here would erase a row on a habitual Backspace.
      stdin.write('/queue')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('\x1b[3~')
      await wait()
      expect(updates.filter(update => update.kind === 'remove')).toHaveLength(0)
      stdin.write('d')
      await wait()
      expect(updates.filter(update => update.kind === 'remove')).toHaveLength(1)
      stdin.write('\x1b')
      await wait()
      cancelled.length = 0

      // Delete on the empty composer cancels the NEWEST queued row.
      output = ''
      stdin.write('\x1b[3~')
      await wait()
      expect(cancelled).toEqual([later.id])

      // A non-empty draft keeps Delete as text editing — no cancellation.
      output = ''
      stdin.write('draft text')
      await wait()
      stdin.write('\x1b[3~')
      await wait()
      expect(cancelled).toHaveLength(1)
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('walks a long queue with g/G and paging, keeping the window on the selection', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const approvalListeners = new Set<() => void>()
    const questionListeners = new Set<() => void>()
    const noop = (): void => {}
    const store = createTranscriptStore()
    for (let index = 1; index <= 30; index += 1) {
      store.apply({
        type: 'agent/inbox/spliced',
        seq: index,
        time: index,
        data: {
          target: 'next-turn',
          start: index - 1,
          inserted: [createUserMessage({ content: [{ type: 'text', text: `msg ${index}` }], source: { kind: 'user' } })],
        },
      } as never)
    }
    const instance = render(createElement(App, appProps({
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      store,
      approval: {
        subscribe: (listener: () => void) => {
          approvalListeners.add(listener)
          return () => approvalListeners.delete(listener)
        },
        // Stable frozen snapshots: an inline object literal would hand React a
        // new identity on every getSnapshot call and spin it into
        // "Maximum update depth exceeded".
        getSnapshot: () => approvalSnapshot,
      },
      questions: {
        subscribe: (listener: () => void) => {
          questionListeners.add(listener)
          return () => questionListeners.delete(listener)
        },
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => noop, setAgent: noop },
      skills: { rows: [], subscribe: () => noop, setAgent: noop },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      loadUsage: async () => ({ turns: [] }),
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      updateQueued: noop,
      onBridgeReady: noop,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      stdin.write('/queue')
      await wait()
      stdin.write('\r')
      await wait()
      // The window starts at the head and covers exactly one body page.
      expect(output).toContain('30 queued')
      const firstWindow = /rows 1-(\d+)/u.exec(output)
      expect(firstWindow).not.toBeNull()
      const bodyRows = Number(firstWindow![1])
      expect(bodyRows).toBeGreaterThan(1)
      expect(bodyRows).toBeLessThan(30)
      expect(output).toContain('1. msg 1')

      // G jumps to the tail and the window follows it to the last page.
      stdin.write('G')
      await wait()
      expect(output).toContain(`rows ${30 - bodyRows + 1}-30`)
      expect(output).toContain('30. msg 30')

      // g returns to the head.
      stdin.write('g')
      await wait()
      expect(output).toContain(`rows 1-${bodyRows}`)
      expect(output).toContain('1. msg 1')

      // A page down advances the selection by one body page (still inside the
      // first window), so the selected row carries the cursor mark.
      output = ''
      stdin.write('\x1b[6~')
      await wait()
      expect(output).toContain(`› ${bodyRows}. msg ${bodyRows}`)

      // A second page pushes past the first window: it scrolls to keep the
      // selection visible and still spans exactly one body page.
      output = ''
      stdin.write('\x1b[6~')
      await wait()
      const paged = /rows (\d+)-(\d+)/u.exec(output)
      expect(paged).not.toBeNull()
      expect(Number(paged![1])).toBeGreaterThan(1)
      expect(Number(paged![2])).toBe(Number(paged![1]) + bodyRows - 1)
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('searches past prompts in /history and fills the composer from a match', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const noop = (): void => {}
    const recorded: string[] = []
    const approvalListeners = new Set<() => void>()
    const questionListeners = new Set<() => void>()
    const instance = render(createElement(App, appProps({
      store: createTranscriptStore(),
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: {
        subscribe: (listener: () => void) => {
          approvalListeners.add(listener)
          return () => approvalListeners.delete(listener)
        },
        getSnapshot: () => approvalSnapshot,
      },
      questions: {
        subscribe: (listener: () => void) => {
          questionListeners.add(listener)
          return () => questionListeners.delete(listener)
        },
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => noop, setAgent: noop },
      skills: { rows: [], subscribe: () => noop, setAgent: noop },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\repo\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      loadUsage: async () => ({ turns: [] }),
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: ['fix the login bug', 'bump the package version'],
      recordHistory: text => {
        recorded.push(text)
      },
      onBridgeReady: noop,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // Submit a new prompt: recorded to the persistent file and recallable.
      stdin.write('draft prompt')
      await wait()
      stdin.write('\r')
      await wait()
      expect(recorded).toEqual(['draft prompt'])

      // Open /history: the recall space is newest-first, so the fresh
      // submission leads the list.
      output = ''
      stdin.write('/history')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('/history · 4 prompts · type to filter')

      // Filter to one match and accept it: the composer fills and the panel closes.
      stdin.write('package')
      await wait()
      expect(output).toContain('1 of 4 match')
      output = ''
      stdin.write('\r')
      await wait()
      expect(output).toContain('bump the package version')
      expect(output).not.toContain('1 of 3 match')

      // The first Up stays inside the filled prompt and moves to its visual
      // start; recall then walks the newest-first space - the locally
      // recorded '/history' and 'draft prompt' lead, and the oldest
      // persistent entry arrives last.
      output = ''
      stdin.write('\x1b[A')
      await wait()
      // The filled entry's caret rests on the text end, so the first Up
      // crosses to the older persistent entry; Down walks back through
      // the newer shared entries: the prompt and the typed /history
      // command itself.
      // The filled entry's caret rests on the text end, so the first Up
      // crosses to the older persistent entry; Down walks back through
      // the newer shared entries: the prompt and the typed /history
      // command itself.
      stdin.write('\x1b[A')
      await wait()
      expect(output).toContain('fix the login bug')
      stdin.write('\x1b[B')
      await wait()
      expect(output).toContain('bump the package version')
      stdin.write('\x1b[B')
      await wait()
      expect(output).toContain('draft prompt')
      stdin.write('\x1b[B')
      await wait()
      expect(output).toContain('/history')
      // Both the prompt and the typed /history command joined the shared
      // persistent history, in submission order.
      expect(recorded).toEqual(['draft prompt', '/history'])
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('opens the /review picker and resolves every candidate kind', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const noop = (): void => {}
    const reviews: ReviewSelection[] = []
    const approvalListeners = new Set<() => void>()
    const questionListeners = new Set<() => void>()
    const instance = render(createElement(App, appProps({
      store: createTranscriptStore(),
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: {
        subscribe: (listener: () => void) => {
          approvalListeners.add(listener)
          return () => approvalListeners.delete(listener)
        },
        getSnapshot: () => approvalSnapshot,
      },
      questions: {
        subscribe: (listener: () => void) => {
          questionListeners.add(listener)
          return () => questionListeners.delete(listener)
        },
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => noop, setAgent: noop },
      skills: { rows: [], subscribe: () => noop, setAgent: noop },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      listReviewBranches: async () => [{ name: 'develop' }, { name: 'release' }],
      listReviewCommits: async () => [{ sha: 'abc123def456', title: 'fix the login bug', at: Date.now() }],
      reviewChanges: selection => {
        reviews.push(selection)
      },
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      loadUsage: async () => ({ turns: [] }),
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      onBridgeReady: noop,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      stdin.write('/review')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('choose a target')

      // Preset 1 (cursor rests on it): the uncommitted review.
      stdin.write('\r')
      await wait()
      expect(reviews).toEqual([{ kind: 'uncommitted' }])

      // Reopen, walk to the branch preset, pick the loaded branch.
      output = ''
      stdin.write('/review')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('\x1b[B')
      await wait()
      stdin.write('\r')
      await wait()
      for (let i = 0; i < 20 && !output.includes('develop'); i += 1) await wait()
      expect(output).toContain('develop')
      stdin.write('\r')
      await wait()
      expect(reviews).toEqual([{ kind: 'uncommitted' }, { kind: 'base-branch', branch: 'develop' }])

      // Reopen, commit preset, filter by typing, pick the commit.
      output = ''
      stdin.write('/review')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('\x1b[B')
      await wait()
      stdin.write('\x1b[B')
      await wait()
      stdin.write('\r')
      await wait()
      for (let i = 0; i < 20 && !output.includes('fix the login bug'); i += 1) await wait()
      expect(output).toContain('abc123d')
      stdin.write('\r')
      await wait()
      expect(reviews).toEqual([{ kind: 'uncommitted' }, { kind: 'base-branch', branch: 'develop' }, { kind: 'commit', sha: 'abc123def456' }])

      // Reopen, custom focus: type and submit.
      output = ''
      stdin.write('/review')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('\x1b[B')
      await wait()
      stdin.write('\x1b[B')
      await wait()
      stdin.write('\x1b[B')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('concurrency only')
      await wait()
      stdin.write('\r')
      await wait()
      expect(reviews).toEqual([{ kind: 'uncommitted' }, { kind: 'base-branch', branch: 'develop' }, { kind: 'commit', sha: 'abc123def456' }, { kind: 'custom', instructions: 'concurrency only' }])
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('opens /search with a seed query and searches immediately', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const noop = (): void => {}
    const searched: string[] = []
    const approvalListeners = new Set<() => void>()
    const questionListeners = new Set<() => void>()
    const instance = render(createElement(App, appProps({
      store: createTranscriptStore(),
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: {
        subscribe: (listener: () => void) => {
          approvalListeners.add(listener)
          return () => approvalListeners.delete(listener)
        },
        getSnapshot: () => approvalSnapshot,
      },
      questions: {
        subscribe: (listener: () => void) => {
          questionListeners.add(listener)
          return () => questionListeners.delete(listener)
        },
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => noop, setAgent: noop },
      skills: { rows: [], subscribe: () => noop, setAgent: noop },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\repo\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      searchSessions: async (query: string) => {
        searched.push(query)
        return [{
          id: 'session-seed-hit',
          label: 'seed hit',
          detail: '',
          snippet: 'matched the seeded query',
          updatedAt: Date.now(),
          subagent: false,
          resumable: true,
        }]
      },
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      loadUsage: async () => ({ turns: [] }),
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      onBridgeReady: noop,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // /search <query> opens the panel seeded: the effect fires the search
      // immediately, before any keystroke.
      stdin.write('/search seeded query')
      await wait()
      stdin.write('\r')
      for (let i = 0; i < 20 && !output.includes("1 hit for 'seeded query'"); i += 1) await wait()
      expect(searched).toEqual(['seeded query'])
      expect(output).toContain("1 hit for 'seeded query'")
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('notifies instead of opening /search when the deployment has no engine', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const noop = (): void => {}
    const approvalListeners = new Set<() => void>()
    const questionListeners = new Set<() => void>()
    const instance = render(createElement(App, appProps({
      store: createTranscriptStore(),
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: {
        subscribe: (listener: () => void) => {
          approvalListeners.add(listener)
          return () => approvalListeners.delete(listener)
        },
        getSnapshot: () => approvalSnapshot,
      },
      questions: {
        subscribe: (listener: () => void) => {
          questionListeners.add(listener)
          return () => questionListeners.delete(listener)
        },
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => noop, setAgent: noop },
      skills: { rows: [], subscribe: () => noop, setAgent: noop },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\repo\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      loadUsage: async () => ({ turns: [] }),
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      onBridgeReady: noop,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // No searchSessions prop: /search degrades to a notice, no panel.
      stdin.write('/search')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('session search is unavailable')
      expect(output).not.toContain("type a query")
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('searches persisted sessions from /search and resumes the picked hit', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const noop = (): void => {}
    const switched: string[] = []
    const approvalListeners = new Set<() => void>()
    const questionListeners = new Set<() => void>()
    const instance = render(createElement(App, appProps({
      store: createTranscriptStore(),
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: {
        subscribe: (listener: () => void) => {
          approvalListeners.add(listener)
          return () => approvalListeners.delete(listener)
        },
        getSnapshot: () => approvalSnapshot,
      },
      questions: {
        subscribe: (listener: () => void) => {
          questionListeners.add(listener)
          return () => questionListeners.delete(listener)
        },
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => noop, setAgent: noop },
      skills: { rows: [], subscribe: () => noop, setAgent: noop },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\repo\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      searchSessions: async (query: string) => {
        expect(query).toBe('login bug')
        return [
          {
            id: 'session-hit-1',
            label: 'session-hit',
            detail: 'dsh-cli · standard',
            snippet: 'fix the login bug in auth.ts',
            updatedAt: Date.now(),
            subagent: false,
            resumable: true,
          },
          {
            id: 'child-hit-1',
            label: 'child-hit',
            detail: '',
            snippet: 'subagent also mentions the login bug',
            updatedAt: Date.now(),
            subagent: true,
            resumable: false,
          },
        ]
      },
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      loadUsage: async () => ({ turns: [] }),
      switchSession: (row: { id: string }) => {
        switched.push(row.id)
      },
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      onBridgeReady: noop,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // Open the panel, type a query, and search.
      stdin.write('/search')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('/search · type a query')
      stdin.write('login bug')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain("2 hits for 'login bug'")
      expect(output).toContain('⎿ fix the login bug in auth.ts')
      // Down onto the read-only subagent hit: Enter must keep the panel and
      // its results instead of trading them for a rejected switch.
      stdin.write('\x1b[B')
      await wait()
      expect(output).toContain('read-only')
      stdin.write('\r')
      await wait()
      expect(switched).toEqual([])
      expect(output).toContain('2 hits for')
      // Back up onto the resumable hit: Enter resumes it.
      stdin.write('\x1b[A')
      await wait()
      stdin.write('\r')
      await wait()
      expect(switched).toEqual(['session-hit-1'])
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('keeps uppercase letters in /history filters and makes g/G query text mid-filter', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const noop = (): void => {}
    const approvalListeners = new Set<() => void>()
    const questionListeners = new Set<() => void>()
    const instance = render(createElement(App, appProps({
      store: createTranscriptStore(),
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: {
        subscribe: (listener: () => void) => {
          approvalListeners.add(listener)
          return () => approvalListeners.delete(listener)
        },
        getSnapshot: () => approvalSnapshot,
      },
      questions: {
        subscribe: (listener: () => void) => {
          questionListeners.add(listener)
          return () => questionListeners.delete(listener)
        },
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => noop, setAgent: noop },
      skills: { rows: [], subscribe: () => noop, setAgent: noop },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\repo\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      loadUsage: async () => ({ turns: [] }),
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: ['Fix the login bug', 'bump the package version'],
      recordHistory: noop,
      onBridgeReady: noop,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // Open /history: the recall space holds the typed command plus the two
      // persistent entries, newest first.
      stdin.write('/history')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('/history · 3 prompts · type to filter')

      // Typing 'Fix' sends a shift-marked 'F' through Ink's key parser; the
      // uppercase letter must reach the query, not vanish (regression).
      stdin.write('Fix')
      await wait()
      expect(output).toContain("1 of 3 match 'Fix'")

      // Mid-filter, 'g' extends the query instead of jumping to the top.
      stdin.write('g')
      await wait()
      expect(output).toContain("0 of 3 match 'Fixg'")

      // Clear the query: with it empty again, G/g regain their jump roles.
      stdin.write('\x7f')
      await wait()
      stdin.write('\x7f')
      await wait()
      stdin.write('\x7f')
      await wait()
      stdin.write('\x7f')
      await wait()
      output = ''
      stdin.write('G')
      await wait()
      // The recall space is newest-first ('/history' leads), so G lands on
      // the oldest row: the last persistent entry.
      expect(output).toContain('› Fix the login bug')
      stdin.write('g')
      await wait()
      expect(output).toContain('› /history')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('shows the Codex shimmer Deep-diving line and original braille busy marker', async () => {
    const originalChalkLevel = chalk.level
    chalk.level = 3
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const noop = (): void => {}
    const instance = render(createElement(App, appProps({
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      store: createTranscriptStore([
        { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } } as never,
      ]),
      approval: {
        subscribe: () => () => {},
        getSnapshot: () => approvalSnapshot,
      },
      questions: {
        subscribe: () => () => {},
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => noop, setAgent: noop },
      skills: { rows: [], subscribe: () => noop, setAgent: noop },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\repo\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      loadUsage: async () => ({ turns: [] }),
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      onBridgeReady: noop,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      const plainOutput = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '')
      expect(plainOutput).toContain('✻ Deep diving')
      expect(plainOutput).not.toContain('Deep diving... ✻')
      // The busy composer keeps the original rotating braille chase.
      const frames = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']
      expect(frames.some(frame => plainOutput.includes(frame))).toBe(true)
      // The status text is painted by the active-palette blue shimmer,
      // rather than one dim gray span.
      expect(output).toContain('38;2;72;104;178m')
      expect(output).toContain('38;2;103;158;254m')
      expect(output).not.toContain('❯ type a message')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
      chalk.level = originalChalkLevel
    }
  })
})

describe('/model effort stage', () => {
  it('lists a multi-level model’s efforts, backs out without applying, and applies a picked level', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const noop = (): void => {}
    const approvalListeners = new Set<() => void>()
    const questionListeners = new Set<() => void>()
    const approvalSnapshot: ApprovalSnapshot = { pending: undefined, answered: false, queued: 0 }
    const questionSnapshot: QuestionSnapshot = { pending: undefined }
    const picked: { row: ModelRow; effortId?: string }[] = []
    const rows: readonly ModelRow[] = [
      {
        provider: 'deepseek-official',
        providerName: 'DeepSeek',
        model: 'deepseek-v4',
        modelName: 'V4',
        reasoning: {
          efforts: [
            { id: 'off', name: 'Off' },
            { id: 'high', name: 'High' },
            { id: 'max', name: 'Max' },
          ],
          defaultEffort: 'high',
        },
      },
      {
        provider: 'acme',
        providerName: 'Acme',
        model: 'single',
        modelName: 'Single',
        reasoning: { efforts: [{ id: 'high', name: 'High' }] },
      },
      { provider: 'acme', providerName: 'Acme', model: 'plain', modelName: 'Plain' },
      {
        provider: 'acme',
        providerName: 'Acme',
        model: 'think',
        modelName: 'Think',
        reasoning: {
          efforts: [
            { id: 'off', name: 'Off' },
            { id: 'high', name: 'High' },
            { id: 'max', name: 'Max' },
          ],
        },
      },
    ]
    const instance = render(createElement(App, appProps({
      store: createTranscriptStore(),
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: {
        subscribe: (listener: () => void) => {
          approvalListeners.add(listener)
          return () => approvalListeners.delete(listener)
        },
        getSnapshot: () => approvalSnapshot,
      },
      questions: {
        subscribe: (listener: () => void) => {
          questionListeners.add(listener)
          return () => questionListeners.delete(listener)
        },
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => noop, setAgent: noop },
      skills: { rows: [], subscribe: () => noop, setAgent: noop },
      model: 'acme/plain',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows, failures: [] }),
      loadMentions: async () => [],
      selectModel: (row: ModelRow, effortId?: string) => {
        picked.push({ row, effortId })
        return `${row.provider}/${row.model}`
      },
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      loadUsage: async () => ({ turns: [] }),
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      onBridgeReady: noop,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      output = ''
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      // The list opens on the APPLIED model (acme/plain, row 3 of 4) — the
      // cursor follows the current pick. Jump to the first row to reach the
      // multi-level DeepSeek model.
      expect(output).toContain('· 3/4')
      // Typing filters the directory in place; 'v4' narrows to the DeepSeek row.
      stdin.write('v4')
      await wait()
      stdin.write('\r')
      await wait()
      // The first row advertises three levels: the effort stage opens instead
      // of applying directly, with the model default marked.
      expect(output).toContain('effort for DeepSeek · V4')
      expect(output).toContain('Off')
      expect(output).toContain('Max')
      expect(output).toContain('· default')
      expect(picked).toHaveLength(0)

      // Esc returns to the model list without applying anything. The cursor
      // re-positions on the APPLIED model (acme/plain, index 2) — one up
      // reaches acme/single.
      output = ''
      stdin.write('\x1b')
      await wait()
      expect(output).toContain('select model')
      expect(output).toContain('Plain')
      expect(picked).toHaveLength(0)

      // A single advertised level is applied directly, no stage.
      output = ''
      stdin.write('\x1b[A')
      await wait()
      stdin.write('\r')
      await wait()
      expect(picked).toEqual([{ row: rows[1], effortId: 'high' }])
      expect(output).toContain('model → next step uses acme/single@high')

      // A model without reasoning applies with no effort at all. The list
      // now opens on the APPLIED model (acme/single from the last pick):
      // one down reaches acme/plain.
      output = ''
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('\x1b[B')
      await wait()
      stdin.write('\r')
      await wait()
      expect(picked).toEqual([
        { row: rows[1], effortId: 'high' },
        { row: rows[2] },
      ])
      expect(output).toContain('model → next step uses acme/plain')

      // Re-open the multi-level model and pick the third level. The list
      // opens on acme/plain again: filter to the DeepSeek row, then the
      // effort stage opens ON the effective level (high) and one down reaches max.
      output = ''
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('v4')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('effort for DeepSeek · V4')
      stdin.write('\x1b[B')
      await wait()
      stdin.write('\r')
      await wait()
      expect(picked).toEqual([
        { row: rows[1], effortId: 'high' },
        { row: rows[2] },
        { row: rows[0], effortId: 'max' },
      ])
      expect(output).toContain('model → next step uses deepseek-official/deepseek-v4@max')
      expect(output).toContain('type a message')

      // A model WITHOUT an adapter-declared default leads the effort stage
      // with a provider-default row: picking it clears the effort back to
      // provider behavior instead of forcing an advertised level. The list
      // opens on deepseek-v4 (the applied model): three downs reach
      // acme/think; its stage opens on the effective level (max), so jump to
      // the top for the Default row.
      output = ''
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('\x1b[B')
      await wait()
      stdin.write('\x1b[B')
      await wait()
      stdin.write('\x1b[B')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('effort for Acme · Think')
      expect(output).toContain('Default')
      stdin.write('g')
      await wait()
      stdin.write('\r')
      await wait()
      expect(picked).toEqual([
        { row: rows[1], effortId: 'high' },
        { row: rows[2] },
        { row: rows[0], effortId: 'max' },
        { row: rows[3], effortId: '' },
      ])
      expect(output).toContain('type a message')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})

describe('/effort command', () => {
  it('opens the effort stage for the current model even when its default route name differs from the catalog', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const noop = (): void => {}
    const rows: readonly ModelRow[] = [
      {
        provider: 'deepseek-official',
        providerName: 'DeepSeek',
        model: 'deepseek-v4',
        modelName: 'V4',
        reasoning: {
          efforts: [
            { id: 'off', name: 'Off' },
            { id: 'high', name: 'High' },
            { id: 'max', name: 'Max' },
          ],
          defaultEffort: 'high',
        },
      },
      { provider: 'acme', providerName: 'Acme', model: 'plain', modelName: 'Plain' },
    ]
    const instance = render(createElement(App, appProps({
      store: createTranscriptStore(),
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: { subscribe: () => noop, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => noop,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => noop, setAgent: noop },
      skills: { rows: [], subscribe: () => noop, setAgent: noop },
      // The deployment default names the route `deepseek`, while the catalog
      // registers `deepseek-official` for the same model id — the fallback
      // match must still resolve the row and open the effort stage.
      model: 'deepseek/deepseek-v4',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows, failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'deepseek/deepseek-v4',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      loadUsage: async () => ({ turns: [] }),
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      onBridgeReady: noop,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      stdin.write('/effort')
      await wait()
      stdin.write('\r')
      await wait()
      // The fallback match opened the effort stage for the catalog row.
      expect(output).toContain('effort for DeepSeek · V4')
      expect(output).toContain('○ Off')
      expect(output).toContain('High · default')
      expect(output).toContain('Max')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('ignores a stale /effort catalog lookup after the model picker takes over', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const rows: readonly ModelRow[] = [
      {
        provider: 'deepseek-official',
        providerName: 'DeepSeek',
        model: 'deepseek-v4',
        modelName: 'V4',
        reasoning: {
          efforts: [
            { id: 'off', name: 'Off' },
            { id: 'high', name: 'High' },
          ],
          defaultEffort: 'high',
        },
      },
    ]
    let resolveEffort: ((value: { rows: readonly ModelRow[]; failures: readonly string[] }) => void) | undefined
    let loads = 0
    const instance = render(createElement(App, appProps({
      model: 'deepseek-official/deepseek-v4',
      loadModels: async () => {
        loads += 1
        if (loads === 1) {
          return await new Promise(resolve => { resolveEffort = resolve })
        }
        return { rows, failures: [] }
      },
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      await wait()
      stdin.write('/effort')
      await wait()
      stdin.write('/model')
      await wait()
      resolveEffort?.({ rows, failures: [] })
      await wait()
      expect(output).not.toContain('effort for DeepSeek · V4')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})

describe('panel row sanitization', () => {
  const fakeStreams = (columns = 100, rows = 24): {
    stdin: NodeJS.ReadStream
    stdout: NodeJS.WriteStream
    read: () => string
  } => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns,
      rows,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    return { stdin, stdout, read: () => output }
  }

  it('sanitizes preset names and descriptions in the /mode list', async () => {
    const { stdin, stdout, read } = fakeStreams()
    const instance = render(createElement(ModePanel, {
      current: 'standard',
      load: async () => [{
        id: 'evil',
        trust: 'user' as const,
        path: 'C:\\presets\\evil\\agent.yml',
        name: 'bad\x1b]0;pwned\x07name',
        description: 'desc\u202eFlipped\nnewline',
      }],
      select: () => {},
      close: () => {},
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      await wait()
      const output = read()
      expect(output).toContain('bad\\x1b]0;pwned\\x07name')
      expect(output).toContain('desc\\u202eFlipped ↵ newline')
      expect(output).not.toContain('\x1b]')
      expect(output).not.toContain('\u202e')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('lists and selects permission presets from the /permission panel', async () => {
    const { stdin, stdout, read } = fakeStreams()
    const selected: string[] = []
    let closed = false
    const instance = render(createElement(PermissionPanel, {
      current: 'workspace-write',
      load: async () => [
        { id: 'read-only', description: 'read\u202eOnly' },
        { id: 'workspace-write', description: 'write within the workspace' },
        { id: 'danger-full-access' },
      ],
      select: id => {
        selected.push(id)
      },
      close: () => {
        closed = true
      },
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      await wait()
      const output = read()
      expect(output).toContain('/permission · current workspace-write')
      // The current preset carries the ● mark; descriptions stay sanitized.
      expect(output).toContain('● workspace-write · write within the workspace')
      expect(output).toContain('read\\u202eOnly')
      // Enter applies the cursor row (read-only); escape closes.
      stdin.write('\r')
      await wait()
      expect(selected).toEqual(['read-only'])
      stdin.write('\x1b')
      await wait()
      expect(closed).toBe(true)
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('shows the selected row on compact and too-small terminals instead of hiding the list', async () => {
    for (const height of [9, 8] as const) {
      const { stdin, stdout, read } = fakeStreams(60, height)
      const instance = render(createElement(PermissionPanel, {
        current: 'workspace-write',
        load: async () => [
          { id: 'read-only', description: 'read only' },
          { id: 'workspace-write', description: 'write within the workspace' },
        ],
        select: () => {},
        close: () => {},
      }), { stdin, stdout, stderr: stdout, exitOnCtrlC: false, patchConsole: false })
      try {
        await wait()
        const output = read()
        // One visible line shows the current selection and the exit — never
        // a hidden surface whose keys still act invisibly. Selection leads so
        // narrow terminals never truncate the escape hint away.
        expect(output).toContain('❯ ○ read-only')
        expect(output).toContain('esc close')
      } finally {
        instance.unmount()
        stdin.destroy()
        stdout.destroy()
      }
    }
  })

  it('sanitizes session titles and workspaces in /resume rows', async () => {
    const { stdin, stdout, read } = fakeStreams()
    const instance = render(createElement(ResumePanel, {
      currentCwd: 'C:\\repo',
      load: async () => [{
        id: 's-1',
        createdAt: 1,
        updatedAt: 1,
        cwd: 'C:\\evil',
        workspace: 'evil',
        subagent: false,
        resumable: true,
        live: false,
        persisted: true,
        preset: 'standard',
        title: 'T\x1b[31mred\u202eR',
      }],
      readTranscript: async () => '',
      select: () => {},
      close: () => {},
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      await wait()
      const output = read()
      expect(output).toContain('T\\x1b[31mred\\u202eR')
      expect(output).not.toContain('\x1b[31m')
      expect(output).not.toContain('\u202e')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('drops stale search results once a newer query supersedes them', async () => {
    const { stdin, stdout, read } = fakeStreams()
    const pending: Array<(rows: readonly SearchRow[]) => void> = []
    const row = (id: string): SearchRow => ({
      id, label: id, detail: '', snippet: `snippet ${id}`, updatedAt: Date.now(), subagent: false, resumable: true,
    })
    const instance = render(createElement(SearchPanel, {
      // Every search parks on a caller-resolved promise so the test controls
      // settlement order exactly.
      load: () => new Promise<readonly SearchRow[]>(resolve => { pending.push(resolve) }),
      select: () => {},
      close: () => {},
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      await wait()
      stdin.write('first')
      await wait()
      stdin.write('\r')
      await wait()
      expect(pending).toHaveLength(1)
      stdin.write('\x7f\x7f\x7f\x7f\x7f')
      await wait()
      stdin.write('second')
      await wait()
      stdin.write('\r')
      await wait()
      expect(pending).toHaveLength(2)
      // The NEWER search settles first and must own the panel; the stale
      // promise resolving afterwards is dropped by the abort guard.
      pending[1]([row('second-hit')])
      await wait()
      pending[0]([row('first-hit')])
      await wait()
      const output = read()
      expect(output).toContain('second-hit')
      expect(output).not.toContain('first-hit')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('keeps multiline, tabbed, and OSC history entries on one physical row', async () => {
    const { stdin, stdout, read } = fakeStreams()
    const instance = render(createElement(HistoryPanel, {
      entries: ['line one\nline two\t tabbed', 'bad\x1b]0;x\x07entry'],
      fill: () => {},
      close: () => {},
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      await wait()
      const output = read()
      // Newlines collapse to the ↵ marker and tabs to two spaces, so a
      // persisted multi-line prompt never breaks the one-row budget; the
      // OSC introducer is rendered as a visible \x1b escape.
      expect(output).toContain('line one ↵ line two   tabbed')
      expect(output).toContain('bad\\x1b]0;x\\x07entry')
      expect(output).not.toContain('\x1b]')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})

describe('panel search query editing', () => {
  it('accepts multi-character IME commits', () => {
    expect(editQuery('', '你好', {})).toBe('你好')
    expect(editQuery('mo', 'de', {})).toBe('mode')
  })
  it('strips bracketed paste markers instead of persisting them', () => {
    expect(editQuery('', '[200~query[201~', {})).toBe('query')
  })
  it('deletes whole graphemes, never splitting surrogate pairs', () => {
    expect(editQuery('a👨‍👩‍👦', '', { backspace: true })).toBe('a')
    expect(editQuery('你好', '', { delete: true })).toBe('你')
    expect(editQuery('', '', { backspace: true })).toBe('')
  })
  it('ignores control-laden and empty chunks', () => {
    expect(editQuery('q', '[A', {})).toBeUndefined()
    expect(editQuery('q', '', {})).toBeUndefined()
  })
})

describe('/jobs panel', () => {
  it('lists background jobs with status marks and elapsed clocks, closes on esc', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 80,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    let closed = false
    const rows: readonly JobRow[] = [
      { id: 'bash-1', kind: 'bash', label: 'pnpm test', status: 'running', startedAt: Date.now() - 65_000 },
      { id: 'bash-2', kind: 'bash', label: 'build docs', status: 'completed', detail: 'exit code: 0', startedAt: Date.now() - 120_000, finishedAt: Date.now() - 61_000 },
    ]
    const instance = render(createElement(JobsPanel, {
      load: () => rows,
      close: () => {
        closed = true
      },
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      await wait()
      expect(output).toContain('/jobs · background tasks · 2')
      expect(output).toContain('● bash-1 · pnpm test · 1m05s')
      expect(output).toContain('✓ bash-2 · build docs · 59s · exit code: 0')
      stdin.write('')
      await wait()
      expect(closed).toBe(true)
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})

describe('/model typing filter', () => {
  it('narrows the directory as you type, keeps q as query text mid-filter, and restores typing on close', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const noop = (): void => {}
    const picked: ModelRow[] = []
    const instance = render(createElement(App, appProps({
      store: createTranscriptStore(),
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: { subscribe: () => noop, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => noop,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => noop, setAgent: noop },
      skills: { rows: [], subscribe: () => noop, setAgent: noop },
      model: 'deepseek/deepseek-chat',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [
        { provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-chat', modelName: 'DeepSeek Chat' },
        { provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-reasoner', modelName: 'DeepSeek Reasoner' },
        { provider: 'openai', providerName: 'OpenAI', model: 'gpt-5.1', modelName: 'GPT-5.1' },
        { provider: 'openai', providerName: 'OpenAI', model: 'gpt-5-mini', modelName: 'GPT-5 mini' },
      ], failures: [] }),
      loadMentions: async () => [],
      selectModel: row => {
        picked.push(row)
        return `${row.provider}/${row.model}`
      },
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      loadUsage: async () => ({ turns: [] }),
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      onBridgeReady: noop,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      await wait()
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      // The frozen band names the panel that owns the keyboard instead of
      // advertising message typing the composer cannot accept.
      expect(output).toContain('keys go to /model · esc closes')
      output = ''
      stdin.write('gpt')
      await wait()
      expect(output).toContain("2 of 4 match 'gpt'")
      expect(output).toContain('GPT-5.1')
      expect(output).toContain('GPT-5 mini')
      expect(output).not.toContain('DeepSeek Chat')
      // Mid-filter, q is query text: the panel stays open with no matches.
      stdin.write('q')
      await wait()
      expect(output).toContain("no models match 'gptq'")
      expect(output).toContain('/model — select model')
      stdin.write('\x7f')
      await wait()
      expect(output).toContain("2 of 4 match 'gpt'")
      // Enter applies the first filtered row and closes the panel.
      stdin.write('\r')
      await wait()
      expect(picked.map(row => row.model)).toEqual(['gpt-5.1'])
      expect(output.lastIndexOf('type a message')).toBeGreaterThan(output.lastIndexOf("match 'gpt'"))
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})

describe('panel query q-key guard', () => {
  it('treats q as query text while filtering in /mode and closes only on an empty query', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    let closed = false
    const instance = render(createElement(ModePanel, {
      current: 'standard',
      load: async () => [
        { id: 'standard', trust: 'user' as const, path: 'C:\\presets\\standard\\agent.yml', description: 'standard preset' },
        { id: 'quiet', trust: 'user' as const, path: 'C:\\presets\\quiet\\agent.yml', description: 'quiet preset' },
      ],
      select: () => {},
      close: () => {
        closed = true
      },
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      await wait()
      stdin.write('qu')
      await wait()
      expect(output).toContain('search: qu')
      expect(output).toContain('quiet preset')
      stdin.write('q')
      await wait()
      expect(closed).toBe(false)
      expect(output).toContain('search: quq')
      expect(output).toContain('no matching entries')
      // Backspace arrives per keystroke; clearing restores the full list.
      stdin.write('\x7f')
      await wait()
      stdin.write('\x7f')
      await wait()
      stdin.write('\x7f')
      await wait()
      expect(output.lastIndexOf('search: type to filter')).toBeGreaterThan(output.lastIndexOf('search: quq'))
      expect(output.lastIndexOf('standard preset')).toBeGreaterThan(output.lastIndexOf('search: quq'))
      stdin.write('q')
      await wait()
      expect(closed).toBe(true)
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})

describe('/model typing filter — late directory and compact copy', () => {
  it('positions on the filtered list when the directory resolves after typing started', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const noop = (): void => {}
    const picked: ModelRow[] = []
    const instance = render(createElement(App, appProps({
      store: createTranscriptStore(),
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: { subscribe: () => noop, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => noop,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => noop, setAgent: noop },
      skills: { rows: [], subscribe: () => noop, setAgent: noop },
      // The applied model sits at FULL-list index 1 but is NOT in the
      // 'gpt' filter: a late directory resolve must not park the cursor on
      // the full-row index (which lands on gpt-5-mini and would pick it).
      model: 'deepseek/deepseek-reasoner',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => {
        await new Promise(resolve => setTimeout(resolve, 400))
        return { rows: [
          { provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-chat', modelName: 'DeepSeek Chat' },
          { provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-reasoner', modelName: 'DeepSeek Reasoner' },
          { provider: 'openai', providerName: 'OpenAI', model: 'gpt-5.1', modelName: 'GPT-5.1' },
          { provider: 'openai', providerName: 'OpenAI', model: 'gpt-5-mini', modelName: 'GPT-5 mini' },
        ], failures: [] }
      },
      loadMentions: async () => [],
      selectModel: row => {
        picked.push(row)
        return `${row.provider}/${row.model}`
      },
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      loadUsage: async () => ({ turns: [] }),
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      onBridgeReady: noop,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      await wait()
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      // Type while the directory is still loading, then wait for the match.
      stdin.write('g')
      await wait()
      stdin.write('pt')
      await wait()
      for (let i = 0; i < 20 && !output.includes("2 of 4 match 'gpt'"); i += 1) await wait()
      expect(output).toContain("2 of 4 match 'gpt'")
      // Wait for the cursor row itself, not just the header: the filtered
      // list and its cursor commit in the same render, so anchoring on the
      // row keeps Enter from racing a half-applied directory.
      for (let i = 0; i < 20 && !output.includes('❯ OpenAI  GPT-5.1'); i += 1) await wait()
      expect(output).toContain('❯ OpenAI  GPT-5.1')
      stdin.write('\r')
      await wait()
      expect(picked.map(row => row.model)).toEqual(['gpt-5.1'])
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('keeps the compact one-liner honest while a filter is active', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 100,
      rows: 9,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const noop = (): void => {}
    const picked: ModelRow[] = []
    const instance = render(createElement(App, appProps({
      store: createTranscriptStore(),
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: { subscribe: () => noop, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => noop,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => noop, setAgent: noop },
      skills: { rows: [], subscribe: () => noop, setAgent: noop },
      model: 'deepseek/deepseek-chat',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [
        { provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-chat', modelName: 'DeepSeek Chat' },
        { provider: 'openai', providerName: 'OpenAI', model: 'gpt-5.1', modelName: 'GPT-5.1' },
      ], failures: [] }),
      loadMentions: async () => [],
      selectModel: row => {
        picked.push(row)
        return `${row.provider}/${row.model}`
      },
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      loadUsage: async () => ({ turns: [] }),
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      onBridgeReady: noop,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      await wait()
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      // The 9-row terminal degrades the panel to its compact one-liner.
      expect(output).not.toContain('select model')
      expect(output).toContain('❯ DeepSeek Chat')
      expect(output).toContain('type to filter')
      stdin.write('zzz')
      await wait()
      expect(output).toContain("no match for 'zzz'")
      expect(output).toContain('backspace edits')
      expect(output.lastIndexOf('backspace edits')).toBeGreaterThan(output.lastIndexOf('r retry'))
      // Enter on an empty match list is a no-op, never a blind pick.
      stdin.write('\r')
      await wait()
      expect(picked).toEqual([])
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})

/**
 * Every panel is mutually exclusive with the composer. These cases pin the
 * single panel-state list: a panel added to the app has to own the keys, name
 * itself in the frozen band, and get out of the way when a human approval
 * arrives — without those three drifting apart again.
 */
describe('panel keyboard ownership', () => {
  /** One TTY plus a mutable approval snapshot the test can drive. */
  function harness(overrides: Partial<AppProps> = {}) {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      },
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 100,
      rows: 30,
    }) as unknown as NodeJS.WriteStream
    const state = {
      output: '',
      approval: approvalSnapshot as ApprovalSnapshot,
      listeners: new Set<() => void>(),
    }
    stdout.on('data', chunk => {
      state.output += chunk.toString()
    })
    const instance = render(createElement(App, appProps({
      ...overrides,
      approval: {
        subscribe: (listener: () => void) => {
          state.listeners.add(listener)
          return () => state.listeners.delete(listener)
        },
        getSnapshot: () => state.approval,
      },
    })), { stdin, stdout, stderr: stdout, exitOnCtrlC: false, patchConsole: false })
    return {
      stdin,
      stdout,
      state,
      instance,
      setApproval(snapshot: ApprovalSnapshot): void {
        state.approval = snapshot
        state.listeners.forEach(listener => listener())
      },
    }
  }

  it('gives /search the keyboard: no composer write, no dispatch, no interrupt', async () => {
    const dispatched: string[] = []
    let interrupts = 0
    // A running turn makes the composer's Esc branch meaningful: without the
    // panel owning the keys it would abort the turn.
    const store = createTranscriptStore([
      { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } },
    ])
    const h = harness({
      store,
      dispatch: text => dispatched.push(text),
      interrupt: () => {
        interrupts += 1
        return true
      },
      searchSessions: async () => [],
    })
    try {
      await wait()
      h.stdin.write('/search')
      await wait()
      h.stdin.write('\r')
      await wait()
      h.state.output = ''
      h.stdin.write('login bug')
      await wait()
      expect(h.state.output).toContain('keys go to /search · esc closes')
      // The query belongs to the panel: the composer must stay untouched.
      expect(h.state.output).not.toContain('❯ login bug')
      h.stdin.write('\r')
      await wait()
      expect(dispatched).toEqual([])
      h.stdin.write('\x1b')
      await wait()
      expect(interrupts).toBe(0)
    } finally {
      h.instance.unmount()
      h.stdin.destroy()
      h.stdout.destroy()
    }
  })

  it('names /queue as the keyboard owner while it is open', async () => {
    const h = harness()
    try {
      await wait()
      h.stdin.write('/queue')
      await wait()
      h.stdin.write('\r')
      await wait()
      expect(h.state.output).toContain('keys go to /queue · esc closes')
    } finally {
      h.instance.unmount()
      h.stdin.destroy()
      h.stdout.destroy()
    }
  })

  it('closes an open panel for an approval and does not resurrect it', async () => {
    const h = harness({ loadJobs: () => [] })
    try {
      await wait()
      h.stdin.write('/jobs')
      await wait()
      h.stdin.write('\r')
      await wait()
      expect(h.state.output).toContain('/jobs · background tasks · 0')
      h.setApproval({
        pending: { headline: 'run a command', toolName: 'shell_command', command: 'ls', answer: noop },
        answered: false,
        queued: 0,
      })
      await wait()
      expect(h.state.output).toContain('keys go to the approval prompt · esc rejects')
      h.setApproval(approvalSnapshot)
      await wait()
      h.state.output = ''
      await wait()
      // Answering the approval must leave the composer in charge: the closed
      // /jobs panel may not come back on its own.
      expect(h.state.output).not.toContain('/jobs · background tasks')
      expect(h.state.output).not.toContain('keys go to /jobs')
    } finally {
      h.instance.unmount()
      h.stdin.destroy()
      h.stdout.destroy()
    }
  })

  it('closes any panel on Ctrl+C, the same way Esc does', async () => {
    const h = harness()
    try {
      await wait()
      h.stdin.write('/help')
      await wait()
      h.stdin.write('\r')
      await wait()
      expect(h.state.output).toContain('keys go to /help · esc closes')
      h.state.output = ''
      h.stdin.write('\x03')
      await wait()
      expect(h.state.output).not.toContain('keys go to /help')
    } finally {
      h.instance.unmount()
      h.stdin.destroy()
      h.stdout.destroy()
    }
  })
})
