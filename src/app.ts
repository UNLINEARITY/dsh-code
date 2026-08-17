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
import {
  brand,
  dim,
  error as paintError,
  getPalette,
  getTheme,
  inkColor,
  setTheme,
  type RgbTriple,
  type ThemeName,
} from './theme.ts'
import { ThemePanel } from './theme-panel.ts'
import { WHALE_GLYPH, WHALE_GLYPH_COLUMNS } from './whale-glyph.ts'
import { DSH_CODE_VERSION } from './version.ts'
import type { TranscriptStore } from './store.ts'
import { settledEntryCount, type TranscriptEntry } from './render/projection.ts'
import { renderMarkdown, type MdSegment, visibleColumns } from './render/markdown.ts'
import type { ToolDetail } from './render/tool-detail.ts'
import {
  busyChaseFrame,
  caretVisible,
  DEEPSEEK_WAVE_TICK_MS,
  deepseekWaveBorderColor,
  deepseekWaveColumnBg,
  deepseekWaveDuration,
  deepseekWaveSpark,
  deepseekWaveStyleRandom,
  deepseekWaveTier,
  deepseekWaveWordHue,
  deepseekWaveWordVisible,
  isOfficialDeepSeekLabel,
  pulseFrame,
  WAVE_BASE_DARK,
  WAVE_BASE_LIGHT,
  type DeepseekWaveStyle,
  type DeepseekWaveTier,
} from './render/animations.ts'
import type { ApprovalSnapshot, ApprovalStore } from './approval.ts'
import type { CommandsView } from './commands.ts'
import type { ModelDirectory, ModelRow } from './models.ts'
import type { ProviderSettingsDirectory, ProviderTargetView } from './provider-settings.ts'
import type { QuestionSnapshot, QuestionStore } from './questions.ts'
import type { SkillsView, SkillRow } from './skills.ts'
import type { MentionCandidate } from './mentions.ts'
import { EffortPanel, ModePanel, HistoryPanel, PermissionPanel, PluginPanel, ResumePanel, StatuslinePanel } from './kernel-panels.ts'
import type { PresetRow } from './presets.ts'
import type { PermissionRow } from './permissions.ts'
import type { PluginRow } from './plugin-inventory.ts'
import {
  recallEntries,
  recallNewer,
  recallOlder,
  recordLocalEntry,
  type RecallState,
} from './history.ts'
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
  STATUS_ROW2_INDENT,
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
  reasoningLines,
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
  /** Effective reasoning effort in force ('' when none), for the /model picker mark. */
  effort?: string
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
  /** Agent preset selected for the current or pending first session. */
  mode: string
  /** Permission preset selected for the current or pending first session. */
  permission: string
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
  /** Apply one /model selection (with an advertised reasoning effort, when picked); returns the display label. */
  selectModel(row: ModelRow, effortId?: string): string
  /** Load provider/settings/credential facts for the optional /model provider stage. */
  loadModelProviders?(): Promise<ProviderSettingsDirectory>
  /** Subscribe to Harness credential/settings/adapter invalidations while /model is open. */
  subscribeModelProviders?(listener: () => void): () => void
  /** Store or rotate one provider credential through the Harness credential service. */
  saveModelProviderCredential?(target: ProviderTargetView, key: string): Promise<void>
  /** Remove one writable provider credential without removing its settings profile. */
  unsetModelProviderCredential?(target: ProviderTargetView): Promise<void>
  /** Remove one user-owned provider profile and its page-managed credential. */
  removeModelProvider?(target: ProviderTargetView): Promise<void>
  /** Cycle to the next permission preset (Shift+Tab); returns the new label. */
  cyclePermission(): string
  /** Select or inspect a permission preset without requiring a pre-existing session. */
  setPermission(id: string): string
  /** Export the transcript to a markdown file (/export [path]); reports via notices. */
  exportTranscript(argument: string): Promise<void>
  /** Rename the session (/title <text>); returns the outcome line for the notice. */
  renameTitle(argument: string): string
  /** Preset/session/plugin kernel operations. */
  loadPresets(): Promise<readonly PresetRow[]>
  switchMode(id: string): Promise<string>
  /** Load the switchable permission presets for the /permission panel. */
  loadPermissions(): Promise<readonly PermissionRow[]>
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
  /** Apply and persist one /theme selection; the runner owns the theme.json file. */
  saveTheme?(name: ThemeName): void
  /** Persistent cross-session input history (oldest first); the runner owns the file. */
  history: readonly string[]
  /** Persist one submitted prompt to the global history file. */
  recordHistory(text: string): void
  /** Cancel one queued inbox message by identity (Delete on the empty composer). */
  cancelQueued(messageId: string): void
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
  return createElement(Text, { color: inkColor(getPalette().brandBright) }, pulseFrame(tick))
}

/**
 * The web StateDot "ongoing" chase in terminal form: three cells of the 3×3
 * ring trail clockwise around the eight outer positions (8 frames × 125ms =
 * the web's 1s cycle). Replaces the plain busy ellipsis as the composer's
 * prompt marker and leads the Deep-diving line.
 */
