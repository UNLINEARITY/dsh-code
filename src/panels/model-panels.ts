/** Model selection and provider-management panels for the terminal app. */

import { createElement, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import type { ModelDirectory, ModelRow } from '../models.ts'
import {
  isDeclaredReasoningEfforts,
  parseReasoningEffortsDraft,
  serializeReasoningEfforts,
  type DiscoveredModelView,
  type ProviderConfiguration,
  type ProviderModelSettings,
  type ProviderSettingsDirectory,
  type ProviderTargetView,
  type ReasoningEffortsValue,
} from '../provider-settings.ts'
import {
  authorizationForProvider,
  providerAuthorizationStatus,
  type ProviderAuthorizationDirectory,
  type ProviderAuthorizationRow,
} from '../authorization.ts'
import { editQuery } from '../ui/query-editor.ts'
import { stripPasteMarkers } from '../keyboard.ts'
import { PanelGap } from '../ui/panel-gap.ts'
import { panelAccent } from '../ui/panel-accent.ts'
import { deleteLastGrapheme } from '../render/editor.ts'
import { panelViewport, selectionWindow } from '../render/inspector.ts'
import { displayText, singleLineText, truncateColumns } from '../render/text.ts'
import { dim, getPalette, inkColor } from '../theme.ts'
import { t } from '../i18n.ts'
import { useStableInput } from '../ui/use-stable-input.ts'

export function ModelPanel({ directory, error, current, onSelect, onProviders, onRetry, onClose }: {
  directory: ModelDirectory | undefined
  error: string | undefined
  /** `provider/model` label of the applied model: the cursor lands on it once. */
  current?: string
  onSelect: (row: ModelRow) => void
  onProviders?: () => void
  onRetry: () => void
  onClose: () => void
}): ReactElement {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const rows = useMemo(() => directory?.rows ?? [], [directory])
  // Direct-typing filter over provider and model names (the /mode contract):
  // printable keys edit the query, so a long directory is searchable without
  // a separate search mode. With a query active, q/r/g/G stop acting as
  // commands and become query text instead.
  const filtered = useMemo(() => {
    if (query === '') return rows
    const needle = query.toLowerCase()
    return rows.filter(row => `${row.provider} ${row.providerName ?? ''} ${row.model} ${row.modelName}`.toLowerCase().includes(needle))
  }, [rows, query])
  const positioned = useRef(false)
  // Latest-value ref: Ink re-subscribes useInput when its effect flushes,
  // which can lag a committed render (a directory that just landed paints
  // before the subscription swaps). A keystroke in that window would meet a
  // stale closure — Enter died as an empty-filter no-op right after "2 of 4
  // match" painted. The handler reads render-fresh values through the ref.
  const liveRef = useRef({ filtered, query, cursor })
  liveRef.current = { filtered, query, cursor }

  useEffect(() => {
    // Open ON the applied model (Codex resumes the previous pick): the first
    // non-empty directory positions the cursor once, never on later refreshes.
    if (positioned.current || rows.length === 0 || current === undefined) {
      if (filtered.length === 0) {
        if (cursor !== 0) setCursor(0)
        return
      }
      if (cursor >= filtered.length) setCursor(filtered.length - 1)
      return
    }
    const index = rows.findIndex(row => `${row.provider}/${row.model}` === current)
    if (index >= 0) {
      positioned.current = true
      // Position within the ACTIVE filter: the full-row index means nothing
      // when the query already narrowed the list while the directory loaded
      // (a late resolve must not place the cursor outside `filtered`).
      const filteredIndex = filtered.indexOf(rows[index])
      setCursor(filteredIndex >= 0 ? filteredIndex : 0)
    } else if (cursor >= filtered.length) {
      setCursor(Math.max(0, filtered.length - 1))
    }
  }, [rows, filtered, cursor, current])

  useInput((input, key) => {
    const { filtered: list, query: text, cursor: at } = liveRef.current
    if (key.escape || (input === 'q' && text === '')) {
      onClose()
      return
    }
    if (input === 'r' && text === '') {
      onRetry()
      return
    }
    if (key.tab && onProviders !== undefined) {
      onProviders()
      return
    }
    // Ctrl+C leaves the whole model configuration flow from any stage.
    if (key.ctrl && input === 'c') {
      onClose()
      return
    }
    const next = editQuery(text, input, key)
    if (next !== undefined) {
      setQuery(next)
      setCursor(0)
      return
    }
    if (list.length === 0) return
    if (key.upArrow) {
      setCursor(at > 0 ? at - 1 : list.length - 1)
      return
    }
    if (key.downArrow) {
      setCursor(at < list.length - 1 ? at + 1 : 0)
      return
    }
    if (key.pageUp) {
      setCursor(current => Math.max(0, current - Math.max(1, viewport.bodyRows - 1)))
      return
    }
    if (key.pageDown) {
      setCursor(current => Math.min(list.length - 1, current + Math.max(1, viewport.bodyRows - 1)))
      return
    }
    if (key.return && list[at] !== undefined) {
      onSelect(list[at])
    }
  })

  if (viewport.maxHeight === 0 || viewport.compact) {
    const providers = onProviders === undefined ? '' : ' · tab providers'
    const state = filtered.length === 0
      ? directory === undefined && error === undefined
        ? t('panel.model.loading')
        : error !== undefined
          ? t('panel.model.error')
          : query === '' ? t('panel.model.noModels') : t('panel.model.compactNoMatch', { query: singleLineText(query) })
      : `❯ ${filtered[cursor]?.modelName ?? filtered[cursor]?.model ?? ''}`
    const tail = query === ''
      ? t('panel.model.footer.filter')
      : t('panel.model.footer.filtered')
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('panel.model.compact', { state, providers, tail }), viewport.contentColumns))
  }

  const stateRows: ReactElement[] = directory === undefined && error === undefined
    ? [createElement(Text, { key: 'loading', dimColor: true, wrap: 'truncate-end' }, `  ${t('panel.model.loading')}`)]
    : error !== undefined
      ? [createElement(
        Text,
        { key: 'error', color: inkColor(getPalette().error), wrap: 'truncate-end' },
        truncateColumns(`  ${singleLineText(error)}`, viewport.contentColumns),
      )]
      : [
        ...(directory?.failures.length === 0
          ? []
          : [createElement(
            Text,
            { key: 'failures', color: inkColor(getPalette().warn), wrap: 'truncate-end' },
            truncateColumns(`  ${t('panel.provider.failure', { providers: directory?.failures.join(', ') ?? '' })}`, viewport.contentColumns),
          )]),
        ...(rows.length === 0
          ? [createElement(Text, { key: 'empty', dimColor: true, wrap: 'truncate-end' }, `  ${t('panel.model.noModels')}`)]
          : filtered.length === 0
            ? [createElement(Text, { key: 'no-match', dimColor: true, wrap: 'truncate-end' }, truncateColumns(`  ${t('panel.model.noMatch', { query: singleLineText(query) })}`, viewport.contentColumns))]
            : []),
      ]
  // Measurement and rendering share the same physical-row budget: state
  // messages consume body rows before selectable entries, as in Codex's
  // list-selection views.
  const visibleStateRows = stateRows.slice(0, viewport.bodyRows)
  const rowBudget = Math.max(0, viewport.bodyRows - visibleStateRows.length)
  const first = selectionWindow(cursor, filtered.length, rowBudget)
  const visible = rowBudget === 0 ? [] : filtered.slice(first, first + rowBudget)
  const accent = panelAccent('model', getPalette().brand)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(accent.border) },
    createElement(Text, { color: inkColor(accent.title), bold: true, wrap: 'truncate-end' }, truncateColumns(query === ''
      ? rows.length === 0 ? t('panel.model.title') : t('panel.model.titleCount', { index: cursor + 1, total: rows.length })
      : t('panel.model.titleMatches', { filtered: filtered.length, total: rows.length, query: singleLineText(query) }), viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...visibleStateRows,
    ...visible.map((row) => {
      const index = filtered.indexOf(row)
      const capability = row.inputModalities?.includes('image') === true ? ' · image' : ''
      const label = displayText(`${row.providerName} · ${row.modelName}${capability}`)
      return createElement(
        Text,
        {
          key: `${row.provider}/${row.model}`,
          color: index === cursor ? inkColor(getPalette().brandBright) : inkColor(getPalette().dim),
          wrap: 'truncate-end',
        },
        truncateColumns(`${index === cursor ? '❯ ' : '  '}${label}`, viewport.contentColumns),
      )
    }),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { wrap: 'truncate-end' }, dim(truncateColumns(query === ''
      ? t('panel.model.footer.select', { providers: onProviders === undefined ? '' : ` · ${t('panel.model.providers')}` })
      : t('panel.model.footer.filteredSelect'), viewport.contentColumns))),
  )
}

