/**
 * Pure session-event-to-view projection for the TUI transcript: one reducer
 * over {@link SessionEvent}s producing the ordered entries the renderer draws.
 * Rendering never reads the session directly — this module owns the view
 * model, so tests drive it with plain event arrays.
 *
 * @module @deepseek-ai/dsh-tui/render/projection
 */

import { boundContextSummary, type ContentBlock, type ImageBlock, type MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, TodoItem } from '@deepseek-ai/dsh-session'
import { graphemeWidth, splitGraphemes } from './width.ts'
// Type-only imports merge the plugin-owned SessionEventMap variants
// (agent/inbox/spliced, command/*, compaction/*, goal/change, llm/retry*,
// plan/mode, permission/preset, sandbox/mode, session/title) into the union
// this reducer switches on.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-llm-retry'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session-title'
import { toolArgumentsPreview, toolPromptPreview } from './tool-preview.ts'
import { toolResultDetail, type ToolDetail } from './tool-detail.ts'

/** In-flight UI buffers are tails; the assembled assistant message is authoritative. */
const MAX_STREAMING_CHARS = 65_536

/**
 * Upper bound on remembered `compaction/summary` shadow prices waiting for a
 * matching `compaction/end`. Compactions are sequential and rare, so a few
 * slots suffice; an aborted compaction (summary without end) otherwise leaves
 * an unbounded residue in `anchors.compactionTokens`. An evicted price
 * degrades to the documented `lastPruneTokens` fallback, exactly like a
 * missing summary.
 */
const MAX_COMPACTION_SUMMARY_RESIDUE = 16

/** Append one delta without retaining an unbounded duplicate of the live reply. */
function appendStreamingTail(current: string, delta: string): string {
  const next = current + delta
  return next.length <= MAX_STREAMING_CHARS ? next : next.slice(-MAX_STREAMING_CHARS)
}

/** One user prompt line. */
export interface UserEntry {
  kind: 'user'
  /** Joined text blocks of the user message. */
  text: string
  /** True for collapsed injected context (plugin/continuation notices), which
   * the renderer marks with a dim ↳ instead of the user ❯ prompt. */
  notice: boolean
  /** Durable image references carried by this prompt. */
  images?: readonly ImageBlock['attachment'][]
}

/** One user message waiting in the agent inbox (the web's queued-message row). */
export interface PendingEntry {
  kind: 'pending'
  /** Stable message identity shared with the durable `user/message` that retires it. */
  messageId: MessageId
  /** Which inbox list holds the message: steering is consumed at the next step boundary. */
  target: 'next-turn' | 'next-step'
  /** Full message text — Codex PendingSteer renders queued prompts exactly like user rows. */
  text: string
  /** Durable image references queued with this prompt. */
  images?: readonly ImageBlock['attachment'][]
}

/** One authoritative assembled assistant reply. */
export interface AssistantEntry {
  kind: 'assistant'
  /** Joined text blocks of the assistant message. */
  text: string
  /** Joined reasoning blocks from the same assembled message. */
  reasoning: string
  /** True when a cancelled stream's delivered prefix was finalized as this
   * entry (rc.8 `assistant/message.interrupted`) — rendered with a marker. */
  interrupted?: true
}