function BusyChase(): ReactElement {
  const tick = useFrames(125)
  return createElement(Text, { color: inkColor(getPalette().brandBright) }, busyChaseFrame(tick) + ' ')
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
 * The busy line, web TurnStatus contract: the StateDot chase leads the plain
 * `Deep diving...` label, with the elapsed clock appended only once the turn
 * has clearly been running (15s) — anchored to `turn/start` so a resumed
 * mid-turn keeps the real time.
 */
function DeepDivingLine({ since }: { since: number }): ReactElement {
  useFrames(1000)
  const elapsed = since === 0 ? 0 : Date.now() - since
  return createElement(
    Box,
    { flexDirection: 'row' },
    createElement(BusyChase),
    createElement(
      Text,
      { dimColor: true },
      elapsed >= 15_000 ? `Deep diving... ${runClock(elapsed)}` : 'Deep diving...',
    ),
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
function StreamTail({ text, dim, maxRows, prefix = '', continuationPrefix = prefix, children }: {
  text: string
  dim: boolean
  maxRows: number
  prefix?: string
  continuationPrefix?: string
  children?: ReactElement
}): ReactElement {
  const columns = useStdout().stdout?.columns ?? 80
  const safeRows = Math.max(1, maxRows)
  // App padding consumes two columns; the final extra column keeps a caret
  // from wrapping onto an unbudgeted row. Both prefixes participate because
  // every physical row now repeats its hanging indent.
  const prefixColumns = Math.max(visibleColumns(prefix), visibleColumns(continuationPrefix))
  const contentColumns = Math.max(10, columns - 3 - prefixColumns)
  const initial = displayTail(text, contentColumns, safeRows)
  // Reserve one row for the omission marker only when a marker is needed.
  const tail = initial.truncated && safeRows > 1
    ? displayTail(text, contentColumns, safeRows - 1)
    : initial
  const rows = tail.text.split('\n')
  return createElement(
    Box,
    { flexDirection: 'column' },
    tail.truncated && safeRows > 1
      ? createElement(Text, { color: inkColor(getPalette().dim) }, continuationPrefix, '…')
      : undefined,
    ...rows.map((row, index) => createElement(
      Text,
      { key: index, dimColor: dim || undefined },
      index === 0 ? prefix : continuationPrefix,
      row,
      index + 1 === rows.length ? children : undefined,
    )),
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
      return { color: inkColor(getPalette().brandBright), bold: undefined, italic: undefined, strikethrough: undefined }
    case 'accentBold':
      return { color: inkColor(getPalette().brandBright), bold: true, italic: undefined, strikethrough: undefined }
    case 'code':
      return { color: inkColor(getPalette().code), bold: undefined, italic: undefined, strikethrough: undefined }
    case 'dim':
      return { color: inkColor(getPalette().dim), bold: undefined, italic: undefined, strikethrough: undefined }
    case 'bold':
      return { color: undefined, bold: true, italic: undefined, strikethrough: undefined }
    case 'italic':
      return { color: undefined, bold: undefined, italic: true, strikethrough: undefined }
    case 'boldItalic':
      return { color: undefined, bold: true, italic: true, strikethrough: undefined }
    case 'strike':
      return { color: inkColor(getPalette().dim), bold: undefined, italic: undefined, strikethrough: true }
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
      return { color: inkColor(getPalette().brandBright), bold: undefined, italic: undefined, strikethrough: undefined, dimColor: undefined }
    case 'success':
      return { color: inkColor(getPalette().success), bold: undefined, italic: undefined, strikethrough: undefined, dimColor: undefined }
    case 'error':
      return { color: inkColor(getPalette().error), bold: undefined, italic: undefined, strikethrough: undefined, dimColor: undefined }
    case 'warn':
      return { color: inkColor(getPalette().warn), bold: undefined, italic: undefined, strikethrough: undefined, dimColor: undefined }
    case 'dimItalic':
      return { color: inkColor(getPalette().dim), bold: undefined, italic: true, strikethrough: undefined, dimColor: undefined }
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
function MarkdownBody({ text, indent = 0 }: { text: string; indent?: number }): ReactElement {
  const columns = useStdout().stdout?.columns ?? 80
  // Cached by (text, width): settled replies re-layout only when either moves.
  // The indent participates in the wrap budget so padded replies never
  // double-wrap inside the padded box.
  const lines = useMemo(
    () => renderMarkdown(displayText(text), Math.max(20, columns - 2 - indent)),
    [text, columns, indent],
  )
  return createElement(
    Box,
    { flexDirection: 'column', paddingLeft: indent },
    ...lines.map((line, index) => createElement(
      Text,
      { key: index },
      line.segments.length === 0
        ? ' '
        : line.segments.map((segment, at) => createElement(Text, { key: at, ...segmentProps(segment.style) }, segment.text)),
    )),
  )
}

/** Expanded reasoning with the same two-column content edge as the reply. */
function ReasoningBody({ text }: { text: string }): ReactElement {
  const columns = useStdout().stdout?.columns ?? 80
  const lines = useMemo(() => reasoningLines(text, Math.max(10, columns - 2)), [text, columns])
  return createElement(StyledRows, { lines })
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
                color: line.mark === '+' ? inkColor(getPalette().success) : line.mark === '-' ? inkColor(getPalette().error) : inkColor(getPalette().dim),
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
      // line width every frame. The reply body carries the same two-column
      // gutter as the composer, so reply text aligns with the input cursor
      // (Codex LIVE_PREFIX alignment).
      return createElement(
        Box,
        { flexDirection: 'column' },
        entry.reasoning === ''
          ? undefined
          : showReasoning
            ? createElement(ReasoningBody, { text: entry.reasoning })
            : createElement(Text, { color: inkColor(getPalette().dim) }, `✻ Thinking (${entry.reasoning.length} chars, Ctrl+R to expand)`),
        createElement(MarkdownBody, { text: entry.text, indent: 2 }),
      )
    case 'tool': {
      // Claude-Code-style tool card: the invocation row plus a nested ⎿
      // result line, so the summary reads under its call instead of inline.
      const mark = entry.state === 'running'
        ? createElement(Pulse)
        : entry.state === 'error'
          ? createElement(Text, { color: inkColor(getPalette().error) }, '⨯')
          : createElement(Text, { color: inkColor(getPalette().success) }, '⏺')
      return createElement(
        Box,
        { flexDirection: 'column' },
        createElement(
          Text,
          { wrap: verbose ? 'truncate-end' : undefined },
          mark,
          ' ',
          brand(displayText(entry.name)),
          entry.preview === '' ? '' : ` ${dim(displayText(entry.preview))}`,
        ),
        entry.summary === ''
          ? undefined
          : createElement(
            Text,
            { color: entry.state === 'error' ? inkColor(getPalette().error) : inkColor(getPalette().dim), wrap: verbose ? 'truncate-end' : undefined },
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
          ? createElement(Text, { color: inkColor(getPalette().error) }, '⨯')
          : createElement(Text, { color: inkColor(getPalette().success) }, '⏺')
      return createElement(
        Box,
        { flexDirection: 'column' },
        createElement(
          Text,
          { wrap: verbose ? 'truncate-end' : undefined },
          mark,
          ' ',
          brand(displayText(`/${entry.name}`)),
          entry.args === '' ? '' : ` ${dim(displayText(entry.args))}`,
        ),
        entry.summary === ''
          ? undefined
          : createElement(Text, { color: inkColor(getPalette().dim), wrap: verbose ? 'truncate-end' : undefined }, `  ⎿ ${displayText(entry.summary)}`),
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
        { color: entry.state === 'running' ? inkColor(getPalette().warn) : inkColor(getPalette().dim), wrap: verbose ? 'truncate-end' : undefined },
        `  ↻ retry ${entry.attempt}/${entry.max} · ${displayText(entry.code)} · ${Math.round(entry.delayMs / 100) / 10}s`,
      )
    case 'files': {
      // Turn-tail deliverables: the turn's mutated files (web turnTail chips).
      const shown = entry.paths.slice(0, 3).map(path => displayText(path)).join(' · ')
      const more = entry.paths.length > 3 ? ` (+${entry.paths.length - 3} more)` : ''
      return createElement(Text, { dimColor: true, wrap: verbose ? 'truncate-end' : undefined }, `  ⎄ ${shown}${more}`)
    }
    case 'pending':
      // Codex PendingSteer: queued prompts render as ordinary user rows; the
      // durable user/message retires them seamlessly.
      return createElement(
        Text,
        { wrap: verbose ? 'truncate-end' : undefined },
        brand('❯ '),
        displayText(entry.text),
      )
    case 'error':
      return createElement(Text, { wrap: verbose ? 'truncate-end' : undefined }, paintError(displayText(entry.text)))
    default:
      return assertNever(entry, 'transcript entry kind')
  }
}

/**
 * The whale header with a compact three-line copy lockup. The title, bilingual
 * slogan, and key hint stay centered inside the existing eight content rows,
 * preserving the Static header's ten physical rows. Short or narrow terminals
 * keep a one-line form.
 */
function Header({ resumed }: { resumed: boolean }): ReactElement {
  const stdout = useStdout().stdout
  const rows = stdout?.rows ?? 40
  const columns = stdout?.columns ?? 80
  const title = `DeepSeek Harness · v${DSH_CODE_VERSION}`
  const slogan = 'Into the Unknown  探索未至之境'
  const hint = resumed ? 'resumed · /help · Esc interrupt' : '/help · Esc interrupt · Ctrl+C quit'
  const copyColumns = Math.max(visibleColumns(title), visibleColumns(slogan), visibleColumns(hint))
  const compact = `${title} · ${hint}`
  if (rows < 20 || columns < WHALE_GLYPH_COLUMNS + copyColumns + 8) {
    return createElement(
      Box,
      { width: Math.max(1, columns - 1), borderStyle: 'round', borderColor: inkColor(getPalette().brand), paddingX: 1 },
      createElement(Text, { color: inkColor(getPalette().brandBright), bold: true, wrap: 'truncate-end' }, truncateColumns(compact, Math.max(1, columns - 5))),
    )
  }
  return createElement(
    Box,
    // alignSelf shrinks the border to the whale-plus-copy content instead of
    // stretching across the terminal and stranding empty space on the right.
    { flexDirection: 'row', gap: 2, borderStyle: 'round', borderColor: inkColor(getPalette().brand), paddingX: 1, alignSelf: 'flex-start' },
    createElement(
      Box,
      { flexDirection: 'column', width: WHALE_GLYPH_COLUMNS, justifyContent: 'center' },
      ...WHALE_GLYPH.map((row, index) => createElement(Text, { key: index, color: inkColor(getPalette().brand) }, row)),
    ),
    createElement(
      Box,
      { flexDirection: 'column', width: copyColumns, justifyContent: 'center' },
      createElement(Text, { color: inkColor(getPalette().brandBright), bold: true, wrap: 'truncate-end' }, title),
      createElement(
        Text,
        { color: inkColor(getPalette().code), wrap: 'truncate-end' },
        createElement(Text, { bold: true }, 'Into the Unknown'),
        '  探索未至之境',
      ),
      createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, hint),
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
      { color: inkColor(getPalette().brand), bold: true, wrap: 'truncate-end' },
      `todos ${completed}/${todos.length}`,
      createElement(Text, { dimColor: true }, ` · ${inProgress} active · ${pending} pending`),
      current === undefined ? '' : createElement(Text, { color: inkColor(getPalette().brandBright) }, ` · ${todoMark(current.status)} ${displayText(current.content)}`),
    ),
  )
}

/**
 * Ink props for one status tone: the Codex status-line accent mapping over
 * the DeepSeek palette, all blue by design — the status bar speaks only in
 * degrees of blue (deep accent, primary figures, model identity, sky
 * paths and done states), with amber/red reserved for warnings and errors.
 */
function statusToneProps(tone: StatusTone): {
  color: string | undefined
  bold: boolean | undefined
  dimColor: boolean | undefined
} {
  switch (tone) {
    case 'model':
      // Same tone as the working-directory segment: the model name reads as
      // a path fact, not a brand accent.
      return { color: inkColor(getPalette().code), bold: true, dimColor: undefined }
    case 'live':
      return { color: inkColor(getPalette().brandBright), bold: undefined, dimColor: undefined }
    case 'path':
      return { color: inkColor(getPalette().code), bold: undefined, dimColor: undefined }
    case 'branch':
      return { color: inkColor(getPalette().text), bold: undefined, dimColor: undefined }
    case 'value':
      return { color: inkColor(getPalette().brand), bold: undefined, dimColor: undefined }
    case 'label':
    case 'meta':
      // Explicit RGB gray, not SGR dim: Ink's token stream inherits an
      // unclosed `dim` into the next span (the model name after the busy dot
      // rendered dim+bold and looked gray), and a concrete color closes
      // cleanly on the style transition. Theme-aware via the palette.
      return { color: inkColor(getPalette().dim), bold: undefined, dimColor: undefined }
    case 'accent':
      return { color: inkColor(getPalette().brandDeep), bold: undefined, dimColor: undefined }
    // Context-bar fill: one DeepSeek blue over the whole occupied run; the
    // dotted free track reads through the dim label gray.
    case 'ctxFill':
      return { color: inkColor(getPalette().brand), bold: undefined, dimColor: undefined }
    case 'success':
      return { color: inkColor(getPalette().code), bold: true, dimColor: undefined }
    case 'warn':
      return { color: inkColor(getPalette().warn), bold: true, dimColor: undefined }
    case 'error':
      return { color: inkColor(getPalette().error), bold: true, dimColor: undefined }
    default:
      return { color: inkColor(getPalette().dim), bold: undefined, dimColor: undefined }
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
 *
 * The DeepSeek easter egg: when the model label *switches* to an official
 * DeepSeek route, the composer's INPUT ROW (not the frame) plays Codex's
 * effort-ignition "Wave" — a blue crest sweeping the content row column by
 * column, with the `· ✦ ✧` sparkles on the deepseek tier — and the prompt
 * marker keeps the tier accent afterwards. The border stays a constant
 * static dim; only the row's per-column background tints during the wave,
 * so the row and column budget is untouched throughout.
 */

/** Theme anchors for the one-shot composer wave, read from the active palette
 * so the wave stays coordinated in both themes. The flash tier runs the
 * brand blues; the deepseek tier swaps in the code sky-blue for a brighter,
 * richer mix. Codex's Wave bands carry no hue index (only hues[0] tints the
 * row), so the accent the prompt keeps is always hues[0]. */
function deepseekWaveHues(tier: DeepseekWaveTier): readonly [RgbTriple, RgbTriple, RgbTriple] {
  const palette = getPalette()
  return tier === 'flash'
    ? [palette.brandBright, palette.brand, palette.brandMid]
    : [palette.brandBright, palette.code, palette.brandMid]
}

function StatusLine({ facts, stats, busy, columns, items }: {
  facts: StatusFacts
  stats: Parameters<typeof layoutStatusBar>[1]
  busy: boolean
  columns: number
  items: readonly string[]
}): ReactElement {
  const layout = layoutStatusBar(facts, stats, Math.max(8, columns - 2), { busy, items })

  const renderRow = (row: { left: readonly StatusGroup[]; right: readonly StatusSpan[]; hint: boolean }, key: string, indent = 0): ReactElement => {
    const leftParts: ReactElement[] = []
    row.left.forEach((group, groupIndex) => {
      if (groupIndex > 0) {
        leftParts.push(createElement(Text, { key: key + 'gs' + groupIndex, color: inkColor(getPalette().dim) }, STATUS_GROUP_SEPARATOR))
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
        rightParts.push(createElement(Text, { key: key + 'rs' + index, color: inkColor(getPalette().dim) }, STATUS_ITEM_SEPARATOR))
      }
      rightParts.push(createElement(
        Text,
        { key: key + 'r' + index, wrap: 'truncate-end', ...statusToneProps(span.tone) },
        span.text,
      ))
    })
    if (row.hint) {
      rightParts.push(createElement(Text, { key: key + 'hint', color: inkColor(getPalette().dim) }, STATUS_CYCLE_HINT))
    }
    // Each row already fits the column budget; truncate-end stays as the
    // terminal-measurement backstop so a drifting cell count clips instead
    // of wrapping.
    return createElement(
      Box,
      // Match the prompt text inside the bordered composer: one border column
      // plus one padding column. The secondary row adds the model-name indent
      // (its budget already shrinks by the same amount) so its figures align
      // under the model name rather than under the busy dot.
      { paddingLeft: 2 + indent, justifyContent: rightParts.length > 0 ? 'space-between' : undefined },
      createElement(Text, { wrap: 'truncate-end' }, ...leftParts),
      rightParts.length > 0 ? createElement(Text, { wrap: 'truncate-end' }, ...rightParts) : undefined,
    )
  }
  const row2Present = layout.row2.left.length > 0
  return createElement(
    Box,
    { flexDirection: 'column' },
    renderRow(layout.row1, 's1'),
    row2Present ? renderRow(layout.row2, 's2', STATUS_ROW2_INDENT) : undefined,
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
    ? getPalette().error
    : tone === 'warning'
      ? getPalette().warn
      : getPalette().brandBright
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

/** One selectable approval decision (Codex approval-overlay wording). */
interface ApprovalOption {
  readonly key: 'allow' | 'reject-note' | 'reject'
  readonly label: string
  readonly hotkey: string
}

/** The fixed decision list; answers stay in the binary answerer vocabulary. */
const APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { key: 'allow', label: 'Yes, proceed', hotkey: 'y' },
  { key: 'reject-note', label: 'No, and tell it what to do differently', hotkey: 'n' },
  { key: 'reject', label: 'No, continue without running it', hotkey: 'd' },
]

/**
 * The approval dialog (Codex ApprovalOverlay contract): a bold question
 * header, the bounded command body with an explicit overflow marker, a
 * numbered option list with a `›` cursor, single-key shortcuts, and digits
 * for direct selection. Askers queue FIFO — the count rides the header.
 * The upstream answerer vocabulary stays binary (`allowed-once` /
 * `rejected`): "tell it what to do differently" rejects and hands the
 * composer back with a hint notice, exactly Codex's decline-then-type flow.
 */
function ApprovalBar({ snapshot, locked, notify }: {
  snapshot: ApprovalSnapshot
  locked: boolean
  notify(text: string, tone?: NoticeTone): void
}): ReactElement | undefined {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [cursor, setCursor] = useState(0)
  const pending = snapshot.pending
  const active = !locked && pending !== undefined && !snapshot.answered
  const body = useMemo<readonly StyledLine[]>(() => pending === undefined || pending.command === ''
    ? []
    : textLines(pending.command, viewport.contentColumns, 'dim'), [pending, viewport.contentColumns])

  useEffect(() => {
    setCursor(0)
  }, [pending])

  const decide = (option: ApprovalOption): void => {
    const ask = snapshot.pending
    if (ask === undefined || snapshot.answered) return
    if (option.key === 'allow') {
      ask.answer('allowed-once')
      return
    }
    ask.answer('rejected')
    if (option.key === 'reject-note') {
      notify('rejected — type below what it should do differently (it steers the next step)', 'warning')
    }
  }

  useInput((input, key) => {
    const ask = snapshot.pending
    if (ask === undefined || snapshot.answered) return
    if (key.upArrow) {
      setCursor(current => (current + APPROVAL_OPTIONS.length - 1) % APPROVAL_OPTIONS.length)
      return
    }
    if (key.downArrow) {
      setCursor(current => (current + 1) % APPROVAL_OPTIONS.length)
      return
    }
    if (key.return) {
      decide(APPROVAL_OPTIONS[cursor]!)
      return
    }
    if (key.escape) {
      decide(APPROVAL_OPTIONS[2]!)
      return
    }
    if (input === 'y' || input === 'Y') {
      decide(APPROVAL_OPTIONS[0]!)
      return
    }
    if (input === 'n' || input === 'N') {
      decide(APPROVAL_OPTIONS[1]!)
      return
    }
    if (input === 'd' || input === 'D') {
      decide(APPROVAL_OPTIONS[2]!)
      return
    }
    if (/^[1-9]$/u.test(input)) {
      const index = Number(input) - 1
      if (index < APPROVAL_OPTIONS.length) decide(APPROVAL_OPTIONS[index]!)
    }
  }, { isActive: active })

  if (pending === undefined) return undefined
  if (viewport.maxHeight === 0) return createElement(Box, { display: 'none' })
  const queuedSuffix = snapshot.queued > 0 ? ` · +${snapshot.queued} queued` : ''
  if (viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(`approval${queuedSuffix} · enter/y allow · esc/n reject`, viewport.contentColumns))
  }
  // Body budget: title + options + footer consume fixed rows; the command
  // preview shrinks with an explicit overflow marker (Codex's "[… N lines]").
  const reservedRows = 3 + APPROVAL_OPTIONS.length
  const bodyBudget = Math.max(1, viewport.bodyRows - reservedRows)
  const visibleBody = body.slice(0, bodyBudget)
  const overflow = body.length - visibleBody.length
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(getPalette().warn) },
    createElement(
      Text,
      { color: inkColor(getPalette().warn), bold: true, wrap: 'truncate-end' },
      truncateColumns(`${pending.headline}${queuedSuffix}`, viewport.contentColumns),
    ),
    createElement(PanelGap, { visible: viewport.gapRows > 0 && body.length > 0 }),
    ...visibleBody.map((line, index) => createElement(StyledRows, { key: `body-${index}`, lines: [line] })),
    ...(overflow > 0
      ? [createElement(Text, { key: 'overflow', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(`… +${overflow} more lines · ctrl+o shows the full call in the transcript`, viewport.contentColumns))]
      : []),
    ...(body.length > 0 ? [createElement(PanelGap, { visible: viewport.gapRows > 0 })] : []),
    ...APPROVAL_OPTIONS.map((option, index) => {
      const selected = !snapshot.answered && index === cursor
      return createElement(
        Text,
        {
          key: option.key,
          color: selected ? inkColor(getPalette().brandBright) : inkColor(getPalette().text),
          bold: selected || undefined,
          wrap: 'truncate-end',
        },
        truncateColumns(`${selected ? '›' : ' '} ${index + 1}. ${option.label} (${option.hotkey})`, viewport.contentColumns),
      )
    }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(snapshot.answered
      ? 'submitted…'
      : '↑↓ choose · enter confirm · y/n/d quick · esc reject', viewport.contentColumns)),
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
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(isPlan ? getPalette().brand : getPalette().brandDeep) },
    createElement(
      Text,
      { color: inkColor(isPlan ? getPalette().brand : getPalette().brandDeep), bold: true, wrap: 'truncate-end' },
      truncateColumns(`${isPlan ? '📋 plan review' : '❓ question'} ${index + 1}/${pending.request.questions.length} · lines ${rendered.lines.length === 0 ? 0 : visibleScroll + 1}-${Math.min(rendered.lines.length, visibleScroll + viewport.bodyRows)}/${rendered.lines.length}`, viewport.contentColumns),
    ),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(StyledRows, { lines: rendered.lines.slice(visibleScroll, visibleScroll + viewport.bodyRows) }),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, dim(truncateColumns(footer, viewport.contentColumns))),
  )
}

/** The /model panel: a scrolling list over the advisory model directory. */
function ModelPanel({ directory, error, onSelect, onProviders, onRetry, onClose }: {
  directory: ModelDirectory | undefined
  error: string | undefined
  onSelect(row: ModelRow): void
  onProviders?(): void
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
    if (input === 'a' && onProviders !== undefined) {
      onProviders()
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
    const providers = onProviders === undefined ? '' : ' · a providers'
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(`/model${providers} · r retry · esc/q close`, viewport.contentColumns))
  }

  const stateRows: ReactElement[] = directory === undefined && error === undefined
    ? [createElement(Text, { key: 'loading', dimColor: true, wrap: 'truncate-end' }, '  loading models…')]
    : error !== undefined
      ? [createElement(
        Text,
        { key: 'error', color: inkColor(getPalette().error), wrap: 'truncate-end' },
        truncateColumns(`  ${singleLineText(error)}`, viewport.contentColumns),
      )]
      : [
        ...(directory?.failures.length === 0
          ? []
          : [createElement(
            Text,
            { key: 'failures', color: inkColor(getPalette().warn), wrap: 'truncate-end' },
            truncateColumns(`  unavailable providers: ${directory?.failures.join(', ')}`, viewport.contentColumns),
          )]),
        ...(rows.length === 0
          ? [createElement(Text, { key: 'empty', dimColor: true, wrap: 'truncate-end' }, '  no models available')]
          : []),
      ]
  // Measurement and rendering share the same physical-row budget: state
  // messages consume body rows before selectable entries, as in Codex's
  // list-selection views.
  const visibleStateRows = stateRows.slice(0, viewport.bodyRows)
  const rowBudget = Math.max(0, viewport.bodyRows - visibleStateRows.length)
  const first = selectionWindow(cursor, rows.length, rowBudget)
  const visible = rowBudget === 0 ? [] : rows.slice(first, first + rowBudget)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(getPalette().brand) },
    createElement(Text, { color: inkColor(getPalette().brand), bold: true, wrap: 'truncate-end' }, truncateColumns(`/model — select model${rows.length === 0 ? '' : ` · ${cursor + 1}/${rows.length}`}`, viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...visibleStateRows,
    ...visible.map((row) => {
      const index = rows.indexOf(row)
      const label = displayText(`${row.providerName} · ${row.modelName}`)
      return createElement(
        Text,
        {
          key: `${row.provider}/${row.model}`,
          color: index === cursor ? inkColor(getPalette().brandBright) : inkColor(getPalette().dim),
          wrap: 'truncate-end',
        },
        truncateColumns(`${index === cursor ? '❯ ' : '  '}${label}`, viewport.contentColumns),
      )
    }),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, dim(truncateColumns(`↑↓ move · pgup/pgdn page · enter select${onProviders === undefined ? '' : ' · a providers'} · r retry · esc/q close`, viewport.contentColumns))),
  )
}

/** Compact provider-state copy; only value-free credential facts cross this boundary. */
function providerStateLabel(row: ProviderTargetView): string {
  const route = row.active ? 'active' : 'dormant'
  const credential = row.credential
  if (credential?.kind === 'error') return `${route} · key status unavailable`
  if (credential?.kind === 'facts') {
    if (!credential.configured) return `${route} · key missing`
    const source = credential.source === undefined ? 'configured' : singleLineText(credential.source)
    return `${route} · key ${source}${credential.writable ? '' : ' · read-only'}`
  }
  return `${route} · ${row.configured ? 'provider auth' : 'not configured'}`
}

/** The provider-management stage reached from /model with `a`. */
function ProviderPanel({ directory, error, onCredential, onUnset, onRemove, onRetry, onBack }: {
  directory: ProviderSettingsDirectory | undefined
  error: string | undefined
  onCredential(target: ProviderTargetView): void
  onUnset(target: ProviderTargetView): void
  onRemove(target: ProviderTargetView): void
  onRetry(): void
  onBack(): void
}): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const rows = directory?.rows ?? []
  const [cursor, setCursor] = useState(0)
  const [actionError, setActionError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (rows.length === 0) {
      if (cursor !== 0) setCursor(0)
      return
    }
    if (cursor >= rows.length) setCursor(rows.length - 1)
  }, [rows.length, cursor])

  useStableInput((input, key) => {
    if (key.escape || input === 'q') {
      onBack()
      return
    }
    if (input === 'r') {
      setActionError(undefined)
      onRetry()
      return
    }
    if (rows.length === 0) return
    if (key.upArrow) {
      setActionError(undefined)
      setCursor(cursor > 0 ? cursor - 1 : rows.length - 1)
      return
    }
    if (key.downArrow) {
      setActionError(undefined)
      setCursor(cursor < rows.length - 1 ? cursor + 1 : 0)
      return
    }
    if (key.pageUp) {
      setActionError(undefined)
      setCursor(current => Math.max(0, current - Math.max(1, viewport.bodyRows - 1)))
      return
    }
    if (key.pageDown) {
      setActionError(undefined)
      setCursor(current => Math.min(rows.length - 1, current + Math.max(1, viewport.bodyRows - 1)))
      return
    }
    const target = rows[cursor]
    if (target === undefined) return
    if (input === 'd') {
      const facts = target.credential
      if (facts?.kind !== 'facts' || !facts.configured) {
        setActionError('this provider has no configured API key to remove')
      } else if (!facts.writable) {
        setActionError('this API key is supplied read-only by the environment')
      } else {
        onUnset(target)
      }
      return
    }
    if (input === 'x') {
      if (!target.removable) {
        setActionError('this provider profile is not removable')
      } else {
        onRemove(target)
      }
      return
    }
    if (key.return) {
      if (target.settingsNs.length === 0) {
        setActionError('this provider is not managed by Harness settings')
      } else if (target.credential?.kind === 'error') {
        setActionError('credential status is unavailable; retry before writing')
      } else if (target.credential?.kind === 'facts' && !target.credential.writable) {
        setActionError('this API key is supplied read-only by the environment')
      } else if (target.credentialRef === undefined && directory?.writable !== true) {
        setActionError('settings are read-only; this provider cannot be activated here')
      } else {
        onCredential(target)
      }
    }
  }, true)

  if (viewport.maxHeight === 0) return createElement(Box, { display: 'none' })
  if (viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns('/model providers · enter key · d remove key · esc back', viewport.contentColumns))
  }
  const stateRows: ReactElement[] = directory === undefined && error === undefined
    ? [createElement(Text, { key: 'loading', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, '  loading providers…')]
    : error !== undefined
      ? [createElement(Text, { key: 'error', color: inkColor(getPalette().error), wrap: 'truncate-end' }, truncateColumns(`  ${singleLineText(error)}`, viewport.contentColumns))]
      : [
        ...(actionError === undefined
          ? []
          : [createElement(Text, { key: 'action-error', color: inkColor(getPalette().error), wrap: 'truncate-end' }, truncateColumns(`  ${actionError}`, viewport.contentColumns))]),
        ...(directory?.failures ?? []).map((failure, index) => createElement(
          Text,
          { key: `failure-${index}`, color: inkColor(getPalette().warn), wrap: 'truncate-end' },
          truncateColumns(`  ${singleLineText(failure)}`, viewport.contentColumns),
        )),
        ...(rows.length === 0
          ? [createElement(Text, { key: 'empty', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, '  no configurable providers')]
          : []),
      ]
  const visibleStateRows = stateRows.slice(0, viewport.bodyRows)
  const rowBudget = Math.max(0, viewport.bodyRows - visibleStateRows.length)
  const first = selectionWindow(cursor, rows.length, rowBudget)
  const visible = rowBudget === 0 ? [] : rows.slice(first, first + rowBudget)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(getPalette().brand) },
    createElement(Text, { color: inkColor(getPalette().brand), bold: true, wrap: 'truncate-end' }, truncateColumns(`/model — providers${rows.length === 0 ? '' : ` · ${cursor + 1}/${rows.length}`}`, viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...visibleStateRows,
    ...visible.map((row) => {
      const index = rows.indexOf(row)
      const identity = row.displayName === row.provider ? row.provider : `${row.displayName} (${row.provider})`
      const label = `${identity} · ${providerStateLabel(row)}${row.removable ? ' · custom' : ''}`
      return createElement(
        Text,
        { key: row.provider, color: index === cursor ? inkColor(getPalette().brandBright) : inkColor(getPalette().dim), wrap: 'truncate-end' },
        truncateColumns(`${index === cursor ? '❯ ' : '  '}${displayText(label)}`, viewport.contentColumns),
      )
    }),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns('↑↓ move · enter add/update key · d remove key · x remove custom provider · r retry · esc back', viewport.contentColumns)),
  )
}

/** Write-only masked API-key editor; the secret lives only in this mounted component. */
function ProviderCredentialPanel({ target, save, done, back }: {
  target: ProviderTargetView
  save(target: ProviderTargetView, key: string): Promise<void>
  done(): void
  back(): void
}): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const submit = (): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    Promise.resolve().then(() => save(target, draft)).then(() => {
      setDraft('')
      done()
    }, (reason: unknown) => {
      setError(singleLineText(reason instanceof Error ? reason.message : String(reason)))
      setBusy(false)
    })
  }

  useStableInput((input, key) => {
    if (busy) return
    if (key.escape) {
      setDraft('')
      back()
      return
    }
    if (key.return) {
      submit()
      return
    }
    if (key.backspace || key.delete) {
      setError(undefined)
      setDraft(current => [...current].slice(0, -1).join(''))
      return
    }
    if (key.ctrl && input === 'u') {
      setError(undefined)
      setDraft('')
      return
    }
    if (key.ctrl || key.meta || input.length === 0) return
    const next = draft + input
    if (next.length > 4096) {
      setError('API key input is too long')
      return
    }
    setError(undefined)
    setDraft(next)
  }, true)

  if (viewport.maxHeight === 0) return createElement(Box, { display: 'none' })
  const keyBudget = Math.max(1, viewport.contentColumns - 4)
  const bullets = '•'.repeat(Math.min([...draft].length, keyBudget))
  if (viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(`API key ${bullets}${busy ? ' saving…' : ' ▏'} · esc back`, viewport.contentColumns))
  }
  const identity = target.displayName === target.provider ? target.provider : `${target.displayName} (${target.provider})`
  const source = target.credential?.kind === 'facts' && target.credential.configured
    ? `replaces ${singleLineText(target.credential.source ?? 'stored key')}`
    : 'new key'
  const providerRow = createElement(Text, { key: 'provider', wrap: 'truncate-end' }, truncateColumns(`  provider  ${displayText(identity)}`, viewport.contentColumns))
  const referenceRow = createElement(Text, { key: 'reference', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(`  reference ${displayText(target.credentialRef ?? target.suggestedRef)} · ${source}`, viewport.contentColumns))
  const keyRow = createElement(Text, { key: 'key', color: error === undefined ? inkColor(getPalette().brandBright) : inkColor(getPalette().error), wrap: 'truncate-end' }, truncateColumns(`  key       ${bullets}${busy ? ' saving…' : ' ▏'}`, viewport.contentColumns))
  const errorRow = error === undefined
    ? undefined
    : createElement(Text, { key: 'error', color: inkColor(getPalette().error), wrap: 'truncate-end' }, truncateColumns(`  ${error}`, viewport.contentColumns))
  const detailRows = errorRow === undefined ? [providerRow, referenceRow] : [providerRow, errorRow]
  const primaryRow = viewport.bodyRows === 1 && errorRow !== undefined ? errorRow : keyRow
  const detailBudget = Math.max(0, viewport.bodyRows - 1)
  const bodyRows = [
    ...(detailBudget === 0 ? [] : detailRows.slice(-detailBudget)),
    ...(viewport.bodyRows === 0 ? [] : [primaryRow]),
  ]
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(getPalette().brand) },
    createElement(Text, { color: inkColor(getPalette().brand), bold: true, wrap: 'truncate-end' }, truncateColumns('/model — add API key', viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...bodyRows,
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns('type or paste key · enter save · ctrl+u clear · esc back', viewport.contentColumns)),
  )
}

