/**
 * Provider-management adapter: directory join, credential writes, and profile
 * removal with official web ordering and bounded, key-free errors.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  ProviderSettingsError,
  discoverProviderModels,
  parseReasoningEffortsDraft,
  serializeReasoningEfforts,
  deriveCredentialRef,
  loadProviderSettings,
  removeProviderSettings,
  saveProviderConfiguration,
  saveProviderCredential,
  subscribeProviderSettings,
  unsetProviderCredential,
  type DiscoveredModelView,
  type ProviderTargetView,
} from '../src/provider-settings.ts'

/** A context serving exactly the fakes given, by service name. */
function fakeCtx(services: Record<string, unknown>): Context {
  const provided = new Map(Object.entries(services))
  return { get: (name: string): unknown => provided.get(name) } as unknown as Context
}

/** Shared, read-only fixture shapes (vi.fn state stays per test). */
const deepseekEntry = { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] as string[] }
const deepseekDescriptor = {
  ns: 'llm-deepseek',
  value: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
  revision: 3,
  base: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
  user: {},
}
const piAiEntry = { provider: 'pi-ai', displayName: 'PI AI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'pi-ai'] }
const dormantDescriptor = {
  ns: 'llm-pi-ai',
  value: { providers: {} },
  revision: 2,
  base: { providers: {} },
  user: { providers: {} },
}
const configuredPiAiDescriptor = {
  ns: 'llm-pi-ai',
  value: { providers: { 'pi-ai': { apiKeyEnv: 'PI_AI_API_KEY', baseURL: 'https://gateway.example' } } },
  revision: 4,
  base: { providers: {} },
  user: { providers: { 'pi-ai': { apiKeyEnv: 'PI_AI_API_KEY', baseURL: 'https://gateway.example' } } },
}
const refLessPiAiDescriptor = {
  ns: 'llm-pi-ai',
  value: { providers: { 'pi-ai': { baseURL: 'https://gateway.example' } } },
  revision: 4,
  base: { providers: {} },
  user: { providers: { 'pi-ai': { baseURL: 'https://gateway.example' } } },
}

/** An llm face registering the given providers and directory (no directory when omitted). */
function llmWith(
  providers: Array<{ id: string; name: string }>,
  directory?: unknown[],
): { listProviders: ReturnType<typeof vi.fn>; listConfigurableProviders?: ReturnType<typeof vi.fn> } {
  return {
    listProviders: vi.fn(() => providers),
    ...directory === undefined ? {} : { listConfigurableProviders: vi.fn(() => directory) },
  }
}

describe('deriveCredentialRef', () => {
  it('derives the official web `<ROUTE>_API_KEY` convention', () => {
    expect(deriveCredentialRef('pi-ai')).toBe('PI_AI_API_KEY')
    expect(deriveCredentialRef('minimax-cn')).toBe('MINIMAX_CN_API_KEY')
    expect(deriveCredentialRef('deepseek-official')).toBe('DEEPSEEK_OFFICIAL_API_KEY')
    expect(deriveCredentialRef('openrouter.ai')).toBe('OPENROUTER_AI_API_KEY')
    expect(deriveCredentialRef('a b/c')).toBe('A_B_C_API_KEY')
  })
})

describe('subscribeProviderSettings', () => {
  it('forwards and disposes the official Models invalidation trio', () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    const ctx = {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const set = listeners.get(event) ?? new Set()
        set.add(listener)
        listeners.set(event, set)
        return () => { set.delete(listener) }
      }),
    } as unknown as Context
    let updates = 0
    const dispose = subscribeProviderSettings(ctx, () => { updates += 1 })
    for (const event of ['credentials/reference-updated', 'settings/document-updated', 'llm/adapters-updated']) {
      expect(listeners.get(event)?.size).toBe(1)
      for (const listener of listeners.get(event) ?? []) listener()
    }
    expect(updates).toBe(3)
    dispose()
    expect([...listeners.values()].every(set => set.size === 0)).toBe(true)
  })
})

