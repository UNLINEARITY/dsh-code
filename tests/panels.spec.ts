/** Long exclusive-panel regression over real Ink TTY streams. */

import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app.ts'
import { createTranscriptStore } from '../src/store.ts'
import type { ApprovalSnapshot } from '../src/approval.ts'
import type { PendingQuestion, QuestionSnapshot } from '../src/questions.ts'

const wait = async (): Promise<void> => new Promise(resolve => setTimeout(resolve, 100))

describe('exclusive panel height budgets', () => {
  it('bounds long approval and plan-review content without clearing the terminal', async () => {
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
    const approvalListeners = new Set<() => void>()
    const questionListeners = new Set<() => void>()
    let approvalSnapshot: ApprovalSnapshot = { pending: undefined, answered: false }
    let questionSnapshot: QuestionSnapshot = { pending: undefined }
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
        cancel: noop,
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
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})
