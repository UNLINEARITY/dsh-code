/** Status-bar formatting, tone layout, and one-row width degradation. */

import { describe, expect, it } from 'vitest'
import type { TranscriptStats } from '../src/render/projection.ts'
import { visibleColumns } from '../src/render/markdown.ts'
import {
  cacheHitPercent,
  DEFAULT_STATUSLINE_ITEMS,
  formatDuration,
  formatTokens,
  layoutStatusBar,
  parseStatuslineItems,
  permissionTone,
  STATUS_CYCLE_HINT,
  STATUS_GROUP_SEPARATOR,
  STATUS_ITEM_SEPARATOR,
  type StatusFacts,
  type StatusLayout,
} from '../src/render/status.ts'

const emptyStats: TranscriptStats = {
  turns: 0,
  steps: 0,
  llmMs: 0,
  toolMs: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
  lastPromptTokens: 0,
  contextWindow: 0,
  ttftMs: 0,
  ttftSteps: 0,
  decodeMs: 0,
  decodeTokens: 0,
}

const baseFacts: StatusFacts = {
  model: 'm',
  cwd: 'r',
  branch: '',
  sessionId: 's',
  title: '',
  sandbox: '',
  goal: undefined,
  plan: false,
  permission: '',
}

/** Plain text of the whole bar exactly as the footer would join it. */
function rowText(layout: StatusLayout): string {
  const left = layout.left
    .map(group => group.spans.map(span => span.text).join(''))
    .join(STATUS_GROUP_SEPARATOR)
  const right = layout.right.map(span => span.text).join(STATUS_ITEM_SEPARATOR)
    + (layout.hint ? STATUS_CYCLE_HINT : '')
  return right === '' ? left : left + '  ' + right
}

/** Group text with spans concatenated (separators ride inside the spans). */
function groupText(layout: StatusLayout): string[] {
  return layout.left.map(group => group.spans.map(span => span.text).join(''))
}

/** Texts of every kept group/span, for monotonic degradation checks. */
function keptTexts(layout: StatusLayout): string[] {
  return [
    ...layout.left.flatMap(group => group.spans.map(span => span.text)),
    ...layout.right.map(span => span.text),
  ]
}

describe('status formatting', () => {
  it('compacts token counts like the web StatsLine', () => {
    expect(formatTokens(517)).toBe('517')
    expect(formatTokens(12_160)).toBe('12.2K')
    expect(formatTokens(517_000)).toBe('517K')
    expect(formatTokens(1_230_000)).toBe('1.2M')
  })

  it('compacts durations under and over a minute', () => {
    expect(formatDuration(45_233)).toBe('45.2s')
    expect(formatDuration(162_000)).toBe('2m42s')
  })

  it('computes cache hit only over billed input', () => {
    expect(cacheHitPercent(emptyStats.usage)).toBeNull()
    expect(cacheHitPercent({ inputTokens: 200, outputTokens: 0, cacheReadTokens: 150 })).toBe(75)
  })
})