describe('loadProviderSettings', () => {
  it('joins the whole-section DeepSeek row with its default ref and credential facts', async () => {
    const settings = {
      writable: true,
      describe: vi.fn(() => [deepseekDescriptor]),
      mutate: vi.fn(async () => undefined),
    }
    const credentials = {
      describe: vi.fn(async () => ({ configured: true, source: 'file', writable: true })),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => undefined),
    }
    const llm = llmWith([{ id: 'deepseek-official', name: 'DeepSeek' }], [deepseekEntry])
    const directory = await loadProviderSettings(fakeCtx({ llm, settings, credentials }))
    expect(settings.describe).toHaveBeenCalledWith({ redactSecrets: true })
    expect(directory.writable).toBe(true)
    expect(directory.failures).toEqual([])
    expect(directory.rows).toHaveLength(1)
    const row = directory.rows[0]
    expect(row.provider).toBe('deepseek-official')
    expect(row.displayName).toBe('DeepSeek')
    expect(row.active).toBe(true)
    expect(row.settingsNs).toBe('llm-deepseek')
    expect(row.settingsPath).toEqual([])
    expect(row.settingsRevision).toBe(3)
    expect(row.configured).toBe(true)
    expect(row.removable).toBe(false)
    expect(row.credentialRef).toBe('DEEPSEEK_API_KEY')
    expect(row.suggestedRef).toBe('DEEPSEEK_OFFICIAL_API_KEY')
    expect(row.credential).toEqual({ kind: 'facts', configured: true, source: 'file', writable: true })
    expect(credentials.describe).toHaveBeenCalledWith('DEEPSEEK_API_KEY')
  })

  it('marks a dormant pi-ai route as unconfigured with the conventional suggested ref', async () => {
    const settings = {
      writable: true,
      describe: vi.fn(() => [dormantDescriptor]),
      mutate: vi.fn(async () => undefined),
    }
    const credentials = {
      describe: vi.fn(async () => ({ configured: false, writable: true })),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => undefined),
    }
    const llm = llmWith([], [piAiEntry])
    const directory = await loadProviderSettings(fakeCtx({ llm, settings, credentials }))
    const row = directory.rows[0]
    expect(row.active).toBe(false)
    expect(row.configured).toBe(false)
    expect(row.removable).toBe(false)
    expect(row.credentialRef).toBeUndefined()
    expect(row.suggestedRef).toBe('PI_AI_API_KEY')
    expect(row.credential).toBeUndefined()
    expect(credentials.describe).not.toHaveBeenCalled()
  })

  it('carries the adapter’s configuration diagnostic onto the row instead of dropping it', async () => {
    // 0.1.5: a damaged catalog keeps the provider listed for repair; the
    // diagnostic rides the row so the panel can show what to fix.
    const settings = {
      writable: true,
      describe: vi.fn(() => [dormantDescriptor]),
      mutate: vi.fn(async () => undefined),
    }
    const credentials = {
      describe: vi.fn(async () => ({ configured: false, writable: true })),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => undefined),
    }
    const broken = { ...piAiEntry, error: 'model "glm-9" declares an unknown\nprotocol' }
    const llm = llmWith([], [broken])
    const directory = await loadProviderSettings(fakeCtx({ llm, settings, credentials }))
    expect(directory.failures).toEqual([])
    expect(directory.rows[0].diagnostic).toBe('model "glm-9" declares an unknown protocol')
    // A clean entry never grows the field.
    const clean = await loadProviderSettings(fakeCtx({ llm: llmWith([], [piAiEntry]), settings, credentials }))
    expect(clean.rows[0].diagnostic).toBeUndefined()
  })

  it('surfaces an active provider outside the directory as a read-only unmanaged row', async () => {
    const settings = { writable: true, describe: vi.fn(() => []), mutate: vi.fn(async () => undefined) }
    const credentials = {
      describe: vi.fn(async () => ({ configured: false, writable: true })),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => undefined),
    }
    const llm = llmWith([{ id: 'acme-gateway', name: 'Acme' }])
    const directory = await loadProviderSettings(fakeCtx({ llm, settings, credentials }))
    const row = directory.rows[0]
    expect(row.provider).toBe('acme-gateway')
    expect(row.displayName).toBe('Acme')
    expect(row.active).toBe(true)
    expect(row.settingsNs).toBe('')
    expect(row.settingsPath).toEqual([])
    expect(row.configured).toBe(false)
    expect(row.removable).toBe(false)
    expect(row.credentialRef).toBeUndefined()
    expect(row.credential).toBeUndefined()
    expect(row.suggestedRef).toBe('ACME_GATEWAY_API_KEY')
    expect(credentials.describe).not.toHaveBeenCalled()
  })

  it('marks a path-addressed profile removable when only the user layer carries it', async () => {
    const settings = {
      writable: true,
      describe: vi.fn(() => [configuredPiAiDescriptor]),
      mutate: vi.fn(async () => undefined),
    }
    const credentials = {
      describe: vi.fn(async () => ({ configured: true, source: 'file', writable: true })),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => undefined),
    }
    const llm = llmWith([{ id: 'pi-ai', name: 'PI AI' }], [piAiEntry])
    const directory = await loadProviderSettings(fakeCtx({ llm, settings, credentials }))
    const row = directory.rows[0]
    expect(row.active).toBe(true)
    expect(row.configured).toBe(true)
    expect(row.removable).toBe(true)
    expect(row.credentialRef).toBe('PI_AI_API_KEY')
    expect(row.credential).toEqual({ kind: 'facts', configured: true, source: 'file', writable: true })
  })

  it('keeps every row when one credential describe fails, degrading that row only', async () => {
    const settings = {
      writable: true,
      describe: vi.fn(() => [deepseekDescriptor, configuredPiAiDescriptor]),
      mutate: vi.fn(async () => undefined),
    }
    const credentials = {
      describe: vi.fn(async (ref: string) => {
        if (ref === 'PI_AI_API_KEY') throw new Error('credentials store offline')
        return { configured: true, source: 'file', writable: true }
      }),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => undefined),
    }
    const llm = llmWith(
      [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'pi-ai', name: 'PI AI' }],
      [deepseekEntry, piAiEntry],
    )
    const directory = await loadProviderSettings(fakeCtx({ llm, settings, credentials }))
    expect(directory.rows).toHaveLength(2)
    expect(directory.rows[0].credential).toEqual({ kind: 'facts', configured: true, source: 'file', writable: true })
    expect(directory.rows[1].credential).toEqual({ kind: 'error', message: 'credentials store offline' })
  })

  it('tolerates absent settings and credentials services without losing rows', async () => {
    const llm = llmWith([{ id: 'deepseek-official', name: 'DeepSeek' }], [deepseekEntry, piAiEntry])
    const directory = await loadProviderSettings(fakeCtx({ llm }))
    expect(directory.writable).toBe(false)
    expect(directory.rows).toHaveLength(2)
    for (const row of directory.rows) {
      expect(row.settingsRevision).toBe(0)
      expect(row.configured).toBe(false)
      expect(row.removable).toBe(false)
      expect(row.credentialRef).toBeUndefined()
      expect(row.credential).toBeUndefined()
    }
    expect(directory.rows[0].active).toBe(true)
    expect(directory.rows[1].active).toBe(false)
  })

  it('reports a bounded error for a named ref when the credentials service is absent', async () => {
    const settings = {
      writable: true,
      describe: vi.fn(() => [deepseekDescriptor]),
      mutate: vi.fn(async () => undefined),
    }
    const llm = llmWith([{ id: 'deepseek-official', name: 'DeepSeek' }], [deepseekEntry])
    const directory = await loadProviderSettings(fakeCtx({ llm, settings }))
    expect(directory.rows[0].credentialRef).toBe('DEEPSEEK_API_KEY')
    expect(directory.rows[0].credential).toEqual({ kind: 'error', message: 'credentials service is unavailable' })
  })

  it('returns an empty directory when the llm service is unavailable', async () => {
    const directory = await loadProviderSettings(fakeCtx({}))
    expect(directory).toEqual({ rows: [], writable: false, failures: [] })
  })
})

