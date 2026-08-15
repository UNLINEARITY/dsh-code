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
import type { TranscriptStats } from './projection.ts'
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

/** The footer layout: leading clusters, trailing state spans, cycle hint. */
export interface StatusLayout {
  /** Leading clusters, pipe-separated in display order; index 0 is identity. */
  left: readonly StatusGroup[]
  /** Trailing spans pinned to the right edge, dot-separated in display order. */
  right: readonly StatusSpan[]
  /** Whether the shift+tab cycle hint rides after the permission badge. */
  hint: boolean
}

/** Separator between leading clusters. */
export const STATUS_GROUP_SEPARATOR = ' | '
/** Separator between trailing state spans. */
export const STATUS_ITEM_SEPARATOR = ' · '
/** The Codex-style mode cycle hint appended to the permission badge. */
export const STATUS_CYCLE_HINT = ' (shift+tab to cycle)'

/** Minimum blank gap kept between the leading and trailing sides. */
const LEFT_RIGHT_GAP = 2
/** Column held back so Ink/yoga measurement drift can never force a wrap. */
const WIDTH_SAFETY = 1
/** Column budget for the session title before it ellipsizes. */
const TITLE_BUDGET = 48

/**
 * Drop ranks: when the row overflows, the lowest rank disappears first. The
 * identity cluster never drops — it ellipsizes instead. State outlives
 * telemetry: the goal and divergent-sandbox badges drop only after every
 * figure, and the permission badge outlives everything so the autonomy
 * selection stays readable while it fits.
 */
const RANK_TITLE = 10
const RANK_MODE = 40
const RANK_TOKENS = 50
const RANK_CONTEXT = 60
const RANK_CACHE = 70
const RANK_DURATIONS = 80
const RANK_COUNTS = 90
const RANK_SANDBOX = 92
const RANK_GOAL = 95
const RANK_BADGE = 100
const RANK_IDENTITY = Number.POSITIVE_INFINITY

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
  /** Active permission preset (folded from 'permission/preset'), empty when unknown. */
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

