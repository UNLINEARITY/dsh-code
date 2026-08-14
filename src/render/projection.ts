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
// Type-only imports merge the plugin-owned SessionEventMap variants
// (command/*, compaction/*, goal/change, llm/retry*, plan/mode,
// permission/preset, sandbox/mode, session/title) into the union this
// reducer switches on.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-llm-retry'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session-title'
import { toolArgumentsPreview } from './tool-preview.ts'
import { toolResultDetail, type ToolDetail } from './tool-detail.ts'

/** One user prompt line. */
export interface UserEntry {
  kind: 'user'
  /** Joined text blocks of the user message. */
  text: string
  /** True for collapsed injected context (plugin/continuation notices), which
   * the renderer marks with a dim ↳ instead of the user ❯ prompt. */
  notice: boolean
}

/** One assembled assistant reply. */
export interface AssistantEntry {
  kind: 'assistant'
  /** Joined text blocks of the assistant message. */
  text: string
  /** Joined reasoning blocks of the same message, empty when the model thought out loud. */
  reasoning: string
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
  /** Bounded human-meaningful arguments preview for the tool card. */
  preview: string
  /** Execution state; `running` until the paired result lands. */
  state: 'running' | 'done' | 'error'
  /** Bounded first text block of the result, empty until it lands. */
  summary: string
  /**
   * Bounded expansion payload for the verbose transcript (Ctrl+O), derived
   * from the tool's persisted presentation metadata; undefined until the
   * result lands and only when something renderable exists.
   */
  detail: ToolDetail | undefined
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

/** One non-error turn outcome surfaced from `turn/end`. */
export interface TurnMarkerEntry {
  kind: 'turn-marker'
  /** Human-readable outcome line, dim-rendered. */
  text: string
}

/** One completed compaction lifecycle surfaced from `compaction/end`. */
export interface CompactionEntry {
  kind: 'compaction'
  /** True when the compaction completed, false when it failed. */
  ok: boolean
  /** Heuristic tokens shadowed by the compaction (summary or prune price). */
  tokens: number
  /** Failure text when `ok` is false, empty otherwise. */
  error: string
}

/** One provider-routed model-request retry (the `llm/retry` pair). */
export interface RetryEntry {
  kind: 'retry'
  /** Correlation id shared with the matching `llm/retry-started`. */
  retryId: string
  /** Attempt ordinal and its cap. */
  attempt: number
  max: number
  /** Failure code that triggered the retry. */
  code: string
  /** Backoff wait before the next attempt, in ms. */
  delayMs: number
  /** `running` while the backoff waits, `done` once the attempt started. */
  state: 'running' | 'done'
}

/** Turn-tail deliverables: files mutated by the turn's diff-bearing tools. */
export interface FilesEntry {
  kind: 'files'
  /** Unique mutated paths in call order, bounded. */
  paths: readonly string[]
}

/** Ordered transcript items the renderer draws. */
export type TranscriptEntry = UserEntry | AssistantEntry | ToolEntry | CommandEntry | ErrorEntry | TurnMarkerEntry | CompactionEntry | RetryEntry | FilesEntry

/** The live goal the status line badges, folded from `goal/change`. */
export interface GoalFold {
  /** Human-requested completion objective. */
  objective: string
  /** Durable lifecycle phase. */
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  /** Highest admitted continuation round and its cap. */
  rounds: number
  max: number
  /** Blocked explanation, empty outside the blocked phase. */
  blocked: string
}

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
  /** Prompt-side size of the most recent reported request (context pressure). */
  lastPromptTokens: number
  /** Newest advertised route capacity, 0 when no adapter ever advertised one. */
  contextWindow: number
  /** Summed first-token waits: `step/start` → first non-empty chunk, in ms. */
  ttftMs: number
  /** Steps that produced a first chunk (the TTFT average's denominator). */
  ttftSteps: number
  /** Summed decode spans: first chunk → `assistant/message`, in ms. */
  decodeMs: number
  /** Completion tokens over timed decode spans (the tok/s numerator). */
  decodeTokens: number
}

