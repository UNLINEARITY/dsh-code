/**
 * Provider settings adapter for the TUI `/model` provider-management panel:
 * the same-process equivalent of the web host's Models page join
 * (`packages/client/ui-settings-models`), reading the advisory `ctx.llm`
 * registry, the redacted `ctx.settings` descriptors, and the value-free
 * `ctx.credentials` facts directly. Secrets never cross this module: settings
 * are read with `redactSecrets: true`, credentials are only ever described
 * (never resolved), and every message is single-line without embedding key
 * data.
 *
 * @module @deepseek-ai/dsh-tui/provider-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import { normalizeApiKey } from '@deepseek-ai/dsh-llm'

/* ------------------------------------------------------------------ *
 * Structural service faces. Branding is erased at runtime, so credential
 * refs and settings namespaces are plain strings here; they originate only
 * from trusted settings descriptors or the validated derivation below.
 * Declaring the faces locally keeps this a dependency-free adapter over
 * `ctx.get(...)` — the settings and credentials packages are never imported.
 * ------------------------------------------------------------------ */

/** The subset of the `llm` service this module reads. */
interface LlmFace {
  /** Registered provider routes with a live adapter (`listProviders()`). */
  listProviders(): readonly { readonly id: string; readonly name: string }[]
  /** Declared configurable-provider directory; absent on an older service. */
  listConfigurableProviders?(): readonly {
    readonly provider: string
    readonly displayName: string
    readonly settingsNs: string
    readonly settingsPath: readonly string[]
    readonly declared?: boolean
  }[]
}

/** One redacted settings descriptor (subset of `SettingsDescriptor`). */
interface SettingsDescriptorFace {
  readonly ns: string
  readonly value: unknown
  readonly revision: number
  readonly base?: unknown
  readonly user?: unknown
}

/** One path-addressed edit to a stored section (subset of `SettingsPathOp`). */
interface SettingsPathOpFace {
  readonly op: 'set' | 'unset'
  readonly path: readonly string[]
  readonly value?: unknown
}

/** The subset of the `settings` service this module reads and writes. */
interface SettingsFace {
  readonly writable: boolean
  describe(options?: { readonly redactSecrets?: boolean }): readonly SettingsDescriptorFace[]
  mutate(ns: string, ops: readonly SettingsPathOpFace[], expectedRevision?: number): Promise<void>
}

/** Value-free facts about one credential reference (subset of `CredentialInfo`). */
interface CredentialFactsFace {
  readonly configured: boolean
  readonly source?: string
  readonly writable: boolean
}

/** Event subscription face used for the official Models invalidation trio. */
interface ProviderEventsFace {
  on(event: string, listener: (...args: unknown[]) => void): () => void
}

