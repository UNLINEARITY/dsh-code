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

import { basename } from 'node:path'
import {
  createElement, memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement,
} from 'react'
import { Box, Static, Text, useInput, useStdin, useStdout, type Key } from 'ink'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import type { TodoItem } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionAnswerItem } from '@deepseek-ai/dsh-user-questions'
import type { AuthorizationInteraction, AuthorizationStatus } from '@deepseek-ai/dsh-authorization'
import {
  dim,
  getPalette,
  getTheme,
  inkColor,
  setTheme,
  type RgbTriple,
  type ThemeName,
} from './theme.ts'
import { ThemePanel } from './theme-panel.ts'
import { WHALE_GLYPH, WHALE_GLYPH_COLUMNS } from './whale-glyph.ts'
import { DSH_CODE_VERSION, dshKernelVersion } from './version.ts'
import type { TranscriptStore } from './store.ts'
import { settledEntryCount, type TranscriptEntry } from './render/projection.ts'
import { type MdSegment, visibleColumns } from './render/markdown.ts'
import {
  busyChaseFrame,
  BUSY_CHASE_TICK_MS,
  caretVisible,
  DEEP_DIVING_SHIMMER_TICK_MS,
  DEEPSEEK_WAVE_TICK_MS,
  deepseekWaveColumnBg,
  deepseekWaveDuration,
  deepseekWaveSpark,
  deepseekWaveStyleRandom,
  deepseekWaveTier,
  deepseekWaveWordHue,
  deepseekWaveWordVisible,
  deepDivingGradientColor,
  deepDivingSparkColor,
  effortAboveHigh,
  isOfficialDeepSeekLabel,
  type DeepseekWaveStyle,
  type DeepseekWaveTier,
} from './render/animations.ts'
import type { ApprovalSnapshot, ApprovalStore } from './approval.ts'
import type { CommandsView } from './commands.ts'
import type { ModelDirectory, ModelRow } from './models.ts'
import type { ProviderConfiguration, ProviderSettingsDirectory, ProviderTargetView } from './provider-settings.ts'
import type { QuestionSnapshot, QuestionStore } from './questions.ts'
import type { SkillsView, SkillRow } from './skills.ts'
import { isPathLikeMentionQuery, type MentionCandidate } from './mentions.ts'
import type { SubagentFeedView, SubagentRow } from './subagents.ts'
import { AgentsPanel, EffortPanel, HistoryPanel, JobsPanel, ModePanel, PermissionPanel, PluginPanel, ResumePanel, StatuslinePanel, runClock, SubagentPanel, type JobRow } from './kernel-panels.ts'
import type { PresetRow } from './presets.ts'
import type { PermissionRow } from './permissions.ts'
import type { PluginRow } from './plugin-inventory.ts'
import {
  beginRecall,
  recallEntries,
  recallNewer,
  recallOlder,
  recordLocalEntry,
  type RecallState,
} from './history.ts'
import type { SessionDirectoryOptions, SessionRow } from './session-directory.ts'
import type { GitDiffView } from './git-workflow.ts'
import {
  authorizationForProvider,
  providerAuthorizationStatus,
  type ProviderAuthorizationDirectory,
  type ProviderAuthorizationRow,
} from './authorization.ts'
import { ProviderAuthorizationLogoutPanel, ProviderAuthorizationPanel } from './authorization-panel.ts'
import {
  looksLikeImagePath,
  parsePastedImagePaths,
  type ImagePathInspection,
} from './attachments.ts'

/** Match Codex's settled-resize window before rebuilding terminal scrollback. */
const RESIZE_REFLOW_DELAY_MS = 75

/**
 * Cap on rendered settled history, in physical rows (header and hint
 * included). 3,000 rows sits inside Codex's 1k–10k reflow budget range:
 * replays stay under ~200ms while roughly a hundred messages stay visible
 * before the oldest drop out. `DSH_SETTLED_ROWS` overrides it; 0 disables
 * the cap entirely (the historical unbounded behavior).
 */
const SETTLED_ROW_CAP = readSettledRowCap()
/** Hysteresis: the cap may overflow by 25% before one trimming replay fires. */
/** Header rows plus the trim hint, reserved out of the row cap. */
const SETTLED_ROW_RESERVE = 12

/** Read the configurable settled-history cap once per process. */
function readSettledRowCap(): number {
  const raw = process.env.DSH_SETTLED_ROWS
  if (raw === undefined) return 3_000
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3_000
}

/**
 * Safety net for a bracketed paste whose end marker never arrives (terminal
 * defect or crash mid-paste): past this window the open-paste flag resets so
 * Enter submits again instead of inserting newlines forever.
 */
const PASTE_BRACKET_TIMEOUT_MS = 1_000

/** Reset region/style, clear the visible screen and scrollback, then home. */
const RESIZE_REFLOW_CLEAR = '\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H'
/** Ask terminals supporting DEC synchronized updates to hold the frame. */
const SYNCHRONIZED_UPDATE_BEGIN = '\x1b[?2026h'
/** Release the held frame after Ink has replayed the source-backed Static rows. */
const SYNCHRONIZED_UPDATE_END = '\x1b[?2026l'
import {
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
  isVsCodeTerminalEnv,
  normalizeKeyboardChunk,
  PASTE_END_MARKER,
  PASTE_START_MARKER,
  stripPasteMarkers,
  stripTerminalFocusEvents,
  tokenizeRawEditorChunk,
  type RawEditorToken,
} from './keyboard.ts'
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
  clampLiveAllocation,
  lineSegment,
  markdownLines,
  settledEntryLines,
  styledLines,
  textLines,
  transcriptEntryLines,
  type LineStyle,
  type StyledLine,
} from './render/lines.ts'
import {
  caretSite,
  clampCursor,
  composerMaxRows,
  deleteBackward,
  deleteForward,
  deleteLastGrapheme,
  deleteWordBackward,
  deleteWordForward,
  editorModel,
  editorRowParts,
  insertText,
  type EditResult,
  killToLineEnd,
  killToLineStart,
  moveCursorBy,
  moveCursorVertically,
  moveToLineEnd,
  moveToLineStart,
  moveWordLeft,
  moveWordRight,
  remapStableRange,
  replaceRangePreservingCursor,
  sanitizeDraftText,
  shouldRecallNavigate,
  splitGraphemes,
} from './render/editor.ts'

/** Visual priority for one bounded local notice. */
export type NoticeTone = 'info' | 'warning' | 'error'

/** One source of truth for TUI-owned slash commands in completion and `/help`. */
const LOCAL_COMMANDS = [
  { label: '/help', description: 'show this overlay' },
  { label: '/model', description: 'switch the model and manage providers' },
  { label: '/effort', description: 'adjust reasoning effort for the current model' },
  { label: '/mode', description: 'inspect or select the agent preset (/mode [preset])' },
  { label: '/permission', description: 'inspect or select the permission preset (/permission [preset])' },
  { label: '/new', description: 'create and switch to a fresh session (/new [preset])' },
  { label: '/fork', description: 'fork at the latest completed turn (/fork [event-seq])' },
  { label: '/resume', description: 'browse or switch root sessions (/resume [id|prefix])' },
  { label: '/plugin', description: 'inspect the live plugin composition' },
  { label: '/jobs', description: 'inspect background jobs' },
  { label: '/statusline', description: 'customize the status line items' },
  { label: '/theme', description: 'switch the color theme' },
  { label: '/history', description: 'search and recall past prompts' },
  { label: '/agents', description: 'inspect subagent sessions of this conversation' },
  { label: '/todos', description: 'inspect the full todo list' },
  { label: '/subagent', description: 'choose the model delegated subagents run on' },
  { label: '/vscode-keys', description: 'pass ctrl+r through the vs code terminal' },
  { label: '/delete', description: 'delete a session and its subagent threads' },
  { label: '/clear', description: 'clear the screen' },
  { label: '/export', description: 'export the transcript to markdown (/export [path])' },
  { label: '/title', description: 'rename this session (/title <text>)' },
  { label: '/copy', description: 'copy the latest assistant response' },
  { label: '/diff', description: 'inspect Git changes (/diff [--staged|ref])' },
  { label: '/review', description: 'review Git changes under read-only permissions' },
  { label: '/quit', description: 'exit' },
] as const

const LOCAL_COMMAND_NAMES = new Set(LOCAL_COMMANDS.map(command => command.label.slice(1)))

/** Props the runner hands the app; callbacks stay owned by the runner. */
export interface AppProps {
  /** Event-fed transcript store for the live session. */
  store: TranscriptStore
  /** Approval-question store fed by the answerer listener. */
  approval: ApprovalStore
  /** ask_user_question store fed by the single UI provider. */
  questions: QuestionStore
  /** Live subagent activity feed (child sessions of the current root). */
  subagents: SubagentFeedView
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
  dispatch(text: string, images?: readonly ImageBlock[]): void
  /** Submit steering: consumed at the running turn's next step boundary. */
  steer(text: string, images?: readonly ImageBlock[]): void
  /** Interrupt the running turn (Esc); true when a turn was cancelled. */
  interrupt(): boolean
  /** Quit: unmount, flush, and request process exit. */
  quit(): void
  /** Load the selectable model directory (called when /model opens). */
  loadModels(): Promise<ModelDirectory>
  /** Load @mention candidates for the typed query (files + sessions). */
  loadMentions(query: string, signal?: AbortSignal): Promise<readonly MentionCandidate[]>
  /** Validate draft image paths without committing attachment objects. */
  inspectImages(paths: readonly string[]): Promise<readonly ImagePathInspection[]>
  /** Validate, normalize and persist images immediately before submission. */
  prepareImages(paths: readonly string[], signal?: AbortSignal): Promise<readonly ImageBlock[]>
  /** Apply one /model selection (with an advertised reasoning effort, when picked); returns the display label. */
  selectModel(row: ModelRow, effortId?: string): string
  /** The /subagent override label, '' when delegated agents follow the current model. */
  subagentModel: string
  /** Apply one /subagent model pick; returns the override label. */
  setSubagentModel(row: ModelRow, effortId?: string): string
  /** Drop the /subagent override (delegated agents follow the current model). */
  clearSubagentModel(): void
  /** Delete one session subtree; resolves with the outcome line. */
  deleteSession(id: string): Promise<string>
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
  /** Save endpoint and explicit model capacities through the provider profile. */
  saveModelProviderConfiguration?(target: ProviderTargetView, configuration: ProviderConfiguration): Promise<void>
  /** Provider authorization flows and value-free stored-record facts. */
  loadProviderAuthorizations?(): Promise<ProviderAuthorizationDirectory>
  subscribeProviderAuthorizations?(listener: () => void): () => void
  beginProviderAuthorization?(
    row: ProviderAuthorizationRow,
    method: string,
    interaction: AuthorizationInteraction,
    signal: AbortSignal,
  ): Promise<AuthorizationStatus>
  cancelProviderAuthorization?(row: ProviderAuthorizationRow): void
  logoutProviderAuthorization?(row: ProviderAuthorizationRow): Promise<void>
  openAuthorizationUrl?(url: string): boolean
  copyTextValue?(text: string): Promise<void>
  /** Cycle to the next permission preset (Shift+Tab); returns the new label. */
  cyclePermission(): string
  /** Select or inspect a permission preset without requiring a pre-existing session. */
  setPermission(id: string): string
  /** Export the transcript to a markdown file (/export [path]); reports via notices. */
  exportTranscript(argument: string): Promise<void>
  /** Rename the session (/title <text>); returns the outcome line for the notice. */
  renameTitle(argument: string): string
  /** Copy the latest complete assistant response; resolves to notice text. */
  copyLastResponse(): Promise<string>
  /** Load a complete read-only Git diff for the file-oriented viewport. */
  loadGitDiff(argument: string): Promise<GitDiffView>
  /** Start a model review after applying the read-only permission preset. */
  reviewChanges(argument: string): void
  /** Preset/session/plugin kernel operations. */
  loadPresets(): Promise<readonly PresetRow[]>
  switchMode(id: string): Promise<string>
  /** Load the switchable permission presets for the /permission panel. */
  loadPermissions(): Promise<readonly PermissionRow[]>
  createSession(mode?: string): void
  /** Fork the active session at a completed-turn boundary. */
  forkSession(argument: string): void
  loadSessions(options: SessionDirectoryOptions, signal?: AbortSignal): Promise<readonly SessionRow[]>
  loadSessionTranscript(id: string, signal?: AbortSignal): Promise<string>
  /** Load this session's subagent conversations (children by lineage). */
  loadSubagents(): Promise<readonly SessionRow[]>
  switchSession(row: SessionRow): void
  cancelSessionSwitch(): boolean
  loadPlugins(): readonly PluginRow[]
  /** Caller-visible background jobs (the host jobs registry, read-only). */
  loadJobs(): readonly JobRow[]
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
  /** Apply the Ctrl+R terminal passthrough to the detected editor (/vscode-keys); resolves to a one-line summary. */
  applyEditorKeys(): Promise<string>
}

/** Pad text with spaces to a visible-column target (menu name column). */
function padColumns(text: string, width: number): string {
  const clipped = truncateColumns(singleLineText(text), width)
  return clipped + ' '.repeat(Math.max(0, width - visibleColumns(clipped)))
}

/** Interval-driven frame counter for one self-contained animated leaf. */
function useFrames(intervalMs: number, active = true): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick(current => current + 1), intervalMs)
    return () => {
      clearInterval(id)
    }
  }, [active, intervalMs])
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

/** The original web StateDot chase used by the busy composer marker. */
function BusyChase(): ReactElement {
  const tick = useFrames(BUSY_CHASE_TICK_MS)
  return createElement(Text, { color: inkColor(getPalette().brandBright) }, busyChaseFrame(tick) + ' ')
}

/** Blinking block caret appended to streaming text. */
function Caret(): ReactElement {
  const tick = useFrames(530)
  return createElement(Text, null, caretVisible(tick) ? '▍' : ' ')
}

