/** Folding session events into the TUI transcript view. */

import { describe, expect, it } from 'vitest'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type CallId,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createTranscriptView, projectEvent, projectEvents } from '../src/render/projection.ts'

const callId = { current: 'c1' as CallId }

function userEvent(text: string, seq: number): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 0,
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  } as SessionEvent
}

function chunkEvent(text: string, seq: number): SessionEvent {
  return {
    type: 'assistant/chunk',
    seq,
    time: 0,
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } },
  } as SessionEvent
}

function assistantEvent(text: string, seq: number): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text }],
        source: { provider: 'p', model: 'm' },
      }),
    },
  } as SessionEvent
}

function toolCallEvent(name: string, id: CallId, seq: number): SessionEvent {
  return {
    type: 'tool/call',
    seq,
    time: 0,
    data: { turn: 1, step: 1, callId: id, name, arguments: '{"path":"a.ts"}' },
  } as SessionEvent
}

function toolResultEvent(id: CallId, text: string, isError: boolean, seq: number): SessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: id,
        content: [{ type: 'text', text }],
        isError,
      }),
    },
  } as SessionEvent
}

describe('transcript projection', () => {
  it('renders direct human prompts as full user entries', () => {
    const view = projectEvent(createTranscriptView(), userEvent('hello', 1))
    expect(view.entries).toEqual([{ kind: 'user', text: 'hello', notice: false }])
  })

  it('collapses injected plugin context to a bounded notice row', () => {
    const event = {
      type: 'user/message',
      seq: 1,
      time: 0,
      data: createUserMessage({
        content: [{ type: 'text', text: 'x'.repeat(400) }],
        source: { kind: 'plugin', plugin: 'watcher', form: 'notice', summary: 'files changed' },
      }),
    } as SessionEvent
    const view = projectEvent(createTranscriptView(), event)
    expect(view.entries).toEqual([{ kind: 'user', text: 'files changed', notice: true }])
  })

  it('accumulates text deltas into the streaming buffer and flushes on assembly', () => {
    let view = projectEvents([userEvent('hi', 1), chunkEvent('Deep', 2), chunkEvent('Seek', 3)])
    expect(view.streaming).toBe('DeepSeek')
    view = projectEvent(view, assistantEvent('DeepSeek harness', 4))
    expect(view.streaming).toBe('')
    expect(view.entries).toEqual([
      { kind: 'user', text: 'hi', notice: false },
      { kind: 'assistant', text: 'DeepSeek harness', reasoning: '' },
    ])
  })

  it('accumulates reasoning deltas into the thinking buffer and folds them into the assembled entry', () => {
    const reasoningDelta = (text: string, seq: number): SessionEvent => ({
      type: 'assistant/chunk',
      seq,
      time: seq,
      data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text } },
    } as unknown as SessionEvent)
    let view = projectEvents([reasoningDelta('let me', 1), reasoningDelta(' think', 2)])
    expect(view.streamingReasoning).toBe('let me think')
    view = projectEvent(view, {
      type: 'assistant/message',
      seq: 3,
      time: 3,
      data: {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [
            { type: 'reasoning', text: 'let me think' },
            { type: 'text', text: 'here is the answer' },
          ],
        }),
      },
    } as unknown as SessionEvent)
    expect(view.streamingReasoning).toBe('')
    const last = view.entries[view.entries.length - 1]
    expect(last).toEqual({ kind: 'assistant', text: 'here is the answer', reasoning: 'let me think' })
  })

  it('pairs tool calls with their results by call id', () => {
    const other = 'c2' as CallId
    const view = projectEvents([
      toolCallEvent('read_file', callId.current, 1),
      toolCallEvent('bash', other, 2),
      toolResultEvent(other, 'done', false, 3),
      toolResultEvent(callId.current, 'missing file', true, 4),
    ])
    expect(view.entries).toEqual([
      { kind: 'tool', callId: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}', preview: 'a.ts', state: 'error', summary: 'missing file', detail: { kind: 'raw', text: 'missing file', truncated: false } },
      { kind: 'tool', callId: 'c2', name: 'bash', arguments: '{"path":"a.ts"}', preview: 'a.ts', state: 'done', summary: 'done', detail: { kind: 'raw', text: 'done', truncated: false } },
    ])
  })

  it('derives the verbose expansion from persisted diff presentation meta', () => {
    const event = {
      ...toolResultEvent(callId.current, 'Updated file', false, 2),
      data: {
        ...toolResultEvent(callId.current, 'Updated file', false, 2).data,
        meta: { diffs: [{ path: 'src/a.ts', oldText: 'one\ntwo', newText: 'one\nTWO' }] },
      },
    } as SessionEvent
    const view = projectEvents([toolCallEvent('edit', callId.current, 1), event])
    const entry = view.entries[0]
    expect(entry).toEqual({
      kind: 'tool',
      callId: 'c1',
      name: 'edit',
      arguments: '{"path":"a.ts"}',
      preview: 'a.ts',
      state: 'done',
      summary: 'Updated file',
      detail: {
        kind: 'diff',
        diffs: [{ path: 'src/a.ts', lines: [{ mark: '-', text: 'two' }, { mark: '+', text: 'TWO' }], truncated: false }],
      },
    })
  })

  it('derives the verbose expansion from a persisted read window', () => {
    const event = {
      ...toolResultEvent(callId.current, 'read 2 lines', false, 2),
      data: {
        ...toolResultEvent(callId.current, 'read 2 lines', false, 2).data,
        meta: { path: 'src/a.ts', offset: 3, totalLines: 9, lines: [{ number: 3, text: 'x' }, { number: 4, text: 'y' }] },
      },
    } as SessionEvent
    const view = projectEvents([toolCallEvent('read', callId.current, 1), event])
    expect(view.entries[0]).toMatchObject({
      kind: 'tool',
      detail: {
        kind: 'read',
        path: 'src/a.ts',
        offset: 3,
        totalLines: 9,
        truncated: false,
        lines: [{ number: 3, text: 'x' }, { number: 4, text: 'y' }],
      },
    })
  })

  it('replaces the todo snapshot on each write', () => {
    const todos = [{ content: 'ship', status: 'completed' }]
    const event = { type: 'todo/write', seq: 1, time: 0, data: { todos } } as unknown as SessionEvent
    const view = projectEvent(createTranscriptView(), event)
    expect(view.todos).toEqual(todos)
  })

  it('clears the todo snapshot when a fresh turn opens', () => {
    const todos = [{ content: 'ship', status: 'completed' }]
    let view = projectEvent(createTranscriptView(), {
      type: 'todo/write', seq: 1, time: 0, data: { todos },
    } as unknown as SessionEvent)
    view = projectEvent(view, { type: 'turn/start', seq: 2, time: 0, data: { turn: 2 } } as SessionEvent)
    expect(view.todos).toEqual([])
    expect(view.busy).toBe(true)
  })

  it('pairs command lifecycle events by command id', () => {
    const view = projectEvents([
      {
        type: 'command/run', seq: 1, time: 0,
        data: { commandId: 'cmd-1', name: 'compact', args: ' now', source: { kind: 'user' } },
      },
      {
        type: 'command/done', seq: 2, time: 0,
        data: { commandId: 'cmd-1', kind: 'success', text: 'compacted 2 turns' },
      },
    ] as unknown as readonly SessionEvent[])
    expect(view.entries).toEqual([{
      kind: 'command',
      commandId: 'cmd-1',
      name: 'compact',
      args: ' now',
      state: 'done',
      summary: 'compacted 2 turns',
    }])
  })

  it('folds the session model from the latest request header', () => {
    const header = (provider: string, model: string) => ({
      type: 'request/header', seq: 1, time: 0,
      data: { header: { config: { provider, model } }, reason: 'change' },
    }) as unknown as SessionEvent
    let view = projectEvent(createTranscriptView(), header('deepseek-official', 'deepseek-v4-flash'))
    expect(view.model).toBe('deepseek-official/deepseek-v4-flash')
    view = projectEvent(view, header('deepseek-official', 'deepseek-v4'))
    expect(view.model).toBe('deepseek-official/deepseek-v4')
  })

  it('folds plan mode from the last plan/mode event', () => {
    const flip = (active: boolean, seq: number) => ({
      type: 'plan/mode', seq, time: seq, data: { active },
    }) as unknown as SessionEvent
    const view = projectEvents([flip(true, 1), flip(false, 2), flip(true, 3)])
    expect(view.plan).toBe(true)
  })

  it('folds the permission preset from the last permission/preset event', () => {
    const preset = (name: string, seq: number) => ({
      type: 'permission/preset', seq, time: seq, data: { preset: name },
    }) as unknown as SessionEvent
    const view = projectEvents([preset('read-only', 1), preset('workspace-write', 2)])
    expect(view.permission).toBe('workspace-write')
  })

  it('marks non-error turn outcomes with dim marker rows', () => {
    const marker = (reason: unknown, seq: number) => ({
      type: 'turn/end',
      seq,
      time: 0,
      data: { turn: 1, reason },
    }) as SessionEvent
    expect(projectEvent(createTranscriptView(), marker({ kind: 'completed' }, 1)).entries).toEqual([])
    expect(projectEvent(createTranscriptView(), marker({ kind: 'aborted', reason: { kind: 'user' } }, 1)).entries)
      .toEqual([{ kind: 'turn-marker', text: 'turn cancelled by the user' }])
    expect(projectEvent(createTranscriptView(), marker({ kind: 'max-tokens' }, 1)).entries)
      .toEqual([{ kind: 'turn-marker', text: 'turn hit the output-token ceiling (max-tokens)' }])
    expect(projectEvent(createTranscriptView(), marker({ kind: 'interrupted' }, 1)).entries)
      .toEqual([{ kind: 'turn-marker', text: 'turn was interrupted by a restart' }])
  })

  it('folds the route context window and the latest prompt pressure', () => {
    const route = (window: number | undefined, seq: number) => ({
      type: 'request/context', seq, time: 0,
      data: { provider: 'p', model: 'm', ...(window === undefined ? {} : { contextWindow: window }) },
    }) as SessionEvent
    let view = projectEvent(createTranscriptView(), route(64_000, 1))
    expect(view.stats.contextWindow).toBe(64_000)
    view = projectEvent(view, {
      ...assistantEvent('hi', 2),
      data: { ...assistantEvent('hi', 2).data, usage: { inputTokens: 10_000, outputTokens: 5, cacheReadTokens: 6_000, cacheWriteTokens: 0 } },
    } as SessionEvent)
    expect(view.stats.lastPromptTokens).toBe(16_000)
    view = projectEvent(view, route(undefined, 3))
    expect(view.stats.contextWindow).toBe(64_000)
  })

  it('folds first-token latency and decode throughput', () => {
    const view = projectEvents([
      { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } },
      { type: 'step/start', seq: 2, time: 1_000, data: { turn: 1, step: 1 } },
      { ...chunkEvent('He', 3), time: 1_450 },
      { ...chunkEvent('llo', 4), time: 1_800 },
      { ...assistantEvent('Hello', 5), time: 2_100, data: { ...assistantEvent('Hello', 5).data, usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
    ] as SessionEvent[])
    expect(view.stats.ttftSteps).toBe(1)
    expect(view.stats.ttftMs).toBe(450)
    expect(view.stats.decodeMs).toBe(650)
    expect(view.stats.decodeTokens).toBe(2)
  })

  it('folds the session title, last write winning', () => {
    const title = (text: string, seq: number) => ({
      type: 'session/title',
      seq,
      time: 0,
      data: { title: text, messageSeqs: [1], source: { kind: 'user' } },
    }) as unknown as SessionEvent
    let view = projectEvent(createTranscriptView(), title('first title', 1))
    expect(view.title).toBe('first title')
    view = projectEvent(view, title('renamed', 2))
    expect(view.title).toBe('renamed')
  })

  it('surfaces completed compactions with their reclaimed tokens', () => {
    const view = projectEvents([
      {
        type: 'compaction/start', seq: 1, time: 0,
        data: { compactionId: 'k1' as never, turn: null },
      },
      {
        type: 'compaction/summary', seq: 2, time: 0,
        data: {
          compactionId: 'k1' as never, turn: null,
          summary: [], shadowedRange: { start: 1, end: 9 }, shadowedSeqs: [],
          shadowedTokenCount: 12_345, provider: 'p', model: 'm', llmStreamCall: true, rawOutput: [],
        },
      },
      {
        type: 'compaction/end', seq: 3, time: 0,
        data: { compactionId: 'k1' as never, turn: null },
      },
    ] as unknown as readonly SessionEvent[])
    expect(view.entries).toEqual([{ kind: 'compaction', ok: true, tokens: 12_345, error: '' }])
  })

  it('surfaces failed compactions and prices prunes without a summary', () => {
    let view = projectEvents([
      {
        type: 'compaction/start', seq: 1, time: 0,
        data: { compactionId: 'k2' as never, turn: 4 },
      },
      {
        type: 'compaction/end', seq: 2, time: 0,
        data: { compactionId: 'k2' as never, turn: 4, error: 'summary failed' },
      },
    ] as unknown as readonly SessionEvent[])
    expect(view.entries).toEqual([{ kind: 'compaction', ok: false, tokens: 0, error: 'summary failed' }])
    view = projectEvents([
      {
        type: 'compaction/prune', seq: 3, time: 0,
        data: { shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [], shadowedTokenCount: 7_000 },
      },
      {
        type: 'compaction/start', seq: 4, time: 0,
        data: { compactionId: 'k3' as never, turn: null },
      },
      {
        type: 'compaction/end', seq: 5, time: 0,
        data: { compactionId: 'k3' as never, turn: null },
      },
    ] as unknown as readonly SessionEvent[])
    expect(view.entries).toEqual([{ kind: 'compaction', ok: true, tokens: 7_000, error: '' }])
  })

  it('folds the llm retry pair from scheduled to started', () => {
    let view = projectEvent(createTranscriptView(), {
      type: 'llm/retry', seq: 1, time: 0,
      data: {
        retryId: 'r1' as never, turn: 1, step: 1, provider: 'p', mode: 'normal',
        policyKey: 'k', retry: 2, maxRetries: 4, delayMs: 1_500,
        failure: { code: 'SERVER', message: 'down' },
      },
    } as unknown as SessionEvent)
    expect(view.entries).toEqual([{
      kind: 'retry', retryId: 'r1', attempt: 2, max: 4, code: 'SERVER', delayMs: 1_500, state: 'running',
    }])
    view = projectEvent(view, {
      type: 'llm/retry-started', seq: 2, time: 1_600,
      data: { retryId: 'r1' as never, turn: 1, step: 1, retry: 2 },
    } as unknown as SessionEvent)
    expect(view.entries[0]).toMatchObject({ kind: 'retry', state: 'done' })
  })

  it('folds the sandbox-mode override, last write winning', () => {
    const switchTo = (mode: string, seq: number) => ({
      type: 'sandbox/mode', seq, time: 0, data: { mode },
    }) as unknown as SessionEvent
    let view = projectEvent(createTranscriptView(), switchTo('workspace-write', 1))
    expect(view.sandbox).toBe('workspace-write')
    view = projectEvent(view, switchTo('danger-full-access', 2))
    expect(view.sandbox).toBe('danger-full-access')
  })

  it('folds goal changes and marks the durable transitions', () => {
    const change = (operation: string, over: Record<string, unknown>, seq: number) => ({
      type: 'goal/change', seq, time: 0,
      data: { kind: 'goal/change', version: 1, operation, ...over },
    }) as unknown as SessionEvent
    let view = projectEvent(createTranscriptView(), change('create', {
      goal: { id: 'g', revision: 1, objective: 'ship the release', phase: 'active', maxGoalRounds: 6 },
      roundsStarted: 0, createdAt: 0, updatedAt: 0,
    }, 1))
    expect(view.goal).toMatchObject({ objective: 'ship the release', phase: 'active', rounds: 0, max: 6 })
    expect(view.entries).toEqual([{ kind: 'turn-marker', text: '◎ goal: ship the release' }])
    view = projectEvent(view, change('block', {
      goal: {
        id: 'g', revision: 2, objective: 'ship the release', phase: 'blocked', maxGoalRounds: 6,
        blockedReason: { code: 'dep', message: 'registry down' },
      },
      roundsStarted: 2, createdAt: 0, updatedAt: 1,
    }, 2))
    expect(view.goal).toMatchObject({ phase: 'blocked', rounds: 2, blocked: 'registry down' })
    view = projectEvent(view, change('clear', { cleared: { id: 'g', revision: 3 }, clearedAt: 2 }, 3))
    expect(view.goal).toBeUndefined()
    expect(view.entries[view.entries.length - 1]).toEqual({ kind: 'turn-marker', text: '◎ goal cleared' })
  })

  it('flushes the turn-tail mutated-files row on turn end', () => {
    const diffResult = (paths: string[], seq: number) => ({
      ...toolResultEvent(callId.current, 'Updated file', false, seq),
      data: {
        ...toolResultEvent(callId.current, 'Updated file', false, seq).data,
        meta: { diffs: paths.map(path => ({ path, oldText: 'a', newText: 'b' })) },
      },
    } as SessionEvent)
    const view = projectEvents([
      { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } },
      toolCallEvent('edit', callId.current, 2),
      diffResult(['src/a.ts', 'src/b.ts'], 3),
      diffResult(['src/a.ts', 'src/c.ts'], 4),
      { type: 'turn/end', seq: 5, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as readonly SessionEvent[])
    expect(view.entries[view.entries.length - 1]).toEqual({
      kind: 'files',
      paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    })
  })

  it('surfaces turn errors as error entries', () => {
    const event = {
      type: 'turn/end',
      seq: 1,
      time: 0,
      data: { turn: 1, reason: { kind: 'error', error: { code: 'SERVER', message: 'down' } } },
    } as SessionEvent
    const view = projectEvent(createTranscriptView(), event)
    expect(view.entries).toEqual([{ kind: 'error', text: 'SERVER: down' }])
  })

  it('tracks the busy flag across the durable turn bracket', () => {
    const open = { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } } as SessionEvent
    const close = { type: 'turn/end', seq: 2, time: 0, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent
    expect(projectEvent(createTranscriptView(), open).busy).toBe(true)
    expect(projectEvent({ ...createTranscriptView(), busy: true }, close).busy).toBe(false)
  })

  it('ignores unhandled events without changing the view', () => {
    const view = createTranscriptView()
    const event = { type: 'step/end', seq: 1, time: 0, data: { turn: 1, step: 1 } } as SessionEvent
    expect(projectEvent(view, event)).toEqual(view)
  })

  it('folds status figures: turns, steps, wall times, and token totals', () => {
    const view = projectEvents([
      { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } },
      { type: 'step/start', seq: 2, time: 100, data: { turn: 1, step: 1 } },
      { ...assistantEvent('hello', 3), time: 2_100, data: { ...assistantEvent('hello', 3).data, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 50 } } },
      { ...toolCallEvent('bash', callId.current, 4), time: 3_000 },
      { ...toolResultEvent(callId.current, 'ok', false, 5), time: 5_100 },
    ] as SessionEvent[])
    expect(view.stats).toEqual({
      turns: 1,
      steps: 1,
      llmMs: 2_000,
      toolMs: 2_100,
      usage: { inputTokens: 450, outputTokens: 20, cacheReadTokens: 300 },
      lastPromptTokens: 450,
      contextWindow: 0,
      ttftMs: 0,
      ttftSteps: 0,
      decodeMs: 0,
      decodeTokens: 0,
    })
  })
})