/** The subset of the `credentials` service this module reads and writes. */
interface CredentialsFace {
  describe(ref: string): Promise<CredentialFactsFace>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

/* ------------------------------------------------------------------ *
 * Pure helpers.
 * ------------------------------------------------------------------ */

/** Human text for a rejection value (mirrors the web page's `messageOf`). */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Collapse every whitespace/control run to one space so a notice stays one line. */
function singleLine(message: string): string {
  return message.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Keep a misbehaving credential provider from reflecting the submitted secret. */
function credentialWriteMessage(error: unknown, secret: string): string {
  const message = singleLine(messageOf(error))
  return message.includes(secret) ? 'credentials service rejected the API key' : message
}

/** Obvious shell-assignment paste; mirrors the official Web Models editor. */
const ENV_ASSIGNMENT = /^[A-Z][A-Z0-9_]*=[^=]/

/** Whether the whole draft is wrapped in one matching quote pair. */
function hasWrappingQuotes(value: string): boolean {
  const first = value[0]
  return (first === '"' || first === '\'' || first === '`') && value.length > 1 && value.endsWith(first)
}

/** Read the value at a path through plain objects; undefined when any segment misses. */
function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Whether a path resolves to a defined value (the empty path reads the root). */
function hasPath(value: unknown, path: readonly string[]): boolean {
  return path.length === 0 ? value !== undefined : getPath(value, path) !== undefined
}

/** The credential reference a resolved profile names (its `apiKeyEnv` field). */
function profileRefOf(profile: unknown): string | undefined {
  if (typeof profile !== 'object' || profile === null) return undefined
  const ref = (profile as { readonly apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/* ------------------------------------------------------------------ *
 * Exported contracts.
 * ------------------------------------------------------------------ */

/**
 * The conventional credential reference for a provider route: `<ROUTE>_API_KEY`
 * with the route uppercased and every non-alphanumeric run collapsed to one
 * underscore — the exact derivation the official Models page uses
 * (`deriveKeyRef` in `ui-settings-models`), so a key saved here is found there.
 * @param provider - provider route id (e.g. `pi-ai`, `minimax-cn`).
 * @returns the derived reference name (e.g. `PI_AI_API_KEY`).
 */
export function deriveCredentialRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/** Value-free facts about one credential reference — never the value. */
export interface ProviderCredentialFacts {
  /** Whether the reference currently resolves to a stored value. */
  readonly configured: boolean
  /** Source layer supplying the value; absent while unconfigured. */
  readonly source?: string
  /** Whether a write through this panel would currently succeed. */
  readonly writable: boolean
}

/**
 * One row's credential state: value-free facts once the reference was
 * described, a bounded error when that describe failed (the row itself is
 * never dropped), or `undefined` when the row names no reference to describe —
 * an unmanaged active provider, a dormant route, or a profile authenticating
 * through the provider's own path.
 */
export type ProviderCredentialView =
  | ({ readonly kind: 'facts' } & ProviderCredentialFacts)
  | { readonly kind: 'error'; readonly message: string }

/**
 * One provider row in the TUI provider-management panel: the configurable
 * directory entry joined with its settings profile and credential facts.
 * Every mutation below addresses this row, and the caller passes the row back
 * after re-loading so the revision/ref facts are current.
 */
export interface ProviderTargetView {
  /** Provider route id (`GenerateOptions.provider`). */
  readonly provider: string
  /** Human-readable provider name. */
  readonly displayName: string
  /** Whether an adapter currently serves this route. */
  readonly active: boolean
  /** User-settings namespace whose section configures this provider; '' when unmanaged. */
  readonly settingsNs: string
  /** Path from that section's root to this provider's profile; [] when the whole section is the profile. */
  readonly settingsPath: readonly string[]
  /** Revision of the owning settings section at load (0 when no namespace resolved). */
  readonly settingsRevision: number
  /** Whether the resolved profile exists (the whole section, or at `settingsPath`). */
  readonly configured: boolean
  /** Whether only the user settings layer carries the profile, so removal restores the base. */
  readonly removable: boolean
  /** The credential reference the resolved profile names, when one does. */
  readonly credentialRef?: string
  /** The conventional reference a save uses for a dormant or ref-less profile. */
  readonly suggestedRef: string
  /** Credential facts, a bounded describe error, or undefined when there is no ref to describe. */
  readonly credential: ProviderCredentialView | undefined
  /** The owning adapter reports this route as hand-declared (absent when it draws no distinction). */
  readonly declared?: boolean
}

/** The resolved provider/settings/credential join. */
export interface ProviderSettingsDirectory {
  /** Provider rows: configurable-directory order first, active-unmanaged rows after. */
  readonly rows: readonly ProviderTargetView[]
  /** Whether the settings provider accepts writes (mirrors the web page's flag). */
  readonly writable: boolean
  /** Non-fatal join failures (settings/directory reads), for a degradation notice. */
  readonly failures: readonly string[]
}

/** Events that invalidate the official Models provider/settings/credential join. */
const PROVIDER_SETTINGS_EVENTS = [
  'credentials/updated',
  'settings/document-updated',
  'llm/adapters-updated',
] as const

/** Subscribe to the same provider-directory invalidations as the official Web Models page. */
export function subscribeProviderSettings(ctx: Context, listener: () => void): () => void {
  const events = ctx as unknown as ProviderEventsFace
  const disposers = PROVIDER_SETTINGS_EVENTS.map(event => events.on(event, () => listener()))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** A single-line, bounded error from the provider-management adapter. */
export class ProviderSettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderSettingsError'
  }
}

/* ------------------------------------------------------------------ *
 * Load.
 * ------------------------------------------------------------------ */

/**
 * Join the configurable-provider directory, the redacted settings
 * namespaces, and the referenced credentials into panel rows, web-parity:
 * - directory entries merge with `listProviders()` to mark each live or
 *   dormant, and routes registered without a directory declaration appear as
 *   read-only/unmanaged rows (no settings address);
 * - a whole-section entry is configured whenever its namespace resolves;
 *   a path-addressed one only when the profile resolves there;
 * - a row is removable when the user layer alone carries its profile;
 * - only refs named by resolved profiles are described, and a per-ref failure
 *   degrades to that row's bounded error instead of losing it.
 * Absent `settings`/`credentials` services are tolerated the same way.
 * @param ctx - context carrying the `llm` service (settings/credentials optional).
 * @returns the resolved directory; empty rows when `llm` is unavailable.
 */
export async function loadProviderSettings(ctx: Context): Promise<ProviderSettingsDirectory> {
  const llm = ctx.get('llm') as LlmFace | undefined
  if (llm === undefined) return { rows: [], writable: false, failures: [] }
  // Call listProviders/listConfigurableProviders AS METHODS: destructured off
  // the service they lose `this` and throw on the first read (same lesson as
  // loadModelDirectory).
  const registered = llm.listProviders()
  const failures: string[] = []
  const directoryEntries: Array<{
    provider: string
    displayName: string
    settingsNs: string
    settingsPath: readonly string[]
    declared?: boolean
  }> = []
  if (llm.listConfigurableProviders !== undefined) {
    try {
      directoryEntries.push(...llm.listConfigurableProviders())
    } catch (error) {
      failures.push(`configurable-provider directory failed: ${singleLine(messageOf(error))}`)
    }
  }
  const settings = ctx.get('settings') as SettingsFace | undefined
  let descriptors: readonly SettingsDescriptorFace[] = []
  let writable = false
  if (settings !== undefined) {
    try {
      descriptors = settings.describe({ redactSecrets: true })
      writable = settings.writable === true
    } catch (error) {
      failures.push(`settings describe failed: ${singleLine(messageOf(error))}`)
    }
  }
  const namespaces = new Map(descriptors.map(descriptor => [descriptor.ns, descriptor] as const))
  const active = new Set(registered.map(provider => provider.id))
  const declared = new Set(directoryEntries.map(entry => entry.provider))
  // Directory order first, then registered-but-undeclared routes (web parity:
  // they exist and serve models, just with no settings address).
  const bases: Array<{
    provider: string
    displayName: string
    active: boolean
    settingsNs: string
    settingsPath: readonly string[]
    declared?: boolean
  }> = [
    ...directoryEntries.map(entry => ({
      provider: entry.provider,
      displayName: entry.displayName,
      active: active.has(entry.provider),
      settingsNs: entry.settingsNs,
      settingsPath: entry.settingsPath,
      ...entry.declared === undefined ? {} : { declared: entry.declared },
    })),
    ...registered
      .filter(provider => !declared.has(provider.id))
      .map(provider => ({
        provider: provider.id,
        displayName: provider.name,
        active: true,
        settingsNs: '',
        settingsPath: [] as readonly string[],
      })),
  ]
  const rows: Array<Omit<ProviderTargetView, 'credential'>> = bases.map((base) => {
    const namespace = base.settingsNs.length === 0 ? undefined : namespaces.get(base.settingsNs)
    const profile = namespace === undefined
      ? undefined
      : base.settingsPath.length === 0
        ? namespace.value
        : getPath(namespace.value, base.settingsPath)
    const configured = namespace !== undefined
      && (base.settingsPath.length === 0 || profile !== undefined)
    const removable = namespace !== undefined
      && base.settingsPath.length > 0
      && hasPath(namespace.user, base.settingsPath)
      && !hasPath(namespace.base, base.settingsPath)
    const credentialRef = profileRefOf(profile)
    return {
      provider: base.provider,
      displayName: base.displayName,
      active: base.active,
      settingsNs: base.settingsNs,
      settingsPath: base.settingsPath,
      settingsRevision: namespace?.revision ?? 0,
      configured,
      removable,
      ...credentialRef === undefined ? {} : { credentialRef },
      suggestedRef: deriveCredentialRef(base.provider),
      ...base.declared === undefined ? {} : { declared: base.declared },
    }
  })
  const refs = [...new Set(rows.flatMap(row => row.credentialRef === undefined ? [] : [row.credentialRef]))]
  const credentialViews = new Map<string, ProviderCredentialView>()
  const credentials = ctx.get('credentials') as CredentialsFace | undefined
  if (refs.length > 0) {
    if (credentials === undefined) {
      for (const ref of refs) {
        credentialViews.set(ref, { kind: 'error', message: 'credentials service is unavailable' })
      }
    } else {
      await Promise.all(refs.map(async (ref) => {
        try {
          const facts = await credentials.describe(ref)
          credentialViews.set(ref, {
            kind: 'facts',
            configured: facts.configured,
            writable: facts.writable,
            ...facts.source === undefined ? {} : { source: facts.source },
          })
        } catch (error) {
          credentialViews.set(ref, { kind: 'error', message: singleLine(messageOf(error)) })
        }
      }))
    }
  }
  return {
    rows: rows.map(row => ({
      ...row,
      credential: row.credentialRef === undefined
        ? undefined
        : credentialViews.get(row.credentialRef) ?? { kind: 'error', message: 'credential describe returned no view' },
    })),
    writable,
    failures,
  }
}

/* ------------------------------------------------------------------ *
 * Writes. Official web ordering is kept: settings.mutate first whenever a
 * profile/path or apiKeyEnv must be materialized, then credentials.set; a
 * removal unsets the managed credential before the profile. All operations
 * are idempotent, so re-running one after a partial failure is safe.
 * ------------------------------------------------------------------ */

/**
 * Store a provider API key, web-parity: validate with `normalizeApiKey`
 * (single-line, actionable errors that never echo the key), materialize the
 * profile/`apiKeyEnv` through `settings.mutate` first when the resolved
 * profile names no reference (dormant route or ref-less profile), then store
 * under the trusted named ref or the derived conventional ref. An existing
 * whole-section DeepSeek whose resolved profile already names
 * `DEEPSEEK_API_KEY` needs no settings mutation. Env-supplied read-only keys
 * are refused before any service call.
 * @param ctx - context carrying `settings` (when materializing) and `credentials`.
 * @param target - the joined row to write through.
 * @param rawKey - the key exactly as typed; surrounding whitespace is trimmed.
 * @throws {@link ProviderSettingsError} with a single-line, key-free message.
 */
export async function saveProviderCredential(ctx: Context, target: ProviderTargetView, rawKey: string): Promise<void> {
  const trimmed = rawKey.trim()
  if (ENV_ASSIGNMENT.test(trimmed) || hasWrappingQuotes(trimmed)) {
    throw new ProviderSettingsError('paste only the API key, without an environment-variable name or wrapping quotes')
  }
  const checked = normalizeApiKey(rawKey)
  if (!checked.ok) {
    throw new ProviderSettingsError(checked.reason === 'empty'
      ? 'the API key is empty after trimming surrounding whitespace'
      : 'the API key contains characters an HTTP header cannot carry; type a plain printable-ASCII key')
  }
  if (target.settingsNs.length === 0) {
    throw new ProviderSettingsError(`provider "${target.provider}" has no managed settings namespace; configure it in settings.yaml`)
  }
  if (target.credential?.kind === 'facts' && target.credential.writable === false) {
    throw new ProviderSettingsError(`the key for provider "${target.provider}" is supplied read-only by the environment; unset it in the shell instead of overwriting it here`)
  }
  const credentials = ctx.get('credentials') as CredentialsFace | undefined
  if (credentials === undefined) {
    throw new ProviderSettingsError('credentials service is unavailable; cannot store the API key')
  }
  const ref = target.credentialRef ?? deriveCredentialRef(target.provider)
  if (target.credentialRef === undefined) {
    const settings = ctx.get('settings') as SettingsFace | undefined
    if (settings === undefined) {
      throw new ProviderSettingsError('settings service is unavailable; cannot materialize the credential reference')
    }
    try {
      await settings.mutate(target.settingsNs, [{ op: 'set', path: [...target.settingsPath, 'apiKeyEnv'], value: ref }])
    } catch (error) {
      throw new ProviderSettingsError(singleLine(messageOf(error)))
    }
  }
  try {
    await credentials.set(ref, checked.value)
  } catch (error) {
    throw new ProviderSettingsError(credentialWriteMessage(error, checked.value))
  }
}

/**
 * Remove the currently named credential without touching the provider
 * profile. Only the resolved profile's own reference is unset; a dormant or
 * ref-less row (nothing to remove), an already-absent key, and an
 * env-supplied read-only key are rejected safely before any service call.
 * @param ctx - context carrying the `credentials` service.
 * @param target - the joined row whose named credential to unset.
 * @throws {@link ProviderSettingsError} with a single-line, key-free message.
 */
export async function unsetProviderCredential(ctx: Context, target: ProviderTargetView): Promise<void> {
  const ref = target.credentialRef
  if (ref === undefined) {
    throw new ProviderSettingsError(`provider "${target.provider}" names no credential reference to remove`)
  }
  const facts = target.credential
  if (facts?.kind === 'facts' && facts.configured === false) {
    throw new ProviderSettingsError(`provider "${target.provider}" has no configured credential to remove`)
  }
  if (facts?.kind === 'facts' && facts.writable === false) {
    throw new ProviderSettingsError(`the key for provider "${target.provider}" is supplied read-only by the environment; unset it in the shell instead`)
  }
  const credentials = ctx.get('credentials') as CredentialsFace | undefined
  if (credentials === undefined) {
    throw new ProviderSettingsError('credentials service is unavailable; cannot remove the API key')
  }
  try {
    await credentials.unset(ref)
  } catch (error) {
    throw new ProviderSettingsError(singleLine(messageOf(error)))
  }
}

/**
 * Remove a user-added provider profile, web-parity: only `removable` rows may
 * be removed; a page-managed credential — the derived ref, configured and
 * writable — is unset first (so a second-step failure leaves the row visible
 * and the operation retryable), then `settings.mutate` unsets
 * `target.settingsPath`. Both steps are idempotent. A hand-named credential
 * ref may be shared elsewhere and is left alone.
 * @param ctx - context carrying `credentials` and `settings`.
 * @param target - the joined row to remove.
 * @throws {@link ProviderSettingsError} with a single-line, key-free message.
 */
export async function removeProviderSettings(ctx: Context, target: ProviderTargetView): Promise<void> {
  if (!target.removable) {
    throw new ProviderSettingsError(`provider "${target.provider}" is not removable from the user settings layer`)
  }
  if (target.settingsNs.length === 0) {
    throw new ProviderSettingsError(`provider "${target.provider}" has no managed settings profile to remove`)
  }
  const managedRef = target.credentialRef === target.suggestedRef
    && target.credential?.kind === 'facts'
    && target.credential.configured === true
    && target.credential.writable === true
    ? target.credentialRef
    : undefined
  if (managedRef !== undefined) {
    const credentials = ctx.get('credentials') as CredentialsFace | undefined
    if (credentials === undefined) {
      throw new ProviderSettingsError('credentials service is unavailable; cannot remove the managed API key')
    }
    try {
      await credentials.unset(managedRef)
    } catch (error) {
      throw new ProviderSettingsError(singleLine(messageOf(error)))
    }
  }
  const settings = ctx.get('settings') as SettingsFace | undefined
  if (settings === undefined) {
    throw new ProviderSettingsError('settings service is unavailable; cannot remove the provider profile')
  }
  try {
    await settings.mutate(target.settingsNs, [{ op: 'unset', path: [...target.settingsPath] }])
  } catch (error) {
    throw new ProviderSettingsError(singleLine(messageOf(error)))
  }
}