describe('parseReasoningEffortsDraft', () => {
  it('parses identity pairs, null wire values, and dialect spellings', () => {
    expect(parseReasoningEffortsDraft('low:low high:high max:max')).toEqual({
      ok: true,
      value: { low: 'low', high: 'high', max: 'max' },
    })
    expect(parseReasoningEffortsDraft('off:null low:high max:max')).toEqual({
      ok: true,
      value: { off: null, low: 'high', max: 'max' },
    })
  })

  it('clears to inherit on empty and disables on the single false token', () => {
    expect(parseReasoningEffortsDraft('   ')).toEqual({ ok: true, value: undefined })
    expect(parseReasoningEffortsDraft('false')).toEqual({ ok: true, value: false })
  })

  it('rejects unknown levels, duplicates, and malformed tokens with one line', () => {
    expect(parseReasoningEffortsDraft('low:low turbo:max')).toEqual({
      ok: false,
      error: expect.stringContaining('"turbo" is not a level'),
    })
    expect(parseReasoningEffortsDraft('low:low low:high')).toEqual({
      ok: false,
      error: expect.stringContaining('appears twice'),
    })
    expect(parseReasoningEffortsDraft('low')).toEqual({
      ok: false,
      error: expect.stringContaining('needs level:wire'),
    })
    expect(parseReasoningEffortsDraft('low:')).toEqual({
      ok: false,
      error: expect.stringContaining('needs level:wire'),
    })
  })

  it('round-trips a stored declaration through serialize', () => {
    const stored = { off: null, low: 'low', medium: 'medium', high: 'high' }
    const serialized = serializeReasoningEfforts(stored)
    expect(serialized).toBe('off:null low:low medium:medium high:high')
    expect(parseReasoningEffortsDraft(serialized)).toEqual({ ok: true, value: stored })
    expect(serializeReasoningEfforts(undefined)).toBe('')
    expect(serializeReasoningEfforts(false)).toBe('false')
  })
})

