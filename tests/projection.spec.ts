/** Folding session events into the TUI transcript view. */

import { describe, expect, it } from 'vitest'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { AttachmentId, type FileAttachmentRef, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolEntry, WorkflowEntry } from '../src/render/projection.ts'
import {
  applyAssistantStreamChunk,
  createReplayAccumulator,
  createTranscriptView,
  finishReplay,
  MAX_TOOL_SUB_DISPATCHES,
  MAX_WORKFLOW_MEMBERS,
  projectEvent,
  projectEvents,
  promptDisplayText,
  replayProjectEvent,
  settledEntryCount,
  snapshotReplayView,
} from '../src/render/projection.ts'

const callId = { current: ToolCallId('c1') }

function userEvent(text: string, seq: number): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: 0,
    surfaceOp: 'append',
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  }
}

// Session-log v2+ keeps durable logs settlement-only: the live typing buffers
// ride the process-local assistant-stream frames, folded through the replay
// accumulator exactly like the store does. These helpers drive that path.
function liveAcc(): ReturnType<typeof createReplayAccumulator> {
  return createReplayAccumulator()
}

function streamText(acc: ReturnType<typeof createReplayAccumulator>, text: string, time = 0): void {
  applyAssistantStreamChunk(acc, '1:1', time, { type: 'text-delta', index: 0, text })
}

function streamReasoning(acc: ReturnType<typeof createReplayAccumulator>, text: string, time = 0): void {
  applyAssistantStreamChunk(acc, '1:1', time, { type: 'reasoning-delta', index: 0, text })
}

function assistantEvent(text: string, seq: number): SessionEvent {
  return {
    type: 'assistant/message',
    seq: SessionSeq(seq),
    time: 0,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        content: [{ type: 'text', text }],
        source: { provider: 'p', model: 'm' },
      }),
    },
  }
}

function toolCallEvent(name: string, id: ToolCallId, seq: number): SessionEvent {
  return {
    type: 'tool/call',
    seq: SessionSeq(seq),
    time: 0,
    data: { turn: 1, step: 1, callId: id, name, arguments: '{"path":"a.ts"}' },
  }
}

function toolResultEvent(id: ToolCallId, text: string, isError: boolean, seq: number): SessionEvent {
  return {
    type: 'tool/result',
    seq: SessionSeq(seq),
    time: 0,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: id,
        content: [{ type: 'text', text }],
        isError,
      }),
    },
  }
}

describe('replay equivalence (property)', () => {
  it('projectEvents matches the sequential projectEvent fold for randomized sequences', () => {
    // Deterministic LCG so a failure replays exactly.
    let seed = 0x2a2a_2a2a
    const rand = (): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0
      return seed / 0x1_0000_0000
    }
    const attemptEvent = (text: string, seq: number): SessionEvent => ({
      type: 'assistant/attempt', seq: SessionSeq(seq), time: 0,
      data: { turn: 1, step: 1, stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [1], texts: [text] }] },
    })
    const systemEvent = (text: string, seq: number): SessionEvent => ({
      type: 'system/message', seq, time: 0, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { role: 'system', id: 's' + seq, content: text === '' ? [] : [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'system-prompt' } } },
    } as unknown as SessionEvent)
    const builders = [userEvent, attemptEvent, assistantEvent, systemEvent]
    for (let trial = 0; trial < 150; trial += 1) {
      const length = Math.floor(rand() * 28)
      const events: SessionEvent[] = []
      let seq = 1
      for (let index = 0; index < length; index += 1) {
        const builder = builders[Math.floor(rand() * builders.length)]
        events.push(builder(`t${trial}-${index}`, seq++))
      }
      const replayed = projectEvents(events)
      const folded = events.reduce(projectEvent, createTranscriptView())
      expect(replayed).toStrictEqual(folded)
    }
  })

  it('projectEvents is deterministic for repeated folds of the same log', () => {
    const attemptEvent = (text: string, seq: number): SessionEvent => ({
      type: 'assistant/attempt', seq: SessionSeq(seq), time: 0,
      data: { turn: 1, step: 1, stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [1], texts: [text] }] },
    })
    const events = [
      userEvent('one', 1),
      attemptEvent('partial ', 2),
      assistantEvent('done', 4),
    ]
    expect(projectEvents(events)).toStrictEqual(projectEvents(events))
  })
})

