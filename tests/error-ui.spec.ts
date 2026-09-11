/** Codex-inspired popup priority and recoverable error-state regressions. */

import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
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
    subagents: { subscribe: () => noop, getSnapshot: () => emptyAgents, getTotalSeen: () => 0 },
    approval: { subscribe: () => noop, getSnapshot: () => approvalSnapshot },
    questions: {
      subscribe: () => noop,
      getSnapshot: () => questionSnapshot,
      submit: noop,
      cancel: noop,
    },
    commands: { descriptors: [], subscribe: () => noop },
    probeUpdate: () => Promise.reject(new Error('update probe not wired in test')),
    applyUpdate: () => Promise.resolve(0),
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
    inspectImages: async () => [],
    prepareImages: async () => [],
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

  it('starts an upstream provider login from /model and returns to the model list', async () => {
    let begins = 0
    const authorization = {
      key: credentialKey('llm-pi-ai', 'deepseek-official'),
      provider: 'deepseek-official',
      label: 'DeepSeek',
      methods: [{ id: 'oauth', label: 'OAuth' }],
      inFlight: false,
      record: { configured: false, writable: true },
    } as const
    const app = renderApp({
      loadModels: async () => ({
        rows: [{ provider: 'deepseek-official', providerName: 'DeepSeek', model: 'flash', modelName: 'Flash' }],
        failures: [],
      }),
      loadModelProviders: async () => ({ rows: [provider()], writable: true, failures: [] }),
      saveModelProviderCredential: async () => {},
      saveModelProviderConfiguration: async () => {},
      loadProviderAuthorizations: async () => ({ rows: [authorization], failures: [] }),
      subscribeProviderAuthorizations: () => () => {},
      beginProviderAuthorization: async (_row, method) => {
        begins += 1
        expect(method).toBe('oauth')
        return 'authorized'
      },
      cancelProviderAuthorization: () => {},
      logoutProviderAuthorization: async () => {},
      openAuthorizationUrl: () => true,
      copyTextValue: async () => {},
    }, { columns: 100, rows: 24 })
    try {
      await wait()
      app.stdin.push('/model')
      await wait()
      app.stdin.push('\r')
      await wait()
      app.stdin.push('\t')
      await wait()
      expect(app.output()).toContain('not logged in')
      app.stdin.push('l')
      await wait()
      expect(app.output()).toContain('login DeepSeek')
      app.stdin.push('\r')
      await wait()
      expect(begins).toBe(1)
      expect(app.output()).toContain('logged in to DeepSeek; select a model')
      expect(app.output()).toContain('DeepSeek')
    } finally {
      app.unmount()
    }
  })

  it('configures key and models on one page and saves both together', async () => {
    let savedKey = ''
    let savedConfig: unknown
    const app = renderApp({
      loadModels: async () => ({
        rows: [{ provider: 'deepseek-official', providerName: 'DeepSeek', model: 'flash', modelName: 'Flash' }],
        failures: [],
      }),
      loadModelProviders: async () => ({ rows: [provider()], writable: true, failures: [] }),
      saveModelProviderCredential: async (_target, key) => { savedKey = key },
      saveModelProviderConfiguration: async (_target, configuration) => { savedConfig = configuration },
      unsetModelProviderCredential: async () => {},
      removeModelProvider: async () => {},
    }, { columns: 100, rows: 24 })
    try {
      await wait()
      app.stdin.push('/model')
      await wait()
      app.stdin.push('\r')
      await wait()
      app.stdin.push('\t')
      await wait()
      // Enter opens the unified setup page: key, endpoint, and models on one
      // screen (the old split hid configuration behind Tab).
      app.stdin.push('\r')
      await wait()
      expect(app.output()).toContain('/model — configure DeepSeek')
      expect(app.output()).toContain('key')
      expect(app.output()).toContain('url')
      expect(app.output()).toContain('official default')

      app.clearOutput()
      app.stdin.push('sk-super-secret')
      await wait()
      expect(app.output()).toContain('••••')
      expect(app.output()).not.toContain('sk-super-secret')

      app.stdin.push('\r')
      await wait()
      expect(savedKey).toBe('sk-super-secret')
      expect(savedConfig).toEqual({ models: [] })
      expect(app.output()).toContain('provider configuration saved: DeepSeek · API key updated')
      expect(app.output()).toContain('/model — providers')
    } finally {
      app.unmount()
    }
  })

  it('hand-adds a model id and edits its context/output windows on the setup page', async () => {
    let saved: unknown
    const app = renderApp({
      loadModels: async () => ({ rows: [], failures: [] }),
      loadModelProviders: async () => ({ rows: [provider()], writable: true, failures: [] }),
      saveModelProviderCredential: async () => {},
      saveModelProviderConfiguration: async (_target, configuration) => { saved = configuration },
      unsetModelProviderCredential: async () => {},
      removeModelProvider: async () => {},
    }, { columns: 100, rows: 24 })
    try {
      await wait()
      app.stdin.push('/model')
      await wait()
      app.stdin.push('\r')
      await wait()
      app.stdin.push('\t')
      await wait()
      app.stdin.push('\r')
      await wait()
      // key → url → models (the add-by-id row is the first row of an empty list).
      app.stdin.push('\x1b[B')
      await wait()
      app.stdin.push('\x1b[B')
      await wait()
      app.stdin.push('flash')
      await wait()
      app.stdin.push(' ')
      await wait()
      expect(app.output()).toContain('[x] flash')
      // Right cycles none → ctx → out; digits edit the active window.
      app.stdin.push('\x1b[C')
      await wait()
      app.stdin.push('128')
      await wait()
      app.stdin.push('\x1b[C')
      await wait()
      app.stdin.push('8192')
      await wait()
      app.stdin.push('\r')
      await wait()
      expect(saved).toEqual({ models: [{ id: 'flash', contextWindow: 128, maxTokens: 8192 }] })
    } finally {
      app.unmount()
    }
  })

  it('discovers real endpoint models, adopts a checked subset, and saves them', async () => {
    let saved: unknown
    const requests: Array<Record<string, unknown>> = []
    const app = renderApp({
      loadModels: async () => ({ rows: [], failures: [] }),
      loadModelProviders: async () => ({ rows: [provider({ configuration: { baseURL: 'https://gw.example/v1', models: [] } })], writable: true, failures: [] }),
      saveModelProviderCredential: async () => {},
      saveModelProviderConfiguration: async (_target, configuration) => { saved = configuration },
      discoverModelProvider: async (_target, request, signal) => {
        requests.push({ ...request, signal: signal !== undefined })
        return [
          { id: 'glm-5.4', name: 'GLM-5.4' },
          { id: 'glm-5.4-air' },
          { id: 'kimi-k4' },
        ]
      },
      unsetModelProviderCredential: async () => {},
      removeModelProvider: async () => {},
    }, { columns: 100, rows: 24 })
    try {
      await wait()
      app.stdin.push('/model')
      await wait()
      app.stdin.push('\r')
      await wait()
      app.stdin.push('\t')
      await wait()
      app.stdin.push('\r')
      await wait()
      // Tab enters the discovery stage; it interrogates immediately with the
      // page's endpoint draft and a cancellation channel.
      app.stdin.push('\t')
      await wait()
      expect(app.output()).toContain('/model — discover DeepSeek')
      expect(requests).toEqual([{ baseURL: 'https://gw.example/v1', signal: true }])
      expect(app.output()).toContain('3 advertised · 3 new · 0 checked')

      // Selective adoption: check two of the three, adopt, leave the third.
      app.stdin.push(' ')
      await wait()
      app.stdin.push('\x1b[B')
      await wait()
      app.stdin.push(' ')
      await wait()
      expect(app.output()).toContain('2 checked')
      app.stdin.push('\r')
      await wait()
      expect(app.output()).toContain('[x] glm-5.4')
      expect(app.output()).toContain('[x] glm-5.4-air')
      expect(app.output()).not.toContain('[x] kimi-k4')

      app.stdin.push('\r')
      await wait()
      expect(saved).toEqual({
        baseURL: 'https://gw.example/v1',
        models: [
          { id: 'glm-5.4', name: 'GLM-5.4' },
          { id: 'glm-5.4-air' },
        ],
      })
    } finally {
      app.unmount()
    }
  })

  it('saves a typed key for a dormant route whose credential facts are absent', async () => {
    let savedKey = ''
    let savedConfig: unknown
    const app = renderApp({
      loadModels: async () => ({ rows: [], failures: [] }),
      loadModelProviders: async () => ({
        rows: [provider({ credentialRef: undefined, credential: undefined, configured: false })],
        writable: true,
        failures: [],
      }),
      saveModelProviderCredential: async (_target, key) => { savedKey = key },
      saveModelProviderConfiguration: async (_target, configuration) => { savedConfig = configuration },
      unsetModelProviderCredential: async () => {},
      removeModelProvider: async () => {},
    }, { columns: 100, rows: 24 })
    try {
      await wait()
      app.stdin.push('/model')
      await wait()
      app.stdin.push('\r')
      await wait()
      app.stdin.push('\t')
      await wait()
      app.stdin.push('\r')
      await wait()
      app.stdin.push('sk-for-dormant-route')
      await wait()
      app.stdin.push('\r')
      await wait()
      // The key rides the same Enter as the configuration — never dropped.
      expect(savedKey).toBe('sk-for-dormant-route')
      expect(savedConfig).toEqual({ models: [] })
      expect(app.output()).toContain('API key updated')
    } finally {
      app.unmount()
    }
  })

  it('refuses the whole save when a typed key cannot be written, instead of dropping it silently', async () => {
    let configs = 0
    let keys = 0
    const app = renderApp({
      loadModels: async () => ({ rows: [], failures: [] }),
      loadModelProviders: async () => ({
        rows: [provider({ credential: { kind: 'facts', configured: true, source: 'env', writable: false } })],
        writable: true,
        failures: [],
      }),
      saveModelProviderCredential: async () => { keys += 1 },
      saveModelProviderConfiguration: async () => { configs += 1 },
      unsetModelProviderCredential: async () => {},
      removeModelProvider: async () => {},
    }, { columns: 100, rows: 24 })
    try {
      await wait()
      app.stdin.push('/model')
      await wait()
      app.stdin.push('\r')
      await wait()
      app.stdin.push('\t')
      await wait()
      app.stdin.push('\r')
      await wait()
      app.stdin.push('sk-readonly-env')
      await wait()
      app.stdin.push('\r')
      await wait()
      expect(app.output()).toContain('cannot be written here')
      expect(keys).toBe(0)
      expect(configs).toBe(0)
      expect(app.output()).toContain('/model — configure DeepSeek')
    } finally {
      app.unmount()
    }
  })

  it('edits a model efforts declaration inline and saves it through extras', async () => {
    let saved: unknown
    const app = renderApp({
      loadModels: async () => ({ rows: [], failures: [] }),
      loadModelProviders: async () => ({
        rows: [provider({ configuration: { models: [{ id: 'glm-5.3' }] } })],
        writable: true,
        failures: [],
      }),
      saveModelProviderCredential: async () => {},
      saveModelProviderConfiguration: async (_target, configuration) => { saved = configuration },
      unsetModelProviderCredential: async () => {},
      removeModelProvider: async () => {},
    }, { columns: 120, rows: 24 })
    try {
      await wait()
      app.stdin.push('/model')
      await wait()
      app.stdin.push('\r')
      await wait()
      app.stdin.push('\t')
      await wait()
      app.stdin.push('\r')
      await wait()
      app.stdin.push('\x1b[B')
      await wait()
      app.stdin.push('\x1b[B')
      await wait()
      // 'e' opens the micro-editor seeded from the (absent) declaration.
      app.stdin.push('e')
      await wait()
      app.stdin.push('low:low high:high max:max')
      await wait()
      app.stdin.push('\r')
      await wait()
      expect(app.output()).toContain('eff:3')
      app.stdin.push('\r')
      await wait()
      expect(saved).toEqual({
        models: [{ id: 'glm-5.3', extras: { reasoningEfforts: { low: 'low', high: 'high', max: 'max' } } }],
      })
    } finally {
      app.unmount()
    }
  })

  it('copies a donor declaration verbatim with c and rejects invalid drafts', async () => {
    let saved: unknown
    const donorProvider = provider({
      provider: 'zai',
      displayName: 'ZAI',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'zai'],
      configuration: {
        models: [{
          id: 'glm-5.3',
          extras: { reasoningEfforts: { low: 'low', high: 'high', max: 'max' } },
        }],
      },
    })
    const targetProvider = provider({
      configuration: { models: [{ id: 'gpt-6' }] },
    })
    const app = renderApp({
      loadModels: async () => ({ rows: [], failures: [] }),
      loadModelProviders: async () => ({ rows: [donorProvider, targetProvider], writable: true, failures: [] }),
      saveModelProviderCredential: async () => {},
      saveModelProviderConfiguration: async (_target, configuration) => { saved = configuration },
      unsetModelProviderCredential: async () => {},
      removeModelProvider: async () => {},
    }, { columns: 120, rows: 24 })
    try {
      await wait()
      app.stdin.push('/model')
      await wait()
      app.stdin.push('\r')
      await wait()
      app.stdin.push('\t')
      await wait()
      // Cursor on the second provider (the gateway target with gpt-6).
      app.stdin.push('\x1b[B')
      await wait()
      app.stdin.push('\r')
      await wait()
      app.stdin.push('\x1b[B')
      await wait()
      app.stdin.push('\x1b[B')
      await wait()
      expect(app.output()).toContain('gpt-6')
      // 'c' opens the donor picker; the zai declaration is listed verbatim.
      app.stdin.push('c')
      await wait()
      expect(app.output()).toContain('/model — copy efforts')
      expect(app.output()).toContain('zai/glm-5.3')
      app.stdin.push('\r')
      await wait()
      expect(app.output()).toContain('eff:3')
      // An invalid draft (unknown level) refuses to commit with one line.
      app.stdin.push('e')
      await wait()
      app.stdin.push('\x15')
      await wait()
      app.stdin.push('turbo:max')
      await wait()
      app.stdin.push('\r')
      await wait()
      expect(app.output()).toContain('is not a level')
      app.stdin.push('\x1b')
      await wait()
      app.stdin.push('\r')
      await wait()
      expect(saved).toEqual({
        models: [{ id: 'gpt-6', extras: { reasoningEfforts: { low: 'low', high: 'high', max: 'max' } } }],
      })
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
      saveModelProviderConfiguration: async () => {},
      unsetModelProviderCredential: async () => {},
      removeModelProvider: async () => {},
    }, { columns: 64, rows: 14 })
    try {
      await wait()
      app.stdin.push('/model')
      await wait()
      app.stdin.push('\r')
      await wait()
      app.stdin.push('\t')
      await wait()
      app.stdin.push('\r')
      await wait()
      // A 14-row terminal cannot fit the three fixed rows; the page degrades
      // to one bounded line instead of overflowing the terminal.
      expect(app.output()).toContain('provider setup · terminal too small · esc back')

      // On a roomy terminal the failure stays inside the panel.
      app.unmount()
    } finally {
      app.unmount()
    }
    const roomy = renderApp({
      loadModels: async () => ({ rows: [], failures: [] }),
      loadModelProviders: async () => ({ rows: [row], writable: true, failures: [] }),
      saveModelProviderCredential: async () => { throw new Error('credential store unavailable') },
      saveModelProviderConfiguration: async () => {},
      unsetModelProviderCredential: async () => {},
      removeModelProvider: async () => {},
    }, { columns: 64, rows: 24 })
    try {
      await wait()
      roomy.stdin.push('/model')
      await wait()
      roomy.stdin.push('\r')
      await wait()
      roomy.stdin.push('\t')
      await wait()
      roomy.stdin.push('\r')
      await wait()
      roomy.stdin.push('sk-short-terminal-secret')
      await wait()
      expect(roomy.output()).toContain('••••')
      expect(roomy.output()).not.toContain('sk-short-terminal-secret')
      roomy.stdin.push('\r')
      await wait()
      expect(roomy.output()).toContain('credential store unavailable')
      expect(roomy.output()).not.toContain('\x1b[3J')
    } finally {
      roomy.unmount()
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
      saveModelProviderConfiguration: async () => {},
      unsetModelProviderCredential: async () => { unsets += 1 },
      removeModelProvider: async () => { removals += 1 },
    })
    try {
      await wait()
      app.stdin.push('/model')
      await wait()
      app.stdin.push('\r')
      await wait()
      app.stdin.push('\t')
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
