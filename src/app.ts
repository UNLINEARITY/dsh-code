/**
 * The Ink terminal app: whale-and-wordmark header in DeepSeek blue, the live
 * transcript, the todo panel, the streaming line, the approval bar, the model
 * panel, local notices, and the input box with history and slash-command
 * completion. All state arrives through the transcript store (derived from
 * the durable session log) plus local input state; the app owns no session
 * mutation of its own.
 *
 * Element construction uses `createElement` (not JSX): the `dsh` source launch
 * compiles this file through tsx's ESM-only hook, which does not adopt this
 * package's `jsx: react-jsx` compiler option, and the classic JSX runtime
 * would demand a React global.
 *
 * @module @deepseek-ai/dsh-code/app
 */

import {
  createElement, memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement,
} from 'react'
import { Box, Static, Text, useInput, useStdout, type Key } from 'ink'
import { assertNever } from '@deepseek-ai/dsh-llm'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import type { TodoItem } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionAnswerItem } from '@deepseek-ai/dsh-user-questions'
import { TUI_RGB, brand, dim, error as paintError } from './theme.ts'
import { WHALE_GLYPH, WHALE_GLYPH_COLUMNS } from './whale-glyph.ts'
import type { TranscriptStore } from './store.ts'
import { settledEntryCount, type TranscriptEntry } from './render/projection.ts'
import { renderMarkdown, type MdSegment, visibleColumns } from './render/markdown.ts'
import type { ToolDetail } from './render/tool-detail.ts'
import { caretVisible, pulseFrame } from './render/animations.ts'
import type { ApprovalSnapshot, ApprovalStore } from './approval.ts'
import type { CommandsView } from './commands.ts'
import type { ModelDirectory, ModelRow } from './models.ts'
import type { QuestionSnapshot, QuestionStore } from './questions.ts'
import type { SkillsView, SkillRow } from './skills.ts'
import type { MentionCandidate } from './mentions.ts'
import { ModePanel, PluginPanel, ResumePanel, StatuslinePanel } from './kernel-panels.ts'
import type { PresetRow } from './presets.ts'
import type { PluginRow } from './plugin-inventory.ts'
import type { SessionDirectoryOptions, SessionRow } from './session-directory.ts'

/** Match Codex's settled-resize window before rebuilding terminal scrollback. */
const RESIZE_REFLOW_DELAY_MS = 75

/** Reset region/style, clear the visible screen and scrollback, then home. */
const RESIZE_REFLOW_CLEAR = '\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H'
import {
  formatTokens,
  layoutStatusBar,
  parseStatuslineItems,
  STATUS_CYCLE_HINT,
  STATUS_GROUP_SEPARATOR,
  STATUS_ITEM_SEPARATOR,
  type StatusFacts,
  type StatusGroup,
  type StatusItemId,
  type StatusSpan,
  type StatusTone,
} from './render/status.ts'
import { displayTail, displayText, singleLineText, truncateColumns } from './render/text.ts'
import {
  clampScroll,
  followInspectorCursor,
  inspectorViewport,
  layoutGutterRows,
  moveScroll,
  panelViewport,
  revealRow,
  selectionWindow,
} from './render/inspector.ts'
import {
  lineSegment,
  markdownLines,
  styledLines,
  textLines,
  transcriptEntryLines,
  type LineStyle,
  type StyledLine,
} from './render/lines.ts'

/** Visual priority for one bounded local notice. */
export type NoticeTone = 'info' | 'warning' | 'error'

/** Props the runner hands the app; callbacks stay owned by the runner. */
export interface AppProps {
  /** Event-fed transcript store for the live session. */
  store: TranscriptStore
  /** Approval-question store fed by the answerer listener. */
  approval: ApprovalStore
  /** ask_user_question store fed by the single UI provider. */
  questions: QuestionStore
  /** Live slash-command descriptor list (completion candidates). */
  commands: CommandsView
  /** Live user-invocable skill catalog (completion candidates). */
  skills: SkillsView
  /** `provider/model` selection serving this session (updated on /model). */
  model: string
  /** Working-directory basename the session serves. */
  cwd: string
  /** Absolute working directory used by session filters and references. */
  workspaceRoot: string
  /** Git branch name, empty outside a repository. */
  branch: string
  /** Short session identifier. */
  sessionId: string
  /** Whether this session was resumed from persistence. */
  resumed: boolean
  /** Agent preset currently composing the session. */
  mode: string
  /** Submit one line: slash commands to the registry, other text to the agent. */
  dispatch(text: string): void
  /** Submit steering: consumed at the running turn's next step boundary. */
  steer(text: string): void
  /** Interrupt the running turn (Esc); true when a turn was cancelled. */
  interrupt(): boolean
  /** Quit: unmount, flush, and request process exit. */
  quit(): void
  /** Load the selectable model directory (called when /model opens). */
  loadModels(): Promise<ModelDirectory>
  /** Load @mention candidates for the typed query (files + sessions). */
  loadMentions(query: string, signal?: AbortSignal): Promise<readonly MentionCandidate[]>
  /** Apply one /model selection; returns the display label. */
  selectModel(row: ModelRow): string
  /** Cycle to the next permission preset (Shift+Tab); returns the new label. */
  cyclePermission(): string
  /** Export the transcript to a markdown file (/export [path]); reports via notices. */
  exportTranscript(argument: string): Promise<void>
  /** Rename the session (/title <text>); returns the outcome line for the notice. */
  renameTitle(argument: string): string
  /** Preset/session/plugin kernel operations. */
  loadPresets(): Promise<readonly PresetRow[]>
  switchMode(id: string): Promise<string>
  createSession(mode?: string): void
  loadSessions(options: SessionDirectoryOptions, signal?: AbortSignal): Promise<readonly SessionRow[]>
  loadSessionTranscript(id: string, signal?: AbortSignal): Promise<string>
  switchSession(row: SessionRow): void
  cancelSessionSwitch(): boolean
  loadPlugins(): readonly PluginRow[]
  /** Registers the app's notice channel with the runner (called once on mount). */
  onBridgeReady(bridge: { notify(text: string, tone?: NoticeTone): void }): void
  /** Ordered enabled status items (/statusline config); the runner owns persistence. */
  statusline: readonly string[]
  /** Persist a new statusline item set; the runner surfaces IO failures as notices. */
  saveStatusline(items: readonly string[]): void
}

/** Ink `color` string for one palette triple. */
function inkColor(triple: readonly [number, number, number]): string {
  return `rgb(${triple[0]}, ${triple[1]}, ${triple[2]})`
}

/** Pad text with spaces to a visible-column target (menu name column). */
function padColumns(text: string, width: number): string {
  const clipped = truncateColumns(singleLineText(text), width)
  return clipped + ' '.repeat(Math.max(0, width - visibleColumns(clipped)))
}

/** Interval-driven frame counter for one self-contained animated leaf. */
function useFrames(intervalMs: number): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(current => current + 1), intervalMs)
    return () => {
      clearInterval(id)
    }
  }, [intervalMs])
  return tick
}

/**
 * Ink re-subscribes its input effect whenever the handler identity changes.
 * Keep terminal input ownership stable while a local surface updates cursor,
 * scroll, or draft state; otherwise every key toggles raw mode and can make
 * Ink repeatedly repaint the live region.
 */
function useStableInput(handler: (input: string, key: Key) => void, active: boolean): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  const stableHandler = useCallback((input: string, key: Key): void => {
    handlerRef.current(input, key)
  }, [])
  useInput(stableHandler, { isActive: active })
}

/** Single-cell stepped pulse: the web's 125ms flat-hold brightness steps over 1s. */
function Pulse(): ReactElement {
  const tick = useFrames(125)
  return createElement(Text, { color: inkColor(TUI_RGB.brandBright) }, pulseFrame(tick))
}

/** Blinking block caret appended to streaming text. */
function Caret(): ReactElement {
  const tick = useFrames(530)
  return createElement(Text, null, caretVisible(tick) ? '▍' : ' ')
}

/** Blinking input cursor: inverse block while the caret phase is on. */
function CursorBlock({ char }: { char: string }): ReactElement {
  const tick = useFrames(530)
  return createElement(Text, { inverse: caretVisible(tick) || undefined }, char)
}

