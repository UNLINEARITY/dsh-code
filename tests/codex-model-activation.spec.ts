import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { activateCodexModel, planCodexModelActivation } from '../src/codex-model-activation.ts'
import { appProps, createTty, renderApp, wait } from './helpers/app-mount.ts'

const candidate = {
  id: 'gpt-6.1-sol',
  name: 'GPT-6.1 Sol',
  contextWindow: 272000,
  maxTokens: 128000,
  input: ['text', 'image'] as const,
  reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
}

describe('planCodexModelActivation', () => {
  it('retains the installed catalog and folds existing overrides into a replacement list', () => {
    expect(planCodexModelActivation({
      registered: ['gpt-6-sol', 'gpt-6-luna'],
      profile: { modelOverrides: { 'gpt-6-sol': { name: 'Custom Sol' } } },
      candidate,
    })).toEqual({
      models: [
        { id: 'gpt-6-sol', name: 'Custom Sol' },
        { id: 'gpt-6-luna' },
        candidate,
      ],
      clearOverrides: true,
    })
  })

  it('preserves explicit user models and does not re-add models they excluded', () => {
    expect(planCodexModelActivation({
      registered: ['gpt-6-sol'],
      profile: { models: [{ id: 'gpt-6-sol', reasoningEfforts: { high: 'high' } }] },
      candidate,
    })).toEqual({
      models: [{ id: 'gpt-6-sol', reasoningEfforts: { high: 'high' } }, candidate],
      clearOverrides: false,
    })
  })

  it('rejects incompatible existing modelOverrides instead of silently dropping them', () => {
    expect(() => planCodexModelActivation({
      registered: ['gpt-6-sol'],
      profile: { models: [{ id: 'gpt-6-sol' }], modelOverrides: { 'gpt-6-sol': { name: 'Custom' } } },
      candidate,
    })).toThrow(/both models and modelOverrides/)
    expect(() => planCodexModelActivation({
      registered: ['gpt-6-sol'],
      profile: { modelOverrides: { 'gpt-6.1-sol': { name: 'Custom' } } },
      candidate,
    })).toThrow(/conflicting modelOverride/)
  })

  it('does not rewrite settings for an already registered model', () => {
    expect(planCodexModelActivation({
      registered: ['gpt-6-sol', 'gpt-6.1-sol'],
      profile: {},
      candidate,
    })).toBeUndefined()
  })
})