describe('discoverProviderModels', () => {
  const targetOf = (overrides: Partial<ProviderTargetView> = {}): ProviderTargetView => ({
    provider: 'gateway',
    displayName: 'Gateway',
    active: true,
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'gateway'],
    settingsRevision: 4,
    configured: true,
    removable: false,
    credentialRef: 'GATEWAY_API_KEY',
    suggestedRef: 'GATEWAY_API_KEY',
    credential: { kind: 'facts', configured: true, source: 'file', writable: true },
    configuration: { models: [] },
    ...overrides,
  })

  it('sends the draft with the typed key and endpoint - never the route id, so a builtin catalog cannot shadow the gateway', async () => {
    const discover = vi.fn(async (_ns: string, request: Record<string, unknown>): Promise<readonly DiscoveredModelView[]> => {
      expect(request).toEqual({ apiKey: 'sk-typed', baseURL: 'https://gw.example/v1' })
      expect('provider' in request).toBe(false)
      return [
        { id: 'glm-5.4', name: 'GLM-5.4', contextWindow: 1000000 },
        { id: '' },
        { id: 'glm-5.4' },
        // The endpoint reply is a wire value, not a checked one: this row
        // deliberately has no id, so the double cast is the point of the test.
        { name: 'nameless' } as unknown as DiscoveredModelView,
      ]
    })
    const rows = await discoverProviderModels(
      fakeCtx({ llm: { discoverModels: discover } }),
      targetOf(),
      { apiKey: 'sk-typed', baseURL: 'https://gw.example/v1' },
    )
    expect(discover).toHaveBeenCalledWith('llm-pi-ai', expect.anything())
    expect(rows).toEqual([{ id: 'glm-5.4', name: 'GLM-5.4', contextWindow: 1000000 }])
  })

  it('resolves the stored credential once for an endpoint probe when no key is typed', async () => {
    const discover = vi.fn(async (_ns: string, _request: Record<string, unknown>) => [])
    // The mock mirrors the real provider's shape: resolve is a METHOD reading
    // instance state, so a bridge that destructures it off the service loses
    // `this`, the lookup throws, and the probe goes out unauthenticated —
    // exactly the production regression this test pins.
    const credentials = {
      store: { GATEWAY_API_KEY: 'sk-stored' } as Record<string, string>,
      resolve(this: { store: Record<string, string> }, ref: string) {
        return Promise.resolve(this.store[ref] === undefined
          ? undefined
          : { value: this.store[ref], source: 'file' })
      },
    }
    await discoverProviderModels(
      fakeCtx({ llm: { discoverModels: discover }, credentials }),
      targetOf({ configuration: { api: 'openai-responses', models: [] } }),
      { baseURL: 'https://gw.example/v1' },
    )
    expect(discover.mock.calls[0][1]).toEqual({
      apiKey: 'sk-stored',
      baseURL: 'https://gw.example/v1',
      api: 'openai-responses',
    })
  })

  it('probes the endpoint unauthenticated when no key exists anywhere', async () => {
    const discover = vi.fn(async (_ns: string, _request: Record<string, unknown>) => [])
    const resolve = vi.fn(async () => { throw new Error('locked') })
    await discoverProviderModels(
      fakeCtx({ llm: { discoverModels: discover }, credentials: { resolve } }),
      targetOf(),
      { baseURL: 'https://gw.example/v1' },
    )
    expect(discover.mock.calls[0][1]).toEqual({ baseURL: 'https://gw.example/v1' })
  })

  it('asks the route itself only when no endpoint override exists', async () => {
    const discover = vi.fn(async (_ns: string, _request: Record<string, unknown>) => [])
    await discoverProviderModels(
      fakeCtx({ llm: { discoverModels: discover } }),
      targetOf(),
      {},
    )
    expect(discover.mock.calls[0][1]).toEqual({ provider: 'gateway' })
  })

  it('forwards the cancellation signal verbatim', async () => {
    const discover = vi.fn(async () => [])
    const controller = new AbortController()
    await discoverProviderModels(fakeCtx({ llm: { discoverModels: discover } }), targetOf(), {}, controller.signal)
    expect(discover).toHaveBeenCalledWith('llm-pi-ai', expect.anything(), controller.signal)
  })

  it('rejects unmanaged rows, absent capability, and endpoint failures with bounded errors', async () => {
    await expect(discoverProviderModels(fakeCtx({ llm: {} }), targetOf({ settingsNs: '' }), {}))
      .rejects.toThrow(ProviderSettingsError)
    await expect(discoverProviderModels(fakeCtx({}), targetOf(), {}))
      .rejects.toThrow('model discovery is unavailable')
    const failing = vi.fn(async () => { throw new Error('gateway answered 401;\ncheck the API key') })
    await expect(discoverProviderModels(fakeCtx({ llm: { discoverModels: failing } }), targetOf(), {}))
      .rejects.toThrow('gateway answered 401; check the API key')
  })
})