describe('transcript projection', () => {
  it('renders direct human prompts as full user entries', () => {
    const view = projectEvent(createTranscriptView(), userEvent('hello', 1))
    expect(view.entries).toEqual([{ kind: 'user', text: 'hello', notice: false }])
  })

  it('projects durable image metadata without paths or encoded bytes', () => {
    const attachment: ImageAttachmentRef = {
      attachmentId: AttachmentId('sha-1'), mediaType: 'image/png', bytes: 128,
      width: 20, height: 10, name: 'diagram.png', originalDimensions: { width: 80, height: 40 },
    }
    const event: SessionEvent = {
      type: 'user/message', seq: SessionSeq(1), time: 0, surfaceOp: 'append',
      data: createUserMessage({
        content: [{ type: 'text', text: 'inspect' }, { type: 'image', attachment }],
        source: { kind: 'user' },
      }),
    }
    const sequential = projectEvent(createTranscriptView(), event)
    const replay = projectEvents([event])
    expect(sequential).toEqual(replay)
    expect(sequential.entries[0]).toMatchObject({
      kind: 'user', text: 'inspect', images: [{ name: 'diagram.png', width: 20, height: 10, bytes: 128, originalDimensions: { width: 80, height: 40 } }],
    })
    expect(JSON.stringify(sequential)).not.toContain('base64')
  })

  it('projects durable file blocks alongside images without exposing paths', () => {
    const file: FileAttachmentRef = { attachmentId: AttachmentId('sha-f1'), name: 'report.pdf', bytes: 2_048 }
    const event: SessionEvent = {
      type: 'user/message', seq: SessionSeq(1), time: 0, surfaceOp: 'append',
      data: createUserMessage({
        content: [{ type: 'text', text: 'summarize' }, { type: 'file', attachment: file }],
        source: { kind: 'user' },
      }),
    }
    const sequential = projectEvent(createTranscriptView(), event)
    const replay = projectEvents([event])
    expect(sequential).toEqual(replay)
    expect(sequential.entries[0]).toMatchObject({ kind: 'user', text: 'summarize', files: [{ name: 'report.pdf', bytes: 2_048 }] })
    expect(promptDisplayText(sequential.entries[0] as never)).toContain('[file: report.pdf · 2048 B]')
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

  it('accumulates live stream deltas into the buffer and flushes on settlement', () => {
    const acc = liveAcc()
    replayProjectEvent(acc, userEvent('hi', 1))
    streamText(acc, 'Deep', 2)
    streamText(acc, 'Seek', 3)
    expect(snapshotReplayView(acc).streaming).toBe('DeepSeek')
    replayProjectEvent(acc, assistantEvent('DeepSeek harness', 4))
    const view = snapshotReplayView(acc)
    expect(view.streaming).toBe('')
    expect(view.entries).toEqual([
      { kind: 'user', text: 'hi', notice: false },
      { kind: 'assistant', text: 'DeepSeek harness', reasoning: '' },
    ])
  })

  it('settles reasoning and answer as one authoritative assistant entry', () => {
    const acc = liveAcc()
    streamReasoning(acc, 'let me', 1)
    streamReasoning(acc, ' think', 2)
    expect(snapshotReplayView(acc).streamingReasoning).toBe('let me think')
    replayProjectEvent(acc, {
      type: 'assistant/message',
      seq: SessionSeq(3),
      time: 3,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        stream: [],
        message: createAssistantMessage({
          content: [
            { type: 'reasoning', text: 'let me think' },
            { type: 'text', text: 'here is the answer' },
          ],
          source: { provider: 'p', model: 'm' },
        }),
      },
    })
    const view = snapshotReplayView(acc)
    expect(view.streamingReasoning).toBe('')
    expect(view.entries).toEqual([{
      kind: 'assistant',
      text: 'here is the answer',
      reasoning: 'let me think',
    }])
  })

  it('bounds the in-flight reasoning duplicate while keeping the newest tail', () => {
    const acc = liveAcc()
    streamReasoning(acc, 'old-'.repeat(20_000), 1)
    streamReasoning(acc, 'newest reasoning', 2)
    const { streamingReasoning } = snapshotReplayView(acc)
    expect(streamingReasoning.length).toBeLessThanOrEqual(65_536)
    expect(streamingReasoning.endsWith('newest reasoning')).toBe(true)
  })

  it('resets both preview channels when a new step supersedes the old one', () => {
    const acc = liveAcc()
    replayProjectEvent(acc, { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } } as SessionEvent)
    streamReasoning(acc, 'old reasoning', 2)
    streamText(acc, 'old answer', 3)
    replayProjectEvent(acc, { type: 'step/start', seq: 4, time: 4, data: { turn: 1, step: 2 } } as SessionEvent)
    const view = snapshotReplayView(acc)
    expect(view.streamingReasoning).toBe('')
    expect(view.streaming).toBe('')
  })

  it('keeps reasoning live through the thinking-to-answer handoff', () => {
    const acc = liveAcc()
    streamReasoning(acc, 'think ', 1)
    streamReasoning(acc, 'hard', 2)
    streamText(acc, 'the answer', 3)
    // The first text delta is only a presentation handoff; neither preview is
    // durable until the assembled assistant message arrives.
    let view = snapshotReplayView(acc)
    expect(view.entries).toEqual([])
    expect(view.streamingReasoning).toBe('think hard')
    expect(view.streaming).toBe('the answer')
    // Later deltas keep the entries empty (no premature flush).
    streamText(acc, ' continues', 4)
    view = snapshotReplayView(acc)
    expect(view.entries).toStrictEqual([])
    // Settlement appends one assistant entry from the assembled message.
    replayProjectEvent(acc, {
      type: 'assistant/message', seq: SessionSeq(5), time: 0, surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        stream: [],
        message: createAssistantMessage({
          content: [
            { type: 'reasoning', text: 'think harder' },
            { type: 'text', text: 'the answer continues' },
          ],
          source: { provider: 'p', model: 'm' },
        }),
      },
    })
    view = snapshotReplayView(acc)
    expect(view.entries).toEqual([{
      kind: 'assistant',
      text: 'the answer continues',
      reasoning: 'think harder',
    }])
  })

  it('does not manufacture a reasoning entry before a tool call', () => {
    const acc = liveAcc()
    streamReasoning(acc, 'plan the edit', 1)
    replayProjectEvent(acc, toolCallEvent('edit', callId.current, 2))
    const view = snapshotReplayView(acc)
    expect(view.entries.map(entry => entry.kind)).toEqual(['tool'])
    expect(view.streamingReasoning).toBe('plan the edit')
  })

  it('joins interleaved assembled reasoning blocks into the assistant entry', () => {
    const acc = liveAcc()
    streamReasoning(acc, 'first segment', 1)
    streamText(acc, 'partial', 2)
    streamReasoning(acc, 'second segment', 3)
    replayProjectEvent(acc, {
      type: 'assistant/message',
      seq: SessionSeq(4),
      time: 0,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        stream: [],
        message: createAssistantMessage({
          content: [
            { type: 'reasoning', text: 'first segment' },
            { type: 'text', text: 'partial' },
            { type: 'reasoning', text: 'second segment' },
          ],
          source: { provider: 'p', model: 'm' },
        }),
      },
    })
    expect(snapshotReplayView(acc).entries).toEqual([{
      kind: 'assistant',
      text: 'partial',
      reasoning: 'first segmentsecond segment',
    }])
  })

  it('bounds only the live preview and keeps the full assembled reasoning', () => {
    const huge = 'x'.repeat(70_000)
    const acc = liveAcc()
    streamReasoning(acc, huge, 1)
    streamText(acc, 'answer', 2)
    expect(snapshotReplayView(acc).streamingReasoning.length).toBeLessThanOrEqual(65_536)
    replayProjectEvent(acc, {
      type: 'assistant/message', seq: SessionSeq(3), time: 0, surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        stream: [],
        message: createAssistantMessage({
          content: [{ type: 'reasoning', text: huge }, { type: 'text', text: 'answer' }],
          source: { provider: 'p', model: 'm' },
        }),
      },
    })
    expect(snapshotReplayView(acc).entries[0]).toEqual({ kind: 'assistant', text: 'answer', reasoning: huge })
  })

  it('clears an unassembled reasoning preview when the turn aborts', () => {
    const acc = liveAcc()
    streamReasoning(acc, 'half a thought', 1)
    replayProjectEvent(acc, { type: 'turn/end', seq: 2, time: 0, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } } as SessionEvent)
    const view = snapshotReplayView(acc)
    expect(view.entries).toEqual([{ kind: 'turn-marker', text: 'turn cancelled by the user' }])
    expect(view.streamingReasoning).toBe('')
  })

  it('times one step identically across an in-step retry on the live and replay paths', () => {
    // Kernel session-stats semantics: the step start spans in-step retries
    // (llmMs reaches back to step/start) and the FIRST attempt owns the
    // first-token anchor (a retry never re-times the step). The live path
    // accrues through stream frames; a resumed session replays only the
    // settlements — both must land on the same figures.
    const attemptStream = (t0: number): [{ type: 'text-chunks'; time0: number; index: number; dt: readonly number[]; texts: readonly string[] }] =>
      [{ type: 'text-chunks', time0: t0, index: 0, dt: [0], texts: ['x'] }]
    // Live: step/start → attempt 1 frames → failed attempt settles → retry
    // frames (no re-anchor) → message settles.
    const live = liveAcc()
    replayProjectEvent(live, { type: 'step/start', seq: 1, time: 1_000, data: { turn: 1, step: 1 } } as SessionEvent)
    streamText(live, 'first', 1_100)
    replayProjectEvent(live, { type: 'assistant/attempt', seq: SessionSeq(2), time: 1_200, data: { turn: 1, step: 1, stream: attemptStream(1_100) } })
    streamText(live, 'retry', 1_300)
    replayProjectEvent(live, {
      type: 'assistant/message', seq: SessionSeq(3), time: 2_000, surfaceOp: 'append',
      data: { turn: 1, step: 1, stream: attemptStream(1_300), message: createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], source: { provider: 'p', model: 'm' } }) },
    })
    // Replay: the same durable log through the pure settlement path.
    const replayed = projectEvents([
      { type: 'step/start', seq: 1, time: 1_000, data: { turn: 1, step: 1 } } as SessionEvent,
      { type: 'assistant/attempt', seq: SessionSeq(2), time: 1_200, data: { turn: 1, step: 1, stream: attemptStream(1_100) } },
      {
        type: 'assistant/message', seq: SessionSeq(3), time: 2_000, surfaceOp: 'append',
        data: { turn: 1, step: 1, stream: attemptStream(1_300), message: createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], source: { provider: 'p', model: 'm' } }) },
      },
    ])
    expect(snapshotReplayView(live).stats.ttftMs).toBe(replayed.stats.ttftMs)
    expect(snapshotReplayView(live).stats.ttftSteps).toBe(replayed.stats.ttftSteps)
    expect(snapshotReplayView(live).stats.llmMs).toBe(replayed.stats.llmMs)
    // And the figures match the kernel's own reading of this sequence.
    expect(replayed.stats.ttftMs).toBe(100)
    expect(replayed.stats.ttftSteps).toBe(1)
    expect(replayed.stats.llmMs).toBe(1_000)
  })

  it('sweeps a live first-token anchor when the turn ends mid-attempt', () => {
    // Frames strictly precede their attempt's settle/end in production, so
    // this is the real order: the anchor exists when turn/end folds.
    const acc = liveAcc()
    replayProjectEvent(acc, { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } } as SessionEvent)
    replayProjectEvent(acc, { type: 'step/start', seq: 2, time: 100, data: { turn: 1, step: 1 } } as SessionEvent)
    streamText(acc, 'thinking', 200)
    expect(acc.firstChunkAt.size).toBe(1)
    replayProjectEvent(acc, { type: 'turn/end', seq: 4, time: 500, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } } as SessionEvent)
    const view = snapshotReplayView(acc)
    expect(view.anchors.stepStart.size).toBe(0)
    expect(view.anchors.firstChunkAt.size).toBe(0)
    expect(view.anchors.turnSteps.size).toBe(0)
  })

  it('drops an abandoned attempt’s partial tail without a surface entry', () => {
    // Session-log v2+: a failed or abandoned attempt folds into a durable
    // `assistant/attempt` (or is dropped by an abandoned stream end frame)
    // and never manufactures an assistant row.
    const acc = liveAcc()
    streamReasoning(acc, 'half a thought', 1)
    streamText(acc, 'partial answer', 2)
    replayProjectEvent(acc, {
      type: 'assistant/attempt', seq: SessionSeq(3), time: 3,
      data: { turn: 1, step: 1, stream: [] },
    })
    const view = snapshotReplayView(acc)
    expect(view.entries).toEqual([])
    expect(view.streaming).toBe('')
    expect(view.streamingReasoning).toBe('')
  })

  it('replays authoritative assistant reasoning identically from the durable event log', () => {
    const events: readonly SessionEvent[] = [
      {
        type: 'assistant/message', seq: SessionSeq(4), time: 0, surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          stream: [{ type: 'text-chunks', time0: 1_000, index: 0, dt: [50], texts: ['answer'] }],
          message: createAssistantMessage({
            content: [
              { type: 'reasoning', text: 'trace body (assembled)' },
              { type: 'text', text: 'answer' },
            ],
            source: { provider: 'p', model: 'm' },
          }),
        },
      },
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
    const other = ToolCallId('c2')
    const view = projectEvents([
      toolCallEvent('read_file', callId.current, 1),
      toolCallEvent('bash', other, 2),
      toolResultEvent(other, 'done', false, 3),
      toolResultEvent(callId.current, 'missing file', true, 4),
    ])
    expect(view.entries).toEqual([
      { kind: 'tool', callId: 'c1', ordinal: 1, name: 'read_file', arguments: '{"path":"a.ts"}', preview: 'a.ts', prompt: '', state: 'error', summary: 'missing file', detail: { kind: 'raw', text: 'missing file', truncated: false }, subs: [], subsDropped: 0 },
      { kind: 'tool', callId: 'c2', ordinal: 2, name: 'bash', arguments: '{"path":"a.ts"}', preview: 'a.ts', prompt: '', state: 'done', summary: 'done', detail: { kind: 'raw', text: 'done', truncated: false }, subs: [], subsDropped: 0 },
    ])
  })

  it('numbers tool calls globally across turns so badges and errors never renounce', () => {
    const callA = ToolCallId('a')
    const callB = ToolCallId('b')
    const callC = ToolCallId('c')
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
      subs: [],
      subsDropped: 0,
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

  it('folds first-token latency and decode throughput from live stream frames', () => {
    const acc = liveAcc()
    replayProjectEvent(acc, { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } } as SessionEvent)
    replayProjectEvent(acc, { type: 'step/start', seq: 2, time: 1_000, data: { turn: 1, step: 1 } } as SessionEvent)
    streamText(acc, 'He', 1_450)
    streamText(acc, 'llo', 1_800)
    replayProjectEvent(acc, {
      ...assistantEvent('Hello', 5), time: 2_100,
      data: { ...assistantEvent('Hello', 5).data, usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    } as SessionEvent)
    const stats = snapshotReplayView(acc).stats
    expect(stats.ttftSteps).toBe(1)
    expect(stats.ttftMs).toBe(450)
    expect(stats.decodeMs).toBe(650)
    expect(stats.decodeTokens).toBe(2)
  })

  it('restores first-token latency from the embedded stream on replay', () => {
    // A replayed settlement has no live frames; the embedded AssistantStreamRecord
    // timings restore the same first-token anchor (time0 + dt[0]).
    const view = projectEvents([
      { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } } as SessionEvent,
      { type: 'step/start', seq: 2, time: 1_000, data: { turn: 1, step: 1 } } as SessionEvent,
      {
        type: 'assistant/message', seq: 5, time: 2_100,
        data: {
          turn: 1,
          step: 1,
          stream: [{ type: 'text-chunks', time0: 1_450, index: 0, dt: [0, 350], texts: ['He', 'llo'] }],
          message: createAssistantMessage({ content: [{ type: 'text', text: 'Hello' }], source: { provider: 'p', model: 'm' } }),
          usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      } as unknown as SessionEvent,
    ])
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
    const acc = liveAcc()
    streamReasoning(acc, 'failed reasoning', 1)
    streamText(acc, 'failed answer', 2)
    replayProjectEvent(acc, {
      type: 'llm/retry', seq: 3, time: 0,
      data: {
        retryId: 'r1' as never, turn: 1, step: 1, provider: 'p', mode: 'normal',
        policyKey: 'k', retry: 2, maxRetries: 4, delayMs: 1_500,
        failure: { code: 'SERVER', message: 'down' },
      },
    } as unknown as SessionEvent)
    let view = snapshotReplayView(acc)
    expect(view.entries).toEqual([{
      kind: 'retry', retryId: 'r1', mode: 'normal', attempt: 2, max: 4, code: 'SERVER', delayMs: 1_500, state: 'running',
    }])
    expect(view.streamingReasoning).toBe('')
    expect(view.streaming).toBe('')
    replayProjectEvent(acc, {
      type: 'llm/retry-started', seq: 4, time: 1_600,
      data: { retryId: 'r1' as never, turn: 1, step: 1, retry: 2 },
    } as unknown as SessionEvent)
    view = snapshotReplayView(acc)
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
    const toolResult = (id: string, seq: number) => toolResultEvent(ToolCallId(id), 'done', false, seq)
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

describe('empty assistant settlements', () => {
  function emptyAssistantEvent(seq: number, interrupted = false): SessionEvent<'assistant/message'> {
    return {
      type: 'assistant/message',
      seq: SessionSeq(seq),
      time: 0,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        stream: [],
        interrupted: interrupted || undefined,
        message: createAssistantMessage({
          content: [],
          source: { provider: 'p', model: 'm' },
        }),
      },
    }
  }

  it('skips zero-line entries for tool-only steps in both fold paths', () => {
    const events: readonly SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(1), time: 0, data: { turn: 1 } },
      toolCallEvent('run_code', callId.current, 2),
      emptyAssistantEvent(3),
      toolResultEvent(callId.current, 'done', false, 4),
      assistantEvent('final answer', 5),
      { type: 'turn/end', seq: SessionSeq(6), time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const view = projectEvents(events)
    // No zero-line assistant card between the tool card and the reply.
    expect(view.entries.filter(entry => entry.kind === 'assistant')).toHaveLength(1)
    expect(view.entries.find(entry => entry.kind === 'assistant')?.kind === 'assistant' && (view.entries.find(entry => entry.kind === 'assistant') as { text: string }).text).toBe('final answer')
    // Live and replay folds agree.
    expect(projectEvents(events)).toStrictEqual(events.reduce(projectEvent, createTranscriptView()))
  })

  it('keeps interrupted empty settlements and timing/usage accounting', async () => {
    const events: readonly SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(1), time: 0, data: { turn: 1 } },
      { type: 'step/start', seq: SessionSeq(2), time: 100, data: { turn: 1, step: 1 } },
      emptyAssistantEvent(3, true),
    ]
    const view = projectEvents(events)
    const entries = view.entries.filter(entry => entry.kind === 'assistant')
    expect(entries).toHaveLength(1)
    // The interrupted marker keeps the card renderable even with no text.
    const { transcriptEntryLines } = await import('../src/render/lines.ts')
    const lines = transcriptEntryLines(entries[0], 80, true)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.some(line => line.segments.some(segment => segment.text.includes('interrupted')))).toBe(true)
    // An empty settlement with usage still feeds the stats it carried.
    const statsView = projectEvents([
      { type: 'turn/start', seq: SessionSeq(1), time: 0, data: { turn: 1 } },
      { type: 'step/start', seq: SessionSeq(2), time: 100, data: { turn: 1, step: 1 } },
      { ...emptyAssistantEvent(3), data: { ...emptyAssistantEvent(3).data, usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0 } } },
    ])
    expect(statsView.stats.usage.inputTokens).toBe(10)
  })
})

