/** Provider authorization adapter and bounded terminal interaction regressions. */

import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it, vi } from 'vitest'
import {
  authorizationForProvider,
  beginProviderAuthorization,
  loadProviderAuthorizations,
  logoutProviderAuthorization,
  providerAuthorizationStatus,
  subscribeProviderAuthorizations,
  type ProviderAuthorizationRow,
} from '../src/authorization.ts'
import { ProviderAuthorizationPanel } from '../src/authorization-panel.ts'

const wait = (ms = 120): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function fakeContext(services: Record<string, unknown>, listeners = new Map<string, Set<(...args: unknown[]) => void>>()): Context {
  return {
    get(name: string): unknown {
      return services[name]
    },
    on(event: string, listener: (...args: unknown[]) => void): () => void {
      const rows = listeners.get(event) ?? new Set()
      rows.add(listener)
      listeners.set(event, rows)
      return () => rows.delete(listener)
    },
  } as unknown as Context
}

const openaiRow = (): ProviderAuthorizationRow => ({
  key: credentialKey('llm-pi-ai', 'openai-codex'),
  provider: 'openai-codex',
  label: 'OpenAI Codex',
  methods: [{ id: 'oauth', label: 'OAuth' }, { id: 'api-key', label: 'API key' }],
  inFlight: false,
  record: { configured: true, kind: 'grant', writable: true },
})

describe('provider authorization adapter', () => {
  it('joins only pi-ai flows with value-free record facts', async () => {
    const authorization = {
      list: () => [
        { ...openaiRow(), record: undefined },
        { key: credentialKey('other-plugin', 'account'), label: 'Other', methods: [{ id: 'x', label: 'X' }], inFlight: false },
      ],
    }
    const credentials = { describeRecord: vi.fn(async () => ({ configured: true, kind: 'grant', writable: true })) }
    const directory = await loadProviderAuthorizations(fakeContext({ authorization, credentials }))
    expect(directory.failures).toEqual([])
    expect(directory.rows).toEqual([openaiRow()])
    expect(authorizationForProvider(directory, 'openai-codex')).toEqual(openaiRow())
    expect(providerAuthorizationStatus(directory.rows[0])).toBe('OAuth')
  })

  it('forwards begin, record changes, settlement, and writable logout', async () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    const begin = vi.fn(async () => ({ status: 'authorized' as const }))
    const deleteRecord = vi.fn(async () => undefined)
    const ctx = fakeContext({
      authorization: { begin, list: () => [], cancel: vi.fn() },
      credentials: {
        describeRecord: vi.fn(async () => ({ configured: true, kind: 'grant', writable: true })),
        deleteRecord,
      },
    }, listeners)
    const row = openaiRow()
    await expect(beginProviderAuthorization(ctx, row, 'oauth', { notify() {}, prompt: async () => '' })).resolves.toBe('authorized')
    expect(begin).toHaveBeenCalledWith(expect.objectContaining({ key: row.key, method: 'oauth' }))

    let updates = 0
    const dispose = subscribeProviderAuthorizations(ctx, () => { updates += 1 })
    for (const event of ['credentials/record-updated', 'authorization/settled']) {
      for (const listener of listeners.get(event) ?? []) listener(row.key, 'authorized')
    }
    expect(updates).toBe(2)
    dispose()
    expect([...listeners.values()].every(set => set.size === 0)).toBe(true)

    await logoutProviderAuthorization(ctx, row)
    expect(deleteRecord).toHaveBeenCalledWith(row.key)
  })
})

describe('ProviderAuthorizationPanel', () => {
  it('selects a method, shows/copies URL and code, masks a secret, then completes', async () => {
    const stdin = new PassThrough() as NodeJS.ReadStream
    Object.assign(stdin, { isTTY: true, setRawMode: vi.fn(), ref() {}, unref() {} })
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 24 }) as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => { output += chunk.toString() })
    const openUrl = vi.fn(() => true)
    const copy = vi.fn(async () => undefined)
    const done = vi.fn()
    const begin = vi.fn(async (_row, method: string, interaction) => {
      expect(method).toBe('oauth')
      interaction.notify({ message: 'Open the verification page', url: 'https://example.test/login', code: 'ABCD' })
      const secret = await interaction.prompt({ kind: 'secret', message: 'Paste the one-time secret' })
      expect(secret).toBe('token')
      return 'authorized' as const
    })
    const instance = render(createElement(ProviderAuthorizationPanel, {
      row: openaiRow(),
      begin,
      cancel: vi.fn(),
      openUrl,
      copy,
      done,
      back: vi.fn(),
    }), { stdin, stdout, stderr: stdout, exitOnCtrlC: false, patchConsole: false })
    try {
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('https://example.test/login')
      expect(output).toContain('ABCD')
      expect(openUrl).toHaveBeenCalledWith('https://example.test/login')
      stdin.write('c')
      await wait()
      expect(copy).toHaveBeenCalledWith('ABCD')
      stdin.write('token')
      await wait()
      expect(output).toContain('•••••')
      expect(output).not.toContain('token')
      stdin.write('\r')
      await wait()
      expect(done).toHaveBeenCalledTimes(1)
    } finally {
      instance.unmount()
    }
  })

  it('answers select prompts and lets Esc cancel the running authorization', async () => {
    const stdin = new PassThrough() as NodeJS.ReadStream
    Object.assign(stdin, { isTTY: true, setRawMode: vi.fn(), ref() {}, unref() {} })
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 24 }) as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => { output += chunk.toString() })
    const cancel = vi.fn()
    const back = vi.fn()
    const begin = vi.fn(async (_row, _method: string, interaction) => {
      const picked = await interaction.prompt({
        kind: 'select',
        message: 'Choose an account',
        options: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }],
      })
      expect(picked).toBe('two')
      await interaction.prompt({ kind: 'text', message: 'Wait for callback' })
      return 'authorized' as const
    })
    const instance = render(createElement(ProviderAuthorizationPanel, {
      row: { ...openaiRow(), methods: [{ id: 'oauth', label: 'OAuth' }] },
      begin,
      cancel,
      openUrl: () => true,
      copy: async () => {},
      done: vi.fn(),
      back,
    }), { stdin, stdout, stderr: stdout, exitOnCtrlC: false, patchConsole: false })
    try {
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('Choose an account')
      stdin.write('\x1b[B')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('Wait for callback')
      stdin.write('\x1b')
      await wait()
      expect(cancel).toHaveBeenCalled()
      expect(back).toHaveBeenCalled()
    } finally {
      instance.unmount()
    }
  })
})