/** One resettable input-caret phase shared by the entire composer. */
function useCursorBlink(active: boolean): { visible: boolean; reset(): void } {
  const [epoch, setEpoch] = useState(0)
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    setVisible(true)
    if (!active) return
    const id = setInterval(() => setVisible(current => !current), 530)
    return () => {
      clearInterval(id)
    }
  }, [active, epoch])
  const reset = useCallback((): void => {
    setVisible(true)
    setEpoch(current => current + 1)
  }, [])
  return { visible, reset }
}

/**
 * One bounded line painted with the deep-diving shimmer: a continuously
 * moving blue gradient across graphemes, the `✻` glyph in the breathing
 * spark color. Shared by the busy line and the collapsed thinking marker;
 * always exactly one row (truncate-end) so the live budget stays exact.
 */
function ShimmerLine({ text }: { text: string }): ReactElement {
  const tick = useFrames(DEEP_DIVING_SHIMMER_TICK_MS)
  const palette = getPalette()
  const graphemes = splitGraphemes(text)
  return createElement(
    Text,
    { wrap: 'truncate-end' },
    ...graphemes.map((grapheme, index) => {
      const sparkle = grapheme.text === '✻'
      return createElement(
        Text,
        {
          key: `${grapheme.start}-${grapheme.end}`,
          color: inkColor(sparkle ? deepDivingSparkColor(tick, palette.brandDeep, palette.brandBright) : deepDivingGradientColor(index, tick, graphemes.length, palette.brandDeep, palette.brandBright)),
          bold: sparkle || undefined,
        },
        grapheme.text,
      )
    }),
  )
}

/**
 * The busy line, web TurnStatus contract: a continuously moving blue gradient
 * paints the complete `Deep diving...` label, with the elapsed clock appended
 * only once the turn has clearly been running (15s) — anchored to `turn/start`
 * so a resumed mid-turn keeps the real time.
 */
function DeepDivingLine({ since }: { since: number }): ReactElement {
  const elapsed = since === 0 ? 0 : Date.now() - since
  const text = elapsed >= 15_000 ? `✻ Deep diving... ${runClock(elapsed)}` : '✻ Deep diving...'
  return createElement(ShimmerLine, { text })
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
  // The final extra column keeps a caret from wrapping onto an unbudgeted
  // row. Both prefixes participate because every physical row repeats its
  // hanging indent.
  const prefixColumns = Math.max(visibleColumns(prefix), visibleColumns(continuationPrefix))
  const contentColumns = Math.max(10, columns - 1 - prefixColumns)
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

/** File-oriented, color-coded unified diff viewport. */
function DiffPanel({ view, onClose }: { view: GitDiffView; onClose(): void }): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [fileIndex, setFileIndex] = useState(0)
  const [scroll, setScroll] = useState(0)
  const file = view.files[fileIndex]
  const lines = useMemo(() => {
    if (file === undefined) return textLines('  (no changes)', viewport.contentColumns, 'dim')
    return file.lines.flatMap(line => styledLines([
      lineSegment(line, line.startsWith('+') && !line.startsWith('+++')
        ? 'success'
        : line.startsWith('-') && !line.startsWith('---')
          ? 'error'
          : line.startsWith('@@') || line.startsWith('diff --git') || line.startsWith('index ')
            ? 'brand'
            : 'dim'),
    ], viewport.contentColumns))
  }, [file, viewport.contentColumns])
  const visibleScroll = clampScroll(scroll, lines.length, viewport.bodyRows)
  useInput((input, key) => {
    if (key.escape || input === 'q') onClose()
    else if (key.leftArrow && view.files.length > 0) {
      setFileIndex(current => (current + view.files.length - 1) % view.files.length)
      setScroll(0)
    } else if (key.rightArrow && view.files.length > 0) {
      setFileIndex(current => (current + 1) % view.files.length)
      setScroll(0)
    }
    else if (input === 'g') setScroll(0)
    else if (input === 'G') setScroll(Math.max(0, lines.length - viewport.bodyRows))
    else if (key.upArrow) setScroll(current => moveScroll(current, -1, lines.length, viewport.bodyRows))
    else if (key.downArrow) setScroll(current => moveScroll(current, 1, lines.length, viewport.bodyRows))
    else if (key.pageUp) setScroll(current => moveScroll(current, -viewport.bodyRows, lines.length, viewport.bodyRows))
    else if (key.pageDown) setScroll(current => moveScroll(current, viewport.bodyRows, lines.length, viewport.bodyRows))
  })
  if (viewport.compact) return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(`${view.title} · ${view.files.length} files · esc/q close`, viewport.contentColumns))
  return createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: inkColor(getPalette().dim), paddingX: 1 },
    createElement(Text, { color: inkColor(getPalette().brand), bold: true, wrap: 'truncate-end' }, truncateColumns(`${view.title} · ${view.files.length === 0 ? 'no files' : `${fileIndex + 1}/${view.files.length} ${file?.path ?? ''}`} · rows ${lines.length === 0 ? 0 : visibleScroll + 1}-${Math.min(lines.length, visibleScroll + viewport.bodyRows)}/${lines.length}`, viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(StyledRows, { lines: lines.slice(visibleScroll, visibleScroll + viewport.bodyRows) }),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns('↑/↓ scroll · g/G ends · esc/q close', viewport.contentColumns)),
  )
}

/** Codex-style panel rhythm that still participates in the row budget. */
function PanelGap({ visible }: { visible: boolean }): ReactElement | undefined {
  return visible ? createElement(Text, null, ' ') : undefined
}


/**
 * The whale header with a compact copy lockup. The dsh kernel version (when
 * the host manifest resolves), the title, the bilingual slogan, and the key
 * hint stay centered inside the existing eight content rows, preserving the
 * Static header's ten physical rows; without a resolvable host the lockup
 * keeps its historical three lines. Short or narrow terminals keep a one-line
 * form without the kernel line.
 */
function Header({ resumed }: { resumed: boolean }): ReactElement {
  const stdout = useStdout().stdout
  const rows = stdout?.rows ?? 40
  const columns = stdout?.columns ?? 80
  const kernelLine = (() => {
    const version = dshKernelVersion()
    return version === undefined ? undefined : `dsh-v${version}`
  })()
  const title = `DeepSeek Harness · v${DSH_CODE_VERSION}`
  const slogan = 'Into the Unknown  探索未至之境'
  const hint = resumed ? 'resumed · /help · Esc interrupt' : '/help · Esc interrupt · Ctrl+C quit'
  const copyWidths = [visibleColumns(title), visibleColumns(slogan), visibleColumns(hint)]
  if (kernelLine !== undefined) copyWidths.push(visibleColumns(kernelLine))
  const copyColumns = Math.max(...copyWidths)
  const compact = `${title} · ${hint}`
  if (rows < 20 || columns < WHALE_GLYPH_COLUMNS + copyColumns + 10) {
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
    // paddingX: 2 keeps a comfortable margin between the border and both the
    // whale on the left and the copy on the right (each side gains one
    // column over the previous paddingX: 1) without changing row height.
    { flexDirection: 'row', gap: 2, borderStyle: 'round', borderColor: inkColor(getPalette().brand), paddingX: 2, alignSelf: 'flex-start' },
    createElement(
      Box,
      { flexDirection: 'column', width: WHALE_GLYPH_COLUMNS, justifyContent: 'center' },
      ...WHALE_GLYPH.map((row, index) => createElement(Text, { key: index, color: inkColor(getPalette().brand) }, row)),
    ),
    createElement(
      Box,
      { flexDirection: 'column', width: copyColumns, justifyContent: 'center' },
      ...(kernelLine === undefined
        ? []
        : [createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, kernelLine)]),
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

/**
 * One-row live subagent summary (the Codex agent status feed, compressed to
 * the transcript's budget): running count, total, and the most recently
 * active child's current activity. One line, never more — the full view is
 * the /agents panel.
 */
function AgentsLine({ rows }: { rows: readonly SubagentRow[] }): ReactElement | undefined {
  if (rows.length === 0) return undefined
  const running = rows.filter(row => row.state !== 'done').length
  const newest = [...rows].sort((left, right) => right.updatedAt - left.updatedAt)[0]!
  const mark = newest.state === 'done' ? '✓' : newest.state === 'idle' ? '⏸' : '●'
  return createElement(
    Box,
    { paddingX: 1 },
    createElement(
      Text,
      { color: inkColor(getPalette().brand), bold: true, wrap: 'truncate-end' },
      `agents ${running} live`,
      createElement(Text, { color: inkColor(getPalette().dim) }, ` · ${rows.length} total · /agents`),
      createElement(Text, { color: inkColor(getPalette().text) }, ` · ${mark} ${newest.label} ${newest.activity}`),
    ),
  )
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
      createElement(Text, { color: inkColor(getPalette().dim) }, ' · /todos'),
    ),
  )
}

/**
 * The /todos subpage: the full todo list in one bounded, scrollable panel.
 * The live tree's TodoPanel stays a one-row summary; this exclusive view
 * shows EVERY item with its three-state mark inside the shared panel
 * viewport (same contract as /help and Ctrl+O: border/title/body/footer all
 * ride one height budget, the composer and status stay put below).
 */
function TodoListPanel({ todos, onClose }: { todos: readonly TodoItem[]; onClose: () => void }): ReactElement {
  const stdout = useStdout().stdout
  const columns = stdout?.columns ?? 80
  const viewport = panelViewport(columns, stdout?.rows ?? 30)
  const [scroll, setScroll] = useState(0)
  const bodyColumns = Math.max(4, viewport.contentColumns - 4)
  const completed = todos.filter(todo => todo.status === 'completed').length
  const inProgress = todos.filter(todo => todo.status === 'in_progress').length
  const pending = todos.length - completed - inProgress
  const rows = todos.length === 0
    ? [createElement(Text, { key: 'empty', dimColor: true, wrap: 'truncate-end' }, '  no todos yet')]
    : todos.map(todo => createElement(
      Text,
      { key: todo.content, dimColor: true, wrap: 'truncate-end' },
      `  ${todoMark(todo.status)} ${truncateColumns(displayText(todo.content), bodyColumns)}`,
    ))
  const visibleScroll = clampScroll(scroll, rows.length, viewport.bodyRows)
  const scrollBy = (delta: number): void => {
    setScroll(current => moveScroll(current, delta, rows.length, viewport.bodyRows))
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
    else if (input === 'G') setScroll(Math.max(0, rows.length - viewport.bodyRows))
  })

  if (viewport.maxHeight === 0) return createElement(Box, { display: 'none' })
  if (viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns('todos · esc/q close', viewport.contentColumns))
  }

  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(getPalette().brand) },
    createElement(Text, { color: inkColor(getPalette().brand), bold: true, wrap: 'truncate-end' }, truncateColumns(`todos · ${completed}/${todos.length} done · ${inProgress} active · ${pending} pending · rows ${rows.length === 0 ? 0 : visibleScroll + 1}-${Math.min(rows.length, visibleScroll + viewport.bodyRows)}/${rows.length}`, viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...rows.slice(visibleScroll, visibleScroll + viewport.bodyRows),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, dim(truncateColumns('↑↓ scroll · pgup/pgdn page · g/G ends · esc/q close', viewport.contentColumns))),
  )
}

const MemoTodoListPanel = memo(TodoListPanel)

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
 * DeepSeek route, the composer's INPUT ROW (the band's middle) plays Codex's
 * effort-ignition "Wave" — a blue crest sweeping the content row column by
 * column, with the `· ✦ ✧` sparkles on the deepseek tier — and the prompt
 * marker keeps the tier accent afterwards. The border stays a constant
 * static dim; only the row's per-column background tints during the wave,
 * so the row and column budget is untouched throughout.
 */

