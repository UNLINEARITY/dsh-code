/**
 * Remote model catalog overlay for subscription providers, following the
 * pi agent's remote-catalog pattern: a static built-in catalog stays the
 * floor, a per-provider network fetch overlays fresh entries on top, and
 * a cache window avoids re-fetching on every panel open. Network failures
 * keep the static list — discovery never blocks the panel.
 *
 * Codex (OpenAI ChatGPT Plus/Pro subscription): the OAuth credential pi's
 * login flow persists at ~/.pi/agent/auth.json carries the access token;
 * the Codex backend serves its live model catalog at
 * chatgpt.com/backend-api/codex/models.
 *
 * @module @deepseek-ai/dsh-tui/remote-models
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Cache window: one fetch per provider per session span (4h, pi's interval). */
const CACHE_TTL_MS = 4 * 60 * 60 * 1000
/** Per-attempt timeout: a slow catalog must not stall the panel load. */
const FETCH_TIMEOUT_MS = 4_000
/** Codex backend model-catalog endpoint (from the Codex CLI source). */
const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'
/** Where pi persists OAuth credentials. */
const PI_AUTH_PATH = join(homedir(), '.pi', 'agent', 'auth.json')

/** One model discovered from a provider's live API. */
export interface RemoteModel {
  readonly id: string
  readonly name: string
}

interface CacheEntry {
  readonly fetchedAt: number
  readonly models: readonly RemoteModel[]
}

/** In-memory per-process cache; one successful fetch serves the window. */
const cache = new Map<string, CacheEntry>()

/** Resolve from cache when fresh enough, otherwise undefined (caller fetches). */
function cached(key: string, now: number): readonly RemoteModel[] | undefined {
  const entry = cache.get(key)
  if (entry === undefined) return undefined
  if (now - entry.fetchedAt >= CACHE_TTL_MS) return undefined
  return entry.models
}

/** Store a successful fetch. */
function store(key: string, models: readonly RemoteModel[], now: number): void {
  cache.set(key, { fetchedAt: now, models })
}

/**
 * Merge a remote overlay into a static baseline (pi's mergeModels): a remote
 * entry with the same id replaces the static one; a remote-only id appends.
 * The static floor survives every network outcome.
 */
export function mergeModelIds(baseline: readonly string[], remote: readonly RemoteModel[]): readonly string[] {
  const merged = [...baseline]
  for (const model of remote) {
    const index = merged.indexOf(model.id)
    if (index >= 0) merged[index] = model.id
    else merged.push(model.id)
  }
  return merged
}

/**
 * Fetch the DeepSeek Account subscription's current model list from the live
 * API. The kernel's `deepseekAccount` service holds the OAuth token; the
 * public API root serves `/models` (OpenAI-compatible `data` array). Every
 * failure path returns an empty overlay — the static catalog stays visible.
 */
export async function fetchDeepSeekAccountModels(
  resolveToken: (url: string) => Promise<string | undefined>,
  baseURL = 'https://api.deepseek.com',
): Promise<readonly RemoteModel[]> {
  const now = Date.now()
  const key = `deepseek-account:${baseURL}`
  const hit = cached(key, now)
  if (hit !== undefined) return hit
  try {
    const token = await resolveToken(baseURL)
    if (token === undefined) return []
    const response = await fetch(`${baseURL}/models`, {
      headers: { 'x-dsh-auth-token': token },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return []
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) return []
    const data: unknown = (body as { readonly data?: unknown }).data
    if (!Array.isArray(data)) return []
    const models: RemoteModel[] = []
    for (const entry of data) {
      if (typeof entry !== 'object' || entry === null) continue
      const id = (entry as { readonly id?: unknown }).id
      if (typeof id !== 'string' || id === '') continue
      models.push({ id, name: id })
    }
    store(key, models, now)
    return models
  } catch {
    return []
  }
}

/**
 * Read the Codex OAuth access token pi's login flow persisted. Returns
 * undefined when the credential is absent or expired — the caller treats
 * that as "no overlay" and keeps the static catalog.
 */
function readCodexToken(): string | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(PI_AUTH_PATH, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return undefined
    const credential = (raw as Record<string, unknown>)['openai-codex']
    if (typeof credential !== 'object' || credential === null) return undefined
    const access = (credential as { readonly access?: unknown }).access
    if (typeof access !== 'string' || access === '') return undefined
    const expires = (credential as { readonly expires?: unknown }).expires
    if (typeof expires === 'number' && expires <= Date.now()) return undefined
    return access
  } catch {
    return undefined
  }
}

/**
 * Fetch the Codex subscription's live model catalog from the ChatGPT
 * backend. The response carries model metadata beyond the plain id; the
 * slug (or id) names each selectable entry. Every failure path returns
 * an empty overlay — the static catalog stays visible.
 */
export async function fetchCodexModels(): Promise<readonly RemoteModel[]> {
  const now = Date.now()
  const key = 'openai-codex'
  const hit = cached(key, now)
  if (hit !== undefined) return hit
  const token = readCodexToken()
  if (token === undefined) return []
  try {
    const response = await fetch(CODEX_MODELS_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return []
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) return []
    const data: unknown = (body as { readonly data?: unknown }).data ?? (body as { readonly models?: unknown }).models
    if (!Array.isArray(data)) return []
    const models: RemoteModel[] = []
    for (const entry of data) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      const id = typeof record.slug === 'string' && record.slug !== '' ? record.slug
        : typeof record.id === 'string' && record.id !== '' ? record.id
        : undefined
      if (id === undefined) continue
      const label = typeof record.label === 'string' && record.label !== '' ? record.label
        : typeof record.name === 'string' && record.name !== '' ? record.name
        : id
      models.push({ id, name: label })
    }
    store(key, models, now)
    return models
  } catch {
    return []
  }
}
