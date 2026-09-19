/**
 * Provider setup page mode layer: subscription vs key channel selection for
 * providers with a web sign-in, the Tab fork between them, Enter on the
 * subscription row, and the list panel's l/o removal.
 */
import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import { credentialKey, type CredentialKey } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationInteraction, AuthorizationStatus } from '@deepseek-ai/dsh-authorization'
import { ProviderAuthorizationPanel } from '../src/panels/authorization-panel.ts'
import { ProviderPanel, ProviderSetupPanel } from '../src/panels/model-panels.ts'
import type { ProviderAuthorizationDirectory, ProviderAuthorizationRow } from '../src/authorization.ts'
import type { DiscoveredModelView } from '../src/provider-settings.ts'
import type { ProviderCredentialView, ProviderSettingsDirectory, ProviderTargetView } from '../src/provider-settings.ts'

const wait = async (ms = 100): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function fakeStreams(columns = 100, rows = 30): {
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  read: () => string
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
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns, rows }) as unknown as NodeJS.WriteStream
  let text = ''
  stdout.on('data', chunk => {
    text += chunk.toString()
  })
  return { stdin, stdout, read: () => text }
}

function target(provider: string, overrides: Partial<ProviderTargetView> = {}): ProviderTargetView {
  return {
    provider,
    displayName: provider,
    active: true,
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', provider],
    settingsRevision: 1,
    configured: false,
    removable: false,
    suggestedRef: `${provider.toUpperCase()}_API_KEY`,
    credential: undefined,
    configuration: { models: [] },
    ...overrides,
  }
}

function loginRow(provider: string, overrides: Partial<ProviderAuthorizationRow> = {}): ProviderAuthorizationRow {
  const key: CredentialKey = credentialKey('llm-pi-ai', provider)
  return {
    key,
    provider,
    label: provider,
    methods: [{ id: 'oauth', label: 'plan sign-in' }],
    inFlight: false,
    record: { configured: false, writable: true },
    ...overrides,
  }
}

const facts = (configured: boolean): ProviderCredentialView => ({ kind: 'facts', configured, writable: true })

const neverDiscover = (): Promise<readonly DiscoveredModelView[]> =>
  Promise.reject(new Error('discovery must not run in this test'))

describe('provider setup mode layer', () => {
  function renderSetup(row: ProviderTargetView, authorization: ProviderAuthorizationRow | undefined, handlers: {
    onSubscribe?: () => void
  } = {}) {
    const streams = fakeStreams()
    const onSubscribe = handlers.onSubscribe ?? vi.fn()
    const instance = render(createElement(ProviderSetupPanel, {
      target: row,
      authorization,
      onSubscribe: authorization === undefined ? undefined : onSubscribe,
      save: vi.fn(async () => {}),
      saveCredential: vi.fn(async () => {}),
      discover: neverDiscover,
      effortDonors: [],
      done: vi.fn(),
      back: vi.fn(),
      onExit: vi.fn(),
    }), { stdin: streams.stdin, stdout: streams.stdout, stderr: streams.stdout, exitOnCtrlC: false, patchConsole: false })
    return {
      ...streams,
      onSubscribe: onSubscribe as ReturnType<typeof vi.fn>,
      close: () => {
        instance.unmount()
        streams.stdin.destroy()
        streams.stdout.destroy()
      },
    }
  }

  it('heads the page with the subscription and key channels and a divider', async () => {
    const harness = renderSetup(target('openai-codex'), loginRow('openai-codex'))
    try {
      await wait()
      const output = harness.read()
      expect(output).toContain('Subscription')
      expect(output).toContain('not signed in')
      expect(output).toContain('Key')
      expect(output).toContain('no key set')
      expect(output).toContain('───')
    } finally {
      harness.close()
    }
  })

  it('shows no mode layer for a provider without a web sign-in', async () => {
    const harness = renderSetup(target('my-proxy'), undefined)
    try {
      await wait()
      const output = harness.read()
      expect(output).not.toContain('Subscription')
      expect(output).not.toContain('not signed in')
    } finally {
      harness.close()
    }
  })

  it('marks an active plan sign-in and warns when a settings key shadows it', async () => {
    const harness = renderSetup(
      target('xai', { configured: true, credential: facts(true) }),
      loginRow('xai', { record: { configured: true, kind: 'grant', writable: true } }),
    )
    try {
      await wait()
      const output = harness.read()
      expect(output).toContain('signed in · plan')
      expect(output).toContain('key saved')
      expect(output).toContain('overrides the plan sign-in')
    } finally {
      harness.close()
    }
  })

  it('Tab signs the subscription channel in and never runs discovery', async () => {
    const harness = renderSetup(target('openai-codex'), loginRow('openai-codex'))
    try {
      await wait()
      harness.stdin.write('\t')
      await wait()
      expect(harness.onSubscribe).toHaveBeenCalledTimes(1)
    } finally {
      harness.close()
    }
  })

  it('Tab on the key channel keeps the discovery stage', async () => {
    const streams = fakeStreams()
    const discover = vi.fn(async () => [] as readonly DiscoveredModelView[])
    const instance = render(createElement(ProviderSetupPanel, {
      target: target('openai-codex', { credential: facts(true) }),
      authorization: loginRow('openai-codex'),
      onSubscribe: vi.fn(),
      save: vi.fn(async () => {}),
      saveCredential: vi.fn(async () => {}),
      discover,
      effortDonors: [],
      done: vi.fn(),
      back: vi.fn(),
      onExit: vi.fn(),
    }), { stdin: streams.stdin, stdout: streams.stdout, stderr: streams.stdout, exitOnCtrlC: false, patchConsole: false })
    try {
      await wait()
      // A configured key selects the key channel by default, so Tab goes
      // straight to discovery.
      streams.stdin.write('\t')
      await wait()
      expect(discover).toHaveBeenCalledTimes(1)
    } finally {
      instance.unmount()
      streams.stdin.destroy()
      streams.stdout.destroy()
    }
  })

  it('Enter on the subscription row opens the channel (sign in or sign out)', async () => {
    const harness = renderSetup(target('openai-codex'), loginRow('openai-codex'))
    try {
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(harness.onSubscribe).toHaveBeenCalledTimes(1)
    } finally {
      harness.close()
    }
  })
})

