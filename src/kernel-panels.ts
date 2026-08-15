/** Bounded, composer-safe panels for preset, session, and plugin kernel views. */

import { createElement, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import type { ModelRow } from './models.ts'
import type { PresetRow } from './presets.ts'
import type { PluginRow } from './plugin-inventory.ts'
import type { SessionDirectoryOptions, SessionRow } from './session-directory.ts'
import { panelViewport, revealRow } from './render/inspector.ts'
import { textLines } from './render/lines.ts'
import { DEFAULT_STATUSLINE_ITEMS, STATUS_ITEMS, type StatusItemId } from './render/status.ts'
import { displayText, singleLineText, truncateColumns } from './render/text.ts'
import { getPalette, inkColor } from './theme.ts'

interface ListFrameProps {
  readonly title: string
  readonly rows: readonly { readonly key: string; readonly text: string; readonly disabled?: boolean }[]
  readonly cursor: number
  readonly loading: boolean
  readonly error?: string
  readonly query: string
  readonly footer: string
}

function ListFrame(props: ListFrameProps): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  if (viewport.maxHeight === 0) return createElement(Box, { display: 'none' })
  if (viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(`${props.title} · esc close`, viewport.contentColumns))
  }
  const stateRows = props.loading
    ? [{ key: 'loading', text: '  loading…' }]
    : props.error !== undefined
      ? [{ key: 'error', text: `  ${singleLineText(props.error)}` }]
      : props.rows.length === 0
        ? [{ key: 'empty', text: '  no matching entries' }]
        : props.rows
  const bodyRows = Math.max(1, viewport.bodyRows - 1)
  const offset = revealRow(0, props.cursor, stateRows.length, bodyRows)
  const visible = stateRows.slice(offset, offset + bodyRows)
  return createElement(
    Box,
    { width: viewport.outerColumns, borderStyle: 'round', borderColor: inkColor(getPalette().dim), flexDirection: 'column', paddingX: 1 },
    createElement(Text, { color: inkColor(getPalette().brandBright), wrap: 'truncate-end' }, truncateColumns(props.title, viewport.contentColumns)),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns(`search: ${props.query === '' ? 'type to filter' : props.query}`, viewport.contentColumns)),
    ...visible.map((row, index) => {
      const absolute = offset + index
      const selected = !props.loading && props.error === undefined && props.rows.length > 0 && absolute === props.cursor
      return createElement(Text, {
        key: row.key,
        color: selected ? inkColor(getPalette().brandBright) : row.disabled ? inkColor(getPalette().dim) : undefined,
        dimColor: row.disabled,
        wrap: 'truncate-end',
      }, truncateColumns(`${selected ? '› ' : '  '}${row.text}`, viewport.contentColumns))
    }),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns(props.footer, viewport.contentColumns)),
  )
}

function editQuery(query: string, input: string, key: { backspace?: boolean; delete?: boolean }): string | undefined {
  if (key.backspace || key.delete) return query.slice(0, -1)
  if (input.length === 1 && input >= ' ' && input !== '\x7f') return query + input
  return undefined
}

export function ModePanel({ current, load, select, close }: {
  current: string
  load(): Promise<readonly PresetRow[]>
  select(id: string): void
  close(): void
}): ReactElement {
  const [rows, setRows] = useState<readonly PresetRow[]>([])
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const refresh = (): void => {
    setLoading(true); setError(undefined)
    Promise.resolve().then(load).then(value => { setRows(value); setLoading(false) }, reason => {
      setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false)
    })
  }
  useEffect(refresh, [])
  const visible = useMemo(() => rows.filter(row => `${row.id} ${row.name ?? ''} ${row.description ?? ''}`.toLowerCase().includes(query.toLowerCase())), [rows, query])
  useEffect(() => setCursor(value => Math.min(value, Math.max(0, visible.length - 1))), [visible.length])
  useInput((input, key) => {
    if (key.escape || input === 'q') return close()
    if (input === 'r' && query === '') return refresh()
    if (key.upArrow) return setCursor(value => visible.length === 0 ? 0 : (value + visible.length - 1) % visible.length)
    if (key.downArrow) return setCursor(value => visible.length === 0 ? 0 : (value + 1) % visible.length)
    if (key.return && visible[cursor]?.broken === undefined) return select(visible[cursor]!.id)
    const next = editQuery(query, input, key)
    if (next !== undefined) { setQuery(next); setCursor(0) }
  })
  return createElement(ListFrame, {
    title: `/mode · current ${current}`,
    rows: visible.map(row => ({ key: row.id, disabled: row.broken !== undefined, text: `${row.id === current ? '●' : '○'} ${row.name ?? row.id} · ${row.description ?? row.trust}${row.broken === undefined ? '' : ` · broken: ${row.broken}`}` })),
    cursor, loading, error, query, footer: '↑↓ choose · enter switch · r refresh · esc close',
  })
}