/** Web TurnStatus elapsed format: `45s` under a minute, `2m03s` beyond. */
function runClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`
}

/**
 * The busy line, web TurnStatus contract: the plain `Deep diving...` label,
 * with the elapsed clock appended only once the turn has clearly been running
 * (15s) — anchored to `turn/start` so a resumed mid-turn keeps the real time.
 */
function DeepDivingLine({ since }: { since: number }): ReactElement {
  useFrames(1000)
  const elapsed = since === 0 ? 0 : Date.now() - since
  return createElement(
    Text,
    { dimColor: true },
    elapsed >= 15_000 ? `Deep diving... ${runClock(elapsed)}` : 'Deep diving...',
  )
}

/**
 * The streaming buffer rendered with a hard size cap: the live region must
 * ALWAYS fit the terminal, or Ink's erase/rewrite of a dynamic tree taller
 * than the screen freezes (cursor-up past the top, garbage, no scroll). The
 * cap counts explicit newlines and terminal wrapping, slicing from the END so
 * the freshest tokens stay visible while a long reply streams; the complete
 * text lands in the flushed scrollback once the turn assembles it.
 */
function StreamTail({ text, dim, maxRows, prefix, children }: {
  text: string
  dim: boolean
  maxRows: number
  prefix?: string
  children?: ReactElement
}): ReactElement {
  const columns = useStdout().stdout?.columns ?? 80
  const safeRows = Math.max(1, maxRows)
  // App padding consumes two columns; the final extra column keeps a caret
  // from wrapping onto an unbudgeted row.
  const contentColumns = Math.max(10, columns - 3 - visibleColumns(prefix ?? ''))
  const initial = displayTail(text, contentColumns, safeRows)
  // Reserve one row for the omission marker only when a marker is needed.
  const tail = initial.truncated && safeRows > 1
    ? displayTail(text, contentColumns, safeRows - 1)
    : initial
  return createElement(
    Box,
    { flexDirection: 'column' },
    tail.truncated && safeRows > 1
      ? createElement(Text, { dimColor: true }, '  …')
      : undefined,
    createElement(Text, { dimColor: dim || undefined }, prefix, tail.text, children),
  )
}

/** Ink props for one markdown style class. */
function segmentProps(style: MdSegment['style']): {
  color: string | undefined
  bold: boolean | undefined
  italic: boolean | undefined
  strikethrough: boolean | undefined
} {
  switch (style) {
    case 'accent':
      return { color: inkColor(TUI_RGB.brandBright), bold: undefined, italic: undefined, strikethrough: undefined }
    case 'code':
      return { color: inkColor(TUI_RGB.code), bold: undefined, italic: undefined, strikethrough: undefined }
    case 'dim':
      return { color: inkColor(TUI_RGB.dim), bold: undefined, italic: undefined, strikethrough: undefined }
    case 'bold':
      return { color: undefined, bold: true, italic: undefined, strikethrough: undefined }
    case 'italic':
      return { color: undefined, bold: undefined, italic: true, strikethrough: undefined }
    case 'boldItalic':
      return { color: undefined, bold: true, italic: true, strikethrough: undefined }
    case 'strike':
      return { color: inkColor(TUI_RGB.dim), bold: undefined, italic: undefined, strikethrough: true }
    default:
      return { color: undefined, bold: undefined, italic: undefined, strikethrough: undefined }
  }
}

/** Ink props for the richer line model used by bounded scrolling panels. */
function lineStyleProps(style: LineStyle): {
  color: string | undefined
  bold: boolean | undefined
  italic: boolean | undefined
  strikethrough: boolean | undefined
  dimColor: boolean | undefined
} {
  switch (style) {
    case 'brand':
      return { color: inkColor(TUI_RGB.brandBright), bold: undefined, italic: undefined, strikethrough: undefined, dimColor: undefined }
    case 'success':
      return { color: inkColor(TUI_RGB.success), bold: undefined, italic: undefined, strikethrough: undefined, dimColor: undefined }
    case 'error':
      return { color: inkColor(TUI_RGB.error), bold: undefined, italic: undefined, strikethrough: undefined, dimColor: undefined }
    case 'warn':
      return { color: inkColor(TUI_RGB.warn), bold: undefined, italic: undefined, strikethrough: undefined, dimColor: undefined }
    case 'dimItalic':
      return { color: undefined, bold: undefined, italic: true, strikethrough: undefined, dimColor: true }
    default:
      return { ...segmentProps(style), dimColor: undefined }
  }
}

/** Render width-safe rows; every child is exactly one terminal row. */
function StyledRows({ lines }: { lines: readonly StyledLine[] }): ReactElement {
  return createElement(
    Box,
    { flexDirection: 'column' },
    ...lines.map((line, index) => createElement(
      Text,
      { key: index, wrap: 'truncate-end' },
      line.segments.length === 0
        ? ' '
        : line.segments.map((segment, at) => createElement(
          Text,
          { key: at, ...lineStyleProps(segment.style) },
          segment.text,
        )),
    )),
  )
}

/** Codex-style panel rhythm that still participates in the row budget. */
function PanelGap({ visible }: { visible: boolean }): ReactElement | undefined {
  return visible ? createElement(Text, null, ' ') : undefined
}

/** One settled markdown document rendered as styled lines at the terminal width. */
function MarkdownBody({ text }: { text: string }): ReactElement {
  const columns = useStdout().stdout?.columns ?? 80
  // Cached by (text, width): settled replies re-layout only when either moves.
  const lines = useMemo(
    () => renderMarkdown(displayText(text), Math.max(20, columns - 2)),
    [text, columns],
  )
  return createElement(
    Box,
    { flexDirection: 'column' },
    ...lines.map((line, index) => createElement(
      Text,
      { key: index },
      line.segments.length === 0
        ? ' '
        : line.segments.map((segment, at) => createElement(Text, { key: at, ...segmentProps(segment.style) }, segment.text)),
    )),
  )
}

/**
 * One expanded tool-card body for the verbose transcript (Ctrl+O): the
 * presentation contract's structured cards — inline diffs, read windows,
 * web sources — rendered as plain terminal rows, degradation-safe against
 * replayed metadata.
 */
function ToolDetailBody({ detail }: { detail: ToolDetail }): ReactElement {
  switch (detail.kind) {
    case 'diff':
      return createElement(
        Box,
        { flexDirection: 'column' },
        ...detail.diffs.map((diff, index) => createElement(
          Box,
          { key: index, flexDirection: 'column' },
          createElement(Text, { dimColor: true, wrap: 'truncate-end' }, `  ── ${displayText(diff.path)}${diff.truncated ? ' (diff truncated)' : ''}`),
          ...diff.lines.map((line, at) => createElement(
            Text,
              {
                key: at,
                color: line.mark === '+' ? inkColor(TUI_RGB.success) : line.mark === '-' ? inkColor(TUI_RGB.error) : inkColor(TUI_RGB.dim),
                wrap: 'truncate-end',
              },
            `  ${line.mark}${displayText(line.text)}`,
          )),
        )),
      )
    case 'read':
      return createElement(
        Box,
        { flexDirection: 'column' },
        createElement(Text, { dimColor: true, wrap: 'truncate-end' }, `  ── ${displayText(detail.path)} · lines ${detail.offset}-${detail.lines.length > 0 ? detail.lines[detail.lines.length - 1]!.number : detail.offset - 1} of ${detail.totalLines}${detail.truncated ? ' (window truncated)' : ''}`),
        ...detail.lines.map((line, at) => createElement(
          Text,
          { key: at, dimColor: true, wrap: 'truncate-end' },
          `  ${String(line.number).padStart(5, ' ')} | ${displayText(line.text)}`,
        )),
      )
    case 'web-search':
      return createElement(
        Box,
        { flexDirection: 'column' },
        ...detail.sources.map((source, at) => createElement(
          Text,
            { key: at, wrap: 'truncate-end' },
          brand(`  ? ${displayText(source.title === undefined ? source.url : source.title)}`),
          createElement(Text, { dimColor: true }, dim(` - ${displayText(source.url)}`)),
        )),
        createElement(Text, { dimColor: true }, dim(`  ${detail.sources.length} sources${detail.truncated ? ' (capped)' : ''}`)),
      )
    case 'web-fetch':
      return createElement(Text, { dimColor: true, wrap: 'truncate-end' }, dim(`  ${displayText(detail.url)} · HTTP ${detail.statusCode}`))
    case 'raw':
      return createElement(
        Box,
        { flexDirection: 'column' },
        ...displayText(detail.text).split('\n').slice(0, 40).map((line, at) => createElement(Text, { key: at, dimColor: true, wrap: 'truncate-end' }, `  ${line}`)),
        createElement(Text, { dimColor: true }, detail.truncated ? '  … (output truncated)' : '  (end of output)'),
      )
    default:
      return assertNever(detail, 'tool detail kind')
  }
}
/** One settled transcript row. */
function EntryLine({ entry, showReasoning, verbose }: { entry: TranscriptEntry; showReasoning: boolean; verbose: boolean }): ReactElement {
  switch (entry.kind) {
    case 'user':
      // Collapsed injected context reads as a dim ↳ row; only direct human
      // prompts get the brand ❯ (they are different surfaces, not the same).
      return entry.notice
        ? createElement(Text, { dimColor: true }, `⤷ ${displayText(entry.text)}`)
        : createElement(Text, null, brand('❯ '), displayText(entry.text))
    case 'assistant':
      // Claude-Code-style thinking: a dim ✻ marker collapsed, the reasoning
      // text dim-italic expanded (Ctrl+R toggles globally). The collapsed
      // row is static — an animated counter inside the text would jitter the
      // line width every frame.
      return createElement(
        Box,
        { flexDirection: 'column' },
        entry.reasoning === ''
          ? undefined
          : showReasoning
            ? createElement(Text, { dimColor: true, italic: true }, `  ✻ ${displayText(entry.reasoning)}`)
            : createElement(Text, { dimColor: true }, `  ✻ Thinking (${entry.reasoning.length} chars, Ctrl+R to expand)`),
        createElement(MarkdownBody, { text: entry.text }),
      )
    case 'tool': {
      // Claude-Code-style tool card: the invocation row plus a nested ⎿
      // result line, so the summary reads under its call instead of inline.
      const mark = entry.state === 'running'
        ? createElement(Pulse)
        : entry.state === 'error'
          ? createElement(Text, { color: inkColor(TUI_RGB.error) }, '⨯')
          : createElement(Text, { color: inkColor(TUI_RGB.success) }, '⏺')
      return createElement(
        Box,
        { flexDirection: 'column' },
        createElement(
          Text,
          { wrap: verbose ? 'truncate-end' : undefined },
          mark,
          ' ',
          brand(entry.name),
          entry.preview === '' ? '' : ` ${dim(displayText(entry.preview))}`,
        ),
        entry.summary === ''
          ? undefined
          : createElement(
            Text,
            { color: entry.state === 'error' ? inkColor(TUI_RGB.error) : inkColor(TUI_RGB.dim), wrap: verbose ? 'truncate-end' : undefined },
            `  ⎿ ${displayText(entry.summary)}`,
          ),
        verbose && entry.detail !== undefined
          ? createElement(ToolDetailBody, { detail: entry.detail })
          : undefined,
      )
    }
    case 'command': {
      const mark = entry.state === 'running'
        ? createElement(Pulse)
        : entry.state === 'error'
          ? createElement(Text, { color: inkColor(TUI_RGB.error) }, '⨯')
          : createElement(Text, { color: inkColor(TUI_RGB.success) }, '⏺')
      return createElement(
        Box,
        { flexDirection: 'column' },
        createElement(
          Text,
          { wrap: verbose ? 'truncate-end' : undefined },
          mark,
          ' ',
          brand(`/${entry.name}`),
          entry.args === '' ? '' : ` ${dim(displayText(entry.args))}`,
        ),
        entry.summary === ''
          ? undefined
          : createElement(Text, { color: inkColor(TUI_RGB.dim), wrap: verbose ? 'truncate-end' : undefined }, `  ⎿ ${displayText(entry.summary)}`),
      )
    }
    case 'turn-marker':
      // Non-error turn outcomes (cancel, ceiling, interruption) as dim rows.
      return createElement(Text, { dimColor: true, wrap: verbose ? 'truncate-end' : undefined }, `  ⏹ ${displayText(entry.text)}`)
    case 'compaction':
      // Completed compaction lifecycle: what it reclaimed, or why it failed.
      return createElement(
        Text,
        { dimColor: true, wrap: verbose ? 'truncate-end' : undefined },
        entry.ok
          ? `  ⧉ compacted ~${formatTokens(entry.tokens)} tokens`
          : `  ⧉ compaction failed: ${displayText(entry.error)}`,
      )
    case 'retry':
      // Provider-routed retry: amber while the backoff waits, dim once the
      // next attempt is underway.
      return createElement(
        Text,
        { color: entry.state === 'running' ? inkColor(TUI_RGB.warn) : inkColor(TUI_RGB.dim), wrap: verbose ? 'truncate-end' : undefined },
        `  ↻ retry ${entry.attempt}/${entry.max} · ${displayText(entry.code)} · ${Math.round(entry.delayMs / 100) / 10}s`,
      )
    case 'files': {
      // Turn-tail deliverables: the turn's mutated files (web turnTail chips).
      const shown = entry.paths.slice(0, 3).map(path => displayText(path)).join(' · ')
      const more = entry.paths.length > 3 ? ` (+${entry.paths.length - 3} more)` : ''
      return createElement(Text, { dimColor: true, wrap: verbose ? 'truncate-end' : undefined }, `  ⎄ ${shown}${more}`)
    }
    case 'error':
      return createElement(Text, { wrap: verbose ? 'truncate-end' : undefined }, paintError(displayText(entry.text)))
    default:
      return assertNever(entry, 'transcript entry kind')
  }
}

/**
 * The whale wordmark header in DeepSeek blue, hugging its content width.
 * The 8-row half-block glyph pairs adjacent lines, so on a terminal too
 * short to show it whole (or mid-resize) the clipped pairs garble the
 * screen — below the height floor the header collapses to a single-line
 * wordmark that stays correct at any size.
 */
function Header({ resumed }: { resumed: boolean }): ReactElement {
  const rows = useStdout().stdout?.rows ?? 40
  const hint = resumed ? 'resumed session · /help commands · Esc interrupt' : '/help commands · Esc interrupt · Ctrl+C quit'
  if (rows < 20) {
    return createElement(
      Box,
      { flexDirection: 'row', gap: 1, borderStyle: 'round', borderColor: inkColor(TUI_RGB.brand), paddingX: 1, alignSelf: 'flex-start' },
      createElement(Text, { color: inkColor(TUI_RGB.brand), bold: true }, 'DeepSeek Harness'),
      createElement(Text, { dimColor: true }, hint),
    )
  }
  return createElement(
    Box,
    // alignSelf shrinks the border to the whale-plus-wordmark content instead
    // of stretching across the terminal and stranding empty space on the right
    // (the compact-banner treatment the Claude Code welcome uses).
    { flexDirection: 'row', gap: 1, borderStyle: 'round', borderColor: inkColor(TUI_RGB.brand), paddingX: 1, alignSelf: 'flex-start' },
    createElement(
      Box,
      { flexDirection: 'column', width: WHALE_GLYPH_COLUMNS },
      ...WHALE_GLYPH.map((row, index) => createElement(Text, { key: index, color: inkColor(TUI_RGB.brand) }, row)),
    ),
    createElement(
      Box,
      { flexDirection: 'column', justifyContent: 'center' },
      createElement(Text, { color: inkColor(TUI_RGB.brand), bold: true }, 'DeepSeek Harness'),
      createElement(Text, { dimColor: true }, hint),
    ),
  )
}

/** Todo status glyph: web TodoPanel's three-state marker. */
function todoMark(status: TodoItem['status']): string {
  return status === 'completed' ? '✓' : status === 'in_progress' ? '●' : '○'
}

/** One-row todo summary: task count cannot grow the live Ink tree. */
function TodoPanel({ todos }: { todos: readonly TodoItem[] }): ReactElement | undefined {
  if (todos.length === 0) return undefined
  const completed = todos.filter(todo => todo.status === 'completed').length
  const inProgress = todos.filter(todo => todo.status === 'in_progress').length
  const pending = todos.length - completed - inProgress
  const current = todos.find(todo => todo.status === 'in_progress')
  return createElement(
    Box,
    { paddingX: 1 },
    createElement(
      Text,
      { color: inkColor(TUI_RGB.brand), bold: true, wrap: 'truncate-end' },
      `todos ${completed}/${todos.length}`,
      createElement(Text, { dimColor: true }, ` · ${inProgress} active · ${pending} pending`),
      current === undefined ? '' : createElement(Text, { color: inkColor(TUI_RGB.brandBright) }, ` · ${todoMark(current.status)} ${displayText(current.content)}`),
    ),
  )
}

/**
 * Ink props for one status tone: the Codex status-line accent mapping over
 * the DeepSeek palette, all blue by design — the status bar speaks only in
 * degrees of blue (deep accent, primary figures, bright model identity, sky
 * paths and done states), with amber/red reserved for warnings and errors.
 */
function statusToneProps(tone: StatusTone): {
  color: string | undefined
  bold: boolean | undefined
  dimColor: boolean | undefined
} {
  switch (tone) {
    case 'model':
      return { color: inkColor(TUI_RGB.brandBright), bold: true, dimColor: undefined }
    case 'live':
      return { color: inkColor(TUI_RGB.brandBright), bold: undefined, dimColor: undefined }
    case 'path':
      return { color: inkColor(TUI_RGB.code), bold: undefined, dimColor: undefined }
    case 'branch':
      return { color: inkColor(TUI_RGB.text), bold: undefined, dimColor: undefined }
    case 'value':
      return { color: inkColor(TUI_RGB.brand), bold: undefined, dimColor: undefined }
    case 'label':
    case 'meta':
      return { color: undefined, bold: undefined, dimColor: true }
    case 'accent':
      return { color: inkColor(TUI_RGB.brandDeep), bold: undefined, dimColor: undefined }
    case 'success':
      return { color: inkColor(TUI_RGB.code), bold: true, dimColor: undefined }
    case 'warn':
      return { color: inkColor(TUI_RGB.warn), bold: true, dimColor: undefined }
    case 'error':
      return { color: inkColor(TUI_RGB.error), bold: true, dimColor: undefined }
    default:
      return { color: undefined, bold: undefined, dimColor: true }
  }
}

/**
 * The footer status line: two stacked physical rows in every mode. Row 1
 * carries Claude-Code-style identity facts and session figures from the left
 * with the Codex-style permission badge — the autonomous-selection anchor
 * with its shift+tab cycle hint — pinned to the right edge. Row 2 (mode,
 * context progress bar, cache, duration figures) renders only while it has
 * content, so the footer degrades to a single row on narrow terminals. Both
 * layouts arrive pre-measured from the pure reducer, so Ink only paints;
 * truncation degrades groups, it never wraps a row.
 */
function StatusLine({ facts, stats, busy, columns, items }: {
  facts: StatusFacts
  stats: Parameters<typeof layoutStatusBar>[1]
  busy: boolean
  columns: number
  items: readonly string[]
}): ReactElement {
  const layout = layoutStatusBar(facts, stats, Math.max(8, columns - 2), { busy, items })
  const renderRow = (row: { left: readonly StatusGroup[]; right: readonly StatusSpan[]; hint: boolean }, key: string): ReactElement => {
    const leftParts: ReactElement[] = []
    row.left.forEach((group, groupIndex) => {
      if (groupIndex > 0) {
        leftParts.push(createElement(Text, { key: key + 'gs' + groupIndex, dimColor: true }, STATUS_GROUP_SEPARATOR))
      }
      group.spans.forEach((span, spanIndex) => {
        leftParts.push(createElement(
          Text,
          { key: key + 'g' + groupIndex + 's' + spanIndex, wrap: 'truncate-end', ...statusToneProps(span.tone) },
          span.text,
        ))
      })
    })
    const rightParts: ReactElement[] = []
    row.right.forEach((span, index) => {
      if (index > 0) {
        rightParts.push(createElement(Text, { key: key + 'rs' + index, dimColor: true }, STATUS_ITEM_SEPARATOR))
      }
      rightParts.push(createElement(
        Text,
        { key: key + 'r' + index, wrap: 'truncate-end', ...statusToneProps(span.tone) },
        span.text,
      ))
    })
    if (row.hint) {
      rightParts.push(createElement(Text, { key: key + 'hint', dimColor: true }, STATUS_CYCLE_HINT))
    }
    // Each row already fits the column budget; truncate-end stays as the
    // terminal-measurement backstop so a drifting cell count clips instead
    // of wrapping.
    return createElement(
      Box,
      // Match the prompt text inside the bordered composer: one border column
      // plus one padding column. Keeping these rows margin-free also makes
      // the composer and status a fixed bottom unit in every interface.
      { paddingLeft: 2, justifyContent: rightParts.length > 0 ? 'space-between' : undefined },
      createElement(Text, { wrap: 'truncate-end' }, ...leftParts),
      rightParts.length > 0 ? createElement(Text, { wrap: 'truncate-end' }, ...rightParts) : undefined,
    )
  }
  const row2Present = layout.row2.left.length > 0
  return createElement(
    Box,
    { flexDirection: 'column' },
    renderRow(layout.row1, 's1'),
    row2Present ? renderRow(layout.row2, 's2') : undefined,
  )
}

/**
 * One fixed-height local feedback row. Errors remain visible while a slash
 * subpage is open, but arbitrary exception text can never add physical rows
 * above the composer.
 */
function NoticeLine({ text, tone, columns }: {
  text: string
  tone: NoticeTone
  columns: number
}): ReactElement {
  const color = tone === 'error'
    ? TUI_RGB.error
    : tone === 'warning'
      ? TUI_RGB.warn
      : TUI_RGB.brandBright
  const mark = tone === 'error' ? '⨯' : tone === 'warning' ? '!' : '•'
  return createElement(
    Box,
    { paddingLeft: 2 },
    createElement(
      Text,
      { color: inkColor(color), wrap: 'truncate-end' },
      truncateColumns(`${mark} ${singleLineText(text)}`, Math.max(1, columns - 2)),
    ),
  )
}

/** The y/n approval bar rendered while an approval ask is pending. */
function ApprovalBar({ snapshot, locked }: { snapshot: ApprovalSnapshot; locked: boolean }): ReactElement | undefined {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [scroll, setScroll] = useState(0)
  const pending = snapshot.pending
  const active = !locked && snapshot.pending !== undefined && !snapshot.answered
  const content = useMemo<readonly StyledLine[]>(() => pending === undefined
    ? []
    : [
      ...styledLines([lineSegment(pending.headline, 'warn')], viewport.contentColumns),
      ...(pending.command === '' ? [] : textLines(`  ${pending.command}`, viewport.contentColumns, 'dim')),
    ], [pending, viewport.contentColumns])
  const visibleScroll = clampScroll(scroll, content.length, viewport.bodyRows)

  useEffect(() => {
    setScroll(0)
  }, [pending])

  useEffect(() => {
    if (visibleScroll !== scroll) setScroll(visibleScroll)
  }, [visibleScroll, scroll])

  useInput((input, key) => {
    if (snapshot.pending === undefined) return
    if (key.upArrow) {
      setScroll(current => moveScroll(current, -1, content.length, viewport.bodyRows))
      return
    }
    if (key.downArrow) {
      setScroll(current => moveScroll(current, 1, content.length, viewport.bodyRows))
      return
    }
    if (key.pageUp) {
      setScroll(current => moveScroll(current, -Math.max(1, viewport.bodyRows - 1), content.length, viewport.bodyRows))
      return
    }
    if (key.pageDown) {
      setScroll(current => moveScroll(current, Math.max(1, viewport.bodyRows - 1), content.length, viewport.bodyRows))
      return
    }
    if (snapshot.answered) return
    if (input === 'y' || input === 'Y') {
      snapshot.pending.answer('allowed-once')
      return
    }
    if (input === 'n' || input === 'N') {
      snapshot.pending.answer('rejected')
    }
  }, { isActive: active })
  if (snapshot.pending === undefined) return undefined
  if (viewport.maxHeight === 0) return createElement(Box, { display: 'none' })
  if (viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns('approval · y allow · n reject', viewport.contentColumns))
  }
  const { answered } = snapshot
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(TUI_RGB.warn) },
    createElement(Text, { color: inkColor(TUI_RGB.warn), bold: true, wrap: 'truncate-end' }, truncateColumns(`⏸ waiting for approval · lines ${content.length === 0 ? 0 : visibleScroll + 1}-${Math.min(content.length, visibleScroll + viewport.bodyRows)}/${content.length}`, viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(StyledRows, { lines: content.slice(visibleScroll, visibleScroll + viewport.bodyRows) }),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, dim(truncateColumns(answered
      ? 'submitted…'
      : '↑↓/pgup/pgdn scroll · y allow once · n reject', viewport.contentColumns))),
  )
}

/**
 * The ask_user_question bar: walks one request question by question,
 * renders the option menu (Claude-Code style: arrows move, space toggles a
 * multi-select, enter submits, `c` opens the custom-answer box, Esc
 * interrupts the question as aborted). Plan reviews arrive through the same
 * service with a `plan-review` intent — the approve option gets a ✓ mark,
 * the answer encoding stays identical.
 */
function QuestionBar({ store, snapshot, locked }: { store: QuestionStore; snapshot: QuestionSnapshot; locked: boolean }): ReactElement | undefined {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const pending = snapshot.pending
  const request = pending?.request
  const [index, setIndex] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState<readonly number[]>([])
  const [mode, setMode] = useState<'options' | 'custom'>('options')
  const [custom, setCustom] = useState('')
  const [answers, setAnswers] = useState<readonly AskUserQuestionAnswerItem[]>([])
  const [submitted, setSubmitted] = useState(false)
  const [scroll, setScroll] = useState(0)
  const [manualScroll, setManualScroll] = useState(false)
  const [followCustomTail, setFollowCustomTail] = useState(false)

  // A new request resets the walk; questions without options start in the
  // custom-answer box (a free-form question). Depend on the request rather
  // than its wrapper snapshot: external stores may refresh that wrapper while
  // a question is still active, and a reset must never become a render loop.
  useEffect(() => {
    const first = request?.questions[0]
    const initialMode = first?.options === undefined || first.options.length === 0 ? 'custom' : 'options'
    setIndex(current => current === 0 ? current : 0)
    setCursor(current => current === 0 ? current : 0)
    setSelected(current => current.length === 0 ? current : [])
    setMode(current => current === initialMode ? current : initialMode)
    setCustom(current => current === '' ? current : '')
    setAnswers(current => current.length === 0 ? current : [])
    setSubmitted(current => current ? false : current)
    setScroll(current => current === 0 ? current : 0)
    setManualScroll(current => current ? false : current)
    setFollowCustomTail(current => current === (initialMode === 'custom') ? current : initialMode === 'custom')
  }, [request])

  const question = pending?.request.questions[index]
  const options = question?.options ?? []
  const isPlan = question?.intent?.kind === 'plan-review'
  const isMulti = question?.multiSelect === true
  const active = !locked && pending !== undefined && question !== undefined && !submitted
  const rendered = useMemo(() => {
    if (question === undefined) return { lines: [] as readonly StyledLine[], optionRows: [] as readonly number[] }
    const lines: StyledLine[] = []
    const optionRows: number[] = []
    if (question.header !== undefined) {
      lines.push(...styledLines([lineSegment(question.header, 'bold')], viewport.contentColumns))
    }
    lines.push(...textLines(question.question, viewport.contentColumns))
    if (question.detail !== undefined) {
      lines.push(...(isPlan
        ? markdownLines(question.detail, viewport.contentColumns)
        : textLines(question.detail, viewport.contentColumns, 'dim')))
    }
    if (submitted) {
      lines.push(...textLines('  submitted…', viewport.contentColumns, 'dim'))
    } else if (mode === 'custom' || options.length === 0) {
      lines.push(...styledLines([
        lineSegment('  custom: ', 'brand'),
        lineSegment(custom, 'plain'),
        lineSegment('▌', 'brand'),
      ], viewport.contentColumns))
    } else {
      options.forEach((option, at) => {
        optionRows.push(lines.length)
        const chosen = isMulti && selected.includes(at)
        const approve = isPlan && question.intent?.approve === option.label
        const mark = approve ? '✓ ' : chosen ? '◉ ' : at === cursor ? '❯ ' : '  '
        const style: LineStyle = at === cursor ? 'brand' : chosen || approve ? 'success' : 'plain'
        lines.push(...styledLines([
          lineSegment(mark, style),
          lineSegment(option.label, style),
          lineSegment(option.description === undefined ? '' : ` — ${option.description}`, 'dim'),
        ], viewport.contentColumns))
      })
    }
    return { lines, optionRows }
  }, [question, isPlan, submitted, mode, options, custom, isMulti, selected, cursor, viewport.contentColumns])
  // Keeping a focused option visible is derived from the current render. It
  // deliberately does not write state from an effect: keyboard selection
  // then has one update path, rather than a cursor update repeatedly causing
  // a post-render scroll update (and, under rapid input, an update-depth
  // loop). Page scrolling explicitly takes ownership until focus moves again.
  const focusedRow = rendered.optionRows[cursor] ?? 0
  const automaticScroll = mode === 'options' && options.length > 0 && !manualScroll
    ? revealRow(scroll, focusedRow, rendered.lines.length, viewport.bodyRows)
    : (mode === 'custom' || options.length === 0) && followCustomTail
      ? Math.max(0, rendered.lines.length - viewport.bodyRows)
      : scroll
  const visibleScroll = clampScroll(automaticScroll, rendered.lines.length, viewport.bodyRows)

  const commit = (answer: AskUserQuestionAnswerItem): void => {
    if (pending === undefined) return
    const next = [...answers, answer]
    const total = pending.request.questions.length
    if (index + 1 >= total) {
      setSubmitted(true)
      store.submit(pending, { answers: next })
      return
    }
    setAnswers(next)
    const nextIndex = index + 1
    const nextQuestion = pending.request.questions[nextIndex]
    setIndex(nextIndex)
    setCursor(0)
    setSelected([])
    setMode(nextQuestion?.options === undefined || nextQuestion.options.length === 0 ? 'custom' : 'options')
    setCustom('')
    setScroll(0)
    setManualScroll(false)
    setFollowCustomTail(nextQuestion?.options === undefined || nextQuestion.options.length === 0)
  }

  const commitOption = (): void => {
    if (pending === undefined || question === undefined) return
    if (isMulti) {
      const labels = selected
        .map(at => options[at]?.label)
        .filter((label): label is string => label !== undefined)
      const customText = custom.trim()
      commit({ id: question.id, selected: labels, ...(customText === '' ? {} : { custom: customText }) })
      return
    }
    const option = options[cursor]
    if (option === undefined) return
    commit({ id: question.id, selected: [option.label] })
  }

  /**
   * A question with choices has two local focus surfaces, just like Codex:
   * the choice list and the optional custom-answer editor. Returning to the
   * list keeps the user's current choice (and multi-select state), but drops
   * the transient custom draft so a second Escape can cancel the question.
   */
  const returnToOptions = (): void => {
    if (options.length === 0) return
    setMode('options')
    setCustom('')
    setScroll(0)
    setManualScroll(false)
    setFollowCustomTail(false)
  }

  useStableInput((input, key) => {
    if (pending === undefined || question === undefined || submitted) return
    if (key.escape) {
      if (mode === 'custom' && options.length > 0) {
        returnToOptions()
        return
      }
      store.cancel(pending)
      return
    }
    if (key.pageUp) {
      setManualScroll(true)
      setFollowCustomTail(false)
      setScroll(moveScroll(visibleScroll, -Math.max(1, viewport.bodyRows - 1), rendered.lines.length, viewport.bodyRows))
      return
    }
    if (key.pageDown) {
      setManualScroll(true)
      setFollowCustomTail(false)
      setScroll(moveScroll(visibleScroll, Math.max(1, viewport.bodyRows - 1), rendered.lines.length, viewport.bodyRows))
      return
    }
    if (mode === 'custom' || options.length === 0) {
      if (key.tab && options.length > 0) {
        returnToOptions()
        return
      }
      if (key.upArrow) {
        setFollowCustomTail(false)
        setScroll(moveScroll(visibleScroll, -1, rendered.lines.length, viewport.bodyRows))
        return
      }
      if (key.downArrow) {
        setFollowCustomTail(false)
        setScroll(moveScroll(visibleScroll, 1, rendered.lines.length, viewport.bodyRows))
        return
      }
      if (key.return) {
        if (custom.trim() === '' && options.length > 0) {
          commitOption()
          return
        }
        commit({
          id: question.id,
          selected: isMulti
            ? selected.map(at => options[at]?.label).filter((label): label is string => label !== undefined)
            : [],
          ...(custom.trim() === '' ? {} : { custom: custom.trim() }),
        })
        return
      }
      if (key.backspace || key.delete) {
        if (custom === '' && options.length > 0) {
          returnToOptions()
          return
        }
        setCustom(current => current.slice(0, -1))
        return
      }
      if (input !== '' && !key.ctrl && !key.meta) {
        setCustom(current => current + input)
      }
      return
    }
    if (key.upArrow) {
      setManualScroll(false)
      setCursor(current => (current + options.length - 1) % options.length)
      return
    }
    if (key.downArrow) {
      setManualScroll(false)
      setCursor(current => (current + 1) % options.length)
      return
    }
    if (key.return) {
      commitOption()
      return
    }
    if (key.tab || input === 'c' || input === 'C') {
      setMode('custom')
      setManualScroll(false)
      setFollowCustomTail(true)
      return
    }
    if (input === ' ' && isMulti) {
      setSelected(current => current.includes(cursor) ? current.filter(at => at !== cursor) : [...current, cursor])
    }
  }, active)

  if (pending === undefined || question === undefined) return undefined
  if (viewport.maxHeight === 0) return createElement(Box, { display: 'none' })
  if (viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(isPlan ? 'plan review · esc cancel' : 'question · esc cancel', viewport.contentColumns))
  }
  const footer = submitted
    ? 'submitted…'
    : mode === 'custom'
      ? options.length === 0
        ? '↑↓/pgup/pgdn scroll · type answer · enter submit · esc interrupt'
        : '↑↓/pgup/pgdn scroll · type answer · enter submit · tab/esc or empty backspace: options'
      : options.length === 0
        ? '↑↓/pgup/pgdn scroll · type answer · enter submit · esc interrupt'
      : isMulti
        ? '↑↓ choose · pgup/pgdn scroll · space toggle · enter submit · c custom · esc interrupt'
        : '↑↓ choose · pgup/pgdn scroll · enter submit · c custom · esc interrupt'
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(isPlan ? TUI_RGB.brand : TUI_RGB.brandDeep) },
    createElement(
      Text,
      { color: inkColor(isPlan ? TUI_RGB.brand : TUI_RGB.brandDeep), bold: true, wrap: 'truncate-end' },
      truncateColumns(`${isPlan ? '📋 plan review' : '❓ question'} ${index + 1}/${pending.request.questions.length} · lines ${rendered.lines.length === 0 ? 0 : visibleScroll + 1}-${Math.min(rendered.lines.length, visibleScroll + viewport.bodyRows)}/${rendered.lines.length}`, viewport.contentColumns),
    ),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(StyledRows, { lines: rendered.lines.slice(visibleScroll, visibleScroll + viewport.bodyRows) }),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, dim(truncateColumns(footer, viewport.contentColumns))),
  )
}

/** The /model panel: a scrolling list over the advisory model directory. */
function ModelPanel({ directory, error, onSelect, onRetry, onClose }: {
  directory: ModelDirectory | undefined
  error: string | undefined
  onSelect(row: ModelRow): void
  onRetry(): void
  onClose(): void
}): ReactElement {
  const [cursor, setCursor] = useState(0)
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const rows = directory?.rows ?? []

  useEffect(() => {
    if (rows.length === 0) {
      if (cursor !== 0) setCursor(0)
      return
    }
    if (cursor >= rows.length) setCursor(rows.length - 1)
  }, [rows.length, cursor])

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose()
      return
    }
    if (input === 'r') {
      onRetry()
      return
    }
    if (rows.length === 0) return
    if (key.upArrow) {
      setCursor(cursor > 0 ? cursor - 1 : rows.length - 1)
      return
    }
    if (key.downArrow) {
      setCursor(cursor < rows.length - 1 ? cursor + 1 : 0)
      return
    }
    if (key.pageUp) {
      setCursor(current => Math.max(0, current - Math.max(1, viewport.bodyRows - 1)))
      return
    }
    if (key.pageDown) {
      setCursor(current => Math.min(rows.length - 1, current + Math.max(1, viewport.bodyRows - 1)))
      return
    }
    if (input === 'g') {
      setCursor(0)
      return
    }
    if (input === 'G') {
      setCursor(rows.length - 1)
      return
    }
    if (key.return && rows[cursor] !== undefined) {
      onSelect(rows[cursor])
    }
  })

  if (viewport.maxHeight === 0) return createElement(Box, { display: 'none' })
  if (viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns('/model · r retry · esc/q close', viewport.contentColumns))
  }

  const stateRows: ReactElement[] = directory === undefined && error === undefined
    ? [createElement(Text, { key: 'loading', dimColor: true, wrap: 'truncate-end' }, '  loading models…')]
    : error !== undefined
      ? [createElement(
        Text,
        { key: 'error', color: inkColor(TUI_RGB.error), wrap: 'truncate-end' },
        truncateColumns(`  ${singleLineText(error)}`, viewport.contentColumns),
      )]
      : [
        ...(directory?.failures.length === 0
          ? []
          : [createElement(
            Text,
            { key: 'failures', color: inkColor(TUI_RGB.warn), wrap: 'truncate-end' },
            truncateColumns(`  unavailable providers: ${directory?.failures.join(', ')}`, viewport.contentColumns),
          )]),
        ...(rows.length === 0
          ? [createElement(Text, { key: 'empty', dimColor: true, wrap: 'truncate-end' }, '  no models available')]
          : []),
      ]
  // Measurement and rendering share the same physical-row budget: state
  // messages consume body rows before selectable entries, as in Codex's
  // list-selection views.
  const rowBudget = Math.max(0, viewport.bodyRows - stateRows.length)
  const first = selectionWindow(cursor, rows.length, rowBudget)
  const visible = rowBudget === 0 ? [] : rows.slice(first, first + rowBudget)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(TUI_RGB.brand) },
    createElement(Text, { color: inkColor(TUI_RGB.brand), bold: true, wrap: 'truncate-end' }, truncateColumns(`/model — select model${rows.length === 0 ? '' : ` · ${cursor + 1}/${rows.length}`}`, viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...stateRows,
    ...visible.map((row) => {
      const index = rows.indexOf(row)
      const label = displayText(`${row.providerName} · ${row.modelName}`)
      return createElement(
        Text,
        {
          key: `${row.provider}/${row.model}`,
          color: index === cursor ? inkColor(TUI_RGB.brandBright) : inkColor(TUI_RGB.dim),
          wrap: 'truncate-end',
        },
        truncateColumns(`${index === cursor ? '❯ ' : '  '}${label}`, viewport.contentColumns),
      )
    }),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, dim(truncateColumns('↑↓ move · pgup/pgdn page · g/G ends · enter select · r retry · esc/q close', viewport.contentColumns))),
  )
}

/**
 * The /help overlay: one scrolling card with the keyboard map, the TUI-local
 * commands, the live registry commands, and the user-invocable skills — the
 * real command surface, replacing the one-line notice.
 */
function HelpPanel({ descriptors, skills, commandError, skillError, onClose }: {
  descriptors: readonly CommandDescriptor[]
  skills: readonly SkillRow[]
  commandError: string | undefined
  skillError: string | undefined
  onClose(): void
}): ReactElement {
  const stdout = useStdout().stdout
  const columns = stdout?.columns ?? 80
  const viewport = panelViewport(columns, stdout?.rows ?? 30)
  const [scroll, setScroll] = useState(0)
  const nameWidth = Math.min(18, Math.max(1, viewport.contentColumns - 2))
  const descBudget = Math.max(0, viewport.contentColumns - nameWidth - 2)
  const row = (label: string, description: string): ReactElement => createElement(
    Text,
    { dimColor: true, wrap: 'truncate-end' },
    `  ${padColumns(label, nameWidth)}${dim(truncateColumns(displayText(description), descBudget))}`,
  )
  const content: ReactElement[] = [
    createElement(Text, { key: 'keys-title', bold: true, wrap: 'truncate-end' }, ' keys'),
    createElement(Text, { key: 'key-submit', dimColor: true, wrap: 'truncate-end' }, '  enter submit · alt+enter / ctrl+j newline · up/down history · tab complete'),
    createElement(Text, { key: 'key-mentions', dimColor: true, wrap: 'truncate-end' }, '  tab also completes bare workspace paths · @ mentions files and sessions'),
    createElement(Text, { key: 'key-inspector', dimColor: true, wrap: 'truncate-end' }, '  ctrl+o history details · ctrl+r thinking · shift+tab permission preset'),
    createElement(Text, { key: 'key-cancel', dimColor: true, wrap: 'truncate-end' }, '  esc interrupt the running turn · ctrl+c cancel / clear / quit · ctrl+d exit'),
    createElement(Text, { key: 'key-edit', dimColor: true, wrap: 'truncate-end' }, '  ctrl+k cut to end of line · ctrl+u clear line · ctrl+a / ctrl+e line ends'),
    createElement(Text, { key: 'commands-gap' }, ' '),
    createElement(Text, { key: 'commands-title', bold: true, wrap: 'truncate-end' }, ' commands'),
    ...(commandError === undefined
      ? []
      : [createElement(
        Text,
        { key: 'commands-error', color: inkColor(TUI_RGB.error), wrap: 'truncate-end' },
        truncateColumns(`  command catalog unavailable: ${singleLineText(commandError)}`, viewport.contentColumns),
      )]),
    createElement(Box, { key: 'local-help' }, row('/help', 'show this overlay')),
    createElement(Box, { key: 'local-model' }, row('/model', 'switch the model')),
    createElement(Box, { key: 'local-mode' }, row('/mode', 'inspect or select the agent preset (/mode [preset])')),
    createElement(Box, { key: 'local-new' }, row('/new', 'create and switch to a fresh session (/new [preset])')),
    createElement(Box, { key: 'local-resume' }, row('/resume', 'browse or switch root sessions (/resume [id|prefix])')),
    createElement(Box, { key: 'local-plugin' }, row('/plugin', 'inspect the live plugin composition')),
    createElement(Box, { key: 'local-statusline' }, row('/statusline', 'customize the status line items')),
    createElement(Box, { key: 'local-clear' }, row('/clear', 'clear the screen')),
    createElement(Box, { key: 'local-export' }, row('/export', 'export the transcript to markdown (/export [path])')),
    createElement(Box, { key: 'local-title' }, row('/title', 'rename this session (/title <text>)')),
    createElement(Box, { key: 'local-quit' }, row('/quit', 'exit')),
    ...descriptors.map(descriptor => createElement(
      Text,
      { key: `command-${descriptor.name}`, dimColor: true, wrap: 'truncate-end' },
      `  ${padColumns(`/${descriptor.name}`, nameWidth)}${dim(truncateColumns(displayText(descriptor.description), descBudget))}`,
    )),
    ...(skills.length === 0 && skillError === undefined
      ? []
      : [
          createElement(Text, { key: 'skills-gap' }, ' '),
          createElement(Text, { key: 'skills-title', bold: true, wrap: 'truncate-end' }, ' skills'),
        ]),
    ...(skillError === undefined
      ? []
      : [createElement(
        Text,
        { key: 'skills-error', color: inkColor(TUI_RGB.error), wrap: 'truncate-end' },
        truncateColumns(`  skill catalog unavailable: ${singleLineText(skillError)}`, viewport.contentColumns),
      )]),
    ...skills.map(skill => createElement(
      Text,
      { key: `skill-${skill.name}`, dimColor: true, wrap: 'truncate-end' },
      `  ${padColumns(`/${skill.name}`, nameWidth)}${dim(truncateColumns(displayText(skill.description), descBudget))}`,
    )),
  ]
  const visibleScroll = clampScroll(scroll, content.length, viewport.bodyRows)
  const scrollBy = (delta: number): void => {
    setScroll(current => moveScroll(current, delta, content.length, viewport.bodyRows))
  }

  useEffect(() => {
    if (visibleScroll !== scroll) setScroll(visibleScroll)
  }, [visibleScroll, scroll])

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose()
      return
    }
    if (key.upArrow) scrollBy(-1)
    else if (key.downArrow) scrollBy(1)
    else if (key.pageUp) scrollBy(-Math.max(1, viewport.bodyRows - 1))
    else if (key.pageDown) scrollBy(Math.max(1, viewport.bodyRows - 1))
    else if (input === 'g') setScroll(0)
    else if (input === 'G') setScroll(Math.max(0, content.length - viewport.bodyRows))
  })

  if (viewport.maxHeight === 0) return createElement(Box, { display: 'none' })
  if (viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns('/help · esc/q close', viewport.contentColumns))
  }

  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(TUI_RGB.brand) },
    createElement(Text, { color: inkColor(TUI_RGB.brand), bold: true, wrap: 'truncate-end' }, truncateColumns(`/help — keys and commands · rows ${content.length === 0 ? 0 : visibleScroll + 1}-${Math.min(content.length, visibleScroll + viewport.bodyRows)}/${content.length}`, viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...content.slice(visibleScroll, visibleScroll + viewport.bodyRows),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, dim(truncateColumns('↑↓ scroll · pgup/pgdn page · g/G ends · esc/q close', viewport.contentColumns))),
  )
}

/** Collapse arbitrary metadata to one terminal row before verbose rendering. */
function verboseLine(text: string, columns: number): string {
  return truncateColumns(displayText(text).replace(/\n/gu, ' ↵ ').replace(/\t/gu, '  '), Math.max(1, columns))
}

/** One-row editor window keeping the logical cursor visible in long drafts. */
function editorWindow(value: string, cursor: number, columns: number): { before: string; caret: string; after: string } {
  const width = Math.max(1, columns)
  const normalize = (text: string): string => displayText(text).replace(/\n/gu, '↵').replace(/\t/gu, '  ')
  const caretSource = value.slice(cursor, cursor + 1)
  const caret = caretSource === '' ? ' ' : normalize(caretSource)
  const remaining = Math.max(0, width - visibleColumns(caret))
  const afterBudget = Math.min(Math.floor(remaining / 3), visibleColumns(normalize(value.slice(cursor + 1))))
  const beforeBudget = Math.max(0, remaining - afterBudget)
  const before = beforeBudget === 0
    ? ''
    : displayTail(normalize(value.slice(0, cursor)), beforeBudget, 1).text
  const after = afterBudget === 0
    ? ''
    : truncateColumns(normalize(value.slice(cursor + 1)), afterBudget)
  return { before, caret, after }
}

/**
 * The Ctrl+O transcript inspector: one selected durable entry at a time,
 * with independent history selection and content scrolling. The complete
 * retained entry is converted to physical rows, but only one viewport slice
 * reaches Ink, so even a huge reasoning block cannot grow the dynamic tree.
 */
function VerbosePanel({ entries, onClose }: { entries: readonly TranscriptEntry[]; onClose(): void }): ReactElement {
  const stdout = useStdout().stdout
  const columns = stdout?.columns ?? 80
  const rows = stdout?.rows ?? 30
  const viewport = inspectorViewport(columns, rows)
  const [cursor, setCursor] = useState(() => Math.max(0, entries.length - 1))
  const [scroll, setScroll] = useState(0)
  const savedScroll = useRef(new Map<number, number>())
  const cursorRef = useRef(cursor)
  const previousLength = useRef(entries.length)
  const entry = entries[cursor]
  const allLines = useMemo(
    () => entry === undefined ? [] : transcriptEntryLines(entry, viewport.contentColumns),
    [entry, viewport.contentColumns],
  )
  const visibleScroll = clampScroll(scroll, allLines.length, viewport.bodyRows)

  useEffect(() => {
    cursorRef.current = cursor
  }, [cursor])

  useEffect(() => {
    const current = cursorRef.current
    const next = followInspectorCursor(current, previousLength.current, entries.length)
    if (next !== current) {
      savedScroll.current.set(current, visibleScroll)
      setCursor(next)
      setScroll(savedScroll.current.get(next) ?? 0)
    }
    previousLength.current = entries.length
  }, [entries.length])

  useEffect(() => {
    const clamped = clampScroll(scroll, allLines.length, viewport.bodyRows)
    if (clamped !== scroll) setScroll(clamped)
    savedScroll.current.set(cursor, clamped)
  }, [cursor, scroll, allLines.length, viewport.bodyRows])

  const selectEntry = (next: number): void => {
    if (entries.length === 0) return
    const selected = Math.max(0, Math.min(entries.length - 1, next))
    if (selected === cursor) return
    savedScroll.current.set(cursor, visibleScroll)
    setCursor(selected)
    setScroll(savedScroll.current.get(selected) ?? 0)
  }

  const scrollBy = (delta: number): void => {
    setScroll(current => moveScroll(current, delta, allLines.length, viewport.bodyRows))
  }

  useInput((input, key) => {
    if (key.escape || input === 'q' || (key.ctrl && input === 'o')) {
      onClose()
      return
    }
    if (entries.length === 0) return
    if (key.leftArrow) {
      selectEntry(cursor - 1)
      return
    }
    if (key.rightArrow) {
      selectEntry(cursor + 1)
      return
    }
    if (key.upArrow) {
      scrollBy(-1)
      return
    }
    if (key.downArrow) {
      scrollBy(1)
      return
    }
    if (key.pageUp) {
      scrollBy(-Math.max(1, viewport.bodyRows - 1))
      return
    }
    if (key.pageDown) {
      scrollBy(Math.max(1, viewport.bodyRows - 1))
      return
    }
    if (input === 'g') {
      setScroll(0)
      return
    }
    if (input === 'G') {
      setScroll(Math.max(0, allLines.length - viewport.bodyRows))
    }
  })

  if (viewport.maxHeight === 0) return createElement(Box, { display: 'none' })
  if (viewport.compact) {
    return createElement(
      Text,
      { wrap: 'truncate-end' },
      truncateColumns('history details · ctrl+o / esc / q close', viewport.contentColumns),
    )
  }

  const title = entries.length === 0
    ? 'history details · empty'
    : `history details · entry ${cursor + 1}/${entries.length} · lines ${allLines.length === 0 ? 0 : visibleScroll + 1}-${Math.min(allLines.length, visibleScroll + viewport.bodyRows)}/${allLines.length}`
  const visible = allLines.slice(visibleScroll, visibleScroll + viewport.bodyRows)
  return createElement(
    Box,
    {
      flexDirection: 'column',
      width: viewport.outerColumns,
      paddingX: 1,
      borderStyle: 'round',
      borderColor: inkColor(TUI_RGB.brand),
    },
    createElement(
      Text,
      { color: inkColor(TUI_RGB.brand), bold: true, wrap: 'truncate-end' },
      truncateColumns(title, viewport.contentColumns),
    ),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(
      Box,
      { flexDirection: 'column' },
      entry === undefined
        ? createElement(Text, { dimColor: true }, '  no durable entries yet')
        : createElement(StyledRows, { lines: visible }),
    ),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(
      Text,
      { dimColor: true, wrap: 'truncate-end' },
      dim(truncateColumns('←→ entry · ↑↓ scroll · pgup/pgdn page · g/G ends · ctrl+o/esc/q close', viewport.contentColumns)),
    ),
  )
}

/** Streaming chunks preserve `entries` identity, so the open inspector stays inert. */
const MemoVerbosePanel = memo(VerbosePanel)

/** Stable append-only boundary: modal updates must never revisit Static rows. */
function staticRow(item: unknown): ReactElement {
  return item as ReactElement
}

function StaticTranscript({ items }: { items: ReactElement[] }): ReactElement {
  return createElement(Static, { items, children: staticRow })
}

const MemoStaticTranscript = memo(StaticTranscript)

/** One completion candidate row. */
interface CompletionCandidate {
  /** Insertion text for the command name (with leading slash). */
  label: string
  /** Human-readable description shown beside the label. */
  description: string
  /** Candidate origin; skills land the same literal text but route through the prompt. */
  origin: 'command' | 'skill' | 'mention' | 'path'
}

/**
 * Resolve completion candidates for the current input: TUI-local commands,
 * the live registry descriptors, and user-invocable skills, filtered by the
 * typed prefix. Command names win collisions (the dispatch tries the
 * registry first and only then falls through to the skill gesture).
 */
function completionCandidates(
  value: string,
  descriptors: readonly CommandDescriptor[],
  skills: readonly SkillRow[],
): readonly CompletionCandidate[] {
  if (!value.startsWith('/')) return []
  const prefix = value.slice(1).split(' ')[0] ?? ''
  const local: CompletionCandidate[] = [
    { label: '/help', description: 'show commands', origin: 'command' },
    { label: '/model', description: 'switch the model', origin: 'command' },
    { label: '/mode', description: 'select the agent preset', origin: 'command' },
    { label: '/new', description: 'start a fresh session', origin: 'command' },
    { label: '/resume', description: 'browse or switch sessions', origin: 'command' },
    { label: '/plugin', description: 'inspect the plugin composition', origin: 'command' },
    { label: '/statusline', description: 'customize the status line', origin: 'command' },
    { label: '/clear', description: 'clear the screen', origin: 'command' },
    { label: '/export', description: 'export the transcript to markdown', origin: 'command' },
    { label: '/title', description: 'rename this session', origin: 'command' },
    { label: '/quit', description: 'exit', origin: 'command' },
  ]
  // Local commands shadow registry names (e.g. the plugin-registered
  // /permission is served by the registry itself, never duplicated here),
  // so collisions cannot render two rows with the same key.
  const localNames = new Set(local.map(candidate => candidate.label.slice(1)))
  const registry = descriptors
    .filter(descriptor => !localNames.has(descriptor.name))
    .map((descriptor): CompletionCandidate => ({
      label: `/${descriptor.name}`,
      description: descriptor.description,
      origin: 'command',
    }))
  const taken = new Set([...local, ...registry].map(candidate => candidate.label.slice(1)))
  const skillRows = skills
    .filter(skill => !taken.has(skill.name))
    .map((skill): CompletionCandidate => ({
      label: `/${skill.name}`,
      description: skill.modelInvocable ? `skill · ${skill.description}` : `skill (user only) · ${skill.description}`,
      origin: 'skill',
    }))
  const all = [...local, ...registry, ...skillRows]
  // The menu itself caps its visible rows behind a scroll window, so the
  // candidate cap only bounds how many entries cycling can reach; 11 keeps
  // every TUI-local command reachable with an empty prefix.
  if (prefix === '') return all.slice(0, 11)
  return all.filter(candidate => candidate.label.slice(1).startsWith(prefix)).slice(0, 11)
}

/**
 * The completion menu, rendered inside the composer's subtree directly above
 * the framed box — attached the way Claude-Code anchors its dropdown. Opening
 * it grows the stack downward: the composer stays the last element on screen
 * and everything above (the flushed static transcript, the status line) never
 * moves. Props-only (no lifted state): the menu is a pure view of the input
 * editor's live completion state, so no cross-component effect ever resyncs
 * it (a state lift here previously deadlocked the menu after a resize).
 */
function CompletionMenu({ active, mention, index, rows }: {
  active: boolean
  mention: boolean
  index: number
  rows: readonly CompletionCandidate[]
}): ReactElement | undefined {
  // Hook order is unconditional: `active` toggling must not change the hook
  // count (the early return used to sit above useStdout).
  const stdout = useStdout().stdout
  const columns = stdout?.columns ?? 80
  const terminalRows = stdout?.rows ?? 30
  if (!active) return undefined
  const contentColumns = Math.max(1, columns - 4)
  const nameWidth = Math.min(18, Math.max(1, contentColumns - 2), Math.max(0, ...rows.map(row => visibleColumns(row.label))) + 2)
  const descBudget = Math.max(0, contentColumns - nameWidth - 2)
  const showFooter = terminalRows >= 12
  const spacious = terminalRows >= 14
  const verticalPadding = spacious ? 1 : 0
  const limit = Math.max(1, Math.min(6, terminalRows - (showFooter ? 11 : 10) - verticalPadding * 2))
  const selected = rows.length === 0 ? 0 : index % rows.length
  const first = selectionWindow(selected, rows.length, limit)
  const visible = rows.slice(first, first + limit)
  return createElement(
    Box,
    { flexDirection: 'column', marginLeft: 2, paddingY: verticalPadding },
    ...(rows.length === 0
      ? [createElement(Text, { key: 'loading', dimColor: true }, 'searching…')]
      : visible.map((candidate, at) => {
        const absolute = first + at
        return createElement(
        Text,
        {
          key: candidate.label,
          color: absolute === selected ? inkColor(TUI_RGB.brandBright) : inkColor(TUI_RGB.dim),
          wrap: 'truncate-end',
        },
        `${absolute === selected ? '❯ ' : '  '}${padColumns(candidate.label, nameWidth)}${dim(truncateColumns(displayText(candidate.description), descBudget))}`,
        )
      })),
    showFooter ? createElement(Text, { dimColor: true, wrap: 'truncate-end' }, dim(mention ? '↑↓ choose · tab insert' : '↑↓ choose · tab complete')) : undefined,
  )
}

/**
 * The prompt box: TUI-local slash commands handled locally, other lines
 * dispatched; input editing keeps a cursor with history and completion.
 * While a modal (approval / question / model panel) owns the keys, the
 * box passes every key through untouched.
 */
function Input({ active, frozen, busy, descriptors, skills, dispatch, steer, interrupt, quit, openModel, openHelp, openMode, openResume, openPlugin, openStatusline, createSession, cancelSessionSwitch, notify, hasNotice, dismissNotice, toggleReasoning, openVerbose, clearView, refresh, loadMentions, cyclePermission, exportTranscript, renameTitle }: {
  active: boolean
  frozen: boolean
  busy: boolean
  descriptors: readonly CommandDescriptor[]
  skills: readonly SkillRow[]
  dispatch(text: string): void
  steer(text: string): void
  interrupt(): boolean
  quit(): void
  openModel(): void
  openHelp(): void
  openMode(): void
  openResume(): void
  openPlugin(query?: string): void
  openStatusline(): void
  createSession(mode?: string): void
  cancelSessionSwitch(): boolean
  notify(text: string, tone?: NoticeTone): void
  hasNotice: boolean
  dismissNotice(): void
  toggleReasoning(): void
  openVerbose(): void
  clearView(): void
  refresh(): void
  loadMentions(query: string, signal?: AbortSignal): Promise<readonly MentionCandidate[]>
  cyclePermission(): string
  exportTranscript(argument: string): Promise<void>
  renameTitle(argument: string): string
}): ReactElement {
  const columns = useStdout().stdout?.columns ?? 80
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const history = useRef<readonly string[]>([])
  const historyIndex = useRef<number | null>(null)
  const draft = useRef('')
  const [completionIndex, setCompletionIndex] = useState(0)
  const [dismissedMenuValue, setDismissedMenuValue] = useState<string | undefined>(undefined)
  const candidates = completionCandidates(value, descriptors, skills)
  const slashActive = candidates.length > 0 && value.startsWith('/') && !value.includes(' ') && !value.includes('\n')

  // @mention token: the last `@word` on the cursor's line before the cursor.
  const beforeCursor = value.slice(0, cursor)
  const lastLine = beforeCursor.split('\n').at(-1) ?? ''
  const tokenMatch = /(^|\s)@([^\s]*)$/u.exec(lastLine)
  const mentionToken = tokenMatch === null
    ? undefined
    : { start: beforeCursor.length - lastLine.length + (tokenMatch.index ?? 0) + (tokenMatch[1]?.length ?? 0), query: tokenMatch[2] ?? '' }
  const mentionActive = mentionToken !== undefined
  const [mentionRows, setMentionRows] = useState<readonly MentionCandidate[]>([])

  // Bare path token: the last whitespace-delimited run on the cursor's line
  // when it already looks like a path (Claude-Code bare Tab completion). A
  // LEADING '/' is the command namespace, never a path — without this guard
  // typing the bare '/' hijacked the menu into the workspace file scan and
  // the slash-command candidates never appeared.
  const bareTokenMatch = /([^\s]+)$/u.exec(lastLine)
  const bareToken = bareTokenMatch === null ? '' : bareTokenMatch[1] ?? ''
  const pathActive = !mentionActive
    && !bareToken.startsWith('/')
    && (bareToken.includes('/') || bareToken === '.' || bareToken === '..')
  const pathTokenStart = beforeCursor.length - bareToken.length
  const [pathRows, setPathRows] = useState<readonly MentionCandidate[]>([])

  useEffect(() => {
    if (!active || !pathActive) {
      setPathRows([])
      return
    }
    const controller = new AbortController()
    setPathRows([])
    loadMentions(bareToken, controller.signal).then(
      rows => setPathRows(rows.filter(row => row.kind !== 'session')),
      () => {},
    )
    return () => {
      controller.abort()
    }
  }, [active, pathActive, bareToken])

  useEffect(() => {
    if (!active || !mentionActive) {
      setMentionRows([])
      return
    }
    const controller = new AbortController()
    setMentionRows([])
    loadMentions(mentionToken.query, controller.signal).then(
      rows => setMentionRows(rows),
      () => {},
    )
    return () => {
      controller.abort()
    }
  }, [active, mentionActive, mentionToken?.query])

  // Codex routes keys to the topmost surface first. Completion therefore
  // remains available while a turn runs, and Esc dismisses it before the
  // same key is allowed to interrupt the turn.
  const menuActive = (slashActive || mentionActive || pathActive) && dismissedMenuValue !== value
  const menuRows: readonly CompletionCandidate[] = mentionActive
    ? mentionRows.map(row => ({
      label: row.label.startsWith('@')
        ? row.label
        : `@${row.label}${row.kind === 'directory' ? '/' : ''}`,
      description: row.description,
      origin: 'mention',
    }))
    : pathActive
      ? pathRows.map(row => ({
        label: row.label,
        description: row.description,
        origin: 'path',
      }))
      : candidates

  useInput((input, key) => {
    // Modal ownership: approval/question/model dialogs consume all keys.
    if (!active) return
    // Shift+Tab cycles the permission preset (Claude-Code convention).
    if (key.tab && key.shift) {
      try {
        const next = cyclePermission()
        if (next !== '') notify(`permission → ${next}`)
      } catch (error: unknown) {
        notify(`permission change failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      }
      return
    }
    // Ctrl+R toggles the thinking display (Claude-Code reasoning fold).
    if (key.ctrl && input === 'r') {
      toggleReasoning()
      return
    }
    // Ctrl+O opens the bounded transcript inspector (Claude-Code convention,
    // adapted to append-only static rows): one history entry at a time with
    // tool cards and reasoning expanded, Esc returns.
    if (key.ctrl && input === 'o') {
      openVerbose()
      return
    }
    // Ctrl+C is three-state (community-TUI convention): a running turn is
    // cancelled, a non-empty draft is cleared, and only an idle empty input
    // exits. Ctrl+D always means exit but refuses mid-turn.
    if (key.ctrl && input === 'c') {
      if (busy) {
        interrupt()
      } else if (value !== '') {
        setValue('')
        setCursor(0)
        setCompletionIndex(0)
        setDismissedMenuValue(undefined)
      } else {
        quit()
      }
      return
    }
    if (key.ctrl && input === 'd') {
      if (busy) notify('cancel the running turn before exiting (Esc or Ctrl+C)', 'warning')
      else quit()
      return
    }
    if (key.escape) {
      if (menuActive) {
        setDismissedMenuValue(value)
        return
      }
      if (hasNotice) {
        dismissNotice()
        return
      }
      if (busy) interrupt()
      return
    }
    if (key.return) {
      // Multi-line editing: most terminals send the same byte for
      // shift+enter as enter, so newline insertion rides alt/meta+enter
      // and ctrl+j (the two distinguishable bindings); a bare return submits.
      if (key.meta || (key.ctrl && input === 'j')) {
        setValue(value.slice(0, cursor) + '\n' + value.slice(cursor))
        setCursor(cursor + 1)
        setDismissedMenuValue(undefined)
        return
      }
      const text = value.trim()
      setValue('')
      setCursor(0)
      setCompletionIndex(0)
      setDismissedMenuValue(undefined)
      if (text === '') return
      dismissNotice()
      history.current = [...history.current, text]
      historyIndex.current = null
      if (text === '/quit') {
        quit()
        return
      }
      if (text === '/help') {
        openHelp()
        return
      }
      if (text === '/clear') {
        // Clear the screen AND drop the folded view: the raw ANSI clear + a
        // Static remount (refresh) so the ledger stays in sync, then the
        // store resets so the rebuilt transcript starts empty.
        refresh()
        clearView()
        dismissNotice()
        return
      }
      if (text === '/export' || text.startsWith('/export ')) {
        void exportTranscript(text.slice(8))
        return
      }
      if (text === '/title' || text.startsWith('/title ')) {
        const outcome = renameTitle(text.slice(7))
        const tone: NoticeTone = outcome.startsWith('rename failed:')
          ? 'error'
          : outcome.startsWith('usage:') || outcome.includes('unavailable')
            ? 'warning'
            : 'info'
        notify(outcome, tone)
        return
      }
      if (text === '/model' || text.startsWith('/model ')) {
        openModel()
        return
      }
      if (text === '/mode' || text.startsWith('/mode ')) {
        const mode = text.slice(5).trim()
        if (mode === '') openMode()
        else dispatch(text)
        return
      }
      if (text === '/resume cancel') {
        notify(cancelSessionSwitch() ? 'pending session switch cancelled' : 'no pending session switch', 'info')
        return
      }
      if (text === '/resume' || text.startsWith('/resume ')) {
        const id = text.slice(7).trim()
        if (id === '') openResume()
        else dispatch(text)
        return
      }
      if (text === '/new' || text.startsWith('/new ')) {
        createSession(text.slice(4).trim() || undefined)
        return
      }
      if (text === '/plugin' || text.startsWith('/plugin ')) {
        openPlugin(text.slice(7).trim())
        return
      }
      if (text === '/statusline') {
        openStatusline()
        return
      }
      if (busy && !text.startsWith('/')) {
        // A running turn is steered, not blocked: the inbox delivers this
        // text at the next step boundary (Esc/Ctrl+C still cancels outright).
        // Slash lines keep the registry path — commands run out of band.
        steer(text)
        return
      }
      dispatch(text)
      return
    }
    if (menuActive && key.upArrow) {
      setCompletionIndex(index => (index + menuRows.length - 1) % menuRows.length)
      return
    }
    if (menuActive && key.downArrow) {
      setCompletionIndex(index => (index + 1) % menuRows.length)
      return
    }
    if (key.upArrow) {
      const entries = history.current
      if (entries.length === 0) return
      const next = historyIndex.current === null ? entries.length - 1 : Math.max(0, historyIndex.current - 1)
      if (historyIndex.current === null) draft.current = value
      historyIndex.current = next
      setValue(entries[next] ?? '')
      setCursor((entries[next] ?? '').length)
      setDismissedMenuValue(undefined)
      return
    }
    if (key.downArrow) {
      const entries = history.current
      if (historyIndex.current === null) return
      const next = historyIndex.current + 1
      if (next >= entries.length) {
        historyIndex.current = null
        setValue(draft.current)
        setCursor(draft.current.length)
        setDismissedMenuValue(undefined)
        return
      }
      historyIndex.current = next
      setValue(entries[next] ?? '')
      setCursor((entries[next] ?? '').length)
      setDismissedMenuValue(undefined)
      return
    }
    if (key.tab && menuActive) {
      if (mentionActive && mentionToken !== undefined) {
        const row = mentionRows[completionIndex % mentionRows.length]
        if (row !== undefined) {
          // Session rows carry the canonical @[label](dsh-session:…) token;
          // file rows insert `@path` (directories keep their trailing slash).
          const insertion = row.label.startsWith('@')
            ? row.label
            : `@${row.label}${row.kind === 'directory' ? '/' : ''}`
          setValue(value.slice(0, mentionToken.start) + insertion + value.slice(cursor))
          setCursor(mentionToken.start + insertion.length)
        }
      } else if (pathActive) {
        const row = pathRows[completionIndex % Math.max(1, pathRows.length)]
        if (row !== undefined) {
          // Bare path completion replaces the typed token with the chosen
          // workspace path (directories keep their trailing slash).
          const insertion = row.kind === 'directory' ? `${row.label}/` : row.label
          setValue(value.slice(0, pathTokenStart) + insertion + value.slice(cursor))
          setCursor(pathTokenStart + insertion.length)
        }
      } else {
        const candidate = candidates[completionIndex % candidates.length]
        if (candidate !== undefined) {
          setValue(`${candidate.label} `)
          setCursor(candidate.label.length + 1)
        }
      }
      setCompletionIndex(0)
      setDismissedMenuValue(undefined)
      return
    }
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setValue(value.slice(0, cursor - 1) + value.slice(cursor))
        setCursor(cursor - 1)
        setCompletionIndex(0)
        setDismissedMenuValue(undefined)
      }
      return
    }
    if (key.leftArrow) {
      setCursor(Math.max(0, cursor - 1))
      return
    }
    if (key.rightArrow) {
      setCursor(Math.min(value.length, cursor + 1))
      return
    }
    if (key.ctrl && input === 'u') {
      setValue('')
      setCursor(0)
      setDismissedMenuValue(undefined)
      return
    }
    // Readline parity: Ctrl+K cuts from the cursor to the end of the line.
    if (key.ctrl && input === 'k') {
      setValue(value.slice(0, cursor))
      setDismissedMenuValue(undefined)
      return
    }
    // Ctrl+L refreshes the screen (readline convention): raw ANSI clear
    // plus a Static remount so the flushed transcript re-emits (a bare
    // console.clear() would desync Ink's ledger against the static rows).
    if (key.ctrl && input === 'l') {
      refresh()
      return
    }
    if (key.ctrl && input === 'a') {
      setCursor(0)
      return
    }
    if (key.ctrl && input === 'e') {
      setCursor(value.length)
      return
    }
    if (input !== '' && !key.ctrl && !key.meta) {
      setValue(value.slice(0, cursor) + input + value.slice(cursor))
      setCursor(cursor + input.length)
      setCompletionIndex(0)
      setDismissedMenuValue(undefined)
    }
  })

  // Every exclusive panel keeps the composer as a stable visual anchor, but
  // freezes it to one row: no menu, multiline wrap, or animation.
  if (frozen) {
    const frozen = value === ''
      ? 'type a message'
      : verboseLine(value, Math.max(1, columns - 6))
    return createElement(
      Box,
      { width: Math.max(1, columns - 1), borderStyle: 'round', borderColor: inkColor(TUI_RGB.dim), paddingX: 1 },
      createElement(
        Text,
        { wrap: 'truncate-end' },
        createElement(Text, { color: inkColor(TUI_RGB.brand) }, busy ? '… ' : '❯ '),
        frozen,
      ),
    )
  }

  const editor = editorWindow(value, cursor, Math.max(1, columns - 6))

  return createElement(
    Box,
    { flexDirection: 'column' },
    // The completion dropdown rides directly above the box (Claude-Code
    // anchor): rendered from the editor's own live state, never lifted.
    createElement(CompletionMenu, {
      active: menuActive,
      mention: mentionActive,
      index: completionIndex,
      rows: menuRows,
    }),
    // The framed input box: a visible boundary so the prompt never blends
    // into the transcript above it; the cursor block sits immediately after
    // the prompt marker (leftmost), with the dim placeholder trailing it —
    // no extra space, so the empty state reads `❯ ▮type a message…`.
    createElement(
      Box,
      { width: Math.max(1, columns - 1), borderStyle: 'round', borderColor: inkColor(TUI_RGB.dim), paddingX: 1 },
      createElement(
        Text,
        { wrap: 'truncate-end' },
        createElement(Text, { color: inkColor(TUI_RGB.brand) }, busy ? '… ' : '❯ '),
        value === '' ? undefined : editor.before,
        createElement(CursorBlock, { char: editor.caret }),
        value === '' && !busy
          ? createElement(Text, { dimColor: true }, 'type a message · / commands · @ mentions')
          : editor.after,
      ),
    ),
  )
}