describe('status layout', () => {
  it('accents identity facts and trails the session label', () => {
    const layout = layoutStatusBar(
      { ...baseFacts, model: 'deepseek/chat', cwd: 'deepseek-harness', branch: 'dsh-cli', sessionId: 'ab12cd34' },
      emptyStats,
      120,
    )
    expect(layout.left).toHaveLength(2)
    expect(groupText(layout)).toEqual(['○ deepseek/chat · deepseek-harness · ⑂ dsh-cli', 'ab12cd34'])
    expect(layout.left[0].spans.map(span => span.tone)).toEqual(['meta', 'model', 'label', 'path', 'label', 'branch'])
    expect(layout.left[1].spans).toEqual([{ text: 'ab12cd34', tone: 'meta' }])
    expect(layout.right).toEqual([])
    expect(layout.hint).toBe(false)
  })

  it('marks the busy dot live and the plan state accented', () => {
    const layout = layoutStatusBar({ ...baseFacts, plan: true }, emptyStats, 120, { busy: true })
    const identity = layout.left[0].spans
    expect(identity[0]).toEqual({ text: '● ', tone: 'live' })
    expect(identity.at(-1)).toEqual({ text: '⧉ plan', tone: 'accent' })
  })

  it('keeps preset, counts, durations, cache, context, and tokens as pipe groups', () => {
    const layout = layoutStatusBar(
      { ...baseFacts, mode: 'code', model: 'm', cwd: 'r', branch: 'main', sessionId: 's' },
      {
        ...emptyStats,
        turns: 2,
        steps: 5,
        llmMs: 45_233,
        toolMs: 162_000,
        usage: { inputTokens: 12_160, outputTokens: 2_400, cacheReadTokens: 9_728 },
      },
      160,
    )
    expect(groupText(layout)).toEqual([
      '○ m · r · ⑂ main',
      'mode code',
      'T2 · S5',
      'llm 45.2s · tool 2m42s',
      'cache 80%',
      '↑12.2K ↓2.4K',
      's',
    ])
    expect(layout.left[0].spans[1]).toEqual({ text: 'm', tone: 'model' })
    expect(layout.left[2].spans[0]).toEqual({ text: 'T2 · S5', tone: 'value' })
    expect(layout.left[3].spans[0]).toEqual({ text: 'llm ', tone: 'label' })
    expect(layout.left[3].spans[1]).toEqual({ text: '45.2s', tone: 'value' })
  })

  it('adds the context-occupancy meter once capacity and a report exist', () => {
    const layout = layoutStatusBar(
      { ...baseFacts, model: 'm', cwd: 'r', sessionId: '' },
      {
        ...emptyStats,
        usage: { inputTokens: 32_000, outputTokens: 800, cacheReadTokens: 0 },
        lastPromptTokens: 32_000,
        contextWindow: 128_000,
      },
      120,
    )
    expect(groupText(layout)).toEqual([
      '○ m · r',
      'cache 0%',
      'ctx 25%',
      '↑32K ↓800',
    ])
  })

  it('shows the session title in place of the short id once one lands', () => {
    const titled = layoutStatusBar({ ...baseFacts, sessionId: 'ab12cd34', title: 'fix the login bug' }, emptyStats, 120)
    expect(titled.left.at(-1).spans).toEqual([{ text: 'fix the login bug', tone: 'meta' }])
    const untitled = layoutStatusBar({ ...baseFacts, sessionId: 'ab12cd34', title: '' }, emptyStats, 120)
    expect(untitled.left.at(-1).spans).toEqual([{ text: 'ab12cd34', tone: 'meta' }])
  })

  it('pins the permission badge right with the idle cycle hint', () => {
    const layout = layoutStatusBar({ ...baseFacts, permission: 'workspace-write' }, emptyStats, 120)
    expect(layout.right).toEqual([{ text: 'workspace-write', tone: 'warn' }])
    expect(layout.hint).toBe(true)
    const busy = layoutStatusBar({ ...baseFacts, permission: 'workspace-write' }, emptyStats, 120, { busy: true })
    expect(busy.hint).toBe(false)
    expect(busy.right).toEqual([{ text: 'workspace-write', tone: 'warn' }])
  })

  it('traffic-lights presets, surfaces divergent sandbox, and badges the goal', () => {
    expect(permissionTone('read-only')).toBe('success')
    expect(permissionTone('workspace-write')).toBe('warn')
    expect(permissionTone('danger-full-access')).toBe('error')
    const layout = layoutStatusBar(
      {
        ...baseFacts,
        permission: 'workspace-write',
        sandbox: 'danger-full-access',
        goal: { phase: 'active', rounds: 2, max: 8 },
      },
      emptyStats,
      160,
    )
    expect(layout.right).toEqual([
      { text: '◎ r2/8', tone: 'accent' },
      { text: 'sandbox danger-full-access', tone: 'warn' },
      { text: 'workspace-write', tone: 'warn' },
    ])
    const echo = layoutStatusBar(
      {
        ...baseFacts,
        permission: 'workspace-write',
        sandbox: 'workspace-write',
        goal: { phase: 'blocked', rounds: 3, max: 8 },
      },
      emptyStats,
      160,
    )
    expect(echo.right).toEqual([
      { text: '◎ blocked', tone: 'accent' },
      { text: 'workspace-write', tone: 'warn' },
    ])
  })

  it('sanitizes external text and bounds the title by columns, not characters', () => {
    const layout = layoutStatusBar({ ...baseFacts, title: 'a\u0007b\nc' }, emptyStats, 120)
    expect(layout.left.at(-1).spans[0].text).toBe('a\\x07b ↵ c')
    const cjk = layoutStatusBar({ ...baseFacts, title: '深'.repeat(30) }, emptyStats, 320)
    const titleSpan = cjk.left.at(-1).spans[0]
    expect(visibleColumns(titleSpan.text)).toBeLessThanOrEqual(48)
    expect(titleSpan.text.endsWith('…')).toBe(true)
  })
})

describe('statusline item configuration', () => {
  it('parses the enabled set exactly: unknown ids drop, duplicates dedupe, arrays only', () => {
    expect(parseStatuslineItems(undefined)).toEqual(DEFAULT_STATUSLINE_ITEMS)
    expect(parseStatuslineItems('nope')).toEqual(DEFAULT_STATUSLINE_ITEMS)
    expect(parseStatuslineItems(['tokens', 'model', 'tokens', 'bogus'])).toEqual(['tokens', 'model'])
    expect(parseStatuslineItems([])).toEqual([])
  })

  it('filters groups to the enabled items', () => {
    const layout = layoutStatusBar(
      { ...baseFacts, model: 'm', cwd: 'r', branch: 'main', permission: 'workspace-write' },
      { ...emptyStats, turns: 1, steps: 1 },
      120,
      { items: ['model', 'permission'] },
    )
    expect(groupText(layout)).toEqual(['○ m'])
    expect(layout.right.map(span => span.text)).toEqual(['workspace-write'])
  })

  it('degrades to the lone busy dot with an empty item set', () => {
    const layout = layoutStatusBar(richFacts, richStats, 120, { items: [] })
    expect(groupText(layout)).toEqual(['○ '])
    expect(layout.right).toEqual([])
    expect(layout.hint).toBe(false)
  })

  it('reorders left clusters and right badges per the configured order', () => {
    const layout = layoutStatusBar(
      { ...baseFacts, model: 'm', cwd: 'r', permission: 'workspace-write', goal: { phase: 'active', rounds: 1, max: 4 } },
      { ...emptyStats, turns: 1, steps: 1 },
      160,
      { items: ['turns', 'cwd', 'model', 'permission', 'goal'] },
    )
    expect(groupText(layout)).toEqual(['○ m · r', 'T1 · S1'])
    expect(layout.right.map(span => span.text)).toEqual(['workspace-write', '◎ r1/4'])
  })
})