/** One model-requested tool invocation and its settled state. */
export interface ToolEntry {
  kind: 'tool'
  /** Correlation id shared with the matching `tool/result`. */
  callId: string
  /**
   * Global tool-call ordinal across the whole transcript (1, 2, 3…, never
   * reset between turns). The tool-card badge and every error line that
   * references the failed call share this number, so "call N" in an error
   * always names the exact card the badge shows.
   */
  ordinal: number
  /** Tool name as the model addressed it. */
  name: string
  /** Raw arguments JSON string exactly as the model produced it. */
  arguments: string
  /** Bounded human-meaningful arguments preview for the tool card. */
  preview: string
  /** Bounded delegation prompt (subagent cards' second row), '' when none. */
  prompt: string
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
export type TranscriptEntry = UserEntry | PendingEntry | AssistantEntry | ToolEntry | CommandEntry | ErrorEntry | TurnMarkerEntry | CompactionEntry | RetryEntry | FilesEntry

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

/**
 * Estimated used tokens per context content type, folded from transcript
 * events via {@link estimateTokens}. The segmented context bar's composition
 * source: proportions across types are meaningful, absolute values are not
 * (they never touch billing or the reported `lastPromptTokens`).
 */
export interface ContextSegments {
  /** Rendered system-prompt text (latest `request/header`) plus injected-context notices. */
  system: number
  /** Direct human prompts (durable `user/message` rows). */
  prompt: number
  /** Assistant text blocks (visible replies). */
  assistant: number
  /** Assistant reasoning blocks (hidden thinking). */
  thinking: number
  /** Tool call arguments plus result text. */
  tools: number
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
  /** Estimated used tokens per content type (the segmented bar's composition). */
  contextSegments: ContextSegments
  /** Summed first-token waits: `step/start` → first non-empty chunk, in ms. */
  ttftMs: number
  /** Steps that produced a first chunk (the TTFT average's denominator). */
  ttftSteps: number
  /** Summed decode spans: first chunk → `assistant/message`, in ms. */
  decodeMs: number
  /** Completion tokens over timed decode spans (the tok/s numerator). */
  decodeTokens: number
  /**
   * Adapter-owned reasoning effort of the latest `request/header` config —
   * the EFFECTIVE effort the session actually uses (a materialized model
   * default is included, exactly as the adapter resolved it). Empty when the
   * header carried none (provider-default behavior). The status line appends
   * it to the model segment as `provider/model@effort`.
   */
  reasoningEffort: string
}

/** The complete TUI transcript view for one session. */
export interface TranscriptView {
  /** Settled entries in log order. */
  entries: readonly TranscriptEntry[]
  /** Bounded text tail accumulated from `assistant/chunk` deltas since the last flush. */
  streaming: string
  /** Bounded thinking tail accumulated from reasoning deltas since the last flush. */
  streamingReasoning: string
  /** Latest whole-list todo snapshot from `todo/write`, empty when none. */
  todos: readonly TodoItem[]
  /**
   * Global tool-call ordinal counter: the number the NEXT `tool/call` lands
   * with (1-based). Never reset, so the counter and the badges/error lines
   * stay consistent across turns and resumed sessions.
   */
  toolCallOrdinal: number
  /** True while a durable turn is open (`turn/start` … `turn/end`). */
  busy: boolean
  /** `turn/start` time of the open turn (0 while idle) — the web TurnStatus clock anchor. */
  busySince: number
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
   * Ordered live message ids per inbox target, mirrored from
   * `agent/inbox/spliced` exactly like the upstream Inbox projection — the
   * coordinates later removals resolve against.
   */
  pending: { 'next-turn': readonly string[]; 'next-step': readonly string[] }
  /**
   * Fold-internal timing anchors, never rendered: open step and tool-call
   * start timestamps the next `assistant/message` / `tool/result` resolves
   * against. Keyed `turn:step` and by call id. `turnSteps`/`turnTools`
   * track which step/tool anchors still belong to the open turn so
   * `turn/end` (and a superseding `step/start`) can sweep anchors an
   * interruption left behind; `turnFiles` keys mutated paths by turn.
   */
  readonly anchors: {
    stepStart: Map<string, number>
    toolStart: Map<string, number>
    firstChunkAt: Map<string, number>
    compactionTokens: Map<string, number>
    lastPruneTokens: number
    turnFiles: Map<number, Set<string>>
    turnSteps: Map<number, string>
    turnTools: Map<number, Set<string>>
  }
}

/** Join the text blocks of a content list; non-text blocks contribute nothing. */
function textOf(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Durable image references in their model-visible order. */
function imagesOf(content: readonly ContentBlock[]): readonly ImageBlock['attachment'][] {
  return content.filter((block): block is ImageBlock => block.type === 'image').map(block => block.attachment)
}

/** Human-readable bounded image labels for transcript, inspector, and export surfaces. */
export function imageLabels(images: readonly ImageBlock['attachment'][] | undefined): string {
  if (images === undefined || images.length === 0) return ''
  return images.map((image, index) => {
    const rawName = image.name?.trim() || `image ${index + 1}`
    const name = rawName.length <= 80 ? rawName : `${rawName.slice(0, 79)}…`
    const original = image.originalDimensions
    const dimensions = original === undefined
      ? `${image.width}×${image.height}`
      : `${image.width}×${image.height} · original ${original.width}×${original.height}`
    return `[image: ${name} · ${dimensions} · ${image.bytes} B]`
  }).join('\n')
}

/** Prompt text with its durable image labels, without exposing local paths or bytes. */
export function promptDisplayText(entry: Pick<UserEntry | PendingEntry, 'text' | 'images'>): string {
  const labels = imageLabels(entry.images)
  return entry.text === '' ? labels : labels === '' ? entry.text : `${entry.text}\n${labels}`
}

/** Join the reasoning blocks of a content list; non-reasoning blocks contribute nothing. */
function reasoningOf(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'reasoning').map(block => block.text).join('')
}

/**
 * Rough token estimate for the segmented context bar (pi-nano-context's ~4
 * chars/token heuristic, CJK-aware so a Chinese prompt is not quartered):
 * CJK/wide chars cost ~1 token each, ASCII ~4 chars per token. Estimates
 * drive bar PROPORTIONS, never billing, so precision is not required.
 * @param text - the text to estimate.
 * @returns an integer token estimate, 0 for empty text.
 */
function estimateTokens(text: string): number {
  let wide = 0
  let narrow = 0
  for (const cluster of splitGraphemes(text)) {
    if (graphemeWidth(cluster) > 1) wide += 1
    else narrow += 1
  }
  return wide + Math.ceil(narrow / 4)
}

/** A fresh, empty transcript view. */
export function createTranscriptView(): TranscriptView {
  return {
    entries: [],
    streaming: '',
    streamingReasoning: '',
    todos: [],
    toolCallOrdinal: 0,
    busy: false,
    busySince: 0,
    model: '',
    plan: false,
    permission: '',
    title: '',
    sandbox: '',
    goal: undefined,
    pending: { 'next-turn': [], 'next-step': [] },
    stats: { turns: 0, steps: 0, llmMs: 0, toolMs: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, lastPromptTokens: 0, contextWindow: 0, contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 }, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0, reasoningEffort: '' },
    anchors: { stepStart: new Map(), toolStart: new Map(), firstChunkAt: new Map(), compactionTokens: new Map(), lastPruneTokens: 0, turnFiles: new Map(), turnSteps: new Map(), turnTools: new Map() },
  }
}