describe('PTC sub-dispatch projection', () => {
  function ptcStartEvent(root: string, sub: string, name: string, args: unknown, seq: number, time: number): SessionEvent {
    return {
      type: 'tool/ptc-dispatch-start',
      seq,
      time,
      data: { rootCallId: root, parentCallId: root, subCallId: sub, name, arguments: args },
    } as unknown as SessionEvent
  }

  function ptcSettleEvent(root: string, sub: string, name: string, seq: number, time: number, isError = false, text = 'ok'): SessionEvent {
    return {
      type: 'tool/ptc-dispatch',
      seq,
      time,
      data: {
        rootCallId: root,
        parentCallId: root,
        subCallId: sub,
        name,
        arguments: {},
        isError,
        content: [{ type: 'text', text }],
      },
    } as unknown as SessionEvent
  }

  it('folds start/settle pairs into bounded rows on the parent run_code card', () => {
    const events: readonly SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(1), time: 0, data: { turn: 1 } },
      toolCallEvent('run_code', callId.current, 2),
      ptcStartEvent(callId.current, 'run:ptc:1', 'read_file', { path: 'a.ts' }, 3, 1_000),
      ptcStartEvent(callId.current, 'run:ptc:2', 'bash', { command: 'ls' }, 4, 1_500),
      ptcSettleEvent(callId.current, 'run:ptc:1', 'read_file', 5, 2_500),
      ptcSettleEvent(callId.current, 'run:ptc:2', 'bash', 6, 4_000, true, 'boom'),
      toolResultEvent(callId.current, 'done', false, 7),
    ]
    const view = projectEvents(events)
    const entry = view.entries.find(item => item.kind === 'tool') as ToolEntry
    expect(entry.name).toBe('run_code')
    expect(entry.subs.map(sub => [sub.subCallId, sub.state, sub.durationMs])).toEqual([
      ['run:ptc:1', 'done', 1_500],
      ['run:ptc:2', 'error', 2_500],
    ])
    expect(entry.subs[0].summary).toBe('ok')
    expect(entry.subs[1].summary).toBe('boom')
    // JSON-normalized sub arguments preview like the native card.
    expect(entry.subs[0].preview).toContain('a.ts')
    // Sub durations are display-only: the parent tool/result already owns
    // the wall-clock, so stats.toolMs stays the parent's alone.
    expect(view.stats.toolMs).toBe(0)
  })

  it('keeps a start without its parent entry and a settle without a live row as no-ops', () => {
    const orphan = projectEvents([
      ptcStartEvent('missing', 'run:ptc:1', 'bash', {}, 1, 0),
      ptcSettleEvent('missing', 'run:ptc:1', 'bash', 2, 10),
    ])
    expect(orphan.entries).toEqual([])

    const settledOnly = projectEvents([
      toolCallEvent('run_code', callId.current, 1),
      ptcSettleEvent(callId.current, 'never-started', 'bash', 2, 10),
    ])
    const entry = settledOnly.entries.find(item => item.kind === 'tool') as ToolEntry
    expect(entry.subs).toEqual([])
    expect(entry.subsDropped).toBe(0)
  })

  it('bounds the window to the newest dispatches and counts evictions', () => {
    const events: SessionEvent[] = [toolCallEvent('run_code', callId.current, 1)]
    for (let index = 0; index < MAX_TOOL_SUB_DISPATCHES + 3; index += 1) {
      events.push(ptcStartEvent(callId.current, `run:ptc:${index}`, 'bash', {}, 2 + index * 2, index))
      events.push(ptcSettleEvent(callId.current, `run:ptc:${index}`, 'bash', 3 + index * 2, index))
    }
    const view = projectEvents(events)
    const entry = view.entries.find(item => item.kind === 'tool') as ToolEntry
    expect(entry.subs).toHaveLength(MAX_TOOL_SUB_DISPATCHES)
    expect(entry.subsDropped).toBe(3)
    expect(entry.subs[entry.subs.length - 1].subCallId).toBe(`run:ptc:${MAX_TOOL_SUB_DISPATCHES + 2}`)
  })

  it('matches between the live fold and the replay fold', () => {
    const events: readonly SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(1), time: 0, data: { turn: 1 } },
      toolCallEvent('run_code', callId.current, 2),
      ptcStartEvent(callId.current, 'run:ptc:1', 'read_file', { path: 'a.ts' }, 3, 1_000),
      ptcSettleEvent(callId.current, 'run:ptc:1', 'read_file', 4, 3_000),
      toolResultEvent(callId.current, 'done', false, 5),
    ]
    const replayed = projectEvents(events)
    const folded = events.reduce(projectEvent, createTranscriptView())
    expect(replayed).toStrictEqual(folded)
  })
})