describe('provider authorization panel auto start', () => {
  it('begins a single method immediately when asked', async () => {
    const begin = vi.fn(async (_row: ProviderAuthorizationRow, _method: string, _interaction: AuthorizationInteraction, _signal: AbortSignal): Promise<AuthorizationStatus> => 'cancelled')
    const streams = fakeStreams()
    const instance = render(createElement(ProviderAuthorizationPanel, {
      row: loginRow('openai-codex'),
      autoStartMethod: 'oauth',
      begin,
      cancel: vi.fn(),
      openUrl: () => false,
      copy: async () => {},
      done: vi.fn(),
      back: vi.fn(),
    }), { stdin: streams.stdin, stdout: streams.stdout, stderr: streams.stdout, exitOnCtrlC: false, patchConsole: false })
    try {
      await wait()
      expect(begin).toHaveBeenCalledTimes(1)
      expect(begin.mock.calls[0][1]).toBe('oauth')
    } finally {
      instance.unmount()
      streams.stdin.destroy()
      streams.stdout.destroy()
    }
  })
})

describe('provider list without l/o', () => {
  it('Enter always configures and l/o do nothing', async () => {
    const onConfigure = vi.fn()
    const streams = fakeStreams()
    const directory: ProviderSettingsDirectory = {
      rows: [target('openai-codex', { configured: true })],
      writable: true,
      failures: [],
    }
    const authorizations: ProviderAuthorizationDirectory = {
      rows: [loginRow('openai-codex', { record: { configured: true, kind: 'grant', writable: true } })],
      failures: [],
    }
    const instance = render(createElement(ProviderPanel, {
      directory,
      error: undefined,
      authorizations,
      authorizationError: undefined,
      onConfigure,
      onUnset: vi.fn(),
      onRemove: vi.fn(),
      onRetry: vi.fn(),
      onBack: vi.fn(),
      onExit: vi.fn(),
    }), { stdin: streams.stdin, stdout: streams.stdout, stderr: streams.stdout, exitOnCtrlC: false, patchConsole: false })
    try {
      await wait()
      streams.stdin.write('l')
      await wait()
      streams.stdin.write('o')
      await wait()
      streams.stdin.write('\r')
      await wait()
      expect(onConfigure).toHaveBeenCalledTimes(1)
      expect(onConfigure).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai-codex' }))
      expect(streams.read()).not.toContain('l login')
    } finally {
      instance.unmount()
      streams.stdin.destroy()
      streams.stdout.destroy()
    }
  })
})
