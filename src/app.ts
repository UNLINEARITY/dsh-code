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
import type { ContentBlock, FileBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
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
import { UpdatePanel } from './update-panel.ts'
import type { LauncherUpdateStatus } from './update.ts'
import { WHALE_GLYPH, WHALE_GLYPH_COLUMNS } from './whale-glyph.ts'
import { DSH_CODE_VERSION, dshKernelVersion } from './version.ts'
import type { TranscriptStore } from './store.ts'
import { DEFAULT_TERMINAL_TITLE, sanitizeTerminalTitle, terminalTitleSequence, useTerminalTitle } from './terminal-title.ts'
import { settledEntryCount, type TranscriptEntry } from './render/projection.ts'
import { imeCursorRowsUp, useImeCursorAnchor } from './render/ime-cursor.ts'
import { type MdSegment, visibleColumns } from './render/markdown.ts'
import {
  busyChaseFrame,
  BUSY_CHASE_TICK_MS,
  CARET_BLINK_TICK_MS,
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
  parseAnimationsArgument,
  type DeepseekWaveStyle,
  type DeepseekWaveTier,
} from './render/animations.ts'
import type { ApprovalSnapshot, ApprovalStore } from './approval.ts'
import { isSlashLine, submissionPayload, type CommandsView } from './commands.ts'
import { rankByName } from './render/fuzzy.ts'
import type { ModelDirectory, ModelRow } from './models.ts'
import {
  isDeclaredReasoningEfforts,
  parseReasoningEffortsDraft,
  serializeReasoningEfforts,
  type DiscoveredModelView,
  type ProviderConfiguration,
  type ProviderModelSettings,
  type ProviderSettingsDirectory,
  type ProviderTargetView,
  type ReasoningEffortsValue,
} from './provider-settings.ts'
import type { QuestionSnapshot, QuestionStore } from './questions.ts'
import type { SkillsView, SkillRow } from './skills.ts'
import { isPathLikeMentionQuery, type MentionCandidate } from './mentions.ts'
import type { SubagentFeedView, SubagentRow } from './subagents.ts'
import { AgentsPanel, editQuery, EffortPanel, HistoryPanel, JobsPanel, ModePanel, PermissionPanel, PluginPanel, ResumePanel, SchedulePanel, StatuslinePanel, runClock, SubagentPanel, type JobRow } from './kernel-panels.ts'
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
  parsePastedAttachmentPaths,
  type FilePathInspection,
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

// The paste safety-net window itself lives in keyboard.ts next to the paste
// markers: the input splitter's stale-paste escape hatch and this reset net
// must always share one window.

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
  PASTE_BRACKET_TIMEOUT_MS,
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
  type EditorRowModel,
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
  { label: '/update', description: 'update dsh-code, the harness host, and profile plugins in one aligned step' },
  { label: '/jobs', description: 'inspect background jobs' },
  { label: '/schedule', description: 'inspect active reminders (created through schedule tools)' },
  { label: '/statusline', description: 'customize the status line items' },
  { label: '/theme', description: 'switch the color theme' },
  { label: '/animation', description: 'toggle timed animations (/animation [on|off])' },
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
  /**
   * Submit one line: slash commands to the registry, other text to the agent.
   * The optional origin names the session the submission was composed for —
   * an attachment prepare resolves after the app remounted onto another
   * session, and the runner drops the stale delivery then.
   */
  dispatch(text: string, attachments?: readonly ContentBlock[], origin?: string): void
  /** Submit steering, with the same stale-delivery guard as {@link dispatch}. */
  steer(text: string, attachments?: readonly ContentBlock[], origin?: string): void
  /**
   * The FULL current session identity ('' while the first session is pending)
   * — the stale-delivery origin above. Distinct from the short display id.
   */
  sessionKey: string
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
  /** Validate draft non-image file paths without committing attachment objects. */
  inspectFiles(paths: readonly string[]): Promise<readonly FilePathInspection[]>
  /** Persist non-image files immediately before submission as durable file blocks. */
  prepareFiles(paths: readonly string[], signal?: AbortSignal): Promise<readonly FileBlock[]>
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
  /**
   * Interrogate the provider's real endpoint (typed key wins over the stored
   * credential) for the models it actually serves — the discovery stage of
   * the provider setup page.
   */
  discoverModelProvider?(
    target: ProviderTargetView,
    request: { readonly apiKey?: string; readonly baseURL?: string },
    signal?: AbortSignal,
  ): Promise<readonly DiscoveredModelView[]>
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
  /** Cycle to the next mode station (Shift+Tab): a permission preset or a plan switch; returns the notice label. */
  cycleMode(): string
  /** Pre-session plan choice: shows the plan badge before the first session exists. */
  pendingPlan?: boolean
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
  /** Probe the launcher's aligned update plan (read-only; never installs). */
  probeUpdate(): Promise<LauncherUpdateStatus>
  /** Run the launcher's aligned update; streams sanitized lines; resolves with the exit code. */
  applyUpdate(onLine: (line: string) => void): Promise<number>
  /** Registers the app's notice channel with the runner (called once on mount). */
  onBridgeReady(bridge: { notify(text: string, tone?: NoticeTone): void }): void
  /** Ordered enabled status items (/statusline config); the runner owns persistence. */
  statusline: readonly string[]
  /** Persist a new statusline item set; the runner surfaces IO failures as notices. */
  saveStatusline(items: readonly string[]): void
  /** Apply and persist one /theme selection; the runner owns the theme.json file. */
  saveTheme?(name: ThemeName): void
  /** Whether timed animations run at startup (animations.json; on by default
   * — like parseAnimationsPref, only an explicit false disables them). */
  animations?: boolean
  /** Apply and persist one /animation toggle; the runner owns the file. */
  saveAnimations?(enabled: boolean): void
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

/**
 * Wall-clock frame counter for one self-contained animated leaf. Each fire
 * derives the tick from elapsed time instead of counting intervals, so a
 * stretched interval (busy event loop, slow SSH) skips the animation ahead
 * rather than slowing it down; the tick always tracks real time.
 */
function useFrames(intervalMs: number, active = true): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const startedAt = Date.now()
    setTick(0)
    const id = setInterval(() => {
      // Clock setback (NTP resync) must not produce negative ticks — the
      // blink parity check would flip the caret off for a full period.
      setTick(Math.max(0, Math.floor((Date.now() - startedAt) / intervalMs)))
    }, intervalMs)
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

/**
 * The original web StateDot chase used by the busy composer marker. With
 * animations off it freezes on the first frame (still visibly busy).
 */
function BusyChase({ animated = true }: { animated?: boolean }): ReactElement {
  const tick = useFrames(BUSY_CHASE_TICK_MS, animated)
  return createElement(Text, { color: inkColor(getPalette().brandBright) }, busyChaseFrame(tick) + ' ')
}

/** Blinking block caret appended to streaming text; solid when frozen. */
function Caret({ animated = true }: { animated?: boolean }): ReactElement {
  const tick = useFrames(CARET_BLINK_TICK_MS, animated)
  return createElement(Text, null, caretVisible(tick) ? '▍' : ' ')
}

/** One resettable input-caret phase shared by the entire composer. */
function useCursorBlink(active: boolean): { visible: boolean; reset(): void } {
  const [epoch, setEpoch] = useState(0)
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    setVisible(true)
    if (!active) return
    const id = setInterval(() => setVisible(current => !current), CARET_BLINK_TICK_MS)
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
 * always exactly one row (truncate-end) so the live budget stays exact. With
 * animations off the same spans render in fixed colors — no timer, no
 * per-frame repaint, the `✻` keeps its highlight.
 */
function ShimmerLine({ text, animated = true }: { text: string; animated?: boolean }): ReactElement {
  const tick = useFrames(DEEP_DIVING_SHIMMER_TICK_MS, animated)
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
          color: inkColor(!animated
            ? (sparkle ? palette.brandBright : palette.brandDeep)
            : sparkle
              ? deepDivingSparkColor(tick, palette.brandDeep, palette.brandBright)
              : deepDivingGradientColor(index, tick, graphemes.length, palette.brandDeep, palette.brandBright)),
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
function DeepDivingLine({ since, animated = true }: { since: number; animated?: boolean }): ReactElement {
  const elapsed = since === 0 ? 0 : Date.now() - since
  const text = elapsed >= 15_000 ? `✻ Deep diving... ${runClock(elapsed)}` : '✻ Deep diving...'
  return createElement(ShimmerLine, { text, animated })
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
  // Content takes the full physical row minus prefixes and the final wrap
  // column — a forced 10-column FLOOR on a narrower terminal made every row
  // autowrap onto a second, unbudgeted row (the live budget then
  // under-counted and the tree overflowed), so the width now shrinks with
  // the real terminal instead of flooring at 10.
  const contentColumns = Math.max(1, columns - 1 - prefixColumns)
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
      // truncate-end is the same belt-and-braces StyledRows uses: any width
      // miscalculation clips a row instead of wrapping it out of budget.
      { key: index, dimColor: dim || undefined, wrap: 'truncate-end' },
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
 * the transcript's budget): running count, the observed total (the row cap
 * is a display budget, not the fan-out size), and the most recently active
 * child's current activity. One line, never more — the full view is the
 * /agents panel.
 */
function AgentsLine({ rows, total }: { rows: readonly SubagentRow[]; total: number }): ReactElement | undefined {
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
      createElement(Text, { color: inkColor(getPalette().dim) }, ` · ${total} total · /agents`),
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

  if (viewport.maxHeight === 0 || viewport.compact) {
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
    // The plan station's dedicated green: the status bar otherwise speaks in
    // blues, but the fourth cycle station IS a distinct green mode marker.
    case 'plan':
      return { color: inkColor(getPalette().success), bold: true, dimColor: undefined }
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

function StatusLine({ facts, stats, busy, columns, items, onRows }: {
  facts: StatusFacts
  stats: Parameters<typeof layoutStatusBar>[1]
  busy: boolean
  columns: number
  items: readonly string[]
  /** Reports the footer's exact physical row count (1 or 2) so the IME
   * anchor ledger below the composer stays exact. */
  onRows?: (rows: 1 | 2) => void
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
  // The IME anchor below the composer counts every row between the caret and
  // Ink's parked cursor, so the footer reports its exact row count one-way
  // (same contract as the composer's row report).
  const statusRowCount: 1 | 2 = layout.row2.left.length > 0 ? 2 : 1
  useEffect(() => {
    onRows?.(statusRowCount)
  }, [onRows, statusRowCount])

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
function ApprovalBar({ snapshot, locked, notify, interrupt, summarize }: {
  snapshot: ApprovalSnapshot
  locked: boolean
  notify(text: string, tone?: NoticeTone): void
  /** Cancel the running turn (Ctrl+C), matching the composer's busy branch. */
  interrupt(): boolean
  /** Render as the bounded one-line form even on tall terminals (another
   * human-asked surface already owns the full panel budget). */
  summarize?: boolean
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
    // Ctrl+C keeps its app-wide meaning while the ask owns the keys: cancel
    // the running turn (the ask's abort signal withdraws the question).
    // Without this branch the keystroke died here silently — the ask was the
    // only reachable surface and offered no way out.
    if (key.ctrl && input === 'c') {
      interrupt()
      return
    }
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
  const queuedSuffix = snapshot.queued > 0 ? ` · +${snapshot.queued} queued` : ''
  if (viewport.maxHeight === 0 || viewport.compact || summarize === true) {
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

interface QuestionDraftState {
  readonly selected: readonly number[]
  readonly custom: string
  readonly cursor: number
  readonly mode: 'options' | 'custom'
  readonly scroll: number
  readonly manualScroll: boolean
  readonly followCustomTail: boolean
  readonly committed: boolean
}

function initialQuestionDraft(question: AskUserQuestionItem | undefined): QuestionDraftState {
  const hasOptions = (question?.options?.length ?? 0) > 0
  return {
    selected: [],
    custom: '',
    cursor: 0,
    mode: hasOptions ? 'options' : 'custom',
    scroll: 0,
    manualScroll: false,
    followCustomTail: !hasOptions,
    committed: false,
  }
}

function answerFromQuestionDraft(question: AskUserQuestionItem, draft: QuestionDraftState): AskUserQuestionAnswerItem {
  // Multi-select changes are answers as soon as a value is toggled, matching
  // Claude-Code's draft store. `committed` still records an explicit Enter so
  // an intentionally empty answer can be submitted, while navigation away
  // from a non-empty draft never discards the user's selection.
  const hasAnswer = question.multiSelect === true
    ? draft.committed || draft.selected.length > 0 || draft.custom.trim() !== ''
    : draft.committed
  if (!hasAnswer) {
    return { id: question.id, selected: [] }
  }
  const options = question.options ?? []
  const selected = draft.selected
    .map(at => options[at]?.label)
    .filter((label): label is string => label !== undefined)
  const custom = draft.custom.trim()
  return { id: question.id, selected, ...(custom === '' ? {} : { custom }) }
}

/**
 * The ask_user_question bar: walks one request question by question,
 * retaining an independent draft for every question. Options use Space/1-9
 * to toggle a multi-select, Enter to confirm, and arrows/Ctrl+P/N to move
 * between questions. Plan reviews arrive through the same service with a
 * `plan-review` intent — the approve option gets a ✓ mark, the answer
 * encoding stays identical.
 */
function QuestionBar({ store, snapshot, locked }: { store: QuestionStore; snapshot: QuestionSnapshot; locked: boolean }): ReactElement | undefined {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const pending = snapshot.pending
  const request = pending?.request
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState<readonly QuestionDraftState[]>(() => request?.questions.map(question => initialQuestionDraft(question)) ?? [])
  const [submitted, setSubmitted] = useState(false)
  const draftsRef = useRef<readonly QuestionDraftState[]>([])
  const indexRef = useRef(0)
  draftsRef.current = drafts
  indexRef.current = index

  // A new request resets the walk; questions without options start in the
  // custom-answer box (a free-form question). Depend on the request rather
  // than its wrapper snapshot: external stores may refresh that wrapper while
  // a question is still active, and a reset must never become a render loop.
  useEffect(() => {
    const next = request?.questions.map(question => initialQuestionDraft(question)) ?? []
    draftsRef.current = next
    indexRef.current = 0
    setDrafts(next)
    setIndex(0)
    setSubmitted(false)
  }, [request])

  const question = pending?.request.questions[index]
  const options = question?.options ?? []
  const isPlan = question?.intent?.kind === 'plan-review'
  const isMulti = question?.multiSelect === true
  const currentDraft = drafts[index] ?? initialQuestionDraft(question)
  const { cursor, selected, mode, custom, scroll, manualScroll, followCustomTail } = currentDraft
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
          // Claude-Code numbering: the digit addresses the row from the
          // keyboard, so the prefix advertises the binding it enables.
          lineSegment(at < 9 ? `${at + 1}. ` : '', 'dim'),
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

  const updateDrafts = (update: (current: readonly QuestionDraftState[]) => readonly QuestionDraftState[]): void => {
    const next = update(draftsRef.current)
    draftsRef.current = next
    setDrafts(next)
  }

  const updateCurrentDraft = (update: (current: QuestionDraftState) => QuestionDraftState): void => {
    const currentIndex = indexRef.current
    updateDrafts(current => current.map((draft, at) => at === currentIndex ? update(draft) : draft))
  }

  const moveQuestion = (direction: -1 | 1): void => {
    const total = request?.questions.length ?? 0
    if (total <= 1) return
    const currentIndex = indexRef.current
    const nextIndex = Math.max(0, Math.min(total - 1, currentIndex + direction))
    if (nextIndex === currentIndex) return
    indexRef.current = nextIndex
    setIndex(nextIndex)
  }

  const commit = (answer: AskUserQuestionAnswerItem): void => {
    if (pending === undefined || question === undefined) return
    const currentIndex = indexRef.current
    const optionLabels = new Set(answer.selected)
    const selectedIndices = (question.options ?? [])
      .map((option, at) => optionLabels.has(option.label) ? at : -1)
      .filter((at): at is number => at >= 0)
    const nextDrafts = draftsRef.current.map((draft, at) => at === currentIndex
      ? { ...draft, selected: selectedIndices, custom: answer.custom ?? '', committed: true }
      : draft)
    draftsRef.current = nextDrafts
    setDrafts(nextDrafts)
    const total = pending.request.questions.length
    if (currentIndex + 1 >= total) {
      setSubmitted(true)
      store.submit(pending, {
        answers: pending.request.questions.map((item, at) => answerFromQuestionDraft(item, nextDrafts[at] ?? initialQuestionDraft(item))),
      })
      return
    }
    const nextIndex = currentIndex + 1
    indexRef.current = nextIndex
    setIndex(nextIndex)
  }

  const commitOption = (): void => {
    if (pending === undefined || question === undefined) return
    const currentIndex = indexRef.current
    const current = draftsRef.current[currentIndex] ?? initialQuestionDraft(question)
    if (isMulti) {
      const labels = current.selected
        .map(at => options[at]?.label)
        .filter((label): label is string => label !== undefined)
      const customText = current.custom.trim()
      commit({ id: question.id, selected: labels, ...(customText === '' ? {} : { custom: customText }) })
      return
    }
    const option = options[current.cursor]
    if (option === undefined) return
    commit({ id: question.id, selected: [option.label] })
  }

  /**
   * A question with choices has two local focus surfaces, just like Codex:
   * the choice list and the optional custom-answer editor. Returning to the
   * list keeps the user's current choice and multi-select state, but drops the
   * transient custom draft so a second Escape can cancel the question.
   */
  const returnToOptions = (): void => {
    if (options.length === 0) return
    updateCurrentDraft(current => ({ ...current, mode: 'options', custom: '', scroll: 0, manualScroll: false, followCustomTail: false }))
  }

  useStableInput((input, key) => {
    if (pending === undefined || question === undefined || submitted) return
    if (viewport.maxHeight === 0) {
      // Options are not rendered at this height, so blind picks stay
      // disabled; only the explicit cancel remains available.
      if (key.escape || (key.ctrl && input === 'c')) store.cancel(pending)
      return
    }
    if (key.ctrl && input === 'c') {
      store.cancel(pending)
      return
    }
    if (key.escape) {
      if (mode === 'custom' && options.length > 0) {
        returnToOptions()
        return
      }
      store.cancel(pending)
      return
    }
    if (key.tab && key.shift) {
      moveQuestion(-1)
      return
    }
    if (key.leftArrow || (key.ctrl && input === 'p')) {
      moveQuestion(-1)
      return
    }
    if (key.rightArrow || (key.ctrl && input === 'n')) {
      moveQuestion(1)
      return
    }
    if (key.pageUp) {
      updateCurrentDraft(current => ({
        ...current,
        manualScroll: true,
        followCustomTail: false,
        scroll: moveScroll(visibleScroll, -Math.max(1, viewport.bodyRows - 1), rendered.lines.length, viewport.bodyRows),
      }))
      return
    }
    if (key.pageDown) {
      updateCurrentDraft(current => ({
        ...current,
        manualScroll: true,
        followCustomTail: false,
        scroll: moveScroll(visibleScroll, Math.max(1, viewport.bodyRows - 1), rendered.lines.length, viewport.bodyRows),
      }))
      return
    }
    if (mode === 'custom' || options.length === 0) {
      if (key.tab && options.length > 0) {
        returnToOptions()
        return
      }
      if (key.upArrow) {
        updateCurrentDraft(current => ({
          ...current,
          followCustomTail: false,
          scroll: moveScroll(visibleScroll, -1, rendered.lines.length, viewport.bodyRows),
        }))
        return
      }
      if (key.downArrow) {
        updateCurrentDraft(current => ({
          ...current,
          followCustomTail: false,
          scroll: moveScroll(visibleScroll, 1, rendered.lines.length, viewport.bodyRows),
        }))
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
        updateCurrentDraft(current => ({ ...current, custom: deleteLastGrapheme(current.custom), committed: false }))
        return
      }
      if (input !== '' && !key.ctrl && !key.meta) {
        // Panel drafts see paste markers as literal text (Ink strips only the
        // leading ESC); strip them so a pasted answer never persists "[200~".
        const text = stripPasteMarkers(input)
        if (text !== '') updateCurrentDraft(current => ({ ...current, custom: current.custom + text, committed: false }))
      }
      return
    }
    if (key.upArrow) {
      updateCurrentDraft(current => ({
        ...current,
        cursor: (current.cursor + options.length - 1) % options.length,
        manualScroll: false,
      }))
      return
    }
    if (key.downArrow) {
      updateCurrentDraft(current => ({
        ...current,
        cursor: (current.cursor + 1) % options.length,
        manualScroll: false,
      }))
      return
    }
    if (key.return) {
      commitOption()
      return
    }
    if (key.tab || input === 'c' || input === 'C') {
      updateCurrentDraft(current => ({ ...current, mode: 'custom', manualScroll: false, followCustomTail: true }))
      return
    }
    if (input === ' ' && isMulti) {
      updateCurrentDraft(current => ({
        ...current,
        selected: current.selected.includes(current.cursor)
          ? current.selected.filter(at => at !== current.cursor)
          : [...current.selected, current.cursor],
        committed: false,
      }))
      return
    }
    // Claude-Code option numbers: the digit addresses a row directly — a
    // toggle in multi-select, an immediate pick in single-select.
    if (/^[1-9]$/.test(input)) {
      const at = Number(input) - 1
      if (at >= options.length) return
      if (isMulti) {
        updateCurrentDraft(current => ({
          ...current,
          selected: current.selected.includes(at)
            ? current.selected.filter(row => row !== at)
            : [...current.selected, at],
          committed: false,
        }))
      } else {
        const option = options[at]
        if (option !== undefined) commit({ id: question.id, selected: [option.label] })
      }
    }
  }, active)

  if (pending === undefined || question === undefined) return undefined
  if (viewport.maxHeight === 0 || viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(isPlan ? 'plan review · esc cancel' : 'question · esc cancel', viewport.contentColumns))
  }
  const footerBase = submitted
    ? 'submitted…'
    : mode === 'custom'
      ? options.length === 0
        ? '↑↓/pgup/pgdn scroll · type answer · enter submit · esc interrupt'
        : '↑↓/pgup/pgdn scroll · type answer · enter submit · tab/esc or empty backspace: options'
      : options.length === 0
        ? '↑↓/pgup/pgdn scroll · type answer · enter submit · esc interrupt'
      : isMulti
        ? '↑↓ choose · pgup/pgdn scroll · space/1-9 toggle · enter submit · c custom · esc interrupt'
        : '↑↓ choose · pgup/pgdn scroll · 1-9 pick · enter submit · c custom · esc interrupt'
  const footer = pending.request.questions.length > 1 && !submitted
    ? `${footerBase} · ←→/ctrl+p/n switch question`
    : footerBase
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
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const rows = directory?.rows ?? []
  // Direct-typing filter over provider and model names (the /mode contract):
  // printable keys edit the query, so a long directory is searchable without
  // a separate search mode. With a query active, q/r/g/G stop acting as
  // commands and become query text instead.
  const filtered = useMemo(() => {
    if (query === '') return rows
    const needle = query.toLowerCase()
    return rows.filter(row => `${row.provider} ${row.providerName ?? ''} ${row.model} ${row.modelName}`.toLowerCase().includes(needle))
  }, [rows, query])
  const positioned = useRef(false)

  useEffect(() => {
    // Open ON the applied model (Codex resumes the previous pick): the first
    // non-empty directory positions the cursor once, never on later refreshes.
    if (positioned.current || rows.length === 0 || current === undefined) {
      if (filtered.length === 0) {
        if (cursor !== 0) setCursor(0)
        return
      }
      if (cursor >= filtered.length) setCursor(filtered.length - 1)
      return
    }
    const index = rows.findIndex(row => `${row.provider}/${row.model}` === current)
    if (index >= 0) {
      positioned.current = true
      // Position within the ACTIVE filter: the full-row index means nothing
      // when the query already narrowed the list while the directory loaded
      // (a late resolve must not place the cursor outside `filtered`).
      const filteredIndex = filtered.indexOf(rows[index]!)
      setCursor(filteredIndex >= 0 ? filteredIndex : 0)
    } else if (cursor >= filtered.length) {
      setCursor(Math.max(0, filtered.length - 1))
    }
  }, [rows, filtered, cursor, current])

  useInput((input, key) => {
    if (key.escape || (input === 'q' && query === '')) {
      onClose()
      return
    }
    if (input === 'r' && query === '') {
      onRetry()
      return
    }
    if (key.tab && onProviders !== undefined) {
      onProviders()
      return
    }
    // Ctrl+C leaves the whole model configuration flow from any stage.
    if (key.ctrl && input === 'c') {
      onClose()
      return
    }
    const next = editQuery(query, input, key)
    if (next !== undefined) {
      setQuery(next)
      setCursor(0)
      return
    }
    if (filtered.length === 0) return
    if (key.upArrow) {
      setCursor(cursor > 0 ? cursor - 1 : filtered.length - 1)
      return
    }
    if (key.downArrow) {
      setCursor(cursor < filtered.length - 1 ? cursor + 1 : 0)
      return
    }
    if (key.pageUp) {
      setCursor(current => Math.max(0, current - Math.max(1, viewport.bodyRows - 1)))
      return
    }
    if (key.pageDown) {
      setCursor(current => Math.min(filtered.length - 1, current + Math.max(1, viewport.bodyRows - 1)))
      return
    }
    if (key.return && filtered[cursor] !== undefined) {
      onSelect(filtered[cursor])
    }
  })

  if (viewport.maxHeight === 0 || viewport.compact) {
    const providers = onProviders === undefined ? '' : ' · tab providers'
    const state = filtered.length === 0
      ? directory === undefined && error === undefined
        ? 'loading…'
        : error !== undefined
          ? 'error'
          : query === '' ? 'no models' : `no match for '${singleLineText(query)}'`
      : `❯ ${filtered[cursor]?.modelName ?? filtered[cursor]?.model ?? ''}`
    const tail = query === ''
      ? 'type to filter · r retry · esc/q close'
      : 'backspace edits · esc close'
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(`/model · ${state}${providers} · ${tail}`, viewport.contentColumns))
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
          : filtered.length === 0
            ? [createElement(Text, { key: 'no-match', dimColor: true, wrap: 'truncate-end' }, truncateColumns(`  no models match '${singleLineText(query)}'`, viewport.contentColumns))]
            : []),
      ]
  // Measurement and rendering share the same physical-row budget: state
  // messages consume body rows before selectable entries, as in Codex's
  // list-selection views.
  const visibleStateRows = stateRows.slice(0, viewport.bodyRows)
  const rowBudget = Math.max(0, viewport.bodyRows - visibleStateRows.length)
  const first = selectionWindow(cursor, filtered.length, rowBudget)
  const visible = rowBudget === 0 ? [] : filtered.slice(first, first + rowBudget)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(getPalette().brand) },
    createElement(Text, { color: inkColor(getPalette().brand), bold: true, wrap: 'truncate-end' }, truncateColumns(query === ''
      ? `/model — select model${rows.length === 0 ? '' : ` · ${cursor + 1}/${rows.length}`}`
      : `/model — select model · ${filtered.length} of ${rows.length} match '${singleLineText(query)}'`, viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...visibleStateRows,
    ...visible.map((row) => {
      const index = filtered.indexOf(row)
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
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, dim(truncateColumns(query === ''
      ? `type to filter · ↑↓ move · pgup/pgdn page · enter select${onProviders === undefined ? '' : ' · tab providers'} · r retry · esc/q close`
      : `↑↓ move · pgup/pgdn page · enter select · backspace edits · esc close`, viewport.contentColumns))),
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
function ProviderPanel({ directory, error, authorizations, authorizationError, onConfigure, onUnset, onRemove, onLogin, onLogout, onRetry, onBack, onExit }: {
  directory: ProviderSettingsDirectory | undefined
  error: string | undefined
  authorizations: ProviderAuthorizationDirectory | undefined
  authorizationError: string | undefined
  onConfigure(target: ProviderTargetView): void
  onUnset(target: ProviderTargetView): void
  onRemove(target: ProviderTargetView): void
  onLogin(target: ProviderTargetView, authorization: ProviderAuthorizationRow): void
  onLogout(target: ProviderTargetView, authorization: ProviderAuthorizationRow): void
  onRetry(): void
  onBack(): void
  /** Leave the whole /model flow (Ctrl+C), not just this stage. */
  onExit(): void
}): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const rows = directory?.rows ?? []
  // Configured providers float to the top so a long dormant tail never buries
  // the ones in use; a dim separator labels the boundary between groups.
  const sorted = [...rows].sort((left, right) =>
    (left.configured ? 0 : 1) - (right.configured ? 0 : 1))
  const configuredCount = sorted.filter(row => row.configured).length
  const hasSeparator = configuredCount > 0 && configuredCount < sorted.length
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
    if (key.ctrl && input === 'c') {
      onExit()
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
    const target = sorted[cursor]
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
    // Enter opens the unified setup page (key, endpoint, models, discovery):
    // the old split — Enter for the key alone, Tab for the deep menu — hid
    // the configuration surface behind an undiscoverable chord.
    if (key.return) {
      if (target.settingsNs.length === 0) {
        setActionError('this provider is not managed by Harness settings')
      } else {
        onConfigure(target)
      }
    }
  }, true)

  if (viewport.maxHeight === 0 || viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns('/model providers · enter configure · d remove key · esc back', viewport.contentColumns))
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
  const displayLength = sorted.length + (hasSeparator ? 1 : 0)
  const displayCursor = cursor + (hasSeparator && cursor >= configuredCount ? 1 : 0)
  const first = selectionWindow(displayCursor, displayLength, rowBudget)
  const itemRows: ReactElement[] = []
  for (let display = first; display < first + rowBudget && display < displayLength; display += 1) {
    if (hasSeparator && display === configuredCount) {
      itemRows.push(createElement(Text, { key: 'separator', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns('  ── not configured ──', viewport.contentColumns)))
      continue
    }
    const index = hasSeparator && display > configuredCount ? display - 1 : display
    const row = sorted[index]
    if (row === undefined) continue
    const identity = row.displayName === row.provider ? row.provider : row.displayName + ' (' + row.provider + ')'
    const authorization = authorizationForProvider(authorizations, row.provider)
    const manualKeyConfigured = row.credential?.kind === 'facts' && row.credential.configured
    const showAuthorization = !manualKeyConfigured || authorization?.record.configured === true || authorization?.inFlight === true
    const authLabel = showAuthorization ? ' · ' + providerAuthorizationStatus(authorization) : ''
    // The adapter's configuration diagnostic rides the row (the provider
    // stays listed and repairable — this is why it did not vanish).
    const diagnostic = row.diagnostic === undefined ? '' : ' · ! ' + singleLineText(row.diagnostic)
    const label = identity + ' · ' + providerStateLabel(row) + authLabel + (row.removable ? ' · custom' : '') + diagnostic
    // Configured rows render in the intermediate brand blue so the in-use
    // group reads at a glance; the dormant tail keeps the dim caption gray.
    const idleColor = row.configured ? inkColor(getPalette().brandMid) : inkColor(getPalette().dim)
    itemRows.push(createElement(
      Text,
      { key: row.provider, color: index === cursor ? inkColor(getPalette().brandBright) : idleColor, wrap: 'truncate-end' },
      truncateColumns((index === cursor ? '❯ ' : '  ') + displayText(label), viewport.contentColumns),
    ))
  }
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(getPalette().brand) },
    createElement(Text, { color: inkColor(getPalette().brand), bold: true, wrap: 'truncate-end' }, truncateColumns(`/model — providers${rows.length === 0 ? '' : ` · ${cursor + 1}/${rows.length}`}`, viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...visibleStateRows,
    ...itemRows,
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns('↑↓ move · enter configure · l login · o logout · d remove key · x remove provider · r retry · esc back', viewport.contentColumns)),
  )
}

/** Provider configuration editor: only explicit models are written to settings. */
/**
 * The unified provider setup page: API key, endpoint, and the explicit model
 * list (with per-model context/output capacities) on ONE screen — the deep
 * Tab menu and the separate key panel merged into a single discoverable
 * surface. A saved key rides the same Enter as the endpoint and models; an
 * empty endpoint keeps the provider's official default. Tab moves to the
 * discovery page, which interrogates the real endpoint and returns checkable
 * models for adoption; the last row also accepts hand-typed model ids.
 */
/** One declarable donor the setup page can copy reasoning efforts from verbatim. */
interface EffortDonor {
  /** Provider route the declaration lives on. */
  readonly provider: string
  /** Model id the declaration belongs to. */
  readonly id: string
  /** The stored display-level to wire-value map, copied verbatim. */
  readonly efforts: Record<string, string | null>
}

function ProviderSetupPanel({ target, save, saveCredential, discover, effortDonors, done, back, onExit }: {
  target: ProviderTargetView
  /** Models with declared efforts (settings first, catalog-advertised after) a model row can copy from. */
  effortDonors: readonly EffortDonor[]
  save(target: ProviderTargetView, configuration: ProviderConfiguration): Promise<void>
  saveCredential: ((target: ProviderTargetView, key: string) => Promise<void>) | undefined
  discover(target: ProviderTargetView, request: { readonly apiKey?: string; readonly baseURL?: string }, signal?: AbortSignal): Promise<readonly DiscoveredModelView[]>
  /** Report a successful save so the surface can notice the key rotation. */
  done(result: { readonly key: boolean }): void
  back(): void
  /** Leave the whole /model flow (Ctrl+C), not just this page. */
  onExit(): void
}): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [page, setPage] = useState<'setup' | 'discover' | 'donor'>('setup')
  const [keyDraft, setKeyDraft] = useState('')
  const [baseURL, setBaseURL] = useState(target.configuration.baseURL ?? '')
  const [models, setModels] = useState<readonly ProviderModelSettings[]>(target.configuration.models)
  const [cursor, setCursor] = useState(0)
  const [zone, setZone] = useState<'key' | 'url' | 'models'>('key')
  const [field, setField] = useState<'none' | 'ctx' | 'out'>('none')
  const [addDraft, setAddDraft] = useState('')
  /** Micro-editor for the selected model's reasoningEfforts declaration. */
  const [effEditing, setEffEditing] = useState(false)
  const [effDraft, setEffDraft] = useState('')
  const [donorCursor, setDonorCursor] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const credential = target.credential
  const keyStatus = saveCredential === undefined
    ? 'key storage unavailable'
    : credential?.kind === 'error'
      ? 'key status unavailable'
      : credential?.kind === 'facts' && credential.configured
        ? 'key saved' + (credential.source === undefined ? '' : ' · ' + credential.source)
        : 'no key set'
  // A dormant route (no resolved profile yet, so no credential facts) may
  // still receive a key: the save path materializes the apiKeyEnv reference
  // itself. Only a known-unwritable or indescribable credential blocks.
  const keyEditable = saveCredential !== undefined
    && (credential === undefined || (credential.kind === 'facts' && credential.writable))
  const onAddRow = cursor >= models.length
  const selected = onAddRow ? undefined : models[cursor]

  const updateSelected = (change: Partial<ProviderModelSettings>): void => {
    if (selected === undefined) return
    setModels(current => current.map((model, index) => index === cursor ? { ...model, ...change } : model))
  }

  const commitAddDraft = (): void => {
    const id = addDraft.trim()
    if (id === '') return
    if (models.some(model => model.id === id)) {
      setError('model "' + id + '" is already in the list')
      return
    }
    setError(undefined)
    setModels([...models, { id }])
    setCursor(models.length)
    setAddDraft('')
  }

  /** Compact declaration summary for the row label: count, off, or inherit. */
  const effortsSummary = (model: ProviderModelSettings): string => {
    const raw = (model.extras as Record<string, unknown> | undefined)?.reasoningEfforts
    if (raw === false) return 'off'
    if (isDeclaredReasoningEfforts(raw)) return String(Object.keys(raw).length)
    return '~'
  }

  /** Write (or clear) the selected model's declaration through extras. */
  const applyDeclaration = (value: ReasoningEffortsValue): void => {
    setModels(current => current.map((model, index) => {
      if (index !== cursor) return model
      const extras: Record<string, unknown> = { ...model.extras }
      if (value === undefined) delete extras.reasoningEfforts
      else extras.reasoningEfforts = value
      return { ...model, ...Object.keys(extras).length === 0 ? {} : { extras } }
    }))
  }

  /** Donors excluding the row being edited (copying from itself is a no-op). */
  const donorRows = selected === undefined
    ? []
    : effortDonors.filter(donor => !(donor.provider === target.provider && donor.id === selected.id))
  const donorIndex = Math.min(donorCursor, Math.max(0, donorRows.length - 1))
  const donorRow = donorRows[donorIndex]

  const submit = (): void => {
    if (busy) return
    const key = keyDraft.trim()
    // A typed key must never vanish silently: when it cannot be written here
    // (read-only env supply, or credential status failed to describe), refuse
    // the whole save with one actionable line instead of saving the endpoint
    // and models while dropping the key the user believes was stored.
    if (key !== '' && !keyEditable) {
      setError('this API key cannot be written here (read-only or status unavailable); clear the key field to save the endpoint and models alone')
      return
    }
    setBusy(true)
    setError(undefined)
    const keySave = key !== '' ? saveCredential : undefined
    void (async () => {
      if (keySave !== undefined) await keySave(target, key)
      await save(target, { ...(baseURL.trim() === '' ? {} : { baseURL }), models })
      return keySave !== undefined
    })().then(keySaved => done({ key: keySaved }), (reason: unknown) => {
      setBusy(false)
      setError(singleLineText(reason instanceof Error ? reason.message : String(reason)))
    })
  }

  useStableInput((input, key) => {
    if (busy) return
    // Ctrl+C leaves the whole model configuration flow from any stage.
    if (key.ctrl && input === 'c') {
      onExit()
      return
    }
    // Efforts micro-editor: consumes every key while open (space is the
    // pair separator, so the composer-style remove must not fire here).
    if (effEditing) {
      if (key.escape) { setEffEditing(false); setEffDraft(''); return }
      if (key.return) {
        const parsed = parseReasoningEffortsDraft(effDraft)
        if (!parsed.ok) { setError(parsed.error); return }
        setError(undefined)
        applyDeclaration(parsed.value)
        setEffEditing(false)
        setEffDraft('')
        return
      }
      if (key.backspace || key.delete) { setError(undefined); setEffDraft(current => deleteLastGrapheme(current)); return }
      if (key.ctrl && input === 'u') { setError(undefined); setEffDraft(''); return }
      if (key.ctrl || key.meta || input.length === 0) return
      if (effDraft.length > 200) { setError('efforts draft is too long'); return }
      setError(undefined)
      setEffDraft(current => current + stripPasteMarkers(input))
      return
    }
    // Donor picker: one page, up/down move, enter copies verbatim.
    if (page === 'donor') {
      if (key.escape || input === 'q') { setPage('setup'); return }
      if (donorRows.length === 0) return
      if (key.upArrow) { setDonorCursor(current => current > 0 ? current - 1 : donorRows.length - 1); return }
      if (key.downArrow) { setDonorCursor(current => current < donorRows.length - 1 ? current + 1 : 0); return }
      if (key.return && donorRow !== undefined) {
        applyDeclaration(donorRow.efforts)
        setError(undefined)
        setPage('setup')
      }
      return
    }
    if (key.escape || input === 'q') { back(); return }
    if (key.tab) { setPage('discover'); return }
    if (key.return) { submit(); return }
    if (zone === 'key') {
      // Typing stays available even when the key cannot be written here (a
      // read-only env supply, or a describe failure): the draft is local, and
      // Enter refuses the save with one actionable line instead of silently
      // dropping what the user typed.
      if (key.downArrow) { setZone('url'); return }
      if (key.backspace || key.delete) { setError(undefined); setKeyDraft(current => [...current].slice(0, -1).join('')); return }
      if (key.ctrl && input === 'u') { setError(undefined); setKeyDraft(''); return }
      if (key.ctrl || key.meta || input.length === 0) return
      const next = keyDraft + stripPasteMarkers(input)
      if (next.length > 4096) { setError('API key input is too long'); return }
      setError(undefined)
      setKeyDraft(next)
      return
    }
    if (zone === 'url') {
      if (key.upArrow) { setZone('key'); return }
      if (key.downArrow) { setZone('models'); return }
      if (key.backspace || key.delete) setBaseURL(current => deleteLastGrapheme(current))
      else if (!key.ctrl && !key.meta && input !== '') setBaseURL(current => current + stripPasteMarkers(input))
      return
    }
    // Models zone: the explicit list plus the hand-add row below it.
    if (key.upArrow) {
      setError(undefined)
      if (cursor === 0) setZone('url')
      else { setCursor(current => current - 1); setField('none') }
      return
    }
    if (key.downArrow) {
      setError(undefined)
      if (!onAddRow) { setCursor(current => current + 1); setField('none') }
      return
    }
    if (key.leftArrow || key.rightArrow) {
      if (selected === undefined) return
      const cycle = key.rightArrow
        ? (current: 'none' | 'ctx' | 'out') => current === 'none' ? 'ctx' : current === 'ctx' ? 'out' : 'none'
        : (current: 'none' | 'ctx' | 'out') => current === 'none' ? 'out' : current === 'out' ? 'ctx' : 'none'
      setField(current => cycle(current))
      return
    }
    if (input === ' ') {
      if (selected === undefined) commitAddDraft()
      else {
        setError(undefined)
        setField('none')
        setModels(current => current.filter((_model, index) => index !== cursor))
        setCursor(current => Math.min(current, Math.max(0, models.length - 1)))
      }
      return
    }
    if (onAddRow) {
      if (key.backspace || key.delete) { setError(undefined); setAddDraft(current => deleteLastGrapheme(current)); return }
      if (key.ctrl || key.meta || input.length === 0) return
      setError(undefined)
      setAddDraft(current => current + stripPasteMarkers(input))
      return
    }
    if (input === 'e' && selected !== undefined) {
      setError(undefined)
      setEffDraft(serializeReasoningEfforts((selected.extras as Record<string, unknown> | undefined)?.reasoningEfforts))
      setEffEditing(true)
      return
    }
    if ((input === 'c' || input === 'C') && !key.ctrl && selected !== undefined) {
      setError(undefined)
      setDonorCursor(0)
      setPage('donor')
      return
    }
    if (field !== 'none' && selected !== undefined) {
      const name = field === 'ctx' ? 'contextWindow' : 'maxTokens'
      const current = String(selected[name] ?? '')
      if (key.backspace || key.delete) {
        const next = current.slice(0, -1)
        updateSelected({ [name]: next === '' ? undefined : Number(next) })
      } else {
        // A pasted number arrives as one multi-character chunk; accept the
        // whole digit run instead of the single-character path only.
        const digits = stripPasteMarkers(input)
        if (/^[0-9]+$/u.test(digits)) updateSelected({ [name]: Number(current + digits) })
      }
    }
  }, page !== 'discover')
  if (viewport.maxHeight === 0 || viewport.bodyRows < 3) {
    // Never hide a live input surface: one visible row keeps the escape
    // route honest on extremely short terminals (the three fixed rows - key,
    // url, add-by-id - cannot fit below a three-row body).
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns('provider setup · terminal too small · esc back', viewport.contentColumns))
  }
  if (page === 'donor') {
    const stateRow = donorRows.length === 0
      ? createElement(Text, { key: 'empty', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns('  no model with declared efforts yet; declare one with e, or hand-write settings', viewport.contentColumns))
      : createElement(Text, { key: 'hint', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns('  copy verbatim into ' + displayText(selected?.id ?? ''), viewport.contentColumns))
    const donorBudget = Math.max(0, viewport.bodyRows - 2)
    const donorFirst = selectionWindow(donorIndex, donorRows.length, donorBudget)
    const donorVisible = donorRows.slice(donorFirst, donorFirst + donorBudget)
    return createElement(
      Box,
      { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(getPalette().brand) },
      createElement(Text, { color: inkColor(getPalette().brand), bold: true, wrap: 'truncate-end' }, truncateColumns('/model — copy efforts', viewport.contentColumns)),
      createElement(PanelGap, { visible: viewport.gapRows > 0 }),
      stateRow,
      ...donorVisible.map((donor, index) => {
        const active = donorFirst + index === donorIndex
        const label = (active ? '>' : ' ') + ' ' + donor.provider + '/' + displayText(donor.id) + ' · ' + serializeReasoningEfforts(donor.efforts)
        return createElement(Text, { key: donor.provider + '/' + donor.id, color: active ? inkColor(getPalette().brandBright) : inkColor(getPalette().text), wrap: 'truncate-end' }, truncateColumns(label, viewport.contentColumns))
      }),
      createElement(PanelGap, { visible: viewport.gapRows > 0 }),
      createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns('↑↓ move · enter copy · esc back', viewport.contentColumns)),
    )
  }
  if (page === 'discover') {
    return createElement(ProviderDiscoveryPanel, {
      target,
      baseURL,
      apiKey: keyDraft,
      configured: models.map(model => model.id),
      discover,
      onAdopt: adopted => {
        const existing = new Set(models.map(model => model.id))
        const fresh = adopted.filter(model => !existing.has(model.id))
        if (fresh.length > 0) {
          setModels([...models, ...fresh.map(model => ({
            id: model.id,
            ...model.name === undefined ? {} : { name: model.name },
            ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
            ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
          }))])
          setCursor(models.length)
        }
        setPage('setup')
      },
      back: () => setPage('setup'),
      onExit,
    })
  }
  const stateRows = error === undefined ? [] : [createElement(Text, { key: 'error', color: inkColor(getPalette().error), wrap: 'truncate-end' }, truncateColumns('  ' + error, viewport.contentColumns))]
  const keyBullets = '•'.repeat(Math.min([...keyDraft].length, Math.max(1, viewport.contentColumns - 14)))
  const keyRow = createElement(Text, { key: 'key', color: zone === 'key' ? inkColor(getPalette().brandBright) : inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(('  ' + (zone === 'key' ? '>' : ' ') + ' key   ' + keyBullets + (zone === 'key' && !busy ? '▏' : '') + (keyDraft === '' ? ' (' + keyStatus + ')' : busy ? ' saving…' : '')).replace(/ +$/u, ''), viewport.contentColumns))
  const urlRow = createElement(Text, { key: 'url', color: zone === 'url' ? inkColor(getPalette().brandBright) : inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns('  ' + (zone === 'url' ? '>' : ' ') + ' url   ' + (baseURL === '' ? '(official default)' : baseURL) + (zone === 'url' ? '▏' : ''), viewport.contentColumns))
  // The fixed diagnostic row (present only with an adapter error) joins the
  // same height budget as the state rows — it must never overflow the panel.
  const rowBudget = Math.max(0, viewport.bodyRows - stateRows.length - (target.diagnostic === undefined ? 0 : 1) - 3)
  const first = selectionWindow(cursor, models.length + 1, rowBudget)
  const modelRows: ReactElement[] = []
  for (let index = first; index < first + Math.max(0, Math.min(models.length + 1 - first, rowBudget)); index += 1) {
    if (index >= models.length) {
      modelRows.push(createElement(Text, { key: 'add', color: cursor === index ? inkColor(getPalette().brandBright) : inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns('  ' + (cursor === index ? '>' : ' ') + ' + add by id' + (addDraft === '' ? '' : ' ' + addDraft + '▏'), viewport.contentColumns)))
      continue
    }
    const model = models[index]!
    const active = index === cursor
    const context = model.contextWindow === undefined ? '-' : String(model.contextWindow)
    const output = model.maxTokens === undefined ? '-' : String(model.maxTokens)
    const editing = active && effEditing
    const tail = editing
      ? '  eff:' + effDraft + '▏'
      : '  in:' + (active && field === 'ctx' ? '[' + context + ']' : context) + ' out:' + (active && field === 'out' ? '[' + output + ']' : output) + ' eff:' + effortsSummary(model)
    modelRows.push(createElement(Text, { key: model.id, color: active ? inkColor(getPalette().brandBright) : inkColor(getPalette().success), wrap: 'truncate-end' }, truncateColumns('  ' + (active ? '>' : ' ') + ' [x] ' + displayText(model.id) + tail, viewport.contentColumns)))
  }
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(getPalette().brand) },
    createElement(Text, { color: inkColor(getPalette().brand), bold: true, wrap: 'truncate-end' }, truncateColumns('/model — configure ' + target.displayName, viewport.contentColumns)),
    // The adapter's configuration diagnostic heads the editor: the provider
    // is here precisely because it stayed listed for repair.
    ...(target.diagnostic === undefined ? [] : [createElement(
      Text,
      { key: 'diagnostic', color: inkColor(getPalette().warn), wrap: 'truncate-end' },
      truncateColumns('! ' + displayText(singleLineText(target.diagnostic)), viewport.contentColumns),
    )]),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    keyRow,
    urlRow,
    ...stateRows,
    ...modelRows,
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns('↑↓ move · ←→ in/out · space remove · e efforts · c copy efforts · tab discover · enter save · esc back', viewport.contentColumns)),
  )
}

/**
 * The discovery stage of the provider setup page: interrogates the endpoint
 * the drafts describe (typed key wins over the stored credential) and offers
 * the advertised models as a checkable list. Already-configured ids render
 * verified but untoggleable; Enter adopts every checked model back into the
 * setup page's list — selective adoption, never a bulk import.
 */
function ProviderDiscoveryPanel({ target, baseURL, apiKey, configured, discover, onAdopt, back, onExit }: {
  target: ProviderTargetView
  baseURL: string
  apiKey: string
  configured: readonly string[]
  discover(target: ProviderTargetView, request: { readonly apiKey?: string; readonly baseURL?: string }, signal?: AbortSignal): Promise<readonly DiscoveredModelView[]>
  onAdopt(models: readonly DiscoveredModelView[]): void
  back(): void
  /** Leave the whole /model flow (Ctrl+C). */
  onExit(): void
}): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [epoch, setEpoch] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [rows, setRows] = useState<readonly DiscoveredModelView[]>([])
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  const [cursor, setCursor] = useState(0)
  useEffect(() => {
    // One probe per epoch (mount and explicit 'f'); leaving the page aborts.
    // The drafts are captured when the page opened — adopting unmounts this
    // stage, so re-renders must not re-interrogate the endpoint.
    const controller = new AbortController()
    setLoading(true)
    setError(undefined)
    discover(target, {
      ...(baseURL.trim() === '' ? {} : { baseURL: baseURL.trim() }),
      ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
    }, controller.signal).then(discovered => {
      if (controller.signal.aborted) return
      setRows(discovered)
      const alreadyKnown = new Set(configured)
      const firstNew = discovered.findIndex(model => !alreadyKnown.has(model.id))
      setCursor(firstNew < 0 ? 0 : firstNew)
      setLoading(false)
    }, (reason: unknown) => {
      if (controller.signal.aborted) return
      setError(singleLineText(reason instanceof Error ? reason.message : String(reason)))
      setLoading(false)
    })
    return () => { controller.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch])
  const known = new Set(configured)
  useStableInput((input, key) => {
    if (key.escape || input === 'q') { back(); return }
    if (key.ctrl && input === 'c') { onExit(); return }
    if (input === 'f') { setChecked(new Set()); setEpoch(current => current + 1); return }
    if (loading || error !== undefined) return
    if (rows.length === 0) return
    if (key.upArrow) { setCursor(current => current > 0 ? current - 1 : rows.length - 1); return }
    if (key.downArrow) { setCursor(current => current < rows.length - 1 ? current + 1 : 0); return }
    const row = rows[cursor]
    if (row === undefined) return
    if (input === ' ') {
      if (known.has(row.id)) return
      setChecked(current => {
        const next = new Set(current)
        if (next.has(row.id)) next.delete(row.id)
        else next.add(row.id)
        return next
      })
      return
    }
    if (key.return) {
      onAdopt(rows.filter(model => checked.has(model.id)))
    }
  }, true)
  if (viewport.maxHeight === 0) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns('model discovery · terminal too small · esc back', viewport.contentColumns))
  }
  const stateRows = loading
    ? [createElement(Text, { key: 'loading', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns('  discovering models…', viewport.contentColumns))]
    : error !== undefined
      ? [createElement(Text, { key: 'error', color: inkColor(getPalette().error), wrap: 'truncate-end' }, truncateColumns('  ' + error, viewport.contentColumns))]
      : rows.length === 0
        ? [createElement(Text, { key: 'empty', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns('  the endpoint advertised no models; add ids by hand on the setup page', viewport.contentColumns))]
        : [createElement(Text, { key: 'summary', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns('  ' + rows.length + ' advertised · ' + rows.filter(model => !known.has(model.id)).length + ' new · ' + checked.size + ' checked', viewport.contentColumns))]
  // One spare row keeps the panel strictly below maxHeight even with the
  // gap collapsed (the at-equality regime makes Ink rewrite Static).
  const rowBudget = Math.max(0, viewport.bodyRows - stateRows.length - 1)
  const first = selectionWindow(cursor, rows.length, rowBudget)
  const visible = rows.slice(first, first + rowBudget)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(getPalette().brand) },
    createElement(Text, { color: inkColor(getPalette().brand), bold: true, wrap: 'truncate-end' }, truncateColumns('/model — discover ' + target.displayName, viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...stateRows,
    ...visible.map((model, index) => {
      const absolute = first + index
      const active = absolute === cursor
      const added = known.has(model.id)
      const mark = added ? '✓' : checked.has(model.id) ? '☑' : '☐'
      const label = (active ? '>' : ' ') + ' ' + mark + ' ' + displayText(model.id) + (model.name === undefined || model.name === model.id ? '' : ' · ' + displayText(model.name))
      return createElement(Text, { key: model.id, color: added ? inkColor(getPalette().dim) : active ? inkColor(getPalette().brandBright) : inkColor(getPalette().text), wrap: 'truncate-end' }, truncateColumns(label, viewport.contentColumns))
    }),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns('↑↓ move · space check · enter adopt · f refetch · esc back', viewport.contentColumns)),
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

  const action = kind === 'credential' ? 'remove API key' : 'remove provider'
  if (viewport.maxHeight === 0 || viewport.compact) {
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

  if (viewport.maxHeight === 0 || viewport.compact) {
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

/** Index of the cell STARTING at a display column, if one does. */
function cellIndexAtColumn(cells: readonly ComposerCell[], target: number): number | undefined {
  let column = 0
  for (let index = 0; index < cells.length; index += 1) {
    if (column === target) return index
    column += cells[index]!.width ?? visibleColumns(cells[index]!.char)
    if (column > target) return undefined
  }
  return undefined
}

/**
 * Wall-clock wave frames — strictly ONE sweep per MOUNT; the mount-spanning
 * one-shot latch (surviving modal unmounts) lives in Input as `wavePlayedKey`.
 * The first gate-off after the sweep has started (it completed, a turn went
 * busy, image preparation began, animations were toggled off) latches `done`
 * for this mount, so the same mount can never resume or replay. A trigger
 * that lands while the gate is already down stays pending until the gate
 * rises once, then plays.
 */
function useWaveFrames(active: boolean, durationMs: number): { tick: number; done: boolean } {
  const [tick, setTick] = useState(0)
  const [done, setDone] = useState(false)
  const startedRef = useRef(false)
  useEffect(() => {
    if (done) return
    if (!active) {
      // A sweep that already started is cancelled permanently, never resumed.
      if (startedRef.current) setDone(true)
      return
    }
    startedRef.current = true
    const startedAt = Date.now()
    const id = setInterval(() => {
      const elapsed = Date.now() - startedAt
      if (elapsed >= durationMs) {
        clearInterval(id)
        setDone(true)
        return
      }
      setTick(Math.max(0, Math.floor(elapsed / DEEPSEEK_WAVE_TICK_MS)))
    }, DEEPSEEK_WAVE_TICK_MS)
    return () => {
      clearInterval(id)
    }
  }, [active, durationMs, done])
  return { tick, done }
}

/** The wave-painted composer band: everything the sweep needs, as data. */
interface ComposerWaveProps {
  /** Wave tier of the applied route (flash / deepseek / unknown). */
  tier: DeepseekWaveTier
  /** Ignition style App picked for this trigger. */
  style: DeepseekWaveStyle
  /** False while busy, preparing images, or animations are off; the fallback
   * band renders instead (non-wave routes keep it false permanently). */
  active: boolean
  /** The static band to render before, after, and instead of the sweep. */
  fallback: ReactElement
  /** Composer band width in columns (terminal width minus the last column). */
  bandWidth: number
  /** Ink color of the static band background (the transparent-cell base). */
  bandBg: string
  /** The editor's visible physical rows (already windowed). */
  rows: readonly EditorRowModel[]
  /** Index of `rows[0]` in the full editor model (keying + caret row math). */
  windowStart: number
  /** Absolute caret row in the editor model. */
  caretRow: number
  /** The authoritative cursor offset. */
  cursor: number
  /** Caret blink visibility (shared with the static path). */
  caretVisible: boolean
  /** The draft text (placeholder detection on row 0). */
  value: string
  /** Tier prompt glyph and accent color (persistent, like Codex's charge). */
  promptGlyph: string
  promptColor: string
  /** Fires EXACTLY ONCE when this sweep ends for any reason — completed,
   * cancelled by the gate, or unmounted (a modal panel froze the composer) —
   * so Input's played-key latch survives the leaf's unmount/remount cycle. */
  onSettled(): void
}

/**
 * The self-contained wave leaf: it owns its 33ms tick, so the sweep
 * re-renders ONLY this component at ~30fps — Input's derived editor state
 * never re-runs per frame. Graphemes stay atomic and every background sample
 * advances by terminal display columns, so CJK and emoji cannot move the
 * caret or wrap the band. The duration gate renders the fallback band on the
 * frame the sweep completes.
 */
function ComposerWave(props: ComposerWaveProps): ReactElement {
  const { tier, style } = props
  const durationMs = deepseekWaveDuration(tier, style)
  const { tick, done } = useWaveFrames(props.active, durationMs)
  // Report the sweep's end exactly once — completion, gate cancellation, or
  // unmount (a modal opened and froze the composer) — latching Input's
  // played-key so this trigger can never replay after a remount.
  const settledRef = useRef(false)
  const onSettledRef = useRef(props.onSettled)
  onSettledRef.current = props.onSettled
  const settle = (): void => {
    if (settledRef.current) return
    settledRef.current = true
    onSettledRef.current()
  }
  useEffect(() => {
    if (done) settle()
  }, [done])
  useEffect(() => () => {
    settle()
  }, [])
  if (!props.active || done || tick * DEEPSEEK_WAVE_TICK_MS >= durationMs) return props.fallback
  const hues = deepseekWaveHues(tier)
  const bandRgb = getPalette().composerBand
  const totalBandRows = props.rows.length + 2
  const waveBg = (row: number, column: number): string => {
    const rgb = deepseekWaveColumnBg(tick, column, props.bandWidth, tier, style, hues, bandRgb, row, totalBandRows)
    return rgb === null ? props.bandBg : inkColor(rgb)
  }
  const blankBandRow = (row: number): ReactElement => {
    const blanks: ComposerCell[] = []
    for (let column = 0; column < props.bandWidth; column += 1) {
      blanks.push({ char: ' ', width: 1, backgroundColor: waveBg(row, column) })
    }
    return createElement(Text, { key: `blank-${row}` }, ...waveRowSpans(blanks))
  }
  const editorWaveRows = props.rows.map((row, visibleIndex) => {
    const sourceIndex = props.windowStart + visibleIndex
    const bandRow = visibleIndex + 1
    const parts = editorRowParts(row, sourceIndex, props.caretRow, props.cursor)
    const placeholder = sourceIndex === 0 && props.value === ''
    const cells: ComposerCell[] = []
    let usedColumns = 0
    const push = (char: string, extra: Omit<ComposerCell, 'char' | 'width' | 'backgroundColor'> = {}): void => {
      const width = visibleColumns(char)
      cells.push({ char, width, backgroundColor: waveBg(bandRow, usedColumns), ...extra })
      usedColumns += width
    }
    if (sourceIndex === 0) {
      push(props.promptGlyph, { color: props.promptColor, bold: true })
      push(' ', { color: props.promptColor })
    } else {
      push(' ')
      push(' ')
    }
    for (const span of splitGraphemes(parts.before)) push(span.text)
    if (parts.hasCaret) push(parts.caret, { inverse: props.caretVisible })
    const tail = placeholder ? COMPOSER_PLACEHOLDER : parts.after
    for (const span of splitGraphemes(tail)) push(span.text, placeholder ? { dim: true } : {})
    while (usedColumns < props.bandWidth) push(' ')

    const middleBandRow = Math.floor(totalBandRows / 2)
    if (bandRow === middleBandRow && deepseekWaveWordVisible(tick, tier, style)) {
      const word = tier === 'unknown' ? 'Into the Unknown' : 'deepseek'
      const start = Math.max(2, Math.floor((props.bandWidth - word.length) / 2))
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
    if (bandRow === middleBandRow && (tier === 'deepseek' || tier === 'unknown') && style === 'wave') {
      const spark = deepseekWaveSpark(tick)
      const lastIndex = cellIndexAtColumn(cells, props.bandWidth - 1)
      if (spark !== null && lastIndex !== undefined && cells[lastIndex]!.char === ' ') {
        cells[lastIndex]!.char = spark
        cells[lastIndex]!.color = props.promptColor
        cells[lastIndex]!.bold = true
        cells[lastIndex]!.dim = false
      }
    }
    return createElement(Text, { key: `editor-${sourceIndex}`, wrap: 'truncate-end' }, ...waveRowSpans(cells))
  })
  return createElement(
    Box,
    { flexDirection: 'column', width: props.bandWidth },
    blankBandRow(0),
    ...editorWaveRows,
    blankBandRow(totalBandRows - 1),
  )
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

  if (viewport.maxHeight === 0 || viewport.compact) {
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
  // Fuzzy ranking (the web menu's discovery feel): the query must be a
  // case-insensitive ordered subsequence of a name; prefix hits first, then
  // alignment score, then this composition order. An empty query keeps the
  // full list.
  return rankByName(all.map(candidate => ({ name: candidate.label.slice(1), candidate })), prefix)
    .map(entry => entry.candidate)
}

/**
 * Shared completion-menu geometry: the menu view and the App's dynamic-row
 * budget MUST derive the exact same physical height, or an open menu silently
 * overflows the terminal during streaming (the cursor creeps past the top and
 * the live region freezes). One helper, two consumers — never drift.
 */
function completionMenuMetrics(terminalRows: number): { limit: number; showFooter: boolean; verticalPadding: number } {
  const showFooter = terminalRows >= 12
  const verticalPadding = terminalRows >= 14 ? 1 : 0
  const limit = Math.max(1, Math.min(6, terminalRows - (showFooter ? 11 : 10) - verticalPadding * 2))
  return { limit, showFooter, verticalPadding }
}

/**
 * The menu's total physical row count at this terminal height: visible
 * candidates (or the single "searching…" row), the overflow marker, the
 * footer, and both padding rows.
 */
function completionMenuRowCount(terminalRows: number, rowCount: number): number {
  const { limit, showFooter, verticalPadding } = completionMenuMetrics(terminalRows)
  const visible = rowCount === 0 ? 1 : Math.min(rowCount, limit)
  const hidden = rowCount === 0 ? 0 : rowCount - visible
  return visible + (hidden > 0 ? 1 : 0) + (showFooter ? 1 : 0) + verticalPadding * 2
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
function CompletionMenu({ active, mention, index, rows, error }: {
  active: boolean
  mention: boolean
  index: number
  rows: readonly CompletionCandidate[]
  /** Live mention-discovery failure; replaces the empty "searching…" row. */
  error?: string
}): ReactElement | undefined {
  // Hook order is unconditional: `active` toggling must not change the hook
  // count (the early return used to sit above useStdout).
  const stdout = useStdout().stdout
  const columns = stdout?.columns ?? 80
  const terminalRows = stdout?.rows ?? 30
  if (!active) return undefined
  const contentColumns = Math.max(1, columns - 4)
  // Geometry comes from the shared helper so the menu and the App's dynamic
  // budget always agree on its exact physical height.
  // File paths are the decision-making data in an @ menu. Give mentions the
  // full available line and sacrifice their repetitive kind label first.
  const nameWidth = mention
    ? Math.max(1, contentColumns - 2)
    : Math.min(18, Math.max(1, contentColumns - 2), Math.max(0, ...rows.map(row => visibleColumns(row.label))) + 2)
  const descBudget = Math.max(0, contentColumns - nameWidth - 2)
  const { limit, showFooter, verticalPadding } = completionMenuMetrics(terminalRows)
  const selected = rows.length === 0 ? 0 : index % rows.length
  const first = selectionWindow(selected, rows.length, limit)
  const visible = rows.slice(first, first + limit)
  const hidden = rows.length - visible.length
  return createElement(
    Box,
    { flexDirection: 'column', marginLeft: 2, paddingY: verticalPadding },
    ...(rows.length === 0
      ? [error === undefined
        ? createElement(Text, { key: 'loading', dimColor: true }, 'searching…')
        : createElement(
          Text,
          { key: 'error', color: inkColor(getPalette().error), wrap: 'truncate-end' },
          truncateColumns(`workspace search unavailable: ${singleLineText(error)} · keep typing to retry`, contentColumns),
        )]
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

/** One attached non-image file held in the editor until submission persists it. */
interface DraftFile extends FilePathInspection {
  /** Visible draft token; deleting it also detaches the hidden path. */
  readonly marker: string
}

/**
 * The prompt box: TUI-local slash commands handled locally, other lines
 * dispatched; input editing keeps a cursor with history and completion.
 * While a modal (approval / question / model panel) owns the keys, the
 * box passes every key through untouched.
 */
function Input({ active, frozen, frozenHint, busy, descriptors, skills, dispatch, steer, interrupt, quit, openModel, openEffort, openHelp, openMode, openPermission, openResume, openPlugin, openUpdate, openSchedule, openJobs, openStatusline, openTheme, openHistory, openAgents, openSubagent, openTodos, openDelete, openDiff, reviewChanges, deleteConfirm, confirmDelete, cancelDelete, createSession, forkSession, cancelSessionSwitch, notify, applyEditorKeys, hasNotice, dismissNotice, toggleReasoning, openVerbose, clearView, refresh, loadMentions, inspectImages, prepareImages, inspectFiles, prepareFiles, cycleMode, exportTranscript, renameTitle, copyLastResponse, recallSpace, recordLocal, recordHistory, queued, cancelQueued, historyFill, historyConsumed, animations, applyAnimations, waveTier, waveStyle, maxRows, anchorRowsBelow, tabTitle, onEditorRows, onMenuRows, sessionKey }: {
  active: boolean
  frozen: boolean
  /** Frozen-band hint naming the surface that owns the keyboard; an empty
   * draft otherwise advertises typing that the composer cannot accept. */
  frozenHint?: string
  busy: boolean
  descriptors: readonly CommandDescriptor[]
  skills: readonly SkillRow[]
  dispatch(text: string, attachments?: readonly ContentBlock[], origin?: string): void
  steer(text: string, attachments?: readonly ContentBlock[], origin?: string): void
  /** The full current session identity ('' while pending); the delivery origin. */
  sessionKey: string
  interrupt(): boolean
  quit(): void
  openModel(): void
  openEffort(): void
  openHelp(): void
  openMode(): void
  openPermission(): void
  openResume(): void
  openPlugin(query?: string): void
  /** Open the /update panel (aligned upgrade surface). */
  openUpdate(): void
  /** Open the /schedule reminder panel (read-only catalog). */
  openSchedule(): void
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
  inspectFiles(paths: readonly string[]): Promise<readonly FilePathInspection[]>
  prepareFiles(paths: readonly string[], signal?: AbortSignal): Promise<readonly FileBlock[]>
  cycleMode(): string
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
  /** Whether timed animations run (shimmer, chase, blink, wave). */
  animations: boolean
  /** Apply and report one /animation toggle (App persists through the runner). */
  applyAnimations(enabled: boolean): void
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
  /** Terminal rows below the composer the editor does not own: the status
   * footer and Ink's parked cursor row. The IME anchor adds these to the
   * caret's in-band offset to reach that parked position. */
  anchorRowsBelow: number
  /** The managed terminal tab label; re-asserted on terminal focus-in so a
   * background process sharing the console cannot keep it overwritten. */
  tabTitle: string
  /** Reports the editor's current physical row count so the live budget stays exact. */
  onEditorRows(rows: number): void
  /** Reports the open completion menu's physical row count (0 when closed)
   * for the same reason: the dynamic budget must reserve it, not overflow. */
  onMenuRows(rows: number): void
}): ReactElement {
  const { stdout: inputStdout } = useStdout()
  const columns = inputStdout?.columns ?? 80
  const inputTerminalRows = inputStdout?.rows ?? 30
  // The managed tab label, kept current for the focus-in re-assert below.
  const tabTitleRef = useRef(tabTitle)
  tabTitleRef.current = tabTitle
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
  const [draftFiles, setDraftFiles] = useState<readonly DraftFile[]>([])
  const draftFilesRef = useRef(draftFiles)
  draftFilesRef.current = draftFiles
  const [preparingImages, setPreparingImages] = useState(false)
  const prepareAbortRef = useRef<AbortController | undefined>(undefined)
  const prepareEpochRef = useRef(0)
  const { visible: cursorVisible, reset: resetCursorBlink } = useCursorBlink(active && !frozen && !preparingImages && animations)
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
    draftFilesRef.current = []
    setDraftFiles([])
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
    setDraftFiles((current) => {
      const next = current.filter(file => value.includes(file.marker))
      draftFilesRef.current = next
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
          // Focus-in re-asserts the managed tab label on both channels: a
          // background process sharing this console (a test-runner worker,
          // for example) may have overwritten the console title while the
          // terminal was unfocused.
          if (focused && inputStdout !== undefined) {
            inputStdout.write(terminalTitleSequence(tabTitleRef.current))
            process.title = sanitizeTerminalTitle(tabTitleRef.current)
          }
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
  /** Latest mention-discovery failure; shown in the menu instead of an empty list. */
  const [mentionError, setMentionError] = useState<string | undefined>(undefined)
  const mentionRequestRef = useRef(0)

  const sameImagePath = (left: string, right: string): boolean => (
    process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
  )

  const uniqueImageMarker = (name: string, source: 'mention' | 'drop', reserved: readonly string[] = [], kind: 'image' | 'file' = 'image'): string => {
    const safeName = singleLineText(sanitizeDraftText(name))
    const label = kind === 'file' ? 'file' : 'image'
    const base = source === 'mention' ? `@${safeName}` : `[${label}: ${safeName}]`
    let marker = base
    let suffix = 2
    const taken = (candidate: string): boolean =>
      valueRef.current.includes(candidate)
      || draftImagesRef.current.some(image => image.marker === candidate)
      || draftFilesRef.current.some(file => file.marker === candidate)
      || reserved.includes(candidate)
    while (taken(marker)) {
      marker = source === 'mention' ? `@${safeName} (${suffix})` : `[${label}: ${safeName} ${suffix}]`
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

  /**
   * Attach a paste/drop split into image and non-image paths: images ride the
   * durable image blocks, files ride the 0.1.5 file blocks, and both register
   * visible draft markers anchored at the drop point.
   */
  const insertDroppedAttachments = (imagePaths: readonly string[], filePaths: readonly string[]): void => {
    const originalValue = valueRef.current
    const originalCursor = cursorRef.current
    const total = imagePaths.length + filePaths.length
    if (total === 0) return
    notify(`checking ${total} attachment${total === 1 ? '' : 's'}…`)
    void Promise.all([
      imagePaths.length === 0 ? Promise.resolve([]) : inspectImages(imagePaths),
      filePaths.length === 0 ? Promise.resolve([]) : inspectFiles(filePaths),
    ]).then(([inspectedImages, inspectedFiles]) => {
      const imageAdditions: DraftImage[] = []
      const fileAdditions: DraftFile[] = []
      const markers: string[] = []
      for (const inspection of inspectedImages) {
        if ([...draftImagesRef.current, ...imageAdditions].some(image => sameImagePath(image.path, inspection.path))) continue
        const marker = uniqueImageMarker(inspection.name, 'drop', markers)
        imageAdditions.push({ ...inspection, marker })
        markers.push(marker)
      }
      for (const inspection of inspectedFiles) {
        if ([...draftFilesRef.current, ...fileAdditions].some(file => sameImagePath(file.path, inspection.path))) continue
        const marker = uniqueImageMarker(inspection.name, 'drop', markers, 'file')
        fileAdditions.push({ ...inspection, marker })
        markers.push(marker)
      }
      if (imageAdditions.length === 0 && fileAdditions.length === 0) {
        notify('those attachments are already attached', 'warning')
        return
      }
      const current = valueRef.current
      const anchor = remapStableRange(originalValue, current, { start: originalCursor, end: originalCursor })
      if (anchor === undefined) {
        notify('draft changed at the attachment drop point; drop the files again', 'warning')
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
      const nextImages = [...draftImagesRef.current, ...imageAdditions]
      draftImagesRef.current = nextImages
      setDraftImages(nextImages)
      const nextFiles = [...draftFilesRef.current, ...fileAdditions]
      draftFilesRef.current = nextFiles
      setDraftFiles(nextFiles)
      const count = imageAdditions.length + fileAdditions.length
      notify(`${count} attachment${count === 1 ? '' : 's'} ready for the next message`)
    }, (reason: unknown) => {
      notify(`attachment failed: ${reason instanceof Error ? reason.message : String(reason)}`, 'error')
    })
  }

  useEffect(() => {
    const requestId = mentionRequestRef.current + 1
    mentionRequestRef.current = requestId
    if (!active || !mentionActive) {
      setMentionRows([])
      setMentionError(undefined)
      return
    }
    setMentionError(undefined)
    const controller = new AbortController()
    const query = mentionToken.query
    const timer = setTimeout(() => {
      void loadMentions(query, controller.signal).then(
        rows => {
          if (!controller.signal.aborted && mentionRequestRef.current === requestId) setMentionRows(rows)
        },
        (reason: unknown) => {
          if (!controller.signal.aborted && mentionRequestRef.current === requestId) {
            setMentionRows([])
            setMentionError(reason instanceof Error ? reason.message : String(reason))
          }
        },
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
  // Fuzzy ordering over the upstream candidates (≤20 per page, cheaper than
  // the slash menu): rows whose name contains the typed query as an ordered
  // subsequence rise to the top by alignment, and every other upstream row
  // keeps its place after them — the upstream matcher has its own relevance
  // semantics (path segments), so ranking reorders but never drops rows. A
  // path-like query keeps the upstream order entirely.
  let rankedMentionRows = visibleMentionRows
  if (mentionToken !== undefined && !isPathLikeMentionQuery(mentionToken.query) && mentionToken.query !== '') {
    const hits = rankByName(visibleMentionRows.map(row => ({ name: row.label.replace(/^@/u, ''), row })), mentionToken.query)
      .map(entry => entry.row)
    const hitSet = new Set(hits)
    rankedMentionRows = [...hits, ...visibleMentionRows.filter(row => !hitSet.has(row))]
  }
  const menuRows: readonly CompletionCandidate[] = mentionActive
    ? rankedMentionRows.map(row => ({
      label: row.label.startsWith('@')
        ? row.label
        : `@${row.label}${row.kind === 'directory' ? '/' : ''}`,
      description: row.description,
      origin: 'mention',
    }))
    : candidates
  // Exact physical height of the open menu, derived from the same shared
  // geometry the menu view uses — reported one-way (onEditorRows pattern) so
  // the App's dynamic budget can reserve it instead of overflowing.
  const menuHeightRows = menuActive ? completionMenuRowCount(inputTerminalRows, menuRows.length) : 0

  /** Accept the highlighted completion-menu candidate into the draft. */
  const acceptMenuCandidate = (): void => {
    if (mentionActive && mentionToken !== undefined) {
      if (rankedMentionRows.length === 0) return
      const row = rankedMentionRows[completionIndex % rankedMentionRows.length]
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

  /** Cross history while an unchanged recalled draft rests its caret on
   * either text edge; between the edges (or inside ordinary drafts) the
   * arrows move through visual rows first. */
  const navigateVertical = (direction: -1 | 1): void => {
    const currentValue = valueRef.current
    const currentCursor = cursorRef.current
    // History owns the arrows while an unchanged recalled draft rests its
    // caret on either text edge (start or end). Everywhere else - edited
    // drafts, interior carets, ordinary typing - the arrows move through
    // visual rows as plain editing.
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
        // Suppress the completion menu for the recalled text: a recalled
        // command would otherwise reopen the menu, whose Up/Down navigation
        // then traps the walk before it reaches older history entries. Any
        // edit re-opens the menu; submitting resets the dismissal.
        setDismissedMenuValue(safe)
      }
      resetCursorBlink()
      return
    }
    const model = editorModel(currentValue, editorColumns)
    const preferred = preferredColumnRef.current ?? caretSite(model, currentCursor).column
    const next = moveCursorVertically(model, currentCursor, preferred, direction)
    if (next !== currentCursor) {
      cursorRef.current = next
      setCursor(next)
      resetCursorBlink()
      preferredColumnRef.current = preferred
    }
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
    // Shift+Tab cycles the mode stations: permission presets, then the
    // plan station when the composition offers it (Claude-Code convention).
    if (key.tab && key.shift) {
      try {
        const label = cycleMode()
        if (label !== '') notify(label)
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
        draftFilesRef.current = []
        setDraftFiles([])
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
      // Ink gives Backspace (\x7f) and forward Delete the same `key.delete`
      // identity; only the raw editor tokens separate them. The destructive
      // queue cancel is Delete-only (the footer says "Delete on the empty
      // composer cancels") — a habitual Backspace must stay inert here.
      const forwardDelete = rawEditorTokens.current?.some(token =>
        token.kind === 'delete-forward' || token.kind === 'delete-word-forward') === true
      if (forwardDelete) {
        cancelQueued(queued[queued.length - 1]!.messageId)
        return
      }
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
      // Payload fidelity: trim() is a blank check, not a rewrite. Ordinary
      // prompts keep their exact indentation and trailing whitespace (pasted
      // code must reach the model verbatim); slash lines normalize so the
      // completion-inserted trailing space still routes `/quit ` correctly.
      const trimmed = liveValue.trim()
      const text = submissionPayload(liveValue)
      if (draftImagesRef.current.length > 0 || draftFilesRef.current.length > 0) {
        // Slash semantics with attachments are unchanged: commands cannot
        // carry attachments, so the line goes to the model as a prompt —
        // warn instead of surprising the user with a literal "/export".
        if (isSlashLine(text)) notify('commands cannot carry attachments; the line will be sent to the model as a prompt', 'warning')
        // Attachment prepares resolve asynchronously; the app remounts onto
        // another session in the meantime, and this (old) instance's unmount
        // cleanup runs too late on the microtask timeline. Tag the delivery
        // with the composing session so the runner can drop the stale one.
        const originSession = sessionKey
        const controller = new AbortController()
        const epoch = prepareEpochRef.current + 1
        prepareEpochRef.current = epoch
        prepareAbortRef.current = controller
        setPreparingImages(true)
        const imageSnapshot = draftImagesRef.current
        const fileSnapshot = draftFilesRef.current
        const total = imageSnapshot.length + fileSnapshot.length
        notify(`processing ${total} attachment${total === 1 ? '' : 's'}…`)
        void Promise.all([
          imageSnapshot.length === 0 ? Promise.resolve([]) : prepareImages(imageSnapshot.map(image => image.path), controller.signal),
          fileSnapshot.length === 0 ? Promise.resolve([]) : prepareFiles(fileSnapshot.map(file => file.path), controller.signal),
        ]).then(([images, files]) => {
          if (controller.signal.aborted || prepareEpochRef.current !== epoch) return
          prepareAbortRef.current = undefined
          setPreparingImages(false)
          valueRef.current = ''
          cursorRef.current = 0
          setValue('')
          setCursor(0)
          draftImagesRef.current = []
          setDraftImages([])
          draftFilesRef.current = []
          setDraftFiles([])
          setCompletionIndex(0)
          setDismissedMenuValue(undefined)
          dismissNotice()
          if (trimmed !== '') {
            recordLocal(text)
            recordHistory(text)
          }
          recall.current = beginRecall(recallSpace, '')
          const blocks: readonly ContentBlock[] = [...images, ...files]
          if (busy) steer(text, blocks, originSession)
          else dispatch(text, blocks, originSession)
        }, (reason: unknown) => {
          if (controller.signal.aborted || prepareEpochRef.current !== epoch) return
          prepareAbortRef.current = undefined
          setPreparingImages(false)
          notify(`attachment submission failed: ${reason instanceof Error ? reason.message : String(reason)}`, 'error')
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
      if (trimmed === '') return
      dismissNotice()
      // Global recall records every submission - prompts and typed slash
      // commands share one history, so Up/Down and /history recall commands
      // exactly like prompts; the submission resets any active recall
      // browsing.
      recordLocal(text)
      recordHistory(text)
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
      if (text === '/update') {
        openUpdate()
        return
      }
      if (text === '/schedule') {
        openSchedule()
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
      if (text === '/animation' || text.startsWith('/animation ')) {
        const parsed = parseAnimationsArgument(text.slice('/animation'.length))
        if (parsed === 'toggle') applyAnimations(!animations)
        else if (parsed === 'usage') notify('usage: /animation [on|off]', 'info')
        else applyAnimations(parsed.enabled)
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
      if (text.length > 1) {
        // A path-list paste splits into images and files; prose falls through
        // as ordinary text (the splitter returns empty groups for non-paths).
        const dropped = parsePastedAttachmentPaths(text)
        if (dropped.images.length > 0 || dropped.files.length > 0) {
          insertDroppedAttachments(dropped.images, dropped.files)
          return
        }
      }
      applyEdit(insertText(valueRef.current, cursorRef.current, text))
    }
  }, active)

  // The DeepSeek easter-egg wave renders through the ComposerWave leaf
  // below, which owns its 33ms tick: the sweep re-renders only that child at
  // 30fps — this component's editor model, menu, and derived state never
  // re-run per frame. App drives the tier/style pair on a model switch, and
  // the child remounts whenever that pair changes (App picks a NEW random
  // style for every replay, so the pair always differs when a wave should
  // run), resetting the timeline to frame 0 before the first paint.
  //
  // The sweep is strictly one-shot per trigger, and the latch lives HERE —
  // not in the leaf — because modal panels freeze the composer and UNMOUNT
  // ComposerWave; a mount-scoped latch would reset on every panel close and
  // replay a finished sweep. Keying `wavePlayedKey` by the tier:style pair
  // survives those unmounts: only a NEW trigger (which always changes the
  // pair) re-arms the sweep. Busy turns, image preparation, /animation
  // toggles, and panel open/close on an UNCHANGED model+effort pair never
  // fire it again.
  const waveKey = waveTier !== null && waveStyle !== null ? `${waveTier}:${waveStyle}` : null
  const [wavePlayedKey, setWavePlayedKey] = useState<string | null>(null)
  useEffect(() => {
    // While animations are off, any pending trigger is consumed silently:
    // re-enabling must never queue or replay a celebration the user opted
    // out of watching.
    if (!animations && waveKey !== null && waveKey !== wavePlayedKey) setWavePlayedKey(waveKey)
  }, [animations, waveKey, wavePlayedKey])
  const waveArmed = waveKey !== null && waveKey !== wavePlayedKey

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
  // IME anchor: park the real terminal cursor on the caret cell while the
  // composer accepts input. IME composition and candidate windows anchor to
  // that real cursor cell, which otherwise sits below the status row where
  // Ink leaves it, so Chinese input never appears at the caret. Frozen bands
  // release the anchor; the wrapper keeps Ink's relative erase ledger exact.
  const caretRowInWindow = Math.max(0, Math.min(caret.row - editorWindowStart, editorWindowRows - 1))
  useImeCursorAnchor(
    !frozen,
    imeCursorRowsUp({ editorWindowRows, caretRowInWindow, rowsBelowComposer: anchorRowsBelow }),
    2 + caret.column,
  )
  // The menu's physical rows ride the same one-way report; the cleanup keeps
  // the reserve from outliving the menu (unmount or inactive handoff).
  useEffect(() => {
    onMenuRows(menuHeightRows)
    return () => onMenuRows(0)
  }, [menuHeightRows, onMenuRows])
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
      ? frozenHint ?? 'type a message'
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
    error: mentionActive ? mentionError : undefined,
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
            ? createElement(BusyChase, { animated: animations })
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

  // The wave paints the SAME visible rows and caret site as the static path
  // through the ComposerWave leaf (see its comment). The child remounts on
  // every tier/style change, so its timeline always starts at frame 0, and
  // its gate cancels — never freezes — the sweep while busy, preparing
  // images, or animations are off.
  return createElement(
    Box,
    { flexDirection: 'column' },
    menu,
    createElement(ComposerWave, {
      key: waveKey ?? 'static',
      tier: waveTier ?? 'deepseek',
      style: waveStyle ?? 'wave',
      active: waveTier !== null && waveStyle !== null && !busy && !preparingImages && animations && waveArmed,
      onSettled: () => {
        if (waveKey !== null) setWavePlayedKey(waveKey)
      },
      fallback: band(staticEditor),
      bandWidth,
      bandBg,
      rows: editorViewModel.rows.slice(editorWindowStart, editorWindowStart + editorWindowRows),
      windowStart: editorWindowStart,
      caretRow: caret.row,
      cursor: clampedCursor,
      caretVisible: cursorVisible,
      value,
      promptGlyph,
      promptColor,
    }),
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
  // Terminal input anchor: Ink reference-counts raw mode across every active
  // `useInput` hook, so mutually exclusive surfaces (composer <-> approval
  // bar <-> panels) drop the count to zero inside each handoff commit — the
  // cooked-mode window on the real console strands keystrokes in the line
  // buffer until the next Enter, which intermittently wedged terminals after
  // approval answers. This always-active hook keeps the count >= 1 for the
  // app's whole lifetime; its handler consumes nothing (Ink broadcasts every
  // key to all active handlers, so real owners stay unaffected).
  useStableInput(() => {}, true)
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
    | { kind: 'configure' | 'unset' | 'remove'; target: ProviderTargetView }
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
   * cached at the switch. The 33ms tick itself lives inside the ComposerWave
   * leaf, so the sweep re-renders only the composer band, not the whole tree,
   * at 30fps; App owns the rarely-changing tier/style and the leaf plays the
   * sweep exactly ONCE per pair change — an unchanged model+effort pair
   * (ordinary turns, image preparation, /animation toggles) never replays. */
  const [waveTier, setWaveTier] = useState<DeepseekWaveTier | null>(null)
  const [waveStyle, setWaveStyle] = useState<DeepseekWaveStyle | null>(null)
  // /animation toggle: applies immediately, persists through the runner, and
  // gates every timed leaf (shimmer, chase, blink, wave) for this render.
  const [animations, setAnimations] = useState(props.animations ?? true)
  const applyAnimations = (enabled: boolean): void => {
    setAnimations(enabled)
    props.saveAnimations?.(enabled)
    notify(`animations ${enabled ? 'on' : 'off'}`)
  }
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
  const [updateOpen, setUpdateOpen] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
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
    : !modelOpen && !helpOpen && !modeOpen && !permissionOpen && !resumeOpen && !pluginOpen && !updateOpen && !scheduleOpen && !jobsOpen && !statuslineOpen && !themeOpen && !historyOpen && !agentsOpen && !subagentOpen && !todosOpen && !verboseOpen && diffView === undefined && !approvalPending && !questionPending

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
    setUpdateOpen(false)
    setScheduleOpen(false)
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
  // status footer. Live stream frames preserve `entries` identity.
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
  // The open completion menu's exact row count, reported one-way by the
  // composer (0 when closed). The menu rides ABOVE the composer band, so its
  // height must come out of the live budget exactly like editor growth —
  // before this report the menu drew from an unnamed 5-row slack and a tall
  // menu during streaming pushed the dynamic tree past the terminal edge.
  const [menuRows, setMenuRows] = useState(0)
  const handleMenuRows = useCallback((rows: number): void => {
    setMenuRows(current => (current === rows ? current : rows))
  }, [])
  // The status footer's exact row count, reported one-way by StatusLine (the
  // second row renders only while it has content). The IME cursor anchor
  // counts every row between the composer caret and Ink's parked cursor: the
  // status footer plus Ink's own below-frame row. The gutter rows sit ABOVE
  // the composer and never enter this distance.
  const [statusBarRows, setStatusBarRows] = useState<1 | 2>(1)
  const handleStatusRows = useCallback((rows: 1 | 2): void => {
    setStatusBarRows(current => (current === rows ? current : rows))
  }, [])
  const imeRowsBelowComposer = statusBarRows + 1
  const composerEditorCap = composerMaxRows(terminalRows)
  // Bottom chrome is composer (2 borders + composerRows) + status (up to 2
  // rows) + todo/agents/notice (3) = 8 resting rows, plus the historical
  // 5-row menu reserve: small menus still fit without shrinking the live
  // area (unchanged behavior), and menu rows beyond the reserve are budgeted
  // exactly so the live/streaming area stays strictly below the terminal
  // height as the editor or the menu grows.
  const MENU_RESERVE_ROWS = 5
  const dynamicRows = Math.max(1, terminalRows - 8 - MENU_RESERVE_ROWS - composerGutterRows - (composerRows - 1) - Math.max(0, menuRows - MENU_RESERVE_ROWS))
  const streamingActive = view.streaming !== '' || view.streamingReasoning !== ''
  const deepDivingVisible = busy && !streamingActive
  // Terminal tab label: "deepseek" until the session carries a name, then the
  // session title; cleared on unmount so the host shell regains its default.
  const tabTitle = view.title === '' ? DEFAULT_TERMINAL_TITLE : view.title
  useTerminalTitle(tabTitle)
  const allLiveLines = useMemo(
    () => view.entries.slice(settled).flatMap(
      // Width shrinks with the real terminal (no 10-column floor: on a
      // narrower terminal the floor silently overflowed every row).
      entry => transcriptEntryLines(entry, Math.max(1, terminalColumns - 2), showReasoning),
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
  const transcriptVisible = !modelOpen && !helpOpen && !modeOpen && !permissionOpen && !resumeOpen && !pluginOpen && !updateOpen && !scheduleOpen && !jobsOpen && !statuslineOpen && !themeOpen && !historyOpen && !agentsOpen && !subagentOpen && !todosOpen && !verboseOpen && diffView === undefined && !approvalPending && !questionPending
  const inspectorVisible = verboseOpen && !approvalPending && !questionPending
  const modalVisible = modelOpen || helpOpen || modeOpen || permissionOpen || resumeOpen || pluginOpen || updateOpen || scheduleOpen || jobsOpen || statuslineOpen || themeOpen || historyOpen || agentsOpen || subagentOpen || todosOpen || inspectorVisible || diffView !== undefined || approvalPending || questionPending
  // The surface that currently owns the keyboard, named in the frozen band:
  // an empty composer under a panel must not advertise typing it cannot
  // accept — every key actually feeds the panel (which may or may not
  // filter with it), so the honest hint names the owner and the way out.
  const keyboardOwner = approvalPending
    ? 'the approval prompt'
    : questionPending
      ? 'the question'
      : diffView !== undefined
        ? 'the diff review'
        : modelOpen
          ? '/model'
          : helpOpen
            ? '/help'
            : modeOpen
              ? '/mode'
              : permissionOpen
                ? '/permission'
                : resumeOpen
                  ? '/resume'
                  : pluginOpen
                    ? '/plugin'
                    : updateOpen
                      ? '/update'
                      : scheduleOpen
                        ? '/schedule'
                        : jobsOpen
                          ? '/jobs'
                        : statuslineOpen
                          ? '/statusline'
                          : themeOpen
                            ? '/theme'
                            : historyOpen
                              ? '/history'
                              : agentsOpen
                                ? '/agents'
                                : subagentOpen
                                  ? '/subagent'
                                  : todosOpen
                                    ? '/todos'
                                    : inspectorVisible
                                      ? 'history details'
                                      : undefined
  const frozenHint = keyboardOwner === undefined
    ? undefined
    : `keys go to ${keyboardOwner} · esc ${approvalPending ? 'rejects' : questionPending ? 'cancels' : 'closes'}`
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
  // source-backed rebuild of native scrollback.

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
  // Declarable effort donors: settings declarations first (verbatim, dialect
  // spellings preserved), then catalog-advertised levels as identity maps -
  // a newly added model copies a known family's mapping in one keystroke.
  const effortDonors = useMemo(() => {
    const donors: EffortDonor[] = []
    const seen = new Set<string>()
    for (const row of providerDirectory?.rows ?? []) {
      for (const model of row.configuration.models) {
        const raw = (model.extras as Record<string, unknown> | undefined)?.reasoningEfforts
        if (!isDeclaredReasoningEfforts(raw)) continue
        const key = row.provider + '/' + model.id
        if (seen.has(key)) continue
        seen.add(key)
        donors.push({ provider: row.provider, id: model.id, efforts: raw })
      }
    }
    for (const row of directory?.rows ?? []) {
      const levels = row.reasoning?.efforts.map(effort => effort.id) ?? []
      if (levels.filter(level => level !== 'off').length === 0) continue
      const key = row.provider + '/' + row.model
      if (seen.has(key)) continue
      seen.add(key)
      const efforts: Record<string, string | null> = {}
      for (const level of levels) efforts[level] = level === 'off' ? null : level
      donors.push({ provider: row.provider, id: row.model, efforts })
    }
    return donors
  }, [providerDirectory, directory])
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
      modelSurface = createElement(ProviderSetupPanel, {
        target: providerAction.target,
        effortDonors,
        save: props.saveModelProviderConfiguration,
        saveCredential: props.saveModelProviderCredential,
        discover: props.discoverModelProvider
          ?? (async () => { throw new Error('model discovery is unavailable in this profile; enter models by hand') }),
        done: result => {
          const target = providerAction.target
          setProviderAction(undefined)
          setProviderOpen(true)
          reloadModelSurfaces()
          notify(`provider configuration saved: ${target.displayName}` + (result.key ? ' · API key updated' : ''))
        },
        back: () => setProviderAction(undefined),
        onExit: closeModelSurface,
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
        onExit: closeModelSurface,
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
        onExit: closeModelSurface,
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
        ...(props.loadModelProviders === undefined || props.saveModelProviderConfiguration === undefined
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
              maxRows: auditedReasoningRows,
            })
            // The collapsed marker shimmers only while reasoning streams
            // alone: once answer text flows, a periodically re-rendered
            // animation component would race the store's frame-throttled
            // notifications and could defer the answer paint by tens to
            // hundreds of milliseconds (stream-burst contract), so the
            // marker falls back to the static dim row — same as Deep diving
            // always yields the live region to streaming content.
            : view.streaming === ''
              ? createElement(ShimmerLine, { text: '✻ Thinking… (Ctrl/Alt+R to expand)', animated: animations })
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
            busy ? createElement(Caret, { animated: animations }) : undefined,
          )
          : undefined,
        deepDivingVisible ? createElement(DeepDivingLine, { since: view.busySince, animated: animations }) : undefined,
      )
      : undefined,
    transcriptVisible ? createElement(TodoPanel, { todos: view.todos }) : undefined,
    transcriptVisible ? createElement(AgentsLine, { rows: agentRows, total: props.subagents.getTotalSeen() }) : undefined,
    todosOpen && !approvalPending && !questionPending
      ? createElement(MemoTodoListPanel, {
        todos: view.todos,
        onClose: () => {
          setTodosOpen(false)
        },
      })
      : undefined,
    createElement(QuestionBar, { store: props.questions, snapshot: questionSnapshot, locked: false }),
    createElement(ApprovalBar, { snapshot: approvalSnapshot, locked: questionPending, notify, interrupt: props.interrupt, summarize: questionPending }),
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
    updateOpen && !approvalPending && !questionPending
      ? createElement(UpdatePanel, {
        probe: props.probeUpdate,
        apply: props.applyUpdate,
        notify: (text: string, tone?: NoticeTone) => notify(text, tone),
        close: () => setUpdateOpen(false),
      })
      : undefined,
    scheduleOpen && !approvalPending && !questionPending
      ? createElement(SchedulePanel, { rows: () => view.schedules, close: () => setScheduleOpen(false) })
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
        frozenHint,
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
        openUpdate: () => setUpdateOpen(true),
        openSchedule: () => setScheduleOpen(true),
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
        // Ctrl+R flips the reasoning fold. Rows already emitted through
        // Static are native scrollback, so the fold state of past entries can
        // only change through the source-backed replay (one clear + rebuild,
        // wrapped in a synchronized frame). Every toggle replays globally and
        // immediately — including mid-turn — so the whole transcript stays at
        // one fold state; the resize path already proves replaying during a
        // stream is safe.
        toggleReasoning: () => {
          setShowReasoning(current => !current)
          refreshScreen()
        },
        loadMentions: props.loadMentions,
        inspectImages: props.inspectImages,
        prepareImages: props.prepareImages,
        inspectFiles: props.inspectFiles,
        prepareFiles: props.prepareFiles,
        sessionKey: props.sessionKey,
        cycleMode: props.cycleMode,
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
        animations,
        applyAnimations,
        waveTier,
        waveStyle,
        maxRows: composerEditorCap,
        anchorRowsBelow: imeRowsBelowComposer,
        tabTitle,
        onEditorRows: handleEditorRows,
        onMenuRows: handleMenuRows,
      }),
      createElement(StatusLine, {
        facts: {
          model: modelLabel,
          mode: props.mode,
          cwd: props.cwd,
          branch: props.branch,
          sessionId: props.sessionId,
          title: view.title,
          plan: view.plan || props.pendingPlan === true,
          permission: view.permission !== '' ? view.permission : props.permission,
          sandbox: view.sandbox,
          goal: view.goal === undefined ? undefined : { phase: view.goal.phase, rounds: view.goal.rounds, max: view.goal.max },
        },
        stats: view.stats,
        busy,
        columns: terminalColumns,
        items: statuslineItems,
        onRows: handleStatusRows,
      }),
    ),
  )
}
