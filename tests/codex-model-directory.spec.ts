import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

vi.mock('../src/remote-models.ts', () => ({
  fetchCodexCatalog: vi.fn(async () => [{
    id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', contextWindow: 272000, maxTokens: 128000,
    input: ['text', 'image'], reasoningEfforts: { high: 'high' },
  }]),
  fetchDeepSeekAccountModels: vi.fn(async () => []),
}))

import { activateModelCandidate, loadModelDirectory } from '../src/models.ts'
import { fetchCodexCatalog, type CodexModelProfile } from '../src/remote-models.ts'

const catalogCandidate: CodexModelProfile = {
  id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', contextWindow: 272000, maxTokens: 128000,
  input: ['text', 'image'], reasoningEfforts: { high: 'high' },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fetchCodexCatalog).mockResolvedValue([catalogCandidate])
})

describe('Codex candidate directory', () => {
  it('passes explicit refresh through to the public catalog', async () => {
    const llm = {
      listProviders: () => [{ id: 'openai-codex', name: 'Codex' }],
      listModels: async () => [],
    }
    const ctx = { get: (name: string) => name === 'llm' ? llm : undefined } as unknown as Context
    await loadModelDirectory(ctx, true)
    expect(fetchCodexCatalog).toHaveBeenLastCalledWith(true)
  })

  it('marks remote-only rows as candidates rather than treating missing capabilities as resolved', async () => {
    const llm = {
      listProviders: () => [{ id: 'openai-codex', name: 'Codex' }],
      listModels: async () => [{ id: 'gpt-6-sol', name: 'Installed Sol' }],
      resolveModelInfo: vi.fn(async (_provider: string, model: string) => {
        if (model !== 'gpt-6-sol') throw new Error('UNKNOWN_MODEL')
        return { id: model, name: model }
      }),
    }
    const ctx = { get: (name: string) => name === 'llm' ? llm : undefined } as unknown as Context
    const directory = await loadModelDirectory(ctx)
    expect(directory.rows).toEqual([
      { provider: 'openai-codex', providerName: 'Codex', model: 'gpt-6-sol', modelName: 'Installed Sol' },
      { provider: 'openai-codex', providerName: 'Codex', model: 'gpt-6.1-sol', modelName: 'GPT-6.1 Sol', candidate: true },
    ])
    expect(directory.reasoningFailures).toEqual([])
    expect(llm.resolveModelInfo).toHaveBeenCalledTimes(1)
  })

  it('still discovers and imports a later candidate after persisting the first import', async () => {
    const laterCandidate = { ...catalogCandidate, id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' }
    let configuredModels: readonly Record<string, unknown>[] | undefined
    let revision = 2
    const registeredModels = (): readonly Record<string, unknown>[] => configuredModels ?? [{ id: 'gpt-6-sol' }]
    const llm = {
      listProviders: () => [{ id: 'openai-codex', name: 'Codex' }],
      listConfigurableProviders: () => [{ provider: 'openai-codex', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai-codex'] }],
      listModels: async () => registeredModels().map(entry => ({ id: entry.id, name: entry.name ?? entry.id })),
      resolveModelInfo: vi.fn(async (_provider: string, model: string) => {
        if (!registeredModels().some(entry => entry.id === model)) throw new Error('UNKNOWN_MODEL')
        return { id: model, name: model, reasoning: { efforts: [{ id: 'high', name: 'High' }] } }
      }),
    }
    const settings = {
      writable: true,
      describe: () => [{
        ns: 'llm-pi-ai', revision,
        value: { providers: { 'openai-codex': configuredModels === undefined ? {} : { models: configuredModels } } },
      }],
      mutate: vi.fn(async (_ns: string, ops: readonly { op: string; path: readonly string[]; value?: unknown }[], expectedRevision: number) => {
        expect(expectedRevision).toBe(revision)
        const modelsOp = ops.find(op => op.op === 'set' && op.path.join('/') === 'providers/openai-codex/models')
        expect(modelsOp).toBeDefined()
        configuredModels = modelsOp!.value as readonly Record<string, unknown>[]
        revision += 1
      }),
    }
    const ctx = { get: (name: string) => name === 'llm' ? llm : name === 'settings' ? settings : undefined } as unknown as Context
    const first = (await loadModelDirectory(ctx)).rows.find(row => row.candidate)
    expect(first).toBeDefined()
    expect((await activateModelCandidate(ctx, first!)).candidate).toBeUndefined()
    expect(configuredModels).toEqual([{ id: 'gpt-6-sol' }, catalogCandidate])

    vi.mocked(fetchCodexCatalog).mockResolvedValue([catalogCandidate, laterCandidate])
    const refreshed = await loadModelDirectory(ctx, true)
    expect(fetchCodexCatalog).toHaveBeenLastCalledWith(true)
    expect(refreshed.rows.find(row => row.model === catalogCandidate.id)?.candidate).toBeUndefined()
    const later = refreshed.rows.find(row => row.model === laterCandidate.id)
    expect(later?.candidate).toBe(true)
    expect((await activateModelCandidate(ctx, later!)).candidate).toBeUndefined()
    expect(settings.mutate).toHaveBeenCalledTimes(2)
    expect(configuredModels).toEqual([{ id: 'gpt-6-sol' }, catalogCandidate, laterCandidate])
    expect((await loadModelDirectory(ctx)).rows.map(row => row.candidate)).toEqual([undefined, undefined, undefined])
  })

  it('adopts the candidate through settings before returning its registry row', async () => {
    let adopted = false
    const llm = {
      listProviders: () => [{ id: 'openai-codex', name: 'Codex' }],
      listConfigurableProviders: () => [{ provider: 'openai-codex', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai-codex'] }],
      listModels: async () => adopted
        ? [{ id: 'gpt-6-sol', name: 'Installed Sol' }, { id: 'gpt-6.1-sol', name: 'Registered 6.1' }]
        : [{ id: 'gpt-6-sol', name: 'Installed Sol' }],
      resolveModelInfo: async (_provider: string, model: string) => {
        if (model === 'gpt-6.1-sol' && !adopted) throw new Error('UNKNOWN_MODEL')
        return { id: model, name: model, reasoning: { efforts: [{ id: 'high', name: 'High' }] } }
      },
    }
    const settings = {
      writable: true,
      describe: () => [{ ns: 'llm-pi-ai', revision: 2, value: { providers: { 'openai-codex': {} } } }],
      mutate: vi.fn(async () => { adopted = true }),
    }
    const ctx = { get: (name: string) => name === 'llm' ? llm : name === 'settings' ? settings : undefined } as unknown as Context
    const candidate = (await loadModelDirectory(ctx)).rows.find(row => row.candidate)
    expect(candidate).toBeDefined()
    const ready = await activateModelCandidate(ctx, candidate!)
    expect(settings.mutate).toHaveBeenCalledOnce()
    expect(ready).toEqual({
      provider: 'openai-codex', providerName: 'Codex', model: 'gpt-6.1-sol', modelName: 'Registered 6.1',
      reasoning: { efforts: [{ id: 'high', name: 'High' }] },
    })
  })
})
