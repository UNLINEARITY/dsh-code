/**
 * Status-bar composition for the TUI footer. Codex/Claude-Code-style split
 * line: identity facts and session figures flow from the left, while the
 * permission badge (the Codex "autonomous selection" anchor, with its
 * shift+tab cycle hint) pins to the right edge. Every segment carries a tone
 * the footer maps to a theme color, and layoutStatusBar degrades the line
 * item by item so it always fits one physical row — truncation with an
 * ellipsis happens only after every lesser group has already dropped out.
 *
 * @module @deepseek-ai/dsh-tui/render/status
 */

import { visibleColumns } from './markdown.ts'
import type { ContextSegments, TranscriptStats } from './projection.ts'
import { singleLineText, truncateColumns } from './text.ts'

/**
 * Compact token count: 517 / 12.2K / 517K / 1.2M (one decimal under three
 * digits), mirroring the web composer's StatsLine format.
 * @param n - token count.
 * @returns display string.
 */
export function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return scaled(n / 1_000) + 'K'
  return scaled(n / 1_000_000) + 'M'
}

/**
 * Compact duration: 45.2s under a minute, 2m42s from there on.
 * @param ms - duration in milliseconds.
 * @returns display string.
 */
export function formatDuration(ms: number): string {
  const s = ms / 1_000
  if (s < 60) return String(Math.round(s * 10) / 10) + 's'
  const whole = Math.round(s)
  return Math.floor(whole / 60) + 'm' + (whole % 60) + 's'
}

/**
 * Compact decode rate: one decimal under a hundred, whole below a thousand,
 * then thousands (15.3 / 124 / 1.2K).
 * @param n - tokens per second.
 * @returns display string.
 */
export function formatRate(n: number): string {
  if (n < 100) return String(Math.round(n * 10) / 10)
  if (n < 1_000) return String(Math.round(n))
  return String(Math.round(n / 100) / 10) + 'K'
}

/**
 * Cache-hit share of billed prompt-side input.
 * @param usage - cumulative token totals.
 * @returns rounded integer percent, or null when no input was billed.
 */
export function cacheHitPercent(usage: TranscriptStats['usage']): number | null {
  return usage.inputTokens === 0
    ? null
    : Math.round(usage.cacheReadTokens / usage.inputTokens * 100)
}

/**
 * Presentation tones for status spans; the footer maps each to a theme color
 * (Codex status-line accents: model/path/branch/state/usage categories).
 */
export type StatusTone =
  | 'model'
  | 'live'
  | 'path'
  | 'branch'
  | 'value'
  | 'label'
  | 'meta'
  | 'accent'
  | 'success'
  | 'warn'
  | 'error'
  // Context-bar segment tones, one DeepSeek blue shade per content type
  // (dark → light: system/prompt/assistant/thinking/tools). Only the
  // context bar emits them; the footer maps each to an existing theme color.
  | 'ctxSystem'
  | 'ctxPrompt'
  | 'ctxAssistant'
  | 'ctxThinking'
  | 'ctxTools'

/** One colored run inside the status bar. */
export interface StatusSpan {
  text: string
  tone: StatusTone
}

/**
 * One pipe-separated cluster on the leading side of the bar. Spans are the
 * full visual sequence: junction separators ride along as their own dim
 * 'label'-tone spans, so joining is a flat concat with no implicit glue.
 */
export interface StatusGroup {
  spans: readonly StatusSpan[]
}

/** One physical row of the footer: leading clusters and trailing badges. */
export interface StatusRow {
  /** Leading clusters, pipe-separated in display order; index 0 is identity. */
  left: readonly StatusGroup[]
  /** Trailing spans pinned to the right edge, dot-separated in display order. */
  right: readonly StatusSpan[]
  /** Whether the shift+tab cycle hint rides after the permission badge. */
  hint: boolean
}

/**
 * The footer layout: two stacked physical rows. Row 1 keeps the primary
 * controls in model, cwd, mode, branch, context, permission order. Row 2
 * carries every secondary session/run figure and degrades independently.
 */
export interface StatusLayout {
  row1: StatusRow
  row2: StatusRow
}

/** Separator between leading clusters. */
export const STATUS_GROUP_SEPARATOR = ' | '
/** Separator between trailing state spans. */
export const STATUS_ITEM_SEPARATOR = ' · '
/** The Codex-style mode cycle hint appended to the permission badge. */
export const STATUS_CYCLE_HINT = ' (shift+tab to cycle)'

