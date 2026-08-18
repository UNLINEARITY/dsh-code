/** Streaming burst regression: synchronous token drains must not trip React's nested-update guard. */

import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { App, type AppProps } from '../src/app.ts'
import { createTranscriptStore } from '../src/store.ts'
import { DEFAULT_STATUSLINE_ITEMS } from '../src/render/status.ts'

const wait = async (): Promise<void> => new Promise(resolve => setTimeout(resolve, 60))
const unsubscribe = (): void => {}
const noop = (): void => {}
const frozen = <T,>(value: T): T => Object.freeze(value)
/** Shared identity-stable empty subagent feed snapshot (getSnapshot contract). */
const EMPTY_AGENTS = frozen([])

function tty(columns: number, rows: number): { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream; read: () => string } {
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
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns, rows }) as unknown as NodeJS.WriteStream
  let output = ''
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  return { stdin, stdout, read: () => output }
}

describe('streaming token bursts', () => {
  it('renders one synchronous reasoning drain without nested-update warnings', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { stdin, stdout, read } = tty(140, 30)
    const store = createTranscriptStore()
    // uETS contract: getSnapshot must return a cached identity — a fresh
    // object per call manufactures the very infinite loop this suite guards
    // against, so the snapshots are module-stable constants.
    const approvalSnapshot = frozen({ pending: undefined, answered: false, queued: 0 })
    const questionSnapshot = frozen({ pending: undefined })

    const props: AppProps = {
      store,
      subagents: { subscribe: () => unsubscribe, getSnapshot: () => EMPTY_AGENTS },
      approval: { subscribe: () => unsubscribe, getSnapshot: () => approvalSnapshot },
      questions: { subscribe: () => unsubscribe, getSnapshot: () => questionSnapshot, submit: noop, cancel: noop },
      commands: { descriptors: [], subscribe: () => unsubscribe },
      skills: { rows: [], subscribe: () => unsubscribe },
      model: 'zai/glm-5.2',
      effort: '',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: 'ab12cd34',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'zai/glm-5.2',
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
    }

    const instance = render(createElement(App, props), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      store.apply({ type: 'request/context', seq: 1, time: 1, data: { provider: 'zai', model: 'glm-5.2', contextWindow: 128_000 } } as SessionEvent)
      store.apply({ type: 'turn/start', seq: 2, time: 2, data: { turn: 1 } } as SessionEvent)
      store.apply({ type: 'step/start', seq: 3, time: 3, data: { turn: 1, step: 1 } } as SessionEvent)
      store.apply({ type: 'user/message', seq: 4, time: 4, data: { content: [{ type: 'text', text: '1' }], source: { kind: 'user' } } } as unknown as SessionEvent)
      await wait()

      // One synchronous drain of 120 reasoning tokens — the shape the zai
      // adapter delivers when it flushes its token buffer (dt 0-2ms). The
      // store must coalesce this into a single re-render; per-event
      // notification cascades past React's 50-nested-passive-update guard.
      const beforeThinking = read()
      for (let index = 0; index < 120; index += 1) {
        store.apply({
          type: 'assistant/chunk', seq: 5 + index, time: 5 + (index % 3),
          data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: `t${index} ` } },
        } as unknown as SessionEvent)
      }
      await wait()
      // Starting the thinking tail must not trigger a source-backed screen clear.
      expect(read().slice(beforeThinking.length)).not.toContain('\x1b[2J')
      // A second drain still renders clean (the guard counts consecutive
      // cascades, so the regression must hold across bursts too).
      for (let index = 0; index < 120; index += 1) {
        store.apply({
          type: 'assistant/chunk', seq: 200 + index, time: 8 + (index % 3),
          data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: `a${index} ` } },
        } as unknown as SessionEvent)
      }
      await wait()

      const calls = errorSpy.mock.calls.flat().join(' ')
      expect(calls).not.toContain('Maximum update depth exceeded')
      expect(calls).not.toContain('should be cached')
      // The coalesced render still paints: reasoning collapses to the
      // Thinking… marker by default, the text burst shows its live tail.
      const plain = read().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      expect(plain).toContain('Thinking')
      expect(plain).toContain('a119')
    } finally {
      instance.unmount()
      errorSpy.mockRestore()
    }
  })
})
