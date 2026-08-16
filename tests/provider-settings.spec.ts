/**
 * Provider-management adapter: directory join, credential writes, and profile
 * removal with official web ordering and bounded, key-free errors.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  ProviderSettingsError,
  deriveCredentialRef,
  loadProviderSettings,
  removeProviderSettings,
  saveProviderCredential,
  subscribeProviderSettings,
  unsetProviderCredential,
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
    for (const event of ['credentials/updated', 'settings/document-updated', 'llm/adapters-updated']) {
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
    const row = directory.rows[0]!
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
    const row = directory.rows[0]!
    expect(row.active).toBe(false)
    expect(row.configured).toBe(false)
    expect(row.removable).toBe(false)
    expect(row.credentialRef).toBeUndefined()
    expect(row.suggestedRef).toBe('PI_AI_API_KEY')
    expect(row.credential).toBeUndefined()
    expect(credentials.describe).not.toHaveBeenCalled()
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
    const row = directory.rows[0]!
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
    const row = directory.rows[0]!
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
    expect(directory.rows[0]!.credential).toEqual({ kind: 'facts', configured: true, source: 'file', writable: true })
    expect(directory.rows[1]!.credential).toEqual({ kind: 'error', message: 'credentials store offline' })
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
    expect(directory.rows[0]!.active).toBe(true)
    expect(directory.rows[1]!.active).toBe(false)
  })

  it('reports a bounded error for a named ref when the credentials service is absent', async () => {
    const settings = {
      writable: true,
      describe: vi.fn(() => [deepseekDescriptor]),
      mutate: vi.fn(async () => undefined),
    }
    const llm = llmWith([{ id: 'deepseek-official', name: 'DeepSeek' }], [deepseekEntry])
    const directory = await loadProviderSettings(fakeCtx({ llm, settings }))
    expect(directory.rows[0]!.credentialRef).toBe('DEEPSEEK_API_KEY')
    expect(directory.rows[0]!.credential).toEqual({ kind: 'error', message: 'credentials service is unavailable' })
  })

  it('returns an empty directory when the llm service is unavailable', async () => {
    const directory = await loadProviderSettings(fakeCtx({}))
    expect(directory).toEqual({ rows: [], writable: false, failures: [] })
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
    const row = (await loadProviderSettings(ctx)).rows[0]!
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
    const row = (await loadProviderSettings(ctx)).rows[0]!
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
    const row = (await loadProviderSettings(ctx)).rows[0]!
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
    const row = (await loadProviderSettings(ctx)).rows[0]!
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
    const row = (await loadProviderSettings(ctx)).rows[0]!
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
    const row = (await loadProviderSettings(ctx)).rows[0]!
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
    const row = (await loadProviderSettings(ctx)).rows[0]!
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
    const row = (await loadProviderSettings(ctx)).rows[0]!
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
    const row = (await loadProviderSettings(ctx)).rows[0]!
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
    const dormant = (await loadProviderSettings(ctx)).rows[0]!
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
    const row = (await loadProviderSettings(ctx)).rows[0]!
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
    const row = (await loadProviderSettings(ctx)).rows[0]!
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
    const row = (await loadProviderSettings(ctx)).rows[0]!
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
    const row = (await loadProviderSettings(ctx)).rows[0]!
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
    const row = (await loadProviderSettings(ctx)).rows[0]!
    await expect(removeProviderSettings(ctx, row)).rejects.toThrow('settings busy')
    // Same (stale) target: the second unset is an idempotent no-op on the
    // already-removed key, and the settings unset lands this time.
    await removeProviderSettings(ctx, row)
    expect(credentials.unset).toHaveBeenCalledTimes(2)
    expect(settings.mutate).toHaveBeenCalledTimes(2)
    expect(settings.mutate).toHaveBeenLastCalledWith('llm-pi-ai', [{ op: 'unset', path: ['providers', 'pi-ai'] }])
  })
})