/** A maximal session: every group and right-side span exists at once. */
const richFacts: StatusFacts = {
  model: 'provider/model-name',
  mode: 'code',
  cwd: 'repository',
  branch: 'feature-branch',
  sessionId: 'ab12cd34',
  title: 'a'.repeat(40),
  sandbox: 'danger-full-access',
  goal: { phase: 'active', rounds: 2, max: 8 },
  plan: true,
  permission: 'workspace-write',
}

const richStats: TranscriptStats = {
  ...emptyStats,
  turns: 3,
  steps: 9,
  llmMs: 45_233,
  toolMs: 162_000,
  ttftMs: 2_400,
  ttftSteps: 4,
  decodeMs: 60_000,
  decodeTokens: 1_200,
  usage: { inputTokens: 12_160, outputTokens: 2_400, cacheReadTokens: 9_728 },
  lastPromptTokens: 32_000,
  contextWindow: 128_000,
}

describe('status width degradation', () => {
  it('keeps every group and the cycle hint on a roomy terminal', () => {
    const layout = layoutStatusBar(richFacts, richStats, 320)
    expect(layout.hint).toBe(true)
    expect(layout.left).toHaveLength(8)
    expect(layout.right.map(span => span.text)).toEqual(['◎ r2/8', 'sandbox danger-full-access', 'workspace-write'])
  })

  it('drops the hint and title before any figure or state', () => {
    const layout = layoutStatusBar(richFacts, richStats, 200)
    expect(layout.hint).toBe(false)
    const texts = keptTexts(layout)
    expect(texts).not.toContain('a'.repeat(40))
    expect(texts).toContain('sandbox danger-full-access')
    expect(texts).toContain('◎ r2/8')
    expect(groupText(layout)).not.toContain('mode code')
    expect(texts).toContain('T3 · S9')
    expect(texts).toContain('workspace-write')
  })

  it('sheds figures right-to-left while the state badges survive', () => {
    const layout = layoutStatusBar(richFacts, richStats, 150)
    const texts = keptTexts(layout)
    expect(texts).toContain('T3 · S9')
    expect(texts).not.toContain('llm 45.2s')
    expect(texts).toContain('◎ r2/8')
    expect(texts).toContain('sandbox danger-full-access')
    expect(texts).toContain('workspace-write')
    const countsGone = layoutStatusBar(richFacts, richStats, 120)
    expect(keptTexts(countsGone)).not.toContain('T3 · S9')
    expect(keptTexts(countsGone)).toContain('◎ r2/8')
  })

  it('keeps the badge after every figure and state drops, then the identity alone', () => {
    const withGoal = layoutStatusBar(richFacts, richStats, 100)
    expect(withGoal.left).toHaveLength(1)
    expect(withGoal.right.map(span => span.text)).toEqual(['◎ r2/8', 'workspace-write'])
    const badgeOnly = layoutStatusBar(richFacts, richStats, 80)
    expect(badgeOnly.left).toHaveLength(1)
    expect(badgeOnly.right.map(span => span.text)).toEqual(['workspace-write'])
    const identityAlone = layoutStatusBar(richFacts, richStats, 70)
    expect(identityAlone.left).toHaveLength(1)
    expect(identityAlone.right).toEqual([])
    expect(visibleColumns(rowText(identityAlone))).toBeLessThanOrEqual(69)
  })

  it('ellipsizes the identity cluster instead of wrapping at extreme widths', () => {
    const layout = layoutStatusBar(richFacts, richStats, 24)
    expect(layout.left).toHaveLength(1)
    expect(layout.right).toEqual([])
    const text = rowText(layout)
    expect(text.endsWith('…')).toBe(true)
    expect(visibleColumns(text)).toBeLessThanOrEqual(23)
  })

  it('never exceeds the one-row budget at any width, degrading monotonically', () => {
    let previous: string[] | undefined
    for (let columns = 8; columns <= 340; columns += 4) {
      const layout = layoutStatusBar(richFacts, richStats, columns)
      const text = rowText(layout)
      expect(visibleColumns(text)).toBeLessThanOrEqual(columns - 1)
      expect(layout.left.length).toBeGreaterThanOrEqual(1)
      // The ellipsized identity is width-dependent by design; every whole
      // span kept at a narrower width must survive a wider one.
      const texts = keptTexts(layout).filter(candidate => !candidate.endsWith('…'))
      if (previous !== undefined) {
        for (const text of previous) {
          expect(texts).toContain(text)
        }
      }
      previous = texts
    }
  })
})