/** Full prompt text of a queued message (identical to the durable user row it retires into). */
function pendingText(content: readonly ContentBlock[]): string {
  return textOf(content)
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
      // A queued row retires when its durable user message lands (the agent
      // claims the inbox and logs the same message identity) — the transient
      // steering/queued preview yields to the real transcript entry.
      const message = event.data
      let entries = view.entries
      let pending = view.pending
      for (const target of ['next-turn', 'next-step'] as const) {
        const index = pending[target].indexOf(message.id)
        if (index < 0) continue
        pending = { ...pending, [target]: pending[target].filter((_, i) => i !== index) }
        entries = entries.filter(entry => !(entry.kind === 'pending' && entry.messageId === message.id))
      }
      // Injected context (plugin/model-continuation sources) stays collapsed
      // to a bounded notice row, exactly like collapsed transcript context
      // elsewhere in the product; only direct human prompts render in full.
      const text = textOf(message.content)
      const images = imagesOf(message.content)
      if (message.source.kind === 'user') {
        return {
          ...view,
          pending,
          entries: [...entries, { kind: 'user', text, notice: false, ...(images.length === 0 ? {} : { images }) }],
          stats: {
            ...view.stats,
            contextSegments: {
              ...view.stats.contextSegments,
              prompt: view.stats.contextSegments.prompt + estimateTokens(text),
            },
          },
        }
      }
      const notice = message.source.kind === 'plugin' && message.source.form === 'notice'
        ? message.source.summary
        : message.source.kind
      const summary = boundContextSummary(notice)
      return {
        ...view,
        pending,
        entries: [...entries, { kind: 'user', text: summary, notice: true }],
        stats: {
          ...view.stats,
          contextSegments: {
            ...view.stats.contextSegments,
            system: view.stats.contextSegments.system + estimateTokens(summary),
          },
        },
      }
    }
    case 'agent/inbox/spliced': {
      // The durable inbox mutation (web queue-mirror contract, event-sourced):
      // removals drop the projected rows at their inbox coordinates, inserted
      // messages gain a pending row at their log position.
      const { target, start, removedCount = 0, inserted } = event.data
      const ids = view.pending[target]
      const removed = ids.slice(start, start + removedCount)
      const nextIds = [
        ...ids.slice(0, start),
        ...ids.slice(start + removedCount),
        ...inserted.map(message => message.id),
      ]
      let entries = view.entries
      if (removed.length > 0) {
        const removedSet = new Set(removed)
        entries = entries.filter(entry =>
          !(entry.kind === 'pending' && entry.target === target && removedSet.has(entry.messageId)))
      }
      for (const message of inserted) {
        entries = [...entries, {
          kind: 'pending',
          messageId: message.id,
          target,
          text: pendingText(message.content),
          ...imagesOf(message.content).length === 0 ? {} : { images: imagesOf(message.content) },
        }]
      }
      return { ...view, entries, pending: { ...view.pending, [target]: nextIds } }
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
        return {
          ...view,
          streaming: appendStreamingTail(view.streaming, chunk.text),
          stats,
        }
      }
      if (chunk.type === 'reasoning-delta') {
        return {
          ...view,
          streamingReasoning: appendStreamingTail(view.streamingReasoning, chunk.text),
          stats,
        }
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
      // The assembled message consumes the turn's current step anchor; a
      // later `turn/end` sweep then has nothing left to clean for this step.
      if (view.anchors.turnSteps.get(event.data.turn) === key) view.anchors.turnSteps.delete(event.data.turn)
      const usage = event.data.usage
      const totals = view.stats.usage
      const text = textOf(event.data.message.content)
      const reasoning = reasoningOf(event.data.message.content)
      return {
        ...view,
        streaming: '',
        streamingReasoning: '',
        entries: [...view.entries, { kind: 'assistant', text, reasoning, interrupted: event.data.interrupted === true ? true : undefined }],
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
          contextSegments: {
            ...view.stats.contextSegments,
            thinking: view.stats.contextSegments.thinking + estimateTokens(reasoning),
            assistant: view.stats.contextSegments.assistant + estimateTokens(text),
          },
        },
      }
    }
    case 'tool/call': {
      const data = event.data
      view.anchors.toolStart.set(data.callId, event.time)
      // Remember the call's turn so `turn/end` can sweep a start that never
      // pairs with a result (an interrupted tool otherwise leaks its anchor).
      const turnTools = view.anchors.turnTools.get(data.turn) ?? new Set<string>()
      turnTools.add(data.callId)
      view.anchors.turnTools.set(data.turn, turnTools)
      const ordinal = view.toolCallOrdinal + 1
      return {
        ...view,
        toolCallOrdinal: ordinal,
        entries: [
          ...view.entries,
          {
            kind: 'tool',
          callId: data.callId,
          ordinal,
          name: data.name,
          arguments: data.arguments,
          preview: toolArgumentsPreview(data.arguments, data.name),
          prompt: toolPromptPreview(data.name, data.arguments),
          state: 'running',
          summary: '',
          detail: undefined,
        }],
        stats: {
          ...view.stats,
          contextSegments: {
            ...view.stats.contextSegments,
            tools: view.stats.contextSegments.tools
              + (typeof data.arguments === 'string' ? estimateTokens(data.arguments) : 0),
          },
        },
      }
    }
    case 'tool/result': {
      const block = event.data.message.content[0]
      const started = view.anchors.toolStart.get(block.toolCallId)
      view.anchors.toolStart.delete(block.toolCallId)
      // Deregister the call from its turn's registry so `turn/end` does not
      // sweep a start that already paired with a result.
      const turnTools = view.anchors.turnTools.get(event.data.turn)
      if (turnTools !== undefined) {
        turnTools.delete(block.toolCallId)
        if (turnTools.size === 0) view.anchors.turnTools.delete(event.data.turn)
      }
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
          contextSegments: {
            ...view.stats.contextSegments,
            tools: view.stats.contextSegments.tools + estimateTokens(rawText),
          },
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
        busySince: view.busy ? view.busySince : event.time,
        todos: [],
        stats: { ...view.stats, turns: view.stats.turns + 1 },
      }
    case 'step/start': {
      // A step supersedes the turn's previous step: if that step never
      // assembled a message (interrupted), its timing anchors are stale the
      // moment the next step opens and are swept here instead of leaking.
      const key = `${event.data.turn}:${event.data.step}`
      const previous = view.anchors.turnSteps.get(event.data.turn)
      if (previous !== undefined && previous !== key) {
        view.anchors.stepStart.delete(previous)
        view.anchors.firstChunkAt.delete(previous)
      }
      view.anchors.turnSteps.set(event.data.turn, key)
      view.anchors.stepStart.set(key, event.time)
      return {
        ...view,
        streaming: '',
        streamingReasoning: '',
        stats: { ...view.stats, steps: view.stats.steps + 1 },
      }
    }
    case 'turn/end': {
      const reason = event.data.reason
      const appended: TranscriptEntry[] = []
      if (reason.kind === 'error') {
        const recovery = reason.error.code === 'MISSING_CREDENTIAL'
          ? ' · open /model to add an API key'
          : ''
        appended.push({ kind: 'error', text: `${reason.error.code}: ${reason.error.message}${recovery}` })
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
      // Derivable boundary sweep: the turn is over, so any step/tool anchors
      // it left behind (interruptions that never produced their message or
      // result) can never be resolved and are reclaimed now.
      const stepKey = view.anchors.turnSteps.get(event.data.turn)
      if (stepKey !== undefined) {
        view.anchors.stepStart.delete(stepKey)
        view.anchors.firstChunkAt.delete(stepKey)
        view.anchors.turnSteps.delete(event.data.turn)
      }
      const turnToolSet = view.anchors.turnTools.get(event.data.turn)
      if (turnToolSet !== undefined) {
        for (const callId of turnToolSet) view.anchors.toolStart.delete(callId)
        view.anchors.turnTools.delete(event.data.turn)
      }
      if (appended.length === 0) {
        return { ...view, busy: false, busySince: 0, streaming: '', streamingReasoning: '' }
      }
      return {
        ...view,
        busy: false,
        busySince: 0,
        streaming: '',
        streamingReasoning: '',
        entries: [...view.entries, ...appended],
      }
    }
    case 'llm/retry': {
      const data = event.data
      return {
        ...view,
        streaming: '',
        streamingReasoning: '',
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
      // state what the compaction reclaimed. The map is capped so an aborted
      // compaction (summary without end) cannot leave an unbounded residue.
      if (view.anchors.compactionTokens.size >= MAX_COMPACTION_SUMMARY_RESIDUE) {
        const oldest = view.anchors.compactionTokens.keys().next().value
        if (oldest !== undefined) view.anchors.compactionTokens.delete(oldest)
      }
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
      // pair, exactly what a resumed TUI restores as the selection, plus the
      // effective reasoning effort that snapshot carried (the adapter may
      // materialize the model default, which is what the status line shows).
      // The snapshot's rendered system prompt is the current system slot, so
      // it REPLACES the estimate (an older system prompt is not re-sent).
      const config = event.data.header.config
      return {
        ...view,
        model: `${config.provider}/${config.model}`,
        stats: {
          ...view.stats,
          reasoningEffort: config.reasoningEffort === undefined ? '' : String(config.reasoningEffort),
          contextSegments: {
            ...view.stats.contextSegments,
            system: estimateTokens(event.data.header.system ?? ''),
          },
        },
      }
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
 * Mutable replay accumulator: folds a persisted log into the identical view
 * `projectEvent` would produce, but in near-linear time. Where `projectEvent`
 * is copy-on-write — every append/scan rebuilds the whole `entries` array, so
 * folding a full log costs O(N²) — the accumulator appends by push, resolves
 * id-keyed updates (tool/result, command/done, retry-started) through index
 * maps, and tombstones retired pending rows, so the whole log folds in O(N)
 * plus one compaction pass when tombstones exist.
 *
 * Index maps never delete: every appended row registers its index, so an id
 * lookup miss provably means no matching row exists and the update is an O(1)
 * no-op (a malicious/orphan-heavy log cannot force per-orphan full-array
 * scans). Each id maps to ALL of its indices, so a duplicate id updates every
 * matching row exactly like the copy-on-write reducer.
 *
 * @internal Exported only so tests can (a) prove replay ≡ sequential
 * `projectEvent` folds and (b) assert the linear complexity deterministically
 * via {@link ReplayAccumulator.ops}, which counts entry-level container work
 * instead of relying on wall-clock thresholds. No public consumer.
 */
export interface ReplayAccumulator {
  /** Working entry list; `undefined` marks a retired pending row (tombstone). */
  entries: (TranscriptEntry | undefined)[]
  /** callId → every index into `entries` holding a `tool` row with that id. */
  toolIndex: Map<string, number[]>
  /** commandId → every index into `entries` holding a `command` row with that id. */
  commandIndex: Map<string, number[]>
  /** retryId → every index into `entries` holding a `retry` row with that id. */
  retryIndex: Map<string, number[]>
  /** messageId → every index into `entries` holding a `pending` row with that id. */
  pendingIndex: Map<string, number[]>
  /** Tombstone count; zero means `entries` is already the final array. */
  removedCount: number
  /** Mutable inbox id lists, mirroring `view.pending` order per target. */
  pendingTurn: string[]
  pendingStep: string[]
  streaming: string
  streamingReasoning: string
  todos: readonly TodoItem[]
  /** Global tool-call ordinal counter (see `TranscriptView.toolCallOrdinal`). */
  toolCallOrdinal: number
  busy: boolean
  busySince: number
  model: string
  plan: boolean
  permission: string
  title: string
  sandbox: string
  goal: GoalFold | undefined
  stats: TranscriptStats
  stepStart: Map<string, number>
  toolStart: Map<string, number>
  firstChunkAt: Map<string, number>
  compactionTokens: Map<string, number>
  lastPruneTokens: number
  turnFiles: Map<number, Set<string>>
  turnSteps: Map<number, string>
  turnTools: Map<number, Set<string>>
  /** Entry-level container operations performed so far (test instrumentation). */
  ops: number
}

/** @internal A fresh replay accumulator whose state mirrors `createTranscriptView()`. */
export function createReplayAccumulator(): ReplayAccumulator {
  return {
    entries: [],
    toolIndex: new Map(),
    commandIndex: new Map(),
    retryIndex: new Map(),
    pendingIndex: new Map(),
    removedCount: 0,
    pendingTurn: [],
    pendingStep: [],
    streaming: '',
    streamingReasoning: '',
    todos: [],
    toolCallOrdinal: 0,
    busy: false,
    busySince: 0,
    model: '',
    plan: false,
    permission: '',
    title: '',
    sandbox: '',
    goal: undefined,
    stats: { turns: 0, steps: 0, llmMs: 0, toolMs: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, lastPromptTokens: 0, contextWindow: 0, contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 }, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0, reasoningEffort: '' },
    stepStart: new Map(),
    toolStart: new Map(),
    firstChunkAt: new Map(),
    compactionTokens: new Map(),
    lastPruneTokens: 0,
    turnFiles: new Map(),
    turnSteps: new Map(),
    turnTools: new Map(),
    ops: 0,
  }
}

/** Append one entry (O(1)) and account the push. */
function appendReplayEntry(acc: ReplayAccumulator, entry: TranscriptEntry): void {
  acc.entries.push(entry)
  acc.ops += 1
}

/**
 * Get (or create) the index list an id owns. Lists are never removed: every
 * appended row registers its index, so a lookup miss later proves no matching
 * row exists and the caller can no-op in O(1).
 */
function indexList(map: Map<string, number[]>, id: string): number[] {
  let list = map.get(id)
  if (list === undefined) {
    list = []
    map.set(id, list)
  }
  return list
}

/**
 * Apply an id-keyed update to every row that registered the id, mirroring the
 * copy-on-write reducer's full-array map semantics (all matching rows update,
 * in order). Each registered index is O(1), so a duplicate id costs
 * O(#duplicates) — never a full-array scan. The kind+id re-check is defensive:
 * registered indices are valid by construction, because tool/command/retry
 * rows are never removed and tombstones never shift indices.
 */
function updateReplayById<T extends TranscriptEntry>(
  acc: ReplayAccumulator,
  map: Map<string, number[]>,
  id: string,
  isMatch: (entry: T) => boolean,
  update: (entry: T) => T,
): void {
  const list = map.get(id)
  if (list === undefined) return // miss provably means no matching row
  for (const index of list) {
    const entry = acc.entries[index]
    if (entry === undefined || !isMatch(entry as T)) continue
    acc.entries[index] = update(entry as T)
    acc.ops += 1
  }
}

/** Tombstone a retired pending row, keeping every other index stable. */
function retireReplayEntry(acc: ReplayAccumulator, index: number): void {
  if (acc.entries[index] !== undefined) {
    acc.entries[index] = undefined
    acc.removedCount += 1
    acc.ops += 1
  }
}

/**
 * Fold one session event into a replay accumulator. This mirrors
 * {@link projectEvent} case for case — same stats arithmetic, same anchor
 * set/delete behavior, same entry shapes — so the finished view is identical
 * to a sequential fold; only the `entries` container operations are mutable.
 *
 * @internal Test-instrumentation path; `projectEvents` is the public entry.
 * @returns whether the event changed the accumulated state — the live store
 * stays silent and keeps its snapshot identity for ignored events, exactly
 * like the copy-on-write reducer returning its input view unchanged.
 */
export function replayProjectEvent(acc: ReplayAccumulator, event: SessionEvent): boolean {
  switch (event.type) {
    case 'user/message': {
      const message = event.data
      for (const target of ['next-turn', 'next-step'] as const) {
        const ids = target === 'next-turn' ? acc.pendingTurn : acc.pendingStep
        const index = ids.indexOf(message.id)
        acc.ops += index < 0 ? ids.length : index + 1
        if (index < 0) continue
        ids.splice(index, 1)
        acc.ops += 1
        // Retire every pending row carrying this message id (duplicate ids
        // included), exactly like the reducer's full-array filter.
        const list = acc.pendingIndex.get(message.id)
        if (list !== undefined) {
          for (const entryIndex of list) retireReplayEntry(acc, entryIndex)
          acc.ops += 1
        }
      }
      const text = textOf(message.content)
      const images = imagesOf(message.content)
      if (message.source.kind === 'user') {
        appendReplayEntry(acc, { kind: 'user', text, notice: false, ...(images.length === 0 ? {} : { images }) })
        acc.stats = {
          ...acc.stats,
          contextSegments: {
            ...acc.stats.contextSegments,
            prompt: acc.stats.contextSegments.prompt + estimateTokens(text),
          },
        }
        return true
      }
      const notice = message.source.kind === 'plugin' && message.source.form === 'notice'
        ? message.source.summary
        : message.source.kind
      const summary = boundContextSummary(notice)
      appendReplayEntry(acc, { kind: 'user', text: summary, notice: true })
      acc.stats = {
        ...acc.stats,
        contextSegments: {
          ...acc.stats.contextSegments,
          system: acc.stats.contextSegments.system + estimateTokens(summary),
        },
      }
      return true
    }
    case 'agent/inbox/spliced': {
      const { target, start, removedCount = 0, inserted } = event.data
      const ids = target === 'next-turn' ? acc.pendingTurn : acc.pendingStep
      const removed = ids.slice(start, start + removedCount)
      acc.ops += removed.length
      ids.splice(start, removedCount)
      acc.ops += removed.length
      for (const id of removed) {
        const list = acc.pendingIndex.get(id)
        if (list === undefined) continue
        for (const entryIndex of list) {
          const entry = acc.entries[entryIndex]
          if (entry !== undefined && entry.kind === 'pending' && entry.target === target) {
            retireReplayEntry(acc, entryIndex)
          }
        }
      }
      for (const message of inserted) {
        const images = imagesOf(message.content)
        appendReplayEntry(acc, { kind: 'pending', messageId: message.id, target, text: pendingText(message.content), ...(images.length === 0 ? {} : { images }) })
        indexList(acc.pendingIndex, message.id).push(acc.entries.length - 1)
        ids.push(message.id)
        acc.ops += 1
      }
      return true
    }
    case 'assistant/chunk': {
      const chunk = event.data.chunk
      const key = `${event.data.turn}:${event.data.step}`
      const delta = chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' ? chunk.text : ''
      if (delta !== '' && !acc.firstChunkAt.has(key)) {
        acc.firstChunkAt.set(key, event.time)
        const started = acc.stepStart.get(key)
        if (started !== undefined) {
          acc.stats = {
            ...acc.stats,
            ttftMs: acc.stats.ttftMs + Math.max(0, event.time - started),
            ttftSteps: acc.stats.ttftSteps + 1,
          }
        }
      }
      if (chunk.type === 'text-delta') {
        acc.streaming = appendStreamingTail(acc.streaming, chunk.text)
        return true
      }
      if (chunk.type === 'reasoning-delta') {
        acc.streamingReasoning = appendStreamingTail(acc.streamingReasoning, chunk.text)
        return true
      }
      return false
    }
    case 'assistant/message': {
      const key = `${event.data.turn}:${event.data.step}`
      const started = acc.stepStart.get(key)
      acc.stepStart.delete(key)
      const firstChunk = acc.firstChunkAt.get(key)
      acc.firstChunkAt.delete(key)
      if (acc.turnSteps.get(event.data.turn) === key) acc.turnSteps.delete(event.data.turn)
      const usage = event.data.usage
      const totals = acc.stats.usage
      const text = textOf(event.data.message.content)
      const reasoning = reasoningOf(event.data.message.content)
      acc.streaming = ''
      acc.streamingReasoning = ''
      appendReplayEntry(acc, { kind: 'assistant', text, reasoning, interrupted: event.data.interrupted === true ? true : undefined })
      acc.stats = {
        ...acc.stats,
        llmMs: acc.stats.llmMs + (started === undefined ? 0 : Math.max(0, event.time - started)),
        usage: usage === undefined ? totals : {
          inputTokens: totals.inputTokens + usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
          outputTokens: totals.outputTokens + usage.outputTokens,
          cacheReadTokens: totals.cacheReadTokens + (usage.cacheReadTokens ?? 0),
        },
        lastPromptTokens: usage === undefined ? acc.stats.lastPromptTokens
          : usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
        decodeMs: acc.stats.decodeMs + (firstChunk === undefined ? 0 : Math.max(0, event.time - firstChunk)),
        decodeTokens: acc.stats.decodeTokens + (firstChunk === undefined || usage === undefined ? 0 : usage.outputTokens),
        contextSegments: {
          ...acc.stats.contextSegments,
          thinking: acc.stats.contextSegments.thinking + estimateTokens(reasoning),
          assistant: acc.stats.contextSegments.assistant + estimateTokens(text),
        },
      }
      return true
    }
    case 'tool/call': {
      const data = event.data
      acc.toolStart.set(data.callId, event.time)
      const turnTools = acc.turnTools.get(data.turn) ?? new Set<string>()
      turnTools.add(data.callId)
      acc.turnTools.set(data.turn, turnTools)
      acc.toolCallOrdinal += 1
      appendReplayEntry(acc, {
        kind: 'tool',
        callId: data.callId,
        ordinal: acc.toolCallOrdinal,
        name: data.name,
        arguments: data.arguments,
        preview: toolArgumentsPreview(data.arguments, data.name),
        prompt: toolPromptPreview(data.name, data.arguments),
        state: 'running',
        summary: '',
        detail: undefined,
      })
      indexList(acc.toolIndex, data.callId).push(acc.entries.length - 1)
      acc.stats = {
        ...acc.stats,
        contextSegments: {
          ...acc.stats.contextSegments,
          tools: acc.stats.contextSegments.tools
            + (typeof data.arguments === 'string' ? estimateTokens(data.arguments) : 0),
        },
      }
      return true
    }
    case 'tool/result': {
      const block = event.data.message.content[0]
      const started = acc.toolStart.get(block.toolCallId)
      acc.toolStart.delete(block.toolCallId)
      const turnTools = acc.turnTools.get(event.data.turn)
      if (turnTools !== undefined) {
        turnTools.delete(block.toolCallId)
        if (turnTools.size === 0) acc.turnTools.delete(event.data.turn)
      }
      const rawText = textOf(block.content)
      const summary = boundContextSummary(rawText)
      const detail = toolResultDetail(event.data.meta, rawText)
      if (detail?.kind === 'diff') {
        const set = acc.turnFiles.get(event.data.turn) ?? new Set<string>()
        for (const diff of detail.diffs) set.add(diff.path)
        acc.turnFiles.set(event.data.turn, set)
      }
      const update = (entry: ToolEntry): ToolEntry => ({
        ...entry,
        state: block.isError === true ? 'error' as const : 'done' as const,
        summary,
        detail,
      })
      // Every matching row updates (duplicate callIds included); an id with no
      // registered index is a provable no-op — no full-array fallback scan.
      updateReplayById<ToolEntry>(acc, acc.toolIndex, block.toolCallId, entry => entry.callId === block.toolCallId, update)
      acc.stats = {
        ...acc.stats,
        toolMs: acc.stats.toolMs + (started === undefined ? 0 : Math.max(0, event.time - started)),
        contextSegments: {
          ...acc.stats.contextSegments,
          tools: acc.stats.contextSegments.tools + estimateTokens(rawText),
        },
      }
      return true
    }
    case 'todo/write':
      acc.todos = event.data.todos
      return true
    case 'turn/start': {
      const wasBusy = acc.busy
      acc.busy = true
      acc.busySince = wasBusy ? acc.busySince : event.time
      acc.todos = []
      acc.stats = { ...acc.stats, turns: acc.stats.turns + 1 }
      return true
    }
    case 'step/start': {
      const key = `${event.data.turn}:${event.data.step}`
      const previous = acc.turnSteps.get(event.data.turn)
      if (previous !== undefined && previous !== key) {
        acc.stepStart.delete(previous)
        acc.firstChunkAt.delete(previous)
      }
      acc.turnSteps.set(event.data.turn, key)
      acc.stepStart.set(key, event.time)
      acc.streaming = ''
      acc.streamingReasoning = ''
      acc.stats = { ...acc.stats, steps: acc.stats.steps + 1 }
      return true
    }
    case 'turn/end': {
      const reason = event.data.reason
      const appended: TranscriptEntry[] = []
      acc.streamingReasoning = ''
      acc.streaming = ''
      if (reason.kind === 'error') {
        const recovery = reason.error.code === 'MISSING_CREDENTIAL'
          ? ' · open /model to add an API key'
          : ''
        appended.push({ kind: 'error', text: `${reason.error.code}: ${reason.error.message}${recovery}` })
      } else {
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
      const files = acc.turnFiles.get(event.data.turn)
      acc.turnFiles.delete(event.data.turn)
      if (files !== undefined && files.size > 0) appended.push({ kind: 'files', paths: [...files].slice(0, 12) })
      const stepKey = acc.turnSteps.get(event.data.turn)
      if (stepKey !== undefined) {
        acc.stepStart.delete(stepKey)
        acc.firstChunkAt.delete(stepKey)
        acc.turnSteps.delete(event.data.turn)
      }
      const turnToolSet = acc.turnTools.get(event.data.turn)
      if (turnToolSet !== undefined) {
        for (const callId of turnToolSet) acc.toolStart.delete(callId)
        acc.turnTools.delete(event.data.turn)
      }
      acc.busy = false
      acc.busySince = 0
      for (const entry of appended) appendReplayEntry(acc, entry)
      return true
    }
    case 'llm/retry': {
      const data = event.data
      acc.streaming = ''
      acc.streamingReasoning = ''
      appendReplayEntry(acc, {
        kind: 'retry',
        retryId: data.retryId,
        attempt: data.retry,
        max: 'maxRetries' in data ? data.maxRetries : data.retry,
        code: data.failure.code,
        delayMs: data.delayMs,
        state: 'running',
      })
      indexList(acc.retryIndex, data.retryId).push(acc.entries.length - 1)
      return true
    }
    case 'llm/retry-started': {
      const data = event.data
      updateReplayById<RetryEntry>(acc, acc.retryIndex, data.retryId, entry => entry.retryId === data.retryId, entry => ({ ...entry, state: 'done' as const }))
      return true
    }
    case 'sandbox/mode':
      acc.sandbox = event.data.mode
      return true
    case 'goal/change': {
      const data = event.data
      const clip = (text: string): string => (text.length > 60 ? `${text.slice(0, 59)}…` : text)
      if (data.operation === 'clear') {
        acc.goal = undefined
        appendReplayEntry(acc, { kind: 'turn-marker', text: '◎ goal cleared' })
        return true
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
      acc.goal = goal
      if (line !== undefined) appendReplayEntry(acc, { kind: 'turn-marker', text: line })
      return true
    }
    case 'session/title':
      acc.title = event.data.title
      return true
    case 'compaction/summary':
      if (acc.compactionTokens.size >= MAX_COMPACTION_SUMMARY_RESIDUE) {
        const oldest = acc.compactionTokens.keys().next().value
        if (oldest !== undefined) acc.compactionTokens.delete(oldest)
      }
      acc.compactionTokens.set(event.data.compactionId, event.data.shadowedTokenCount)
      return true
    case 'compaction/prune':
      acc.lastPruneTokens = event.data.shadowedTokenCount
      return true
    case 'compaction/end': {
      const ok = event.data.error === undefined
      const tokens = acc.compactionTokens.get(event.data.compactionId) ?? acc.lastPruneTokens
      acc.compactionTokens.delete(event.data.compactionId)
      appendReplayEntry(acc, { kind: 'compaction', ok, tokens, error: event.data.error ?? '' })
      return true
    }
    case 'request/context':
      acc.stats = { ...acc.stats, contextWindow: event.data.contextWindow ?? acc.stats.contextWindow }
      return true
    case 'request/header': {
      const config = event.data.header.config
      acc.model = `${config.provider}/${config.model}`
      acc.stats = {
        ...acc.stats,
        reasoningEffort: config.reasoningEffort === undefined ? '' : String(config.reasoningEffort),
        contextSegments: {
          ...acc.stats.contextSegments,
          system: estimateTokens(event.data.header.system ?? ''),
        },
      }
      return true
    }
    case 'plan/mode':
      acc.plan = event.data.active
      return true
    case 'permission/preset':
      acc.permission = event.data.preset
      return true
    case 'command/run': {
      const data = event.data
      appendReplayEntry(acc, {
        kind: 'command',
        commandId: data.commandId,
        name: data.name,
        args: data.args ?? '',
        state: 'running',
        summary: '',
      })
      indexList(acc.commandIndex, data.commandId).push(acc.entries.length - 1)
      return true
    }
    case 'command/done': {
      const data = event.data
      const update = (candidate: CommandEntry): CommandEntry => ({
        ...candidate,
        state: data.kind === 'success' ? 'done' as const : 'error' as const,
        summary: boundContextSummary(data.text ?? ''),
      })
      updateReplayById<CommandEntry>(acc, acc.commandIndex, data.commandId, entry => entry.commandId === data.commandId, update)
      return true
    }
    default:
      return false
  }
}

/**
 * Materialize the accumulated fold as a `TranscriptView`, compacting any
 * retired tombstones. The anchors maps are handed through as-is (their
 * content is identical to a sequential fold's).
 *
 * @internal Test-instrumentation path; `projectEvents` is the public entry.
 */
export function finishReplay(acc: ReplayAccumulator): TranscriptView {
  return materializeReplayView(acc, false)
}

/**
 * Materialize the accumulated fold as a fresh immutable snapshot for the
 * live store. Unlike {@link finishReplay} — the one-shot replay entry, which
 * hands the accumulator's own arrays through because the accumulator is
 * discarded — every array a renderer can hold is copied here, so later
 * folds never mutate a snapshot already handed out. Same fields, same
 * tombstone compaction.
 *
 * @internal Live-store path; `projectEvents` is the public entry.
 */
export function snapshotReplayView(acc: ReplayAccumulator): TranscriptView {
  return materializeReplayView(acc, true)
}

/** Field-for-field materialization; `copy` selects snapshot array isolation. */
function materializeReplayView(acc: ReplayAccumulator, copy: boolean): TranscriptView {
  const entries: readonly TranscriptEntry[] = acc.removedCount === 0
    ? (copy ? [...acc.entries] : acc.entries) as TranscriptEntry[]
    : acc.entries.filter((entry): entry is TranscriptEntry => entry !== undefined)
  if (acc.removedCount > 0) acc.ops += acc.entries.length
  return {
    entries,
    streaming: acc.streaming,
    streamingReasoning: acc.streamingReasoning,
    todos: acc.todos,
    toolCallOrdinal: acc.toolCallOrdinal,
    busy: acc.busy,
    busySince: acc.busySince,
    model: acc.model,
    plan: acc.plan,
    permission: acc.permission,
    title: acc.title,
    sandbox: acc.sandbox,
    goal: acc.goal,
    pending: { 'next-turn': [...acc.pendingTurn], 'next-step': [...acc.pendingStep] },
    stats: acc.stats,
    anchors: {
      stepStart: acc.stepStart,
      toolStart: acc.toolStart,
      firstChunkAt: acc.firstChunkAt,
      compactionTokens: acc.compactionTokens,
      lastPruneTokens: acc.lastPruneTokens,
      turnFiles: acc.turnFiles,
      turnSteps: acc.turnSteps,
      turnTools: acc.turnTools,
    },
  }
}

/**
 * Fold a replayed event history into one view.
 *
 * Folding is near-linear in the log size: the mutable replay accumulator
 * appends in place and resolves id-keyed updates through index maps, so a
 * long persisted session replays without the O(N²) copy-on-write rebuilds a
 * naive sequential fold would incur. The result is identical to folding
 * {@link projectEvent} per event in order.
 * @param events - events in `seq` order.
 * @returns the folded view.
 */
export function projectEvents(events: readonly SessionEvent[]): TranscriptView {
  const acc = createReplayAccumulator()
  for (const event of events) replayProjectEvent(acc, event)
  return finishReplay(acc)
}

/**
 * The append-only flush boundary for a transcript view: the count of entries
 * no later event can remove. Entries at or beyond this index are mutable and
 * must stay in the live tree.
 *
 * `pending` rows are excluded even though they are not a running tool/retry:
 * the inbox claims or cancels them durably (`agent/inbox/spliced` removals,
 * `user/message` retirement), and an append-only `<Static>` flush cannot
 * erase a row that vanishes from the view — the retired row would ghost on
 * screen until the next source-backed replay. Running commands join the
 * mutable boundary for the same reason in reverse: `command/done` mutates the
 * row's state/summary, so a flushed row would keep its stale running mark
 * until a resize-triggered replay. Everything else (including a completed
 * tail) is final: later events only APPEND new rows.
 * @param entries - the view's transcript entries in order.
 * @returns the count of entries safe to flush (0 for an empty transcript).
 */
export function settledEntryCount(entries: readonly TranscriptEntry[]): number {
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (entry.kind === 'pending') return index
    if (entry.kind === 'tool' && entry.state === 'running') return index
    if (entry.kind === 'retry' && entry.state === 'running') return index
    if (entry.kind === 'command' && entry.state === 'running') return index
  }
  return entries.length
}