/** The whole terminal app; state arrives via the store, output via Ink. */
export function App(props: AppProps): ReactElement {
  const view = useSyncExternalStore(props.store.subscribe, props.store.getView)
  const descriptors = useSyncExternalStore(props.commands.subscribe, () => props.commands.descriptors)
  const skills = useSyncExternalStore(props.skills.subscribe, () => props.skills.rows)
  const [modelLabel, setModelLabel] = useState(props.model)
  const [modelOpen, setModelOpen] = useState(false)
  const [directory, setDirectory] = useState<ModelDirectory | undefined>(undefined)
  const [modelError, setModelError] = useState<string | undefined>(undefined)
  const [modelLoadEpoch, setModelLoadEpoch] = useState(0)
  const [notice, setNotice] = useState<{ text: string; tone: NoticeTone } | undefined>(undefined)
  const notify = useCallback((text: string, tone: NoticeTone = 'info'): void => {
    setNotice({ text, tone })
  }, [])

  useEffect(() => {
    props.onBridgeReady({ notify })
  }, [])
  useEffect(() => {
    if (!modelOpen) return
    let cancelled = false
    setDirectory(undefined)
    setModelError(undefined)
    // Enter the promise chain before invoking the loader so a provider that
    // throws synchronously becomes an in-panel error instead of escaping the
    // React effect and tearing down Ink.
    Promise.resolve().then(() => props.loadModels()).then((loaded) => {
      if (!cancelled) setDirectory(loaded)
    }, (error: unknown) => {
      if (!cancelled) setModelError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
    }
  }, [modelOpen, modelLoadEpoch, props.loadModels])

  const busy = view.busy
  const [showReasoning, setShowReasoning] = useState(false)
  const [verboseOpen, setVerboseOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  const [resumeOpen, setResumeOpen] = useState(false)
  const [pluginOpen, setPluginOpen] = useState(false)
  const [pluginQuery, setPluginQuery] = useState('')
  const [statuslineOpen, setStatuslineOpen] = useState(false)
  const [statuslineItems, setStatuslineItems] = useState<readonly StatusItemId[]>(() => parseStatuslineItems(props.statusline))
  const [refreshEpoch, setRefreshEpoch] = useState(0)
  const approvalSnapshot = useSyncExternalStore(props.approval.subscribe, props.approval.getSnapshot)
  const questionSnapshot = useSyncExternalStore(props.questions.subscribe, props.questions.getSnapshot)
  const approvalPending = approvalSnapshot.pending !== undefined
  const questionPending = questionSnapshot.pending !== undefined
  // While any modal owns the keys, the prompt box passes everything through.
  const inputActive = !modelOpen && !helpOpen && !modeOpen && !resumeOpen && !pluginOpen && !statuslineOpen && !verboseOpen && !approvalPending && !questionPending

  // Human questions outrank local inspectors. Close the lower modal instead
  // of leaving an approval/question visible but keyboard-locked behind it.
  useEffect(() => {
    if (!approvalPending && !questionPending) return
    setModelOpen(false)
    setHelpOpen(false)
    setModeOpen(false)
    setResumeOpen(false)
    setPluginOpen(false)
    setStatuslineOpen(false)
    setVerboseOpen(false)
  }, [approvalPending, questionPending])

  // Append-only transcript: everything up to the first still-mutable entry
  // (a running tool/retry) flushes through Ink's `<Static>` into native
  // scrollback and is normally never rewritten — the Claude-Code stability
  // contract
  // that lets arbitrarily long conversations scroll instead of freezing when
  // the live tree exceeds the terminal height. The dynamic region below stays
  // small: the streaming tail, modals, composer, and its status footer.
  // `assistant/chunk` preserves `entries` identity. Memoizing on that identity
  // keeps long settled histories out of the per-token render path.
  const settled = useMemo(() => settledEntryCount(view.entries), [view.entries])
  // Claude-Code spacing: one blank row before each user prompt (except the
  // first) separates replies from the next turn. Settled rows flush once with
  // the reasoning toggle as it is NOW (Ctrl+R affects subsequent flushes);
  // Ctrl+O browses the frozen history through a bounded selected-entry view.
  const settledRows = useMemo(() => {
    const rows: ReactElement[] = [createElement(Header, { key: 'header', resumed: props.resumed })]
    view.entries.slice(0, settled).forEach((entry, index) => {
      const row = createElement(EntryLine, { entry, showReasoning, verbose: false })
      const roomyPrompt = entry.kind === 'user' && !entry.notice
      if (roomyPrompt) {
        rows.push(createElement(Box, { key: `prompt-before-${index}`, paddingX: 1 }, createElement(Text, null, ' ')))
      }
      rows.push(createElement(Box, { key: index, paddingX: 1 }, row))
      if (roomyPrompt) {
        rows.push(createElement(Box, { key: `prompt-after-${index}`, paddingX: 1 }, createElement(Text, null, ' ')))
      }
    })
    return rows
  }, [view.entries, settled, showReasoning, props.resumed])

  // Hook order is unconditional. Its dimensions drive every live-region
  // budget before any dynamic rows are constructed.
  const appStdout = useStdout().stdout
  const [terminalSize, setTerminalSize] = useState(() => ({
    columns: appStdout?.columns ?? 80,
    rows: appStdout?.rows ?? 30,
  }))
  const terminalSizeRef = useRef(terminalSize)
  useEffect(() => {
    if (appStdout === undefined) return
    let replayTimer: ReturnType<typeof setTimeout> | undefined
    const handleResize = (): void => {
      const next = {
        columns: appStdout.columns ?? 80,
        rows: appStdout.rows ?? 30,
      }
      if (next.columns === terminalSizeRef.current.columns && next.rows === terminalSizeRef.current.rows) return
      terminalSizeRef.current = next

      // Ink 5 erases by the old logical line count. Once the terminal reflows
      // a full-width border at a new width, that count is no longer enough and
      // stale frames remain visible. Follow Codex's source-backed reflow
      // policy: update live geometry immediately, but wait for the resize
      // burst to settle before one hard reset and one transcript replay at the
      // final width. Replaying Static on every event appends duplicate history.
      setTerminalSize(next)
      if (replayTimer !== undefined) clearTimeout(replayTimer)
      replayTimer = setTimeout(() => {
        appStdout.write(RESIZE_REFLOW_CLEAR)
        setRefreshEpoch(epoch => epoch + 1)
      }, RESIZE_REFLOW_DELAY_MS)
    }
    appStdout.on('resize', handleResize)
    return () => {
      appStdout.off('resize', handleResize)
      if (replayTimer !== undefined) clearTimeout(replayTimer)
    }
  }, [appStdout])
  const terminalRows = terminalSize.rows
  const terminalColumns = terminalSize.columns
  const composerGutterRows = layoutGutterRows(terminalRows)
  // Bottom chrome is now composer (3) + status (up to 2 rows); the budget
  // keeps the live/streaming area strictly below the terminal height.
  const dynamicRows = Math.max(1, terminalRows - 13 - composerGutterRows)
  const streamingActive = view.streaming !== '' || view.streamingReasoning !== ''
  const deepDivingVisible = busy && !streamingActive
  const allLiveLines = useMemo(
    () => view.entries.slice(settled).flatMap(entry => transcriptEntryLines(entry, Math.max(1, terminalColumns - 2))),
    [view.entries, settled, terminalColumns],
  )
  const liveBudget = streamingActive
    ? Math.max(1, Math.floor(dynamicRows / 3))
    : Math.max(0, dynamicRows - (deepDivingVisible ? 1 : 0))
  const visibleLiveLines = liveBudget === 0 ? [] : allLiveLines.slice(-liveBudget)

  // The screen refresh used by /clear and Ctrl+L: a raw ANSI clear (wipe
  // screen AND scrollback, home the cursor) then a Static remount via the
  // key change, which re-flushes the current items from index 0. NEVER
  // console.clear() — it desyncs Ink's internal line ledger against the
  // flushed static rows and garbles every frame after.
  const streamRows = Math.max(1, dynamicRows - visibleLiveLines.length)
  const reasoningRows = view.streamingReasoning === ''
    ? 0
    : view.streaming === ''
      ? streamRows
      : streamRows <= 1
        ? 0
        : showReasoning
          ? Math.max(1, Math.floor(streamRows / 3))
          : 1
  const answerRows = view.streaming === '' ? 0 : Math.max(1, streamRows - reasoningRows)
  const transcriptVisible = !modelOpen && !helpOpen && !modeOpen && !resumeOpen && !pluginOpen && !statuslineOpen && !verboseOpen && !approvalPending && !questionPending
  const inspectorVisible = verboseOpen && !approvalPending && !questionPending
  const modalVisible = modelOpen || helpOpen || modeOpen || resumeOpen || pluginOpen || statuslineOpen || inspectorVisible || approvalPending || questionPending
  const closeInspector = useCallback((): void => {
    setVerboseOpen(false)
  }, [])
  const refreshScreen = (): void => {
    if (appStdout !== undefined) appStdout.write('\x1b[2J\x1b[3J\x1b[H')
    setRefreshEpoch(epoch => epoch + 1)
  }

  return createElement(
    Box,
    { flexDirection: 'column' },
    createElement(MemoStaticTranscript, {
      key: refreshEpoch,
      items: settledRows,
    }),
    transcriptVisible
      ? createElement(
        Box,
        { flexDirection: 'column', paddingX: 1 },
        visibleLiveLines.length === 0 ? undefined : createElement(StyledRows, { lines: visibleLiveLines }),
        view.streamingReasoning !== '' && reasoningRows > 0
          ? createElement(StreamTail, {
            text: showReasoning ? view.streamingReasoning : 'Thinking…',
            prefix: '  ✻ ',
            dim: true,
            maxRows: reasoningRows,
          })
          : undefined,
        view.streaming !== '' && answerRows > 0
          ? createElement(
            StreamTail,
            { text: view.streaming, dim: false, maxRows: answerRows },
            busy ? createElement(Caret) : undefined,
          )
          : undefined,
        deepDivingVisible ? createElement(DeepDivingLine, { since: view.busySince }) : undefined,
      )
      : undefined,
    transcriptVisible ? createElement(TodoPanel, { todos: view.todos }) : undefined,
    createElement(QuestionBar, { store: props.questions, snapshot: questionSnapshot, locked: false }),
    createElement(ApprovalBar, { snapshot: approvalSnapshot, locked: questionPending }),
    modelOpen && !approvalPending && !questionPending
      ? createElement(ModelPanel, {
        directory,
        error: modelError,
        onSelect: (row: ModelRow) => {
          try {
            setModelLabel(props.selectModel(row))
            notify(`model → next step uses ${row.provider}/${row.model}`)
            setModelOpen(false)
          } catch (error: unknown) {
            notify(`model switch failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
          }
        },
        onRetry: () => {
          setModelLoadEpoch(epoch => epoch + 1)
        },
        onClose: () => {
          setModelOpen(false)
        },
      })
      : undefined,
    helpOpen && !approvalPending && !questionPending
      ? createElement(HelpPanel, {
        descriptors,
        skills,
        commandError: props.commands.error,
        skillError: props.skills.error,
        onClose: () => {
          setHelpOpen(false)
        },
      })
      : undefined,
    verboseOpen && !approvalPending && !questionPending
      ? createElement(MemoVerbosePanel, {
        entries: view.entries,
        onClose: closeInspector,
      })
      : undefined,
    modeOpen && !approvalPending && !questionPending
      ? createElement(ModePanel, {
        current: props.mode,
        load: props.loadPresets,
        select: (id: string) => {
          void props.switchMode(id).then(label => {
            notify(`mode → ${label}`)
            setModeOpen(false)
          }, (reason: unknown) => notify(`mode switch failed: ${reason instanceof Error ? reason.message : String(reason)}`, 'error'))
        },
        close: () => setModeOpen(false),
      })
      : undefined,
    resumeOpen && !approvalPending && !questionPending
      ? createElement(ResumePanel, {
        currentCwd: props.workspaceRoot,
        load: props.loadSessions,
        readTranscript: props.loadSessionTranscript,
        select: (row: SessionRow) => { props.switchSession(row); setResumeOpen(false) },
        close: () => setResumeOpen(false),
      })
      : undefined,
    pluginOpen && !approvalPending && !questionPending
      ? createElement(PluginPanel, { load: props.loadPlugins, initialQuery: pluginQuery, close: () => setPluginOpen(false) })
      : undefined,
    statuslineOpen && !approvalPending && !questionPending
      ? createElement(StatuslinePanel, {
        enabled: statuslineItems,
        change: items => {
          setStatuslineItems(items)
          props.saveStatusline(items)
        },
        close: () => setStatuslineOpen(false),
      })
      : undefined,
    notice === undefined
      ? undefined
      : createElement(NoticeLine, {
        text: notice.text,
        tone: notice.tone,
        columns: terminalColumns,
      }),
    // Persistent bottom chrome: every interface owns exactly the same
    // composer/status geometry. Panels may change above it, but can no longer
    // reorder the status or introduce mode-specific vertical margins.
    createElement(
      Box,
      { flexDirection: 'column', marginTop: composerGutterRows },
      createElement(Input, {
        active: inputActive,
        frozen: modalVisible,
        busy,
        descriptors,
        skills,
        dispatch: props.dispatch,
        steer: props.steer,
        interrupt: props.interrupt,
        quit: props.quit,
        openModel: () => {
          setDirectory(undefined)
          setModelError(undefined)
          setModelOpen(true)
        },
        openHelp: () => {
          setHelpOpen(true)
        },
        openMode: () => setModeOpen(true),
        openResume: () => setResumeOpen(true),
        openPlugin: (query = '') => { setPluginQuery(query); setPluginOpen(true) },
        openStatusline: () => setStatuslineOpen(true),
        createSession: props.createSession,
        cancelSessionSwitch: props.cancelSessionSwitch,
        notify,
        hasNotice: notice !== undefined,
        dismissNotice: () => {
          setNotice(undefined)
        },
        openVerbose: () => {
          setVerboseOpen(true)
        },
        clearView: () => {
          props.store.reset()
        },
        refresh: refreshScreen,
        // Ctrl+R must re-render already-settled history too: settled rows
        // flush through <Static> once, so the toggle rides the same
        // source-backed clear+replay the resize path uses — one clear, one
        // authoritative re-flush at the new visibility.
        toggleReasoning: () => {
          setShowReasoning(current => !current)
          refreshScreen()
        },
        loadMentions: props.loadMentions,
        cyclePermission: props.cyclePermission,
        exportTranscript: props.exportTranscript,
        renameTitle: props.renameTitle,
      }),
      createElement(StatusLine, {
        facts: {
          model: modelLabel,
          mode: props.mode,
          cwd: props.cwd,
          branch: props.branch,
          sessionId: props.sessionId,
          title: view.title,
          plan: view.plan,
          permission: view.permission,
          sandbox: view.sandbox,
          goal: view.goal === undefined ? undefined : { phase: view.goal.phase, rounds: view.goal.rounds, max: view.goal.max },
        },
        stats: view.stats,
        busy,
        columns: terminalColumns,
        items: statuslineItems,
      }),
    ),
  )
}