export function PluginPanel({ load, close, initialQuery = '' }: { load(): readonly PluginRow[]; close(): void; initialQuery?: string }): ReactElement {
  const [epoch, setEpoch] = useState(0)
  const [query, setQuery] = useState(initialQuery)
  const [cursor, setCursor] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const rows = useMemo(() => load().filter(row => `${row.entryId} ${row.moduleName} ${row.phase ?? ''}`.toLowerCase().includes(query.toLowerCase())), [epoch, query])
  useEffect(() => setCursor(value => Math.min(value, Math.max(0, rows.length - 1))), [rows.length])
  useInput((input, key) => {
    if (key.escape || input === 'q') return close()
    if (input === 'r' && query === '') return setEpoch(value => value + 1)
    if (key.upArrow) return setCursor(value => rows.length === 0 ? 0 : (value + rows.length - 1) % rows.length)
    if (key.downArrow) return setCursor(value => rows.length === 0 ? 0 : (value + 1) % rows.length)
    if (key.return) return setExpanded(value => !value)
    const next = editQuery(query, input, key)
    if (next !== undefined) { setQuery(next); setCursor(0) }
  })
  return createElement(ListFrame, {
    title: '/plugin · loader inspector',
    rows: rows.map((row, index) => ({
      key: row.entryId,
      disabled: !row.enabled,
      text: `${row.enabled ? '●' : '○'} ${row.entryId} · ${row.phase ?? 'not mounted'}${expanded && index === cursor ? ` · ${row.moduleName}` : ''}`,
    })), cursor, loading: false, query, footer: '↑↓ inspect · enter details · r refresh · esc close',
  })
}

export function ResumePanel({ currentCwd, load, readTranscript, select, close }: {
  currentCwd: string
  load(options: SessionDirectoryOptions, signal?: AbortSignal): Promise<readonly SessionRow[]>
  readTranscript(id: string, signal?: AbortSignal): Promise<string>
  select(row: SessionRow): void
  close(): void
}): ReactElement {
  const [options, setOptions] = useState<SessionDirectoryOptions>({ sessions: 'roots', cwd: 'all', sort: 'newest', currentCwd, query: '' })
  const [focus, setFocus] = useState(0)
  const [density, setDensity] = useState<'comfortable' | 'dense'>('comfortable')
  const [rows, setRows] = useState<readonly SessionRow[]>([])
  const [cursor, setCursor] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [expanded, setExpanded] = useState<string>()
  const [transcript, setTranscript] = useState<{ id: string; text?: string; error?: string }>()
  const transcriptLoad = useRef<AbortController>()
  useEffect(() => () => transcriptLoad.current?.abort(), [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(undefined)
    Promise.resolve().then(() => load(options, controller.signal)).then(value => {
      if (!controller.signal.aborted) { setRows(value); setLoading(false) }
    }, reason => {
      if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false) }
    })
    return () => controller.abort()
  }, [options])
  useEffect(() => setCursor(value => Math.min(value, Math.max(0, rows.length - 1))), [rows.length])
  const cycle = (): void => {
    if (focus === 3) {
      setDensity(current => current === 'comfortable' ? 'dense' : 'comfortable')
      return
    }
    setOptions(value => {
      if (focus === 0) return { ...value, sessions: value.sessions === 'roots' ? 'all' : 'roots' }
      if (focus === 1) return { ...value, cwd: value.cwd === 'all' ? 'current' : 'all' }
      return { ...value, sort: value.sort === 'newest' ? 'oldest' : 'newest' }
    })
  }
  useInput((input, key) => {
    if (key.escape || input === 'q') return close()
    if (key.tab) return setFocus(value => (value + (key.shift ? 3 : 1)) % 4)
    if (key.leftArrow) return cycle()
    if (key.rightArrow) return cycle()
    if (key.upArrow) return setCursor(value => rows.length === 0 ? 0 : Math.max(0, value - 1))
    if (key.downArrow) return setCursor(value => rows.length === 0 ? 0 : Math.min(rows.length - 1, value + 1))
    if (key.pageUp) return setCursor(value => Math.max(0, value - 8))
    if (key.pageDown) return setCursor(value => Math.min(rows.length - 1, value + 8))
    if (input === 'g') return setCursor(0)
    if (input === 'G') return setCursor(Math.max(0, rows.length - 1))
    if (input === 'd') return setDensity(value => value === 'comfortable' ? 'dense' : 'comfortable')
    if (input === 'e' && rows[cursor] !== undefined) {
      return setExpanded(value => value === rows[cursor]!.id ? undefined : rows[cursor]!.id)
    }
    if (input === 't' && rows[cursor] !== undefined) {
      const row = rows[cursor]!
      transcriptLoad.current?.abort()
      setTranscript({ id: row.id })
      const controller = new AbortController()
      transcriptLoad.current = controller
      Promise.resolve().then(() => readTranscript(row.id, controller.signal)).then(
        text => { if (!controller.signal.aborted) setTranscript({ id: row.id, text }) },
        reason => { if (!controller.signal.aborted) setTranscript({ id: row.id, error: reason instanceof Error ? reason.message : String(reason) }) },
      )
      return
    }
    if (key.return && rows[cursor]?.resumable === true) return select(rows[cursor]!)
    const next = editQuery(options.query, input, key)
    if (next !== undefined) { setOptions(value => ({ ...value, query: next })); setCursor(0) }
  }, { isActive: transcript === undefined })
  if (transcript !== undefined) {
    return createElement(DocumentPanel, {
      title: `transcript · ${transcript.id}`,
      text: transcript.text,
      error: transcript.error,
      close: () => { transcriptLoad.current?.abort(); setTranscript(undefined) },
    })
  }
  const toolbar = `[${focus === 0 ? '>' : ''}${options.sessions}] [${focus === 1 ? '>' : ''}${options.cwd} cwd] [${focus === 2 ? '>' : ''}${options.sort}] [${focus === 3 ? '>' : ''}${density}]`
  return createElement(ListFrame, {
    title: `/resume · ${toolbar}`,
    rows: rows.map(row => ({
      key: row.id,
      disabled: !row.resumable,
      text: `${row.subagent ? '↳' : '○'} ${row.title ?? row.id.slice(-12)}${density === 'comfortable' ? ` · ${row.workspace} · ${row.preset}` : ''}${row.live ? ' · live' : ''}${expanded === row.id ? ` · ${row.id} · ${row.cwd}${row.parent === undefined ? '' : ` · parent ${row.parent}`}` : ''}`,
    })), cursor, loading, error, query: options.query,
    footer: 'type search · tab/←→ filters · ↑↓/pg navigate · e details · t transcript · enter resume',
  })
}