/** Compact provider-state copy; only value-free credential facts cross this boundary. */
function providerStateLabel(row: ProviderTargetView): string {
  const route = row.active ? t('panel.provider.active') : t('panel.provider.dormant')
  const credential = row.credential
  if (credential?.kind === 'error') return t('panel.provider.state', { route, value: t('panel.provider.keyStatusUnavailable') })
  if (credential?.kind === 'facts') {
    if (!credential.configured) return t('panel.provider.state', { route, value: t('panel.provider.noKey') })
    const source = credential.source === undefined ? t('panel.provider.configured') : singleLineText(credential.source)
    return t('panel.provider.state', { route, value: `${t('panel.provider.key', { value: source })}${credential.writable ? '' : ` · ${t('panel.provider.readOnly')}`}` })
  }
  return t('panel.provider.state', { route, value: row.configured ? t('panel.provider.authConfigured') : t('panel.provider.noLogin') })
}

/** The provider-management stage reached from /model with `a`. */
export function ProviderPanel({ directory, error, authorizations, authorizationError, onConfigure, onUnset, onRemove, onLogin, onLogout, onRetry, onBack, onExit }: {
  directory: ProviderSettingsDirectory | undefined
  error: string | undefined
  authorizations: ProviderAuthorizationDirectory | undefined
  authorizationError: string | undefined
  onConfigure: (target: ProviderTargetView) => void
  onUnset: (target: ProviderTargetView) => void
  onRemove: (target: ProviderTargetView) => void
  onLogin: (target: ProviderTargetView, authorization: ProviderAuthorizationRow) => void
  onLogout: (target: ProviderTargetView, authorization: ProviderAuthorizationRow) => void
  onRetry: () => void
  onBack: () => void
  /** Leave the whole /model flow (Ctrl+C), not just this stage. */
  onExit: () => void
}): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const rows = directory?.rows ?? []
  // Configured providers float to the top so a long dormant tail never buries
  // the ones in use; a dim separator labels the boundary between groups.
  const sorted = [...rows].sort((left, right) =>
    (left.configured ? 0 : 1) - (right.configured ? 0 : 1))
  const configuredCount = sorted.filter(row => row.configured).length
  const hasSeparator = configuredCount > 0 && configuredCount < sorted.length
  const [cursor, setCursor] = useState(0)
  const [actionError, setActionError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (rows.length === 0) {
      if (cursor !== 0) setCursor(0)
      return
    }
    if (cursor >= rows.length) setCursor(rows.length - 1)
  }, [rows.length, cursor])

  useStableInput((input, key) => {
    if (key.escape || input === 'q') {
      onBack()
      return
    }
    if (key.ctrl && input === 'c') {
      onExit()
      return
    }
    if (input === 'r') {
      setActionError(undefined)
      onRetry()
      return
    }
    if (rows.length === 0) return
    if (key.upArrow) {
      setActionError(undefined)
      setCursor(cursor > 0 ? cursor - 1 : rows.length - 1)
      return
    }
    if (key.downArrow) {
      setActionError(undefined)
      setCursor(cursor < rows.length - 1 ? cursor + 1 : 0)
      return
    }
    if (key.pageUp) {
      setActionError(undefined)
      setCursor(current => Math.max(0, current - Math.max(1, viewport.bodyRows - 1)))
      return
    }
    if (key.pageDown) {
      setActionError(undefined)
      setCursor(current => Math.min(rows.length - 1, current + Math.max(1, viewport.bodyRows - 1)))
      return
    }
    const target = sorted[cursor]
    if (target === undefined) return
    if (input === 'd') {
      const facts = target.credential
      if (facts?.kind !== 'facts' || !facts.configured) {
        setActionError(t('panel.provider.noConfiguredKey'))
      } else if (!facts.writable) {
        setActionError(t('panel.provider.readOnlyKey'))
      } else {
        onUnset(target)
      }
      return
    }
    if (input === 'x') {
      if (!target.removable) {
        setActionError(t('panel.provider.notRemovable'))
      } else {
        onRemove(target)
      }
      return
    }
    const authorization = authorizationForProvider(authorizations, target.provider)
    if (input === 'l' || input === 'L') {
      if (authorization === undefined) setActionError(t('panel.provider.noLoginFlow'))
      else if (authorization.inFlight) setActionError(t('panel.provider.loginRunning'))
      else onLogin(target, authorization)
      return
    }
    if (input === 'o' || input === 'O') {
      if (authorization === undefined || !authorization.record.configured) setActionError(t('panel.provider.noLoginRecord'))
      else if (!authorization.record.writable) setActionError(t('panel.provider.readOnlyLogin'))
      else onLogout(target, authorization)
      return
    }
    // Enter opens the unified setup page (key, endpoint, models, discovery):
    // the old split — Enter for the key alone, Tab for the deep menu — hid
    // the configuration surface behind an undiscoverable chord.
    if (key.return) {
      if (target.settingsNs.length === 0) {
        setActionError(t('panel.provider.notManaged'))
      } else {
        onConfigure(target)
      }
    }
  }, true)

  if (viewport.maxHeight === 0 || viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('panel.providers.compact'), viewport.contentColumns))
  }
  const stateRows: ReactElement[] = directory === undefined && error === undefined
    ? [createElement(Text, { key: 'loading', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, `  ${t('panel.provider.loading')}`)]
    : error !== undefined
      ? [createElement(Text, { key: 'error', color: inkColor(getPalette().error), wrap: 'truncate-end' }, truncateColumns(`  ${singleLineText(error)}`, viewport.contentColumns))]
      : [
        ...(actionError === undefined
          ? []
          : [createElement(Text, { key: 'action-error', color: inkColor(getPalette().error), wrap: 'truncate-end' }, truncateColumns(`  ${actionError}`, viewport.contentColumns))]),
        ...(directory?.failures ?? []).map((failure, index) => createElement(
          Text,
          { key: `failure-${index}`, color: inkColor(getPalette().warn), wrap: 'truncate-end' },
          truncateColumns(`  ${singleLineText(failure)}`, viewport.contentColumns),
        )),
        ...(authorizationError === undefined
          ? []
          : [createElement(Text, { key: 'authorization-error', color: inkColor(getPalette().warn), wrap: 'truncate-end' }, truncateColumns(`  ${t('panel.provider.loginStatusUnavailable', { message: singleLineText(authorizationError) })}`, viewport.contentColumns))]),
        ...(authorizations?.failures ?? []).map((failure, index) => createElement(
          Text,
          { key: `authorization-failure-${index}`, color: inkColor(getPalette().warn), wrap: 'truncate-end' },
          truncateColumns(`  ${singleLineText(failure)}`, viewport.contentColumns),
        )),
        ...(rows.length === 0
          ? [createElement(Text, { key: 'empty', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, `  ${t('panel.provider.empty')}`)]
          : []),
      ]
  const visibleStateRows = stateRows.slice(0, viewport.bodyRows)
  const rowBudget = Math.max(0, viewport.bodyRows - visibleStateRows.length)
  const displayLength = sorted.length + (hasSeparator ? 1 : 0)
  const displayCursor = cursor + (hasSeparator && cursor >= configuredCount ? 1 : 0)
  const first = selectionWindow(displayCursor, displayLength, rowBudget)
  const itemRows: ReactElement[] = []
  for (let display = first; display < first + rowBudget && display < displayLength; display += 1) {
    if (hasSeparator && display === configuredCount) {
      itemRows.push(createElement(Text, { key: 'separator', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(`  ${t('panel.provider.notConfiguredDivider')}`, viewport.contentColumns)))
      continue
    }
    const index = hasSeparator && display > configuredCount ? display - 1 : display
    const row = sorted[index]
    if (row === undefined) continue
    const identity = row.displayName === row.provider ? row.provider : row.displayName + ' (' + row.provider + ')'
    const authorization = authorizationForProvider(authorizations, row.provider)
    const manualKeyConfigured = row.credential?.kind === 'facts' && row.credential.configured
    const showAuthorization = !manualKeyConfigured || authorization?.record.configured === true || authorization?.inFlight === true
    const authLabel = showAuthorization ? ' · ' + providerAuthorizationStatus(authorization) : ''
    // The adapter's configuration diagnostic rides the row (the provider
    // stays listed and repairable — this is why it did not vanish).
    const diagnostic = row.diagnostic === undefined ? '' : ' · ! ' + singleLineText(row.diagnostic)
    const label = identity + ' · ' + providerStateLabel(row) + authLabel + (row.removable ? ' · custom' : '') + diagnostic
    // Configured rows render in the intermediate brand blue so the in-use
    // group reads at a glance; the dormant tail keeps the dim caption gray.
    const idleColor = row.configured ? inkColor(getPalette().brandMid) : inkColor(getPalette().dim)
    itemRows.push(createElement(
      Text,
      { key: row.provider, color: index === cursor ? inkColor(getPalette().brandBright) : idleColor, wrap: 'truncate-end' },
      truncateColumns((index === cursor ? '❯ ' : '  ') + displayText(label), viewport.contentColumns),
    ))
  }
  const accent = panelAccent('model-providers', getPalette().brand)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(accent.border) },
    createElement(Text, { color: inkColor(accent.title), bold: true, wrap: 'truncate-end' }, truncateColumns(rows.length === 0 ? t('panel.provider.title') : t('panel.provider.titleCount', { index: cursor + 1, total: rows.length }), viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...visibleStateRows,
    ...itemRows,
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(t('panel.providers.footer'), viewport.contentColumns)),
  )
}

/** Provider configuration editor: only explicit models are written to settings. */
/**
 * The unified provider setup page: API key, endpoint, and the explicit model
 * list (with per-model context/output capacities) on ONE screen — the deep
 * Tab menu and the separate key panel merged into a single discoverable
 * surface. A saved key rides the same Enter as the endpoint and models; an
 * empty endpoint keeps the provider's official default. Tab moves to the
 * discovery page, which interrogates the real endpoint and returns checkable
 * models for adoption; the last row also accepts hand-typed model ids.
 */
/** One declarable donor the setup page can copy reasoning efforts from verbatim. */
export interface EffortDonor {
  /** Provider route the declaration lives on. */
  readonly provider: string
  /** Model id the declaration belongs to. */
  readonly id: string
  /** The stored display-level to wire-value map, copied verbatim. */
  readonly efforts: Record<string, string | null>
}

export function ProviderSetupPanel({ target, save, saveCredential, discover, effortDonors, done, back, onExit }: {
  target: ProviderTargetView
  /** Models with declared efforts (settings first, catalog-advertised after) a model row can copy from. */
  effortDonors: readonly EffortDonor[]
  save: (target: ProviderTargetView, configuration: ProviderConfiguration) => Promise<void>
  saveCredential: ((target: ProviderTargetView, key: string) => Promise<void>) | undefined
  discover: (target: ProviderTargetView, request: { readonly apiKey?: string; readonly baseURL?: string }, signal?: AbortSignal) => Promise<readonly DiscoveredModelView[]>
  /** Report a successful save so the surface can notice the key rotation. */
  done: (result: { readonly key: boolean }) => void
  back: () => void
  /** Leave the whole /model flow (Ctrl+C), not just this page. */
  onExit: () => void
}): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [page, setPage] = useState<'setup' | 'discover' | 'donor'>('setup')
  const [keyDraft, setKeyDraft] = useState('')
  const [baseURL, setBaseURL] = useState(target.configuration.baseURL ?? '')
  const [models, setModels] = useState<readonly ProviderModelSettings[]>(target.configuration.models)
  const [cursor, setCursor] = useState(0)
  const [zone, setZone] = useState<'key' | 'url' | 'models'>('key')
  const [field, setField] = useState<'none' | 'ctx' | 'out'>('none')
  const [addDraft, setAddDraft] = useState('')
  /** Micro-editor for the selected model's reasoningEfforts declaration. */
  const [effEditing, setEffEditing] = useState(false)
  const [effDraft, setEffDraft] = useState('')
  const [donorCursor, setDonorCursor] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const credential = target.credential
  const keyStatus = saveCredential === undefined
    ? 'key storage unavailable'
    : credential?.kind === 'error'
      ? 'key status unavailable'
      : credential?.kind === 'facts' && credential.configured
        ? 'key saved' + (credential.source === undefined ? '' : ' · ' + credential.source)
        : 'no key set'
  // A dormant route (no resolved profile yet, so no credential facts) may
  // still receive a key: the save path materializes the apiKeyEnv reference
  // itself. Only a known-unwritable or indescribable credential blocks.
  const keyEditable = saveCredential !== undefined
    && (credential === undefined || (credential.kind === 'facts' && credential.writable))
  const onAddRow = cursor >= models.length
  const selected = onAddRow ? undefined : models[cursor]

  const updateSelected = (change: Partial<ProviderModelSettings>): void => {
    if (selected === undefined) return
    setModels(current => current.map((model, index) => index === cursor ? { ...model, ...change } : model))
  }

  const commitAddDraft = (): void => {
    const id = addDraft.trim()
    if (id === '') return
    if (models.some(model => model.id === id)) {
      setError('model "' + id + '" is already in the list')
      return
    }
    setError(undefined)
    setModels([...models, { id }])
    setCursor(models.length)
    setAddDraft('')
  }

  /** Compact declaration summary for the row label: count, off, or inherit. */
  const effortsSummary = (model: ProviderModelSettings): string => {
    const raw = (model.extras)?.reasoningEfforts
    if (raw === false) return 'off'
    if (isDeclaredReasoningEfforts(raw)) return String(Object.keys(raw).length)
    return '~'
  }

  /** Write (or clear) the selected model's declaration through extras. */
  const applyDeclaration = (value: ReasoningEffortsValue): void => {
    setModels(current => current.map((model, index) => {
      if (index !== cursor) return model
      const extras: Record<string, unknown> = { ...model.extras }
      if (value === undefined) delete extras.reasoningEfforts
      else extras.reasoningEfforts = value
      return { ...model, ...Object.keys(extras).length === 0 ? {} : { extras } }
    }))
  }

  /** Donors excluding the row being edited (copying from itself is a no-op). */
  const donorRows = selected === undefined
    ? []
    : effortDonors.filter(donor => !(donor.provider === target.provider && donor.id === selected.id))
  const donorIndex = Math.min(donorCursor, Math.max(0, donorRows.length - 1))
  const donorRow = donorRows[donorIndex]

  const submit = (): void => {
    if (busy) return
    const key = keyDraft.trim()
    // A typed key must never vanish silently: when it cannot be written here
    // (read-only env supply, or credential status failed to describe), refuse
    // the whole save with one actionable line instead of saving the endpoint
    // and models while dropping the key the user believes was stored.
    if (key !== '' && !keyEditable) {
      setError('this API key cannot be written here (read-only or status unavailable); clear the key field to save the endpoint and models alone')
      return
    }
    setBusy(true)
    setError(undefined)
    const keySave = key !== '' ? saveCredential : undefined
    void (async () => {
      if (keySave !== undefined) await keySave(target, key)
      await save(target, { ...(baseURL.trim() === '' ? {} : { baseURL }), models })
      return keySave !== undefined
    })().then(keySaved => done({ key: keySaved }), (reason: unknown) => {
      setBusy(false)
      setError(singleLineText(reason instanceof Error ? reason.message : String(reason)))
    })
  }

  useStableInput((input, key) => {
    if (busy) return
    // Ctrl+C leaves the whole model configuration flow from any stage.
    if (key.ctrl && input === 'c') {
      onExit()
      return
    }
    // Efforts micro-editor: consumes every key while open (space is the
    // pair separator, so the composer-style remove must not fire here).
    if (effEditing) {
      if (key.escape) { setEffEditing(false); setEffDraft(''); return }
      if (key.return) {
        const parsed = parseReasoningEffortsDraft(effDraft)
        if (!parsed.ok) { setError(parsed.error); return }
        setError(undefined)
        applyDeclaration(parsed.value)
        setEffEditing(false)
        setEffDraft('')
        return
      }
      if (key.backspace || key.delete) { setError(undefined); setEffDraft(current => deleteLastGrapheme(current)); return }
      if (key.ctrl && input === 'u') { setError(undefined); setEffDraft(''); return }
      if (key.ctrl || key.meta || input.length === 0) return
      if (effDraft.length > 200) { setError('efforts draft is too long'); return }
      setError(undefined)
      setEffDraft(current => current + stripPasteMarkers(input))
      return
    }
    // Donor picker: one page, up/down move, enter copies verbatim.
    if (page === 'donor') {
      if (key.escape || input === 'q') { setPage('setup'); return }
      if (donorRows.length === 0) return
      if (key.upArrow) { setDonorCursor(current => current > 0 ? current - 1 : donorRows.length - 1); return }
      if (key.downArrow) { setDonorCursor(current => current < donorRows.length - 1 ? current + 1 : 0); return }
      if (key.return && donorRow !== undefined) {
        applyDeclaration(donorRow.efforts)
        setError(undefined)
        setPage('setup')
      }
      return
    }
    if (key.escape || input === 'q') { back(); return }
    if (key.tab) { setPage('discover'); return }
    if (key.return) { submit(); return }
    if (zone === 'key') {
      // Typing stays available even when the key cannot be written here (a
      // read-only env supply, or a describe failure): the draft is local, and
      // Enter refuses the save with one actionable line instead of silently
      // dropping what the user typed.
      if (key.downArrow) { setZone('url'); return }
      if (key.backspace || key.delete) { setError(undefined); setKeyDraft(current => [...current].slice(0, -1).join('')); return }
      if (key.ctrl && input === 'u') { setError(undefined); setKeyDraft(''); return }
      if (key.ctrl || key.meta || input.length === 0) return
      const next = keyDraft + stripPasteMarkers(input)
      if (next.length > 4096) { setError('API key input is too long'); return }
      setError(undefined)
      setKeyDraft(next)
      return
    }
    if (zone === 'url') {
      if (key.upArrow) { setZone('key'); return }
      if (key.downArrow) { setZone('models'); return }
      if (key.backspace || key.delete) setBaseURL(current => deleteLastGrapheme(current))
      else if (!key.ctrl && !key.meta && input !== '') setBaseURL(current => current + stripPasteMarkers(input))
      return
    }
    // Models zone: the explicit list plus the hand-add row below it.
    if (key.upArrow) {
      setError(undefined)
      if (cursor === 0) setZone('url')
      else { setCursor(current => current - 1); setField('none') }
      return
    }
    if (key.downArrow) {
      setError(undefined)
      if (!onAddRow) { setCursor(current => current + 1); setField('none') }
      return
    }
    if (key.leftArrow || key.rightArrow) {
      if (selected === undefined) return
      const cycle = key.rightArrow
        ? (current: 'none' | 'ctx' | 'out') => current === 'none' ? 'ctx' : current === 'ctx' ? 'out' : 'none'
        : (current: 'none' | 'ctx' | 'out') => current === 'none' ? 'out' : current === 'out' ? 'ctx' : 'none'
      setField(current => cycle(current))
      return
    }
    if (input === ' ') {
      if (selected === undefined) commitAddDraft()
      else {
        setError(undefined)
        setField('none')
        setModels(current => current.filter((_model, index) => index !== cursor))
        setCursor(current => Math.min(current, Math.max(0, models.length - 1)))
      }
      return
    }
    if (onAddRow) {
      if (key.backspace || key.delete) { setError(undefined); setAddDraft(current => deleteLastGrapheme(current)); return }
      if (key.ctrl || key.meta || input.length === 0) return
      setError(undefined)
      setAddDraft(current => current + stripPasteMarkers(input))
      return
    }
    if (input === 'e' && selected !== undefined) {
      setError(undefined)
      setEffDraft(serializeReasoningEfforts((selected.extras)?.reasoningEfforts))
      setEffEditing(true)
      return
    }
    if ((input === 'c' || input === 'C') && !key.ctrl && selected !== undefined) {
      setError(undefined)
      setDonorCursor(0)
      setPage('donor')
      return
    }
    if (field !== 'none' && selected !== undefined) {
      const name = field === 'ctx' ? 'contextWindow' : 'maxTokens'
      const current = String(selected[name] ?? '')
      if (key.backspace || key.delete) {
        const next = current.slice(0, -1)
        updateSelected({ [name]: next === '' ? undefined : Number(next) })
      } else {
        // A pasted number arrives as one multi-character chunk; accept the
        // whole digit run instead of the single-character path only.
        const digits = stripPasteMarkers(input)
        if (/^[0-9]+$/u.test(digits)) updateSelected({ [name]: Number(current + digits) })
      }
    }
  }, page !== 'discover')
  if (viewport.maxHeight === 0 || viewport.bodyRows < 3) {
    // Never hide a live input surface: one visible row keeps the escape
    // route honest on extremely short terminals (the three fixed rows - key,
    // url, add-by-id - cannot fit below a three-row body).
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('panel.setup.compact'), viewport.contentColumns))
  }
  if (page === 'donor') {
    const stateRow = donorRows.length === 0
      ? createElement(Text, { key: 'empty', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(`  ${t('panel.setup.noDonors')}`, viewport.contentColumns))
      : createElement(Text, { key: 'hint', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(`  ${t('panel.setup.copyInto', { id: displayText(selected?.id ?? '') })}`, viewport.contentColumns))
    const donorBudget = Math.max(0, viewport.bodyRows - 2)
    const donorFirst = selectionWindow(donorIndex, donorRows.length, donorBudget)
    const donorVisible = donorRows.slice(donorFirst, donorFirst + donorBudget)
    const accent = panelAccent('model-efforts', getPalette().brand)
    return createElement(
      Box,
      { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(accent.border) },
      createElement(Text, { color: inkColor(accent.title), bold: true, wrap: 'truncate-end' }, truncateColumns(t('panel.setup.copyTitle'), viewport.contentColumns)),
      createElement(PanelGap, { visible: viewport.gapRows > 0 }),
      stateRow,
      ...donorVisible.map((donor, index) => {
        const active = donorFirst + index === donorIndex
        const label = (active ? '>' : ' ') + ' ' + donor.provider + '/' + displayText(donor.id) + ' · ' + serializeReasoningEfforts(donor.efforts)
        return createElement(Text, { key: donor.provider + '/' + donor.id, color: active ? inkColor(getPalette().brandBright) : inkColor(getPalette().text), wrap: 'truncate-end' }, truncateColumns(label, viewport.contentColumns))
      }),
      createElement(PanelGap, { visible: viewport.gapRows > 0 }),
      createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(t('panel.setup.copyFooter'), viewport.contentColumns)),
    )
  }
  if (page === 'discover') {
    return createElement(ProviderDiscoveryPanel, {
      target,
      baseURL,
      apiKey: keyDraft,
      configured: models.map(model => model.id),
      discover,
      onAdopt: adopted => {
        const existing = new Set(models.map(model => model.id))
        const fresh = adopted.filter(model => !existing.has(model.id))
        if (fresh.length > 0) {
          setModels([...models, ...fresh.map(model => ({
            id: model.id,
            ...model.name === undefined ? {} : { name: model.name },
            ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
            ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
          }))])
          setCursor(models.length)
        }
        setPage('setup')
      },
      back: () => setPage('setup'),
      onExit,
    })
  }
  const stateRows = error === undefined ? [] : [createElement(Text, { key: 'error', color: inkColor(getPalette().error), wrap: 'truncate-end' }, truncateColumns('  ' + error, viewport.contentColumns))]
  const keyBullets = '•'.repeat(Math.min([...keyDraft].length, Math.max(1, viewport.contentColumns - 14)))
  const keyRow = createElement(Text, { key: 'key', color: zone === 'key' ? inkColor(getPalette().brandBright) : inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(('  ' + (zone === 'key' ? '>' : ' ') + ' key   ' + keyBullets + (zone === 'key' && !busy ? '▏' : '') + (keyDraft === '' ? ' (' + keyStatus + ')' : busy ? ' saving…' : '')).replace(/ +$/u, ''), viewport.contentColumns))
  const urlRow = createElement(Text, { key: 'url', color: zone === 'url' ? inkColor(getPalette().brandBright) : inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns('  ' + (zone === 'url' ? '>' : ' ') + ' url   ' + (baseURL === '' ? '(official default)' : baseURL) + (zone === 'url' ? '▏' : ''), viewport.contentColumns))
  // The fixed diagnostic row (present only with an adapter error) joins the
  // same height budget as the state rows — it must never overflow the panel.
  const rowBudget = Math.max(0, viewport.bodyRows - stateRows.length - (target.diagnostic === undefined ? 0 : 1) - 3)
  const first = selectionWindow(cursor, models.length + 1, rowBudget)
  const modelRows: ReactElement[] = []
  for (let index = first; index < first + Math.max(0, Math.min(models.length + 1 - first, rowBudget)); index += 1) {
    if (index >= models.length) {
      modelRows.push(createElement(Text, { key: 'add', color: cursor === index ? inkColor(getPalette().brandBright) : inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns('  ' + (cursor === index ? '>' : ' ') + ' + add by id' + (addDraft === '' ? '' : ' ' + addDraft + '▏'), viewport.contentColumns)))
      continue
    }
    const model = models[index]
    const active = index === cursor
    const context = model.contextWindow === undefined ? '-' : String(model.contextWindow)
    const output = model.maxTokens === undefined ? '-' : String(model.maxTokens)
    const editing = active && effEditing
    const tail = editing
      ? '  eff:' + effDraft + '▏'
      : '  in:' + (active && field === 'ctx' ? '[' + context + ']' : context) + ' out:' + (active && field === 'out' ? '[' + output + ']' : output) + ' eff:' + effortsSummary(model)
    modelRows.push(createElement(Text, { key: model.id, color: active ? inkColor(getPalette().brandBright) : inkColor(getPalette().success), wrap: 'truncate-end' }, truncateColumns('  ' + (active ? '>' : ' ') + ' [x] ' + displayText(model.id) + tail, viewport.contentColumns)))
  }
  const accent = panelAccent('model-configure', getPalette().brand)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(accent.border) },
    createElement(Text, { color: inkColor(accent.title), bold: true, wrap: 'truncate-end' }, truncateColumns(t('panel.setup.title', { provider: target.displayName }), viewport.contentColumns)),
    // The adapter's configuration diagnostic heads the editor: the provider
    // is here precisely because it stayed listed for repair.
    ...(target.diagnostic === undefined ? [] : [createElement(
      Text,
      { key: 'diagnostic', color: inkColor(getPalette().warn), wrap: 'truncate-end' },
      truncateColumns('! ' + displayText(singleLineText(target.diagnostic)), viewport.contentColumns),
    )]),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    keyRow,
    urlRow,
    ...stateRows,
    ...modelRows,
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(t('panel.setup.footer'), viewport.contentColumns)),
  )
}

