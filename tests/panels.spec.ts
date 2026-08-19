/** Long exclusive-panel regression over real Ink TTY streams. */

import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../src/app.ts'
import { editQuery, HistoryPanel, ModePanel, PermissionPanel, ResumePanel } from '../src/kernel-panels.ts'
import { createTranscriptStore } from '../src/store.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DEFAULT_STATUSLINE_ITEMS } from '../src/render/status.ts'
import type { ModelRow } from '../src/models.ts'
import type { ApprovalSnapshot } from '../src/approval.ts'
import type { PendingQuestion, QuestionSnapshot } from '../src/questions.ts'

const wait = async (): Promise<void> => new Promise(resolve => setTimeout(resolve, 100))

// useSyncExternalStore compares getSnapshot results by identity: these
// doubles must return one frozen object forever, or React spins into an
// infinite re-render loop (Maximum update depth exceeded).
const approvalSnapshot = Object.freeze({ pending: undefined, answered: false, queued: 0 })
/** Shared identity-stable empty subagent feed snapshot (getSnapshot contract). */
const EMPTY_AGENTS = Object.freeze([])
const questionSnapshot = Object.freeze({ pending: undefined })

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
    const instance = render(createElement(App, {
      store: createTranscriptStore(),
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS },
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
      commands: { descriptors: [], subscribe: () => noop },
      skills: { rows: [], subscribe: () => noop },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cyclePermission: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => Array.from({ length: 40 }, (_, index) => ({ id: `mode-${index}`, trust: 'user' as const, description: `preset ${index}` })),
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => Array.from({ length: 80 }, (_, index) => ({
        id: `session-${index}`, createdAt: index, cwd: 'C:\\repo', workspace: 'repo', subagent: false,
        resumable: true, live: false, persisted: true, preset: 'standard', title: `Conversation ${index}`,
      })),
      loadSessionTranscript: async id => `# ${id}\n${Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n')}`,
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => Array.from({ length: 100 }, (_, index) => ({
        entryId: `plugin-${index}`, moduleName: `@test/plugin-${index}`, enabled: true, phase: 'active' as const,
      })),
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      cancelQueued: noop,
      onBridgeReady: noop,
    }), {
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
      expect(output.lastIndexOf('type a message')).toBeLessThan(output.lastIndexOf('test/model'))
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
      expect(output.lastIndexOf('type a message')).toBeLessThan(output.lastIndexOf('test/model'))
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
      expect(output.lastIndexOf('type a message')).toBeLessThan(output.lastIndexOf('test/model'))
      expect(output).not.toContain('\x1b[2J')
      stdin.write('q')
      await wait()

      output = ''
      stdin.write('/mode')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('current standard')
      expect(output.lastIndexOf('type a message')).toBeLessThan(output.lastIndexOf('test/model'))
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
      expect(output.lastIndexOf('type a message')).toBeLessThan(output.lastIndexOf('test/model'))
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
    let approvalSnapshot: ApprovalSnapshot = { pending: undefined, answered: false, queued: 0 }
    let questionSnapshot: QuestionSnapshot = { pending: undefined }
    const noop = (): void => {}
    const saved: readonly string[][] = []
    let currentItems: readonly string[] = DEFAULT_STATUSLINE_ITEMS
    const instance = render(createElement(App, {
      store: createTranscriptStore(),
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS },
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
      commands: { descriptors: [], subscribe: () => noop },
      skills: { rows: [], subscribe: () => noop },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\repo\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cyclePermission: () => '',
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
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      statusline: currentItems,
      saveStatusline: items => {
        currentItems = items
        saved.push([...items])
      },
      history: [],
      recordHistory: noop,
      cancelQueued: noop,
      onBridgeReady: noop,
    }), {
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
      expect(output.lastIndexOf('type a message')).toBeLessThan(output.lastIndexOf('test/model'))
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
    const cancelled: string[] = []
    const instance = render(createElement(App, {
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS },
      store: createTranscriptStore([
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
          data: { target: 'next-turn', start: 0, inserted: [queued] },
        } as never,
      ]),
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
      commands: { descriptors: [], subscribe: () => noop },
      skills: { rows: [], subscribe: () => noop },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\repo\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cyclePermission: () => '',
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
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      cancelQueued: messageId => {
        cancelled.push(messageId)
      },
      onBridgeReady: noop,
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // Codex PendingSteer: queued prompts render as ordinary user rows.
      expect(output).toContain('❯ fix the build')
      expect(output).toContain('❯ then run tests')

      // Delete on the empty composer cancels the NEWEST queued row.
      output = ''
      stdin.write('\x1b[3~')
      await wait()
      expect(cancelled).toEqual([queued.id])

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
    const instance = render(createElement(App, {
      store: createTranscriptStore(),
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS },
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
      commands: { descriptors: [], subscribe: () => noop },
      skills: { rows: [], subscribe: () => noop },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\repo\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cyclePermission: () => '',
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
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: ['fix the login bug', 'bump the package version'],
      recordHistory: text => {
        recorded.push(text)
      },
      cancelQueued: noop,
      onBridgeReady: noop,
    }), {
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
      expect(output).toContain('/history · 3 prompts · type to filter')

      // Filter to one match and accept it: the composer fills and the panel closes.
      stdin.write('package')
      await wait()
      expect(output).toContain('1 of 3 match')
      output = ''
      stdin.write('\r')
      await wait()
      expect(output).toContain('bump the package version')
      expect(output).not.toContain('1 of 3 match')

      // Up from the filled match recalls the older entry (boundary gate).
      output = ''
      stdin.write('\x1b[A')
      await wait()
      expect(output).toContain('fix the login bug')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('shows the web StateDot chase in the composer and the Deep-diving line while busy', async () => {
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
    const instance = render(createElement(App, {
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS },
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
      commands: { descriptors: [], subscribe: () => noop },
      skills: { rows: [], subscribe: () => noop },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\repo\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cyclePermission: () => '',
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
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      cancelQueued: noop,
      onBridgeReady: noop,
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      expect(output).toContain('Deep diving')
      // The busy composer replaces '❯ ' with the rotating chase.
      const frames = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']
      expect(frames.some(frame => output.includes(frame))).toBe(true)
      expect(output).not.toContain('❯ type a message')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
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
    const instance = render(createElement(App, {
      store: createTranscriptStore(),
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS },
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
      commands: { descriptors: [], subscribe: () => noop },
      skills: { rows: [], subscribe: () => noop },
      model: 'acme/plain',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows, failures: [] }),
      loadMentions: async () => [],
      selectModel: (row: ModelRow, effortId?: string) => {
        picked.push({ row, effortId })
        return `${row.provider}/${row.model}`
      },
      cyclePermission: () => '',
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
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      cancelQueued: noop,
      onBridgeReady: noop,
    }), {
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
      stdin.write('g')
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
      // opens on acme/plain again: jump to the top, then the effort stage
      // opens ON the effective level (high) and one down reaches max.
      output = ''
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('g')
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
    const instance = render(createElement(App, {
      store: createTranscriptStore(),
      subagents: { subscribe: () => () => {}, getSnapshot: () => EMPTY_AGENTS },
      approval: { subscribe: () => noop, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => noop,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => noop },
      skills: { rows: [], subscribe: () => noop },
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
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows, failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'deepseek/deepseek-v4',
      cyclePermission: () => '',
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
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      cancelQueued: noop,
      onBridgeReady: noop,
    }), {
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
      remove: async () => '',
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