/** Theme anchors for the one-shot composer wave, read from the active palette
 * so the wave stays coordinated in both themes. The flash tier runs the
 * brand blues; the deepseek AND unknown tiers swap in the code sky-blue for
 * a brighter, richer mix (the unknown tier reuses the pro palette). Codex's
 * Wave bands carry no hue index (only hues[0] tints the row), so the accent
 * the prompt keeps is always hues[0]. */
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
  const layout = useMemo(() => layoutStatusBar(facts, stats, Math.max(8, columns - 2), {
    busy,
    items,
    // Match the composer content budget: border + horizontal padding are
    // already excluded, and layoutStatusBar shrinks this ceiling as needed.
    contextWidth: Math.max(5, columns - 6),
  }), [
    facts.model,
    facts.mode,
    facts.cwd,
    facts.branch,
    facts.sessionId,
    facts.title,
    facts.sandbox,
    facts.plan,
    facts.permission,
    facts.goal?.phase,
    facts.goal?.rounds,
    facts.goal?.max,
    stats,
    busy,
    columns,
    items,
  ])

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
      // Match the prompt text inside the composer band: two padding columns.
      // The secondary row adds the model-name indent
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
        setCustom(current => deleteLastGrapheme(current))
        return
      }
      if (input !== '' && !key.ctrl && !key.meta) {
        // Panel drafts see paste markers as literal text (Ink strips only the
        // leading ESC); strip them so a pasted answer never persists "[200~".
        const text = stripPasteMarkers(input)
        if (text !== '') setCustom(current => current + text)
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
function ModelPanel({ directory, error, current, onSelect, onProviders, onRetry, onClose }: {
  directory: ModelDirectory | undefined
  error: string | undefined
  /** `provider/model` label of the applied model: the cursor lands on it once. */
  current?: string
  onSelect(row: ModelRow): void
  onProviders?(): void
  onRetry(): void
  onClose(): void
}): ReactElement {
  const [cursor, setCursor] = useState(0)
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const rows = directory?.rows ?? []
  const positioned = useRef(false)

  useEffect(() => {
    // Open ON the applied model (Codex resumes the previous pick): the first
    // non-empty directory positions the cursor once, never on later refreshes.
    if (positioned.current || rows.length === 0 || current === undefined) {
      if (rows.length === 0) {
        if (cursor !== 0) setCursor(0)
        return
      }
      if (cursor >= rows.length) setCursor(rows.length - 1)
      return
    }
    const index = rows.findIndex(row => `${row.provider}/${row.model}` === current)
    if (index >= 0) {
      positioned.current = true
      setCursor(index)
    } else if (cursor >= rows.length) {
      setCursor(Math.max(0, rows.length - 1))
    }
  }, [rows, cursor, current])

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
      const capability = row.inputModalities?.includes('image') === true ? ' · image' : ''
      const label = displayText(`${row.providerName} · ${row.modelName}${capability}`)
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
function ProviderPanel({ directory, error, authorizations, authorizationError, onCredential, onConfigure, onUnset, onRemove, onLogin, onLogout, onRetry, onBack }: {
  directory: ProviderSettingsDirectory | undefined
  error: string | undefined
  authorizations: ProviderAuthorizationDirectory | undefined
  authorizationError: string | undefined
  onCredential(target: ProviderTargetView): void
  onConfigure(target: ProviderTargetView): void
  onUnset(target: ProviderTargetView): void
  onRemove(target: ProviderTargetView): void
  onLogin(target: ProviderTargetView, authorization: ProviderAuthorizationRow): void
  onLogout(target: ProviderTargetView, authorization: ProviderAuthorizationRow): void
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
    if (key.tab) {
      if (target.settingsNs.length === 0) setActionError('this provider is not managed by Harness settings')
      else onConfigure(target)
      return
    }
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
    const authorization = authorizationForProvider(authorizations, target.provider)
    if (input === 'l' || input === 'L') {
      if (authorization === undefined) setActionError('this provider offers no interactive login flow')
      else if (authorization.inFlight) setActionError('a login attempt is already running for this provider')
      else onLogin(target, authorization)
      return
    }
    if (input === 'o' || input === 'O') {
      if (authorization === undefined || !authorization.record.configured) setActionError('this provider has no login record to remove')
      else if (!authorization.record.writable) setActionError('this login record is read-only')
      else onLogout(target, authorization)
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
        ...(authorizationError === undefined
          ? []
          : [createElement(Text, { key: 'authorization-error', color: inkColor(getPalette().warn), wrap: 'truncate-end' }, truncateColumns(`  login status unavailable: ${singleLineText(authorizationError)}`, viewport.contentColumns))]),
        ...(authorizations?.failures ?? []).map((failure, index) => createElement(
          Text,
          { key: `authorization-failure-${index}`, color: inkColor(getPalette().warn), wrap: 'truncate-end' },
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
      const authorization = authorizationForProvider(authorizations, row.provider)
      const manualKeyConfigured = row.credential?.kind === 'facts' && row.credential.configured
      const showAuthorization = !manualKeyConfigured || authorization?.record.configured === true || authorization?.inFlight === true
      const authLabel = showAuthorization ? ` · ${providerAuthorizationStatus(authorization)}` : ''
      const label = `${identity} · ${providerStateLabel(row)}${authLabel}${row.removable ? ' · custom' : ''}`
      return createElement(
        Text,
        { key: row.provider, color: index === cursor ? inkColor(getPalette().brandBright) : inkColor(getPalette().dim), wrap: 'truncate-end' },
        truncateColumns(`${index === cursor ? '❯ ' : '  '}${displayText(label)}`, viewport.contentColumns),
      )
    }),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns('↑↓ move · enter key · l login · o logout · tab configure · d remove key · x remove provider · r retry · esc back', viewport.contentColumns)),
  )
}

/** Provider configuration editor: only explicit models are written to settings. */
function ProviderConfigurationPanel({ target, catalog, save, done, back }: {
  target: ProviderTargetView
  catalog: readonly ModelRow[]
  save(target: ProviderTargetView, configuration: ProviderConfiguration): Promise<void>
  done(): void
  back(): void
}): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [baseURL, setBaseURL] = useState(target.configuration.baseURL ?? '')
  const [models, setModels] = useState<readonly ProviderConfiguration['models'][number][]>(target.configuration.models)
  const [cursor, setCursor] = useState(0)
  const [focus, setFocus] = useState<'url' | 'models' | 'context' | 'output'>('url')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const choices = useMemo(() => {
    const known = catalog.filter(row => row.provider === target.provider)
    const ids = new Set(known.map(row => row.model))
    return [
      ...known.map(row => ({ id: row.model, name: row.modelName })),
      ...models.filter(model => !ids.has(model.id)).map(model => ({ id: model.id, name: model.name ?? model.id })),
    ]
  }, [catalog, models, target.provider])
  const selected = choices[cursor]
  const selectedModel = selected === undefined ? undefined : models.find(model => model.id === selected.id)
  const updateSelected = (change: Partial<ProviderConfiguration['models'][number]>): void => {
    if (selected === undefined) return
    setModels(current => current.some(model => model.id === selected.id)
      ? current.map(model => model.id === selected.id ? { ...model, ...change } : model)
      : [...current, { id: selected.id, name: selected.name, ...change }])
  }
  const submit = (): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    void Promise.resolve().then(() => save(target, { ...(baseURL.trim() === '' ? {} : { baseURL }), models })).then(done, (reason: unknown) => {
      setBusy(false)
      setError(singleLineText(reason instanceof Error ? reason.message : String(reason)))
    })
  }
  useStableInput((input, key) => {
    if (busy) return
    if (key.escape || input === 'q') { back(); return }
    if (key.tab) {
      setFocus(current => current === 'url' ? 'models' : current === 'models' ? 'context' : current === 'context' ? 'output' : 'url')
      return
    }
    if (key.return) { submit(); return }
    if (focus === 'url') {
      if (key.backspace || key.delete) setBaseURL(current => deleteLastGrapheme(current))
      else if (!key.ctrl && !key.meta && input !== '') setBaseURL(current => current + stripPasteMarkers(input))
      return
    }
    if (key.upArrow && choices.length > 0) { setCursor(current => Math.max(0, current - 1)); return }
    if (key.downArrow && choices.length > 0) { setCursor(current => Math.min(choices.length - 1, current + 1)); return }
    if (focus === 'models' && input === ' ') {
      if (selectedModel === undefined) updateSelected({})
      else setModels(current => current.filter(model => model.id !== selectedModel.id))
      return
    }
    if ((focus === 'context' || focus === 'output') && selectedModel !== undefined) {
      const field = focus === 'context' ? 'contextWindow' : 'maxTokens'
      const current = String(selectedModel[field] ?? '')
      if (key.backspace || key.delete) {
        const next = current.slice(0, -1)
        updateSelected({ [field]: next === '' ? undefined : Number(next) })
      } else {
        // A pasted number arrives as one multi-character chunk; accept the
        // whole digit run instead of the single-character path only.
        const digits = stripPasteMarkers(input)
        if (/^[0-9]+$/u.test(digits)) {
          const next = `${current}${digits}`
          updateSelected({ [field]: Number(next) })
        }
      }
    }
  }, true)
  if (viewport.maxHeight === 0) return createElement(Box, { display: 'none' })
  const stateRows = error === undefined ? [] : [createElement(Text, { key: 'error', color: inkColor(getPalette().error), wrap: 'truncate-end' }, truncateColumns(`  ${error}`, viewport.contentColumns))]
  const rowBudget = Math.max(0, viewport.bodyRows - stateRows.length - 1)
  const first = selectionWindow(cursor, choices.length, rowBudget)
  const visible = choices.slice(first, first + rowBudget)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(getPalette().brand) },
    createElement(Text, { color: inkColor(getPalette().brand), bold: true, wrap: 'truncate-end' }, truncateColumns(`/model - ${target.displayName} configuration`, viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: focus === 'url' ? inkColor(getPalette().brandBright) : inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(`  ${focus === 'url' ? '>' : ' '} endpoint: ${baseURL === '' ? '(adapter default)' : baseURL}`, viewport.contentColumns)),
    ...stateRows,
    ...visible.map((choice, index) => {
      const absolute = first + index
      const model = models.find(item => item.id === choice.id)
      const selectedMark = model === undefined ? '[ ]' : '[x]'
      const context = model?.contextWindow === undefined ? '-' : String(model.contextWindow)
      const output = model?.maxTokens === undefined ? '-' : String(model.maxTokens)
      const active = absolute === cursor && focus !== 'url'
      return createElement(Text, { key: choice.id, color: active ? inkColor(getPalette().brandBright) : model === undefined ? inkColor(getPalette().dim) : inkColor(getPalette().success), wrap: 'truncate-end' }, truncateColumns(`${active ? '>' : ' '} ${selectedMark} ${choice.name}  in:${context} out:${output}`, viewport.contentColumns))
    }),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns('tab endpoint/models/input/output - space select - arrows model - digits set window - enter save - esc back', viewport.contentColumns)),
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
    const next = draft + stripPasteMarkers(input)
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
    createElement(Text, { key: 'key-submit', dimColor: true, wrap: 'truncate-end' }, '  enter submit · up/down history · tab complete'),
    createElement(Text, { key: 'key-mentions', dimColor: true, wrap: 'truncate-end' }, '  @ mentions workspace files and sessions'),
    createElement(Text, { key: 'key-inspector', dimColor: true, wrap: 'truncate-end' }, '  ctrl+o history details · ctrl/alt+r thinking · shift+tab permission preset'),
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
    ...LOCAL_COMMANDS.map(command => createElement(
      Box,
      { key: `local-${command.label.slice(1)}` },
      row(command.label, command.description),
    )),
    ...descriptors.filter(descriptor => !LOCAL_COMMAND_NAMES.has(descriptor.name)).map(descriptor => createElement(
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

/** The empty-composer placeholder text (shared by the static and wave paths). */
const COMPOSER_PLACEHOLDER = 'type a message · / commands · @ mentions'

/** One physical cell of the wave-painted composer row: a char plus styles. */
interface ComposerCell {
  char: string
  width?: number
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
  origin: 'command' | 'skill' | 'mention'
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
  const local: CompletionCandidate[] = LOCAL_COMMANDS.map(command => ({ ...command, origin: 'command' }))
  // Local commands shadow registry names (e.g. the TUI-local /permission works
  // before any session exists, while the registry child needs one), so
  // collisions cannot render two rows with the same key.
  const registry = descriptors
    .filter(descriptor => !LOCAL_COMMAND_NAMES.has(descriptor.name))
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
 * the composer band — attached the way Claude-Code anchors its dropdown. Opening
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
  // File paths are the decision-making data in an @ menu. Give mentions the
  // full available line and sacrifice their repetitive kind label first.
  const nameWidth = mention
    ? Math.max(1, contentColumns - 2)
    : Math.min(18, Math.max(1, contentColumns - 2), Math.max(0, ...rows.map(row => visibleColumns(row.label))) + 2)
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

interface DraftImage extends ImagePathInspection {
  /** Visible draft token; deleting it also detaches the hidden path. */
  readonly marker: string
}

/**
 * The prompt box: TUI-local slash commands handled locally, other lines
 * dispatched; input editing keeps a cursor with history and completion.
 * While a modal (approval / question / model panel) owns the keys, the
 * box passes every key through untouched.
 */
function Input({ active, frozen, busy, descriptors, skills, dispatch, steer, interrupt, quit, openModel, openEffort, openHelp, openMode, openPermission, openResume, openPlugin, openJobs, openStatusline, openTheme, openHistory, openAgents, openSubagent, openTodos, openDelete, openDiff, reviewChanges, deleteConfirm, confirmDelete, cancelDelete, createSession, forkSession, cancelSessionSwitch, notify, applyEditorKeys, hasNotice, dismissNotice, toggleReasoning, openVerbose, clearView, refresh, loadMentions, inspectImages, prepareImages, cyclePermission, exportTranscript, renameTitle, copyLastResponse, recallSpace, recordLocal, recordHistory, queued, cancelQueued, historyFill, historyConsumed, waveTier, waveStyle, maxRows, onEditorRows }: {
  active: boolean
  frozen: boolean
  busy: boolean
  descriptors: readonly CommandDescriptor[]
  skills: readonly SkillRow[]
  dispatch(text: string, images?: readonly ImageBlock[]): void
  steer(text: string, images?: readonly ImageBlock[]): void
  interrupt(): boolean
  quit(): void
  openModel(): void
  openEffort(): void
  openHelp(): void
  openMode(): void
  openPermission(): void
  openResume(): void
  openPlugin(query?: string): void
  openJobs(): void
  openStatusline(): void
  openTheme(): void
  openHistory(): void
  /** Open the /agents panel (live subagent feed + transcript entry). */
  openAgents(): void
  /** Open the /subagent model panel. */
  openSubagent(): void
  /** Open the /todos subpage (full todo list in one bounded panel). */
  openTodos(): void
  /** Open the /resume picker in delete mode, optionally pre-armed on one id. */
  openDelete(id?: string): void
  openDiff(argument: string): void
  reviewChanges(argument: string): void
  /** The row id awaiting y/n in this box, when a deletion is pending. */
  deleteConfirm?: string
  /** Confirm the pending deletion (y in the box). */
  confirmDelete(): void
  /** Cancel the pending deletion (any other key in the box). */
  cancelDelete(): void
  createSession(mode?: string): void
  forkSession(argument: string): void
  cancelSessionSwitch(): boolean
  notify(text: string, tone?: NoticeTone): void
  /** Apply the Ctrl+R passthrough to the detected editor (/vscode-keys); resolves to a one-line summary. */
  applyEditorKeys(): Promise<string>
  hasNotice: boolean
  dismissNotice(): void
  toggleReasoning(): void
  openVerbose(): void
  clearView(): void
  refresh(): void
  loadMentions(query: string, signal?: AbortSignal): Promise<readonly MentionCandidate[]>
  inspectImages(paths: readonly string[]): Promise<readonly ImagePathInspection[]>
  prepareImages(paths: readonly string[], signal?: AbortSignal): Promise<readonly ImageBlock[]>
  cyclePermission(): string
  exportTranscript(argument: string): Promise<void>
  renameTitle(argument: string): string
  copyLastResponse(): Promise<string>
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
  /** DeepSeek easter-egg wave tier of the applied route (null otherwise):
   * official DeepSeek models drive their flash/pro tiers, non-DeepSeek
   * models running an effort above high drive the "Into the Unknown"
   * variant. Drives the persistent prompt glyph/accent and the sparkle
   * tier. */
  waveTier: DeepseekWaveTier | null
  /** The ignition style running, if any: Wave / Aurora / Pulse. */
  waveStyle: DeepseekWaveStyle | null
  /** Maximum physical editor rows the composer may occupy (see composerMaxRows). */
  maxRows: number
  /** Reports the editor's current physical row count so the live budget stays exact. */
  onEditorRows(rows: number): void
}): ReactElement {
  const columns = useStdout().stdout?.columns ?? 80
  const editorColumns = Math.max(1, columns - 6)
  const stdin = useStdin().stdin
  const focusReporting = isVsCodeTerminalEnv()
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const valueRef = useRef(value)
  const cursorRef = useRef(cursor)
  valueRef.current = value
  cursorRef.current = cursor
  const [draftImages, setDraftImages] = useState<readonly DraftImage[]>([])
  const draftImagesRef = useRef(draftImages)
  draftImagesRef.current = draftImages
  const [preparingImages, setPreparingImages] = useState(false)
  const prepareAbortRef = useRef<AbortController | undefined>(undefined)
  const prepareEpochRef = useRef(0)
  const { visible: cursorVisible, reset: resetCursorBlink } = useCursorBlink(active && !frozen && !preparingImages)
  useEffect(() => () => {
    prepareEpochRef.current += 1
    prepareAbortRef.current?.abort()
  }, [])
  // Codex textarea editing state: a single-entry kill buffer, the vertical
  // move's preferred display column, the editor's scroll window, and the
  // bracketed-paste marker state. All of it is editor-local; nothing here
  // ever reaches the App.
  const killRef = useRef('')
  const preferredColumnRef = useRef<number | null>(null)
  const editorScrollRef = useRef(0)
  const pasteBracketRef = useRef(false)
  /** Cancels the pending lost-paste safety timer (undefined when disarmed). */
  const pasteBracketCancelRef = useRef<(() => void) | undefined>(undefined)
  /** Ordered editor tokens from the stdin chunk Ink is about to deliver. */
  const rawEditorTokens = useRef<readonly RawEditorToken[] | undefined>(undefined)
  /** VS Code focus state from xterm focus-report events; starts focused. */
  const terminalFocusedRef = useRef(true)
  // Codex shell-style recall: the navigation cursor, the saved draft restored
  // on Down past the newest entry, and the boundary-gate anchor.
  const recall = useRef<RecallState>(beginRecall([], ''))

  useEffect(() => {
    preferredColumnRef.current = null
  }, [editorColumns])

  // A /history panel acceptance lands as a fill: place the sanitized text at
  // the end of the composer and resume recall from that entry.
  useEffect(() => {
    if (historyFill === undefined) return
    const safe = sanitizeDraftText(historyFill.text)
    draftImagesRef.current = []
    setDraftImages([])
    valueRef.current = safe
    cursorRef.current = safe.length
    setValue(safe)
    setCursor(safe.length)
    resetCursorBlink()
    preferredColumnRef.current = null
    setDismissedMenuValue(undefined)
    recall.current = {
      entries: recallSpace,
      index: historyFill.index,
      savedDraft: safe,
      lastRecalled: safe,
    }
    historyConsumed()
  }, [historyFill, recallSpace, historyConsumed, resetCursorBlink])

  useEffect(() => {
    setDraftImages((current) => {
      const next = current.filter(image => value.includes(image.marker))
      draftImagesRef.current = next
      return next.length === current.length ? current : next
    })
  }, [value])

  // Home/End and the Backspace-vs-Delete family never survive Ink's parser
  // as distinct keys, and kitty CSI-u forms parse as unnamed junk Ink would
  // insert as draft text.
  // Patch stdin.read — the single choke point Ink's input loop pulls every
  // chunk through — to first rewrite decodable CSI-u sequences to their
  // legacy bytes, then tokenize editor-only sequences before Ink emits the
  // matching input event. Batched Home/End/Delete/Backspace actions remain
  // ordered even though Ink invokes useInput only once for the whole chunk.
  useEffect(() => {
    if (stdin === undefined) return
    const originalRead = stdin.read.bind(stdin)
    const patchedRead = function patchedRead(this: typeof stdin, ...args: Parameters<typeof originalRead>) {
      const chunk = originalRead(...args)
      if (chunk === null) return chunk
      const normalized = normalizeKeyboardChunk(typeof chunk === 'string' ? chunk : String(chunk))
      const input = focusReporting
        ? stripTerminalFocusEvents(normalized, focused => {
          terminalFocusedRef.current = focused
        })
        : normalized
      rawEditorTokens.current = tokenizeRawEditorChunk(input)
      return input
    } as typeof stdin.read
    stdin.read = patchedRead
    return () => {
      stdin.read = originalRead as typeof stdin.read
    }
  }, [focusReporting, stdin])

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
  const mentionRequestRef = useRef(0)

  const sameImagePath = (left: string, right: string): boolean => (
    process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
  )

  const uniqueImageMarker = (name: string, source: 'mention' | 'drop', reserved: readonly string[] = []): string => {
    const safeName = singleLineText(sanitizeDraftText(name))
    const base = source === 'mention' ? `@${safeName}` : `[image: ${safeName}]`
    let marker = base
    let suffix = 2
    while (valueRef.current.includes(marker) || draftImagesRef.current.some(image => image.marker === marker) || reserved.includes(marker)) {
      marker = source === 'mention' ? `@${safeName} (${suffix})` : `[image: ${safeName} ${suffix}]`
      suffix += 1
    }
    return marker
  }

  const registerDraftImage = (inspection: ImagePathInspection, marker: string): boolean => {
    if (draftImagesRef.current.some(image => sameImagePath(image.path, inspection.path))) {
      notify(`${inspection.name} is already attached`, 'warning')
      return false
    }
    const next = [...draftImagesRef.current, { ...inspection, marker }]
    draftImagesRef.current = next
    setDraftImages(next)
    return true
  }

  const insertDroppedImages = (paths: readonly string[]): void => {
    const originalValue = valueRef.current
    const originalCursor = cursorRef.current
    notify(`checking ${paths.length} image${paths.length === 1 ? '' : 's'}…`)
    void inspectImages(paths).then((inspected) => {
      const additions: DraftImage[] = []
      const markers: string[] = []
      for (const inspection of inspected) {
        if ([...draftImagesRef.current, ...additions].some(image => sameImagePath(image.path, inspection.path))) continue
        const marker = uniqueImageMarker(inspection.name, 'drop', markers)
        additions.push({ ...inspection, marker })
        markers.push(marker)
      }
      if (additions.length === 0) {
        notify('those images are already attached', 'warning')
        return
      }
      const current = valueRef.current
      const anchor = remapStableRange(originalValue, current, { start: originalCursor, end: originalCursor })
      if (anchor === undefined) {
        notify('draft changed at the image drop point; drop the images again', 'warning')
        return
      }
      const at = anchor.start
      const insertion = `${at > 0 && !/\s$/u.test(current.slice(0, at)) ? ' ' : ''}${markers.join(' ')}${current.slice(at) === '' ? '' : ' '}`
      const edit = replaceRangePreservingCursor(current, cursorRef.current, anchor, insertion)
      const nextCursor = current === originalValue && cursorRef.current === originalCursor
        ? at + insertion.length
        : edit.cursor
      valueRef.current = edit.value
      cursorRef.current = nextCursor
      setValue(edit.value)
      setCursor(nextCursor)
      resetCursorBlink()
      const nextImages = [...draftImagesRef.current, ...additions]
      draftImagesRef.current = nextImages
      setDraftImages(nextImages)
      notify(`${additions.length} image${additions.length === 1 ? '' : 's'} ready for the next message`)
    }, (reason: unknown) => {
      notify(`image attachment failed: ${reason instanceof Error ? reason.message : String(reason)}`, 'error')
    })
  }

  useEffect(() => {
    const requestId = mentionRequestRef.current + 1
    mentionRequestRef.current = requestId
    if (!active || !mentionActive) {
      setMentionRows([])
      return
    }
    const controller = new AbortController()
    const query = mentionToken.query
    const timer = setTimeout(() => {
      void loadMentions(query, controller.signal).then(
        rows => {
          if (!controller.signal.aborted && mentionRequestRef.current === requestId) setMentionRows(rows)
        },
        () => {},
      )
    }, 50)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [active, mentionActive, mentionToken?.query])

  // Codex routes keys to the topmost surface first. Completion therefore
  // remains available while a turn runs, and Esc dismisses it before the
  // same key is allowed to interrupt the turn.
  const menuActive = !preparingImages && (slashActive || mentionActive) && dismissedMenuValue !== value
  const visibleMentionRows = mentionToken !== undefined && isPathLikeMentionQuery(mentionToken.query)
    ? mentionRows.filter(row => row.kind !== 'session')
    : mentionRows
  const menuRows: readonly CompletionCandidate[] = mentionActive
    ? visibleMentionRows.map(row => ({
      label: row.label.startsWith('@')
        ? row.label
        : `@${row.label}${row.kind === 'directory' ? '/' : ''}`,
      description: row.description,
      origin: 'mention',
    }))
    : candidates

  /** Accept the highlighted completion-menu candidate into the draft. */
  const acceptMenuCandidate = (): void => {
    if (mentionActive && mentionToken !== undefined) {
      if (visibleMentionRows.length === 0) return
      const row = visibleMentionRows[completionIndex % visibleMentionRows.length]
      if (row !== undefined) {
        if (row.kind === 'file' && row.path !== undefined && looksLikeImagePath(row.path)) {
          const tokenText = value.slice(mentionToken.start, cursor)
          const start = mentionToken.start
          const originalValue = value
          notify(`checking image ${basename(row.path)}…`)
          void inspectImages([row.path]).then((inspected) => {
            const inspection = inspected[0]
            if (inspection === undefined) return
            const current = valueRef.current
            const anchor = remapStableRange(originalValue, current, { start, end: start + tokenText.length })
            if (anchor === undefined || current.slice(anchor.start, anchor.end) !== tokenText) {
              notify('draft changed around the image mention; select it again', 'warning')
              return
            }
            if (draftImagesRef.current.some(image => sameImagePath(image.path, inspection.path))) {
              const edit = replaceRangePreservingCursor(current, cursorRef.current, anchor, '')
              valueRef.current = edit.value
              cursorRef.current = edit.cursor
              setValue(edit.value)
              setCursor(edit.cursor)
              resetCursorBlink()
              setDismissedMenuValue(edit.value)
              notify(`${inspection.name} is already attached`, 'warning')
              return
            }
            const marker = uniqueImageMarker(inspection.name, 'mention')
            const edit = replaceRangePreservingCursor(current, cursorRef.current, anchor, marker)
            valueRef.current = edit.value
            cursorRef.current = edit.cursor
            setValue(edit.value)
            setCursor(edit.cursor)
            resetCursorBlink()
            setDismissedMenuValue(edit.value)
            registerDraftImage(inspection, marker)
            notify(`${inspection.name} ready for the next message`)
          }, (reason: unknown) => {
            notify(`image attachment failed: ${reason instanceof Error ? reason.message : String(reason)}`, 'error')
          })
          setCompletionIndex(0)
          setDismissedMenuValue(undefined)
          return
        }
        // Session rows carry the canonical @[label](dsh-session:…) token;
        // file rows insert `@path` (directories keep their trailing slash).
        const insertion = row.label.startsWith('@')
          ? row.label
          : `@${row.label}${row.kind === 'directory' ? '/' : ''}`
        const nextValue = value.slice(0, mentionToken.start) + insertion + value.slice(cursor)
        const nextCursor = mentionToken.start + insertion.length
        valueRef.current = nextValue
        cursorRef.current = nextCursor
        setValue(nextValue)
        setCursor(nextCursor)
        resetCursorBlink()
      }
    } else {
      if (candidates.length === 0) return
      const candidate = candidates[completionIndex % candidates.length]
      if (candidate !== undefined) {
        const nextValue = `${candidate.label} `
        const nextCursor = candidate.label.length + 1
        valueRef.current = nextValue
        cursorRef.current = nextCursor
        setValue(nextValue)
        setCursor(nextCursor)
        resetCursorBlink()
      }
    }
    setCompletionIndex(0)
    setDismissedMenuValue(undefined)
  }

  /** Apply one editor edit: draft, cursor, kill buffer, menu reset. */
  const applyEdit = (edit: EditResult): void => {
    if (edit.killed !== undefined && edit.killed !== '') killRef.current = edit.killed
    valueRef.current = edit.value
    cursorRef.current = edit.cursor
    setValue(edit.value)
    setCursor(edit.cursor)
    resetCursorBlink()
    preferredColumnRef.current = null
    setCompletionIndex(0)
    setDismissedMenuValue(undefined)
  }

  /** Move the cursor without editing; horizontal moves clear the column preference. */
  const moveCursorTo = (next: number): void => {
    resetCursorBlink()
    if (next === cursorRef.current) return
    cursorRef.current = next
    setCursor(next)
    preferredColumnRef.current = null
  }

  /** Apply an ordered raw-key batch against one current draft snapshot. */
  const applyRawEditorTokens = (tokens: readonly RawEditorToken[]): void => {
    let nextValue = valueRef.current
    let nextCursor = cursorRef.current
    for (const token of tokens) {
      if (token.kind === 'text') {
        const edit = insertText(nextValue, nextCursor, token.text)
        nextValue = edit.value
        nextCursor = edit.cursor
        continue
      }
      if (token.kind === 'home') {
        nextCursor = moveToLineStart(nextValue, nextCursor, false)
        continue
      }
      if (token.kind === 'end') {
        nextCursor = moveToLineEnd(nextValue, nextCursor, false)
        continue
      }
      const edit = token.kind === 'delete-backward'
        ? deleteBackward(nextValue, nextCursor)
        : token.kind === 'delete-word-backward'
          ? deleteWordBackward(nextValue, nextCursor)
          : token.kind === 'delete-forward'
            ? deleteForward(nextValue, nextCursor)
            : deleteWordForward(nextValue, nextCursor)
      if (edit.killed !== undefined && edit.killed !== '') killRef.current = edit.killed
      nextValue = edit.value
      nextCursor = edit.cursor
    }
    valueRef.current = nextValue
    cursorRef.current = nextCursor
    setValue(nextValue)
    setCursor(nextCursor)
    resetCursorBlink()
    preferredColumnRef.current = null
    setCompletionIndex(0)
    setDismissedMenuValue(undefined)
  }

  const cancelImageSubmission = (): void => {
    prepareEpochRef.current += 1
    prepareAbortRef.current?.abort()
    prepareAbortRef.current = undefined
    setPreparingImages(false)
    dismissNotice()
    notify('image submission cancelled', 'warning')
  }

  /** Move through visual rows first, then cross history at the true edge. */
  const navigateVertical = (direction: -1 | 1): void => {
    const currentValue = valueRef.current
    const currentCursor = cursorRef.current
    const model = editorModel(currentValue, editorColumns)
    const preferred = preferredColumnRef.current ?? caretSite(model, currentCursor).column
    const next = moveCursorVertically(model, currentCursor, preferred, direction)
    if (next !== currentCursor) {
      cursorRef.current = next
      setCursor(next)
      resetCursorBlink()
      preferredColumnRef.current = preferred
      return
    }
    if (recall.current.entries.length > 0
      && shouldRecallNavigate(currentValue, currentCursor, recall.current.lastRecalled, direction)) {
      const step = direction < 0 ? recallOlder(recall.current, currentValue) : recallNewer(recall.current)
      recall.current = step.state
      if (step.entry !== undefined) {
        const safe = sanitizeDraftText(step.entry)
        valueRef.current = safe
        cursorRef.current = safe.length
        setValue(safe)
        setCursor(safe.length)
        preferredColumnRef.current = null
        setDismissedMenuValue(undefined)
      }
    }
    resetCursorBlink()
  }

  useStableInput((input, key) => {
    // Modal ownership: approval/question/model dialogs consume all keys.
    if (!active) return
    // React may not have committed the previous Tab completion render before
    // the next terminal byte arrives. Read the synchronous editor refs so a
    // completion followed immediately by text edits never uses stale closure
    // state.
    const liveValue = valueRef.current
    const liveCursor = cursorRef.current
    if (preparingImages) {
      if (key.escape || (key.ctrl && input === 'c')) cancelImageSubmission()
      return
    }
    // Deletion confirm owns the box: y proceeds, anything else cancels.
    // Typed in the INPUT BOX (codex delete-confirm): the keystroke is echoed
    // as the box's own prompt, not an invisible panel keypress.
    if (deleteConfirm !== undefined) {
      if (input === 'y' || input === 'Y') {
        confirmDelete()
      } else {
        cancelDelete()
      }
      return
    }
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
    // Alt+R is the zero-config alias: VS Code never intercepts Alt chords,
    // so the toggle stays reachable before /vscode-keys has been applied.
    if ((key.ctrl || key.meta) && input === 'r') {
      if (focusReporting && !terminalFocusedRef.current) return
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
      } else if (liveValue !== '') {
        valueRef.current = ''
        cursorRef.current = 0
        setValue('')
        setCursor(0)
        resetCursorBlink()
        draftImagesRef.current = []
        setDraftImages([])
        setCompletionIndex(0)
        setDismissedMenuValue(undefined)
      } else {
        quit()
      }
      return
    }
    if (key.ctrl && input === 'd') {
      // Codex: Ctrl+D deletes forward while a draft exists; the app-level
      // exit only fires from an empty composer.
      if (liveValue !== '') {
        applyEdit(deleteForward(liveValue, liveCursor))
        return
      }
      if (busy) notify('cancel the running turn before exiting (Esc or Ctrl+C)', 'warning')
      else quit()
      return
    }
    if (key.escape) {
      if (menuActive) {
        setDismissedMenuValue(liveValue)
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
    if (key.delete && liveValue === '' && queued.length > 0) {
      cancelQueued(queued[queued.length - 1]!.messageId)
      return
    }
    if (key.return) {
      // A newline inside an open bracketed paste inserts; it never submits.
      if (pasteBracketRef.current) {
        applyEdit(insertText(liveValue, liveCursor, '\n'))
        return
      }
      // Enter on an open completion menu accepts the highlighted candidate
      // (Codex list parity: Tab and Enter are both accept keys — many users
      // never discover Tab) — UNLESS the draft already spells one candidate
      // exactly, in which case Enter submits it (typing a full "/effort" and
      // pressing return must run the command, not re-accept its own text).
      if (menuActive) {
        const exactSlash = !mentionActive && candidates.some(candidate => candidate.label === liveValue)
        if (!exactSlash) {
          acceptMenuCandidate()
          return
        }
      }
      const text = liveValue.trim()
      if (draftImagesRef.current.length > 0) {
        const controller = new AbortController()
        const epoch = prepareEpochRef.current + 1
        prepareEpochRef.current = epoch
        prepareAbortRef.current = controller
        setPreparingImages(true)
        notify(`processing ${draftImagesRef.current.length} image${draftImagesRef.current.length === 1 ? '' : 's'}…`)
        const snapshot = draftImagesRef.current
        void prepareImages(snapshot.map(image => image.path), controller.signal).then((images) => {
          if (controller.signal.aborted || prepareEpochRef.current !== epoch) return
          prepareAbortRef.current = undefined
          setPreparingImages(false)
          valueRef.current = ''
          cursorRef.current = 0
          setValue('')
          setCursor(0)
          draftImagesRef.current = []
          setDraftImages([])
          setCompletionIndex(0)
          setDismissedMenuValue(undefined)
          dismissNotice()
          if (text !== '') {
            recordLocal(text)
            recordHistory(text)
          }
          recall.current = beginRecall(recallSpace, '')
          if (busy) steer(text, images)
          else dispatch(text, images)
        }, (reason: unknown) => {
          if (controller.signal.aborted || prepareEpochRef.current !== epoch) return
          prepareAbortRef.current = undefined
          setPreparingImages(false)
          notify(`image submission failed: ${reason instanceof Error ? reason.message : String(reason)}`, 'error')
        })
        return
      }
      valueRef.current = ''
      cursorRef.current = 0
      setValue('')
      setCursor(0)
      resetCursorBlink()
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
      recall.current = beginRecall(recallSpace, '')
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
      if (text === '/copy') {
        void copyLastResponse().then(
          outcome => notify(outcome),
          error => notify(`copy failed: ${error instanceof Error ? error.message : String(error)}`, 'error'),
        )
        return
      }
      if (text === '/diff' || text.startsWith('/diff ')) {
        openDiff(text.slice(5))
        return
      }
      if (text === '/review' || text.startsWith('/review ')) {
        reviewChanges(text.slice(7))
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
      if (text === '/fork' || text.startsWith('/fork ')) {
        forkSession(text.slice(5))
        return
      }
      if (text === '/plugin' || text.startsWith('/plugin ')) {
        openPlugin(text.slice(7).trim())
        return
      }
      if (text === '/jobs' || text.startsWith('/jobs ')) {
        openJobs()
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
      if (text === '/agents') {
        openAgents()
        return
      }
      if (text === '/todos') {
        openTodos()
        return
      }
      if (text === '/vscode-keys' || text.startsWith('/vscode-keys ')) {
        void applyEditorKeys().then(
          summary => notify(summary),
          error => notify(`vscode-keys failed: ${error instanceof Error ? error.message : String(error)}`, 'error'),
        )
        return
      }
      if (text === '/subagent') {
        openSubagent()
        return
      }
      if (text === '/delete' || text.startsWith('/delete ')) {
        openDelete(text.slice(7).trim())
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
    // Ink exposes Ctrl+J as a bare LF and Alt+Enter as a bare CR after
    // stripping the leading escape. Neither is a multiline shortcut.
    if (input === '\n' || input === '\r') return
    // A fast Tab followed by text can arrive as one readable chunk in an
    // integrated terminal. Accept the candidate first, then apply the
    // remaining characters against the synchronously updated editor refs.
    if (menuActive && (key.tab || input.startsWith('\t'))) {
      const remainder = key.tab ? '' : input.slice(1)
      acceptMenuCandidate()
      if (remainder !== '') applyEdit(insertText(valueRef.current, cursorRef.current, remainder))
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
    // Batched Home/End/Delete/Backspace sequences bypass Ink's one-key parser
    // and reduce against one current editor snapshot in their original order.
    const rawTokens = rawEditorTokens.current
    rawEditorTokens.current = undefined
    if (rawTokens !== undefined) {
      applyRawEditorTokens(rawTokens)
      return
    }
    if (key.upArrow || key.downArrow) {
      navigateVertical(key.upArrow ? -1 : 1)
      return
    }
    // Ctrl+P / Ctrl+N share the Up/Down contract (Codex binds them to
    // move_up/move_down, so the history gate applies first).
    if (key.ctrl && (input === 'p' || input === 'n')) {
      navigateVertical(input === 'p' ? -1 : 1)
      return
    }
    // Codex editor keymap: Alt/Ctrl+arrows and Alt+B/F move by word pieces;
    // plain arrows and Ctrl+B/F move by grapheme.
    if (key.leftArrow) {
      moveCursorTo(key.meta || key.ctrl ? moveWordLeft(liveValue, liveCursor) : moveCursorBy(liveValue, liveCursor, -1))
      return
    }
    if (key.rightArrow) {
      moveCursorTo(key.meta || key.ctrl ? moveWordRight(liveValue, liveCursor) : moveCursorBy(liveValue, liveCursor, 1))
      return
    }
    if (key.meta && input === 'b') {
      moveCursorTo(moveWordLeft(liveValue, liveCursor))
      return
    }
    if (key.meta && input === 'f') {
      moveCursorTo(moveWordRight(liveValue, liveCursor))
      return
    }
    if (key.ctrl && input === 'b') {
      moveCursorTo(moveCursorBy(liveValue, liveCursor, -1))
      return
    }
    if (key.ctrl && input === 'f') {
      moveCursorTo(moveCursorBy(liveValue, liveCursor, 1))
      return
    }
    // Ctrl+W and Alt+Backspace delete the previous word piece into the kill
    // buffer; Alt+D and the raw Ctrl/Alt+Delete variants kill forward.
    if (key.ctrl && input === 'w') {
      applyEdit(deleteWordBackward(liveValue, liveCursor))
      return
    }
    if (key.meta && input === 'd') {
      applyEdit(deleteWordForward(liveValue, liveCursor))
      return
    }
    // Un-annotated backspace/delete (Ink maps both  and  here):
    // delete the grapheme before the cursor.
    if (key.backspace || key.delete) {
      applyEdit(deleteBackward(liveValue, liveCursor))
      return
    }
    // Readline parity over the LOGICAL line: A/E to its ends, U/K kill to
    // them (filling the single kill buffer), Y yanks it back.
    if (key.ctrl && input === 'a') {
      moveCursorTo(moveToLineStart(liveValue, liveCursor, true))
      return
    }
    if (key.ctrl && input === 'e') {
      moveCursorTo(moveToLineEnd(liveValue, liveCursor, true))
      return
    }
    if (key.ctrl && input === 'u') {
      applyEdit(killToLineStart(liveValue, liveCursor))
      return
    }
    if (key.ctrl && input === 'k') {
      applyEdit(killToLineEnd(liveValue, liveCursor))
      return
    }
    if (key.ctrl && input === 'y') {
      if (killRef.current !== '') applyEdit(insertText(liveValue, liveCursor, killRef.current))
      return
    }
    // Ctrl+L refreshes the screen (readline convention): raw ANSI clear
    // plus a Static remount so the flushed transcript re-emits (a bare
    // console.clear() would desync Ink's ledger against the static rows).
    if (key.ctrl && input === 'l') {
      refresh()
      return
    }
    if (input !== '' && !key.ctrl && !key.meta) {
      // Bracketed-paste wrappers arrive as unknown escape sequences stripped
      // of their ESC. Markers may ride their own chunk or the edges of a
      // content chunk; strip every occurrence and track the open-paste flag
      // so a chunk that is exactly LF inserts instead of submitting.
      let text = input
      if (text.includes(PASTE_START_MARKER)) {
        pasteBracketRef.current = true
        // Arm the lost-marker safety net: one timer per open paste, re-armed
        // if a second start marker rides the same burst.
        pasteBracketCancelRef.current?.()
        const timer = setTimeout(() => {
          pasteBracketRef.current = false
          pasteBracketCancelRef.current = undefined
        }, PASTE_BRACKET_TIMEOUT_MS)
        pasteBracketCancelRef.current = () => {
          clearTimeout(timer)
          pasteBracketCancelRef.current = undefined
        }
        text = text.replaceAll(PASTE_START_MARKER, '')
      }
      if (text.includes(PASTE_END_MARKER)) {
        pasteBracketRef.current = false
        pasteBracketCancelRef.current?.()
        text = text.replaceAll(PASTE_END_MARKER, '')
      }
      if (text === '') return
      const droppedPaths = text.length > 1 ? parsePastedImagePaths(text) : []
      if (droppedPaths.length > 0) {
        insertDroppedImages(droppedPaths)
        return
      }
      applyEdit(insertText(valueRef.current, cursorRef.current, text))
    }
  }, active)

  // The DeepSeek easter-egg wave owns its 33ms tick HERE instead of in App:
  // the interval re-renders only the composer band at 30fps, never the whole
  // tree. App drives the tier/style pair on a model switch; this local effect
  // starts the sweep whenever that pair changes (App picks a NEW random style
  // for every replay — including effort changes on the same route — so the
  // pair always differs when a new wave should run) and stops it when the
  // route leaves every wave tier (tier becomes null).
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
  const waveActive = !preparingImages && waveTick !== null && waveTier !== null && waveStyle !== null
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
  // The multiline editor model: the sanitized draft hard-wrapped into
  // column-safe physical rows, with the caret mapped to its exact row and
  // column. Computed before the frozen path so the row report below runs
  // unconditionally.
  const editorViewModel = editorModel(value, editorColumns)
  const clampedCursor = clampCursor(value, cursor)
  const caret = caretSite(editorViewModel, clampedCursor)
  const editorWindowRows = Math.min(editorViewModel.rows.length, Math.max(1, maxRows))
  const maxEditorScroll = Math.max(0, editorViewModel.rows.length - editorWindowRows)
  const currentEditorScroll = Math.min(Math.max(0, editorScrollRef.current), maxEditorScroll)
  // Codex effective_scroll: no scrolling while the rows fit; otherwise the
  // window follows the caret row with as little movement as possible.
  const editorWindowStart = caret.row < currentEditorScroll
    ? caret.row
    : caret.row >= currentEditorScroll + editorWindowRows
      ? caret.row - editorWindowRows + 1
      : currentEditorScroll
  editorScrollRef.current = editorWindowStart
  const editorRowCount = frozen ? 1 : editorWindowRows
  useEffect(() => {
    onEditorRows(editorRowCount)
  }, [editorRowCount, onEditorRows])
  // The composer band: the old border's three-row footprint repainted as a
  // background-color band (the Codex-style shaded composer strip) — one
  // blank band row above and below the content rows, full width minus the
  // final column. Row counts are untouched, so every height budget stays
  // exact.
  const bandWidth = Math.max(1, columns - 1)
  const bandBg = inkColor(getPalette().composerBand)
  const bandFill = (consumed: number): string => ' '.repeat(Math.max(0, bandWidth - consumed))
  const band = (content: ReactElement): ReactElement => createElement(
    Box,
    { flexDirection: 'column', width: bandWidth },
    createElement(Text, { backgroundColor: bandBg }, ' '.repeat(bandWidth)),
    content,
    createElement(Text, { backgroundColor: bandBg }, ' '.repeat(bandWidth)),
  )
  if (frozen) {
    // A pending deletion turns the band into the confirm prompt: the y/n is
    // typed HERE; without a border the warn color carries the warning.
    if (deleteConfirm !== undefined) {
      const warning = 'y delete · any other key cancels'
      return band(createElement(
        Text,
        { backgroundColor: bandBg, wrap: 'truncate-end' },
        createElement(Text, { color: inkColor(getPalette().warn), bold: true }, '❯ '),
        createElement(Text, { color: inkColor(getPalette().warn), bold: true }, warning),
        bandFill(2 + visibleColumns(warning)),
      ))
    }
    const frozenLine = value === ''
      ? 'type a message'
      : verboseLine(value, Math.max(1, columns - 6))
    return band(createElement(
      Text,
      { backgroundColor: bandBg, wrap: 'truncate-end' },
      createElement(Text, { color: promptColor, bold: tierActive ? true : undefined }, busy ? '… ' : `${promptGlyph} `),
      frozenLine,
      bandFill(2 + visibleColumns(frozenLine)),
    ))
  }
  const menu = createElement(CompletionMenu, {
    active: menuActive,
    mention: mentionActive,
    index: completionIndex,
    rows: menuRows,
  })

  // Every state reuses this exact multiline editor window. Only the caret row
  // owns an inverse block; non-caret rows render their text without a hidden
  // spacer or a second blink timer.
  const editorRows: ReactElement[] = []
  for (let index = editorWindowStart; index < Math.min(editorViewModel.rows.length, editorWindowStart + editorWindowRows); index += 1) {
    const row = editorViewModel.rows[index]!
    const parts = editorRowParts(row, index, caret.row, clampedCursor, !preparingImages)
    const placeholder = index === 0 && value === '' && !busy && !preparingImages
    const tail = placeholder ? COMPOSER_PLACEHOLDER : parts.after
    const consumed = 2 + visibleColumns(parts.before) + visibleColumns(parts.caret) + visibleColumns(tail)
    editorRows.push(createElement(
      Text,
      { key: index, backgroundColor: bandBg, wrap: 'truncate-end' },
      index === 0
        ? preparingImages
          ? createElement(Text, { color: inkColor(getPalette().warn), bold: true }, '… ')
          : busy
            ? createElement(BusyChase)
            : createElement(Text, { color: promptColor, bold: tierActive ? true : undefined }, `${promptGlyph} `)
        : '  ',
      parts.before,
      parts.hasCaret
        ? createElement(Text, { key: 'caret', inverse: cursorVisible || undefined }, parts.caret)
        : null,
      placeholder
        ? createElement(Text, { dimColor: true }, COMPOSER_PLACEHOLDER)
        : parts.after,
      bandFill(consumed),
    ))
  }
  const staticEditor = createElement(Box, { flexDirection: 'column' }, ...editorRows)

  // The wave paints the SAME visible rows and caret site as the static path.
  // Graphemes remain atomic and every background sample advances by terminal
  // display columns, so CJK and emoji cannot move the caret or wrap the band.
  const waveRow = (): ReactElement => {
    const hues = deepseekWaveHues(waveTier!)
    const style = waveStyle!
    const bandRgb = getPalette().composerBand
    const visibleRows = editorViewModel.rows.slice(editorWindowStart, editorWindowStart + editorWindowRows)
    const totalBandRows = visibleRows.length + 2
    const waveBg = (row: number, column: number): string => {
      const rgb = deepseekWaveColumnBg(waveTick!, column, bandWidth, waveTier!, style, hues, bandRgb, row, totalBandRows)
      return rgb === null ? bandBg : inkColor(rgb)
    }
    const blankBandRow = (row: number): ReactElement => {
      const blanks: ComposerCell[] = []
      for (let column = 0; column < bandWidth; column += 1) {
        blanks.push({ char: ' ', width: 1, backgroundColor: waveBg(row, column) })
      }
      return createElement(Text, { key: `blank-${row}` }, ...waveRowSpans(blanks))
    }
    const cellIndexAtColumn = (cells: readonly ComposerCell[], target: number): number | undefined => {
      let column = 0
      for (let index = 0; index < cells.length; index += 1) {
        if (column === target) return index
        column += cells[index]!.width ?? visibleColumns(cells[index]!.char)
        if (column > target) return undefined
      }
      return undefined
    }
    const editorWaveRows = visibleRows.map((row, visibleIndex) => {
      const sourceIndex = editorWindowStart + visibleIndex
      const bandRow = visibleIndex + 1
      const parts = editorRowParts(row, sourceIndex, caret.row, clampedCursor)
      const placeholder = sourceIndex === 0 && value === '' && !busy
      const cells: ComposerCell[] = []
      let usedColumns = 0
      const push = (char: string, extra: Omit<ComposerCell, 'char' | 'width' | 'backgroundColor'> = {}): void => {
        const width = visibleColumns(char)
        cells.push({ char, width, backgroundColor: waveBg(bandRow, usedColumns), ...extra })
        usedColumns += width
      }
      if (sourceIndex === 0) {
        push(promptGlyph, { color: promptColor, bold: true })
        push(' ', { color: promptColor })
      } else {
        push(' ')
        push(' ')
      }
      for (const span of splitGraphemes(parts.before)) push(span.text)
      if (parts.hasCaret) push(parts.caret, { inverse: cursorVisible })
      const tail = placeholder ? COMPOSER_PLACEHOLDER : parts.after
      for (const span of splitGraphemes(tail)) push(span.text, placeholder ? { dim: true } : {})
      while (usedColumns < bandWidth) push(' ')

      const middleBandRow = Math.floor(totalBandRows / 2)
      if (bandRow === middleBandRow && deepseekWaveWordVisible(waveTick!, waveTier!, style)) {
        const word = waveTier === 'unknown' ? 'Into the Unknown' : 'deepseek'
        const start = Math.max(2, Math.floor((bandWidth - word.length) / 2))
        const indices = Array.from({ length: word.length }, (_, at) => cellIndexAtColumn(cells, start + at))
        if (indices.every(index => index !== undefined && (cells[index]!.char === ' ' || cells[index]!.dim === true))) {
          for (let at = 0; at < word.length; at += 1) {
            const cell = cells[indices[at]!]!
            cell.char = word[at]!
            cell.width = 1
            cell.color = inkColor(deepseekWaveWordHue(at, hues))
            cell.bold = true
            cell.dim = false
          }
        }
      }
      if (bandRow === middleBandRow && (waveTier === 'deepseek' || waveTier === 'unknown') && style === 'wave') {
        const spark = deepseekWaveSpark(waveTick!)
        const lastIndex = cellIndexAtColumn(cells, bandWidth - 1)
        if (spark !== null && lastIndex !== undefined && cells[lastIndex]!.char === ' ') {
          cells[lastIndex]!.char = spark
          cells[lastIndex]!.color = promptColor
          cells[lastIndex]!.bold = true
          cells[lastIndex]!.dim = false
        }
      }
      return createElement(Text, { key: `editor-${sourceIndex}`, wrap: 'truncate-end' }, ...waveRowSpans(cells))
    })
    return createElement(
      Box,
      { flexDirection: 'column', width: bandWidth },
      blankBandRow(0),
      ...editorWaveRows,
      blankBandRow(totalBandRows - 1),
    )
  }

  return createElement(
    Box,
    { flexDirection: 'column' },
    menu,
    waveTick !== null && waveTier !== null && waveStyle !== null && !busy && !preparingImages
      ? waveRow()
      : band(staticEditor),
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
  /** Physical rows this record contributes (row body plus spacers) — the
   * unit of the rendered-history cap. */
  rows: number
}

/** The incremental settled-history cache (see `computeSettledRows`). */
interface SettledRowsCache {
  /** The exact settled entries the cache covers (the WINDOW: the newest
   * `entries.length` settled entries, oldest dropped entries excluded). */
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
  /** The refreshEpoch the rows was built for; a bump forces a full rebuild. */
  epoch: number
  /** The terminal width the rows were wrapped for; a change forces a rebuild. */
  columns: number
  /** The flat row list (header + optional hint + per-entry before/box/after). */
  flat: ReactElement[]
  /** Settled entries dropped from the window's head (rendering only — the
   * event log keeps everything; Ctrl+O and /export read it directly). */
  droppedEntries: number
  /** Physical rows the window's entries contribute (excludes header/hint). */
  totalRows: number
  /** The window overflowed the trim hysteresis; one source-backed replay
   * (epoch bump) will re-window the cache. The append path never mutates
   * flat's head, so <Static> only ever sees tail appends between remounts. */
  needsTrim: boolean
}

/** One step of `computeSettledRows`. */
interface SettledRowsResult {
  cache: SettledRowsCache
  /** How many rows had to be BUILT by this step (0 = pure reuse). */
  built: number
}

/** Build one settled row (row Box plus its roomy-prompt spacers and row count). */
function buildSettledRow(entry: TranscriptEntry, index: number, showReasoning: boolean, columns: number): SettledRowRecord {
  // The SAME physical-row pipeline as the live tail (settledEntryLines).
  // Every row carries its own two-column prefix (user ❯, reply body, tool
  // cards), which is the whole gutter: no extra container padding, so reply
  // text starts at the same column as the composer's input text and wrapped
  // continuations keep their hanging indent instead of resetting to column 0.
  const roomyPrompt = entry.kind === 'user' && !entry.notice
  const lines = settledEntryLines(entry, Math.max(10, columns - 2), showReasoning)
  return {
    box: createElement(Box, { key: index }, createElement(StyledRows, { lines })),
    before: roomyPrompt
      ? createElement(Box, { key: `prompt-before-${index}`, paddingX: 1 }, createElement(Text, null, ' '))
      : undefined,
    after: roomyPrompt
      ? createElement(Box, { key: `prompt-after-${index}`, paddingX: 1 }, createElement(Text, null, ' '))
      : undefined,
    rows: lines.length + (roomyPrompt ? 2 : 0),
  }
}

/** The dim hint row placed under the header once the window has dropped entries. */
function settledTrimHint(droppedEntries: number, columns: number): ReactElement {
  return createElement(
    Text,
    { key: 'history-cap-hint', color: inkColor(getPalette().dim), wrap: 'truncate-end' },
    truncateColumns(`… +${droppedEntries} earlier messages hidden · ctrl+o browse · /export full transcript`, Math.max(10, columns - 2)),
  )
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
 * RENDERED-HISTORY CAP: the window holds at most `rowCap` physical rows of
 * settled transcript (header and hint reserved on top). The cap exists only
 * here — the event log, the store projection, /export, Ctrl+O, and /resume
 * keep the full history. Ink 5's <Static> is a consumption counter
 * (items.slice(index) keyed on length): deleting head items mid-stream while
 * appending tail items can permanently swallow new rows, so the append branch
 * NEVER drops the head — it only accounts rows and flags `needsTrim` once the
 * window overflows cap + margin. The flag fires one source-backed replay
 * (epoch bump = the existing clear + <Static> remount), whose rebuild branch
 * walks the settled entries BACKWARD from the newest, keeps whole entries
 * until the cap, and counts everything older as `droppedEntries` (those
 * entries never even reach settledEntryLines). Hysteresis bounds replays to
 * at most one per 25% growth; resize / Ctrl+L / idle Ctrl+R replays re-window
 * for free on the same path.
 *
 * Full rebuilds run only on the rare, deliberate paths: no cache yet, a
 * source-backed replay (`epoch` bump: resize / Ctrl+L / an idle Ctrl+R fold
 * toggle / a cap trim remounts `<Static>` and must re-flush the CURRENT rows
 * at the CURRENT fold state), a `resumed` change, or a shrink (`store.reset`).
 * While a turn is busy or streaming, Ctrl+R only flips the live region; rows
 * already emitted to native scrollback change exclusively through rebuilds.
 */
export function computeSettledRows(
  previous: SettledRowsCache | undefined,
  entries: readonly TranscriptEntry[],
  settled: number,
  showReasoning: boolean,
  resumed: boolean,
  epoch: number,
  columns = 80,
  rowCap = SETTLED_ROW_CAP,
): SettledRowsResult {
  if (previous === undefined || previous.epoch !== epoch || previous.resumed !== resumed
    || settled < previous.entries.length) {
    // Full rebuild at the CURRENT fold state, newest-first so the cap keeps
    // whole entries and never even parses dropped ones.
    const records = new Map<TranscriptEntry, SettledRowRecord>()
    const window: ReactElement[] = []
    let windowRows = 0
    let droppedEntries = 0
    let index = settled - 1
    for (; index >= 0; index--) {
      const entry = entries[index]
      if (entry === undefined) break
      const record = buildSettledRow(entry, index, showReasoning, columns)
      if (rowCap > 0 && windowRows + record.rows > rowCap - SETTLED_ROW_RESERVE) {
        // This whole entry (and everything older) falls out of the window.
        droppedEntries = index + 1
        break
      }
      records.set(entry, record)
      windowRows += record.rows
      if (record.after !== undefined) window.unshift(record.after)
      window.unshift(record.box)
      if (record.before !== undefined) window.unshift(record.before)
    }
    const header = createElement(Header, { key: 'header', resumed })
    const flat = droppedEntries > 0
      ? [header, settledTrimHint(droppedEntries, columns), ...window]
      : [header, ...window]
    return {
      cache: {
        entries: entries.slice(droppedEntries, settled),
        records,
        header,
        resumed,
        showReasoning,
        epoch,
        columns,
        flat,
        droppedEntries,
        totalRows: windowRows,
        needsTrim: false,
      },
      built: records.size,
    }
  }
  if (previous.showReasoning !== showReasoning) {
    // Native scrollback is immutable. Record only the mode future settled
    // entries will capture; the existing flat row identity stays untouched.
    return { cache: { ...previous, showReasoning }, built: 0 }
  }
  if (settled === previous.entries.length) {
    // Nothing below the boundary changed (a pending retirement above it, a
    // tool/result at the boundary): keep the SAME flat identity so the
    // memoized <Static> subtree does not re-render at all.
    return { cache: previous, built: 0 }
  }
  // The boundary grew: build ONLY the newly settled suffix. The head is never
  // dropped here (Ink's Static counter would swallow rows on a mixed frame);
  // overflow only flags the cache for one trimming replay.
  const records = previous.records
  const suffix: TranscriptEntry[] = []
  const added: ReactElement[] = []
  let deltaRows = 0
  for (let index = previous.entries.length + previous.droppedEntries; index < settled; index++) {
    const entry = entries[index]
    const record = buildSettledRow(entry, index, showReasoning, previous.columns)
    records.set(entry, record)
    suffix.push(entry)
    deltaRows += record.rows
    if (record.before !== undefined) added.push(record.before)
    added.push(record.box)
    if (record.after !== undefined) added.push(record.after)
  }
  const totalRows = previous.totalRows + deltaRows
  const needsTrim = rowCap > 0 && totalRows > rowCap + Math.floor(rowCap / 4)
  return {
    cache: {
      entries: previous.entries.concat(suffix),
      records,
      header: previous.header,
      resumed: previous.resumed,
      showReasoning,
      epoch: previous.epoch,
      columns: previous.columns,
      flat: previous.flat.concat(added),
      droppedEntries: previous.droppedEntries,
      totalRows,
      needsTrim,
    },
    built: suffix.length,
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
  const [providerAction, setProviderAction] = useState<
    | { kind: 'credential' | 'configure' | 'unset' | 'remove'; target: ProviderTargetView }
    | { kind: 'login' | 'logout'; target: ProviderTargetView; authorization: ProviderAuthorizationRow }
    | undefined
  >(undefined)
  /** The model row whose effort levels the /model stage lists; undefined shows the model list. */
  const [effortFor, setEffortFor] = useState<ModelRow | undefined>(undefined)
  /** Effective reasoning effort, shown in the /model picker and switch notice. */
  const [effortLabel, setEffortLabel] = useState<string | undefined>(props.effort)
  /** DeepSeek easter egg: switching INTO an official DeepSeek route — or
   * onto a NON-DeepSeek model running a reasoning effort strictly above
   * high — plays one of Codex's three ignition styles (Wave / Aurora /
   * Pulse, picked at random without repeating) across the composer's
   * padded band (33ms tick, per-style durations), then the band returns
   * to static while the prompt marker keeps the tier accent. The trigger
   * follows the applied model label (what the status bar actually shows),
   * never the initial paint, and the tier is derived from the label and
   * cached at the switch. The 33ms tick itself lives inside Input, so the
   * sweep re-renders only the composer band, not the whole tree, at 30fps;
   * App owns the rarely-changing tier/style and Input starts the sweep
   * whenever that pair changes. */
  const [waveTier, setWaveTier] = useState<DeepseekWaveTier | null>(null)
  const [waveStyle, setWaveStyle] = useState<DeepseekWaveStyle | null>(null)
  const previousModel = useRef<string | undefined>(undefined)
  const previousEffort = useRef<string | undefined>(props.effort)
  const previousStyle = useRef<DeepseekWaveStyle | undefined>(undefined)
  useEffect(() => {
    const previous = previousModel.current
    previousModel.current = modelLabel
    // The wave replays when the applied model changes OR its effort level
    // changes (Codex replays the ignition on effort changes too). Official
    // DeepSeek routes run their flash/pro tiers; a NON-DeepSeek model
    // running a reasoning effort STRICTLY above high runs the "Into the
    // Unknown" variant — the deepseek tier's exact motion with a different
    // wordmark. Any other non-DeepSeek route stays static.
    const effortChanged = previousEffort.current !== effortLabel
    previousEffort.current = effortLabel
    const modelChanged = previous !== undefined && previous !== modelLabel
    const official = isOfficialDeepSeekLabel(modelLabel)
    const unknownTrigger = !official && effortAboveHigh(effortLabel)
    if (!official && !unknownTrigger) {
      setWaveTier(null)
      setWaveStyle(null)
      return
    }
    if (modelChanged || effortChanged) {
      setWaveTier(official ? deepseekWaveTier(modelLabel) : 'unknown')
      const nextStyle = deepseekWaveStyleRandom(previousStyle.current)
      previousStyle.current = nextStyle
      setWaveStyle(nextStyle)
    }
  }, [modelLabel, effortLabel])
  const [directory, setDirectory] = useState<ModelDirectory | undefined>(undefined)
  const [modelError, setModelError] = useState<string | undefined>(undefined)
  const [providerDirectory, setProviderDirectory] = useState<ProviderSettingsDirectory | undefined>(undefined)
  const [providerError, setProviderError] = useState<string | undefined>(undefined)
  const [authorizationDirectory, setAuthorizationDirectory] = useState<ProviderAuthorizationDirectory | undefined>(undefined)
  const [authorizationError, setAuthorizationError] = useState<string | undefined>(undefined)
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
    if (!modelOpen || props.loadProviderAuthorizations === undefined) return
    let cancelled = false
    setAuthorizationDirectory(undefined)
    setAuthorizationError(undefined)
    Promise.resolve().then(() => props.loadProviderAuthorizations!()).then((loaded) => {
      if (!cancelled) setAuthorizationDirectory(loaded)
    }, (error: unknown) => {
      if (!cancelled) setAuthorizationError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
    }
  }, [modelOpen, modelLoadEpoch, props.loadProviderAuthorizations])
  useEffect(() => {
    const subscribe = props.subscribeModelProviders
    if (!modelOpen || subscribe === undefined) return
    try {
      return subscribe(() => setModelLoadEpoch(epoch => epoch + 1))
    } catch (error: unknown) {
      setProviderError(error instanceof Error ? error.message : String(error))
    }
  }, [modelOpen, props.subscribeModelProviders])
  useEffect(() => {
    const subscribe = props.subscribeProviderAuthorizations
    if (!modelOpen || subscribe === undefined) return
    try {
      return subscribe(() => setModelLoadEpoch(epoch => epoch + 1))
    } catch (error: unknown) {
      setAuthorizationError(error instanceof Error ? error.message : String(error))
    }
  }, [modelOpen, props.subscribeProviderAuthorizations])

  const busy = view.busy
  const [showReasoning, setShowReasoning] = useState(false)
  // Dedupe for the dynamic-budget tripwire: one warning per distinct shape.
  const budgetWarnRef = useRef<string | undefined>(undefined)
  const [verboseOpen, setVerboseOpen] = useState(false)
  const [diffView, setDiffView] = useState<GitDiffView | undefined>(undefined)
  const [helpOpen, setHelpOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  const [permissionOpen, setPermissionOpen] = useState(false)
  const [resumeOpen, setResumeOpen] = useState(false)
  const [pluginOpen, setPluginOpen] = useState(false)
  const [pluginQuery, setPluginQuery] = useState('')
  const [jobsOpen, setJobsOpen] = useState(false)
  const [statuslineOpen, setStatuslineOpen] = useState(false)
  const [statuslineItems, setStatuslineItems] = useState<readonly StatusItemId[]>(() => parseStatuslineItems(props.statusline))
  const [themeOpen, setThemeOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [subagentOpen, setSubagentOpen] = useState(false)
  const [todosOpen, setTodosOpen] = useState(false)
  /** /delete state: delete-mode hint plus an optional pre-armed row id. */
  const [resumeDelete, setResumeDelete] = useState<{ mode: boolean; id?: string }>({ mode: false })
  /** The row id awaiting y/n in the COMPOSER (codex delete confirm): the
   * composer takes the keys, the resume panel yields until it settles. */
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | undefined>(undefined)
  /** Bumped after a deletion so the /resume listing reloads immediately. */
  const [deleteReloadToken, setDeleteReloadToken] = useState(0)
  const requestDelete = useCallback((row: SessionRow): void => {
    setDeleteConfirmId(row.id)
  }, [])
  const cancelDelete = useCallback((): void => {
    setDeleteConfirmId(undefined)
  }, [])
  const confirmDelete = useCallback((): void => {
    const id = deleteConfirmId
    if (id === undefined) return
    setDeleteConfirmId(undefined)
    void props.deleteSession(id).then(outcome => {
      notify(outcome)
      // Keep the picker open and reload: a successful deletion must vanish
      // from the list immediately, not look like a no-op.
      setDeleteReloadToken(token => token + 1)
    }, (reason: unknown) => {
      notify(`delete failed: ${reason instanceof Error ? reason.message : String(reason)}`, 'error')
    })
  }, [deleteConfirmId, props.deleteSession, notify])
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
  const agentRows = useSyncExternalStore(props.subagents.subscribe, props.subagents.getSnapshot)
  const approvalPending = approvalSnapshot.pending !== undefined
  const questionPending = questionSnapshot.pending !== undefined
  // While any modal owns the keys, the prompt box passes everything through.
  // While a deletion waits for y/n, the composer takes the keys (the resume
  // panel yields): the confirm is typed IN the input box, not as an invisible
  // panel keypress.
  const inputActive = deleteConfirmId !== undefined
    ? !approvalPending && !questionPending
    : !modelOpen && !helpOpen && !modeOpen && !permissionOpen && !resumeOpen && !pluginOpen && !jobsOpen && !statuslineOpen && !themeOpen && !historyOpen && !agentsOpen && !subagentOpen && !todosOpen && !verboseOpen && diffView === undefined && !approvalPending && !questionPending

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
    setAgentsOpen(false)
    setSubagentOpen(false)
    setTodosOpen(false)
    setDeleteConfirmId(undefined)
    setVerboseOpen(false)
    setDiffView(undefined)
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
  // event. A source-backed replay (`refreshEpoch` bump: resize / Ctrl+L)
  // rebuilds the CURRENT row set from index 0,
  // so the replay stays complete and never ghosts a pending/running tail.
  // Hook order is unconditional. Its dimensions drive every live-region
  // budget before any dynamic rows are constructed.
  const appStdout = useStdout().stdout
  const [terminalSize, setTerminalSize] = useState(() => ({
    columns: appStdout?.columns ?? 80,
    rows: appStdout?.rows ?? 30,
  }))
  const terminalSizeRef = useRef(terminalSize)
  const settledRowsCache = useRef<SettledRowsCache | undefined>(undefined)
  const settledRows = useMemo(() => {
    const result = computeSettledRows(
      settledRowsCache.current,
      view.entries,
      settled,
      showReasoning,
      props.resumed,
      refreshEpoch,
      terminalSize.columns,
    )
    settledRowsCache.current = result.cache
    return result.cache.flat
  }, [view.entries, settled, showReasoning, props.resumed, refreshEpoch, terminalSize.columns])

  // One pending synchronized frame covers a debounced resize or explicit
  // source-backed replay. It is closed after the corresponding React commit.
  const synchronizedReplayPending = useRef(false)
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
        synchronizedReplayPending.current = true
        appStdout.write(SYNCHRONIZED_UPDATE_BEGIN + RESIZE_REFLOW_CLEAR)
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
  // The composer's live row count, reported one-way by the editor itself
  // (frozen modals report 1). This keeps the live/streaming budget exact as
  // a multiline draft grows, without lifting any editor state into the App.
  const [composerRows, setComposerRows] = useState(1)
  const handleEditorRows = useCallback((rows: number): void => {
    setComposerRows(current => (current === rows ? current : rows))
  }, [])
  const composerEditorCap = composerMaxRows(terminalRows)
  // Bottom chrome is composer (2 borders + composerRows) + menu + status
  // (up to 2 rows); the budget keeps the live/streaming area strictly below
  // the terminal height as the editor grows.
  const dynamicRows = Math.max(1, terminalRows - 13 - composerGutterRows - (composerRows - 1))
  const streamingActive = view.streaming !== '' || view.streamingReasoning !== ''
  const deepDivingVisible = busy && !streamingActive
  const allLiveLines = useMemo(
    () => view.entries.slice(settled).flatMap(
      entry => transcriptEntryLines(entry, Math.max(10, terminalColumns - 2), showReasoning),
    ),
    [view.entries, settled, terminalColumns, showReasoning],
  )
  // Reserve the same stream slice from the moment a turn becomes busy. This
  // keeps the first thinking frame from changing the dynamic-tree geometry
  // underneath Ink's cursor ledger and avoids a start-of-thinking flash.
  const liveBudget = busy || streamingActive
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
  // Dynamic-height tripwire: the allocation must fit dynamicRows by
  // construction; a future edit that breaks the derivation clamps here
  // (answer, then reasoning, then settled live rows) and warns once.
  const liveAudit = clampLiveAllocation(
    { live: visibleLiveLines.length, reasoning: reasoningRows, answer: answerRows },
    dynamicRows,
  )
  if (liveAudit.warning !== undefined && budgetWarnRef.current !== liveAudit.warning) {
    budgetWarnRef.current = liveAudit.warning
    console.warn(`[dsh-code] ${liveAudit.warning}`)
  }
  const auditedLiveLines = liveAudit.allocation.live === visibleLiveLines.length
    ? visibleLiveLines
    : visibleLiveLines.slice(-liveAudit.allocation.live)
  const auditedReasoningRows = liveAudit.allocation.reasoning
  const auditedAnswerRows = liveAudit.allocation.answer
  const transcriptVisible = !modelOpen && !helpOpen && !modeOpen && !permissionOpen && !resumeOpen && !pluginOpen && !jobsOpen && !statuslineOpen && !themeOpen && !historyOpen && !agentsOpen && !subagentOpen && !todosOpen && !verboseOpen && diffView === undefined && !approvalPending && !questionPending
  const inspectorVisible = verboseOpen && !approvalPending && !questionPending
  const modalVisible = modelOpen || helpOpen || modeOpen || permissionOpen || resumeOpen || pluginOpen || jobsOpen || statuslineOpen || themeOpen || historyOpen || agentsOpen || subagentOpen || todosOpen || inspectorVisible || diffView !== undefined || approvalPending || questionPending
  const closeInspector = useCallback((): void => {
    setVerboseOpen(false)
  }, [])
  const refreshScreen = (): void => {
    // Same source-backed clear the resize path uses: reset the scroll region
    // (`\x1b[r`) before wiping screen AND scrollback, then home the cursor.
    // A bare `\x1b[2J\x1b[3J\x1b[H` leaves a previously set scroll region in
    // place, so Ink's next repaint positions against stale bounds — the
    // stale-position flicker where the screen keeps redrawing.
    if (appStdout !== undefined) {
      synchronizedReplayPending.current = true
      appStdout.write(SYNCHRONIZED_UPDATE_BEGIN + RESIZE_REFLOW_CLEAR)
    }
    setRefreshEpoch(epoch => epoch + 1)
  }
  useEffect(() => {
    if (!synchronizedReplayPending.current || appStdout === undefined) return
    synchronizedReplayPending.current = false
    appStdout.write(SYNCHRONIZED_UPDATE_END)
  }, [appStdout, refreshEpoch])
  // An idle Ctrl+R fold toggle joins resize and explicit Ctrl+L as a deliberate
  // source-backed rebuild of native scrollback; busy turns never do.

  // Rendered-history cap: when the settled window overflows the trim
  // hysteresis, one source-backed replay re-windows it (the rebuild branch
  // drops the oldest entries beyond the cap). Deferred while busy or
  // streaming so the clear never interrupts a visible stream; the flag
  // survives until the turn calms.
  const settledNeedsTrim = settledRowsCache.current?.needsTrim === true
  useEffect(() => {
    if (!settledNeedsTrim || busy || streamingActive) return
    refreshScreen()
  }, [settledNeedsTrim, busy, streamingActive])

  const sessionHasImages = useMemo(() => view.entries.some(entry =>
    (entry.kind === 'user' || entry.kind === 'pending') && (entry.images?.length ?? 0) > 0), [view.entries])

  /** Apply one /model pick: record the selection, close the panel, report via notice. */
  const applyModel = (row: ModelRow, effortId: string | undefined): void => {
    try {
      const label = props.selectModel(row, effortId)
      setModelLabel(label)
      setEffortLabel(effortId)
      const selected = `${label}${effortId === undefined || effortId === '' ? '' : `@${effortId}`}`
      if (sessionHasImages && row.inputModalities !== undefined && !row.inputModalities.includes('image')) {
        notify(`model → ${selected} · image history will be sent as text placeholders`, 'warning')
      } else {
        notify(`model → next step uses ${selected}`)
      }
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
    if (providerAction?.kind === 'login'
      && props.beginProviderAuthorization !== undefined
      && props.cancelProviderAuthorization !== undefined
      && props.openAuthorizationUrl !== undefined
      && props.copyTextValue !== undefined) {
      modelSurface = createElement(ProviderAuthorizationPanel, {
        row: providerAction.authorization,
        begin: props.beginProviderAuthorization,
        cancel: () => props.cancelProviderAuthorization!(providerAction.authorization),
        openUrl: props.openAuthorizationUrl,
        copy: props.copyTextValue,
        done: () => {
          const authorization = providerAction.authorization
          setProviderAction(undefined)
          setProviderOpen(false)
          reloadModelSurfaces()
          notify(`logged in to ${authorization.label}; select a model`)
        },
        back: () => {
          setProviderAction(undefined)
          setProviderOpen(true)
        },
      })
    } else if (providerAction?.kind === 'logout' && props.logoutProviderAuthorization !== undefined) {
      modelSurface = createElement(ProviderAuthorizationLogoutPanel, {
        row: providerAction.authorization,
        confirm: props.logoutProviderAuthorization,
        done: () => {
          const authorization = providerAction.authorization
          setProviderAction(undefined)
          setProviderOpen(true)
          reloadModelSurfaces()
          notify(`logged out from ${authorization.label}`)
        },
        back: () => setProviderAction(undefined),
      })
    } else if (providerAction?.kind === 'configure' && props.saveModelProviderConfiguration !== undefined) {
      modelSurface = createElement(ProviderConfigurationPanel, {
        target: providerAction.target,
        catalog: directory?.rows ?? [],
        save: props.saveModelProviderConfiguration,
        done: () => {
          const target = providerAction.target
          setProviderAction(undefined)
          setProviderOpen(true)
          reloadModelSurfaces()
          notify(`provider configuration saved: ${target.displayName}`)
        },
        back: () => setProviderAction(undefined),
      })
    } else if (providerAction?.kind === 'credential' && props.saveModelProviderCredential !== undefined) {
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
        authorizations: authorizationDirectory,
        authorizationError,
        onCredential: (target: ProviderTargetView) => {
          if (props.saveModelProviderCredential === undefined) {
            notify('API key storage is unavailable in this profile', 'warning')
            return
          }
          setProviderAction({ kind: 'credential', target })
        },
        onConfigure: (target: ProviderTargetView) => {
          if (props.saveModelProviderConfiguration === undefined) {
            notify('provider configuration is unavailable in this profile', 'warning')
            return
          }
          setProviderAction({ kind: 'configure', target })
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
        onLogin: (target: ProviderTargetView, authorization: ProviderAuthorizationRow) => {
          if (busy) {
            notify('provider login is available only while the agent is idle', 'warning')
            return
          }
          if (props.beginProviderAuthorization === undefined
            || props.cancelProviderAuthorization === undefined
            || props.openAuthorizationUrl === undefined
            || props.copyTextValue === undefined) {
            notify('provider login is unavailable in this profile', 'warning')
            return
          }
          setProviderAction({ kind: 'login', target, authorization })
        },
        onLogout: (target: ProviderTargetView, authorization: ProviderAuthorizationRow) => {
          if (props.logoutProviderAuthorization === undefined) {
            notify('provider logout is unavailable in this profile', 'warning')
            return
          }
          setProviderAction({ kind: 'logout', target, authorization })
        },
        onRetry: reloadModelSurfaces,
        onBack: () => setProviderOpen(false),
      })
    } else if (effortFor !== undefined) {
      modelSurface = createElement(EffortPanel, {
        // Keyed per row: switching models remounts the stage so its cursor
        // initializes on the new model's effective effort.
        key: `${effortFor.provider}/${effortFor.model}`,
        row: effortFor,
        current: effortLabel,
        select: (effortId: string) => applyModel(effortFor, effortId),
        back: () => setEffortFor(undefined),
      })
    } else {
      modelSurface = createElement(ModelPanel, {
        directory,
        error: modelError,
        current: modelLabel,
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
        // No container padding: every live row carries its own two-column
        // prefix, so streaming text lands exactly where the composer's input
        // text and the settled reply both render (Codex LIVE_PREFIX).
        { flexDirection: 'column' },
        auditedLiveLines.length === 0 ? undefined : createElement(StyledRows, { lines: auditedLiveLines }),
        view.streamingReasoning !== '' && auditedReasoningRows > 0
          ? showReasoning
            ? createElement(StreamTail, {
              text: view.streamingReasoning,
              prefix: '✻ ',
              continuationPrefix: '  ',
              dim: true,
              maxRows: reasoningRows,
            })
            // The collapsed marker shimmers only while reasoning streams
            // alone: once answer text flows, a periodically re-rendered
            // animation component would race the store's frame-throttled
            // notifications and could defer the answer paint by tens to
            // hundreds of milliseconds (stream-burst contract), so the
            // marker falls back to the static dim row — same as Deep diving
            // always yields the live region to streaming content.
            : view.streaming === ''
              ? createElement(ShimmerLine, { text: '✻ Thinking… (Ctrl/Alt+R to expand)' })
              : createElement(StreamTail, {
                text: 'Thinking… (Ctrl/Alt+R to expand)',
                prefix: '✻ ',
                continuationPrefix: '  ',
                dim: true,
                maxRows: auditedReasoningRows,
              })
          : undefined,
        view.streaming !== '' && auditedAnswerRows > 0
          ? createElement(
            StreamTail,
            // The same two-column gutter as settled replies: streamed text
            // lands exactly where the assembled message will render.
            { text: view.streaming, dim: false, maxRows: auditedAnswerRows, prefix: '  ' },
            busy ? createElement(Caret) : undefined,
          )
          : undefined,
        deepDivingVisible ? createElement(DeepDivingLine, { since: view.busySince }) : undefined,
      )
      : undefined,
    transcriptVisible ? createElement(TodoPanel, { todos: view.todos }) : undefined,
    transcriptVisible ? createElement(AgentsLine, { rows: agentRows }) : undefined,
    todosOpen && !approvalPending && !questionPending
      ? createElement(MemoTodoListPanel, {
        todos: view.todos,
        onClose: () => {
          setTodosOpen(false)
        },
      })
      : undefined,
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
    diffView !== undefined && !approvalPending && !questionPending
      ? createElement(DiffPanel, {
        view: diffView,
        onClose: () => setDiffView(undefined),
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
        requestDelete,
        deleteConfirmId,
        reloadToken: deleteReloadToken,
        deleteMode: resumeDelete.mode,
        select: (row: SessionRow) => { props.switchSession(row); setResumeOpen(false) },
        close: () => setResumeOpen(false),
      })
      : undefined,
    pluginOpen && !approvalPending && !questionPending
      ? createElement(PluginPanel, { load: props.loadPlugins, initialQuery: pluginQuery, close: () => setPluginOpen(false) })
      : undefined,
    jobsOpen && !approvalPending && !questionPending
      ? createElement(JobsPanel, { load: props.loadJobs, close: () => setJobsOpen(false) })
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
    agentsOpen && !approvalPending && !questionPending
      ? createElement(AgentsPanel, {
        live: agentRows,
        load: props.loadSubagents,
        readTranscript: props.loadSessionTranscript,
        close: () => setAgentsOpen(false),
      })
      : undefined,
    subagentOpen && !approvalPending && !questionPending
      ? createElement(SubagentPanel, {
        current: props.subagentModel,
        load: props.loadModels,
        pick: (row: ModelRow, effortId?: string) => {
          try {
            // The runner's label already carries the effort suffix
            // (`provider/model@effort`), so no second append here.
            const label = props.setSubagentModel(row, effortId)
            notify(`subagents → ${label}`)
            setSubagentOpen(false)
          } catch (reason: unknown) {
            notify(`subagent model change failed: ${reason instanceof Error ? reason.message : String(reason)}`, 'error')
          }
        },
        inherit: () => {
          props.clearSubagentModel()
          notify('subagents → inherit current model')
          setSubagentOpen(false)
        },
        close: () => setSubagentOpen(false),
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
        applyEditorKeys: props.applyEditorKeys,
        steer: props.steer,
        interrupt: props.interrupt,
        quit: props.quit,
        openModel: () => {
          setDirectory(undefined)
          setModelError(undefined)
          setProviderDirectory(undefined)
          setProviderError(undefined)
          setAuthorizationDirectory(undefined)
          setAuthorizationError(undefined)
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
              // A model that advertises no levels still opens the stage: the
              // panel itself carries the empty state (the web effort pane's
              // "no levels" copy), instead of a bare notice that reads like
              // a failure.
              setEffortFor(row)
              setModelOpen(true)
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
        openResume: () => { setResumeDelete({ mode: false }); setResumeOpen(true) },
        openPlugin: (query = '') => { setPluginQuery(query); setPluginOpen(true) },
        openJobs: () => setJobsOpen(true),
        openStatusline: () => setStatuslineOpen(true),
        openTheme: () => setThemeOpen(true),
        openHistory: () => setHistoryOpen(true),
        openAgents: () => setAgentsOpen(true),
        openSubagent: () => setSubagentOpen(true),
        openTodos: () => setTodosOpen(true),
        openDelete: (id?: string) => {
          const armed = id === undefined || id === '' ? undefined : id
          setResumeDelete({ mode: true, ...armed === undefined ? {} : { id: armed } })
          setDeleteConfirmId(armed)
          setResumeOpen(true)
        },
        openDiff: (argument: string) => {
          void props.loadGitDiff(argument).then(setDiffView, (error: unknown) => {
            notify(`diff failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
          })
        },
        reviewChanges: props.reviewChanges,
        deleteConfirm: deleteConfirmId,
        confirmDelete,
        cancelDelete,
        createSession: props.createSession,
        forkSession: props.forkSession,
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
        // Ctrl+R flips the reasoning fold. Idle toggles must be visible: rows
        // already emitted through Static are native scrollback, so the fold
        // state of past entries can only change through the source-backed
        // replay (one clear + rebuild, wrapped in a synchronized frame). A
        // busy/streaming turn stays calm: the live region flips alone and the
        // entries that settle afterward capture the mode.
        toggleReasoning: () => {
          setShowReasoning(current => !current)
          if (!busy && !streamingActive) refreshScreen()
        },
        loadMentions: props.loadMentions,
        inspectImages: props.inspectImages,
        prepareImages: props.prepareImages,
        cyclePermission: props.cyclePermission,
        exportTranscript: props.exportTranscript,
        renameTitle: props.renameTitle,
        copyLastResponse: props.copyLastResponse,
        recallSpace,
        recordLocal,
        recordHistory: props.recordHistory,
        queued: queuedRows,
        cancelQueued: props.cancelQueued,
        historyFill,
        historyConsumed,
        waveTier,
        waveStyle,
        maxRows: composerEditorCap,
        onEditorRows: handleEditorRows,
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
