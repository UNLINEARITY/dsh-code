/**
 * Pure session-event-to-view projection for the TUI transcript: one reducer
 * over {@link SessionEvent}s producing the ordered entries the renderer draws.
 * Rendering never reads the session directly — this module owns the view
 * model, so tests drive it with plain event arrays.
 *
 * @module @deepseek-ai/dsh-tui/render/projection
 */

import { boundContextSummary, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, TodoItem } from '@deepseek-ai/dsh-session'
// Type-only imports merge the plugin-owned SessionEventMap variants (command/*
// from dsh-commands) into the union this reducer switches on.
import type {} from '@deepseek-ai/dsh-commands'

/** One user prompt line. */
export interface UserEntry {
  kind: 'user'
  /** Joined text blocks of the user message. */
  text: string
}

/** One assembled assistant reply. */
export interface AssistantEntry {
  kind: 'assistant'
  /** Joined text blocks of the assistant message. */
  text: string
}

/** One model-requested tool invocation and its settled state. */
export interface ToolEntry {
  kind: 'tool'
  /** Correlation id shared with the matching `tool/result`. */
  callId: string
  /** Tool name as the model addressed it. */
  name: string
  /** Raw arguments JSON string exactly as the model produced it. */
  arguments: string
  /** Execution state; `running` until the paired result lands. */
  state: 'running' | 'done' | 'error'
  /** Bounded first text block of the result, empty until it lands. */
  summary: string
}

/** One slash-command execution dispatched through `ctx.commands`. */
export interface CommandEntry {
  kind: 'command'
  /** Pairing id shared with the matching `command/done`. */
  commandId: string
  /** Lowercase command name without the leading slash. */
  name: string
  /** Verbatim text following the command name. */
  args: string
  /** Execution state; `running` until the paired lifecycle event lands. */
  state: 'running' | 'done' | 'error'
  /** Handler outcome text, empty until it lands. */
  summary: string
}

/** One turn-level failure surfaced from `turn/end`. */
export interface ErrorEntry {
  kind: 'error'
  /** `code: message` of the failure. */
  text: string
}

/** Ordered transcript items the renderer draws. */
export type TranscriptEntry = UserEntry | AssistantEntry | ToolEntry | CommandEntry | ErrorEntry

/** Cumulative token accounting folded from `assistant/message` usage reports. */
export interface UsageTotals {
  /** Prompt-side billed tokens: `inputTokens` plus both cache buckets. */
  inputTokens: number
  /** Completion-side tokens over the whole log. */
  outputTokens: number
  /** Cache-read tokens over the whole log (0 when the adapter reports none). */
  cacheReadTokens: number
}

/** Window-scoped figures the status line shows; timing uses event timestamps. */
export interface TranscriptStats {
  /** Durable turns opened (`turn/start` events). */
  turns: number
  /** Model requests made (`step/start` events). */
  steps: number
  /** Summed model wall time: `step/start` → `assistant/message`, in ms. */
  llmMs: number
  /** Summed tool wall time: `tool/call` → `tool/result`, in ms. */
  toolMs: number
  /** Cumulative token accounting; input stays 0 until a report lands. */
  usage: UsageTotals
}

/** The complete TUI transcript view for one session. */
export interface TranscriptView {
  /** Settled entries in log order. */
  entries: readonly TranscriptEntry[]
  /** Text accumulated from `assistant/chunk` deltas since the last flush. */
  streaming: string
  /** Latest whole-list todo snapshot from `todo/write`, empty when none. */
  todos: readonly TodoItem[]
  /** True while a durable turn is open (`turn/start` … `turn/end`). */
  busy: boolean
  /** Figures the status line renders. */
  stats: TranscriptStats
  /**
   * The `provider/model` pair of the last `request/header` snapshot — the
   * session's own model record, which a resumed TUI prefers over the
   * deployment default (mirrors the web host's resume selection order).
   * Empty before the session's first request.
   */
  model: string
  /**
   * Fold-internal timing anchors, never rendered: open step and tool-call
   * start timestamps the next `assistant/message` / `tool/result` resolves
   * against. Keyed `turn:step` and by call id.
   */
  readonly anchors: { stepStart: Map<string, number>; toolStart: Map<string, number> }
}

/** Join the text blocks of a content list; non-text blocks contribute nothing. */
function textOf(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** A fresh, empty transcript view. */
export function createTranscriptView(): TranscriptView {
  return {
    entries: [],
    streaming: '',
    todos: [],
    busy: false,
    model: '',
    stats: { turns: 0, steps: 0, llmMs: 0, toolMs: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } },
    anchors: { stepStart: new Map(), toolStart: new Map() },
  }
}

/**
 * Fold one session event into an updated view (copy-on-write).
 * @param view - the view before the event.
 * @param event - one durable session event from `session/event` or the log.
 * @returns the view after the event; the input view is never mutated.
 */
