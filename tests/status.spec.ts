/** Status-line formatting and group composition. */

import { describe, expect, it } from 'vitest'
import type { TranscriptStats } from '../src/render/projection.ts'
import { buildStatusGroups, cacheHitPercent, formatDuration, formatTokens } from '../src/render/status.ts'

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

describe('status groups', () => {
  it('shows identity alone before any work lands', () => {
    expect(buildStatusGroups(
      { model: 'deepseek/chat', cwd: 'deepseek-harness', branch: 'dsh-cli', sessionId: 'ab12cd34' },
      emptyStats,
    )).toEqual(['deepseek/chat · deepseek-harness · ⑂ dsh-cli', 'ab12cd34'])
  })

  it('drops empty identity parts and the branch outside a repository', () => {
    expect(buildStatusGroups(
      { model: 'deepseek/chat', cwd: 'repo', branch: '', sessionId: '' },
      emptyStats,
    )).toEqual(['deepseek/chat · repo'])
  })

  it('adds counts, durations, cache, and tokens once work lands', () => {
    const groups = buildStatusGroups(
      { model: 'm', cwd: 'r', branch: 'main', sessionId: 's' },
      {
        turns: 2,
        steps: 5,
        llmMs: 45_233,
        toolMs: 162_000,
        usage: { inputTokens: 12_160, outputTokens: 2_400, cacheReadTokens: 9_728 },
      },
    )
    expect(groups).toEqual([
      'm · r · ⑂ main',
      'T2 · S5',
      'llm 45.2s · tool 2m42s',
      'cache 80%',
      '↑12.2K ↓2.4K',
      's',
    ])
  })

  it('adds the context-occupancy meter once capacity and a report exist', () => {
    const groups = buildStatusGroups(
      { model: 'm', cwd: 'r', branch: '', sessionId: '' },
      {
        ...emptyStats,
        usage: { inputTokens: 32_000, outputTokens: 800, cacheReadTokens: 0 },
        lastPromptTokens: 32_000,
        contextWindow: 128_000,
      },
    )
    expect(groups).toEqual(['m · r', 'cache 0%', 'ctx 25%', '↑32K ↓800'])
  })

  it('shows the session title in place of the short id once one lands', () => {
    expect(buildStatusGroups(
      { model: 'm', cwd: 'r', branch: '', sessionId: 'ab12cd34', title: 'fix the login bug' },
      emptyStats,
    )).toEqual(['m · r', 'fix the login bug'])
    expect(buildStatusGroups(
      { model: 'm', cwd: 'r', branch: '', sessionId: 'ab12cd34', title: '' },
      emptyStats,
    )).toEqual(['m · r', 'ab12cd34'])
  })

  it('badges the goal and surfaces only divergent sandbox overrides', () => {
    const facts = (sandbox: string, goal?: { phase: string; rounds: number; max: number }) => ({
      model: 'm', cwd: 'r', branch: '', sessionId: 's', title: '', sandbox, goal,
      permission: 'workspace-write', plan: false,
    })
    // Echoing preset: no sandbox badge.
    expect(buildStatusGroups(facts('workspace-write', { phase: 'active', rounds: 2, max: 8 }), emptyStats))
      .toEqual(['m · r', 's', 'workspace-write', '◎ r2/8'])
    // Divergent override and a non-active phase.
    expect(buildStatusGroups(facts('danger-full-access', { phase: 'blocked', rounds: 3, max: 8 }), emptyStats))
      .toEqual(['m · r', 's', 'workspace-write', 'sandbox danger-full-access', '◎ blocked'])
  })

  it('omits the cache group when nothing was billed', () => {
    const groups = buildStatusGroups(
      { model: 'm', cwd: 'r', branch: '', sessionId: '' },
      { ...emptyStats, turns: 1, steps: 1, usage: { inputTokens: 0, outputTokens: 30, cacheReadTokens: 0 } },
    )
    expect(groups).toEqual(['m · r', 'T1 · S1', '↑0 ↓30'])
  })
})