/**
 * Interior columns of the segmented context bar (content-type segments plus
 * the free tail whose right edge carries the usage readout). Fixed so the
 * row-2 drop ladder can pre-measure the group; the bar shrinks its labels and
 * readout inside this budget rather than asking the layout for more room.
 */
export const CONTEXT_BAR_WIDTH = 24
/** Occupancy at which the usage readout flips from brand blue to amber. */
export const CONTEXT_WARN_PERCENT = 90
/** Free-tail floor in columns: wide enough for the bare percent readout, so
 * the warning stays visible even at 100%+ occupancy. */
const CONTEXT_MIN_FREE = 5

/** One content-type segment of the context bar (pure data; colors live in app.ts). */
export interface ContextSegmentSpec {
  key: keyof ContextSegments
  /** Tone the footer maps to a DeepSeek blue shade. */
  tone: StatusTone
  /** Labels longest → shortest; the first one fitting the segment width wins. */
  labels: readonly string[]
}

/** The five content types in conversation order, dark → light blue. */
export const CONTEXT_SEGMENTS: readonly ContextSegmentSpec[] = [
  { key: 'system', tone: 'ctxSystem', labels: ['system', 'sys', 's'] },
  { key: 'prompt', tone: 'ctxPrompt', labels: ['prompt', 'pr', 'p'] },
  { key: 'assistant', tone: 'ctxAssistant', labels: ['assistant', 'ast', 'a'] },
  { key: 'thinking', tone: 'ctxThinking', labels: ['think', 'th', 't'] },
  { key: 'tools', tone: 'ctxTools', labels: ['tools', 'tl', 'x'] },
] as const

/** First label whose visible width fits the segment; empty only when none do. */
function chooseContextLabel(labels: readonly string[], width: number): string {
  for (const label of labels) {
    if (visibleColumns(label) <= width) return label
  }
  return ''
}

/** Center a label inside its segment width; the padding spaces carry the tone. */
function centerInSegment(text: string, width: number): string {
  const textWidth = visibleColumns(text)
  const left = Math.floor((width - textWidth) / 2)
  return ' '.repeat(Math.max(0, left)) + text + ' '.repeat(Math.max(0, width - textWidth - left))
}

/**
 * Largest-remainder allocation: distribute `columns` across `values`
 * proportionally, handing each leftover column to the largest remainder.
 */
function allocateProportionally(values: readonly number[], columns: number): number[] {
  if (columns <= 0) return values.map(() => 0)
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return values.map(() => 0)
  const raw = values.map(value => value / total * columns)
  const allocated = raw.map(Math.floor)
  let remaining = columns - allocated.reduce((sum, value) => sum + value, 0)
  const remainders = raw
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder)
  for (const slot of remainders) {
    if (remaining <= 0) break
    allocated[slot.index] = (allocated[slot.index] ?? 0) + 1
    remaining -= 1
  }
  return allocated
}

/** Bar column widths: every non-zero segment keeps at least one column before
 * the remaining columns share by token proportion. */
function allocateBarColumns(values: readonly number[], width: number): number[] {
  const visible = values
    .map((value, index) => (value > 0 ? index : -1))
    .filter(index => index >= 0)
  if (visible.length === 0 || visible.length >= width) {
    return allocateProportionally(values, width)
  }
  const minimum = values.map(() => 0)
  for (const index of visible) minimum[index] = 1
  const remaining = allocateProportionally(values, width - visible.length)
  return minimum.map((min, index) => min + (remaining[index] ?? 0))
}

/**
 * Render context occupancy as a segmented bar: one DeepSeek-blue run per
 * content type (system/prompt/assistant/thinking/tools), column widths
 * proportional to their estimated token share, each with a centered label
 * that shortens to fit (system→sys→s). The remaining free tail is a dim
 * track whose right edge carries the usage readout (`12.3K/1.0M 25%`,
 * shrinking to the bare percent as the tail narrows). The readout flips to
 * amber once occupancy reaches the warning threshold; the segment blues stay
 * untouched so the composition remains readable at full context. The used
 * total comes from the reported `lastPromptTokens`, never from the estimates.
 * @param segments - estimated used tokens per content type.
 * @param usedTokens - reported used tokens (drives the readout and percent).
 * @param contextWindow - route capacity.
 * @param width - total bar interior columns.
 * @returns tone-split spans for the footer to paint.
 */