export function projectEvent(view: TranscriptView, event: SessionEvent): TranscriptView {
  switch (event.type) {
    case 'user/message': {
      // Injected context (plugin/model-continuation sources) stays collapsed
      // to a bounded notice row, exactly like collapsed transcript context
      // elsewhere in the product; only direct human prompts render in full.
      const message = event.data
      if (message.source.kind === 'user') {
        return { ...view, entries: [...view.entries, { kind: 'user', text: textOf(message.content) }] }
      }
      const notice = message.source.kind === 'plugin' && message.source.form === 'notice'
        ? message.source.summary
        : message.source.kind
      return { ...view, entries: [...view.entries, { kind: 'user', text: boundContextSummary(notice) }] }
    }
    case 'assistant/chunk': {
      const chunk = event.data.chunk
      if (chunk.type !== 'text-delta') return view
      return { ...view, streaming: view.streaming + chunk.text }
    }
    case 'assistant/message': {
      // The assembled message is authoritative; drop the streamed buffer.
      const key = `${event.data.turn}:${event.data.step}`
      const started = view.anchors.stepStart.get(key)
      view.anchors.stepStart.delete(key)
      const usage = event.data.usage
      const totals = view.stats.usage
      return {
        ...view,
        streaming: '',
        entries: [...view.entries, { kind: 'assistant', text: textOf(event.data.message.content) }],
        stats: {
          ...view.stats,
          llmMs: view.stats.llmMs + (started === undefined ? 0 : Math.max(0, event.time - started)),
          usage: usage === undefined ? totals : {
            inputTokens: totals.inputTokens + usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
            outputTokens: totals.outputTokens + usage.outputTokens,
            cacheReadTokens: totals.cacheReadTokens + (usage.cacheReadTokens ?? 0),
          },
        },
      }
    }
    case 'tool/call': {
      const data = event.data
      view.anchors.toolStart.set(data.callId, event.time)
      return {
        ...view,
        entries: [...view.entries, {
          kind: 'tool',
          callId: data.callId,
          name: data.name,
          arguments: data.arguments,
          state: 'running',
          summary: '',
        }],
      }
    }
    case 'tool/result': {
      const block = event.data.message.content[0]
      const started = view.anchors.toolStart.get(block.toolCallId)
      view.anchors.toolStart.delete(block.toolCallId)
      const summary = boundContextSummary(textOf(block.content))
      const entries = view.entries.map((entry) => {
        if (entry.kind !== 'tool' || entry.callId !== block.toolCallId) return entry
        return { ...entry, state: block.isError === true ? 'error' as const : 'done' as const, summary }
      })
      return {
        ...view,
        entries,
        stats: {
          ...view.stats,
          toolMs: view.stats.toolMs + (started === undefined ? 0 : Math.max(0, event.time - started)),
        },
      }
    }
    case 'todo/write':
      return { ...view, todos: event.data.todos }
    case 'turn/start':
      // The web todo projection clears on turn/start: a fresh turn's first
      // write is the authoritative list, and a stale snapshot must not linger
      // through a turn that has not written one yet.
      return {
        ...view,
        busy: true,
        todos: [],
        stats: { ...view.stats, turns: view.stats.turns + 1 },
      }
    case 'step/start':
      view.anchors.stepStart.set(`${event.data.turn}:${event.data.step}`, event.time)
      return { ...view, stats: { ...view.stats, steps: view.stats.steps + 1 } }
    case 'turn/end': {
      const reason = event.data.reason
      if (reason.kind !== 'error') return { ...view, busy: false }
      return {
        ...view,
        busy: false,
        entries: [...view.entries, { kind: 'error', text: `${reason.error.code}: ${reason.error.message}` }],
      }
    }
    case 'request/header': {
      // The session's own model record: the latest snapshot's provider/model
      // pair, exactly what a resumed TUI restores as the selection.
      const config = event.data.header.config
      return { ...view, model: `${config.provider}/${config.model}` }
    }
    case 'command/run': {
      const data = event.data
      return {
        ...view,
        entries: [...view.entries, {
          kind: 'command',
          commandId: data.commandId,
          name: data.name,
          args: data.args ?? '',
          state: 'running',
          summary: '',
        }],
      }
    }
    case 'command/done': {
      const data = event.data
      const entries = view.entries.map((entry) => {
        if (entry.kind !== 'command' || entry.commandId !== data.commandId) return entry
        return {
          ...entry,
          state: data.kind === 'success' ? 'done' as const : 'error' as const,
          summary: boundContextSummary(data.text ?? ''),
        }
      })
      return { ...view, entries }
    }
    default:
      return view
  }
}

/**
 * Fold a replayed event history into one view.
 * @param events - events in `seq` order.
 * @returns the folded view.
 */
export function projectEvents(events: readonly SessionEvent[]): TranscriptView {
  return events.reduce(projectEvent, createTranscriptView())
}
