/** Codex-inspired popup priority and recoverable error-state regressions. */

import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { App, type AppProps } from '../src/app.ts'
import { createTranscriptStore } from '../src/store.ts'
import { DEFAULT_STATUSLINE_ITEMS } from '../src/render/status.ts'

const wait = async (): Promise<void> => new Promise(resolve => setTimeout(resolve, 100))

function renderApp(overrides: Partial<AppProps> = {}): {
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  output(): string
  clearOutput(): void
  unmount(): void
  store: ReturnType<typeof createTranscriptStore>
} {
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
    columns: 64,
    rows: 20,
  }) as unknown as NodeJS.WriteStream
  let captured = ''
  stdout.on('data', chunk => {
    captured += chunk.toString()
  })
  const noop = (): void => {}
  const store = createTranscriptStore()
  const approvalSnapshot = Object.freeze({ pending: undefined, answered: false })
  const questionSnapshot = Object.freeze({ pending: undefined })
  const props: AppProps = {
    store,
    approval: { subscribe: () => noop, getSnapshot: () => approvalSnapshot },
    questions: {
      subscribe: () => noop,
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
    loadPresets: async () => [],
    switchMode: async id => id,
    createSession: noop,
    loadSessions: async () => [],
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
    ...overrides,
  }
  const instance = render(createElement(App, props), {
    stdin,
    stdout,
    stderr: stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  return {
    stdin,
    stdout,
    output: () => captured,
    clearOutput: () => { captured = '' },
    unmount: () => {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    },
    store,
  }
}

describe('popup input priority', () => {
  it('keeps slash completion available while busy and lets Esc dismiss it before interrupting', async () => {
    let interrupts = 0
    const app = renderApp({
      commands: {
        descriptors: [{ name: 'hello', description: 'test command' }],
        subscribe: () => () => {},
      },
      interrupt: () => {
        interrupts += 1
        return true
      },
    })
    try {
      app.store.apply({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } as SessionEvent)
      await wait()
      app.clearOutput()
      app.stdin.push('/he')
      await wait()
      expect(app.output()).toContain('test command')

      // TUI-local commands stay completable: /stat must surface the
      // statusline picker, not an empty menu.
      app.clearOutput()
      app.stdin.push('\x15')
      await wait()
      app.stdin.push('/stat')
      await wait()
      expect(app.output()).toContain('/statusline')
      expect(app.output()).toContain('customize the status line')
      // Restore the /he draft so the esc-menu-interrupt ladder below still
      // walks the same states.
      app.clearOutput()
      app.stdin.push('\x15')
      await wait()
      app.stdin.push('/he')
      await wait()

      app.stdin.push('\x1b')
      await wait()
      expect(interrupts).toBe(0)

      app.stdin.push('l')
      await wait()
      app.stdin.push('\x1b')
      await wait()
      expect(interrupts).toBe(0)

      app.stdin.push('\x1b')
      await wait()
      expect(interrupts).toBe(1)
    } finally {
      app.unmount()
    }
  })
})

describe('/model error recovery', () => {
  it('contains synchronous failures, retries in place, and keeps selection errors visible', async () => {
    let loads = 0
    const app = renderApp({
      loadModels: () => {
        loads += 1
        if (loads === 1) throw new Error('catalog\nunavailable')
        return Promise.resolve({
          rows: [{ provider: 'ok', providerName: 'Provider', model: 'one', modelName: 'Model One' }],
          failures: ['broken'],
        })
      },
      selectModel: () => {
        throw new Error('route offline\nretry later')
      },
    })
    try {
      await wait()
      app.stdin.push('/model')
      await wait()
      app.stdin.push('\r')
      await wait()
      expect(app.output()).toContain('catalog ↵ unavailable')

      app.clearOutput()
      app.stdin.push('r')
      await wait()
      expect(loads).toBe(2)
      expect(app.output()).toContain('unavailable providers: broken')
      expect(app.output()).toContain('Model One')

      app.clearOutput()
      app.stdin.push('\r')
      await wait()
      expect(app.output()).toContain('model switch failed: route offline ↵ retry later')
      expect(app.output()).toContain('/model')
      expect(app.output()).toContain('test/model')
    } finally {
      app.unmount()
    }
  })
})
