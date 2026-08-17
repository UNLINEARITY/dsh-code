/** Status-bar formatting, tone layout, and two-row width degradation. */

import { describe, expect, it } from 'vitest'
import type { TranscriptStats } from '../src/render/projection.ts'
import { visibleColumns } from '../src/render/markdown.ts'
import {
  cacheHitPercent,
  contextBar,
  CONTEXT_BAR_WIDTH,
  DEFAULT_STATUSLINE_ITEMS,
  formatDuration,
  formatTokens,
  layoutStatusBar,
  parseStatuslineItems,
  permissionTone,
  STATUS_CYCLE_HINT,
  STATUS_GROUP_SEPARATOR,
  STATUS_ITEM_SEPARATOR,
  STATUS_ROW2_INDENT,
  type StatusFacts,
  type StatusLayout,
  type StatusRow,
} from '../src/render/status.ts'

const emptyStats: TranscriptStats = {
  turns: 0,
  steps: 0,
  llmMs: 0,
  toolMs: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
  lastPromptTokens: 0,
  contextWindow: 0,
  contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
  ttftMs: 0,
  ttftSteps: 0,
  decodeMs: 0,
  decodeTokens: 0,
  reasoningEffort: '',
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

/** Plain text of one row exactly as the footer would join it (indent included). */
function rowText(row: StatusRow, indent = 0): string {
  const left = row.left
    .map(group => group.spans.map(span => span.text).join(''))
    .join(STATUS_GROUP_SEPARATOR)
  const right = row.right.map(span => span.text).join(STATUS_ITEM_SEPARATOR)
    + (row.hint ? STATUS_CYCLE_HINT : '')
  const body = right === '' ? left : left + '  ' + right
  return ' '.repeat(indent) + body
}

/** Group text with spans concatenated (separators ride inside the spans). */
function groupText(row: StatusRow): string[] {
  return row.left.map(group => group.spans.map(span => span.text).join(''))
}

/** Texts of every kept group/span across both rows, for degradation checks. */
function keptTexts(layout: StatusLayout): string[] {
  return [
    ...layout.row1.left.flatMap(group => group.spans.map(span => span.text)),
    ...layout.row1.right.map(span => span.text),
    ...layout.row2.left.flatMap(group => group.spans.map(span => span.text)),
  ]
}

/** Joined text of every kept group across both rows (groups, not spans). */
function keptGroups(layout: StatusLayout): string[] {
  return [
    ...layout.row1.left.map(group => group.spans.map(span => span.text).join('')),
    ...layout.row1.right.map(span => span.text),
    ...layout.row2.left.map(group => group.spans.map(span => span.text).join('')),
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

describe('context progress bar', () => {
  /** Joined text of the tone-split bar spans. */
  const barText = (spans: readonly { text: string }[]): string => spans.map(span => span.text).join('')

  it('renders one stepless fill run with a dim dotted track and right-aligned readout', () => {
    expect(contextBar(32_000, 128_000, CONTEXT_BAR_WIDTH)).toEqual([
      { text: '██████', tone: 'ctxFill' },
      { text: '░░░░░░', tone: 'label' },
      { text: '32K/128K 25%', tone: 'value' },
    ])
  })

  it('fills exactly the requested width at any occupancy', () => {
    for (const used of [8_000, 32_000, 64_000, 96_000, 121_600, 150_000]) {
      const spans = contextBar(used, 128_000, CONTEXT_BAR_WIDTH)
      expect(visibleColumns(barText(spans))).toBe(CONTEXT_BAR_WIDTH)
    }
  })

  it('keeps the deterministic rounding pinned: half-up free share, fill takes the rest', () => {
    // 0.6875 of 24 free columns = 16.5 → rounds half-up to 17 free, so the
    // fill takes 7; the same occupancy always renders the identical bar.
    expect(contextBar(40_000, 128_000, 24).map(span => span.text)).toEqual(['█'.repeat(7), '░'.repeat(5), '40K/128K 31%'])
    expect(contextBar(32_000, 128_000, 40).map(span => span.text)).toEqual(['█'.repeat(10), '░'.repeat(18), '32K/128K 25%'])
  })

  it('shrinks the readout to the bare percent as the free track narrows', () => {
    const tight = contextBar(96_000, 128_000, CONTEXT_BAR_WIDTH)
    expect(tight.map(span => span.text)).toEqual(['█'.repeat(18), '░'.repeat(3), '75%'])
    expect(tight.map(span => span.tone)).toEqual(['ctxFill', 'label', 'value'])
  })

  it('flips the readout to amber at the warning threshold while the fill stays blue', () => {
    const at = contextBar(121_600, 128_000, CONTEXT_BAR_WIDTH)
    expect(at.map(span => span.text)).toEqual(['█'.repeat(19), '░░', '95%'])
    expect(at.at(-1)).toEqual({ text: '95%', tone: 'warn' })
    expect(at[0]).toEqual({ text: '█'.repeat(19), tone: 'ctxFill' })
    const over = contextBar(200_000, 128_000, CONTEXT_BAR_WIDTH)
    // Over budget: the percent keeps the raw value while the fill saturates.
    expect(over.map(span => span.text)).toEqual(['█'.repeat(19), '░', '156%'])
    expect(over.at(-1)).toEqual({ text: '156%', tone: 'warn' })
  })

  it('returns no spans for a non-positive width or window', () => {
    expect(contextBar(32_000, 128_000, 0)).toEqual([])
    expect(contextBar(32_000, 0, CONTEXT_BAR_WIDTH)).toEqual([])
  })
})

describe('status layout', () => {
  it('accents identity facts and trails the session label on row 1', () => {
    const layout = layoutStatusBar(
      { ...baseFacts, model: 'deepseek/chat', cwd: 'deepseek-harness', branch: 'dsh-cli', sessionId: 'ab12cd34' },
      emptyStats,
      120,
    )
    expect(layout.row1.left).toHaveLength(1)
    expect(groupText(layout.row1)).toEqual(['○ deepseek/chat · deepseek-harness · ⑂ dsh-cli'])
    expect(layout.row1.left[0].spans.map(span => span.tone)).toEqual(['meta', 'model', 'label', 'path', 'label', 'branch'])
    expect(layout.row1.right).toEqual([])
    expect(layout.row1.hint).toBe(false)
    expect(groupText(layout.row2)).toEqual(['ab12cd34'])
  })

  it('appends the effective reasoning effort to the model segment', () => {
    const withEffort = layoutStatusBar(
      { ...baseFacts, model: 'deepseek-official/deepseek-v4-flash' },
      { ...emptyStats, reasoningEffort: 'high' },
      120,
    )
    expect(groupText(withEffort.row1)[0]).toBe('○ deepseek-official/deepseek-v4-flash@high · r')
    expect(withEffort.row1.left[0].spans[1]).toEqual({ text: 'deepseek-official/deepseek-v4-flash@high', tone: 'model' })
    // Provider-default behavior (no header effort) keeps the bare pair.
    const withoutEffort = layoutStatusBar(
      { ...baseFacts, model: 'deepseek-official/deepseek-v4-flash' },
      emptyStats,
      120,
    )
    expect(groupText(withoutEffort.row1)[0]).toBe('○ deepseek-official/deepseek-v4-flash · r')
  })

  it('marks the busy dot live and the plan state accented', () => {
    const layout = layoutStatusBar({ ...baseFacts, plan: true }, emptyStats, 120, { busy: true })
    const identity = layout.row1.left[0].spans
    expect(identity[0]).toEqual({ text: '● ', tone: 'live' })
    expect(groupText(layout.row2)).toContain('⧉ plan')
  })

  it('keeps primary controls on row 1 in model, cwd, mode, branch, context, permission order', () => {
    const layout = layoutStatusBar(
      { ...baseFacts, mode: 'standard', model: 'm', cwd: 'r', branch: 'main', permission: 'workspace-write' },
      {
        ...emptyStats,
        usage: { inputTokens: 32_000, outputTokens: 800, cacheReadTokens: 0 },
        lastPromptTokens: 32_000,
        contextWindow: 128_000,
        contextSegments: { system: 2_000, prompt: 12_000, assistant: 6_000, thinking: 8_000, tools: 4_000 },
      },
      160,
    )
    expect(groupText(layout.row1)).toEqual([
      '○ m · r · /mode standard · ⑂ main',
      'context ██████░░░░░░32K/128K 25%',
    ])
    expect(layout.row1.right).toEqual([{ text: 'workspace-write', tone: 'warn' }])
    expect(layout.row1.hint).toBe(true)
    expect(groupText(layout.row2)).toEqual(['cache 0%', 'in 32K · out 800', 's'])
  })

  it('splits identity/state to row 1 and run meters to row 2', () => {
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
    expect(groupText(layout.row1)).toEqual(['○ m · r · /mode code · ⑂ main'])
    expect(groupText(layout.row2)).toEqual([
      'turns 2 · steps 5',
      'model 45.2s · tool 2m42s',
      'cache 80%',
      'in 12.2K · out 2.4K',
      's',
    ])
    expect(layout.row1.left[0].spans[1]).toEqual({ text: 'm', tone: 'model' })
    expect(layout.row2.left[0].spans[0]).toEqual({ text: 'turns ', tone: 'label' })
    expect(layout.row2.left[0].spans[1]).toEqual({ text: '2', tone: 'value' })
    expect(layout.row2.left[1].spans[0]).toEqual({ text: 'model ', tone: 'label' })
    expect(layout.row2.left[1].spans[1]).toEqual({ text: '45.2s', tone: 'value' })
  })

  it('writes duration parameters in full words, no single-letter codes', () => {
    const layout = layoutStatusBar(
      { ...baseFacts, mode: 'code' },
      {
        ...emptyStats,
        turns: 1,
        steps: 2,
        llmMs: 45_233,
        ttftMs: 2_400,
        ttftSteps: 4,
        decodeMs: 60_000,
        decodeTokens: 1_200,
        toolMs: 162_000,
      },
      160,
    )
    expect(groupText(layout.row1)).toEqual(['○ m · r · /mode code'])
    expect(groupText(layout.row2)).toEqual([
      'turns 1 · steps 2',
      'model 45.2s · latency 0.6s · 20 tokens/s · tool 2m42s',
      's',
    ])
  })

  it('shows context occupancy as a progress bar once capacity and a report exist', () => {
    const layout = layoutStatusBar(
      { ...baseFacts, model: 'm', cwd: 'r', sessionId: '' },
      {
        ...emptyStats,
        usage: { inputTokens: 32_000, outputTokens: 800, cacheReadTokens: 0 },
        lastPromptTokens: 32_000,
        contextWindow: 128_000,
        contextSegments: { system: 2_000, prompt: 12_000, assistant: 6_000, thinking: 8_000, tools: 4_000 },
      },
      120,
    )
    expect(groupText(layout.row1)).toEqual([
      '○ m · r',
      'context ██████░░░░░░32K/128K 25%',
    ])
    expect(groupText(layout.row2)).toEqual(['cache 0%', 'in 32K · out 800'])
  })

  it('shows the session title in place of the short id once one lands', () => {
    const titled = layoutStatusBar({ ...baseFacts, sessionId: 'ab12cd34', title: 'fix the login bug' }, emptyStats, 120)
    expect(titled.row2.left.at(-1).spans).toEqual([{ text: 'fix the login bug', tone: 'meta' }])
    const untitled = layoutStatusBar({ ...baseFacts, sessionId: 'ab12cd34', title: '' }, emptyStats, 120)
    expect(untitled.row2.left.at(-1).spans).toEqual([{ text: 'ab12cd34', tone: 'meta' }])
  })

  it('pins the permission badge right with the idle cycle hint', () => {
    const layout = layoutStatusBar({ ...baseFacts, permission: 'workspace-write' }, emptyStats, 120)
    expect(layout.row1.right).toEqual([{ text: 'workspace-write', tone: 'warn' }])
    expect(layout.row1.hint).toBe(true)
    const busy = layoutStatusBar({ ...baseFacts, permission: 'workspace-write' }, emptyStats, 120, { busy: true })
    expect(busy.row1.hint).toBe(false)
    expect(busy.row1.right).toEqual([{ text: 'workspace-write', tone: 'warn' }])
  })

  it('traffic-lights presets, surfaces divergent sandbox, and spells the goal round', () => {
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
    expect(layout.row1.right).toEqual([{ text: 'workspace-write', tone: 'warn' }])
    expect(groupText(layout.row2)).toEqual([
      's',
      '◎ round 2/8',
      'sandbox danger-full-access',
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
    expect(echo.row1.right).toEqual([{ text: 'workspace-write', tone: 'warn' }])
    expect(groupText(echo.row2)).toEqual(['s', '◎ blocked'])
  })

  it('sanitizes external text and bounds the title by columns, not characters', () => {
    const layout = layoutStatusBar({ ...baseFacts, title: 'a\u0007b\nc' }, emptyStats, 120)
    expect(layout.row2.left.at(-1).spans[0].text).toBe('a\\x07b ↵ c')
    const cjk = layoutStatusBar({ ...baseFacts, title: '深'.repeat(30) }, emptyStats, 320)
    const titleSpan = cjk.row2.left.at(-1).spans[0]
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
    expect(groupText(layout.row1)).toEqual(['○ m'])
    expect(layout.row1.right.map(span => span.text)).toEqual(['workspace-write'])
    expect(layout.row2.left).toEqual([])
  })

  it('degrades to the lone busy dot with an empty item set', () => {
    const layout = layoutStatusBar(richFacts, richStats, 120, { items: [] })
    expect(groupText(layout.row1)).toEqual(['○ '])
    expect(layout.row1.right).toEqual([])
    expect(layout.row1.hint).toBe(false)
    expect(layout.row2.left).toEqual([])
  })

  it('reorders left clusters and right badges per the configured order', () => {
    const layout = layoutStatusBar(
      { ...baseFacts, model: 'm', cwd: 'r', permission: 'workspace-write', goal: { phase: 'active', rounds: 1, max: 4 } },
      { ...emptyStats, turns: 1, steps: 1 },
      160,
      { items: ['turns', 'cwd', 'model', 'permission', 'goal'] },
    )
    expect(groupText(layout.row1)).toEqual(['○ m · r'])
    expect(layout.row1.right.map(span => span.text)).toEqual(['workspace-write'])
    expect(groupText(layout.row2)).toEqual(['turns 1 · steps 1', '◎ round 1/4'])
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
  contextSegments: { system: 2_000, prompt: 12_000, assistant: 6_000, thinking: 8_000, tools: 4_000 },
}

describe('status width degradation', () => {
  it('keeps every group on both rows and the cycle hint on a roomy terminal', () => {
    const layout = layoutStatusBar(richFacts, richStats, 320)
    expect(layout.row1.hint).toBe(true)
    expect(groupText(layout.row1)).toEqual([
      '○ provider/model-name · repository · /mode code · ⑂ feature-branch',
      'context ██████░░░░░░32K/128K 25%',
    ])
    expect(layout.row1.right.map(span => span.text)).toEqual(['workspace-write'])
    expect(groupText(layout.row2)).toEqual([
      '⧉ plan',
      'turns 3 · steps 9',
      'model 45.2s · latency 0.6s · 20 tokens/s · tool 2m42s',
      'cache 80%',
      'in 12.2K · out 2.4K',
      'a'.repeat(40),
      '◎ round 2/8',
      'sandbox danger-full-access',
    ])
  })

  it('drops secondary title independently while preserving the primary row', () => {
    const layout = layoutStatusBar(richFacts, richStats, 200)
    expect(layout.row1.hint).toBe(true)
    const texts = keptTexts(layout)
    const groups = keptGroups(layout)
    expect(texts).not.toContain('a'.repeat(40))
    expect(groups).toContain('context ██████░░░░░░32K/128K 25%')
    expect(groups).toContain('workspace-write')
    expect(groups).toContain('turns 3 · steps 9')
    expect(groups).toContain('◎ round 2/8')
    expect(groups).toContain('sandbox danger-full-access')
  })

  it('degrades row 2 without moving secondary figures onto row 1', () => {
    const layout = layoutStatusBar(richFacts, richStats, 150)
    const groups = keptGroups(layout)
    expect(groupText(layout.row1)).toContain('context ██████░░░░░░32K/128K 25%')
    expect(groups).toContain('workspace-write')
    expect(groups).toContain('turns 3 · steps 9')
    expect(groups).toContain('in 12.2K · out 2.4K')
    expect(groups).toContain('◎ round 2/8')
    expect(groups).toContain('sandbox danger-full-access')
    expect(groups).not.toContain('model 45.2s · latency 0.6s · 20 tokens/s · tool 2m42s')
    expect(groups).not.toContain('a'.repeat(40))
  })

  it('keeps permission rightmost before the identity must ellipsize', () => {
    const withBadge = layoutStatusBar(richFacts, richStats, 100)
    expect(withBadge.row1.left).toHaveLength(1)
    expect(withBadge.row1.right.map(span => span.text)).toEqual(['workspace-write'])
    const identityAlone = layoutStatusBar(richFacts, richStats, 80)
    expect(identityAlone.row1.left).toHaveLength(1)
    expect(identityAlone.row1.right).toEqual([])
    expect(visibleColumns(rowText(identityAlone.row1))).toBeLessThanOrEqual(79)
  })

  it('ellipsizes the identity cluster instead of wrapping at extreme widths', () => {
    const layout = layoutStatusBar(richFacts, richStats, 24)
    expect(layout.row1.left).toHaveLength(1)
    expect(layout.row1.right).toEqual([])
    // Row 2 independently keeps at most one secondary group at this width.
    expect(layout.row2.left.length).toBeLessThanOrEqual(1)
    if (layout.row2.left.length > 0) {
      expect(visibleColumns(rowText(layout.row2, STATUS_ROW2_INDENT))).toBeLessThanOrEqual(23)
    }
    const text = rowText(layout.row1)
    expect(text.endsWith('…')).toBe(true)
    expect(visibleColumns(text)).toBeLessThanOrEqual(23)
  })

  it('never exceeds the two-row budget at any width, degrading monotonically', () => {
    let previousRow1: string[] | undefined
    let previousRow2: string[] | undefined
    for (let columns = 8; columns <= 340; columns += 4) {
      const layout = layoutStatusBar(richFacts, richStats, columns)
      expect(visibleColumns(rowText(layout.row1))).toBeLessThanOrEqual(columns - 1)
      if (layout.row2.left.length > 0) {
        expect(visibleColumns(rowText(layout.row2, STATUS_ROW2_INDENT))).toBeLessThanOrEqual(columns - 1)
      }
      expect(layout.row1.left.length).toBeGreaterThanOrEqual(1)
      // The ellipsized identity is width-dependent by design; every whole
      // span kept at a narrower width must survive a wider one.
      const texts1 = layout.row1.left.flatMap(group => group.spans.map(span => span.text))
        .filter(candidate => !candidate.endsWith('…'))
      const texts2 = layout.row2.left.flatMap(group => group.spans.map(span => span.text))
      if (previousRow1 !== undefined) {
        for (const text of previousRow1) {
          expect(texts1).toContain(text)
        }
      }
      if (previousRow2 !== undefined) {
        for (const text of previousRow2) {
          expect(texts2).toContain(text)
        }
      }
      previousRow1 = texts1
      previousRow2 = texts2
    }
  })
})
