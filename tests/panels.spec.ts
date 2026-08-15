/** Long exclusive-panel regression over real Ink TTY streams. */

import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../src/app.ts'
import { createTranscriptStore } from '../src/store.ts'
import { DEFAULT_STATUSLINE_ITEMS } from '../src/render/status.ts'
import type { ApprovalSnapshot } from '../src/approval.ts'
import type { PendingQuestion, QuestionSnapshot } from '../src/questions.ts'

const wait = async (): Promise<void> => new Promise(resolve => setTimeout(resolve, 100))

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
    let approvalSnapshot: ApprovalSnapshot = { pending: undefined, answered: false }
    let questionSnapshot: QuestionSnapshot = { pending: undefined }
    let questionCancelCount = 0
    const noop = (): void => {}
    const instance = render(createElement(App, {
      store: createTranscriptStore(),
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
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      cyclePermission: () => '',
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
      }
      approvalListeners.forEach(listener => listener())
      await wait()
      expect(output).toContain('waiting for approval')
      expect(output.lastIndexOf('type a message')).toBeLessThan(output.lastIndexOf('test/model'))
      expect(output).not.toContain('\x1b[2J')

      approvalSnapshot = { pending: undefined, answered: false }
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

      approvalSnapshot = { pending: undefined, answered: false }
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
    let approvalSnapshot: ApprovalSnapshot = { pending: undefined, answered: false }
    let questionSnapshot: QuestionSnapshot = { pending: undefined }
    const noop = (): void => {}
    const saved: readonly string[][] = []
    let currentItems: readonly string[] = DEFAULT_STATUSLINE_ITEMS
    const instance = render(createElement(App, {
      store: createTranscriptStore(),
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
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      cyclePermission: () => '',
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      statusline: currentItems,
      saveStatusline: items => {
        currentItems = items
        saved.push([...items])
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
      // status chrome, so the newline total may exceed the row count by the
      // second status row per frame; the single-frame height stays bounded.
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