export function contextBar(
  segments: ContextSegments,
  usedTokens: number,
  contextWindow: number,
  width: number,
): readonly StatusSpan[] {
  if (width <= 0 || contextWindow <= 0) return []
  const used = Math.max(0, usedTokens)
  const percent = Math.round(used / contextWindow * 100)
  const warning = percent >= CONTEXT_WARN_PERCENT
  const readoutTone: StatusTone = warning ? 'warn' : 'value'

  const freeShare = Math.round(Math.max(0, contextWindow - used) / contextWindow * width)
  const freeColumns = Math.min(width, Math.max(freeShare, CONTEXT_MIN_FREE))
  const usedColumns = Math.max(0, width - freeColumns)

  const total = `${formatTokens(used)}/${formatTokens(contextWindow)}`
  const percentText = `${percent}%`
  const readout = freeColumns >= visibleColumns(`${total} ${percentText}`)
    ? `${total} ${percentText}`
    : freeColumns >= visibleColumns(percentText)
      ? percentText
      : ''

  const values = CONTEXT_SEGMENTS.map(segment => segments[segment.key])
  const estimated = values.reduce((sum, value) => sum + value, 0)
  // No estimate yet (a resumed session before any text-bearing event): treat
  // the whole reported used context as one prompt segment instead of an
  // empty bar.
  const allocation = allocateBarColumns(
    estimated > 0 ? values : [0, used, 0, 0, 0],
    usedColumns,
  )
  const spans: StatusSpan[] = []
  for (let index = 0; index < CONTEXT_SEGMENTS.length; index += 1) {
    const columns = allocation[index] ?? 0
    if (columns <= 0) continue
    spans.push({
      text: centerInSegment(chooseContextLabel(CONTEXT_SEGMENTS[index].labels, columns), columns),
      tone: CONTEXT_SEGMENTS[index].tone,
    })
  }
  const pad = freeColumns - visibleColumns(readout)
  if (pad > 0) spans.push({ text: '▱'.repeat(pad), tone: 'label' })
  if (readout !== '') spans.push({ text: readout, tone: readoutTone })
  return spans
}

/**
 * One customizable status item (the Codex /statusline picker contract).
 * 'left' items render as pipe-separated clusters after the identity dot;
 * 'right' items pin to the right edge as dot-separated state badges.
 */
export type StatusItemId =
  | 'model'
  | 'cwd'
  | 'branch'
  | 'plan'
  | 'mode'
  | 'turns'
  | 'durations'
  | 'cache'
  | 'context'
  | 'tokens'
  | 'title'
  | 'goal'
  | 'sandbox'
  | 'permission'

/** Picker-facing metadata for one customizable item. */
export interface StatusItemInfo {
  id: StatusItemId
  /** Short picker label. */
  label: string
  /** One-line picker description of what the item shows. */
  description: string
  /** Which side of the split row the item renders on. */
  side: 'left' | 'right'
}

/** The full item catalog in canonical order (the /statusline default). */
export const STATUS_ITEMS: readonly StatusItemInfo[] = [
  { id: 'model', label: 'model', description: 'provider/model serving this session', side: 'left' },
  { id: 'cwd', label: 'cwd', description: 'working-directory basename', side: 'left' },
  { id: 'mode', label: 'mode', description: 'agent preset composing the session', side: 'left' },
  { id: 'branch', label: 'branch', description: 'git branch inside a repository', side: 'left' },
  { id: 'context', label: 'context', description: 'context-window occupancy meter', side: 'left' },
  { id: 'permission', label: 'permission', description: 'permission preset badge with cycle hint', side: 'right' },
  { id: 'plan', label: 'plan', description: 'plan-mode state mark', side: 'left' },
  { id: 'turns', label: 'turns', description: 'turn and step counters', side: 'left' },
  { id: 'durations', label: 'durations', description: 'llm/ttft/decode/tool wall time', side: 'left' },
  { id: 'cache', label: 'cache', description: 'cache-hit share of billed input', side: 'left' },
  { id: 'tokens', label: 'tokens', description: 'cumulative input/output tokens', side: 'left' },
  { id: 'title', label: 'title', description: 'session title or short id', side: 'left' },
  { id: 'goal', label: 'goal', description: 'live goal phase and round progress', side: 'left' },
  { id: 'sandbox', label: 'sandbox', description: 'divergent sandbox-mode override', side: 'left' },
]

