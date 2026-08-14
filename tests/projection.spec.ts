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
    expect(view.entries).toEqual([{ kind: 'user', text: 'hello' }])
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
    expect(view.entries).toEqual([{ kind: 'user', text: 'files changed' }])
  })

  it('accumulates text deltas into the streaming buffer and flushes on assembly', () => {
    let view = projectEvents([userEvent('hi', 1), chunkEvent('Deep', 2), chunkEvent('Seek', 3)])
    expect(view.streaming).toBe('DeepSeek')
    view = projectEvent(view, assistantEvent('DeepSeek harness', 4))
    expect(view.streaming).toBe('')
    expect(view.entries).toEqual([
      { kind: 'user', text: 'hi' },
      { kind: 'assistant', text: 'DeepSeek harness' },
    ])
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
      { kind: 'tool', callId: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}', state: 'error', summary: 'missing file' },
      { kind: 'tool', callId: 'c2', name: 'bash', arguments: '{"path":"a.ts"}', state: 'done', summary: 'done' },
    ])
  })

  it('replaces the todo snapshot on each write', () => {
    const todos = [{ content: 'ship', status: 'completed' }]
    const event = { type: 'todo/write', seq: 1, time: 0, data: { todos } } as unknown as SessionEvent
    const view = projectEvent(createTranscriptView(), event)
    expect(view.todos).toEqual(todos)
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
    })
  })
})