/** Build every candidate group/span with its drop rank. */
function buildCandidates(
  facts: StatusFacts,
  stats: TranscriptStats,
  busy: boolean,
): {
  left: { group: StatusGroup; rank: number }[]
  right: { span: StatusSpan; rank: number }[]
  badge: number
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
  if (model !== '') push({ text: model, tone: 'model' })
  const cwd = safe(facts.cwd)
  if (cwd !== '') push({ text: cwd, tone: 'path' })
  const branch = safe(facts.branch)
  if (branch !== '') push({ text: '⑂ ' + branch, tone: 'branch' })
  if (facts.plan) push({ text: '⧉ plan', tone: 'accent' })

  const left: { group: StatusGroup; rank: number }[] = [
    { group: { spans: identity }, rank: RANK_IDENTITY },
  ]
  const right: { span: StatusSpan; rank: number }[] = []

  const mode = safe(facts.mode ?? '')
  if (mode !== '') {
    left.push({
      group: { spans: [{ text: 'mode ', tone: 'label' }, { text: mode, tone: 'accent' }] },
      rank: RANK_MODE,
    })
  }

  if (stats.turns > 0 || stats.steps > 0) {
    left.push({
      group: { spans: [{ text: 'T' + stats.turns + ' · S' + stats.steps, tone: 'value' }] },
      rank: RANK_COUNTS,
    })
    // Decode latency figures (the web StatsLine's TTFT and throughput):
    // average first-token wait and tokens per second over timed steps.
    // Pairs join through explicit dim separators; the label keeps its one
    // trailing space so 'llm 45.2s' reads as one figure.
    const durations: StatusSpan[] = []
    const pair = (label: string, value: string): void => {
      if (durations.length > 0) durations.push(sep())
      durations.push({ text: label + ' ', tone: 'label' }, { text: value, tone: 'value' })
    }
    if (stats.llmMs > 0) pair('llm', formatDuration(stats.llmMs))
    if (stats.ttftSteps > 0) pair('ttft', formatDuration(stats.ttftMs / stats.ttftSteps))
    if (stats.decodeMs > 0 && stats.decodeTokens > 0) {
      if (durations.length > 0) durations.push(sep())
      durations.push(
        { text: formatRate(stats.decodeTokens / (stats.decodeMs / 1_000)), tone: 'value' },
        { text: ' tok/s', tone: 'label' },
      )
    }
    if (stats.toolMs > 0) pair('tool', formatDuration(stats.toolMs))
    if (durations.length > 0) {
      left.push({ group: { spans: durations }, rank: RANK_DURATIONS })
    }
  }

  const cacheHit = cacheHitPercent(stats.usage)
  if (cacheHit !== null) {
    left.push({
      group: { spans: [{ text: 'cache ', tone: 'label' }, { text: cacheHit + '%', tone: 'value' }] },
      rank: RANK_CACHE,
    })
  }
  // Context occupancy (the web StatsLine's meter): the most recent reported
  // prompt size against the advertised route capacity.
  if (stats.contextWindow > 0 && stats.lastPromptTokens > 0) {
    left.push({
      group: {
        spans: [
          { text: 'ctx ', tone: 'label' },
          { text: Math.min(999, Math.round(stats.lastPromptTokens / stats.contextWindow * 100)) + '%', tone: 'value' },
        ],
      },
      rank: RANK_CONTEXT,
    })
  }
  if (stats.usage.inputTokens > 0 || stats.usage.outputTokens > 0) {
    left.push({
      group: {
        spans: [{
          text: '↑' + formatTokens(stats.usage.inputTokens) + ' ↓' + formatTokens(stats.usage.outputTokens),
          tone: 'value',
        }],
      },
      rank: RANK_TOKENS,
    })
  }

  // The session title replaces the bare short id whenever one has landed
  // (user rename or provider generation); the bound is column-based so a
  // CJK title cannot outgrow its budget.
  const rawLabel = facts.title !== undefined && facts.title !== '' ? facts.title : facts.sessionId
  const label = truncateColumns(safe(rawLabel), TITLE_BUDGET)
  if (label !== '') {
    left.push({ group: { spans: [{ text: label, tone: 'meta' }] }, rank: RANK_TITLE })
  }

  // Goal badge on the right (Codex goal indicator): round progress while
  // active, the phase otherwise.
  if (facts.goal !== undefined) {
    right.push({
      span: {
        text: facts.goal.phase === 'active'
          ? '◎ r' + facts.goal.rounds + '/' + facts.goal.max
          : '◎ ' + safe(facts.goal.phase),
        tone: 'accent',
      },
      rank: RANK_GOAL,
    })
  }
  // The sandbox override stays implicit when it merely echoes the preset —
  // the badge exists to surface a divergence, not to duplicate the label.
  const sandbox = safe(facts.sandbox ?? '')
  if (sandbox !== '' && sandbox.toLowerCase() !== facts.permission.toLowerCase()) {
    right.push({ span: { text: 'sandbox ' + sandbox, tone: 'warn' }, rank: RANK_SANDBOX })
  }
  const permission = safe(facts.permission)
  let badge = -1
  if (permission !== '') {
    right.push({ span: { text: permission, tone: permissionTone(permission) }, rank: RANK_BADGE })
    badge = right.length - 1
  }
  return { left, right, badge }
}

/**
 * Compose the one-row footer layout under a column budget. Degrades in a
 * fixed order — cycle hint, then title, mode preset, token figures, context,
 * cache, durations, counts, goal, divergent sandbox, permission badge — and
 * only then ellipsizes the identity cluster, so the row never wraps.
 * @param facts - identity facts resolved by the runner.
 * @param stats - session figures folded from the durable log.
 * @param columns - usable columns for the row (before its left padding).
 * @param options - 'busy' hides the cycle hint while a turn runs (Codex
 * keeps mode hints idle-only).
 * @returns the segments to render; left is never empty.
 */
export function layoutStatusBar(
  facts: StatusFacts,
  stats: TranscriptStats,
  columns: number,
  options: { busy?: boolean } = {},
): StatusLayout {
  const busy = options.busy === true
  const budget = Math.max(1, Math.floor(columns) - WIDTH_SAFETY)
  const { left, right, badge } = buildCandidates(facts, stats, busy)
  const groupSeparator = visibleColumns(STATUS_GROUP_SEPARATOR)
  const itemSeparator = visibleColumns(STATUS_ITEM_SEPARATOR)

  let hint = badge >= 0 && !busy
  const leftKept = [...left]
  const rightKept = [...right]

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
    }
  }

  return {
    left: leftKept.map(entry => entry.group),
    right: rightKept.map(entry => entry.span),
    hint,
  }
}