/**
 * Default order: the whole catalog (matches the pre-customization bar).
 * The busy dot is not an item — it always leads the identity cluster.
 */
export const DEFAULT_STATUSLINE_ITEMS: readonly StatusItemId[] = STATUS_ITEMS.map(item => item.id)

/**
 * Parse a persisted statusline item list. The stored value is the ordered
 * set of ENABLED items (the Codex /statusline contract): unknown ids and
 * duplicates drop out, and a non-array value (missing or corrupt file)
 * falls back to the full default set. An explicitly empty array is valid —
 * the bar degrades to its busy dot alone.
 * @param value - the raw parsed JSON value (expected string[]).
 * @returns the normalized ordered item list.
 */
export function parseStatuslineItems(value: unknown): readonly StatusItemId[] {
  if (!Array.isArray(value)) return [...DEFAULT_STATUSLINE_ITEMS]
  const known = new Set(STATUS_ITEMS.map(item => item.id))
  const kept: StatusItemId[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && known.has(entry as StatusItemId) && !kept.includes(entry as StatusItemId)) {
      kept.push(entry as StatusItemId)
    }
  }
  return kept
}

/** Minimum blank gap kept between the leading and trailing sides. */
const LEFT_RIGHT_GAP = 2
/** Column held back so Ink/yoga measurement drift can never force a wrap. */
const WIDTH_SAFETY = 1
/** Column budget for the session title before it ellipsizes. */
const TITLE_BUDGET = 48

/**
 * Primary-row drop ranks: context drops before permission; the identity
 * cluster never drops and ellipsizes only after the right badge is gone.
 * Secondary-row groups reuse the remaining ranks independently.
 */
const RANK_TITLE = 10
const RANK_TOKENS = 50
const RANK_COUNTS = 90
const RANK_CONTEXT = 90
const RANK_SANDBOX = 92
const RANK_GOAL = 95
const RANK_BADGE = 100
const RANK_IDENTITY = Number.POSITIVE_INFINITY

/** Row 2 drop ranks: title and durations go first; state and counts survive longest. */
const RANK2_DURATIONS = 40
const RANK2_CACHE = 50
const RANK2_PLAN = 70

/** Identity facts the runner resolves once at mount; empty strings drop out. */
export interface StatusFacts {
  /** 'provider/model' selection serving this session. */
  model: string
  /** Agent preset composing this session. */
  mode?: string
  /** Working-directory basename the session serves. */
  cwd: string
  /** Git branch name, empty outside a repository or on a detached HEAD file. */
  branch: string
  /** Short session identifier (last dash-separated segment or tail). */
  sessionId: string
  /** Latest session title (folded from 'session/title'); shown in place of the id. */
  title: string
  /** Sandbox-mode override (folded from 'sandbox/mode'), empty when never switched. */
  sandbox: string
  /** Live goal summary (folded from 'goal/change'), undefined when none. */
  goal: { phase: string; rounds: number; max: number } | undefined
  /** Whether plan mode is active (folded from 'plan/mode'). */
  plan: boolean
  /** Active or pending permission preset; empty only when the service is unavailable. */
  permission: string
}

/**
 * Traffic-light tone for a permission preset: read-only stays success green,
 * full access reads error red, and every workspace-scoped middle ground
 * (including unknown presets) reads warning amber.
 * @param permission - active permission preset label.
 * @returns tone for the badge span.
 */
export function permissionTone(permission: string): StatusTone {
  const label = permission.toLowerCase()
  if (label.includes('read')) return 'success'
  if (label.includes('danger') || label.includes('full')) return 'error'
  return 'warn'
}

/** Display-safe external text: one row, controls escaped. */
function safe(text: string): string {
  return singleLineText(text)
}

/** Dim junction separator span inside a cluster. */
function sep(): StatusSpan {
  return { text: ' · ', tone: 'label' }
}

/** Total visible columns of a span list (separators ride inside the spans). */
function spansWidth(spans: readonly StatusSpan[]): number {
  let width = 0
  for (const span of spans) width += visibleColumns(span.text)
  return width
}