describe('saveProviderConfiguration', () => {
  const target: ProviderTargetView = {
    provider: 'pi-ai', displayName: 'PI AI', active: true,
    settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'pi-ai'], settingsRevision: 7,
    configured: true, removable: false, suggestedRef: 'PI_AI_API_KEY', credential: undefined,
    configuration: { models: [] },
  }

  it('writes only endpoint and an explicit model allow-list with capacities', async () => {
    const settings = { writable: true, mutate: vi.fn(async () => undefined) }
    await saveProviderConfiguration(fakeCtx({ settings }), target, {
      baseURL: 'https://gateway.example/v1',
      models: [{ id: 'model-a', name: 'Model A', contextWindow: 128_000, maxTokens: 8_192 }],
    })
    expect(settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'pi-ai', 'baseURL'], value: 'https://gateway.example/v1' },
      { op: 'set', path: ['providers', 'pi-ai', 'models'], value: [{ id: 'model-a', name: 'Model A', contextWindow: 128_000, maxTokens: 8_192 }] },
    ], 7)
  })

  it('round-trips editor-invisible declaration fields through a panel save', async () => {
    const settings = {
      writable: true,
      describe: vi.fn(() => [{
        ns: 'llm-pi-ai',
        revision: 7,
        value: {
          providers: {
            'pi-ai': {
              baseURL: 'https://gateway.example/v1',
              models: [{
                id: 'model-a',
                name: 'Model A',
                contextWindow: 128_000,
                maxTokens: 8_192,
                reasoningEfforts: { off: null, high: 'ultra' },
                compat: { supportsStore: false },
              }],
            },
          },
        },
        base: { providers: {} },
        user: {},
      }]),
      mutate: vi.fn(async () => undefined),
    }
    const llm = llmWith([{ id: 'pi-ai', name: 'PI AI' }], [piAiEntry])
    const ctx = fakeCtx({ llm, settings })
    const row = (await loadProviderSettings(ctx)).rows[0]
    expect(row.configuration.models).toEqual([{
      id: 'model-a',
      name: 'Model A',
      contextWindow: 128_000,
      maxTokens: 8_192,
      extras: { reasoningEfforts: { off: null, high: 'ultra' }, compat: { supportsStore: false } },
    }])
    // A save that keeps the row checked re-emits the carried fields verbatim;
    // edited modelled fields (a new output window) win over nothing carried.
    await saveProviderConfiguration(ctx, row, {
      baseURL: 'https://gateway.example/v1',
      models: [{ ...row.configuration.models[0], maxTokens: 4_096 }],
    })
    expect(settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'pi-ai', 'baseURL'], value: 'https://gateway.example/v1' },
      { op: 'set', path: ['providers', 'pi-ai', 'models'], value: [{
        id: 'model-a',
        reasoningEfforts: { off: null, high: 'ultra' },
        compat: { supportsStore: false },
        name: 'Model A',
        contextWindow: 128_000,
        maxTokens: 4_096,
      }] },
    ], 7)
  })

  it('lets a cleared modelled field drop even when extras carry raw values', async () => {
    const settings = { writable: true, mutate: vi.fn(async () => undefined) }
    await saveProviderConfiguration(fakeCtx({ settings }), target, {
      models: [{ id: 'model-a', extras: { input: ['text'] } }],
    })
    expect(settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'unset', path: ['providers', 'pi-ai', 'baseURL'] },
      { op: 'set', path: ['providers', 'pi-ai', 'models'], value: [{ id: 'model-a', input: ['text'] }] },
    ], 7)
  })

  it('rejects invalid endpoints and never invokes settings mutation', async () => {
    const settings = { writable: true, mutate: vi.fn(async () => undefined) }
    await expect(saveProviderConfiguration(fakeCtx({ settings }), target, {
      baseURL: 'file:///not-a-provider', models: [],
    })).rejects.toBeInstanceOf(ProviderSettingsError)
    expect(settings.mutate).not.toHaveBeenCalled()
  })
})