/** The complete TUI transcript view for one session. */
export interface TranscriptView {
  /** Settled entries in log order. */
  entries: readonly TranscriptEntry[]
  /** Text accumulated from `assistant/chunk` deltas since the last flush. */
  streaming: string
  /** Thinking accumulated from `assistant/chunk` reasoning deltas since the last flush. */
  streamingReasoning: string
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
  /** Plan mode state folded from the last `plan/mode` event. */
  plan: boolean
  /** Active permission preset folded from the last `permission/preset` event, empty before one. */
  permission: string
  /** Latest session title folded from the last `session/title` event, empty before one. */
  title: string
  /** Sandbox-mode override folded from the last `sandbox/mode` event, empty when never switched. */
  sandbox: string
  /** Current long-running goal folded from the last `goal/change`, undefined when cleared. */
  goal: GoalFold | undefined
  /**
   * Fold-internal timing anchors, never rendered: open step and tool-call
   * start timestamps the next `assistant/message` / `tool/result` resolves
   * against. Keyed `turn:step` and by call id.
   */
  readonly anchors: { stepStart: Map<string, number>; toolStart: Map<string, number>; firstChunkAt: Map<string, number>; compactionTokens: Map<string, number>; lastPruneTokens: number; turnFiles: Map<number, Set<string>> }
}

/** Join the text blocks of a content list; non-text blocks contribute nothing. */
function textOf(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Join the reasoning blocks of a content list; non-reasoning blocks contribute nothing. */
function reasoningOf(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'reasoning').map(block => block.text).join('')
}