/** Join widths of parts with one fixed separator between neighbors. */
function joinWidth(parts: readonly number[], separator: number): number {
  if (parts.length === 0) return 0
  let width = 0
  for (const part of parts) width += part
  return width + separator * (parts.length - 1)
}

/** Build every candidate group/span with its drop rank and item id. */
function buildCandidates(
  facts: StatusFacts,
  stats: TranscriptStats,
  busy: boolean,
  enabled: ReadonlySet<string>,
): {
  left: { group: StatusGroup; rank: number; id: string }[]
  right: { span: StatusSpan; rank: number; id: string }[]
  badge: number
  row2: { group: StatusGroup; rank: number; id: string }[]
} {
  const identity: StatusSpan[] = [
    { text: busy ? '● ' : '○ ', tone: busy ? 'live' : 'meta' },
  ]
  // The dot glues straight to the first fact; further facts join through
  // explicit dim separators, so an absent model never strands a leading ' · '.
  const push = (span: StatusSpan): void => {
    if (identity.length > 1) identity.push(sep())
    identity.push(span)
  }
  const model = safe(facts.model)
  if (model !== '' && enabled.has('model')) {
    // The effective reasoning effort rides the model identity as
    // `provider/model@effort` (Codex's model-with-reasoning status item): the
    // projection folds the latest request header's effort, so a resumed
    // session and every request after a /effort pick show what the session
    // actually uses. An empty effort keeps the bare pair.
    const effort = safe(stats.reasoningEffort)
    push({ text: effort === '' ? model : `${model}@${effort}`, tone: 'model' })
  }
  const cwd = safe(facts.cwd)
  if (cwd !== '' && enabled.has('cwd')) push({ text: cwd, tone: 'path' })
  const mode = safe(facts.mode ?? '')
  if (mode !== '' && enabled.has('mode')) {
    push({ text: '/mode ', tone: 'label' })
    identity.push({ text: mode, tone: 'accent' })
  }
  const branch = safe(facts.branch)
  if (branch !== '' && enabled.has('branch')) push({ text: '⑂ ' + branch, tone: 'branch' })

  const left: { group: StatusGroup; rank: number; id: string }[] = [
    { group: { spans: identity }, rank: RANK_IDENTITY, id: 'identity' },
  ]
  const right: { span: StatusSpan; rank: number; id: string }[] = []
  const row2: { group: StatusGroup; rank: number; id: string }[] = []

  if (facts.plan && enabled.has('plan')) {
    row2.push({ group: { spans: [{ text: '⧉ plan', tone: 'accent' }] }, rank: RANK2_PLAN, id: 'plan' })
  }

  if (stats.turns > 0 || stats.steps > 0) {
    if (enabled.has('turns')) {
      // Label/value pairs join through explicit dim separators.
      const counts: StatusSpan[] = []
      const pair = (label: string, value: string): void => {
        if (counts.length > 0) counts.push(sep())
        counts.push({ text: label + ' ', tone: 'label' }, { text: value, tone: 'value' })
      }
      pair('turns', String(stats.turns))
      pair('steps', String(stats.steps))
      row2.push({ group: { spans: counts }, rank: RANK_COUNTS, id: 'turns' })
    }
    if (enabled.has('durations')) {
      // Model round-trip, first-token latency, decode rate, and tool wall
      // time; the label keeps its one trailing space so each reads as one
      // figure ('model 45.2s'). Named in full — no single-letter codes.
      const durations: StatusSpan[] = []
      const pair = (label: string, value: string): void => {
        if (durations.length > 0) durations.push(sep())
        durations.push({ text: label + ' ', tone: 'label' }, { text: value, tone: 'value' })
      }
      if (stats.llmMs > 0) pair('model', formatDuration(stats.llmMs))
      if (stats.ttftSteps > 0) pair('latency', formatDuration(stats.ttftMs / stats.ttftSteps))
      if (stats.decodeMs > 0 && stats.decodeTokens > 0) {
        if (durations.length > 0) durations.push(sep())
        durations.push(
          { text: formatRate(stats.decodeTokens / (stats.decodeMs / 1_000)), tone: 'value' },
          { text: ' tokens/s', tone: 'label' },
        )
      }
      if (stats.toolMs > 0) pair('tool', formatDuration(stats.toolMs))
      if (durations.length > 0) {
        row2.push({ group: { spans: durations }, rank: RANK2_DURATIONS, id: 'durations' })
      }
    }
  }

  const cacheHit = cacheHitPercent(stats.usage)
  if (cacheHit !== null && enabled.has('cache')) {
    row2.push({
      group: { spans: [{ text: 'cache ', tone: 'label' }, { text: cacheHit + '%', tone: 'value' }] },
      rank: RANK2_CACHE,
      id: 'cache',
    })
  }
  // Context occupancy as a segmented bar: per-content-type runs colored by
  // their own blue shade with a right-aligned usage readout. The used total
  // is the most recent reported prompt size against the advertised route
  // capacity (the same figures the old bracket bar showed).
  if (stats.contextWindow > 0 && stats.lastPromptTokens > 0 && enabled.has('context')) {
    left.push({
      group: {
        spans: [
          { text: 'context ', tone: 'label' },
          ...contextBar(stats.contextSegments, stats.lastPromptTokens, stats.contextWindow, CONTEXT_BAR_WIDTH),
        ],
      },
      rank: RANK_CONTEXT,
      id: 'context',
    })
  }
  if ((stats.usage.inputTokens > 0 || stats.usage.outputTokens > 0) && enabled.has('tokens')) {
    const tokens: StatusSpan[] = []
    const pair = (label: string, value: string): void => {
      if (tokens.length > 0) tokens.push(sep())
      tokens.push({ text: label + ' ', tone: 'label' }, { text: value, tone: 'value' })
    }
    pair('in', formatTokens(stats.usage.inputTokens))
    pair('out', formatTokens(stats.usage.outputTokens))
    row2.push({ group: { spans: tokens }, rank: RANK_TOKENS, id: 'tokens' })
  }

  // The session title replaces the bare short id whenever one has landed
  // (user rename or provider generation); the bound is column-based so a
  // CJK title cannot outgrow its budget.
  const rawLabel = facts.title !== undefined && facts.title !== '' ? facts.title : facts.sessionId
  const label = truncateColumns(safe(rawLabel), TITLE_BUDGET)
  if (label !== '' && enabled.has('title')) {
    row2.push({ group: { spans: [{ text: label, tone: 'meta' }] }, rank: RANK_TITLE, id: 'title' })
  }

  // Secondary state rides row 2; permission alone remains right-pinned on row 1.
  if (facts.goal !== undefined && enabled.has('goal')) {
    row2.push({
      group: {
        spans: [{
          text: facts.goal.phase === 'active'
            ? '◎ round ' + facts.goal.rounds + '/' + facts.goal.max
            : '◎ ' + safe(facts.goal.phase),
          tone: 'accent',
        }],
      },
      rank: RANK_GOAL,
      id: 'goal',
    })
  }
  // The sandbox override stays implicit when it merely echoes the preset.
  const sandbox = safe(facts.sandbox ?? '')
  if (sandbox !== '' && sandbox.toLowerCase() !== facts.permission.toLowerCase() && enabled.has('sandbox')) {
    row2.push({ group: { spans: [{ text: 'sandbox ' + sandbox, tone: 'warn' }] }, rank: RANK_SANDBOX, id: 'sandbox' })
  }
  const permission = safe(facts.permission)
  let badge = -1
  if (permission !== '' && enabled.has('permission')) {
    right.push({ span: { text: `/permission ${permission}`, tone: permissionTone(permission) }, rank: RANK_BADGE, id: 'permission' })
    badge = right.length - 1
  }
  return { left, right, badge, row2 }
}

