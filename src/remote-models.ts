/**
 * Remote model catalog overlay for subscription providers, following the
 * pi agent's remote-catalog pattern: a static built-in catalog stays the
 * floor, a per-provider network fetch overlays fresh entries on top, and
 * a cache window avoids re-fetching on every panel open. Network failures
 * keep the static list — discovery never blocks the panel.
 *
 * Codex uses pi's public catalog, with its local models-store.json as an
 * offline fallback. Neither source is a credential store. Only validated
 * model profile fields cross into the Harness configuration boundary.
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
/** Public pi catalog for all model types (only Codex chat models pass validation). */
const CODEX_CATALOG_URL = 'https://pi.dev/api/models/providers/openai-codex?types=chat%2Cimage%2Cclassifier'
const PI_MODELS_STORE_PATH = join(homedir(), '.pi', 'agent', 'models-store.json')
const CODEX_API = 'openai-codex-responses'
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api'
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** One model discovered from a provider's live API. */
export interface RemoteModel {
  readonly id: string
  readonly name: string
}

/** Whitelisted fields accepted by Harness's pi-ai model profile. */
export interface CodexModelProfile {
  readonly id: string
  readonly name: string
  readonly contextWindow: number
  readonly maxTokens: number
  readonly input: readonly ('text' | 'image')[]
  readonly reasoningEfforts: false | Readonly<Partial<Record<typeof THINKING_LEVELS[number], string>>>
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

/** Only these pi catalog facts may enter a Harness model profile. */
function codexProfile(value: unknown): CodexModelProfile | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (row.provider !== 'openai-codex' || row.api !== CODEX_API || row.baseUrl !== CODEX_BASE_URL) return undefined
  if (row.type !== undefined && row.type !== 'chat') return undefined
  if (typeof row.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(row.id)) return undefined
  if (typeof row.name !== 'string' || row.name.length === 0 || row.name.length > 160
    || [...row.name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return undefined
  if (!Array.isArray(row.input) || row.input.length === 0
    || row.input.some(input => input !== 'text' && input !== 'image')) return undefined
  if (!Number.isSafeInteger(row.contextWindow) || (row.contextWindow as number) <= 0
    || !Number.isSafeInteger(row.maxTokens) || (row.maxTokens as number) <= 0) return undefined
  if (row.reasoning !== undefined && typeof row.reasoning !== 'boolean') return undefined
  if (row.thinkingLevelMap !== undefined && (typeof row.thinkingLevelMap !== 'object'
    || row.thinkingLevelMap === null || Array.isArray(row.thinkingLevelMap))) return undefined
  if (row.reasoning === undefined && row.thinkingLevelMap === undefined) return undefined
  const levels = (row.thinkingLevelMap ?? {}) as Record<string, unknown>
  for (const [level, wire] of Object.entries(levels)) {
    if (!THINKING_LEVELS.some(known => known === level)) return undefined
    if (wire !== null && (typeof wire !== 'string' || wire.length === 0)) return undefined
  }
  // pi's map is sparse: null disables a level, ordinary missing levels use
  // identity dispatch, and xhigh/max require an explicit mapping. Codex's
  // implicit off dispatch is "none", not Harness's null (omit the parameter).
  const efforts: Record<string, string> = {}
  for (const level of THINKING_LEVELS) {
    const wire = levels[level]
    if (wire === null || ((level === 'xhigh' || level === 'max') && wire === undefined)) continue
    efforts[level] = typeof wire === 'string' ? wire : level === 'off' ? 'none' : level
  }
  if (row.reasoning !== false && !Object.keys(efforts).some(level => level !== 'off')) return undefined
  return {
    id: row.id,
    name: row.name,
    contextWindow: row.contextWindow as number,
    maxTokens: row.maxTokens as number,
    input: row.input.map((input: unknown): 'text' | 'image' => input === 'image' ? 'image' : 'text'),
    reasoningEfforts: row.reasoning === false ? false : efforts,
  }
}

function parseCodexCatalog(value: unknown): readonly CodexModelProfile[] {
  if (!Array.isArray(value)) return []
  const models = new Map<string, CodexModelProfile>()
  for (const valueRow of value) {
    const profile = codexProfile(valueRow)
    if (profile !== undefined && !models.has(profile.id)) models.set(profile.id, profile)
  }
  return [...models.values()]
}

/** Read pi's public-catalog cache only; never open its credential file. */
function cachedPiCatalog(): readonly CodexModelProfile[] {
  try {
    const stored: unknown = JSON.parse(readFileSync(PI_MODELS_STORE_PATH, 'utf8'))
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return []
    const entry: unknown = (stored as Record<string, unknown>)['openai-codex']
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    return parseCodexCatalog((entry as Record<string, unknown>).models)
  } catch {
    return []
  }
}

let codexCache: { fetchedAt: number; models: readonly CodexModelProfile[] } | undefined

/** Fetch pi's public catalog; use its validated local cache when offline. */
export async function fetchCodexCatalog(refresh = false): Promise<readonly CodexModelProfile[]> {
  const now = Date.now()
  if (!refresh && codexCache !== undefined && now - codexCache.fetchedAt < CACHE_TTL_MS) return codexCache.models
  try {
    const response = await fetch(CODEX_CATALOG_URL, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (response.ok) {
      const body: unknown = await response.json()
      const models = parseCodexCatalog(body)
      if (models.length > 0) {
        codexCache = { fetchedAt: now, models }
        return models
      }
    }
  } catch {
    // Network errors never hide a valid local catalog.
  }
  // A failed refresh must not replace the last successful remote directory
  // with an older, independently maintained pi cache.
  return codexCache?.models ?? cachedPiCatalog()
}

/** Backward-compatible display rows while callers move to rich model profiles. */
export async function fetchCodexModels(): Promise<readonly RemoteModel[]> {
  return (await fetchCodexCatalog()).map(model => ({ id: model.id, name: model.name }))
}