/**
 * The discovery stage of the provider setup page: interrogates the endpoint
 * the drafts describe (typed key wins over the stored credential) and offers
 * the advertised models as a checkable list. Already-configured ids render
 * verified but untoggleable; Enter adopts every checked model back into the
 * setup page's list — selective adoption, never a bulk import.
 */
function ProviderDiscoveryPanel({ target, baseURL, apiKey, configured, discover, onAdopt, back, onExit }: {
  target: ProviderTargetView
  baseURL: string
  apiKey: string
  configured: readonly string[]
  discover: (target: ProviderTargetView, request: { readonly apiKey?: string; readonly baseURL?: string }, signal?: AbortSignal) => Promise<readonly DiscoveredModelView[]>
  onAdopt: (models: readonly DiscoveredModelView[]) => void
  back: () => void
  /** Leave the whole /model flow (Ctrl+C). */
  onExit: () => void
}): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [epoch, setEpoch] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [rows, setRows] = useState<readonly DiscoveredModelView[]>([])
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  const [cursor, setCursor] = useState(0)
  useEffect(() => {
    // One probe per epoch (mount and explicit 'f'); leaving the page aborts.
    // The drafts are captured when the page opened — adopting unmounts this
    // stage, so re-renders must not re-interrogate the endpoint.
    const controller = new AbortController()
    setLoading(true)
    setError(undefined)
    discover(target, {
      ...(baseURL.trim() === '' ? {} : { baseURL: baseURL.trim() }),
      ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
    }, controller.signal).then(discovered => {
      if (controller.signal.aborted) return
      setRows(discovered)
      const alreadyKnown = new Set(configured)
      const firstNew = discovered.findIndex(model => !alreadyKnown.has(model.id))
      setCursor(firstNew < 0 ? 0 : firstNew)
      setLoading(false)
    }, (reason: unknown) => {
      if (controller.signal.aborted) return
      setError(singleLineText(reason instanceof Error ? reason.message : String(reason)))
      setLoading(false)
    })
    return () => { controller.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch])
  const known = new Set(configured)
  useStableInput((input, key) => {
    if (key.escape || input === 'q') { back(); return }
    if (key.ctrl && input === 'c') { onExit(); return }
    if (input === 'f') { setChecked(new Set()); setEpoch(current => current + 1); return }
    if (loading || error !== undefined) return
    if (rows.length === 0) return
    if (key.upArrow) { setCursor(current => current > 0 ? current - 1 : rows.length - 1); return }
    if (key.downArrow) { setCursor(current => current < rows.length - 1 ? current + 1 : 0); return }
    const row = rows[cursor]
    if (row === undefined) return
    if (input === ' ') {
      if (known.has(row.id)) return
      setChecked(current => {
        const next = new Set(current)
        if (next.has(row.id)) next.delete(row.id)
        else next.add(row.id)
        return next
      })
      return
    }
    if (key.return) {
      onAdopt(rows.filter(model => checked.has(model.id)))
    }
  }, true)
  if (viewport.maxHeight === 0) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('panel.discovery.compact'), viewport.contentColumns))
  }
  const stateRows = loading
    ? [createElement(Text, { key: 'loading', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(`  ${t('panel.discovery.loading')}`, viewport.contentColumns))]
    : error !== undefined
      ? [createElement(Text, { key: 'error', color: inkColor(getPalette().error), wrap: 'truncate-end' }, truncateColumns('  ' + error, viewport.contentColumns))]
      : rows.length === 0
        ? [createElement(Text, { key: 'empty', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(`  ${t('panel.discovery.empty')}`, viewport.contentColumns))]
        : [createElement(Text, { key: 'summary', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(`  ${t('panel.discovery.summary', { advertised: rows.length, newCount: rows.filter(model => !known.has(model.id)).length, checked: checked.size })}`, viewport.contentColumns))]
  // One spare row keeps the panel strictly below maxHeight even with the
  // gap collapsed (the at-equality regime makes Ink rewrite Static).
  const rowBudget = Math.max(0, viewport.bodyRows - stateRows.length - 1)
  const first = selectionWindow(cursor, rows.length, rowBudget)
  const visible = rows.slice(first, first + rowBudget)
  const accent = panelAccent('model-discover', getPalette().brand)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(accent.border) },
    createElement(Text, { color: inkColor(accent.title), bold: true, wrap: 'truncate-end' }, truncateColumns(t('panel.discovery.title', { provider: target.displayName }), viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...stateRows,
    ...visible.map((model, index) => {
      const absolute = first + index
      const active = absolute === cursor
      const added = known.has(model.id)
      const mark = added ? '✓' : checked.has(model.id) ? '☑' : '☐'
      const label = (active ? '>' : ' ') + ' ' + mark + ' ' + displayText(model.id) + (model.name === undefined || model.name === model.id ? '' : ' · ' + displayText(model.name))
      return createElement(Text, { key: model.id, color: added ? inkColor(getPalette().dim) : active ? inkColor(getPalette().brandBright) : inkColor(getPalette().text), wrap: 'truncate-end' }, truncateColumns(label, viewport.contentColumns))
    }),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(t('panel.discovery.footer'), viewport.contentColumns)),
  )
}

/** Bounded destructive-action confirmation for credential or provider removal. */
export function ProviderConfirmPanel({ target, kind, confirm, done, back }: {
  target: ProviderTargetView
  kind: 'credential' | 'provider'
  confirm: (target: ProviderTargetView) => Promise<void>
  done: () => void
  back: () => void
}): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const run = (): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    Promise.resolve().then(() => confirm(target)).then(done, (reason: unknown) => {
      setError(singleLineText(reason instanceof Error ? reason.message : String(reason)))
      setBusy(false)
    })
  }
  useStableInput((input, key) => {
    if (busy) return
    if (key.escape || input === 'n') {
      back()
      return
    }
    if (input === 'y') run()
  }, true)

  const action = kind === 'credential' ? 'remove API key' : 'remove provider'
  if (viewport.maxHeight === 0 || viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(`${action} ${target.displayName}? · y confirm · n/esc back`, viewport.contentColumns))
  }
  const identity = target.displayName === target.provider ? target.provider : `${target.displayName} (${target.provider})`
  const identityRow = createElement(Text, { key: 'identity', wrap: 'truncate-end' }, truncateColumns(`  ${displayText(identity)}`, viewport.contentColumns))
  const descriptionRow = createElement(Text, { key: 'description', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(kind === 'credential' ? '  the provider profile and selected model stay available' : '  the user settings profile and its managed key will be removed', viewport.contentColumns))
  const errorRow = error === undefined
    ? undefined
    : createElement(Text, { key: 'error', color: inkColor(getPalette().error), wrap: 'truncate-end' }, truncateColumns(`  ${error}`, viewport.contentColumns))
  const bodyRows = errorRow === undefined
    ? [identityRow, descriptionRow].slice(0, viewport.bodyRows)
    : [identityRow, errorRow].slice(-viewport.bodyRows)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(getPalette().warn) },
    createElement(Text, { color: inkColor(getPalette().warn), bold: true, wrap: 'truncate-end' }, truncateColumns(`/model — ${action}`, viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...bodyRows,
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(busy ? 'working…' : 'y confirm · n/esc back', viewport.contentColumns)),
  )
}

/**
 * The /help overlay: one scrolling card with the keyboard map, the TUI-local
 * commands, the live registry commands, and the user-invocable skills — the
 * real command surface, replacing the one-line notice.
 */