function DocumentPanel({ title, text, error, close }: {
  title: string
  text?: string
  error?: string
  close(): void
}): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [scroll, setScroll] = useState(0)
  const lines = useMemo(() => text === undefined ? [] : textLines(text, viewport.contentColumns).map(line => line.segments.map(segment => segment.text).join('')), [text, viewport.contentColumns])
  useInput((input, key) => {
    if (key.escape || input === 'q' || input === 't') return close()
    if (key.upArrow) return setScroll(value => Math.max(0, value - 1))
    if (key.downArrow) return setScroll(value => Math.min(Math.max(0, lines.length - viewport.bodyRows), value + 1))
    if (key.pageUp) return setScroll(value => Math.max(0, value - Math.max(1, viewport.bodyRows - 1)))
    if (key.pageDown) return setScroll(value => Math.min(Math.max(0, lines.length - viewport.bodyRows), value + Math.max(1, viewport.bodyRows - 1)))
    if (input === 'g') return setScroll(0)
    if (input === 'G') return setScroll(Math.max(0, lines.length - viewport.bodyRows))
  })
  if (viewport.compact) return createElement(Text, { wrap: 'truncate-end' }, truncateColumns('transcript · esc close', viewport.contentColumns))
  const body = error !== undefined
    ? [`error: ${singleLineText(error)}`]
    : text === undefined
      ? ['loading transcript…']
      : lines.slice(scroll, scroll + viewport.bodyRows)
  return createElement(
    Box,
    { width: viewport.outerColumns, borderStyle: 'round', borderColor: inkColor(getPalette().dim), flexDirection: 'column', paddingX: 1 },
    createElement(Text, { color: inkColor(getPalette().brandBright), wrap: 'truncate-end' }, truncateColumns(title, viewport.contentColumns)),
    ...body.map((line, index) => createElement(Text, { key: `${scroll}-${index}`, wrap: 'truncate-end' }, truncateColumns(line, viewport.contentColumns))),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns(`lines ${lines.length === 0 ? 0 : scroll + 1}-${Math.min(lines.length, scroll + viewport.bodyRows)}/${lines.length} · ↑↓/pg/g/G · t/esc close`, viewport.contentColumns)),
  )
}

