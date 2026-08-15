/**
 * Status-line composition for the TUI footer: pipe-separated groups blending
 * the Claude-Code-style identity facts (model, working directory, git branch,
 * session) with the web StatsLine's session figures (turns/steps, model and
 * tool wall time, cache hit, token totals). Pure functions only — the footer
 * renders exactly what {@link buildStatusGroups} returns.
 *
 * @module @deepseek-ai/dsh-tui/render/status
 */

import type { TranscriptStats } from './projection.ts'

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
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/**
 * Compact duration: 45.2s under a minute, 2m42s from there on.
 * @param ms - duration in milliseconds.
 * @returns display string.
 */
export function formatDuration(ms: number): string {
  const s = ms / 1_000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
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
  return `${Math.round(n / 100) / 10}K`
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

/** Identity facts the runner resolves once at mount; empty strings drop out. */
export interface StatusFacts {
  /** `provider/model` selection serving this session. */
  model: string
  /** Agent preset composing this session. */
  mode?: string
  /** Working-directory basename the session serves. */
  cwd: string
  /** Git branch name, empty outside a repository or on a detached HEAD file. */
  branch: string
  /** Short session identifier (last dash-separated segment or tail). */
  sessionId: string
  /** Latest session title (folded from `session/title`); shown in place of the id. */
  title: string
  /** Sandbox-mode override (folded from `sandbox/mode`), empty when never switched. */
  sandbox: string
  /** Live goal summary (folded from `goal/change`), undefined when none. */
  goal: { phase: string; rounds: number; max: number } | undefined
  /** Whether plan mode is active (folded from `plan/mode`). */
  plan: boolean
  /** Active permission preset (folded from `permission/preset`), empty when unknown. */
  permission: string
}

/**
 * Build the footer's display groups; a group with no data drops out whole.
 * @param facts - identity facts resolved by the runner.
 * @param stats - session figures folded from the durable log.
 * @returns one string per pipe-separated group, in display order.
 */
export function buildStatusGroups(facts: StatusFacts, stats: TranscriptStats): string[] {
  const groups: string[] = []
  const identity = [
    facts.model,
    facts.cwd,
    facts.branch === '' ? undefined : `⑂ ${facts.branch}`,
    facts.plan ? '⧉ plan' : undefined,
  ].filter(part => part !== undefined && part !== '')
  if (identity.length > 0) groups.push(identity.join(' · '))
  if (facts.mode !== undefined && facts.mode !== '') groups.push(`mode ${facts.mode}`)
  if (stats.turns > 0 || stats.steps > 0) {
    groups.push(`T${stats.turns} · S${stats.steps}`)
    const durations: string[] = []
    if (stats.llmMs > 0) durations.push(`llm ${formatDuration(stats.llmMs)}`)
    // Decode latency figures (the web StatsLine's TTFT and throughput):
    // average first-token wait and tokens per second over timed steps.
    if (stats.ttftSteps > 0) durations.push(`ttft ${formatDuration(stats.ttftMs / stats.ttftSteps)}`)
    if (stats.decodeMs > 0 && stats.decodeTokens > 0) {
      durations.push(`${formatRate(stats.decodeTokens / (stats.decodeMs / 1_000))} tok/s`)
    }
    if (stats.toolMs > 0) durations.push(`tool ${formatDuration(stats.toolMs)}`)
    if (durations.length > 0) groups.push(durations.join(' · '))
  }
  const cacheHit = cacheHitPercent(stats.usage)
  if (stats.usage.inputTokens > 0 || stats.usage.outputTokens > 0) {
    if (cacheHit !== null) groups.push(`cache ${cacheHit}%`)
    // Context occupancy (the web StatsLine's meter): the most recent
    // reported prompt size against the advertised route capacity.
    if (stats.contextWindow > 0 && stats.lastPromptTokens > 0) {
      groups.push(`ctx ${Math.min(999, Math.round(stats.lastPromptTokens / stats.contextWindow * 100))}%`)
    }
    groups.push(`↑${formatTokens(stats.usage.inputTokens)} ↓${formatTokens(stats.usage.outputTokens)}`)
  }
  // The session title replaces the bare short id whenever one has landed
  // (user rename or provider generation), bounded so a long title cannot
  // crowd out the rest of the line.
  const label = facts.title !== undefined && facts.title !== ''
    ? (facts.title.length > 48 ? `${facts.title.slice(0, 47)}…` : facts.title)
    : facts.sessionId
  if (label !== '') groups.push(label)
  // The permission preset trails the line: switching it changes only the
  // tail, so the left-aligned bar never shifts its other groups. Plain text,
  // the Claude-Code permission-mode display (no glyphs).
  if (facts.permission !== undefined && facts.permission !== '') groups.push(facts.permission)
  // The sandbox override stays implicit when it merely echoes the preset —
  // the badge exists to surface a divergence, not to duplicate the label.
  const sandbox = facts.sandbox ?? ''
  if (sandbox !== '' && sandbox.toLowerCase() !== facts.permission.toLowerCase()) {
    groups.push(`sandbox ${sandbox}`)
  }
  // Goal badge: round progress while active, the phase otherwise.
  if (facts.goal !== undefined) {
    groups.push(facts.goal.phase === 'active'
      ? `◎ r${facts.goal.rounds}/${facts.goal.max}`
      : `◎ ${facts.goal.phase}`)
  }
  return groups
}