describe('workflow run projection', () => {
  function runStartEvent(runId: string, name: string, seq: number): SessionEvent {
    return { type: 'tool-workflow/run-start', seq, time: 0, data: { runId, name } } as unknown as SessionEvent
  }

  function agentStartEvent(runId: string, member: number, label: string, seq: number, phase?: string): SessionEvent {
    return {
      type: 'tool-workflow/agent-start',
      seq,
      time: 0,
      data: { runId, seq: member, label, phase, childId: `child-${member}` },
    } as unknown as SessionEvent
  }

  function agentEndEvent(runId: string, member: number, outcome: 'completed' | 'failed' | 'cancelled', seq: number): SessionEvent {
    return { type: 'tool-workflow/agent-end', seq, time: 0, data: { runId, seq: member, outcome } } as unknown as SessionEvent
  }

  function runEndEvent(runId: string, stopReason: 'completed' | 'cancelled' | 'error', seq: number): SessionEvent {
    return { type: 'tool-workflow/run-end', seq, time: 0, data: { runId, stopReason } } as unknown as SessionEvent
  }

  it('folds one bounded card per run with members paired by sequence', () => {
    const view = projectEvents([
      runStartEvent('run-1', 'audit', 1),
      agentStartEvent('run-1', 1, 'scan sources', 2, 'phase-a'),
      agentStartEvent('run-1', 2, 'verify fixes', 3),
      agentEndEvent('run-1', 1, 'completed', 4),
      agentEndEvent('run-1', 2, 'failed', 5),
      runEndEvent('run-1', 'error', 6),
    ])
    const entry = view.entries.find(item => item.kind === 'workflow') as WorkflowEntry
    expect(entry.name).toBe('audit')
    expect(entry.state).toBe('error')
    expect(entry.members.map(member => [member.label, member.outcome, member.phase])).toEqual([
      ['scan sources', 'completed', 'phase-a'],
      ['verify fixes', 'failed', ''],
    ])
    // The mutable boundary: a run that has not settled keeps its card out
    // of the settled region; the settled run above counts in.
    const running = projectEvents([
      runStartEvent('run-2', 'live', 1),
      agentStartEvent('run-2', 1, 'busy', 2),
    ])
    expect(settledEntryCount(running.entries)).toBe(0)
    expect(settledEntryCount(view.entries)).toBe(1)
  })

  it('bounds the member window and settles unmatched sequences as no-ops', () => {
    const events: SessionEvent[] = [runStartEvent('run-1', 'fan-out', 1)]
    for (let member = 0; member < MAX_WORKFLOW_MEMBERS + 2; member += 1) {
      events.push(agentStartEvent('run-1', member, `m${member}`, 2 + member * 2))
      events.push(agentEndEvent('run-1', member, 'completed', 3 + member * 2))
    }
    events.push(agentEndEvent('run-1', 9_999, 'completed', 90))
    events.push(runEndEvent('run-1', 'completed', 91))
    const view = projectEvents(events)
    const entry = view.entries.find(item => item.kind === 'workflow') as WorkflowEntry
    expect(entry.members).toHaveLength(MAX_WORKFLOW_MEMBERS)
    expect(entry.membersDropped).toBe(2)
    expect(entry.state).toBe('completed')
    expect(settledEntryCount(view.entries)).toBe(1)
  })

  it('ignores member events for an unknown run and matches live against replay', () => {
    const orphan = projectEvents([
      agentStartEvent('missing', 1, 'ghost', 1),
      runEndEvent('missing', 'completed', 2),
    ])
    expect(orphan.entries).toEqual([])

    const events: readonly SessionEvent[] = [
      runStartEvent('run-1', 'audit', 1),
      agentStartEvent('run-1', 1, 'scan', 2, 'p1'),
      agentEndEvent('run-1', 1, 'cancelled', 3),
      runEndEvent('run-1', 'cancelled', 4),
    ]
    expect(projectEvents(events)).toStrictEqual(events.reduce(projectEvent, createTranscriptView()))
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
      seq: SessionSeq(1),
      time: 0,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        stream: [],
        message: createAssistantMessage({
          content: [
            { type: 'reasoning', text: 'let me think' },
            { type: 'text', text: 'here is the answer' },
          ],
          source: { provider: 'p', model: 'm' },
        }),
      },
    })
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

  it('replaces the system segment from the latest system/message surface node', () => {
    // Session-log v3 removed `request/header.system`; the effective system
    // prompt lives in `system/message` surface events (an empty content
    // records "no system prompt").
    const systemMessage = (text: string | undefined, seq: number, surfaceOp: 'append' | { op: 'replace'; startSeq: number; endSeq: number } = 'append') => ({
      type: 'system/message',
      seq,
      time: 0,
      surfaceOp,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'system',
          id: 'sys-' + seq,
          content: text === undefined ? [] : [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'system-prompt' },
        },
      },
    }) as unknown as SessionEvent
    let view = projectEvent(createTranscriptView(), systemMessage('you are helpful', 1))
    expect(view.systemPrompt).toBe('you are helpful')
    expect(view.stats.contextSegments.system).toBe(4)
    // An EMPTY append records an empty later node — it does not erase the
    // head (only a replacement covering the head's seq can).
    view = projectEvent(view, systemMessage(undefined, 2))
    expect(view.systemPrompt).toBe('you are helpful')
    expect(view.stats.contextSegments.system).toBe(4)
    // A replacement covering every node with empty content clears it all.
    view = projectEvent(view, systemMessage(undefined, 3, { op: 'replace', startSeq: 1, endSeq: 2 }))
    expect(view.systemPrompt).toBe('')
    expect(view.stats.contextSegments.system).toBe(0)
  })

  it('retires system nodes shadowed by ANY surface replace, not only system/message', () => {
    // A compaction summary lands as a user/message replace whose range may
    // cover later system nodes (only node 0 is compaction-protected); the
    // fold must drop them from the assembled prompt and the estimate.
    const systemMessage = (text: string, seq: number, surfaceOp: 'append' | { op: 'replace'; startSeq: number; endSeq: number }) => ({
      type: 'system/message', seq, time: 0, surfaceOp,
      data: { turn: 1, step: 1, message: { role: 'system', id: 'sys-' + seq, content: text === '' ? [] : [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'system-prompt' } } },
    } as unknown as SessionEvent)
    const compactionSummary = (seq: number, startSeq: number, endSeq: number) => ({
      type: 'user/message', seq, time: 0, surfaceOp: { op: 'replace' as const, startSeq, endSeq },
      data: createUserMessage({
        content: [{ type: 'text', text: 'compacted context summary' }],
        source: { kind: 'plugin', plugin: 'compaction', form: 'notice', summary: 'compacted' },
      }),
    } as unknown as SessionEvent)
    let view = projectEvents([
      systemMessage('head persona', 1, 'append'),
      systemMessage('pinned addendum', 2, 'append'),
    ] as const)
    expect(view.systemPrompt).toBe('head persona\n\npinned addendum')
    // The compaction replace covers seq 2 (and its own summary node); only
    // the protected head survives. The segment estimate prices the surviving
    // head (12 ASCII chars → 3) plus the compaction notice row itself (9
    // chars → 3; plugin context joins the system segment).
    view = projectEvent(view, compactionSummary(3, 2, 2))
    expect(view.systemPrompt).toBe('head persona')
    expect(view.stats.contextSegments.system).toBe(6)
    expect(view.entries.some(entry => entry.kind === 'user' && entry.text.includes('compacted'))).toBe(true)
  })

  it('keeps the surviving head when a replacement only clears a later system node', () => {
    // The in-history route appends later nodes and may later normalize them
    // away with a replace carrying empty content — the head node survives and
    // the estimate must not drop to zero.
    const systemMessage = (text: string | undefined, seq: number, surfaceOp: 'append' | { op: 'replace'; startSeq: number; endSeq: number }) => ({
      type: 'system/message',
      seq,
      time: 0,
      surfaceOp,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'system',
          id: 'sys-' + seq,
          content: text === undefined ? [] : [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'system-prompt' },
        },
      },
    }) as unknown as SessionEvent
    let view = projectEvents([
      systemMessage('you are helpful', 1, 'append'),
      systemMessage('extra context', 2, 'append'),
    ] as const)
    expect(view.systemPrompt).toBe('you are helpful\n\nextra context')
    view = projectEvent(view, systemMessage(undefined, 3, { op: 'replace', startSeq: 2, endSeq: 2 }))
    expect(view.systemPrompt).toBe('you are helpful')
    expect(view.stats.contextSegments.system).toBe(4)
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
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]
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
              push('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('orphan-' + seq), content: [{ type: 'text', text: 'orphan result' }], isError: false }) })
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
        push('user/message', queuedMessages[id])
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
        if (rand() < 0.5) {
          push('assistant/attempt', { turn: current, step, stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [1], texts: ['attempt ' + current + '.' + step] }] })
        }
        const toolCount = Math.floor(rand() * 3)
        const stepCalls: ToolCallId[] = []
        for (let t = 0; t < toolCount; t += 1) {
          // Occasionally reuse the previous callId so the replay's multi-index
          // path (duplicate ids update every matching row) is fuzzed too.
          const id = rand() < 0.05 && stepCalls.length > 0
            ? stepCalls[stepCalls.length - 1]
            : ToolCallId(`call-${current}-${step}-${t}`)
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
            source: { provider: 'p', model: 'm' },
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
      toolCallEvent('read', ToolCallId('dup'), 2),
      toolCallEvent('edit', ToolCallId('dup'), 3), // duplicate callId: two rows share it
      toolResultEvent(ToolCallId('dup'), 'done', false, 4),
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
        events.push({ type: 'tool/result', seq: seq++, time: 0, data: { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('orphan-' + i), content: [{ type: 'text', text: 'x' }], isError: false }) } } as unknown as SessionEvent)
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
    const acc = liveAcc()
    for (const event of [
      { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } },
      { type: 'step/start', seq: 2, time: 100, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 4, time: 500, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    ] as const) replayProjectEvent(acc, event as unknown as SessionEvent)
    streamText(acc, 'thinking', 200)
    // The frame arrived after the sweep folded the turn end; the anchors it
    // touched were already reclaimed, and no later boundary re-creates them.
    const view = snapshotReplayView(acc)
    expect(view.anchors.stepStart.size).toBe(0)
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
    const acc = liveAcc()
    for (const event of [
      { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } },
      { type: 'step/start', seq: 2, time: 100, data: { turn: 1, step: 1 } },
    ] as const) replayProjectEvent(acc, event as unknown as SessionEvent)
    streamText(acc, 'stale', 200) // step 1 interrupted right here
    for (const event of [
      { type: 'step/start', seq: 4, time: 300, data: { turn: 1, step: 2 } },
      { ...assistantEvent('fresh', 5), time: 600 },
      { type: 'turn/end', seq: 6, time: 700, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as const) replayProjectEvent(acc, event as unknown as SessionEvent)
    const view = snapshotReplayView(acc)
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
      toolCallEvent('read', ToolCallId('a'), 2),
      toolCallEvent('bash', ToolCallId('b'), 3),
      toolCallEvent('edit', ToolCallId('c'), 4),
      toolResultEvent(ToolCallId('b'), 'done', false, 5), // b completes between running a and c
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