/** Bounded destructive-action confirmation for credential or provider removal. */
function ProviderConfirmPanel({ target, kind, confirm, done, back }: {
  target: ProviderTargetView
  kind: 'credential' | 'provider'
  confirm(target: ProviderTargetView): Promise<void>
  done(): void
  back(): void
}): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const run = (): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    Promise.resolve().then(() => confirm(target)).then(done, (reason: unknown) => {
      setError(singleLineText(reason instanceof Error ? reason.message : String(reason)))
      setBusy(false)
    })
  }
  useStableInput((input, key) => {
    if (busy) return
    if (key.escape || input === 'n') {
      back()
      return
    }
    if (input === 'y') run()
  }, true)

  if (viewport.maxHeight === 0) return createElement(Box, { display: 'none' })
  const action = kind === 'credential' ? 'remove API key' : 'remove provider'
  if (viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(`${action} ${target.displayName}? · y confirm · n/esc back`, viewport.contentColumns))
  }
  const identity = target.displayName === target.provider ? target.provider : `${target.displayName} (${target.provider})`
  const identityRow = createElement(Text, { key: 'identity', wrap: 'truncate-end' }, truncateColumns(`  ${displayText(identity)}`, viewport.contentColumns))
  const descriptionRow = createElement(Text, { key: 'description', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(kind === 'credential' ? '  the provider profile and selected model stay available' : '  the user settings profile and its managed key will be removed', viewport.contentColumns))
  const errorRow = error === undefined
    ? undefined
    : createElement(Text, { key: 'error', color: inkColor(getPalette().error), wrap: 'truncate-end' }, truncateColumns(`  ${error}`, viewport.contentColumns))
  const bodyRows = errorRow === undefined
    ? [identityRow, descriptionRow].slice(0, viewport.bodyRows)
    : [identityRow, errorRow].slice(-viewport.bodyRows)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(getPalette().warn) },
    createElement(Text, { color: inkColor(getPalette().warn), bold: true, wrap: 'truncate-end' }, truncateColumns(`/model — ${action}`, viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...bodyRows,
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(busy ? 'working…' : 'y confirm · n/esc back', viewport.contentColumns)),
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
    createElement(Text, { key: 'key-queue', dimColor: true, wrap: 'truncate-end' }, '  delete on the empty composer cancels the newest queued message'),
    createElement(Text, { key: 'key-edit', dimColor: true, wrap: 'truncate-end' }, '  ctrl+k cut to end of line · ctrl+u clear line · ctrl+a / ctrl+e line ends'),
    createElement(Text, { key: 'commands-gap' }, ' '),
    createElement(Text, { key: 'commands-title', bold: true, wrap: 'truncate-end' }, ' commands'),
    ...(commandError === undefined
      ? []
      : [createElement(
        Text,
        { key: 'commands-error', color: inkColor(getPalette().error), wrap: 'truncate-end' },
        truncateColumns(`  command catalog unavailable: ${singleLineText(commandError)}`, viewport.contentColumns),
      )]),
    createElement(Box, { key: 'local-help' }, row('/help', 'show this overlay')),
    createElement(Box, { key: 'local-model' }, row('/model', 'switch the model')),
    createElement(Box, { key: 'local-effort' }, row('/effort', 'adjust reasoning effort for the current model')),
    createElement(Box, { key: 'local-mode' }, row('/mode', 'inspect or select the agent preset (/mode [preset])')),
    createElement(Box, { key: 'local-permission' }, row('/permission', 'inspect or select the permission preset (/permission [preset])')),
    createElement(Box, { key: 'local-new' }, row('/new', 'create and switch to a fresh session (/new [preset])')),
    createElement(Box, { key: 'local-resume' }, row('/resume', 'browse or switch root sessions (/resume [id|prefix])')),
    createElement(Box, { key: 'local-plugin' }, row('/plugin', 'inspect the live plugin composition')),
    createElement(Box, { key: 'local-statusline' }, row('/statusline', 'customize the status line items')),
    createElement(Box, { key: 'local-theme' }, row('/theme', 'switch the color theme')),
    createElement(Box, { key: 'local-history' }, row('/history', 'search and recall past prompts')),
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
        { key: 'skills-error', color: inkColor(getPalette().error), wrap: 'truncate-end' },
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
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(getPalette().brand) },
    createElement(Text, { color: inkColor(getPalette().brand), bold: true, wrap: 'truncate-end' }, truncateColumns(`/help — keys and commands · rows ${content.length === 0 ? 0 : visibleScroll + 1}-${Math.min(content.length, visibleScroll + viewport.bodyRows)}/${content.length}`, viewport.contentColumns)),
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