/**
 * Compose the two-row footer layout under a column budget. Row 1 keeps model,
 * cwd, mode, branch, context, then the right-pinned permission badge and cycle
 * hint. It drops hint, context, and permission before ellipsizing identity.
 * Row 2 fits all secondary figures and state within its own budget.
 * @param facts - identity facts resolved by the runner.
 * @param stats - session figures folded from the durable log.
 * @param columns - usable columns for each row (before their left padding).
 * @param options - 'busy' hides the cycle hint while a turn runs (Codex
 * keeps mode hints idle-only); 'items' is the ordered enabled-item config
 * from /statusline (defaults to the full catalog). Display order follows the
 * config per side while the drop ladder keeps its fixed ranks.
 * @returns the two rows to render; row1.left is never empty.
 */
export function layoutStatusBar(
  facts: StatusFacts,
  stats: TranscriptStats,
  columns: number,
  options: { busy?: boolean; items?: readonly string[] } = {},
): StatusLayout {
  const busy = options.busy === true
  const items = options.items ?? DEFAULT_STATUSLINE_ITEMS
  const enabled = new Set(items)
  const budget = Math.max(1, Math.floor(columns) - WIDTH_SAFETY)
  const { left, right, badge, row2 } = buildCandidates(facts, stats, busy, enabled)
  const groupSeparator = visibleColumns(STATUS_GROUP_SEPARATOR)
  const itemSeparator = visibleColumns(STATUS_ITEM_SEPARATOR)

  // Display order follows the config per side (Codex /statusline reorder).
  // The identity cluster stays anchored first — it owns the busy dot.
  const position = new Map(items.map((id, index) => [id, index]))
  const byPosition = (a: { id: string }, b: { id: string }): number =>
    (position.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.id) ?? Number.MAX_SAFE_INTEGER)
  const orderedLeft = [left[0], ...left.slice(1).sort(byPosition)]
  const orderedRight = right.slice().sort(byPosition)
  const orderedRow2 = row2.slice().sort(byPosition)

  let hint = badge >= 0 && !busy
  const leftKept = [...orderedLeft]
  const rightKept = [...orderedRight]

  const width = (): number => {
    const leftWidth = joinWidth(
      leftKept.map(entry => spansWidth(entry.group.spans)),
      groupSeparator,
    )
    const rightWidth = joinWidth(rightKept.map(entry => visibleColumns(entry.span.text)), itemSeparator)
      + (hint ? visibleColumns(STATUS_CYCLE_HINT) : 0)
    return rightWidth > 0 ? leftWidth + LEFT_RIGHT_GAP + rightWidth : leftWidth
  }

  while (width() > budget) {
    if (hint) {
      hint = false
      continue
    }
    let dropLeft = -1
    let dropRight = -1
    let dropRank = Number.POSITIVE_INFINITY
    for (let index = 0; index < leftKept.length; index += 1) {
      const rank = leftKept[index].rank
      if (rank < dropRank) {
        dropRank = rank
        dropLeft = index
        dropRight = -1
      }
    }
    for (let index = 0; index < rightKept.length; index += 1) {
      const rank = rightKept[index].rank
      if (rank < dropRank) {
        dropRank = rank
        dropRight = index
        dropLeft = -1
      }
    }
    if (dropLeft < 0 && dropRight < 0) break
    if (dropLeft >= 0) {
      leftKept.splice(dropLeft, 1)
    } else {
      rightKept.splice(dropRight, 1)
      if (dropRight === rightKept.length) hint = false
    }
  }

  // Only the identity cluster can remain overflowing: collapse to it and
  // ellipsize inside the budget as the last resort. Flat spans make the
  // joined text identical to what the row would have displayed.
  if (width() > budget) {
    rightKept.length = 0
    hint = false
    while (leftKept.length > 1) leftKept.pop()
    const identity = leftKept[0].group
    const joined = identity.spans.map(span => span.text).join('')
    leftKept[0] = {
      group: { spans: [{ text: truncateColumns(joined, budget), tone: 'model' }] },
      rank: RANK_IDENTITY,
      id: 'identity',
    }
  }

  // Row 2 fits its own budget; the lowest-rank group drops first until the
  // row fits or nothing is left. An empty row2 is a valid state — the footer
  // degrades back to a single status row.
  const row2Kept = [...orderedRow2]
  const row2Width = (): number =>
    joinWidth(row2Kept.map(entry => spansWidth(entry.group.spans)), groupSeparator)
  while (row2Width() > budget && row2Kept.length > 0) {
    let dropIndex = 0
    let dropRank = Number.POSITIVE_INFINITY
    for (let index = 0; index < row2Kept.length; index += 1) {
      if (row2Kept[index].rank < dropRank) {
        dropRank = row2Kept[index].rank
        dropIndex = index
      }
    }
    row2Kept.splice(dropIndex, 1)
  }

  return {
    row1: {
      left: leftKept.map(entry => entry.group),
      right: rightKept.map(entry => entry.span),
      hint,
    },
    row2: {
      left: row2Kept.map(entry => entry.group),
      right: [],
      hint: false,
    },
  }
}
