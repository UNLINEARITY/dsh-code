/**
 * /usage panel data: the four disjoint provider buckets, the context block,
 * and the per-turn table. The panel renders whatever the token meter reports,
 * so these tests pin the arithmetic, the availability states, and the bounds.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { TurnTokenUsage } from '@deepseek-ai/dsh-token-meter/client'
import { setLanguage } from '../src/i18n.ts'
import { visibleColumns } from '../src/render/markdown.ts'
import {
  billedInputTokens,
  completedTurns,
  modelTotals,
  turnUsages,
  usageCacheHitPercent,
  usageLines,
  usageTotalTokens,
  type UsageTurn,
  type UsageView,
} from '../src/render/usage.ts'

/** One durable turn boundary pair around whatever events are given. */
function turn(turnNumber: number, body: readonly SessionEvent[] = []): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(turnNumber * 10), time: turnNumber * 10, data: { turn: turnNumber } },
    ...body,
    { type: 'turn/end', seq: SessionSeq(turnNumber * 10 + 9), time: turnNumber * 10 + 9, data: { turn: turnNumber, reason: { kind: 'completed' } } },
  ]
}

/** One settled assistant message attributed to a model. */
function billedBy(model: string, seq: number): SessionEvent {
  return {
    type: 'assistant/message',
    seq: SessionSeq(seq),
    time: seq,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { provider: 'p', model },
      }),
    },
  }
}

/** Joined text of every rendered row. */
function text(view: UsageView, columns = 100): string {
  return usageLines(view, columns)
    .map(line => line.segments.map(segment => segment.text).join(''))
    .join('\n')
}

const totals = {
  uncachedInputTokens: 15_553_400,
  outputTokens: 1_057_300,
  cacheReadTokens: 920_064_800,
  cacheWriteTokens: 0,
}

// The panel's own labels are pinned in Chinese; the language test below
// flips the interface and checks the English wording separately.
beforeEach(() => {
  setLanguage('zh')
})

