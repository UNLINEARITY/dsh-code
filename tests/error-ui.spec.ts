/** Codex-inspired popup priority and recoverable error-state regressions. */

import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { App, type AppProps } from '../src/app.ts'
import { createTranscriptStore } from '../src/store.ts'
import { DEFAULT_STATUSLINE_ITEMS } from '../src/render/status.ts'
import type { ProviderTargetView } from '../src/provider-settings.ts'

const wait = async (): Promise<void> => new Promise(resolve => setTimeout(resolve, 100))

function renderApp(
  overrides: Partial<AppProps> = {},
  terminal: { columns?: number; rows?: number } = {},
): {
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
    columns: terminal.columns ?? 64,
    rows: terminal.rows ?? 20,
  }) as unknown as NodeJS.WriteStream
  let captured = ''
  stdout.on('data', chunk => {
    captured += chunk.toString()
  })
  const noop = (): void => {}
  const store = createTranscriptStore()
  const approvalSnapshot = Object.freeze({ pending: undefined, answered: false, queued: 0 })
  const questionSnapshot = Object.freeze({ pending: undefined })
  const emptyAgents = Object.freeze([])
  const props: AppProps = {
    store,
    subagents: { subscribe: () => noop, getSnapshot: () => emptyAgents },
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
    loadJobs: () => [],
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

describe('/model provider credentials', () => {
  const provider = (overrides: Partial<ProviderTargetView> = {}): ProviderTargetView => ({
    provider: 'deepseek-official',
    displayName: 'DeepSeek',
    active: true,
    settingsNs: 'llm-deepseek',
    settingsPath: [],
    settingsRevision: 1,
    configured: true,
    removable: false,
    credentialRef: 'DEEPSEEK_API_KEY',
    suggestedRef: 'DEEPSEEK_OFFICIAL_API_KEY',
    credential: { kind: 'facts', configured: false, writable: true },
    configuration: { models: [] },
    ...overrides,
  })

  it('opens from the model list, masks the key, saves it, and returns to model selection', async () => {
    let saved = ''
    let current = provider()
    let invalidate: (() => void) | undefined
    let unsubscribed = false
    const app = renderApp({
      loadModels: async () => ({
        rows: [{ provider: 'deepseek-official', providerName: 'DeepSeek', model: 'flash', modelName: 'Flash' }],
        failures: [],
      }),
      loadModelProviders: async () => ({ rows: [current], writable: true, failures: [] }),
      subscribeModelProviders: listener => {
        invalidate = listener
        return () => { unsubscribed = true; invalidate = undefined }
      },
      saveModelProviderCredential: async (_target, key) => { saved = key },
      unsetModelProviderCredential: async () => {},
      removeModelProvider: async () => {},
    })
    try {
      await wait()
      app.stdin.push('/model')
      await wait()
      app.stdin.push('\r')
      await wait()
      expect(app.output()).toContain('a providers')

      app.clearOutput()
      app.stdin.push('a')
      await wait()
      expect(app.output()).toContain('/model — providers')
      expect(app.output()).toContain('key missing')

      current = provider({ credential: { kind: 'facts', configured: true, source: 'file', writable: true } })
      invalidate?.()
      await wait()
      expect(app.output()).toContain('key file')

      app.clearOutput()
      app.stdin.push('\r')
      await wait()
      expect(app.output()).toContain('/model — add API key')
      app.clearOutput()
      app.stdin.push('sk-super-secret')
      await wait()
      expect(app.output()).toContain('••••')
      expect(app.output()).not.toContain('sk-super-secret')

      app.stdin.push('\r')
      await wait()
      expect(saved).toBe('sk-super-secret')
      expect(app.output()).toContain('API key saved for DeepSeek; select a model')
      expect(app.output()).toContain('DeepSeek · Flash')
    } finally {
      app.unmount()
    }
    await wait()
    expect(unsubscribed).toBe(true)
  })

  it('edits an explicit provider model allow-list and its token windows from the provider panel', async () => {
    let saved: unknown
    const app = renderApp({
      loadModels: async () => ({
        rows: [{ provider: 'deepseek-official', providerName: 'DeepSeek', model: 'flash', modelName: 'Flash' }],
        failures: [],
      }),
      loadModelProviders: async () => ({ rows: [provider()], writable: true, failures: [] }),
      saveModelProviderCredential: async () => {},
      saveModelProviderConfiguration: async (_target, configuration) => { saved = configuration },
      unsetModelProviderCredential: async () => {},
      removeModelProvider: async () => {},
    })
    try {
      await wait()
      app.stdin.push('/model')
      await wait()
      app.stdin.push('\r')
      await wait()
      app.stdin.push('a')
      await wait()
      app.stdin.push('\t')
      await wait()
      expect(app.output()).toContain('DeepSeek configuration')
      app.stdin.push('\t')
      await wait()
      app.stdin.push(' ')
      await wait()
      app.stdin.push('\t')
      await wait()
      app.stdin.push('1')
      await wait()
      app.stdin.push('2')
      await wait()
      app.stdin.push('8')
      await wait()
      app.stdin.push('0')
      await wait()
      app.stdin.push('0')
      await wait()
      app.stdin.push('\t')
      await wait()
      app.stdin.push('8')
      await wait()
      app.stdin.push('1')
      await wait()
      app.stdin.push('9')
      await wait()
      app.stdin.push('2')
      await wait()
      app.stdin.push('\r')
      await wait()
      expect(saved).toEqual({ models: [{ id: 'flash', name: 'Flash', contextWindow: 12800, maxTokens: 8192 }] })
    } finally {
      app.unmount()
    }
  })

  it('keeps masked input and save failures inside the five-row panel budget', async () => {
    const row = provider()
    const app = renderApp({
      loadModels: async () => ({ rows: [], failures: [] }),
      loadModelProviders: async () => ({ rows: [row], writable: true, failures: [] }),
      saveModelProviderCredential: async () => { throw new Error('credential store unavailable') },
      unsetModelProviderCredential: async () => {},
      removeModelProvider: async () => {},
    }, { columns: 64, rows: 14 })
    try {
      await wait()
      app.stdin.push('/model')
      await wait()
      app.stdin.push('\r')
      await wait()
      app.stdin.push('a')
      await wait()
      app.stdin.push('\r')
      await wait()
      expect(app.output()).toContain('/model — add API key')

      app.clearOutput()
      app.stdin.push('sk-short-terminal-secret')
      await wait()
      expect(app.output()).toContain('••••')
      expect(app.output()).not.toContain('sk-short-terminal-secret')
      app.stdin.push('\r')
      await wait()
      expect(app.output()).toContain('credential store unavailable')
      expect(app.output()).not.toContain('\x1b[3J')
    } finally {
      app.unmount()
    }
  })

  it('confirms key and custom-provider removals while refusing environment-owned keys', async () => {
    let unsets = 0
    let removals = 0
    let current = provider({
      credential: { kind: 'facts', configured: true, source: 'file', writable: true },
      removable: true,
    })
    const app = renderApp({
      loadModels: async () => ({ rows: [], failures: [] }),
      loadModelProviders: async () => ({ rows: [current], writable: true, failures: [] }),
      saveModelProviderCredential: async () => {},
      unsetModelProviderCredential: async () => { unsets += 1 },
      removeModelProvider: async () => { removals += 1 },
    })
    try {
      await wait()
      app.stdin.push('/model')
      await wait()
      app.stdin.push('\r')
      await wait()
      app.stdin.push('a')
      await wait()

      app.clearOutput()
      app.stdin.push('d')
      await wait()
      expect(app.output()).toContain('/model — remove API key')
      app.stdin.push('y')
      await wait()
      expect(unsets).toBe(1)
      expect(app.output()).toContain('API key removed for DeepSeek')

      app.clearOutput()
      app.stdin.push('x')
      await wait()
      expect(app.output()).toContain('/model — remove provider')
      app.stdin.push('y')
      await wait()
      expect(removals).toBe(1)

      current = provider({ credential: { kind: 'facts', configured: true, source: 'env', writable: false } })
      app.stdin.push('r')
      await wait()
      app.clearOutput()
      app.stdin.push('d')
      await wait()
      expect(app.output()).toContain('supplied read-only by the environment')
      expect(unsets).toBe(1)
    } finally {
      app.unmount()
    }
  })
})
