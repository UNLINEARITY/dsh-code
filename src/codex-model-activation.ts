/** Adopt an explicitly selected Codex catalog candidate into Harness's live pi-ai route. */
import type { Context } from '@deepseek-ai/cordis'
import type { CodexModelProfile } from './remote-models.ts'

interface Profile {
  readonly models?: readonly Record<string, unknown>[]
  readonly modelOverrides?: Readonly<Record<string, Record<string, unknown>>>
}

interface ActivationPlan {
  readonly models: readonly Record<string, unknown>[]
  readonly clearOverrides: boolean
}

/** A non-empty models list REPLACES the installed catalog: carry its ids and customizations forward. */
export function planCodexModelActivation(input: {
  readonly registered: readonly string[]
  readonly profile: Profile
  readonly candidate: CodexModelProfile
}): ActivationPlan | undefined {
  const { registered, profile, candidate } = input
  if (registered.includes(candidate.id)) return undefined
  const explicit = profile.models ?? []
  const overrides = profile.modelOverrides ?? {}
  if (explicit.length > 0 && Object.keys(overrides).length > 0) {
    throw new Error('Codex provider has both models and modelOverrides; repair its settings first')
  }
  if (overrides[candidate.id] !== undefined) {
    throw new Error(`Codex model ${candidate.id} has a conflicting modelOverride; repair its settings first`)
  }
  const clearOverrides = Object.keys(overrides).length > 0
  const models = explicit.length > 0
    ? explicit.map(entry => ({ ...entry }))
    : registered.map(id => ({ id, ...overrides[id] }))
  if (models.some(entry => entry.id === candidate.id)) {
    throw new Error(`Codex model ${candidate.id} is configured but is not serviceable; repair its provider settings first`)
  }
  return { models: [...models, { ...candidate }], clearOverrides }
}

interface CodexLlm {
  listConfigurableProviders(): readonly {
    readonly provider: string
    readonly settingsNs: string
    readonly settingsPath: readonly string[]
  }[]
  listModels(provider: string): Promise<readonly { readonly id: string }[]>
  resolveModelInfo(provider: string, model: string): Promise<unknown>
}

interface CodexSettings {
  readonly writable: boolean
  describe(options?: { readonly redactSecrets?: boolean }): readonly {
    readonly ns: string
    readonly value: unknown
    readonly revision: number
  }[]
  mutate(ns: string, ops: readonly {
    readonly op: 'set' | 'unset'
    readonly path: readonly string[]
    readonly value?: unknown
  }[], revision: number): Promise<void>
}

function atPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Enter on a candidate is the only operation that persists an adopted model. */
export async function activateCodexModel(ctx: Context, candidate: CodexModelProfile): Promise<void> {
  const llm = ctx.get('llm') as CodexLlm | undefined
  const settings = ctx.get('settings') as CodexSettings | undefined
  if (llm?.listConfigurableProviders === undefined || settings === undefined) {
    throw new Error('Codex provider configuration is unavailable in this profile')
  }
  if (!settings.writable) throw new Error('Codex provider settings are read-only')
  const route = llm.listConfigurableProviders().find(entry =>
    entry.provider === 'openai-codex' && entry.settingsNs === 'llm-pi-ai')
  if (route === undefined || route.settingsPath.length !== 2
    || route.settingsPath[0] !== 'providers' || route.settingsPath[1] !== 'openai-codex') {
    throw new Error('Codex is not registered through the expected llm-pi-ai provider profile')
  }
  const section = settings.describe({ redactSecrets: true }).find(entry => entry.ns === route.settingsNs)
  if (section === undefined) throw new Error('Codex provider settings section is unavailable')
  const raw = atPath(section.value, route.settingsPath)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Codex provider profile is unavailable')
  }
  const profile = raw as Record<string, unknown>
  if (profile.api !== undefined || profile.baseURL !== undefined || profile.apiKeyEnv !== undefined) {
    throw new Error('Codex provider overrides its subscription endpoint or credential; import is unavailable')
  }
  if (profile.models !== undefined && !Array.isArray(profile.models)) {
    throw new Error('Codex provider model list is invalid')
  }
  const registered = (await llm.listModels('openai-codex')).map(model => model.id)
  const plan = planCodexModelActivation({ registered, profile: raw, candidate })
  if (plan !== undefined) {
    await settings.mutate(route.settingsNs, [
      ...(plan.clearOverrides ? [{ op: 'unset' as const, path: [...route.settingsPath, 'modelOverrides'] }] : []),
      { op: 'set', path: [...route.settingsPath, 'models'], value: plan.models },
    ], section.revision)
  }
  // mutate awaits loader reconciliation. Do not treat an advisory row as a usable model until the live registry agrees.
  await llm.resolveModelInfo('openai-codex', candidate.id)
}
