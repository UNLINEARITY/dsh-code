/** Public Codex catalog and pi cache are advisory, validated before use. */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }))

const model = {
  id: 'gpt-6.1-sol',
  name: 'GPT-6.1 Sol',
  provider: 'openai-codex',
  api: 'openai-codex-responses',
  baseUrl: 'https://chatgpt.com/backend-api',
  input: ['text', 'image'],
  contextWindow: 272000,
  maxTokens: 128000,
  thinkingLevelMap: { off: null, low: 'low', high: 'high' },
  compat: { unwanted: 'must not cross the boundary' },
}

const profile = {
  id: 'gpt-6.1-sol',
  name: 'GPT-6.1 Sol',
  contextWindow: 272000,
  maxTokens: 128000,
  input: ['text', 'image'],
  reasoningEfforts: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-30T00:00:00Z'))
  vi.mocked(readFileSync).mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('fetchCodexCatalog', () => {
  it('expands sparse pi mappings into every supported Harness effort', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [
      { ...model, thinkingLevelMap: { minimal: 'low', xhigh: 'xhigh' } },
    ] })))
    const { fetchCodexCatalog } = await import('../src/remote-models.ts')
    expect(await fetchCodexCatalog()).toEqual([{
      ...profile,
      reasoningEfforts: { off: 'none', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
    }])
  })

  it('uses the public pi.dev catalog without credentials or redirects and whitelists fields', async () => {
    const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => ({ ok: true, json: async () => [model] }))
    vi.stubGlobal('fetch', fetcher)
    const { fetchCodexCatalog } = await import('../src/remote-models.ts')
    expect(await fetchCodexCatalog()).toEqual([profile])
    expect(fetcher).toHaveBeenCalledWith(
      'https://pi.dev/api/models/providers/openai-codex?types=chat%2Cimage%2Cclassifier',
      expect.objectContaining({ redirect: 'error' }),
    )
    const options = fetcher.mock.calls[0]?.[1]
    expect(Object.keys(options?.headers ?? {}).map(key => key.toLowerCase())).not.toContain('authorization')
    expect(vi.mocked(readFileSync)).not.toHaveBeenCalled()
  })

  it('rejects cross-provider, wrong protocol, wrong endpoint, malformed capacities and efforts', async () => {
    const invalid = [
      { ...model, id: 'wrong-provider', provider: 'openai' },
      { ...model, id: 'wrong-api', api: 'openai-responses' },
      { ...model, id: 'wrong-endpoint', baseUrl: 'https://evil.example' },
      { ...model, id: 'wrong-input', input: ['audio'] },
      { ...model, id: 'wrong-capacity', contextWindow: -1 },
      { ...model, id: 'wrong-output', maxTokens: '128000' },
      { ...model, id: 'wrong-effort', thinkingLevelMap: { high: 42 } },
      { ...model, id: 'unknown-effort', thinkingLevelMap: { super: 'super' } },
      { ...model, id: 'empty-effort', thinkingLevelMap: { high: '' } },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [...invalid, model] })))
    const { fetchCodexCatalog } = await import('../src/remote-models.ts')
    expect(await fetchCodexCatalog()).toEqual([profile])
  })

  it('preserves an explicitly offered off effort but does not turn null into an offered effort', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [
      { ...model, id: 'gpt-6-sol', thinkingLevelMap: { off: 'none', high: 'high' } }, model,
    ] })))
    const { fetchCodexCatalog } = await import('../src/remote-models.ts')
    expect(await fetchCodexCatalog()).toEqual([
      { ...profile, id: 'gpt-6-sol', reasoningEfforts: { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' } }, profile,
    ])
  })

  it('respects null on every level without rejecting the whole model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [
      { ...model, thinkingLevelMap: { off: null, minimal: null, low: null, medium: 'medium', high: 'high', xhigh: null, max: null } },
    ] })))
    const { fetchCodexCatalog } = await import('../src/remote-models.ts')
    expect(await fetchCodexCatalog()).toEqual([{ ...profile, reasoningEfforts: { medium: 'medium', high: 'high' } }])
  })

  it('supports reasoning models without an override map and non-reasoning models', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [
      { ...model, reasoning: true, thinkingLevelMap: undefined },
      { ...model, id: 'chat-only', reasoning: false, thinkingLevelMap: undefined },
    ] })))
    const { fetchCodexCatalog } = await import('../src/remote-models.ts')
    expect(await fetchCodexCatalog()).toEqual([
      { ...profile, reasoningEfforts: { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' } },
      { ...profile, id: 'chat-only', reasoningEfforts: false },
    ])
  })

  it('restores validated pi models-store.json entries when network fails without reading auth.json', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ 'openai-codex': { models: [
      { ...model, id: 'unsafe', provider: 'other' }, model,
    ] } }))
    const { fetchCodexCatalog, fetchCodexModels } = await import('../src/remote-models.ts')
    expect(await fetchCodexCatalog()).toEqual([profile])
    expect(await fetchCodexModels()).toEqual([{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }])
    expect(vi.mocked(readFileSync)).toHaveBeenCalledWith(
      expect.stringMatching(/[/\\]\.pi[/\\]agent[/\\]models-store\.json$/), 'utf8',
    )
    expect(vi.mocked(readFileSync).mock.calls.some(([path]) => String(path).includes('auth.json'))).toBe(false)
  })

  it('reuses a successful catalog for four hours then refreshes', async () => {
    const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => ({ ok: true, json: async () => [model] }))
    vi.stubGlobal('fetch', fetcher)
    const { fetchCodexCatalog } = await import('../src/remote-models.ts')
    await fetchCodexCatalog()
    await fetchCodexCatalog()
    expect(fetcher).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(4 * 60 * 60 * 1000)
    await fetchCodexCatalog()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('refreshes on demand before the TTL and retains the last good catalog on failure', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [model] })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ ...model, id: 'new-model' }] })
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetcher)
    const { fetchCodexCatalog } = await import('../src/remote-models.ts')
    expect(await fetchCodexCatalog()).toEqual([profile])
    expect(await fetchCodexCatalog(true)).toEqual([{ ...profile, id: 'new-model' }])
    expect(await fetchCodexCatalog(true)).toEqual([{ ...profile, id: 'new-model' }])
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('keeps the last successful directory when an offline refresh finds an older local catalog', async () => {
    const latest = { ...model, id: 'new-model' }
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [model, latest] })
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetcher)
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ 'openai-codex': { models: [model] } }))
    const { fetchCodexCatalog } = await import('../src/remote-models.ts')
    const expected = [profile, { ...profile, id: 'new-model' }]
    expect(await fetchCodexCatalog()).toEqual(expected)
    expect(await fetchCodexCatalog(true)).toEqual(expected)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('only offers xhigh and max when explicitly mapped and preserves their wire values', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [
      { ...model, thinkingLevelMap: { off: 'none', minimal: null, high: 'max', xhigh: 'high', max: 'max' } },
    ] })))
    const { fetchCodexCatalog } = await import('../src/remote-models.ts')
    expect(await fetchCodexCatalog()).toEqual([{
      ...profile,
      reasoningEfforts: { off: 'none', low: 'low', medium: 'medium', high: 'max', xhigh: 'high', max: 'max' },
    }])
  })

  it('rejects a reasoning model that disables every thinking level', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [{
      ...model,
      reasoning: true,
      thinkingLevelMap: { off: 'none', minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
    }] })))
    const { fetchCodexCatalog } = await import('../src/remote-models.ts')
    expect(await fetchCodexCatalog()).toEqual([])
  })

  it('ignores malformed network payloads and malformed cache entries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [model] }) })))
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ 'openai-codex': { models: [
      { ...model, baseUrl: 'https://evil.example' },
    ] } }))
    const { fetchCodexCatalog } = await import('../src/remote-models.ts')
    expect(await fetchCodexCatalog()).toEqual([])
  })
})

describe('fetchDeepSeekAccountModels', () => {
  it('keeps the existing credential and /models discovery behavior', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: 'deepseek-v4' }] }) }))
    vi.stubGlobal('fetch', fetcher)
    const { fetchDeepSeekAccountModels } = await import('../src/remote-models.ts')
    expect(await fetchDeepSeekAccountModels(async () => 'test-token')).toEqual([{ id: 'deepseek-v4', name: 'deepseek-v4' }])
    expect(fetcher).toHaveBeenCalledWith('https://api.deepseek.com/models', expect.objectContaining({
      headers: { 'x-dsh-auth-token': 'test-token' },
    }))
  })
})