describe('usage buckets', () => {
  it('keeps the four buckets disjoint and adds the billed prompt side', () => {
    expect(billedInputTokens(totals)).toBe(15_553_400 + 920_064_800)
    expect(usageTotalTokens(totals)).toBe(15_553_400 + 920_064_800 + 1_057_300)
  })

  it('measures the hit share against the billed prompt, never the uncached part', () => {
    expect(usageCacheHitPercent(totals)).toBe(98.3)
    expect(usageCacheHitPercent({ uncachedInputTokens: 100, outputTokens: 5, cacheReadTokens: 300, cacheWriteTokens: 100 })).toBe(60)
    expect(usageCacheHitPercent({ uncachedInputTokens: 0, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull()
  })
})

describe('per-turn slicing', () => {
  it('keeps complete turns only, in log order', () => {
    const events = [...turn(1), ...turn(2), ...turn(3).slice(0, 1)]
    expect(completedTurns(events).map(slice => slice.turn)).toEqual([1, 2])
  })

  it('never invents accounting for a turn the meter cannot prove', () => {
    const events = [...turn(1), ...turn(2)]
    const proved: TurnTokenUsage = { uncachedInputTokens: 10, outputTokens: 2, totalTokens: 12 }
    const rows = turnUsages(events, slice => (
      slice[0].type === 'turn/start' && slice[0].data.turn === 1 ? proved : undefined
    ))
    expect(rows).toEqual([{ turn: 1, usage: proved, model: '' }])
  })
})

  it('drops a turn that billed nothing', () => {
    const events = [...turn(1), ...turn(2)]
    const rows = turnUsages(events, slice => (
      slice[0].type === 'turn/start' && slice[0].data.turn === 1
        ? { uncachedInputTokens: 0, outputTokens: 0, totalTokens: 0 }
        : { uncachedInputTokens: 5, outputTokens: 1, totalTokens: 6 }
    ))
    expect(rows.map(row => row.turn)).toEqual([2])
  })

  it('attributes a turn from its own messages when the meter withheld routes', () => {
    const events = turn(5, [billedBy('glm-5.3', 51), billedBy('glm-5.3', 52), billedBy('gpt-5.6-sol', 53)])
    // The meter refuses `routes` unless EVERY attempt is attributed, so the
    // turn's own messages answer — by majority, never by the current pick.
    const rows = turnUsages(events, () => ({ uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2 }))
    expect(rows[0].model).toBe('glm-5.3')
  })

  it('names every model of a turn split evenly between two of them', () => {
    const events = turn(6, [billedBy('a', 61), billedBy('b', 62)])
    const rows = turnUsages(events, () => ({ uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2 }))
    expect(rows[0].model).toBe('a + b')
  })

  it('prefers the meter routes over the messages, and reports a true gap as empty', () => {
    const routed = turnUsages(turn(7, [billedBy('m', 71)]), () => ({
      uncachedInputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      routes: [{ provider: 'p', model: 'meter-says' }],
    }))
    expect(routed[0].model).toBe('meter-says')
    const silent = turnUsages(turn(8), () => ({ uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2 }))
    expect(silent[0].model).toBe('')
  })

describe('usage panel rows', () => {
  it('renders the four buckets, the total, and the hit share', () => {
    const body = text({ totals, turns: [] })
    expect(body).toContain('15.6M')
    expect(body).toContain('920M')
    expect(body).toContain('98.3%')
    // Total prompt plus completion, not the prompt side alone.
    expect(body).toContain('937M')
  })

  it('says the projections are missing instead of showing zeros', () => {
    const body = text({ turns: [] })
    expect(body).toContain('dsh-token-meter')
    expect(body).toContain('还没有已完成的回合')
  })

  it('no longer renders a context block', () => {
    const body = text({ totals, turns: [] })
    expect(body).not.toContain('上次上报')
    expect(body).not.toContain('构成估算')
  })

  it('lists turns newest first and marks unreported buckets', () => {
    const body = text({
      turns: [
        { turn: 1, model: 'deepseek-flash', usage: { uncachedInputTokens: 300, outputTokens: 40, totalTokens: 340, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 10 } },
        { turn: 2, model: 'deepseek-pro + glm', usage: { uncachedInputTokens: 12_000, outputTokens: 900, totalTokens: 12_900 } },
      ],
    })
    expect(body.indexOf('#2')).toBeLessThan(body.indexOf('#1'))
    expect(body).toContain('deepseek-pro + glm')
    // A bucket no provider reported reads as an em dash, never as a zero.
    expect(body).toContain('—')
    expect(body).toContain('12.9K')
  })

  it('carries the cache-hit share on both tables', () => {
    const rows: UsageTurn[] = [
      // 300 read out of a 400-token billed prompt.
      { turn: 1, model: 'deepseek-flash', usage: { uncachedInputTokens: 100, outputTokens: 10, totalTokens: 410, cacheReadTokens: 300, routes: [] } },
      // No cache read reported at all: the share stays unprovable.
      { turn: 2, model: 'glm-5.3', usage: { uncachedInputTokens: 50, outputTokens: 5, totalTokens: 55 } },
    ]
    const body = text({ totals, turns: rows })
    expect(body).toContain('75%')
    const merged = modelTotals(rows)
    expect(merged[0]).toMatchObject({ model: 'deepseek-flash', cacheReadTokens: 300 })
    // The group and the turn read the same share, from the same buckets.
    expect(body.match(/75%/gu)?.length).toBe(2)
  })

  it('merges turns by the model that billed them, biggest spender first', () => {
    const rows: UsageTurn[] = [
      { turn: 1, model: 'small', usage: { uncachedInputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 5, cacheWriteTokens: 1, reasoningTokens: 2 } },
      { turn: 2, model: 'big', usage: { uncachedInputTokens: 900, outputTokens: 90, totalTokens: 990, cacheReadTokens: 50, cacheWriteTokens: 1, reasoningTokens: 20 } },
      { turn: 3, model: 'small', usage: { uncachedInputTokens: 200, outputTokens: 20, totalTokens: 220, cacheReadTokens: 10, cacheWriteTokens: 1 } },
    ]
    const merged = modelTotals(rows)
    expect(merged.map(row => row.model)).toEqual(['big', 'small'])
    expect(merged[1]).toMatchObject({
      turns: 2,
      totalTokens: 330,
      uncachedInputTokens: 300,
      outputTokens: 30,
      cacheReadTokens: 15,
      cacheWriteTokens: 2,
      // Only one turn reported thinking tokens: the group sums that one and
      // marks the figure as a floor instead of dropping the whole bucket.
      reasoningTokens: 2,
      partial: ['reasoningTokens'],
    })
  })

  it('marks a group bucket as a floor, and leaves it blank when nobody reported it', () => {
    const rows: UsageTurn[] = [
      { turn: 1, model: 'm', usage: { uncachedInputTokens: 10, outputTokens: 1, totalTokens: 11, cacheReadTokens: 4, routes: [] } },
      { turn: 2, model: 'm', usage: { uncachedInputTokens: 20, outputTokens: 2, totalTokens: 22 } },
    ]
    const [group] = modelTotals(rows)
    expect(group).toMatchObject({ cacheReadTokens: 4, cacheWriteTokens: undefined, partial: ['cacheReadTokens'] })
    // The share rides the same floor: the marker travels with the number.
    expect(text({ turns: rows })).toContain('4+')
    expect(text({ turns: rows })).toContain('已上报的部分')
  })

  it('keeps a turn that switched models in one group, never in both', () => {
    const rows: UsageTurn[] = [
      { turn: 1, model: 'a + b', usage: { uncachedInputTokens: 10, outputTokens: 1, totalTokens: 11 } },
      { turn: 2, model: 'a', usage: { uncachedInputTokens: 20, outputTokens: 2, totalTokens: 22 } },
    ]
    const merged = modelTotals(rows)
    expect(merged).toHaveLength(2)
    // The mixed turn is its own group: summing it into both would double count it.
    expect(merged.find(row => row.model === 'a + b')?.totalTokens).toBe(11)
    expect(merged.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(33)
  })

  it('renders the by-model block above the per-turn table', () => {
    const body = text({
      totals,
      turns: [
        { turn: 1, model: 'small', usage: { uncachedInputTokens: 100, outputTokens: 10, totalTokens: 110 } },
        { turn: 2, model: 'big', usage: { uncachedInputTokens: 900, outputTokens: 90, totalTokens: 990 } },
      ],
    })
    expect(body).toContain('按模型 · 2')
    expect(body.indexOf('big')).toBeLessThan(body.indexOf('small'))
    expect(body.indexOf('按模型')).toBeLessThan(body.indexOf('按回合'))
  })

  it('stays inside the column budget it is given', () => {
    const view: UsageView = {
      totals,
      turns: [
        { turn: 7, model: 'deepseek-flash', usage: { uncachedInputTokens: 12_000, outputTokens: 900, totalTokens: 12_900 } },
        { turn: 8, model: 'glm-5.3', usage: { uncachedInputTokens: 4_000, outputTokens: 300, totalTokens: 4_300, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      ],
    }
    for (const columns of [24, 40, 80, 120]) {
      const rows = usageLines(view, columns)
      const plain = rows.map(row => row.segments.map(segment => segment.text).join(''))
      for (const line of plain) expect(visibleColumns(line)).toBeLessThanOrEqual(columns)
    }
  })

  it('switches every label with the interface language', () => {
    try {
      setLanguage('en')
      const body = text({ totals, turns: [] })
      expect(body).toContain('Totals (whole session)')
      expect(body).toContain('cache hit')
    } finally {
      setLanguage('zh')
    }
  })
})