describe('activateCodexModel', () => {
  it('writes only the selected provider model list and verifies the live registry', async () => {
    let registered = false
    const mutate = vi.fn(async (_ns: string, _ops: unknown, _revision: number) => { registered = true })
    const llm = {
      listConfigurableProviders: () => [{ provider: 'openai-codex', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai-codex'] }],
      listModels: async () => [{ id: 'gpt-6-sol', name: 'GPT-6 Sol' }],
      resolveModelInfo: async (_provider: string, model: string) => {
        if (!registered || model !== candidate.id) throw new Error('UNKNOWN_MODEL')
        return { id: model }
      },
    }
    const settings = {
      writable: true,
      describe: () => [{ ns: 'llm-pi-ai', revision: 3, value: { providers: { 'openai-codex': {} } } }],
      mutate,
    }
    const ctx = { get: (name: string) => name === 'llm' ? llm : name === 'settings' ? settings : undefined } as unknown as Context
    await activateCodexModel(ctx, candidate)
    expect(mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'openai-codex', 'models'], value: [{ id: 'gpt-6-sol' }, candidate] },
    ], 3)
  })

  it('refuses to write when the settings document is read-only', async () => {
    const mutate = vi.fn()
    const ctx = { get: (name: string) => name === 'llm'
      ? { listConfigurableProviders: () => [{ provider: 'openai-codex', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai-codex'] }], listModels: async () => [] }
      : name === 'settings' ? { writable: false, describe: () => [], mutate } : undefined } as unknown as Context
    await expect(activateCodexModel(ctx, candidate)).rejects.toThrow(/read-only/)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('does not import into a credential- or endpoint-overridden route', async () => {
    const mutate = vi.fn()
    const llm = {
      listConfigurableProviders: () => [{ provider: 'openai-codex', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai-codex'] }],
      listModels: async () => [{ id: 'gpt-6-sol' }],
    }
    const settings = {
      writable: true,
      describe: () => [{ ns: 'llm-pi-ai', revision: 2, value: { providers: { 'openai-codex': { apiKeyEnv: 'CODEX_API_KEY' } } } }],
      mutate,
    }
    const ctx = { get: (name: string) => name === 'llm' ? llm : name === 'settings' ? settings : undefined } as unknown as Context
    await expect(activateCodexModel(ctx, candidate)).rejects.toThrow(/overrides its subscription/)
    expect(mutate).not.toHaveBeenCalled()
  })
})

describe('Codex candidate selection in /model', () => {
  const proposed = { provider: 'openai-codex', providerName: 'Codex', model: 'gpt-6.1-sol', modelName: 'GPT-6.1 Sol', candidate: true }
  it('labels the import before the model name on compact terminals', async () => {
    const tty = createTty(100, 9)
    const instance = renderApp(tty, appProps({ loadModels: async () => ({ rows: [proposed], failures: [] }) }))
    try {
      await wait()
      tty.stdin.write('/model')
      await wait()
      tty.stdin.write('\r')
      for (let i = 0; i < 30 && !tty.output.text.includes('import GPT-6.1 Sol'); i += 1) await wait(50)
      expect(tty.output.text).toContain('import GPT-6.1 Sol')
    } finally {
      instance.unmount()
      tty.stdin.destroy()
      tty.stdout.destroy()
    }
  }, 10_000)

  it('registers before selecting and keeps the registered row as the authority', async () => {
    const tty = createTty()
    const order: string[] = []
    const selectModel = vi.fn(() => { order.push('select'); return 'openai-codex/gpt-6.1-sol' })
    const activateModelCandidate = vi.fn(async () => {
      order.push('activate')
      return { ...proposed, candidate: false }
    })
    const instance = renderApp(tty, appProps({
      loadModels: async () => ({ rows: [proposed], failures: [] }),
      activateModelCandidate,
      selectModel,
    }))
    try {
      await wait()
      tty.stdin.write('/model')
      await wait()
      tty.stdin.write('\r')
      for (let i = 0; i < 30 && !tty.output.text.includes('GPT-6.1 Sol'); i += 1) await wait(50)
      expect(tty.output.text).toContain('GPT-6.1 Sol')
      await wait()
      tty.stdin.write('\r')
      for (let i = 0; i < 30 && selectModel.mock.calls.length === 0; i += 1) await wait(50)
      expect(activateModelCandidate).toHaveBeenCalledWith(proposed)
      expect(selectModel).toHaveBeenCalledWith(expect.objectContaining({ candidate: false }), undefined)
      expect(order).toEqual(['activate', 'select'])
    } finally {
      instance.unmount()
      tty.stdin.destroy()
      tty.stdout.destroy()
    }
  }, 10_000)

  it('requests a fresh remote catalog when r refreshes the model panel', async () => {
    const tty = createTty()
    const loadModels = vi.fn(async () => ({ rows: [proposed], failures: [] }))
    const instance = renderApp(tty, appProps({ loadModels }))
    try {
      await wait()
      tty.stdin.write('/model')
      await wait()
      tty.stdin.write('\r')
      await vi.waitFor(() => expect(loadModels).toHaveBeenCalledWith(false))
      tty.stdin.write('r')
      await vi.waitFor(() => expect(loadModels).toHaveBeenLastCalledWith(true))
    } finally {
      instance.unmount()
      tty.stdin.destroy()
      tty.stdout.destroy()
    }
  })

  it.each([false, true])('does not select or close the panel when registration fails (sync: %s)', async (synchronous) => {
    const tty = createTty()
    const selectModel = vi.fn(() => 'bad')
    const instance = renderApp(tty, appProps({
      loadModels: async () => ({ rows: [proposed], failures: [] }),
      activateModelCandidate: () => {
        if (synchronous) throw new Error('settings are read-only')
        return Promise.reject(new Error('settings are read-only'))
      },
      selectModel,
    }))
    try {
      await wait()
      tty.stdin.write('/model')
      await wait()
      tty.stdin.write('\r')
      for (let i = 0; i < 30 && !tty.output.text.includes('GPT-6.1 Sol'); i += 1) await wait(50)
      await wait()
      tty.stdin.write('\r')
      for (let i = 0; i < 30 && !tty.output.text.includes('settings are read-only'); i += 1) await wait(50)
      expect(tty.output.text).toContain('settings are read-only')
      expect(selectModel).not.toHaveBeenCalled()
      expect(tty.output.text).toContain('GPT-6.1 Sol')
    } finally {
      instance.unmount()
      tty.stdin.destroy()
      tty.stdout.destroy()
    }
  }, 10_000)
})
