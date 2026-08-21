/** Folding session events into the TUI transcript view. */

import { describe, expect, it } from 'vitest'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type CallId,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolEntry } from '../src/render/projection.ts'
import {
  createReplayAccumulator,
  createTranscriptView,
  finishReplay,
  projectEvent,
  projectEvents,
  replayProjectEvent,
  settledEntryCount,
} from '../src/render/projection.ts'

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

function reasoningChunkEvent(text: string, seq: number): SessionEvent {
  return {
    type: 'assistant/chunk',
    seq,
    time: 0,
    data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text } },
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

  it('projects durable image metadata without paths or encoded bytes', () => {
    const attachment = {
      attachmentId: 'sha-1', mediaType: 'image/png', bytes: 128,
      width: 20, height: 10, name: 'diagram.png', originalDimensions: { width: 80, height: 40 },
    }
    const event = {
      type: 'user/message', seq: 1, time: 0,
      data: createUserMessage({
        content: [{ type: 'text', text: 'inspect' }, { type: 'image', attachment }],
        source: { kind: 'user' },
      }),
    } as unknown as SessionEvent
    const sequential = projectEvent(createTranscriptView(), event)
    const replay = projectEvents([event])
    expect(sequential).toEqual(replay)
    expect(sequential.entries[0]).toMatchObject({
      kind: 'user', text: 'inspect', images: [{ name: 'diagram.png', width: 20, height: 10, bytes: 128, originalDimensions: { width: 80, height: 40 } }],
    })
    expect(JSON.stringify(sequential)).not.toContain('base64')
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

  it('settles reasoning and answer as one authoritative assistant entry', () => {
    let view = projectEvents([reasoningChunkEvent('let me', 1), reasoningChunkEvent(' think', 2)])
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
    expect(view.entries).toEqual([{
      kind: 'assistant',
      text: 'here is the answer',
      reasoning: 'let me think',
    }])
  })

  it('bounds the in-flight reasoning duplicate while keeping the newest tail', () => {
    const prefix = 'old-'.repeat(20_000)
    const suffix = 'newest reasoning'
    const view = projectEvents([
      {
        type: 'assistant/chunk', seq: 1, time: 1,
        data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: prefix } },
      },
      {
        type: 'assistant/chunk', seq: 2, time: 2,
        data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: suffix } },
      },
    ] as unknown as readonly SessionEvent[])
    expect(view.streamingReasoning.length).toBeLessThanOrEqual(65_536)
    expect(view.streamingReasoning.endsWith(suffix)).toBe(true)
  })

  it('resets both preview channels when a new step supersedes the old one', () => {
    const view = projectEvents([
      { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } } as SessionEvent,
      reasoningChunkEvent('old reasoning', 2),
      chunkEvent('old answer', 3),
      { type: 'step/start', seq: 4, time: 4, data: { turn: 1, step: 2 } } as SessionEvent,
    ])
    expect(view.streamingReasoning).toBe('')
    expect(view.streaming).toBe('')
  })

  it('keeps reasoning live through the thinking-to-answer handoff', () => {
    let view = projectEvents([reasoningChunkEvent('think ', 1), reasoningChunkEvent('hard', 2), chunkEvent('the answer', 3)])
    // The first text delta is only a presentation handoff; neither preview is
    // durable until the assembled assistant message arrives.
    expect(view.entries).toEqual([])
    expect(view.streamingReasoning).toBe('think hard')
    expect(view.streaming).toBe('the answer')
    // Later deltas keep the entries identity (no duplicate flush).
    const entriesBefore = view.entries
    view = projectEvent(view, chunkEvent(' continues', 4))
    expect(view.entries).toBe(entriesBefore)
    // Settlement appends one assistant entry from the assembled message.
    view = projectEvent(view, {
      type: 'assistant/message', seq: 5, time: 0,
      data: {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [
            { type: 'reasoning', text: 'think harder' },
            { type: 'text', text: 'the answer continues' },
          ],
          source: { provider: 'p', model: 'm' },
        }),
      },
    } as SessionEvent)
    expect(view.entries).toEqual([{
      kind: 'assistant',
      text: 'the answer continues',
      reasoning: 'think harder',
    }])
  })

  it('does not manufacture a reasoning entry before a tool call', () => {
    const view = projectEvents([reasoningChunkEvent('plan the edit', 1), toolCallEvent('edit', callId.current, 2)])
    expect(view.entries.map(entry => entry.kind)).toEqual(['tool'])
    expect(view.streamingReasoning).toBe('plan the edit')
  })

  it('joins interleaved assembled reasoning blocks into the assistant entry', () => {
    const view = projectEvents([
      reasoningChunkEvent('first segment', 1),
      chunkEvent('partial', 2),
      reasoningChunkEvent('second segment', 3),
      {
        type: 'assistant/message',
        seq: 4,
        time: 0,
        data: {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [
              { type: 'reasoning', text: 'first segment' },
              { type: 'text', text: 'partial' },
              { type: 'reasoning', text: 'second segment' },
            ],
          }),
        },
      } as unknown as SessionEvent,
    ])
    expect(view.entries).toEqual([{
      kind: 'assistant',
      text: 'partial',
      reasoning: 'first segmentsecond segment',
    }])
  })

  it('bounds only the live preview and keeps the full assembled reasoning', () => {
    const huge = 'x'.repeat(70_000)
    let view = projectEvents([reasoningChunkEvent(huge, 1), chunkEvent('answer', 2)])
    expect(view.streamingReasoning.length).toBeLessThanOrEqual(65_536)
    view = projectEvent(view, {
      type: 'assistant/message', seq: 3, time: 0,
      data: {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'reasoning', text: huge }, { type: 'text', text: 'answer' }],
          source: { provider: 'p', model: 'm' },
        }),
      },
    } as SessionEvent)
    expect(view.entries[0]).toEqual({ kind: 'assistant', text: 'answer', reasoning: huge })
  })

  it('clears an unassembled reasoning preview when the turn aborts', () => {
    const view = projectEvents([
      reasoningChunkEvent('half a thought', 1),
      { type: 'turn/end', seq: 2, time: 0, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } } as SessionEvent,
    ])
    expect(view.entries).toEqual([{ kind: 'turn-marker', text: 'turn cancelled by the user' }])
    expect(view.streamingReasoning).toBe('')
  })

  it('replays authoritative assistant reasoning identically from the durable event log', () => {
    const events: readonly SessionEvent[] = [
      reasoningChunkEvent('trace ', 1),
      reasoningChunkEvent('body', 2),
      chunkEvent('answer', 3),
      {
        type: 'assistant/message', seq: 4, time: 0,
        data: {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [
              { type: 'reasoning', text: 'trace body (assembled)' },
              { type: 'text', text: 'answer' },
            ],
            source: { provider: 'p', model: 'm' },
          }),
        },
      } as SessionEvent,
    ]
    let sequential = createTranscriptView()
    for (const event of events) sequential = projectEvent(sequential, event)
    expect(sequential).toEqual(projectEvents(events))
    expect(sequential.entries).toEqual([{
      kind: 'assistant',
      text: 'answer',
      reasoning: 'trace body (assembled)',
    }])
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
      { kind: 'tool', callId: 'c1', ordinal: 1, name: 'read_file', arguments: '{"path":"a.ts"}', preview: 'a.ts', prompt: '', state: 'error', summary: 'missing file', detail: { kind: 'raw', text: 'missing file', truncated: false } },
      { kind: 'tool', callId: 'c2', ordinal: 2, name: 'bash', arguments: '{"path":"a.ts"}', preview: 'a.ts', prompt: '', state: 'done', summary: 'done', detail: { kind: 'raw', text: 'done', truncated: false } },
    ])
  })

  it('numbers tool calls globally across turns so badges and errors never renounce', () => {
    const callA = 'a' as CallId
    const callB = 'b' as CallId
    const callC = 'c' as CallId
    const view = projectEvents([
      { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } } as SessionEvent,
      toolCallEvent('read', callA, 2),
      toolResultEvent(callA, 'ok', false, 3),
      { type: 'turn/end', seq: 4, time: 0, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent,
      { type: 'turn/start', seq: 5, time: 0, data: { turn: 2 } } as SessionEvent,
      toolCallEvent('bash', callB, 6),
      toolCallEvent('edit', callC, 7),
      toolResultEvent(callB, 'boom', true, 8),
      { type: 'turn/end', seq: 9, time: 0, data: { turn: 2, reason: { kind: 'completed' } } } as SessionEvent,
    ])
    const tools = view.entries.filter((entry): entry is ToolEntry => entry.kind === 'tool')
    // The counter never resets between turns: 1, 2, 3 across the whole log.
    expect(tools.map(tool => tool.ordinal)).toEqual([1, 2, 3])
    // The failed call keeps the exact number its card badge shows; result
    // folding never renumbers a settled entry.
    const failed = tools.find(tool => tool.state === 'error')
    expect(failed?.callId).toBe(callB)
    expect(failed?.ordinal).toBe(2)
    expect(view.toolCallOrdinal).toBe(3)
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
      ordinal: 1,
      name: 'edit',
      arguments: '{"path":"a.ts"}',
      preview: 'a.ts',
      prompt: '',
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

  it('folds the effective reasoning effort from the latest request header', () => {
    const header = (config: Record<string, string>, seq: number) => ({
      type: 'request/header', seq, time: 0,
      data: { header: { config }, reason: 'change' },
    }) as unknown as SessionEvent
    let view = projectEvent(createTranscriptView(), header({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }, 1))
    expect(view.stats.reasoningEffort).toBe('high')
    // An adapter-materialized default is still the effective effort.
    view = projectEvent(view, header({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' }, 2))
    expect(view.stats.reasoningEffort).toBe('max')
    // A header without an effort means provider-default behavior.
    view = projectEvent(view, header({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, 3))
    expect(view.stats.reasoningEffort).toBe('')
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
    let view = projectEvents([reasoningChunkEvent('failed reasoning', 1), chunkEvent('failed answer', 2)])
    view = projectEvent(view, {
      type: 'llm/retry', seq: 3, time: 0,
      data: {
        retryId: 'r1' as never, turn: 1, step: 1, provider: 'p', mode: 'normal',
        policyKey: 'k', retry: 2, maxRetries: 4, delayMs: 1_500,
        failure: { code: 'SERVER', message: 'down' },
      },
    } as unknown as SessionEvent)
    expect(view.entries).toEqual([{
      kind: 'retry', retryId: 'r1', attempt: 2, max: 4, code: 'SERVER', delayMs: 1_500, state: 'running',
    }])
    expect(view.streamingReasoning).toBe('')
    expect(view.streaming).toBe('')
    view = projectEvent(view, {
      type: 'llm/retry-started', seq: 4, time: 1_600,
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

  it('anchors the busy clock at turn start and clears it at turn end', () => {
    let view = projectEvent(createTranscriptView(), {
      type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 },
    } as unknown as SessionEvent)
    expect(view.busy).toBe(true)
    expect(view.busySince).toBe(1_000)
    view = projectEvent(view, {
      type: 'turn/end', seq: 2, time: 9_000,
      data: { turn: 1, reason: { kind: 'completed' } },
    } as unknown as SessionEvent)
    expect(view.busy).toBe(false)
    expect(view.busySince).toBe(0)
  })

  it('settles only the prefix no later event can mutate', () => {
    const toolCall = (id: string, seq: number) => ({
      type: 'tool/call', seq, time: 0,
      data: { turn: 1, step: 1, callId: id, name: 'edit', arguments: {} },
    }) as unknown as SessionEvent
    const toolResult = (id: string, seq: number) => toolResultEvent(id as CallId, 'done', false, seq)
    // Empty transcript flushes nothing; a transcript with no running work
    // flushes EVERYTHING (the completed tail included — later events only
    // append new rows, so resizes never re-print the conversation).
    expect(settledEntryCount([])).toBe(0)
    let view = projectEvents([
      { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } },
      toolCall('a', 2),
      toolCall('b', 3),
    ] as unknown as readonly SessionEvent[])
    // The first running tool freezes everything from itself onward.
    expect(settledEntryCount(view.entries)).toBe(0)
    view = projectEvent(view, toolResult('a', 4))
    // Tool a is final and flushes; tool b (the running tail) stays live.
    expect(settledEntryCount(view.entries)).toBe(1)
    view = projectEvent(view, toolResult('b', 5))
    // All work done: the whole transcript (tail included) settles.
    expect(settledEntryCount(view.entries)).toBe(view.entries.length)
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

  it('adds an in-product recovery path to missing-credential failures', () => {
    const event = {
      type: 'turn/end',
      seq: 1,
      time: 0,
      data: {
        turn: 1,
        reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'no API key configured' } },
      },
    } as SessionEvent
    const view = projectEvent(createTranscriptView(), event)
    expect(view.entries).toEqual([{
      kind: 'error',
      text: 'MISSING_CREDENTIAL: no API key configured · open /model to add an API key',
    }])
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
      contextSegments: { system: 0, prompt: 0, assistant: 2, thinking: 0, tools: 5 },
      ttftMs: 0,
      ttftSteps: 0,
      decodeMs: 0,
      decodeTokens: 0,
      reasoningEffort: '',
    })
  })
})

describe('context segment estimates', () => {
  it('counts a direct human prompt into the prompt segment', () => {
    const view = projectEvent(createTranscriptView(), userEvent('hello', 1))
    expect(view.stats.contextSegments).toEqual({ system: 0, prompt: 2, assistant: 0, thinking: 0, tools: 0 })
  })

  it('counts CJK prompts at ~1 token per char instead of 4 chars per token', () => {
    const view = projectEvent(createTranscriptView(), userEvent('你好世界', 1))
    expect(view.stats.contextSegments.prompt).toBe(4)
  })

  it('splits assistant replies into visible text and hidden thinking', () => {
    const view = projectEvent(createTranscriptView(), {
      type: 'assistant/message',
      seq: 1,
      time: 0,
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
    expect(view.stats.contextSegments).toEqual({ system: 0, prompt: 0, assistant: 5, thinking: 3, tools: 0 })
  })

  it('counts tool call arguments and result text into the tools segment', () => {
    const view = projectEvents([
      toolCallEvent('read_file', callId.current, 1),
      toolResultEvent(callId.current, 'ok', false, 2),
    ])
    expect(view.stats.contextSegments.tools).toBe(5)
  })

  it('counts injected plugin context into the system segment', () => {
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
    expect(view.stats.contextSegments.system).toBe(4)
  })

  it('replaces the system segment from the latest request header system prompt', () => {
    const header = (system: string | undefined, seq: number) => ({
      type: 'request/header',
      seq,
      time: 0,
      data: {
        header: {
          config: { provider: 'p', model: 'm' },
          ...(system === undefined ? {} : { system }),
        },
        reason: 'change',
      },
    }) as unknown as SessionEvent
    let view = projectEvent(createTranscriptView(), header('you are helpful', 1))
    expect(view.stats.contextSegments.system).toBe(4)
    view = projectEvent(view, header(undefined, 2))
    expect(view.stats.contextSegments.system).toBe(0)
  })

  it('does not estimate queued rows until their durable user message lands', () => {
    const message = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    const spliced = {
      type: 'agent/inbox/spliced',
      seq: 1,
      time: 0,
      data: { target: 'next-turn', start: 0, inserted: [message] },
    } as unknown as SessionEvent
    const queued = projectEvent(createTranscriptView(), spliced)
    expect(queued.stats.contextSegments.prompt).toBe(0)
    const landed = projectEvent(queued, { type: 'user/message', seq: 2, time: 0, data: message } as SessionEvent)
    expect(landed.stats.contextSegments.prompt).toBe(2)
  })

  it('accumulates estimates across events', () => {
    const view = projectEvents([userEvent('hello', 1), userEvent('world', 2)])
    expect(view.stats.contextSegments.prompt).toBe(4)
  })
})

describe('queued inbox projection', () => {
  let seq = 1000

  function pendingMessage(text: string): ReturnType<typeof createUserMessage> {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  }

  function spliceEvent(
    target: 'next-turn' | 'next-step',
    start: number,
    removedCount: number | undefined,
    inserted: ReturnType<typeof createUserMessage>[],
  ): SessionEvent {
    return {
      type: 'agent/inbox/spliced',
      seq: seq++,
      time: 0,
      data: {
        target,
        start,
        ...(removedCount === undefined ? {} : { removedCount }),
        inserted,
      },
    } as unknown as SessionEvent
  }

  function userMessageEvent(message: ReturnType<typeof createUserMessage>): SessionEvent {
    return { type: 'user/message', seq: seq++, time: 0, data: message } as SessionEvent
  }

  it('shows submitted messages as pending rows in the transcript', () => {
    const steering = pendingMessage('steer me')
    const queued = pendingMessage('next turn')
    const view = projectEvents([
      spliceEvent('next-step', 0, undefined, [steering]),
      spliceEvent('next-turn', 0, undefined, [queued]),
    ])
    expect(view.entries).toEqual([
      { kind: 'pending', messageId: steering.id, target: 'next-step', text: 'steer me' },
      { kind: 'pending', messageId: queued.id, target: 'next-turn', text: 'next turn' },
    ])
    expect(view.pending).toEqual({ 'next-turn': [queued.id], 'next-step': [steering.id] })
  })

  it('retires a pending row when its durable user message lands', () => {
    const steering = pendingMessage('steer me')
    const view = projectEvents([
      spliceEvent('next-step', 0, undefined, [steering]),
      userMessageEvent(steering),
    ])
    expect(view.entries).toEqual([
      { kind: 'user', text: 'steer me', notice: false },
    ])
    expect(view.pending).toEqual({ 'next-turn': [], 'next-step': [] })
  })

  it('drops pending rows at their inbox coordinates on a removal splice', () => {
    const first = pendingMessage('first')
    const second = pendingMessage('second')
    const view = projectEvents([
      spliceEvent('next-step', 0, undefined, [first]),
      spliceEvent('next-step', 1, undefined, [second]),
      spliceEvent('next-step', 0, 1, []),
    ])
    expect(view.entries).toEqual([
      { kind: 'pending', messageId: second.id, target: 'next-step', text: 'second' },
    ])
    expect(view.pending).toEqual({ 'next-turn': [], 'next-step': [second.id] })
  })

  it('keeps target coordinates independent across interleaved lists', () => {
    const a = pendingMessage('a')
    const b = pendingMessage('b')
    const c = pendingMessage('c')
    const view = projectEvents([
      spliceEvent('next-step', 0, undefined, [a]),
      spliceEvent('next-turn', 0, undefined, [b]),
      spliceEvent('next-step', 1, undefined, [c]),
      spliceEvent('next-turn', 0, 1, []),
    ])
    expect(view.entries).toEqual([
      { kind: 'pending', messageId: a.id, target: 'next-step', text: 'a' },
      { kind: 'pending', messageId: c.id, target: 'next-step', text: 'c' },
    ])
  })

  it('carries the full prompt text like an ordinary user row', () => {
    const long = pendingMessage('x'.repeat(300))
    const multiline = pendingMessage('a\nb  c')
    const view = projectEvents([
      spliceEvent('next-step', 0, undefined, [long, multiline]),
    ])
    expect(view.entries[0]).toMatchObject({
      kind: 'pending',
      text: 'x'.repeat(300),
    })
    expect(view.entries[1]).toMatchObject({
      kind: 'pending',
      text: 'a\nb  c',
    })
  })

  it('keeps queued rows live so retirement never ghosts an append-only flush', () => {
    const first = pendingMessage('first')
    const second = pendingMessage('second')
    // Everything before a pending row is final; the pending row and anything
    // after it (the agent is still mutating the queue) stay live.
    const queued = projectEvents([
      spliceEvent('next-turn', 0, undefined, [first]),
    ])
    expect(settledEntryCount(queued.entries)).toBe(0)
    // A durable user message retires the pending row: once the row is gone
    // from the view, everything is final again.
    const landed = projectEvent(queued, userMessageEvent(first))
    expect(landed.entries).toEqual([{ kind: 'user', text: 'first', notice: false }])
    expect(settledEntryCount(landed.entries)).toBe(1)
    // A later message behind a still-queued one cannot flush past the queue.
    const mixed = projectEvent(landed, spliceEvent('next-turn', 0, undefined, [second]))
    expect(settledEntryCount(mixed.entries)).toBe(1)
  })
})

describe('replay accumulator', () => {
  /** Deterministic PRNG so the complexity guards are reproducible across runs. */
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  /**
   * A varied, interruption-rich but deterministic log exercising every event
   * family: turns with steps that sometimes never assemble a message, tool
   * calls that sometimes never pair with a result, retry/command/compaction
   * pairs with orphans, inbox queues with retirements and removals, and
   * latest-wins snapshots (header, title, plan, permission, sandbox, goal).
   */
  function generateFuzzLog(seed: number, targetEvents: number): SessionEvent[] {
    const rand = mulberry32(seed)
    const events: SessionEvent[] = []
    let seq = 1
    let turn = 0
    const time = (): number => Math.floor(rand() * 10_000)
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!
    const push = (type: string, data: unknown): void => {
      events.push({ type, seq: seq++, time: time(), data } as unknown as SessionEvent)
    }
    const queuedIds: Record<'next-turn' | 'next-step', string[]> = { 'next-turn': [], 'next-step': [] }
    const queuedMessages: Record<string, ReturnType<typeof createUserMessage>> = {}

    const goalChange = (): void => {
      const op = pick(['create', 'block', 'pause', 'resume', 'complete', 'clear'])
      if (op === 'clear') {
        push('goal/change', { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'g', revision: 2 }, clearedAt: 0 })
        return
      }
      push('goal/change', {
        kind: 'goal/change',
        version: 1,
        operation: op,
        goal: {
          id: 'g',
          revision: 1,
          objective: 'objective',
          phase: op === 'block' ? 'blocked' : 'active',
          maxGoalRounds: 6,
          ...(op === 'block' ? { blockedReason: { code: 'dep', message: 'down' } } : {}),
        },
        roundsStarted: 2,
        createdAt: 0,
        updatedAt: 0,
      })
    }

    const interlude = (): void => {
      switch (Math.floor(rand() * 11)) {
        case 0:
          push('request/header', { header: { config: { provider: 'deepseek-official', model: pick(['deepseek-v4-flash', 'deepseek-v4', 'deepseek-v4-pro']) }, ...(rand() < 0.5 ? { system: 'you are helpful' } : {}) }, reason: 'change' })
          return
        case 1:
          push('request/context', { provider: 'p', model: 'm', ...(rand() < 0.8 ? { contextWindow: pick([64_000, 128_000]) } : {}) })
          return
        case 2:
          push('plan/mode', { active: rand() < 0.5 })
          return
        case 3:
          push('permission/preset', { preset: pick(['read-only', 'workspace-write']) })
          return
        case 4:
          push('session/title', { title: 'session ' + seq, messageSeqs: [seq], source: { kind: 'user' } })
          return
        case 5:
          push('sandbox/mode', { mode: 'danger-full-access' })
          return
        case 6:
          push('todo/write', { todos: [{ content: 'ship', status: 'completed' }] })
          return
        case 7:
          goalChange()
          return
        case 8: {
          const message = createUserMessage({ content: [{ type: 'text', text: 'prompt ' + seq }], source: { kind: 'user' } })
          push('user/message', message)
          return
        }
        case 9: {
          const target = pick(['next-turn', 'next-step'] as const)
          const message = createUserMessage({ content: [{ type: 'text', text: 'queued ' + seq }], source: { kind: 'user' } })
          push('agent/inbox/spliced', { target, start: 0, removedCount: 0, inserted: [message] })
          queuedIds[target].push(message.id)
          queuedMessages[message.id] = message
          return
        }
        default: {
          // Orphan updates: results/retries/commands whose partner never
          // arrived — exercises the replay's index-miss fallback scans.
          switch (Math.floor(rand() * 4)) {
            case 0:
              push('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ('orphan-' + seq) as CallId, content: [{ type: 'text', text: 'orphan result' }], isError: false }) })
              return
            case 1:
              push('llm/retry-started', { retryId: 'orphan-retry-' + seq, turn: 1, step: 1, retry: 1 })
              return
            case 2:
              push('command/done', { commandId: 'orphan-cmd-' + seq, kind: 'success', text: 'orphan done' })
              return
            default:
              push('step/end', { turn: 1, step: 1 }) // unhandled: must leave the view untouched
              return
          }
        }
      }
    }

    const consumeQueue = (): void => {
      const target = pick(['next-turn', 'next-step'] as const)
      const list = queuedIds[target]
      if (list.length === 0) return
      const id = list.shift()!
      if (rand() < 0.6) {
        push('user/message', queuedMessages[id]!)
      } else {
        push('agent/inbox/spliced', { target, start: 0, removedCount: 1, inserted: [] })
      }
    }

    const runTurn = (): void => {
      turn += 1
      const current = turn
      push('turn/start', { turn: current })
      if (rand() < 0.3) consumeQueue()
      const steps = 1 + Math.floor(rand() * 3)
      for (let step = 1; step <= steps; step += 1) {
        push('step/start', { turn: current, step })
        const chunks = Math.floor(rand() * 3)
        for (let c = 0; c < chunks; c += 1) {
          push('assistant/chunk', { turn: current, step, chunk: { type: rand() < 0.4 ? 'reasoning-delta' : 'text-delta', index: 0, text: rand() < 0.1 ? '' : `chunk ${current}.${step}.${c} ` } })
        }
        const toolCount = Math.floor(rand() * 3)
        const stepCalls: CallId[] = []
        for (let t = 0; t < toolCount; t += 1) {
          // Occasionally reuse the previous callId so the replay's multi-index
          // path (duplicate ids update every matching row) is fuzzed too.
          const id = rand() < 0.05 && stepCalls.length > 0
            ? stepCalls[stepCalls.length - 1]!
            : (`call-${current}-${step}-${t}` as CallId)
          stepCalls.push(id)
          push('tool/call', { turn: current, step, callId: id, name: pick(['read_file', 'bash', 'edit']), arguments: '{"path":"a.ts"}' })
        }
        for (const id of stepCalls) {
          if (rand() < 0.7) {
            push('tool/result', { turn: current, step, message: createToolResultMessage({ callId: id, content: [{ type: 'text', text: 'result of ' + id }], isError: rand() < 0.2 }) })
          }
          // 30% of calls never pair: their start anchor must be swept at turn end.
        }
        // 20% of steps never assemble a message (interrupted): the next
        // step/start or the turn end must reclaim their timing anchors.
        if (rand() < 0.2) continue
        const usage = rand() < 0.7
          ? { inputTokens: Math.floor(rand() * 10_000), outputTokens: Math.floor(rand() * 1_000), cacheReadTokens: Math.floor(rand() * 5_000), cacheWriteTokens: 0 }
          : undefined
        push('assistant/message', {
          turn: current,
          step,
          message: createAssistantMessage({
            content: [
              ...(rand() < 0.5 ? [{ type: 'reasoning' as const, text: 'let me think' }] : []),
              { type: 'text' as const, text: `answer ${current}.${step}` },
            ],
          }),
          ...(usage === undefined ? {} : { usage }),
        })
      }
      if (rand() < 0.3) {
        const id = 'retry-' + current
        push('llm/retry', { retryId: id, turn: current, step: 1, provider: 'p', mode: 'normal', policyKey: 'k', retry: 1, maxRetries: 3, delayMs: 500, failure: { code: 'SERVER', message: 'down' } })
        if (rand() < 0.8) push('llm/retry-started', { retryId: id, turn: current, step: 1, retry: 1 })
      }
      if (rand() < 0.3) {
        const id = 'cmd-' + current
        push('command/run', { commandId: id, name: 'compact', args: ' now', source: { kind: 'user' } })
        if (rand() < 0.8) push('command/done', { commandId: id, kind: rand() < 0.8 ? 'success' : 'error', text: 'compacted' })
      }
      if (rand() < 0.2) {
        const id = 'compaction-' + current
        push('compaction/start', { compactionId: id, turn: current })
        if (rand() < 0.7) {
          push('compaction/summary', { compactionId: id, turn: current, summary: [], shadowedRange: { start: 1, end: 9 }, shadowedSeqs: [], shadowedTokenCount: 5_000 + Math.floor(rand() * 10_000), provider: 'p', model: 'm', llmStreamCall: true, rawOutput: [] })
          if (rand() < 0.8) push('compaction/end', { compactionId: id, turn: current })
          // else: summary without end — capped residue must stay bounded.
        } else {
          push('compaction/end', { compactionId: id, turn: current, error: 'summary failed' })
        }
      }
      if (rand() < 0.1) push('compaction/prune', { shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [], shadowedTokenCount: 7_000 })
      const outcome = pick(['completed', 'completed', 'completed', 'aborted', 'max-tokens', 'interrupted', 'blocked', 'error'])
      push('turn/end', {
        turn: current,
        reason: outcome === 'error'
          ? { kind: 'error', error: { code: 'SERVER', message: 'down' } }
          : outcome === 'aborted'
            ? { kind: 'aborted', reason: { kind: pick(['user', 'timeout']) } }
            : { kind: outcome },
      })
    }

    while (events.length < targetEvents) {
      if (rand() < 0.15) interlude()
      else runTurn()
    }
    return events
  }

  it('folds an empty log to a fresh view', () => {
    expect(projectEvents([])).toEqual(createTranscriptView())
  })

  it('replays a full log identically to a sequential projectEvent fold', () => {
    const cases = [[1, 700], [7, 900], [42, 1_100], [2024, 600], [99, 800], [1234, 1_000]] as const
    for (const [seed, size] of cases) {
      const events = generateFuzzLog(seed, size)
      const replay = projectEvents(events)
      const sequential = events.reduce(projectEvent, createTranscriptView())
      expect(replay, `seed ${seed}`).toEqual(sequential)
    }
  })

  it('folds a large log in near-linear time (entry ops stay O(N))', () => {
    const events = generateFuzzLog(42, 24_000)
    const acc = createReplayAccumulator()
    for (const event of events) replayProjectEvent(acc, event)
    const view = finishReplay(acc)
    // Correct at scale: the whole transcript folded and pending retired.
    expect(view.entries.length).toBeGreaterThan(1_000)

    // Linear bound: container work stays proportional to the log size. A
    // copy-on-write rewrite would push `ops` toward Σ(current length), i.e.
    // quadratic, and blow this bound by orders of magnitude.
    expect(acc.ops).toBeLessThan(events.length * 8)

    // Contrast with the naive COW lower bound: every append event copies the
    // whole array so far, so a sequential fold costs Σ(length at each append),
    // which is quadratic. The replay must stay far below it — deterministic,
    // no wall-clock thresholds.
    let naiveOps = 0
    let naiveLength = 0
    for (const event of events) {
      switch (event.type) {
        case 'user/message':
        case 'assistant/message':
        case 'tool/call':
        case 'turn/end':
        case 'llm/retry':
        case 'command/run':
        case 'compaction/end':
        case 'goal/change':
        case 'agent/inbox/spliced':
          naiveOps += naiveLength
          naiveLength += 1
          break
        default:
          break
      }
    }
    expect(acc.ops * 50).toBeLessThan(naiveOps)
  })

  it('replay wall time scales near-linearly (ratio guard, not an absolute budget)', () => {
    const small = generateFuzzLog(11, 8_000)
    const large = generateFuzzLog(22, 32_000)
    const measure = (log: SessionEvent[]): number => {
      let best = Number.POSITIVE_INFINITY
      for (let run = 0; run < 3; run += 1) {
        const started = performance.now()
        projectEvents(log)
        best = Math.min(best, performance.now() - started)
      }
      return best
    }
    const smallMs = measure(small)
    const largeMs = measure(large)
    // Linear scaling is ~4x for a 4x input; quadratic is ~16x. The 8x band
    // separates the two with room for scheduler noise. If the small sample is
    // too fast to measure, fall back to a generous absolute ceiling instead.
    if (smallMs > 3) {
      expect(largeMs).toBeLessThan(smallMs * 8)
    } else {
      expect(largeMs).toBeLessThan(2_000)
    }
  }, 60_000)

  it('updates every duplicate-id row exactly like the copy-on-write reducer', () => {
    // The reducer's id-keyed updates map over ALL entries, so two rows sharing
    // one id both flip. The replay must mirror that through its multi-index
    // lists instead of only touching the last registration.
    const events = [
      { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } },
      toolCallEvent('read', 'dup' as CallId, 2),
      toolCallEvent('edit', 'dup' as CallId, 3), // duplicate callId: two rows share it
      toolResultEvent('dup' as CallId, 'done', false, 4),
      { type: 'command/run', seq: 5, time: 0, data: { commandId: 'dup-cmd', name: 'compact', args: '', source: { kind: 'user' } } },
      { type: 'command/run', seq: 6, time: 0, data: { commandId: 'dup-cmd', name: 'compact', args: '', source: { kind: 'user' } } },
      { type: 'command/done', seq: 7, time: 0, data: { commandId: 'dup-cmd', kind: 'success', text: 'ok' } },
    ] as unknown as readonly SessionEvent[]
    const replay = projectEvents(events)
    const sequential = events.reduce(projectEvent, createTranscriptView())
    expect(replay).toEqual(sequential)
    const toolStates = replay.entries
      .filter(entry => entry.kind === 'tool')
      .map(entry => (entry as { state: string }).state)
    expect(toolStates).toEqual(['done', 'done'])
    const commandStates = replay.entries
      .filter(entry => entry.kind === 'command')
      .map(entry => (entry as { state: string }).state)
    expect(commandStates).toEqual(['done', 'done'])
  })

  it('folds an orphan-heavy log in linear time and identically to the sequential fold', () => {
    // A malicious/corrupt log can pair every append with an orphan update that
    // matches nothing. The naive reducer scans the whole entries array per
    // orphan (quadratic); the replay's index maps never delete, so a miss is
    // a provable O(1) no-op.
    const events: SessionEvent[] = []
    let seq = 1
    const orphanKinds = ['tool/result', 'command/done', 'llm/retry-started'] as const
    for (let i = 0; i < 24_000; i += 1) {
      if (i % 2 === 0) {
        events.push({ type: 'user/message', seq: seq++, time: 0, data: createUserMessage({ content: [{ type: 'text', text: 'prompt ' + i }], source: { kind: 'user' } }) } as unknown as SessionEvent)
        continue
      }
      const kind = orphanKinds[i % orphanKinds.length]
      if (kind === 'tool/result') {
        events.push({ type: 'tool/result', seq: seq++, time: 0, data: { turn: 1, step: 1, message: createToolResultMessage({ callId: ('orphan-' + i) as CallId, content: [{ type: 'text', text: 'x' }], isError: false }) } } as unknown as SessionEvent)
      } else if (kind === 'command/done') {
        events.push({ type: 'command/done', seq: seq++, time: 0, data: { commandId: 'orphan-cmd-' + i, kind: 'success', text: 'x' } } as unknown as SessionEvent)
      } else {
        events.push({ type: 'llm/retry-started', seq: seq++, time: 0, data: { retryId: 'orphan-retry-' + i, turn: 1, step: 1, retry: 1 } } as unknown as SessionEvent)
      }
    }

    const acc = createReplayAccumulator()
    for (const event of events) replayProjectEvent(acc, event)
    const view = finishReplay(acc)
    // Linear bound: one container op per event (append push or orphan miss).
    expect(acc.ops).toBeLessThan(events.length * 8)
    // Contrast with the naive cost: each orphan maps over every appended row
    // (a full-array scan), so the naive fold is quadratic on this input.
    let naiveOps = 0
    let naiveLength = 0
    for (const event of events) {
      if (event.type === 'user/message') {
        naiveOps += naiveLength
        naiveLength += 1
      } else {
        naiveOps += naiveLength // orphan update scans the whole array
      }
    }
    expect(acc.ops * 50).toBeLessThan(naiveOps)

    // Equivalence at scale: the whole orphan-heavy log folds identically.
    expect(view).toEqual(events.reduce(projectEvent, createTranscriptView()))
  }, 60_000)
})

describe('anchor cleanup at derivable boundaries', () => {
  it('sweeps an interrupted step at turn end', () => {
    const view = projectEvents([
      { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } },
      { type: 'step/start', seq: 2, time: 100, data: { turn: 1, step: 1 } },
      { ...chunkEvent('thinking', 3), time: 200 },
      { type: 'turn/end', seq: 4, time: 500, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    ] as unknown as readonly SessionEvent[])
    expect(view.anchors.stepStart.size).toBe(0)
    expect(view.anchors.firstChunkAt.size).toBe(0)
    expect(view.anchors.turnSteps.size).toBe(0)
  })

  it('sweeps interrupted tool starts at turn end', () => {
    const view = projectEvents([
      { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } },
      toolCallEvent('bash', callId.current, 2),
      { type: 'turn/end', seq: 3, time: 500, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    ] as unknown as readonly SessionEvent[])
    expect(view.anchors.toolStart.size).toBe(0)
    expect(view.anchors.turnTools.size).toBe(0)
  })

  it('keeps open-turn anchors until their boundary resolves them', () => {
    const view = projectEvents([
      { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } },
      toolCallEvent('bash', callId.current, 2),
    ] as unknown as readonly SessionEvent[])
    expect(view.anchors.toolStart.size).toBe(1)
    expect(view.anchors.turnTools.get(1)?.has(callId.current)).toBe(true)
  })

  it('a superseding step start reclaims the interrupted step anchors', () => {
    const view = projectEvents([
      { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } },
      { type: 'step/start', seq: 2, time: 100, data: { turn: 1, step: 1 } },
      { ...chunkEvent('stale', 3), time: 200 }, // step 1 interrupted right here
      { type: 'step/start', seq: 4, time: 300, data: { turn: 1, step: 2 } },
      { ...assistantEvent('fresh', 5), time: 600 },
      { type: 'turn/end', seq: 6, time: 700, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as readonly SessionEvent[])
    expect(view.anchors.stepStart.size).toBe(0)
    expect(view.anchors.firstChunkAt.size).toBe(0)
    expect(view.anchors.turnSteps.size).toBe(0)
  })

  it('caps compaction summary residue and falls back to the prune price', () => {
    const events: SessionEvent[] = []
    for (let i = 0; i < 20; i += 1) {
      events.push({ type: 'compaction/summary', seq: i + 1, time: 0, data: { compactionId: 'k' + i, turn: null, shadowedTokenCount: 1_000 + i } } as unknown as SessionEvent)
    }
    events.push({ type: 'compaction/prune', seq: 21, time: 0, data: { shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [], shadowedTokenCount: 7_000 } } as unknown as SessionEvent)
    events.push({ type: 'compaction/start', seq: 22, time: 0, data: { compactionId: 'fresh' as never, turn: null } } as unknown as SessionEvent)
    events.push({ type: 'compaction/end', seq: 23, time: 0, data: { compactionId: 'fresh' as never, turn: null } } as unknown as SessionEvent)
    const view = projectEvents(events)
    // Oldest summaries are evicted first (Map insertion order).
    expect(view.anchors.compactionTokens.size).toBe(16)
    expect([...view.anchors.compactionTokens.keys()][0]).toBe('k4')
    // The fresh end has no summary of its own; the evicted price falls back
    // to the documented `lastPruneTokens` price.
    expect(view.entries[view.entries.length - 1]).toEqual({ kind: 'compaction', ok: true, tokens: 7_000, error: '' })
  })
})

describe('settledEntryCount tail invariant', () => {
  it('does not let a settled row between running rows advance the flush boundary', () => {
    // The live suffix can contain done rows (a parallel tool completed while
    // earlier siblings still run): only the FIRST mutable entry defines the
    // flush boundary. A tail-scan shortcut returning the LAST mutable index
    // would flush a still-running tool into the append-only <Static> and
    // ghost its state change — which is exactly why a pure tail scan is not a
    // safe optimization for this function.
    const view = projectEvents([
      { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } },
      toolCallEvent('read', 'a' as CallId, 2),
      toolCallEvent('bash', 'b' as CallId, 3),
      toolCallEvent('edit', 'c' as CallId, 4),
      toolResultEvent('b' as CallId, 'done', false, 5), // b completes between running a and c
    ] as unknown as readonly SessionEvent[])
    expect(view.entries.map(entry => entry.kind)).toEqual(['tool', 'tool', 'tool'])
    expect(view.entries[1]).toMatchObject({ callId: 'b', state: 'done' })
    // a (index 0) is still running: nothing before it may flush.
    expect(settledEntryCount(view.entries)).toBe(0)
  })

  it('treats a running command as a mutable boundary until command/done settles it', () => {
    // A running command's row is still mutable: command/done rewrites its
    // state/summary, so flushing it into the append-only <Static> would leave
    // the stale running mark visible until the next resize-triggered replay.
    const view = projectEvents([
      { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } },
      { type: 'command/run', seq: 2, time: 0, data: { commandId: 'c1', name: 'compact', args: '', source: { kind: 'user' } } },
      userEvent('after', 3), // appended behind the still-running command
    ] as unknown as readonly SessionEvent[])
    expect(settledEntryCount(view.entries)).toBe(0)
    const done = projectEvent(view, {
      type: 'command/done', seq: 4, time: 0,
      data: { commandId: 'c1', kind: 'success', text: 'compacted 2 turns' },
    } as unknown as SessionEvent)
    // Once the command settles, everything up to the next mutable row flushes.
    expect(done.entries[0]).toMatchObject({ kind: 'command', state: 'done', summary: 'compacted 2 turns' })
    expect(settledEntryCount(done.entries)).toBe(2)
  })
})

describe('assistant/message interrupted marker (rc.8)', () => {
  const interruptedEvent = {
    type: 'assistant/message',
    seq: 2,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'partial answer' }],
        source: { provider: 'p', model: 'm' },
      }),
      interrupted: true,
    },
  } as SessionEvent

  it('folds the interrupted flag onto the entry in both the live and replay paths', () => {
    const live = projectEvent(createTranscriptView(), { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } } as SessionEvent)
    const settledLive = projectEvent(live, interruptedEvent)
    const liveEntry = settledLive.entries[settledLive.entries.length - 1]
    expect(liveEntry).toMatchObject({ kind: 'assistant', text: 'partial answer', interrupted: true })

    const acc = createReplayAccumulator()
    replayProjectEvent(acc, { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } } as SessionEvent)
    replayProjectEvent(acc, interruptedEvent)
    const replayed = finishReplay(acc)
    const replayEntry = replayed.entries[replayed.entries.length - 1]
    expect(replayEntry).toMatchObject({ kind: 'assistant', interrupted: true })
  })

  it('leaves completed replies unmarked and renders the marker as one dim row', async () => {
    const plain = projectEvent(createTranscriptView(), assistantEvent('done', 2))
    const plainEntry = plain.entries[plain.entries.length - 1]
    expect(plainEntry).toMatchObject({ kind: 'assistant' })
    expect((plainEntry as { interrupted?: boolean }).interrupted).toBeUndefined()

    const { transcriptEntryLines } = await import('../src/render/lines.ts')
    const rows = transcriptEntryLines({ kind: 'assistant', text: 'partial answer', reasoning: '', interrupted: true }, 80)
    const flat = rows.map(row => row.segments.map(segment => segment.text).join('')).join('\n')
    expect(flat).toContain('partial answer')
    expect(flat).toContain('⏹ interrupted')
    const plainRows = transcriptEntryLines({ kind: 'assistant', text: 'done', reasoning: '' }, 80)
    expect(plainRows.map(row => row.segments.map(segment => segment.text).join('')).join('\n')).not.toContain('⏹')
  })
})