/** The empty-composer placeholder text (shared by the static and wave paths). */
const COMPOSER_PLACEHOLDER = 'type a message · / commands · @ mentions'

/** One physical cell of the wave-painted composer row: a char plus styles. */
interface ComposerCell {
  char: string
  color?: string
  backgroundColor?: string
  bold?: boolean
  inverse?: boolean
  dim?: boolean
}

/** Adjacent cells with identical styling merge into one styled Text span. */
function sameCellStyle(a: ComposerCell, b: ComposerCell): boolean {
  return a.color === b.color
    && a.backgroundColor === b.backgroundColor
    && a.bold === b.bold
    && a.inverse === b.inverse
    && a.dim === b.dim
}

/**
 * Render the wave row as one Text whose cells carry per-column
 * `backgroundColor` runs: the Codex Wave crest paints a smooth gradient
 * (one SGR run per sampled column) over the prompt, draft, cursor,
 * placeholder, and the trailing blank fill — the draft stays readable
 * because the tint blends at ≤ 0.55 toward the theme's blank-cell base.
 */
function waveRowSpans(cells: readonly ComposerCell[]): ReactElement[] {
  const spans: ReactElement[] = []
  let start = 0
  while (start < cells.length) {
    const cell = cells[start]!
    let end = start + 1
    while (end < cells.length && sameCellStyle(cells[end]!, cell)) end += 1
    spans.push(createElement(
      Text,
      {
        key: start,
        color: cell.color,
        backgroundColor: cell.backgroundColor,
        bold: cell.bold,
        inverse: cell.inverse,
        dimColor: cell.dim,
      },
      cells.slice(start, end).map(c => c.char).join(''),
    ))
    start = end
  }
  return spans
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
      borderColor: inkColor(getPalette().brand),
    },
    createElement(
      Text,
      { color: inkColor(getPalette().brand), bold: true, wrap: 'truncate-end' },
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
 * registry first and only then falls through to the skill gesture), and a
 * later duplicate name never renders twice.
 *
 * A bare `/` returns the FULL merged list — Codex's command popup shows every
 * command inside a scroll window on an empty filter, and the menu's own
 * selection window bounds the visible rows, so no slice cap is needed.
 */
