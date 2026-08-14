/** App-level Ctrl+O rendering regression over real Node streams. */

import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it } from 'vitest'
import { createToolResultMessage, type CallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { App } from '../src/app.ts'
import { createTranscriptStore } from '../src/store.ts'

const wait = async (): Promise<void> => new Promise(resolve => setTimeout(resolve, 100))

describe('Ctrl+O history details', () => {
  it('uses an exclusive bounded screen without clearing scrollback and preserves the draft', async () => {
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
    const unsubscribe = (): void => {}
    const approvalSnapshot = Object.freeze({ pending: undefined, answered: false })
    const questionSnapshot = Object.freeze({ pending: undefined })
    const noop = (): void => {}
    let dispatched: string | undefined
    const store = createTranscriptStore()
    const instance = render(createElement(App, {
      store,
      approval: { subscribe: () => unsubscribe, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => unsubscribe },
      skills: { rows: [], subscribe: () => unsubscribe },
      model: 'test/model',
      cwd: 'dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      dispatch: (text: string) => {
        dispatched = text
      },
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ providers: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      cyclePermission: () => '',
      exportTranscript: async () => {},
      renameTitle: () => '',
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
      stdin.write('draft')
      await wait()
      expect(output).toContain('draft')
      output = ''
      stdin.write('\x0f')
      await wait()
      expect(output).toContain('history details')
      expect(output).toContain('test/model')
      expect(output).toContain('draft')
      expect(output).not.toContain('\x1b[2J')
      expect(output.split('\n').length).toBeLessThanOrEqual(10)

      output = ''
      stdin.write('\x0f')
      await wait()
      expect(output).not.toContain('\x1b[2J')
      stdin.write('\r')
      await wait()
      expect(dispatched).toBe('draft')

      store.apply({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } as SessionEvent)
      output = ''
      store.apply({
        type: 'assistant/chunk',
        seq: 2,
        time: 2,
        data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking\n'.repeat(1_000) } },
      } as SessionEvent)
      await wait()
      expect(output).not.toContain('\x1b[2J')
      expect(output.split('\n').length).toBeLessThan(stdout.rows)

      const callId = 'long-tool' as CallId
      store.apply({
        type: 'tool/call',
        seq: 3,
        time: 3,
        data: { turn: 1, step: 1, callId, name: 'shell_command', arguments: '{}' },
      } as SessionEvent)
      store.apply({
        type: 'tool/result',
        seq: 4,
        time: 4,
        data: {
          turn: 1,
          step: 1,
          message: createToolResultMessage({
            callId,
            content: [{ type: 'text', text: 'tool output\n'.repeat(1_000) }],
            isError: false,
          }),
        },
      } as SessionEvent)
      await wait()
      output = ''
      stdin.write('\x0f')
      await wait()
      expect(output).toContain('history details')
      expect(output).not.toContain('\x1b[2J')
      expect(output.split('\n').length).toBeLessThanOrEqual(stdout.rows)
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})