describe('saveProviderCredential', () => {
  it('materializes a dormant pi-ai route before storing its key, web ordering', async () => {
    const order: string[] = []
    const settings = {
      writable: true,
      describe: vi.fn(() => [dormantDescriptor]),
      mutate: vi.fn(async () => { order.push('mutate') }),
    }
    const credentials = {
      describe: vi.fn(async () => ({ configured: false, writable: true })),
      set: vi.fn(async () => { order.push('set') }),
      unset: vi.fn(async () => undefined),
    }
    const llm = llmWith([], [piAiEntry])
    const ctx = fakeCtx({ llm, settings, credentials })
    const row = (await loadProviderSettings(ctx)).rows[0]
    await saveProviderCredential(ctx, row, '  sk-pi-ai-123  ')
    expect(settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'pi-ai', 'apiKeyEnv'], value: 'PI_AI_API_KEY' },
    ])
    expect(credentials.set).toHaveBeenCalledWith('PI_AI_API_KEY', 'sk-pi-ai-123')
    expect(order).toEqual(['mutate', 'set'])
  })

  it('records the derived ref on a configured profile that names none', async () => {
    const settings = {
      writable: true,
      describe: vi.fn(() => [refLessPiAiDescriptor]),
      mutate: vi.fn(async () => undefined),
    }
    const credentials = {
      describe: vi.fn(async () => ({ configured: false, writable: true })),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => undefined),
    }
    const llm = llmWith([{ id: 'pi-ai', name: 'PI AI' }], [piAiEntry])
    const ctx = fakeCtx({ llm, settings, credentials })
    const row = (await loadProviderSettings(ctx)).rows[0]
    expect(row.configured).toBe(true)
    expect(row.credentialRef).toBeUndefined()
    await saveProviderCredential(ctx, row, 'sk-gateway')
    expect(settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'pi-ai', 'apiKeyEnv'], value: 'PI_AI_API_KEY' },
    ])
    expect(credentials.set).toHaveBeenCalledWith('PI_AI_API_KEY', 'sk-gateway')
  })

  it('rotates a configured key without any settings mutation when the ref is already named', async () => {
    const settings = {
      writable: true,
      describe: vi.fn(() => [deepseekDescriptor]),
      mutate: vi.fn(async () => undefined),
    }
    const credentials = {
      describe: vi.fn(async () => ({ configured: true, source: 'file', writable: true })),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => undefined),
    }
    const llm = llmWith([{ id: 'deepseek-official', name: 'DeepSeek' }], [deepseekEntry])
    const ctx = fakeCtx({ llm, settings, credentials })
    const row = (await loadProviderSettings(ctx)).rows[0]
    await saveProviderCredential(ctx, row, 'sk-rotated-1')
    expect(settings.mutate).not.toHaveBeenCalled()
    expect(credentials.set).toHaveBeenCalledWith('DEEPSEEK_API_KEY', 'sk-rotated-1')
  })

  it('redacts a credential-provider error that reflects the submitted secret', async () => {
    const settings = { writable: true, describe: vi.fn(() => [deepseekDescriptor]), mutate: vi.fn(async () => undefined) }
    const credentials = {
      describe: vi.fn(async () => ({ configured: false, writable: true })),
      set: vi.fn(async (_ref: string, value: string) => { throw new Error(`store refused ${value}`) }),
      unset: vi.fn(async () => undefined),
    }
    const llm = llmWith([{ id: 'deepseek-official', name: 'DeepSeek' }], [deepseekEntry])
    const ctx = fakeCtx({ llm, settings, credentials })
    const row = (await loadProviderSettings(ctx)).rows[0]
    const secret = 'sk-must-not-escape'
    await expect(saveProviderCredential(ctx, row, secret)).rejects.toThrow('credentials service rejected the API key')
    try {
      await saveProviderCredential(ctx, row, secret)
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain(secret)
    }
  })

  it('refuses env-supplied read-only keys before any service call', async () => {
    const settings = { writable: true, describe: vi.fn(() => [deepseekDescriptor]), mutate: vi.fn(async () => undefined) }
    const credentials = {
      describe: vi.fn(async () => ({ configured: true, source: 'env', writable: false })),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => undefined),
    }
    const llm = llmWith([{ id: 'deepseek-official', name: 'DeepSeek' }], [deepseekEntry])
    const ctx = fakeCtx({ llm, settings, credentials })
    const row = (await loadProviderSettings(ctx)).rows[0]
    await expect(saveProviderCredential(ctx, row, 'sk-secret')).rejects.toThrow('read-only')
    expect(credentials.set).not.toHaveBeenCalled()
    expect(settings.mutate).not.toHaveBeenCalled()
  })

  it('rejects invalid keys with key-free single-line errors, never reaching services', async () => {
    const settings = { writable: true, describe: vi.fn(() => [deepseekDescriptor]), mutate: vi.fn(async () => undefined) }
    const credentials = {
      describe: vi.fn(async () => ({ configured: false, writable: true })),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => undefined),
    }
    const llm = llmWith([{ id: 'deepseek-official', name: 'DeepSeek' }], [deepseekEntry])
    const ctx = fakeCtx({ llm, settings, credentials })
    const row = (await loadProviderSettings(ctx)).rows[0]
    for (const bad of [
      '',
      '   ',
      'sk-key with space',
      'sk-密钥',
      'DEEPSEEK_API_KEY=sk-pasted',
      '"sk-quoted"',
      '\'sk-quoted\'',
      '`sk-quoted`',
    ]) {
      await expect(saveProviderCredential(ctx, row, bad)).rejects.toBeInstanceOf(ProviderSettingsError)
    }
    expect(settings.mutate).not.toHaveBeenCalled()
    expect(credentials.set).not.toHaveBeenCalled()
    // The rejection text never echoes any part of the raw key.
    try {
      await saveProviderCredential(ctx, row, 'sk-密钥')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).not.toContain('密钥')
      expect(message).not.toContain('\n')
      expect(message).not.toContain('\r')
    }
  })

  it('refuses an unmanaged active provider with no settings namespace', async () => {
    const settings = { writable: true, describe: vi.fn(() => []), mutate: vi.fn(async () => undefined) }
    const credentials = {
      describe: vi.fn(async () => ({ configured: false, writable: true })),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => undefined),
    }
    const llm = llmWith([{ id: 'acme-gateway', name: 'Acme' }])
    const ctx = fakeCtx({ llm, settings, credentials })
    const row = (await loadProviderSettings(ctx)).rows[0]
    await expect(saveProviderCredential(ctx, row, 'sk-acme')).rejects.toThrow('no managed settings namespace')
    expect(settings.mutate).not.toHaveBeenCalled()
    expect(credentials.set).not.toHaveBeenCalled()
  })

  it('retries a save whose credential write failed without corrupting settings', async () => {
    const settings = {
      writable: true,
      describe: vi.fn(() => [dormantDescriptor]),
      mutate: vi.fn(async () => undefined),
    }
    let setCalls = 0
    const credentials = {
      describe: vi.fn(async () => ({ configured: false, writable: true })),
      set: vi.fn(async () => {
        setCalls += 1
        if (setCalls === 1) throw new Error('store busy')
      }),
      unset: vi.fn(async () => undefined),
    }
    const llm = llmWith([], [piAiEntry])
    const ctx = fakeCtx({ llm, settings, credentials })
    const row = (await loadProviderSettings(ctx)).rows[0]
    await expect(saveProviderCredential(ctx, row, 'sk-a')).rejects.toThrow('store busy')
    // Same (stale) target: the re-materialization is idempotent, then the key lands.
    await saveProviderCredential(ctx, row, 'sk-a')
    expect(settings.mutate).toHaveBeenCalledTimes(2)
    expect(credentials.set).toHaveBeenCalledTimes(2)
    expect(credentials.set).toHaveBeenLastCalledWith('PI_AI_API_KEY', 'sk-a')
  })
})