export function completionCandidates(
  value: string,
  descriptors: readonly CommandDescriptor[],
  skills: readonly SkillRow[],
): readonly CompletionCandidate[] {
  if (!value.startsWith('/')) return []
  const prefix = value.slice(1).split(' ')[0] ?? ''
  const local: CompletionCandidate[] = [
    { label: '/help', description: 'show commands', origin: 'command' },
    { label: '/model', description: 'switch the model', origin: 'command' },
    { label: '/effort', description: 'adjust reasoning effort for the current model', origin: 'command' },
    { label: '/mode', description: 'select the agent preset', origin: 'command' },
    { label: '/permission', description: 'inspect or select the permission preset', origin: 'command' },
    { label: '/new', description: 'start a fresh session', origin: 'command' },
    { label: '/resume', description: 'browse or switch sessions', origin: 'command' },
    { label: '/plugin', description: 'inspect the plugin composition', origin: 'command' },
    { label: '/statusline', description: 'customize the status line', origin: 'command' },
    { label: '/theme', description: 'switch the color theme', origin: 'command' },
    { label: '/history', description: 'search and recall past prompts', origin: 'command' },
    { label: '/clear', description: 'clear the screen', origin: 'command' },
    { label: '/export', description: 'export the transcript to markdown', origin: 'command' },
    { label: '/title', description: 'rename this session', origin: 'command' },
    { label: '/quit', description: 'exit', origin: 'command' },
  ]
  // Local commands shadow registry names (e.g. the TUI-local /permission works
  // before any session exists, while the registry child needs one), so
  // collisions cannot render two rows with the same key.
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
  // One row per name, first occurrence wins: local before registry before
  // skills, which is exactly the shadowing precedence above (defensive
  // against duplicate registry names across scopes).
  const seen = new Set<string>()
  const all: CompletionCandidate[] = []
  for (const candidate of [...local, ...registry, ...skillRows]) {
    const name = candidate.label.slice(1)
    if (seen.has(name)) continue
    seen.add(name)
    all.push(candidate)
  }
  if (prefix === '') return all
  return all.filter(candidate => candidate.label.slice(1).startsWith(prefix))
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
  const hidden = rows.length - visible.length
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
          color: absolute === selected ? inkColor(getPalette().brandBright) : inkColor(getPalette().dim),
          wrap: 'truncate-end',
        },
        `${absolute === selected ? '❯ ' : '  '}${padColumns(candidate.label, nameWidth)}${dim(truncateColumns(displayText(candidate.description), descBudget))}`,
        )
      })),
    // Scroll affordance: with the full merged catalog (commands + registry +
    // skills) the six-row window rarely shows the tail — count and hint keep
    // the rest discoverable without inflating the menu budget.
    hidden > 0 ? createElement(Text, { key: 'more', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, dim(`  … +${hidden} more`)) : undefined,
    showFooter ? createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, dim(mention ? `↑↓ choose · ${rows.length} items · tab insert` : `↑↓ choose · ${rows.length} items · tab complete`)) : undefined,
  )
}

/**
 * The prompt box: TUI-local slash commands handled locally, other lines
 * dispatched; input editing keeps a cursor with history and completion.
 * While a modal (approval / question / model panel) owns the keys, the
 * box passes every key through untouched.
 */
