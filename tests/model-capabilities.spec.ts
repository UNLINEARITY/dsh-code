/**
 * Same-id reasoning-capability inheritance: pure planning rules and the
 * settings-backed applier with fake services.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  planCapabilitySync,
  resetCapabilitySyncState,
  syncModelCapabilities,
  type CapabilityProfileSource,
} from '../src/model-capabilities.ts'
import type { ModelRow } from '../src/models.ts'

/** A context serving exactly the fakes given, by service name. */
function fakeCtx(services: Record<string, unknown>): Context {
  const provided = new Map(Object.entries(services))
  return { get: (name: string): unknown => provided.get(name) } as unknown as Context
}

/** One advertised-effort row shaped like the live directory's. */
function row(provider: string, model: string, levels: readonly string[]): ModelRow {
  return {
    provider,
    providerName: provider,
    model,
    modelName: model,
    ...levels.length === 0 ? {} : {
      reasoning: { efforts: levels.map(id => ({ id, name: id })) },
    },
  }
}

/** A pi-ai profile source addressed for mutation. */
function profile(provider: string, models: readonly Record<string, unknown>[]): CapabilityProfileSource {
  return { settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider], revision: 1, models }
}

beforeEach(() => {
  resetCapabilitySyncState()
})

describe('planCapabilitySync', () => {
  it('copies a sibling settings declaration verbatim, dialect wire spellings included', () => {
    const zai = profile('zai', [{ id: 'glm-5.2', reasoningEfforts: { low: 'high', high: 'high', max: 'max' } }])
    const bqy = profile('bqy', [{ id: 'glm-5.2' }])
    const plans = planCapabilitySync({ rows: [], profiles: new Map([['zai', zai], ['bqy', bqy]]) })
    expect(plans).toHaveLength(1)
    expect(plans[0]!.provider).toBe('bqy')
    expect(plans[0]!.models).toEqual([{ id: 'glm-5.2', reasoningEfforts: { low: 'high', high: 'high', max: 'max' } }])
    expect(plans[0]!.inherited).toEqual(['glm-5.2'])
    expect(plans[0]!.sources).toEqual(['zai/glm-5.2'])
  })

  it('maps an advertised donor row by identity: off sends nothing, levels keep their names', () => {
    const bqy = profile('bqy', [{ id: 'gpt-5.5' }])
    const plans = planCapabilitySync({ rows: [row('openai', 'gpt-5.5', ['off', 'low', 'medium', 'high'])], profiles: new Map([['bqy', bqy]]) })
    expect(plans).toHaveLength(1)
    expect(plans[0]!.models).toEqual([{ id: 'gpt-5.5', reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' } }])
    expect(plans[0]!.sources).toEqual(['openai/gpt-5.5'])
  })

  it('prefers a sibling declaration over an advertised row for the same id', () => {
    const zai = profile('zai', [{ id: 'glm-5.2', reasoningEfforts: { high: 'high' } }])
    const bqy = profile('bqy', [{ id: 'glm-5.2' }])
    const rows = [row('openai', 'glm-5.2', ['low', 'medium'])]
    const plans = planCapabilitySync({ rows, profiles: new Map([['zai', zai], ['bqy', bqy]]) })
    expect(plans[0]!.models[0]!.reasoningEfforts).toEqual({ high: 'high' })
    expect(plans[0]!.sources).toEqual(['zai/glm-5.2'])
  })

  it('never touches an explicit dict or false declaration', () => {
    const declared = profile('a', [{ id: 'm', reasoningEfforts: { high: 'high' } }])
    const disabled = profile('b', [{ id: 'm', reasoningEfforts: false }])
    const rows = [row('openai', 'm', ['low', 'high'])]
    const plans = planCapabilitySync({ rows, profiles: new Map([['a', declared], ['b', disabled]]) })
    expect(plans).toEqual([])
  })

  it('skips an entry whose live row already advertises efforts (catalog inheritance)', () => {
    const zai = profile('zai', [{ id: 'glm-5.2' }])
    const rows = [row('zai', 'glm-5.2', ['low', 'high'])]
    const plans = planCapabilitySync({ rows, profiles: new Map([['zai', zai]]) })
    expect(plans).toEqual([])
  })

  it('plans nothing without a donor, or when the only donor row offers just off', () => {
    const alone = profile('a', [{ id: 'kimi-k4' }])
    const offOnly = profile('b', [{ id: 'm2' }])
    const rows = [row('x', 'm2', ['off'])]
    expect(planCapabilitySync({ rows, profiles: new Map([['a', alone]]) })).toEqual([])
    expect(planCapabilitySync({ rows, profiles: new Map([['b', offOnly]]) })).toEqual([])
  })

  it('treats an empty declaration dict as absent and falls through to an advertised donor', () => {
    const declared = profile('a', [{ id: 'm', reasoningEfforts: {} }])
    const target = profile('b', [{ id: 'm' }])
    const rows = [row('openai', 'm', ['high'])]
    const plans = planCapabilitySync({ rows, profiles: new Map([['a', declared], ['b', target]]) })
    expect(plans[0]!.models[0]!.reasoningEfforts).toEqual({ high: 'high' })
  })

  it('preserves untouched entries, fields, and key order in the merged array', () => {
    const bqy = profile('bqy', [
      { id: 'first', name: 'First' },
      { id: 'gpt-5.5', name: 'GPT', contextWindow: 272000 },
      { id: 'last', compat: { supportsStore: false } },
    ])
    const rows = [row('openai', 'gpt-5.5', ['low', 'high'])]
    const plans = planCapabilitySync({ rows, profiles: new Map([['bqy', bqy]]) })
    const models = plans[0]!.models
    expect(models).toHaveLength(3)
    expect(models[0]).toEqual({ id: 'first', name: 'First' })
    expect(Object.keys(models[1]!)).toEqual(['id', 'name', 'contextWindow', 'reasoningEfforts'])
    expect(models[2]).toEqual({ id: 'last', compat: { supportsStore: false } })
  })

  it('emits one plan per provider that inherits, none for providers that do not', () => {
    const zai = profile('zai', [{ id: 'glm-5.2', reasoningEfforts: { high: 'high' } }])
    const bqy = profile('bqy', [{ id: 'glm-5.2' }])
    const relay = profile('relay', [{ id: 'glm-5.2' }, { id: 'solo' }])
    const clean = profile('clean', [{ id: 'other', reasoningEfforts: false }])
    const plans = planCapabilitySync({ rows: [], profiles: new Map([['zai', zai], ['bqy', bqy], ['relay', relay], ['clean', clean]]) })
    expect(plans.map(plan => plan.provider)).toEqual(['bqy', 'relay'])
    expect(plans[1]!.inherited).toEqual(['glm-5.2'])
    expect(plans[1]!.sources).toEqual(['zai/glm-5.2'])
  })
})

describe('syncModelCapabilities', () => {
  /** Fake llm: zai's glm-5.2 advertises efforts, bqy's does not. */
  const llmAdvertised = {
    listProviders: () => [{ id: 'zai', name: 'Zai' }, { id: 'bqy', name: 'BQY' }],
    listModels: async () => [{ id: 'glm-5.2', name: 'GLM-5.2' }],
    resolveModelInfo: async (provider: string, _model: string) =>
      provider === 'zai' ? { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } } : {},
    listConfigurableProviders: () => [
      { provider: 'zai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'zai'] },
      { provider: 'bqy', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'bqy'] },
      { provider: 'deepseek-official', settingsNs: 'llm-deepseek', settingsPath: [] },
    ],
  }

  it('materializes an identity declaration for an undeclared relay model and notices', async () => {
    const settings = {
      describe: vi.fn(() => [{
        ns: 'llm-pi-ai',
        revision: 9,
        value: {
          providers: {
            zai: { models: [{ id: 'glm-5.2', name: 'GLM-5.2' }] },
            bqy: { models: [{ id: 'glm-5.2' }] },
          },
        },
      }]),
      mutate: vi.fn(async () => undefined),
    }
    const notices: Array<[string, string | undefined]> = []
    await syncModelCapabilities(fakeCtx({ llm: llmAdvertised, settings }), (text, tone) => notices.push([text, tone]))
    expect(settings.mutate).toHaveBeenCalledTimes(1)
    expect(settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'bqy', 'models'], value: [{ id: 'glm-5.2', reasoningEfforts: { low: 'low', high: 'high' } }] },
    ], 9)
    expect(notices).toHaveLength(1)
    expect(notices[0]![0]).toContain('bqy')
    expect(notices[0]![1]).toBe('info')
    // The fingerprint suppresses a redundant rewrite of the same value.
    await syncModelCapabilities(fakeCtx({ llm: llmAdvertised, settings }), (text, tone) => notices.push([text, tone]))
    expect(settings.mutate).toHaveBeenCalledTimes(1)
  })

  it('copies a sibling declaration verbatim through the applier', async () => {
    const settings = {
      describe: vi.fn(() => [{
        ns: 'llm-pi-ai',
        revision: 4,
        value: {
          providers: {
            zai: { models: [{ id: 'glm-5.2', reasoningEfforts: { low: 'high', high: 'high', max: 'max' } }] },
            bqy: { models: [{ id: 'glm-5.2' }] },
          },
        },
      }]),
      mutate: vi.fn(async () => undefined),
    }
    await syncModelCapabilities(fakeCtx({ llm: llmAdvertised, settings }))
    expect(settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'bqy', 'models'], value: [{ id: 'glm-5.2', reasoningEfforts: { low: 'high', high: 'high', max: 'max' } }] },
    ], 4)
  })

  it('degrades a rejected write to one warning notice and keeps the others going', async () => {
    let revisions = 5
    const settings = {
      describe: vi.fn(() => [{
        ns: 'llm-pi-ai',
        revision: revisions,
        value: {
          providers: {
            zai: { models: [{ id: 'shared', reasoningEfforts: { high: 'high' } }] },
            bqy: { models: [{ id: 'shared' }] },
            relay: { models: [{ id: 'shared' }] },
          },
        },
      }]),
      mutate: vi.fn(async (_ns: string, ops: readonly { path: readonly string[] }[]) => {
        revisions += 1
        if (ops[0]!.path[1] === 'bqy') throw new Error('settings busy')
      }),
    }
    const llmThree = {
      ...llmAdvertised,
      listProviders: () => [{ id: 'zai', name: 'Zai' }, { id: 'bqy', name: 'BQY' }, { id: 'relay', name: 'Relay' }],
      listModels: async () => [{ id: 'shared', name: 'Shared' }],
      listConfigurableProviders: () => [
        { provider: 'zai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'zai'] },
        { provider: 'bqy', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'bqy'] },
        { provider: 'relay', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'relay'] },
      ],
    }
    const notices: Array<[string, string | undefined]> = []
    await syncModelCapabilities(fakeCtx({ llm: llmThree, settings }), (text, tone) => notices.push([text, tone]))
    expect(settings.mutate).toHaveBeenCalledTimes(2)
    expect(notices.map(([, tone]) => tone).filter(tone => tone === 'warning')).toHaveLength(1)
    expect(notices.some(([text]) => text.includes('bqy') && text.includes('settings busy'))).toBe(true)
    expect(notices.some(([text, tone]) => text.includes('relay') && tone === 'info')).toBe(true)
  })

  it('returns silently when services are absent or the route has no models list', async () => {
    await expect(syncModelCapabilities(fakeCtx({}))).resolves.toBeUndefined()
    const settings = {
      describe: vi.fn(() => [{
        ns: 'llm-pi-ai',
        revision: 1,
        value: { providers: { dormant: { apiKeyEnv: 'X' } } },
      }]),
      mutate: vi.fn(async () => undefined),
    }
    const llmDormant = {
      ...llmAdvertised,
      listConfigurableProviders: () => [{ provider: 'dormant', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'dormant'] }],
      listModels: async () => [],
    }
    await expect(syncModelCapabilities(fakeCtx({ llm: llmDormant, settings }))).resolves.toBeUndefined()
    expect(settings.mutate).not.toHaveBeenCalled()
  })

  it('never rejects when the llm directory itself throws', async () => {
    const broken = {
      ...llmAdvertised,
      listModels: async () => { throw new Error('listing failed') },
    }
    const settings = {
      describe: vi.fn(() => [{ ns: 'llm-pi-ai', revision: 1, value: { providers: { bqy: { models: [{ id: 'glm-5.2' }] } } } }]),
      mutate: vi.fn(async () => undefined),
    }
    await expect(syncModelCapabilities(fakeCtx({ llm: broken, settings }))).resolves.toBeUndefined()
    expect(settings.mutate).not.toHaveBeenCalled()
  })
})