/** A fresh, empty transcript view. */
export function createTranscriptView(): TranscriptView {
  return {
    entries: [],
    streaming: '',
    streamingReasoning: '',
    todos: [],
    busy: false,
    model: '',
    plan: false,
    permission: '',
    title: '',
    sandbox: '',
    goal: undefined,
    stats: { turns: 0, steps: 0, llmMs: 0, toolMs: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, lastPromptTokens: 0, contextWindow: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    anchors: { stepStart: new Map(), toolStart: new Map(), firstChunkAt: new Map(), compactionTokens: new Map(), lastPruneTokens: 0, turnFiles: new Map() },
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
        return { ...view, entries: [...view.entries, { kind: 'user', text: textOf(message.content), notice: false }] }
      }
      const notice = message.source.kind === 'plugin' && message.source.form === 'notice'
        ? message.source.summary
        : message.source.kind
      return { ...view, entries: [...view.entries, { kind: 'user', text: boundContextSummary(notice), notice: true }] }
    }
    case 'assistant/chunk': {
      const chunk = event.data.chunk
      // First-token latency: the first non-empty delta of a step anchors the
      // TTFT (empty keep-alive deltas do not count as tokens).
      const key = `${event.data.turn}:${event.data.step}`
      const delta = chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' ? chunk.text : ''
      let stats = view.stats
      if (delta !== '' && !view.anchors.firstChunkAt.has(key)) {
        view.anchors.firstChunkAt.set(key, event.time)
        const started = view.anchors.stepStart.get(key)
        if (started !== undefined) {
          stats = {
            ...stats,
            ttftMs: stats.ttftMs + Math.max(0, event.time - started),
            ttftSteps: stats.ttftSteps + 1,
          }
        }
      }
      if (chunk.type === 'text-delta') {
        return { ...view, streaming: view.streaming + chunk.text, stats }
      }
      if (chunk.type === 'reasoning-delta') {
        return { ...view, streamingReasoning: view.streamingReasoning + chunk.text, stats }
      }
      return view
    }
    case 'assistant/message': {
      // The assembled message is authoritative; drop the streamed buffers.
      const key = `${event.data.turn}:${event.data.step}`
      const started = view.anchors.stepStart.get(key)
      view.anchors.stepStart.delete(key)
      const firstChunk = view.anchors.firstChunkAt.get(key)
      view.anchors.firstChunkAt.delete(key)
      const usage = event.data.usage
      const totals = view.stats.usage
      return {
        ...view,
        streaming: '',
        streamingReasoning: '',
        entries: [...view.entries, {
          kind: 'assistant',
          text: textOf(event.data.message.content),
          reasoning: reasoningOf(event.data.message.content),
        }],
        stats: {
          ...view.stats,
          llmMs: view.stats.llmMs + (started === undefined ? 0 : Math.max(0, event.time - started)),
          usage: usage === undefined ? totals : {
            inputTokens: totals.inputTokens + usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
            outputTokens: totals.outputTokens + usage.outputTokens,
            cacheReadTokens: totals.cacheReadTokens + (usage.cacheReadTokens ?? 0),
          },
          lastPromptTokens: usage === undefined ? view.stats.lastPromptTokens
            : usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
          // Decode span and its tokens pair up: an un-timed step (no first
          // chunk landed) contributes neither, so the rate stays honest.
          decodeMs: view.stats.decodeMs + (firstChunk === undefined ? 0 : Math.max(0, event.time - firstChunk)),
          decodeTokens: view.stats.decodeTokens + (firstChunk === undefined || usage === undefined ? 0 : usage.outputTokens),
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
          preview: toolArgumentsPreview(data.arguments, data.name),
          state: 'running',
          summary: '',
          detail: undefined,
        }],
      }
    }
    case 'tool/result': {
      const block = event.data.message.content[0]
      const started = view.anchors.toolStart.get(block.toolCallId)
      view.anchors.toolStart.delete(block.toolCallId)
      const rawText = textOf(block.content)
      const summary = boundContextSummary(rawText)
      // The verbose expansion self-serves from the persisted presentation
      // metadata (diffs, read windows, web sources) with the bounded raw text
      // as the universal fallback — the capable-UI degradation ladder.
      const detail = toolResultDetail(event.data.meta, rawText)
      // Turn-tail deliverables: a diff-bearing mutation records its paths.
      if (detail?.kind === 'diff') {
        const set = view.anchors.turnFiles.get(event.data.turn) ?? new Set<string>()
        for (const diff of detail.diffs) set.add(diff.path)
        view.anchors.turnFiles.set(event.data.turn, set)
      }
      const entries = view.entries.map((entry) => {
        if (entry.kind !== 'tool' || entry.callId !== block.toolCallId) return entry
        return { ...entry, state: block.isError === true ? 'error' as const : 'done' as const, summary, detail }
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
      const appended: TranscriptEntry[] = []
      if (reason.kind === 'error') {
        appended.push({ kind: 'error', text: `${reason.error.code}: ${reason.error.message}` })
      } else {
        // Non-error outcomes deserve their own durable row (the web renders
        // distinct max-tokens / abort / interruption nodes); `completed` stays
        // silent so an ordinary turn never grows a marker.
        const marker = reason.kind === 'aborted'
          ? reason.reason.kind === 'user' ? 'turn cancelled by the user' : `turn cancelled (${reason.reason.kind})`
          : reason.kind === 'max-tokens'
            ? 'turn hit the output-token ceiling (max-tokens)'
            : reason.kind === 'blocked'
              ? 'turn ended blocked'
              : reason.kind === 'interrupted'
                ? 'turn was interrupted by a restart'
                : undefined
        if (marker !== undefined) appended.push({ kind: 'turn-marker', text: marker })
      }
      // Deliverables ride the turn tail (the web's turnTail chips): the
      // turn's mutated files flush as one bounded row, then the set resets.
      const files = view.anchors.turnFiles.get(event.data.turn)
      view.anchors.turnFiles.delete(event.data.turn)
      if (files !== undefined && files.size > 0) appended.push({ kind: 'files', paths: [...files].slice(0, 12) })
      if (appended.length === 0) return { ...view, busy: false }
      return { ...view, busy: false, entries: [...view.entries, ...appended] }
    }
    case 'llm/retry': {
      const data = event.data
      return {
        ...view,
        entries: [...view.entries, {
          kind: 'retry',
          retryId: data.retryId,
          attempt: data.retry,
          max: 'maxRetries' in data ? data.maxRetries : data.retry,
          code: data.failure.code,
          delayMs: data.delayMs,
          state: 'running',
        }],
      }
    }
    case 'llm/retry-started': {
      const data = event.data
      const entries = view.entries.map((entry) => {
        if (entry.kind !== 'retry' || entry.retryId !== data.retryId) return entry
        return { ...entry, state: 'done' as const }
      })
      return { ...view, entries }
    }
    case 'sandbox/mode':
      // Log-only override switch; last write wins for the status badge.
      return { ...view, sandbox: event.data.mode }
    case 'goal/change': {
      const data = event.data
      const clip = (text: string): string => (text.length > 60 ? `${text.slice(0, 59)}…` : text)
      if (data.operation === 'clear') {
        return {
          ...view,
          goal: undefined,
          entries: [...view.entries, { kind: 'turn-marker', text: '◎ goal cleared' }],
        }
      }
      const goal: GoalFold = {
        objective: data.goal.objective,
        phase: data.goal.phase,
        rounds: data.roundsStarted,
        max: data.goal.maxGoalRounds,
        blocked: data.goal.blockedReason?.message ?? '',
      }
      const line = data.operation === 'create'
        ? `◎ goal: ${clip(data.goal.objective)}`
        : data.operation === 'complete'
          ? '◎ goal complete'
          : data.operation === 'pause'
            ? '◎ goal paused'
            : data.operation === 'resume'
              ? '◎ goal resumed'
              : data.operation === 'block'
                ? `◎ goal blocked: ${clip(goal.blocked)}`
                : undefined
      return {
        ...view,
        goal,
        entries: line === undefined ? view.entries : [...view.entries, { kind: 'turn-marker', text: line }],
      }
    }
    case 'session/title':
      // Latest-wins title snapshot, log-only; the status line prefers it.
      return { ...view, title: event.data.title }
    case 'compaction/summary':
      // Remember the shadow price so the matching `compaction/end` row can
      // state what the compaction reclaimed.
      view.anchors.compactionTokens.set(event.data.compactionId, event.data.shadowedTokenCount)
      return view
    case 'compaction/prune':
      // A model-free prune carries no compaction id; its price serves the next
      // `compaction/end` that cannot find a summary price.
      return { ...view, anchors: { ...view.anchors, lastPruneTokens: event.data.shadowedTokenCount } }
    case 'compaction/end': {
      const ok = event.data.error === undefined
      const tokens = view.anchors.compactionTokens.get(event.data.compactionId) ?? view.anchors.lastPruneTokens
      view.anchors.compactionTokens.delete(event.data.compactionId)
      return {
        ...view,
        entries: [...view.entries, { kind: 'compaction', ok, tokens, error: event.data.error ?? '' }],
      }
    }
    case 'request/context':
      // Route capacity, logged only when it changes; last one wins.
      return {
        ...view,
        stats: { ...view.stats, contextWindow: event.data.contextWindow ?? view.stats.contextWindow },
      }
    case 'request/header': {
      // The session's own model record: the latest snapshot's provider/model
      // pair, exactly what a resumed TUI restores as the selection.
      const config = event.data.header.config
      return { ...view, model: `${config.provider}/${config.model}` }
    }
    case 'plan/mode':
      // Whole-value replace; the last one wins (upstream fold semantics).
      return { ...view, plan: event.data.active }
    case 'permission/preset':
      return { ...view, permission: event.data.preset }
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