function Input({ active, frozen, busy, descriptors, skills, dispatch, steer, interrupt, quit, openModel, openEffort, openHelp, openMode, openPermission, openResume, openPlugin, openStatusline, openTheme, openHistory, createSession, cancelSessionSwitch, notify, hasNotice, dismissNotice, toggleReasoning, openVerbose, clearView, refresh, loadMentions, cyclePermission, exportTranscript, renameTitle, recallSpace, recordLocal, recordHistory, queued, cancelQueued, historyFill, historyConsumed, waveTier, waveStyle }: {
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
  openEffort(): void
  openHelp(): void
  openMode(): void
  openPermission(): void
  openResume(): void
  openPlugin(query?: string): void
  openStatusline(): void
  openTheme(): void
  openHistory(): void
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
  /** Newest-first recall space (persistent + in-session, deduped). */
  recallSpace: readonly string[]
  /** Record one in-session submission (deduped, local only). */
  recordLocal(text: string): void
  /** Persist one submission to the global history file. */
  recordHistory(text: string): void
  /** Live queued inbox rows; Delete on the empty composer cancels the newest. */
  queued: readonly { messageId: string; target: 'next-turn' | 'next-step'; text: string }[]
  /** Cancel one queued inbox message by identity. */
  cancelQueued(messageId: string): void
  /** Accepted /history entry waiting to be placed into the composer. */
  historyFill: { text: string; index: number } | undefined
  /** Marks the accepted entry consumed (called after the fill is applied). */
  historyConsumed(): void
  /** DeepSeek easter-egg wave tier of the applied official DeepSeek model
   * (null otherwise): drives the persistent prompt glyph/accent and the
   * sparkle tier. */
  waveTier: DeepseekWaveTier | null
  /** The ignition style running, if any: Wave / Aurora / Pulse. */
  waveStyle: DeepseekWaveStyle | null
}): ReactElement {
  const columns = useStdout().stdout?.columns ?? 80
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  // Codex shell-style recall: the navigation cursor, the saved draft restored
  // on Down past the newest entry, and the boundary-gate anchor.
  const recall = useRef<RecallState>({ entries: [], index: null, savedDraft: '', lastRecalled: null })

  // A /history panel acceptance lands as a fill: place the text at the end of
  // the composer and resume recall from that entry.
  useEffect(() => {
    if (historyFill === undefined) return
    setValue(historyFill.text)
    setCursor(historyFill.text.length)
    setDismissedMenuValue(undefined)
    recall.current = {
      entries: recallSpace,
      index: historyFill.index,
      savedDraft: historyFill.text,
      lastRecalled: historyFill.text,
    }
    historyConsumed()
  }, [historyFill, recallSpace, historyConsumed])

  // Keep the navigation's recall space fresh while browsing state survives
  // (new local submissions extend the space; the index stays valid unless
  // the space shrank, in which case browsing ends at the current position).
  if (recall.current.entries !== recallSpace) {
    const index = recall.current.index === null || recall.current.index < recallSpace.length
      ? recall.current.index
      : null
    recall.current = { ...recall.current, entries: recallSpace, index }
  }
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

  /** Accept the highlighted completion-menu candidate into the draft. */
  const acceptMenuCandidate = (): void => {
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
  }

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
    // Delete on the empty composer cancels the newest queued message (the
    // web queue-mirror contract: the durable splice drops the pending row).
    if (key.delete && value === '' && queued.length > 0) {
      cancelQueued(queued[queued.length - 1]!.messageId)
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
      // Enter on an open completion menu accepts the highlighted candidate
      // (Codex list parity: Tab and Enter are both accept keys — many users
      // never discover Tab) — UNLESS the draft already spells one candidate
      // exactly, in which case Enter submits it (typing a full "/effort" and
      // pressing return must run the command, not re-accept its own text).
      if (menuActive) {
        const exactSlash = !mentionActive && !pathActive && candidates.some(candidate => candidate.label === value)
        if (!exactSlash) {
          acceptMenuCandidate()
          return
        }
      }
      const text = value.trim()
      setValue('')
      setCursor(0)
      setCompletionIndex(0)
      setDismissedMenuValue(undefined)
      if (text === '') return
      dismissNotice()
      // Global recall records non-slash submissions only (slash lines are
      // commands, not prompts) — Codex record_local_submission semantics;
      // the submission resets any active recall browsing.
      if (!text.startsWith('/')) {
        recordLocal(text)
        recordHistory(text)
      }
      recall.current = { entries: recallSpace, index: null, savedDraft: '', lastRecalled: null }
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
      if (text === '/effort' || text.startsWith('/effort ')) {
        openEffort()
        return
      }
      if (text === '/permission') {
        openPermission()
        return
      }
      if (text.startsWith('/permission ')) {
        dispatch(text)
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
      if (text === '/theme') {
        openTheme()
        return
      }
      if (text === '/history') {
        openHistory()
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
      // Claude-Code shell recall: Up always walks the global history (the
      // current draft is saved for Down-past-newest restore); the boundary
      // gate from Codex only blocks interior multiline movement, which the
      // user experience here deliberately skips.
      if (recall.current.entries.length === 0) return
      const step = recallOlder(recall.current, value)
      recall.current = step.state
      if (step.entry !== undefined) {
        setValue(step.entry)
        setCursor(step.entry.length)
        setDismissedMenuValue(undefined)
      }
      return
    }
    if (key.downArrow) {
      if (recall.current.entries.length === 0) return
      const step = recallNewer(recall.current)
      recall.current = step.state
      if (step.entry !== undefined) {
        setValue(step.entry)
        setCursor(step.entry.length)
        setDismissedMenuValue(undefined)
      }
      return
    }
    if (key.tab && menuActive) {
      acceptMenuCandidate()
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

  // The DeepSeek easter-egg wave owns its 33ms tick HERE instead of in App:
  // the interval re-renders only the composer row at 30fps, never the whole
  // tree. App drives the tier/style pair on a model switch; this local effect
  // starts the sweep whenever that pair changes (App picks a NEW random style
  // for every replay — including effort changes on the same route — so the
  // pair always differs when a new wave should run) and stops it when the
  // model leaves the official DeepSeek route (tier becomes null).
  const [waveTick, setWaveTick] = useState<number | null>(null)
  const wavePrevious = useRef<{ tier: DeepseekWaveTier | null; style: DeepseekWaveStyle | null }>({ tier: null, style: null })
  useEffect(() => {
    const previous = wavePrevious.current
    wavePrevious.current = { tier: waveTier, style: waveStyle }
    if (waveTier === null) {
      setWaveTick(null)
      return
    }
    if (previous.tier !== waveTier || previous.style !== waveStyle) {
      setWaveTick(0)
    }
  }, [waveTier, waveStyle])
  const waveActive = waveTick !== null && waveTier !== null && waveStyle !== null
    && waveTick * DEEPSEEK_WAVE_TICK_MS < deepseekWaveDuration(waveTier, waveStyle)
  useEffect(() => {
    if (!waveActive) return
    const id = setInterval(() => {
      setWaveTick(current => (current === null ? 0 : current + 1))
    }, DEEPSEEK_WAVE_TICK_MS)
    return () => {
      clearInterval(id)
    }
  }, [waveActive])
  useEffect(() => {
    if (waveTick !== null && waveTier !== null && waveStyle !== null
      && waveTick * DEEPSEEK_WAVE_TICK_MS >= deepseekWaveDuration(waveTier, waveStyle)) setWaveTick(null)
  }, [waveTick, waveTier, waveStyle])

  // Every exclusive panel keeps the composer as a stable visual anchor, but
  // freezes it to one row: no menu, multiline wrap, or animation.
  const tierActive = waveTier !== null
  const tierHues = waveTier === null ? null : deepseekWaveHues(waveTier)
  const promptColor = tierHues === null ? inkColor(getPalette().brand) : inkColor(tierHues[0])
  const promptGlyph = waveTier === 'flash' ? '›' : waveTier === 'deepseek' ? '»' : '❯'
  if (frozen) {
    const frozen = value === ''
      ? 'type a message'
      : verboseLine(value, Math.max(1, columns - 6))
    return createElement(
      Box,
      { width: Math.max(1, columns - 1), borderStyle: 'round', borderColor: inkColor(getPalette().dim), paddingX: 1 },
      createElement(
        Text,
        { wrap: 'truncate-end' },
        createElement(Text, { color: promptColor, bold: tierActive ? true : undefined }, busy ? '… ' : `${promptGlyph} `),
        frozen,
      ),
    )
  }

  // The bordered frame: static dim at rest; while the wave runs the border
  // breathes with the sweep (dim blends toward the tier accent and back), so
  // the frame glows up while the crest crosses the row.
  const frame = (row: ReactElement, borderRgb?: RgbTriple): ReactElement => createElement(
    Box,
    { width: Math.max(1, columns - 1), borderStyle: 'round', borderColor: inkColor(borderRgb ?? getPalette().dim), paddingX: 1 },
    row,
  )
  const menu = createElement(CompletionMenu, {
    active: menuActive,
    mention: mentionActive,
    index: completionIndex,
    rows: menuRows,
  })

  // Static row (idle, busy, or after the wave): prompt + editor window. The
  // prompt marker keeps the tier accent while an official DeepSeek model is
  // applied, restoring the static brand ❯ on any other route.
  const editor = editorWindow(value, cursor, Math.max(1, columns - 6))
  const staticRow = createElement(
    Text,
    { wrap: 'truncate-end' },
    busy
      ? createElement(BusyChase)
      : createElement(Text, { color: promptColor, bold: tierActive ? true : undefined }, `${promptGlyph} `),
    value === '' ? undefined : editor.before,
    createElement(CursorBlock, { char: editor.caret }),
    value === '' && !busy
      ? createElement(Text, { dimColor: true }, COMPOSER_PLACEHOLDER)
      : editor.after,
  )

  // Wave row: the input row assembled column by column, each cell carrying
  // the sampled wave `backgroundColor` (null outside the crest → transparent),
  // so the crest sweeps the FULL content row — prompt, draft, cursor,
  // placeholder, and the trailing blank fill. The deepseek tier drops the
  // `· ✦ ✧` sparkles into the rightmost blank cell from 900ms on.
  const waveRow = (): ReactElement => {
    const contentWidth = Math.max(1, columns - 5)
    const waveEditor = editorWindow(value, cursor, Math.max(1, contentWidth - 2))
    const hues = deepseekWaveHues(waveTier!)
    const style = waveStyle!
    const base = getTheme() === 'light' ? WAVE_BASE_LIGHT : WAVE_BASE_DARK
    const waveBg = (column: number): string | undefined => {
      const rgb = deepseekWaveColumnBg(waveTick!, column, contentWidth, waveTier!, style, hues, base)
      return rgb === null ? undefined : inkColor(rgb)
    }
    const cells: ComposerCell[] = []
    cells.push({ char: promptGlyph, color: promptColor, bold: true, backgroundColor: waveBg(0) })
    cells.push({ char: ' ', color: promptColor, backgroundColor: waveBg(1) })
    for (const char of waveEditor.before) {
      cells.push({ char, backgroundColor: waveBg(cells.length) })
    }
    cells.push({ char: waveEditor.caret, inverse: true, backgroundColor: waveBg(cells.length) })
    if (value === '' && !busy) {
      for (let at = 0; at < COMPOSER_PLACEHOLDER.length; at += 1) {
        cells.push({ char: COMPOSER_PLACEHOLDER[at]!, dim: true, backgroundColor: waveBg(cells.length) })
      }
    } else {
      for (const char of waveEditor.after) {
        cells.push({ char, backgroundColor: waveBg(cells.length) })
      }
    }
    while (cells.length < contentWidth) {
      cells.push({ char: ' ', backgroundColor: waveBg(cells.length) })
    }
    // The brand wordmark rides the wave's middle: `deepseek` in the tier's
    // cycled hues, placed in the row's mid-section and only over blank or
    // placeholder cells — real draft text is never covered.
    if (deepseekWaveWordVisible(waveTick!, waveTier!, style)) {
      const word = 'deepseek'
      const start = Math.max(2, Math.floor((contentWidth - word.length) / 2))
      let clear = true
      for (let at = 0; at < word.length; at += 1) {
        const cell = cells[start + at]
        if (cell === undefined || (cell.char !== ' ' && cell.dim !== true)) { clear = false; break }
      }
      if (clear) {
        for (let at = 0; at < word.length; at += 1) {
          const cell = cells[start + at]!
          cell.char = word[at]!
          cell.color = inkColor(deepseekWaveWordHue(at, hues))
          cell.bold = true
          cell.dim = false
        }
      }
    }
    // The tail sparkles belong to the Wave style's deepseek tier only
    // (Codex paints spark_frame on Wave+Ultra).
    if (waveTier === 'deepseek' && style === 'wave') {
      const spark = deepseekWaveSpark(waveTick!)
      if (spark !== null) {
        const last = cells[cells.length - 1]
        if (last !== undefined && last.char === ' ') {
          last.char = spark
          last.color = promptColor
          last.bold = true
          last.dim = false
        }
      }
    }
    const borderRgb = deepseekWaveBorderColor(waveTick!, waveTier!, style, hues, getPalette().dim)
    return frame(createElement(Text, { wrap: 'truncate-end' }, ...waveRowSpans(cells)), borderRgb)
  }

  return createElement(
    Box,
    { flexDirection: 'column' },
    menu,
    waveTick !== null && waveTier !== null && !busy ? waveRow() : frame(staticRow),
  )
}

/** One cached settled row: the row Box plus its roomy-prompt spacers. */
interface SettledRowRecord {
  /** The row Box element (keyed by the entry's settled index). */
  box: ReactElement
  /** The roomy-prompt spacer BEFORE the row, or undefined. */
  before: ReactElement | undefined
  /** The roomy-prompt spacer AFTER the row, or undefined. */
  after: ReactElement | undefined
  /** Whether the row's text depends on the reasoning toggle (Ctrl+R). */
  reasonSensitive: boolean
  /** The toggle state the row was built with. */
  showReasoning: boolean
}

/** The incremental settled-history cache (see `computeSettledRows`). */
interface SettledRowsCache {
  /** The exact settled entries the cache covers (`view.entries[0..entries.length)`). */
  entries: TranscriptEntry[]
  /** Records keyed by entry identity; mutated in place so the append path
   * never copies the whole map. */
  records: Map<TranscriptEntry, SettledRowRecord>
  /** The header element (depends only on `resumed`). */
  header: ReactElement
  /** The `resumed` the header was built with. */
  resumed: boolean
  /** The toggle state the rows were built with. */
  showReasoning: boolean
  /** The refreshEpoch the rows were built for; a bump forces a full rebuild. */
  epoch: number
  /** The flat row list (header + per-entry before/box/after). */
  flat: ReactElement[]
}

/** One step of `computeSettledRows`. */
interface SettledRowsResult {
  cache: SettledRowsCache
  /** How many rows had to be BUILT by this step (0 = pure reuse). */
  built: number
}

/** Build one settled row (row Box plus its roomy-prompt spacers). */
function buildSettledRow(entry: TranscriptEntry, index: number, showReasoning: boolean): SettledRowRecord {
  const row = createElement(EntryLine, { entry, showReasoning, verbose: false })
  const roomyPrompt = entry.kind === 'user' && !entry.notice
  return {
    box: createElement(Box, { key: index, paddingX: 1 }, row),
    before: roomyPrompt
      ? createElement(Box, { key: `prompt-before-${index}`, paddingX: 1 }, createElement(Text, null, ' '))
      : undefined,
    after: roomyPrompt
      ? createElement(Box, { key: `prompt-after-${index}`, paddingX: 1 }, createElement(Text, null, ' '))
      : undefined,
    reasonSensitive: entry.kind === 'assistant' && entry.reasoning !== '',
    showReasoning,
  }
}

/**
 * The settled `<Static>` row set as a PURE incremental state machine (App
 * drives it from the memo; tests drive it directly and read `built`).
 *
 * The settled prefix is permanently final: the projection only APPENDS below
 * the flush boundary, removes pending rows at or beyond it, and replaces
 * running tool/retry/command rows there too. So extending the cache never
 * rescans the old prefix — a grown boundary builds ONLY the newly settled
 * suffix and reuses every cached element, letting React bail out of unchanged
 * rows and keeping long histories out of the per-durable-event path (no O(N)
 * rebuild of rows, Map, or MarkdownBody parses). `records` is mutated in place
 * on the append/toggle paths to stay O(delta).
 *
 * Full rebuilds run only on the rare, deliberate paths: no cache yet, a
 * source-backed replay (`epoch` bump: resize / Ctrl+L / Ctrl+R remounts
 * `<Static>` and must re-flush the CURRENT rows), a `resumed` change, or a shrink
 * (`store.reset`). A reasoning toggle rebuilds only the rows whose text
 * depends on it, preserving the other rows' element identity.
 */
export function computeSettledRows(
  previous: SettledRowsCache | undefined,
  entries: readonly TranscriptEntry[],
  settled: number,
  showReasoning: boolean,
  resumed: boolean,
  epoch: number,
): SettledRowsResult {
  if (previous === undefined || previous.epoch !== epoch || previous.resumed !== resumed
    || settled < previous.entries.length) {
    // Full rebuild from the current settled prefix.
    const records = new Map<TranscriptEntry, SettledRowRecord>()
    const flat: ReactElement[] = [createElement(Header, { key: 'header', resumed })]
    for (let index = 0; index < settled; index++) {
      const entry = entries[index]
      const record = buildSettledRow(entry, index, showReasoning)
      records.set(entry, record)
      if (record.before !== undefined) flat.push(record.before)
      flat.push(record.box)
      if (record.after !== undefined) flat.push(record.after)
    }
    return {
      cache: { entries: entries.slice(0, settled), records, header: flat[0]!, resumed, showReasoning, epoch, flat },
      built: settled,
    }
  }
  if (previous.showReasoning !== showReasoning) {
    // Reasoning toggle: only rows whose text depends on it rebuild; spacers
    // and the other rows keep their element identity.
    const records = previous.records
    const flat: ReactElement[] = [previous.header]
    let built = 0
    for (let index = 0; index < previous.entries.length; index++) {
      const entry = previous.entries[index]
      const record = records.get(entry)!
      const current = record.reasonSensitive
        ? {
          ...record,
          box: createElement(Box, { key: index, paddingX: 1 }, createElement(EntryLine, { entry, showReasoning, verbose: false })),
          showReasoning,
        }
        : record
      if (current !== record) {
        records.set(entry, current)
        built += 1
      }
      if (current.before !== undefined) flat.push(current.before)
      flat.push(current.box)
      if (current.after !== undefined) flat.push(current.after)
    }
    return { cache: { ...previous, records, showReasoning, flat }, built }
  }
  if (settled === previous.entries.length) {
    // Nothing below the boundary changed (a pending retirement above it, a
    // tool/result at the boundary): keep the SAME flat identity so the
    // memoized <Static> subtree does not re-render at all.
    return { cache: previous, built: 0 }
  }
  // The boundary grew: build ONLY the newly settled suffix.
  const records = previous.records
  const suffix: TranscriptEntry[] = []
  const added: ReactElement[] = []
  for (let index = previous.entries.length; index < settled; index++) {
    const entry = entries[index]
    const record = buildSettledRow(entry, index, showReasoning)
    records.set(entry, record)
    suffix.push(entry)
    if (record.before !== undefined) added.push(record.before)
    added.push(record.box)
    if (record.after !== undefined) added.push(record.after)
  }
  return {
    cache: {
      entries: previous.entries.concat(suffix),
      records,
      header: previous.header,
      resumed: previous.resumed,
      showReasoning,
      epoch: previous.epoch,
      flat: previous.flat.concat(added),
    },
    built: settled - previous.entries.length,
  }
}

/** The whole terminal app; state arrives via the store, output via Ink. */
export function App(props: AppProps): ReactElement {
  const view = useSyncExternalStore(props.store.subscribe, props.store.getView)
  // getSnapshot must be a STABLE reference (the React contract): an inline
  // arrow here re-subscribes the store hook on every render and cascades
  // force-updates — during a fast reasoning stream that chain crossed React's
  // nested-passive-update limit and flooded "Maximum update depth exceeded"
  // warnings. The view objects are process-stable, so one callback per view
  // identity is enough.
  // getSnapshot should be a stable reference (the React contract): an inline
  // arrow re-subscribes the store hook on every render and forces the uETS
  // consistency check to re-run per commit. The view objects are
  // process-stable, so one callback per view identity is enough.
  const readDescriptors = useCallback(() => props.commands.descriptors, [props.commands])
  const readSkills = useCallback(() => props.skills.rows, [props.skills])
  const descriptors = useSyncExternalStore(props.commands.subscribe, readDescriptors)
  const skills = useSyncExternalStore(props.skills.subscribe, readSkills)
  const [modelLabel, setModelLabel] = useState(props.model)
  const [modelOpen, setModelOpen] = useState(false)
  /** Nested /model stages; only one owns terminal input at a time. */
  const [providerOpen, setProviderOpen] = useState(false)
  const [providerAction, setProviderAction] = useState<{
    kind: 'credential' | 'unset' | 'remove'
    target: ProviderTargetView
  } | undefined>(undefined)
  /** The model row whose effort levels the /model stage lists; undefined shows the model list. */
  const [effortFor, setEffortFor] = useState<ModelRow | undefined>(undefined)
  /** Effective reasoning effort, shown in the /model picker and switch notice. */
  const [effortLabel, setEffortLabel] = useState<string | undefined>(props.effort)
  /** DeepSeek easter egg: switching INTO an official DeepSeek route plays
   * one of Codex's three ignition styles (Wave / Aurora / Pulse, picked at
   * random without repeating) across the composer's padded band (33ms tick,
   * per-style durations), then the band returns to static while the prompt
   * marker keeps the tier accent. The trigger follows the applied model
   * label (what the status bar actually shows), never the initial paint,
   * and the tier is derived from the label and cached at the switch. The
   * 33ms tick itself lives inside Input, so the sweep re-renders only the
   * composer row, not the whole tree, at 30fps; App owns the rarely-changing
   * tier/style and Input starts the sweep whenever that pair changes. */
  const [waveTier, setWaveTier] = useState<DeepseekWaveTier | null>(null)
  const [waveStyle, setWaveStyle] = useState<DeepseekWaveStyle | null>(null)
  const previousModel = useRef<string | undefined>(undefined)
  const previousEffort = useRef<string | undefined>(props.effort)
  const previousStyle = useRef<DeepseekWaveStyle | undefined>(undefined)
  useEffect(() => {
    const previous = previousModel.current
    previousModel.current = modelLabel
    // The wave replays when the applied model changes OR its effort level
    // changes on the same official DeepSeek route (Codex replays the
    // ignition on effort changes too).
    const effortChanged = previousEffort.current !== effortLabel
    previousEffort.current = effortLabel
    const modelChanged = previous !== undefined && previous !== modelLabel
    if (!isOfficialDeepSeekLabel(modelLabel)) {
      setWaveTier(null)
      setWaveStyle(null)
      return
    }
    if (modelChanged || effortChanged) {
      setWaveTier(deepseekWaveTier(modelLabel))
      const nextStyle = deepseekWaveStyleRandom(previousStyle.current)
      previousStyle.current = nextStyle
      setWaveStyle(nextStyle)
    }
  }, [modelLabel, effortLabel])
  const [directory, setDirectory] = useState<ModelDirectory | undefined>(undefined)
  const [modelError, setModelError] = useState<string | undefined>(undefined)
  const [providerDirectory, setProviderDirectory] = useState<ProviderSettingsDirectory | undefined>(undefined)
  const [providerError, setProviderError] = useState<string | undefined>(undefined)
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
  useEffect(() => {
    if (!modelOpen || props.loadModelProviders === undefined) return
    let cancelled = false
    setProviderDirectory(undefined)
    setProviderError(undefined)
    Promise.resolve().then(() => props.loadModelProviders!()).then((loaded) => {
      if (!cancelled) setProviderDirectory(loaded)
    }, (error: unknown) => {
      if (!cancelled) setProviderError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
    }
  }, [modelOpen, modelLoadEpoch, props.loadModelProviders])
  useEffect(() => {
    const subscribe = props.subscribeModelProviders
    if (!modelOpen || subscribe === undefined) return
    try {
      return subscribe(() => setModelLoadEpoch(epoch => epoch + 1))
    } catch (error: unknown) {
      setProviderError(error instanceof Error ? error.message : String(error))
    }
  }, [modelOpen, props.subscribeModelProviders])

  const busy = view.busy
  const [showReasoning, setShowReasoning] = useState(false)
  const [verboseOpen, setVerboseOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  const [permissionOpen, setPermissionOpen] = useState(false)
  const [resumeOpen, setResumeOpen] = useState(false)
  const [pluginOpen, setPluginOpen] = useState(false)
  const [pluginQuery, setPluginQuery] = useState('')
  const [statuslineOpen, setStatuslineOpen] = useState(false)
  const [statuslineItems, setStatuslineItems] = useState<readonly StatusItemId[]>(() => parseStatuslineItems(props.statusline))
  const [themeOpen, setThemeOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  /** The /history panel's accepted entry: text plus its recall-space index. */
  const [historyFill, setHistoryFill] = useState<{ text: string; index: number } | undefined>(undefined)
  /** Submissions recorded in this process (Codex local history; persistent file stays in the runner). */
  const [localHistory, setLocalHistory] = useState<readonly string[]>([])
  const recordLocal = useCallback((text: string): void => {
    setLocalHistory(current => recordLocalEntry(current, text))
  }, [])
  /** Newest-first recall space shared by the composer and the /history panel. */
  const recallSpace = useMemo(
    () => recallEntries(props.history, localHistory),
    [props.history, localHistory],
  )
  const historyConsumed = useCallback((): void => {
    setHistoryFill(undefined)
  }, [])
  /** The append-only flush boundary (see `settledEntryCount`): entries below
   * this index are final and ride the `<Static>` scrollback; everything at or
   * beyond stays in the live tree. Pending inbox rows always live at
   * index >= settled, so the queued-inbox scan below only walks the mutable
   * tail instead of the whole history. */
  const settled = useMemo(() => settledEntryCount(view.entries), [view.entries])
  /** Live queued inbox rows (event-sourced from `agent/inbox/spliced`). The
   * projection only appends and removes pending rows at index >= settled, so
   * a bounded tail scan replaces an unconditional O(history) filter on every
   * event. */
  const queuedRows = useMemo(() => {
    const rows: Array<Extract<TranscriptEntry, { kind: 'pending' }>> = []
    for (let index = settled; index < view.entries.length; index++) {
      const entry = view.entries[index]
      if (entry.kind === 'pending') rows.push(entry)
    }
    return rows
  }, [view.entries, settled])
  const [refreshEpoch, setRefreshEpoch] = useState(0)
  const approvalSnapshot = useSyncExternalStore(props.approval.subscribe, props.approval.getSnapshot)
  const questionSnapshot = useSyncExternalStore(props.questions.subscribe, props.questions.getSnapshot)
  const approvalPending = approvalSnapshot.pending !== undefined
  const questionPending = questionSnapshot.pending !== undefined
  // While any modal owns the keys, the prompt box passes everything through.
  const inputActive = !modelOpen && !helpOpen && !modeOpen && !permissionOpen && !resumeOpen && !pluginOpen && !statuslineOpen && !themeOpen && !historyOpen && !verboseOpen && !approvalPending && !questionPending

  // Human questions outrank local inspectors. Close the lower modal instead
  // of leaving an approval/question visible but keyboard-locked behind it.
  useEffect(() => {
    if (!approvalPending && !questionPending) return
    setModelOpen(false)
    setProviderOpen(false)
    setProviderAction(undefined)
    setEffortFor(undefined)
    setHelpOpen(false)
    setModeOpen(false)
    setPermissionOpen(false)
    setResumeOpen(false)
    setPluginOpen(false)
    setStatuslineOpen(false)
    setThemeOpen(false)
    setHistoryOpen(false)
    setVerboseOpen(false)
  }, [approvalPending, questionPending])

  // Append-only transcript: everything up to the first still-mutable entry
  // (a running tool/retry/command) flushes through Ink's `<Static>` into native
  // scrollback and is normally never rewritten — the Claude-Code stability
  // contract that lets arbitrarily long conversations scroll instead of
  // freezing when the live tree exceeds the terminal height. The dynamic
  // region below stays small: the streaming tail, modals, composer, and its
  // status footer. `assistant/chunk` preserves `entries` identity.
  //
  // `computeSettledRows` extends the cached row set incrementally: the
  // settled prefix is permanently final, so a grown boundary builds ONLY the
  // newly settled suffix and reuses every cached element — long histories
  // stop re-creating rows (and re-parsing MarkdownBody) on every durable
  // event. A source-backed replay (`refreshEpoch` bump: resize / Ctrl+L /
  // Ctrl+R remounts `<Static>`) rebuilds the CURRENT row set from index 0,
  // so the replay stays complete and never ghosts a pending/running tail.
  const settledRowsCache = useRef<SettledRowsCache | undefined>(undefined)
  const settledRows = useMemo(() => {
    const result = computeSettledRows(
      settledRowsCache.current,
      view.entries,
      settled,
      showReasoning,
      props.resumed,
      refreshEpoch,
    )
    settledRowsCache.current = result.cache
    return result.cache.flat
  }, [view.entries, settled, showReasoning, props.resumed, refreshEpoch])

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
  const transcriptVisible = !modelOpen && !helpOpen && !modeOpen && !permissionOpen && !resumeOpen && !pluginOpen && !statuslineOpen && !themeOpen && !historyOpen && !verboseOpen && !approvalPending && !questionPending
  const inspectorVisible = verboseOpen && !approvalPending && !questionPending
  const modalVisible = modelOpen || helpOpen || modeOpen || permissionOpen || resumeOpen || pluginOpen || statuslineOpen || themeOpen || historyOpen || inspectorVisible || approvalPending || questionPending
  const closeInspector = useCallback((): void => {
    setVerboseOpen(false)
  }, [])
  const refreshScreen = (): void => {
    if (appStdout !== undefined) appStdout.write('\x1b[2J\x1b[3J\x1b[H')
    setRefreshEpoch(epoch => epoch + 1)
  }

  /** Apply one /model pick: record the selection, close the panel, report via notice. */
  const applyModel = (row: ModelRow, effortId: string | undefined): void => {
    try {
      const label = props.selectModel(row, effortId)
      setModelLabel(label)
      setEffortLabel(effortId)
      notify(`model → next step uses ${label}${effortId === undefined || effortId === '' ? '' : `@${effortId}`}`)
      setModelOpen(false)
      setProviderOpen(false)
      setProviderAction(undefined)
      setEffortFor(undefined)
    } catch (error: unknown) {
      notify(`model switch failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  const reloadModelSurfaces = (): void => {
    setModelLoadEpoch(epoch => epoch + 1)
  }
  const closeModelSurface = (): void => {
    setModelOpen(false)
    setProviderOpen(false)
    setProviderAction(undefined)
    setEffortFor(undefined)
  }
  let modelSurface: ReactElement | undefined
  if (modelOpen && !approvalPending && !questionPending) {
    if (providerAction?.kind === 'credential' && props.saveModelProviderCredential !== undefined) {
      modelSurface = createElement(ProviderCredentialPanel, {
        target: providerAction.target,
        save: props.saveModelProviderCredential,
        done: () => {
          const target = providerAction.target
          setProviderAction(undefined)
          setProviderOpen(false)
          reloadModelSurfaces()
          notify(`API key saved for ${target.displayName}; select a model`)
        },
        back: () => setProviderAction(undefined),
      })
    } else if (providerAction?.kind === 'unset' && props.unsetModelProviderCredential !== undefined) {
      modelSurface = createElement(ProviderConfirmPanel, {
        target: providerAction.target,
        kind: 'credential',
        confirm: props.unsetModelProviderCredential,
        done: () => {
          const target = providerAction.target
          setProviderAction(undefined)
          setProviderOpen(true)
          reloadModelSurfaces()
          notify(`API key removed for ${target.displayName}`)
        },
        back: () => setProviderAction(undefined),
      })
    } else if (providerAction?.kind === 'remove' && props.removeModelProvider !== undefined) {
      modelSurface = createElement(ProviderConfirmPanel, {
        target: providerAction.target,
        kind: 'provider',
        confirm: props.removeModelProvider,
        done: () => {
          const target = providerAction.target
          setProviderAction(undefined)
          setProviderOpen(true)
          reloadModelSurfaces()
          notify(`provider removed: ${target.displayName}`)
        },
        back: () => setProviderAction(undefined),
      })
    } else if (providerOpen) {
      modelSurface = createElement(ProviderPanel, {
        directory: providerDirectory,
        error: providerError,
        onCredential: (target: ProviderTargetView) => {
          if (props.saveModelProviderCredential === undefined) {
            notify('API key storage is unavailable in this profile', 'warning')
            return
          }
          setProviderAction({ kind: 'credential', target })
        },
        onUnset: (target: ProviderTargetView) => {
          if (props.unsetModelProviderCredential === undefined) {
            notify('API key removal is unavailable in this profile', 'warning')
            return
          }
          setProviderAction({ kind: 'unset', target })
        },
        onRemove: (target: ProviderTargetView) => {
          if (props.removeModelProvider === undefined) {
            notify('provider removal is unavailable in this profile', 'warning')
            return
          }
          setProviderAction({ kind: 'remove', target })
        },
        onRetry: reloadModelSurfaces,
        onBack: () => setProviderOpen(false),
      })
    } else if (effortFor !== undefined) {
      modelSurface = createElement(EffortPanel, {
        row: effortFor,
        current: effortLabel,
        select: (effortId: string) => applyModel(effortFor, effortId),
        back: () => setEffortFor(undefined),
      })
    } else {
      modelSurface = createElement(ModelPanel, {
        directory,
        error: modelError,
        onSelect: (row: ModelRow) => {
          // A model advertising several levels opens the effort stage first;
          // one advertised level is its only option, while no capability uses
          // the model default exactly as before.
          if (row.reasoning !== undefined && row.reasoning.efforts.length > 1) {
            setEffortFor(row)
            return
          }
          const effortId = row.reasoning?.efforts.length === 1 ? row.reasoning.efforts[0]!.id : undefined
          applyModel(row, effortId)
        },
        ...(props.loadModelProviders === undefined || props.saveModelProviderCredential === undefined
          ? {}
          : { onProviders: () => setProviderOpen(true) }),
        onRetry: reloadModelSurfaces,
        onClose: closeModelSurface,
      })
    }
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
        // The two-column gutter matches the composer's border + padding, so
        // message text aligns with the input cursor (Codex LIVE_PREFIX).
        { flexDirection: 'column', paddingX: 2 },
        visibleLiveLines.length === 0 ? undefined : createElement(StyledRows, { lines: visibleLiveLines }),
        view.streamingReasoning !== '' && reasoningRows > 0
          ? createElement(StreamTail, {
            text: showReasoning ? view.streamingReasoning : 'Thinking…',
            prefix: '✻ ',
            continuationPrefix: '  ',
            dim: true,
            maxRows: reasoningRows,
          })
          : undefined,
        view.streaming !== '' && answerRows > 0
          ? createElement(
            StreamTail,
            // The same two-column gutter as settled replies: streamed text
            // lands exactly where the assembled message will render.
            { text: view.streaming, dim: false, maxRows: answerRows, prefix: '  ' },
            busy ? createElement(Caret) : undefined,
          )
          : undefined,
        deepDivingVisible ? createElement(DeepDivingLine, { since: view.busySince }) : undefined,
      )
      : undefined,
    transcriptVisible ? createElement(TodoPanel, { todos: view.todos }) : undefined,
    createElement(QuestionBar, { store: props.questions, snapshot: questionSnapshot, locked: false }),
    createElement(ApprovalBar, { snapshot: approvalSnapshot, locked: questionPending, notify }),
    modelSurface,
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
    permissionOpen && !approvalPending && !questionPending
      ? createElement(PermissionPanel, {
        current: props.permission,
        load: props.loadPermissions,
        select: (id: string) => {
          try {
            const selected = props.setPermission(id)
            notify(`permission → ${selected}`)
            setPermissionOpen(false)
          } catch (reason: unknown) {
            notify(`permission change failed: ${reason instanceof Error ? reason.message : String(reason)}`, 'error')
          }
        },
        close: () => setPermissionOpen(false),
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
    themeOpen && !approvalPending && !questionPending
      ? createElement(ThemePanel, {
        current: getTheme(),
        select: (name: ThemeName) => {
          // Apply immediately (module-level palette), persist through the
          // runner, then close: the close re-render paints with the new
          // palette. `auto` stores as requested; detection is a later step.
          setTheme(name)
          props.saveTheme?.(name)
          notify(`theme → ${name}`)
          setThemeOpen(false)
        },
        close: () => setThemeOpen(false),
      })
      : undefined,
    historyOpen && !approvalPending && !questionPending
      ? createElement(HistoryPanel, {
        entries: recallSpace,
        fill: (text: string, index: number) => {
          setHistoryFill({ text, index })
          setHistoryOpen(false)
        },
        close: () => setHistoryOpen(false),
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
          setProviderDirectory(undefined)
          setProviderError(undefined)
          setProviderOpen(false)
          setProviderAction(undefined)
          setEffortFor(undefined)
          setModelOpen(true)
        },
        openEffort: () => {
          // /effort adjusts the CURRENT model's reasoning: resolve it from
          // the live catalog, then open the same effort stage the /model
          // picker would. Match on the applied label (what the status bar
          // shows) — `props.model` may still carry the deployment default
          // until the next request header lands. The model-id fallback
          // prefers a reasoning-capable row (several routes may serve the
          // same id), and a capability-lookup failure reads as "retry",
          // never as "the model has no efforts" — the adapter advertises
          // levels for every deepseek model, so "no efforts" is almost
          // always a failed resolveModelInfo, not a fact.
          void props.loadModels().then((loaded) => {
            const [provider, model] = modelLabel.split('/')
            const row = loaded.rows.find(candidate => candidate.provider === provider && candidate.model === model)
              ?? loaded.rows.find(candidate => candidate.model === model && candidate.reasoning !== undefined)
              ?? loaded.rows.find(candidate => candidate.model === model)
            if (row === undefined) {
              notify('current model is not in the catalog', 'warning')
              return
            }
            const rowTag = `${row.provider}/${row.model}`
            if (loaded.reasoningFailures?.includes(rowTag) === true) {
              notify('reasoning levels temporarily unavailable (capability lookup failed) — try again', 'warning')
              return
            }
            if (row.reasoning === undefined || row.reasoning.efforts.length === 0) {
              notify('current model does not expose reasoning efforts', 'warning')
              return
            }
            setEffortFor(row)
            setModelOpen(true)
          }, (error: unknown) => {
            notify(`model lookup failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
          })
        },
        openHelp: () => {
          setHelpOpen(true)
        },
        openMode: () => setModeOpen(true),
        openPermission: () => setPermissionOpen(true),
        openResume: () => setResumeOpen(true),
        openPlugin: (query = '') => { setPluginQuery(query); setPluginOpen(true) },
        openStatusline: () => setStatuslineOpen(true),
        openTheme: () => setThemeOpen(true),
        openHistory: () => setHistoryOpen(true),
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
        recallSpace,
        recordLocal,
        recordHistory: props.recordHistory,
        queued: queuedRows,
        cancelQueued: props.cancelQueued,
        historyFill,
        historyConsumed,
        waveTier,
        waveStyle,
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
          permission: view.permission !== '' ? view.permission : props.permission,
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