describe('unsetProviderCredential', () => {
  it('unsets only the currently named credential, leaving settings alone', async () => {
    const settings = { writable: true, describe: vi.fn(() => [deepseekDescriptor]), mutate: vi.fn(async () => undefined) }
    const credentials = {
      describe: vi.fn(async () => ({ configured: true, source: 'file', writable: true })),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => undefined),
    }
    const llm = llmWith([{ id: 'deepseek-official', name: 'DeepSeek' }], [deepseekEntry])
    const ctx = fakeCtx({ llm, settings, credentials })
    const row = (await loadProviderSettings(ctx)).rows[0]
    await unsetProviderCredential(ctx, row)
    expect(credentials.unset).toHaveBeenCalledWith('DEEPSEEK_API_KEY')
    expect(settings.mutate).not.toHaveBeenCalled()
  })

  it('rejects a row that names no reference and an already-absent key', async () => {
    const settings = { writable: true, describe: vi.fn(() => [dormantDescriptor]), mutate: vi.fn(async () => undefined) }
    const credentials = {
      describe: vi.fn(async () => ({ configured: false, writable: true })),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => undefined),
    }
    const llm = llmWith([], [piAiEntry])
    const ctx = fakeCtx({ llm, settings, credentials })
    const dormant = (await loadProviderSettings(ctx)).rows[0]
    await expect(unsetProviderCredential(ctx, dormant)).rejects.toThrow('names no credential reference')
    expect(credentials.unset).not.toHaveBeenCalled()

    const absent = {
      provider: 'deepseek-official',
      displayName: 'DeepSeek',
      active: true,
      settingsNs: 'llm-deepseek',
      settingsPath: [],
      settingsRevision: 0,
      configured: true,
      removable: false,
      credentialRef: 'DEEPSEEK_API_KEY',
      suggestedRef: 'DEEPSEEK_OFFICIAL_API_KEY',
      credential: { kind: 'facts' as const, configured: false, writable: true },
      configuration: { models: [] },
    } satisfies ProviderTargetView
    await expect(unsetProviderCredential(ctx, absent)).rejects.toThrow('no configured credential')
    expect(credentials.unset).not.toHaveBeenCalled()
  })

  it('refuses to remove an env-supplied read-only key', async () => {
    const settings = { writable: true, describe: vi.fn(() => [deepseekDescriptor]), mutate: vi.fn(async () => undefined) }
    const credentials = {
      describe: vi.fn(async () => ({ configured: true, source: 'env', writable: false })),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => undefined),
    }
    const llm = llmWith([{ id: 'deepseek-official', name: 'DeepSeek' }], [deepseekEntry])
    const ctx = fakeCtx({ llm, settings, credentials })
    const row = (await loadProviderSettings(ctx)).rows[0]
    await expect(unsetProviderCredential(ctx, row)).rejects.toThrow('read-only')
    expect(credentials.unset).not.toHaveBeenCalled()
  })
})