/**
 * The /history recall panel (Codex composer-history search, bounded): one
 * query line over the newest-first recall space, filtered by substring, with
 * arrow selection and enter to fill the composer. Editing the query restarts
 * from the newest match; Esc closes without touching the draft.
 */
export function HistoryPanel({ entries, fill, close }: {
  /** Newest-first recall entries (persistent + in-session, deduped). */
  entries: readonly string[]
  /** Accept one entry: its text plus its recall-space index (browsing resumes there). */
  fill(text: string, index: number): void
  close(): void
}): ReactElement {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const matches = query === ''
    ? entries
    : entries.filter(entry => entry.toLowerCase().includes(query.toLowerCase()))
  useInput((input, key) => {
    if (key.escape) return close()
    if (key.return) {
      const entry = matches[cursor]
      if (entry !== undefined) fill(entry, entries.indexOf(entry))
      return
    }
    if (key.upArrow) return setCursor(value => Math.max(0, value - 1))
    if (key.downArrow) return setCursor(value => Math.min(matches.length - 1, value + 1))
    if (input === 'g') return setCursor(0)
    if (input === 'G') return setCursor(matches.length - 1)
    if (key.backspace) {
      setQuery(current => current.slice(0, -1))
      setCursor(0)
      return
    }
    if (input !== '' && !key.ctrl && !key.meta && !key.shift) {
      setQuery(current => (current + input).slice(0, 120))
      setCursor(0)
    }
  })
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  if (viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns('/history · esc close', viewport.contentColumns))
  }
  if (viewport.maxHeight === 0) return createElement(Box, { display: 'none' })
  const bodyRows = Math.max(1, viewport.bodyRows - 1)
  const offset = revealRow(0, cursor, matches.length, bodyRows)
  const visible = matches.slice(offset, offset + bodyRows)
  const header = query === ''
    ? `/history · ${entries.length} prompts · type to filter`
    : `/history · ${matches.length} of ${entries.length} match '${truncateColumns(singleLineText(query), viewport.contentColumns - 30)}'`
  return createElement(
    Box,
    { width: viewport.outerColumns, borderStyle: 'round', borderColor: inkColor(getPalette().dim), flexDirection: 'column', paddingX: 1 },
    createElement(Text, { color: inkColor(getPalette().brandBright), wrap: 'truncate-end' }, truncateColumns(header, viewport.contentColumns)),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns(`  filter ${query === '' ? '· type to search prompts' : '· ' + singleLineText(query)}, enter fills the composer`, viewport.contentColumns)),
    ...(visible.length === 0
      ? [createElement(Text, { key: 'empty', dimColor: true, wrap: 'truncate-end' }, truncateColumns('  no matching prompts', viewport.contentColumns))]
      : visible.map((entry, index) => {
        const absolute = offset + index
        const selected = absolute === cursor
        return createElement(
          Text,
          {
            key: `history-${absolute}`,
            color: selected ? inkColor(getPalette().brandBright) : undefined,
            wrap: 'truncate-end',
          },
          truncateColumns((selected ? '› ' : '  ') + displayText(entry), viewport.contentColumns),
        )
      })),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns('↑↓ move · g/G ends · enter fill · esc close', viewport.contentColumns)),
  )
}

/**
 * The /statusline picker (the Codex setup-view contract): one bounded list
 * of every status item with its enabled mark, arrow reordering, and a
 * live preview — the real status line under the composer updates as you
 * edit, so the panel itself carries no duplicate preview row.
 */