describe('removeProviderSettings', () => {
  it('unsets the managed credential before removing the profile, web ordering', async () => {
    const order: string[] = []
    const settings = {
      writable: true,
      describe: vi.fn(() => [configuredPiAiDescriptor]),
      mutate: vi.fn(async () => { order.push('mutate') }),
    }
    const credentials = {
      describe: vi.fn(async () => ({ configured: true, source: 'file', writable: true })),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => { order.push('unset') }),
    }
    const llm = llmWith([{ id: 'pi-ai', name: 'PI AI' }], [piAiEntry])
    const ctx = fakeCtx({ llm, settings, credentials })
    const row = (await loadProviderSettings(ctx)).rows[0]
    expect(row.removable).toBe(true)
    await removeProviderSettings(ctx, row)
    expect(credentials.unset).toHaveBeenCalledWith('PI_AI_API_KEY')
    expect(settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'unset', path: ['providers', 'pi-ai'] }])
    expect(order).toEqual(['unset', 'mutate'])
  })

  it('leaves a hand-named credential alone when removing the profile', async () => {
    const custom = {
      ns: 'llm-pi-ai',
      value: { providers: { 'pi-ai': { apiKeyEnv: 'MY_SHARED_KEY', baseURL: 'https://gateway.example' } } },
      revision: 4,
      base: { providers: {} },
      user: { providers: { 'pi-ai': { apiKeyEnv: 'MY_SHARED_KEY', baseURL: 'https://gateway.example' } } },
    }
    const settings = { writable: true, describe: vi.fn(() => [custom]), mutate: vi.fn(async () => undefined) }
    const credentials = {
      describe: vi.fn(async () => ({ configured: true, source: 'file', writable: true })),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => undefined),
    }
    const llm = llmWith([{ id: 'pi-ai', name: 'PI AI' }], [piAiEntry])
    const ctx = fakeCtx({ llm, settings, credentials })
    const row = (await loadProviderSettings(ctx)).rows[0]
    expect(row.removable).toBe(true)
    expect(row.credentialRef).toBe('MY_SHARED_KEY')
    await removeProviderSettings(ctx, row)
    expect(credentials.unset).not.toHaveBeenCalled()
    expect(settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'unset', path: ['providers', 'pi-ai'] }])
  })

  it('refuses a row that is not removable', async () => {
    const settings = { writable: true, describe: vi.fn(() => [deepseekDescriptor]), mutate: vi.fn(async () => undefined) }
    const credentials = {
      describe: vi.fn(async () => ({ configured: true, source: 'file', writable: true })),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => undefined),
    }
    const llm = llmWith([{ id: 'deepseek-official', name: 'DeepSeek' }], [deepseekEntry])
    const ctx = fakeCtx({ llm, settings, credentials })
    const row = (await loadProviderSettings(ctx)).rows[0]
    expect(row.removable).toBe(false)
    await expect(removeProviderSettings(ctx, row)).rejects.toThrow('not removable')
    expect(credentials.unset).not.toHaveBeenCalled()
    expect(settings.mutate).not.toHaveBeenCalled()
  })

  it('retries a removal whose settings write failed', async () => {
    let mutateCalls = 0
    const settings = {
      writable: true,
      describe: vi.fn(() => [configuredPiAiDescriptor]),
      mutate: vi.fn(async () => {
        mutateCalls += 1
        if (mutateCalls === 1) throw new Error('settings busy')
      }),
    }
    const credentials = {
      describe: vi.fn(async () => ({ configured: true, source: 'file', writable: true })),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => undefined),
    }
    const llm = llmWith([{ id: 'pi-ai', name: 'PI AI' }], [piAiEntry])
    const ctx = fakeCtx({ llm, settings, credentials })
    const row = (await loadProviderSettings(ctx)).rows[0]
    await expect(removeProviderSettings(ctx, row)).rejects.toThrow('settings busy')
    // Same (stale) target: the second unset is an idempotent no-op on the
    // already-removed key, and the settings unset lands this time.
    await removeProviderSettings(ctx, row)
    expect(credentials.unset).toHaveBeenCalledTimes(2)
    expect(settings.mutate).toHaveBeenCalledTimes(2)
    expect(settings.mutate).toHaveBeenLastCalledWith('llm-pi-ai', [{ op: 'unset', path: ['providers', 'pi-ai'] }])
  })
})