export function StatuslinePanel({ enabled, change, close }: {
  enabled: readonly StatusItemId[]
  change(items: readonly StatusItemId[]): void
  close(): void
}): ReactElement {
  // Working state: the full catalog in display order (enabled entries in
  // their configured positions, disabled ones trailing canonically) plus
  // the enabled set. Persisted shape is the enabled subsequence only.
  const [order, setOrder] = useState<readonly StatusItemId[]>(() => {
    const seen = new Set(enabled)
    return [...enabled, ...DEFAULT_STATUSLINE_ITEMS.filter(id => !seen.has(id))]
  })
  const [on, setOn] = useState<ReadonlySet<StatusItemId>>(() => new Set(enabled))
  const [cursor, setCursor] = useState(0)
  const commit = (nextOrder: readonly StatusItemId[], nextOn: ReadonlySet<StatusItemId>): void => {
    setOrder(nextOrder)
    setOn(nextOn)
    change(nextOrder.filter(id => nextOn.has(id)))
  }
  const move = (offset: number): void => {
    const target = cursor + offset
    if (target < 0 || target >= order.length) return
    const next = [...order]
    const [item] = next.splice(cursor, 1)
    next.splice(target, 0, item!)
    commit(next, on)
    setCursor(target)
  }
  useInput((input, key) => {
    if (key.escape || input === 'q' || key.return) return close()
    if (key.upArrow) return setCursor(value => Math.max(0, value - 1))
    if (key.downArrow) return setCursor(value => Math.min(order.length - 1, value + 1))
    if (key.leftArrow) return move(-1)
    if (key.rightArrow) return move(1)
    if (input === 'g') return setCursor(0)
    if (input === 'G') return setCursor(order.length - 1)
    if (input === 'd') {
      commit([...DEFAULT_STATUSLINE_ITEMS], new Set(DEFAULT_STATUSLINE_ITEMS))
      setCursor(0)
      return
    }
    if (input === ' ') {
      const item = order[cursor]
      if (item === undefined) return
      const next = new Set(on)
      if (next.has(item)) next.delete(item)
      else next.add(item)
      commit(order, next)
    }
  })
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  if (viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns('/statusline · esc close', viewport.contentColumns))
  }
  if (viewport.maxHeight === 0) return createElement(Box, { display: 'none' })
  const bodyRows = Math.max(1, viewport.bodyRows - 1)
  const offset = revealRow(0, cursor, order.length, bodyRows)
  const visible = order.slice(offset, offset + bodyRows)
  const meta = new Map(STATUS_ITEMS.map(item => [item.id, item]))
  return createElement(
    Box,
    { width: viewport.outerColumns, borderStyle: 'round', borderColor: inkColor(getPalette().dim), flexDirection: 'column', paddingX: 1 },
    createElement(Text, { color: inkColor(getPalette().brandBright), wrap: 'truncate-end' }, truncateColumns('/statusline · items apply to the live status line below', viewport.contentColumns)),
    ...visible.map((id, index) => {
      const absolute = offset + index
      const selected = absolute === cursor
      const info = meta.get(id)
      return createElement(
        Text,
        {
          key: id,
          color: selected ? inkColor(getPalette().brandBright) : undefined,
          dimColor: !on.has(id) || undefined,
          wrap: 'truncate-end',
        },
        truncateColumns((selected ? '› ' : '  ') + (on.has(id) ? '● ' : '○ ') + (info?.label ?? id) + (info === undefined ? '' : ' · ' + info.description + ' · ' + info.side), viewport.contentColumns),
      )
    }),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns('↑↓ move · space toggle · ←→ reorder · d default · esc close', viewport.contentColumns)),
  )
}

/**
 * The `/model` reasoning-effort stage (the Codex model → reasoning popup
 * contract): one bounded list over the selected model's adapter-advertised
 * effort levels, with the effective effort and the model default marked.
 * Enter applies one level; Esc returns to the model list without applying.
 */
export function EffortPanel({ row, current, select, back }: {
  /** The model row whose advertised levels this stage lists. */
  row: ModelRow
  /** Effective effort currently in force ('' when none), for the ● mark. */
  current: string | undefined
  /** Accept one advertised effort id. */
  select(effortId: string): void
  /** Return to the model list without applying. */
  back(): void
}): ReactElement {
  const [cursor, setCursor] = useState(0)
  const efforts = row.reasoning?.efforts ?? []
  useEffect(() => {
    if (efforts.length === 0) {
      if (cursor !== 0) setCursor(0)
      return
    }
    if (cursor >= efforts.length) setCursor(efforts.length - 1)
  }, [efforts.length, cursor])
  useInput((input, key) => {
    if (key.escape || input === 'q') return back()
    if (efforts.length === 0) return
    if (key.upArrow) {
      setCursor(cursor > 0 ? cursor - 1 : efforts.length - 1)
      return
    }
    if (key.downArrow) {
      setCursor(cursor < efforts.length - 1 ? cursor + 1 : 0)
      return
    }
    if (key.return && efforts[cursor] !== undefined) {
      select(efforts[cursor]!.id)
    }
  })
  return createElement(ListFrame, {
    title: `/model — effort for ${row.providerName} · ${row.modelName}`,
    rows: efforts.map(effort => ({
      key: effort.id,
      text: `${effort.id === current ? '●' : '○'} ${effort.name}${effort.id === row.reasoning?.defaultEffort ? ' · default' : ''}${effort.description === undefined ? '' : ` · ${effort.description}`}`,
    })),
    cursor,
    loading: false,
    query: '',
    footer: '↑↓ choose · enter apply · esc/q back',
  })
}
