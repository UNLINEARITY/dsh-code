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
import { Box, Static, Text, useInput, useStdout } from 'ink'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import type { ContentBlock, FileBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import type { AuthorizationInteraction, AuthorizationStatus } from '@deepseek-ai/dsh-authorization'
import {
  dim,
  FLOW_ANCHORS,
  getPalette,
  getTheme,
  inkColor,
  isRainbow,
  themeFlow,
  setTheme,
  type ThemeName,
} from './theme.ts'
import { panelAccent } from './ui/panel-accent.ts'
import { rainbowRoll, rainbowSeedLabel, rerollRainbow } from './rainbow.ts'
import { ThemePanel } from './panels/theme-panel.ts'
import { LanguagePanel } from './panels/language-panel.ts'
import { getLanguage, t, type LanguageName } from './i18n.ts'
import { UpdatePanel, subscribeUpdateApplyRunning } from './panels/update-panel.ts'
import type { LauncherUpdateStatus } from './update.ts'
import { WHALE_GLYPH, WHALE_GLYPH_COLUMNS } from './whale-glyph.ts'
import { dshKernelVersion, headerBrandTitle } from './version.ts'
import type { TranscriptStore } from './session/store.ts'
import { DEFAULT_TERMINAL_TITLE, useTerminalTitle } from './ui/terminal-title.ts'
import { settledEntryCount, type TranscriptEntry } from './render/projection.ts'
import { createSubagentAttachment, EMPTY_ATTACH_STORE, type SubagentAttachment, type SubagentAttachmentServices } from './session/attach.ts'
import { visibleColumns } from './render/markdown.ts'
import {
  BUSY_CHASE_TICK_MS,
  CARET_BLINK_TICK_MS,
  caretVisible,
  DEEP_DIVING_SHIMMER_TICK_MS,
  deepseekWaveStyleRandom,
  deepseekWaveTier,
  deepDivingGradientColor,
  deepDivingSparkColor,
  flowColor,
  effortAboveHigh,
  isOfficialDeepSeekLabel,
  rainbowSpectrumHue,
  type DeepseekWaveStyle,
  type DeepseekWaveTier,
} from './render/animations.ts'
import type { ApprovalStore } from './approval.ts'
import type { CommandsView } from './commands.ts'
import type { ModelDirectory, ModelRow } from './models.ts'
import {
  isDeclaredReasoningEfforts,
  type DiscoveredModelView,
  type ProviderConfiguration,
  type ProviderSettingsDirectory,
  type ProviderTargetView,
} from './provider-settings.ts'
import type { QuestionStore } from './questions.ts'
import type { SkillsView, SkillRow } from './skills.ts'
import type { MentionCandidate } from './mentions.ts'
import type { SubagentFeedView, SubagentRow } from './session/subagents.ts'
import type { UsageView } from './render/usage.ts'
import { AgentsPanel, EffortPanel, HistoryPanel, JobsPanel, ModePanel, PermissionPanel, PluginPanel, ResumePanel, ReviewPickerPanel, SchedulePanel, SearchPanel, StatuslinePanel, runClock, SubagentPanel, UsagePanel, type JobRow, type SearchRow } from './panels/kernel-panels.ts'
import type { PresetRow } from './presets.ts'
import type { PermissionRow } from './permissions.ts'
import type { PluginRow } from './plugin-inventory.ts'
import { recallEntries, recordLocalEntry } from './session/history.ts'
import type { SessionDirectoryOptions, SessionRow } from './session/session-directory.ts'
import type { GitDiffView, ReviewBranch, ReviewCommit, ReviewSelection } from './git-workflow.ts'
import type { ProviderAuthorizationDirectory, ProviderAuthorizationRow } from './authorization.ts'
import { authorizationForProvider } from './authorization.ts'
import { ProviderAuthorizationLogoutPanel, ProviderAuthorizationPanel } from './panels/authorization-panel.ts'
import type { FilePathInspection, ImagePathInspection } from './attachments.ts'
import { LOCAL_COMMAND_NAMES, LOCAL_COMMANDS } from './completion.ts'
export { completionCandidates, stepCompletionIndex } from './completion.ts'
import { Composer } from './composer.ts'
import {
  ModelPanel,
  ProviderConfirmPanel,
  ProviderPanel,
  ProviderSetupPanel,
  type EffortDonor,
} from './panels/model-panels.ts'
import { PanelGap } from './ui/panel-gap.ts'
import { StyledRows } from './ui/styled-rows.ts'
import { ApprovalBar, QuestionBar } from './panels/interaction-bars.ts'
import { useStableInput } from './ui/use-stable-input.ts'
import { useFrames } from './ui/use-frames.ts'
import type { NoticeTone, QueueMutation } from './ui/ui-contract.ts'
export type { NoticeTone, QueueMutation } from './ui/ui-contract.ts'

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
/**
 * Same as {@link RESIZE_REFLOW_CLEAR} without wiping native scrollback.
 * History-cap trims remount `<Static>` but must not `\x1b[3J` a user who is
 * reading earlier messages above the fold.
 */
const TRIM_REFLOW_CLEAR = '\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[H'
/** Ask terminals supporting DEC synchronized updates to hold the frame. */
const SYNCHRONIZED_UPDATE_BEGIN = '\x1b[?2026h'
/** Release the held frame after Ink has replayed the source-backed Static rows. */
const SYNCHRONIZED_UPDATE_END = '\x1b[?2026l'
import {
  layoutStatusBar,
  parseStatuslineItems,
  statusCycleHint,
  STATUS_GROUP_SEPARATOR,
  STATUS_ITEM_SEPARATOR,
  STATUS_ROW2_INDENT,
  type StatusFacts,
  type StatusGroup,
  type StatusItemId,
  type StatusSpan,
  type StatusTone,
} from './render/status.ts'
import { displayTail, displayText, padColumns, singleLineText, truncateColumns } from './render/text.ts'
import {
  clampScroll,
  followInspectorCursor,
  inspectorViewport,
  inspectableTranscriptEntries,
  layoutGutterRows,
  liveRegionBudget,
  moveScroll,
  panelViewport,
  revealRow,
} from './render/inspector.ts'
import {
  clampLiveAllocation,
  diffLineStyle,
  fillDiffLineBars,
  lineSegment,
  settledEntryLines,
  styledLines,
  textLines,
  transcriptEntryLines,
} from './render/lines.ts'
import {
  composerMaxRows,
  deleteBackward,
  insertText,
  moveCursorBy,
  splitGraphemes,
} from './render/editor.ts'

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
  dispatch: (text: string, attachments?: readonly ContentBlock[], origin?: string) => void
  /**
   * Submit one line as steering: it joins the turn already running at its next
   * step boundary instead of waiting for the next turn. Same stale-delivery
   * guard as {@link dispatch}.
   */
  steer: (text: string, attachments?: readonly ContentBlock[], origin?: string) => void
  /**
   * The FULL current session identity ('' while the first session is pending)
   * — the stale-delivery origin above. Distinct from the short display id.
   */
  sessionKey: string
  /** Interrupt the running turn (Esc); true when a turn was cancelled. */
  interrupt: () => boolean
  /** Quit: unmount, flush, and request process exit. */
  quit: () => void
  /** Load the selectable model directory (called when /model opens). */
  loadModels: () => Promise<ModelDirectory>
  /** Load @mention candidates for the typed query (files + sessions). */
  loadMentions: (query: string, signal?: AbortSignal) => Promise<readonly MentionCandidate[]>
  /** Validate draft image paths without committing attachment objects. */
  inspectImages: (paths: readonly string[]) => Promise<readonly ImagePathInspection[]>
  /** Validate, normalize and persist images immediately before submission. */
  prepareImages: (paths: readonly string[], signal?: AbortSignal) => Promise<readonly ImageBlock[]>
  /** Validate draft non-image file paths without committing attachment objects. */
  inspectFiles: (paths: readonly string[]) => Promise<readonly FilePathInspection[]>
  /** Persist non-image files immediately before submission as durable file blocks. */
  prepareFiles: (paths: readonly string[], signal?: AbortSignal) => Promise<readonly FileBlock[]>
  /** Apply one /model selection (with an advertised reasoning effort, when picked); returns the display label. */
  selectModel: (row: ModelRow, effortId?: string) => string
  /** The /subagent override label, '' when delegated agents follow the current model. */
  subagentModel: string
  /** Apply one /subagent model pick; returns the override label. */
  setSubagentModel: (row: ModelRow, effortId?: string) => string
  /** Drop the /subagent override (delegated agents follow the current model). */
  clearSubagentModel: () => void
  /** Delete one session subtree; resolves with the outcome line. */
  deleteSession: (id: string) => Promise<string>
  /** Load provider/settings/credential facts for the optional /model provider stage. */
  loadModelProviders?: () => Promise<ProviderSettingsDirectory>
  /** Subscribe to Harness credential/settings/adapter invalidations while /model is open. */
  subscribeModelProviders?: (listener: () => void) => () => void
  /** Store or rotate one provider credential through the Harness credential service. */
  saveModelProviderCredential?: (target: ProviderTargetView, key: string) => Promise<void>
  /** Switch a provider route to its subscription channel (drops the key reference). */
  enableModelProviderSubscription?: (target: ProviderTargetView) => Promise<void>
  /** Remove one writable provider credential without removing its settings profile. */
  unsetModelProviderCredential?: (target: ProviderTargetView) => Promise<void>
  /** Remove one user-owned provider profile and its page-managed credential. */
  removeModelProvider?: (target: ProviderTargetView) => Promise<void>
  /** Save endpoint and explicit model capacities through the provider profile. */
  saveModelProviderConfiguration?: (target: ProviderTargetView, configuration: ProviderConfiguration) => Promise<void>
  /**
   * Interrogate the provider's real endpoint (typed key wins over the stored
   * credential) for the models it actually serves — the discovery stage of
   * the provider setup page.
   */
  discoverModelProvider?: (
    target: ProviderTargetView,
    request: { readonly apiKey?: string; readonly baseURL?: string },
    signal?: AbortSignal,
  ) => Promise<readonly DiscoveredModelView[]>
  /** Provider authorization flows and value-free stored-record facts. */
  loadProviderAuthorizations?: () => Promise<ProviderAuthorizationDirectory>
  subscribeProviderAuthorizations?: (listener: () => void) => () => void
  beginProviderAuthorization?: (
    row: ProviderAuthorizationRow,
    method: string,
    interaction: AuthorizationInteraction,
    signal: AbortSignal,
  ) => Promise<AuthorizationStatus>
  cancelProviderAuthorization?: (row: ProviderAuthorizationRow) => void
  logoutProviderAuthorization?: (row: ProviderAuthorizationRow) => Promise<void>
  openAuthorizationUrl?: (url: string) => boolean
  copyTextValue?: (text: string) => Promise<void>
  /** Cycle to the next mode station (Shift+Tab): a permission preset or a plan switch; returns the notice label. */
  cycleMode: () => string
  /** Pre-session plan choice: shows the plan badge before the first session exists. */
  pendingPlan?: boolean
  /** Select or inspect a permission preset without requiring a pre-existing session. */
  setPermission: (id: string) => string
  /** Export the transcript to a markdown file (/export [path]); reports via notices. */
  exportTranscript: (argument: string) => Promise<void>
  /** Rename the session (/title <text>); returns the outcome line for the notice. */
  renameTitle: (argument: string) => string
  /** Copy the latest complete assistant response; resolves to notice text. */
  copyLastResponse: () => Promise<string>
  /** Load a complete read-only Git diff for the file-oriented viewport. */
  loadGitDiff: (argument: string) => Promise<GitDiffView>
  /** Local branches for the /review picker (absent: the picker hides the branch phase's list). */
  listReviewBranches?: (signal?: AbortSignal) => Promise<readonly ReviewBranch[]>
  /** Recent commits on the current branch for the /review picker. */
  listReviewCommits?: (signal?: AbortSignal) => Promise<readonly ReviewCommit[]>
  /** Start a model review after applying the read-only permission preset. */
  reviewChanges: (selection: ReviewSelection) => void
  /** Preset/session/plugin kernel operations. */
  loadPresets: () => Promise<readonly PresetRow[]>
  switchMode: (id: string) => Promise<string>
  /** Load the switchable permission presets for the /permission panel. */
  loadPermissions: () => Promise<readonly PermissionRow[]>
  createSession: (mode?: string) => void
  /** Fork the active session at a completed-turn boundary. */
  forkSession: (argument: string) => void
  loadSessions: (options: SessionDirectoryOptions, signal?: AbortSignal) => Promise<readonly SessionRow[]>
  loadSessionTranscript: (id: string, signal?: AbortSignal) => Promise<string>
  /** Read the current session's usage blocks (projections plus per-turn fold). */
  loadUsage: () => Promise<UsageView>
  /**
   * Full-text search over every persisted session (the in-process
   * session-query engine). Absent when the deployment disabled the row;
   * /search degrades to a notice instead of opening the panel.
   */
  searchSessions?: (query: string, signal?: AbortSignal) => Promise<readonly SearchRow[]>
  /** Load this session's subagent conversations (children by lineage). */
  loadSubagents: () => Promise<readonly SessionRow[]>
  /** Live subagent attachment: seed + the two real-time buses, runner-wired. */
  attachSubagent?: SubagentAttachmentServices
  switchSession: (row: SessionRow) => void
  cancelSessionSwitch: () => boolean
  loadPlugins: () => readonly PluginRow[]
  /** Caller-visible background jobs (the host jobs registry, read-only). */
  loadJobs: () => readonly JobRow[]
  /** Probe the launcher's aligned update plan (read-only; never installs). */
  probeUpdate: () => Promise<LauncherUpdateStatus>
  /** Run the launcher's aligned update; streams sanitized lines; resolves with the exit code. */
  applyUpdate: (onLine: (line: string) => void, plan?: { readonly dshSpec: string; readonly codeSpec: string; readonly pluginSpecs: readonly string[] }) => Promise<number>
  /** Registers the app's notice channel with the runner (called once on mount). */
  onBridgeReady: (bridge: { notify: (text: string, tone?: NoticeTone) => void }) => void
  /** Ordered enabled status items (/statusline config); the runner owns persistence. */
  statusline: readonly string[]
  /** Persist a new statusline item set; the runner surfaces IO failures as notices. */
  saveStatusline: (items: readonly string[]) => void
  /** Apply and persist one /language selection; the runner owns the language.json file. */
  saveLanguage: (name: LanguageName) => void
  /** Apply and persist one /theme selection; the runner owns the theme.json file. */
  saveTheme?: (name: ThemeName) => void
  /** Whether timed animations run at startup (animations.json; on by default
   * — like parseAnimationsPref, only an explicit false disables them). */
  animations?: boolean
  /** Apply and persist one /animation toggle; the runner owns the file. */
  saveAnimations?: (enabled: boolean) => void
  /** Persistent cross-session input history (oldest first); the runner owns the file. */
  history: readonly string[]
  /** Persist one submitted prompt to the global history file. */
  recordHistory: (text: string) => void
  /** Mutate one next-turn inbox message; durable inbox splices reconcile the result. */
  updateQueued?: (messageId: string, action: QueueMutation) => void
  /** Apply the Ctrl+R terminal passthrough to the detected editor (/vscode-keys); resolves to a one-line summary. */
  applyEditorKeys: () => Promise<string>
}

/**
 * The original web StateDot chase used by the busy composer marker. With
 * animations off it freezes on the first frame (still visibly busy).
 */
function Caret({ animated = true }: { animated?: boolean }): ReactElement {
  const tick = useFrames(CARET_BLINK_TICK_MS, animated)
  return createElement(Text, null, caretVisible(tick) ? '▍' : ' ')
}

/** One resettable input-caret phase shared by the entire composer. */
function ShimmerLine({ text, animated = true }: { text: string; animated?: boolean }): ReactElement {
  const tick = useFrames(DEEP_DIVING_SHIMMER_TICK_MS, animated)
  const palette = getPalette()
  // Flowing themes walk their anchors for the shimmer highlight so
  // streaming text glows along the spectrum; other themes keep the bright
  // accent.
  const flow = themeFlow()
  const highlight = flow !== undefined && animated
    ? flowColor(tick * DEEP_DIVING_SHIMMER_TICK_MS + flow.phaseMs, flow.anchors)
    : palette.brandBright
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
              ? deepDivingSparkColor(tick, palette.brandDeep, highlight)
              : deepDivingGradientColor(index, tick, graphemes.length, palette.brandDeep, highlight)),
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
 *
 * Body wrap width for a streaming tail. `rowColumns` is the same width
 * passed to `transcriptEntryLines` (terminal minus the last-column safety);
 * the hanging prefix then shrinks the body so streamed text and settled
 * markdown wrap on the same column.
 */
export function streamTailBodyColumns(rowColumns: number, prefix: string, continuationPrefix = prefix): number {
  const width = Math.max(1, Math.floor(rowColumns))
  const prefixColumns = Math.max(visibleColumns(prefix), visibleColumns(continuationPrefix))
  return Math.max(1, width - prefixColumns)
}

function StreamTail({ text, dim, maxRows, prefix = '', continuationPrefix = prefix, children, columns }: {
  text: string
  dim: boolean
  maxRows: number
  prefix?: string
  continuationPrefix?: string
  children?: ReactElement
  /** Same physical row width `transcriptEntryLines` uses (terminal minus 2). */
  columns: number
}): ReactElement {
  const safeRows = Math.max(1, maxRows)
  // Both prefixes participate because every physical row repeats its hanging
  // indent. The wrap matches settled markdown (row width minus prefix), so
  // the flush at turn end does not reflow the last paragraph.
  const contentColumns = streamTailBodyColumns(columns, prefix, continuationPrefix)
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
function DiffPanel({ view, onClose }: { view: GitDiffView; onClose: () => void }): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [fileIndex, setFileIndex] = useState(0)
  const [scroll, setScroll] = useState(0)
  const file = view.files[fileIndex]
  const lines = useMemo(() => {
    if (file === undefined) return textLines('  (no changes)', viewport.contentColumns, 'dim')
    return fillDiffLineBars(file.lines.flatMap(line => styledLines([lineSegment(line, diffLineStyle(line))], viewport.contentColumns)), viewport.contentColumns)
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
  if (viewport.compact) return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('panel.diff.compact', { title: view.title, files: view.files.length }), viewport.contentColumns))
  const accent = panelAccent('diff', getPalette().dim, getPalette().brand)
  return createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: inkColor(accent.border), paddingX: 1 },
    createElement(Text, { color: inkColor(accent.title), bold: true, wrap: 'truncate-end' }, truncateColumns(`${view.title} · ${view.files.length === 0 ? t('panel.diff.noFiles') : `${fileIndex + 1}/${view.files.length} ${file?.path ?? ''}`} · rows ${lines.length === 0 ? 0 : visibleScroll + 1}-${Math.min(lines.length, visibleScroll + viewport.bodyRows)}/${lines.length}`, viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(StyledRows, { lines: lines.slice(visibleScroll, visibleScroll + viewport.bodyRows) }),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(t('panel.diff.footer'), viewport.contentColumns)),
  )
}


/**
 * The whale header with a compact copy lockup. The dsh kernel version (when
 * the host manifest resolves), the title, the bilingual slogan, and the key
 * hint stay centered inside the existing eight content rows, preserving the
 * Static header's ten physical rows; without a resolvable host the lockup
 * keeps its historical three lines. Short or narrow terminals keep a one-line
 * form without the kernel line.
 */
/**
 * One whale-glyph row painted as a frozen seven-color spectrum (column 0
 * red, column 25 violet). Spaces stay uncolored so the silhouette punches
 * through; adjacent same-hue blocks merge into one span.
 */
function rainbowGlyphRow(row: string, rowKey: number): ReactElement {
  const span = Math.max(1, WHALE_GLYPH_COLUMNS - 1)
  const children: ReactElement[] = []
  let start = 0
  while (start < row.length) {
    if (row[start] === ' ') {
      let end = start + 1
      while (end < row.length && row[end] === ' ') end += 1
      children.push(createElement(Text, { key: start }, row.slice(start, end)))
      start = end
      continue
    }
    const color = inkColor(rainbowSpectrumHue(start / span))
    let end = start + 1
    while (end < row.length && row[end] !== ' ' && inkColor(rainbowSpectrumHue(end / span)) === color) end += 1
    children.push(createElement(Text, { key: start, color }, row.slice(start, end)))
    start = end
  }
  return createElement(Text, { key: rowKey }, ...children)
}

function Header({ resumed }: { resumed: boolean }): ReactElement {
  const stdout = useStdout().stdout
  const rows = stdout?.rows ?? 40
  const columns = stdout?.columns ?? 80
  const kernelLine = (() => {
    const version = dshKernelVersion()
    return version === undefined ? undefined : `dsh-v${version}`
  })()
  const title = headerBrandTitle()
  const slogan = 'Into the Unknown  探索未至之境'
  const hint = resumed ? t('header.hintResumed') : t('header.hint')
  const copyWidths = [visibleColumns(title), visibleColumns(slogan), visibleColumns(hint)]
  if (kernelLine !== undefined) copyWidths.push(visibleColumns(kernelLine))
  const copyColumns = Math.max(...copyWidths)
  const compact = kernelLine === undefined ? `${title} · ${hint}` : `${title} · ${kernelLine} · ${hint}`
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
      ...WHALE_GLYPH.map((row, index) =>
        isRainbow()
          ? rainbowGlyphRow(row, index)
          : createElement(Text, { key: index, color: inkColor(getPalette().brand) }, row)),
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
  const newest = [...rows].sort((left, right) => right.updatedAt - left.updatedAt)[0]
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
    ? [createElement(Text, { key: 'empty', dimColor: true, wrap: 'truncate-end' }, `  ${t('panel.todos.empty')}`)]
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
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('panel.todos.compact'), viewport.contentColumns))
  }

  const accent = panelAccent('todos', getPalette().brand)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(accent.border) },
    createElement(Text, { color: inkColor(accent.title), bold: true, wrap: 'truncate-end' }, truncateColumns(t('panel.todos.title', { done: completed, total: todos.length, active: inProgress, pending, from: rows.length === 0 ? 0 : visibleScroll + 1, to: Math.min(rows.length, visibleScroll + viewport.bodyRows), rows: rows.length }), viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...rows.slice(visibleScroll, visibleScroll + viewport.bodyRows),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { wrap: 'truncate-end' }, dim(truncateColumns(t('panel.todos.footer'), viewport.contentColumns))),
  )
}

const MemoTodoListPanel = memo(TodoListPanel)

/** Rows in the exact next-turn inbox order, never transcript append order. */
export function queuedInboxRows(
  entries: readonly TranscriptEntry[],
  ids: readonly string[],
): readonly Extract<TranscriptEntry, { kind: 'pending' }>[] {
  const byId = new Map<string, Extract<TranscriptEntry, { kind: 'pending' }>>()
  for (const entry of entries) {
    if (entry.kind === 'pending' && entry.target === 'next-turn') byId.set(entry.messageId, entry)
  }
  return ids.flatMap(id => {
    const row = byId.get(id)
    return row === undefined ? [] : [row]
  })
}

/** A bounded, keyboard-owned management surface for the durable next-turn inbox. */
function QueuePanel({ rows, busy, update, onClose }: {
  rows: readonly Extract<TranscriptEntry, { kind: 'pending' }>[]
  busy: boolean
  update?: (messageId: string, action: QueueMutation) => void
  onClose: () => void
}): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [selected, setSelected] = useState(0)
  const [scroll, setScroll] = useState(0)
  const [editing, setEditing] = useState<{ messageId: string; text: string; cursor: number } | undefined>(undefined)
  // Ink can deliver a following key before its effect swaps the input
  // listener after an edit-mode render; this ref keeps the editor's key
  // stream coherent while the visible state catches up.
  const editingRef = useRef(editing)
  const current = rows[selected]
  const visibleScroll = revealRow(clampScroll(scroll, rows.length, viewport.bodyRows), selected, rows.length, viewport.bodyRows)
  const move = (delta: number): void => {
    setSelected(current => Math.max(0, Math.min(rows.length - 1, current + delta)))
  }

  useEffect(() => {
    setSelected(current => Math.max(0, Math.min(rows.length - 1, current)))
    if (editing !== undefined && !rows.some(row => row.messageId === editing.messageId)) {
      editingRef.current = undefined
      setEditing(undefined)
    }
  }, [rows, editing])
  useEffect(() => {
    if (visibleScroll !== scroll) setScroll(visibleScroll)
  }, [visibleScroll, scroll])

  useStableInput((input, key) => {
    const activeEdit = editingRef.current
    if (activeEdit !== undefined) {
      if (key.escape) {
        editingRef.current = undefined
        setEditing(undefined)
        return
      }
      if (key.return) {
        if (activeEdit.text.trim() !== '') update?.(activeEdit.messageId, { kind: 'edit', text: activeEdit.text })
        editingRef.current = undefined
        setEditing(undefined)
        return
      }
      if (key.leftArrow) {
        const next = { ...activeEdit, cursor: moveCursorBy(activeEdit.text, activeEdit.cursor, -1) }
        editingRef.current = next
        setEditing(next)
        return
      }
      if (key.rightArrow) {
        const next = { ...activeEdit, cursor: moveCursorBy(activeEdit.text, activeEdit.cursor, 1) }
        editingRef.current = next
        setEditing(next)
        return
      }
      // Ink 5 reports 0x7F (backspace) and the forward-delete sequence as the
      // same `key.delete`, so a bare Delete binding here would erase on a
      // habitual Backspace. This management surface keeps `d` as its only
      // removal key instead of guessing which byte arrived.
      if (key.backspace || key.delete) {
        const edit = deleteBackward(activeEdit.text, activeEdit.cursor)
        const next = { ...activeEdit, text: edit.value, cursor: edit.cursor }
        editingRef.current = next
        setEditing(next)
        return
      }
      if (input !== '' && !key.ctrl && !key.meta) {
        const edit = insertText(activeEdit.text, activeEdit.cursor, input)
        const next = { ...activeEdit, text: edit.value, cursor: edit.cursor }
        editingRef.current = next
        setEditing(next)
      }
      return
    }
    if (key.escape || input === 'q') {
      onClose()
      return
    }
    if (key.upArrow) move(-1)
    else if (key.downArrow) move(1)
    else if (key.pageUp) move(-Math.max(1, viewport.bodyRows - 1))
    else if (key.pageDown) move(Math.max(1, viewport.bodyRows - 1))
    else if (input === 'g') setSelected(0)
    else if (input === 'G') setSelected(Math.max(0, rows.length - 1))
    else if (input === 'e' && current !== undefined) {
      // Text is editable on every row: an edit rewrites what the user typed
      // and carries the row's attachments through untouched, which is exactly
      // what the row's read-only attachment marker promises.
      const next = { messageId: current.messageId, text: current.text, cursor: current.text.length }
      editingRef.current = next
      setEditing(next)
    }
    else if (input === 'd' && current !== undefined) update?.(current.messageId, { kind: 'remove' })
    else if (key.return && current !== undefined && busy) update?.(current.messageId, { kind: 'steer' })
  }, true)

  if (viewport.maxHeight === 0 || viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('panel.queue.compact'), viewport.contentColumns))
  }
  const body = rows.length === 0
    ? [createElement(Text, { key: 'empty', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(t('panel.queue.empty'), viewport.contentColumns))]
    : rows.map((row, index) => {
      const selectedRow = index === selected
      const suffix = (row.images?.length ?? 0) + (row.files?.length ?? 0) > 0 ? ` ${t('panel.queue.attachments')}` : ''
      if (editing?.messageId === row.messageId) {
        const before = editing.text.slice(0, editing.cursor)
        const caret = editing.text.slice(editing.cursor, editing.cursor + 1) || ' '
        const after = editing.text.slice(editing.cursor + caret.length)
        return createElement(Text, { key: row.messageId, color: inkColor(getPalette().brandBright), wrap: 'truncate-end' }, truncateColumns(`✎ ${before}[${caret}]${after}`, viewport.contentColumns))
      }
      return createElement(Text, { key: row.messageId, color: inkColor(selectedRow ? getPalette().brandBright : getPalette().dim), bold: selectedRow || undefined, wrap: 'truncate-end' }, truncateColumns(`${selectedRow ? '›' : ' '} ${index + 1}. ${singleLineText(row.text)}${suffix}`, viewport.contentColumns))
    })
  const footer = editing !== undefined
    ? t('panel.queue.editFooter')
    : busy
      ? t('panel.queue.footerBusy')
      : t('panel.queue.footerIdle')
  const accent = panelAccent('queue', getPalette().brand)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(accent.border) },
    createElement(Text, { color: inkColor(accent.title), bold: true, wrap: 'truncate-end' }, truncateColumns(t('panel.queue.title', { count: rows.length, from: rows.length === 0 ? 0 : visibleScroll + 1, to: Math.min(rows.length, visibleScroll + viewport.bodyRows) }), viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...body.slice(visibleScroll, visibleScroll + viewport.bodyRows),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(footer, viewport.contentColumns)),
  )
}

/**
 * Ink props for one status tone: the Codex status-line accent mapping over
 * the DeepSeek palette, all blue by design — the status bar speaks only in
 * degrees of blue (deep accent, primary figures, model identity, sky
 * paths and done states), with amber/red reserved for warnings and errors.
 */
function statusToneProps(tone: StatusTone, flowMs?: number): {
  color: string | undefined
  bold: boolean | undefined
  dimColor: boolean | undefined
} {
  if (isRainbow()) {
    // Carnival roll: every tone carries its rolled color (adjacent tones in
    // canonical on-screen order never match, the row boundary included);
    // the live dot rides the flow walk while busy. Bold emphasis carries
    // the semantic hierarchy so randomness never hides importance.
    const emphasized = tone === 'model' || tone === 'success' || tone === 'plan' || tone === 'warn' || tone === 'error'
    const color = tone === 'live' && flowMs !== undefined
      ? flowColor(flowMs, themeFlow()?.anchors ?? FLOW_ANCHORS)
      : rainbowRoll().toneColors[tone]
    return { color: inkColor(color), bold: emphasized || undefined, dimColor: undefined }
  }
  switch (tone) {
    case 'model':
      // Same tone as the working-directory segment: the model name reads as
      // a path fact, not a brand accent.
      return { color: inkColor(getPalette().code), bold: true, dimColor: undefined }
    case 'live':
      // With a flow sample (flowing theme while busy), the live dot rides
      // the anchor walk; otherwise the palette's live accent.
      return { color: inkColor(flowMs === undefined ? getPalette().brandBright : flowColor(flowMs, themeFlow()?.anchors ?? FLOW_ANCHORS)), bold: undefined, dimColor: undefined }
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
function StatusLine({ facts, stats, busy, columns, items, onRows, animated }: {
  facts: StatusFacts
  stats: Parameters<typeof layoutStatusBar>[1]
  busy: boolean
  columns: number
  items: readonly string[]
  /** Reports the footer's exact physical row count (1 or 2) so the IME
   * anchor ledger below the composer stays exact. */
  onRows?: (rows: 1 | 2) => void
  /** Whether timed animations run (the persisted preference). */
  animated: boolean
}): ReactElement {
  // Flowing-theme busy flow: the identity cluster's live dot cycles the
  // anchor walk while a turn runs; static themes never start the timer.
  const flow = themeFlow()
  const flowActive = animated && busy && flow !== undefined
  const flowTick = useFrames(BUSY_CHASE_TICK_MS, flowActive)
  const flowMs = flowActive ? flowTick * BUSY_CHASE_TICK_MS + (flow?.phaseMs ?? 0) : undefined
  const language = getLanguage()
  const layout = useMemo(() => {
    // The layout reads translations through t(); naming the current language
    // here makes that external store value an explicit cache invalidator.
    void language
    return layoutStatusBar(facts, stats, Math.max(8, columns - 2), {
      busy,
      items,
      // Match the composer content budget: border + horizontal padding are
      // already excluded, and layoutStatusBar shrinks this ceiling as needed.
      contextWidth: Math.max(5, columns - 6),
    })
  }, [
    facts,
    stats,
    busy,
    columns,
    items,
    // Labels come from t(); a language switch must rebuild the rows.
    language,
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
          { key: key + 'g' + groupIndex + 's' + spanIndex, wrap: 'truncate-end', ...statusToneProps(span.tone, flowMs) },
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
        { key: key + 'r' + index, wrap: 'truncate-end', ...statusToneProps(span.tone, flowMs) },
        span.text,
      ))
    })
    if (row.hint) {
      rightParts.push(createElement(Text, { key: key + 'hint', color: inkColor(getPalette().dim) }, statusCycleHint()))
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
function HelpPanel({ descriptors, skills, commandError, skillError, onClose }: {
  descriptors: readonly CommandDescriptor[]
  skills: readonly SkillRow[]
  commandError: string | undefined
  skillError: string | undefined
  onClose: () => void
}): ReactElement {
  const stdout = useStdout().stdout
  const columns = stdout?.columns ?? 80
  const viewport = panelViewport(columns, stdout?.rows ?? 30)
  const [scroll, setScroll] = useState(0)
  const nameWidth = Math.min(18, Math.max(1, viewport.contentColumns - 2))
  const descBudget = Math.max(0, viewport.contentColumns - nameWidth - 2)
  const row = (label: string, description: string): ReactElement => createElement(
    Text,
    { color: inkColor(getPalette().dim), wrap: 'truncate-end' },
    `  ${padColumns(label, nameWidth)}${truncateColumns(displayText(description), descBudget)}`,
  )
  const content: ReactElement[] = [
    createElement(Text, { key: 'keys-title', bold: true, wrap: 'truncate-end' }, t('help.keysTitle')),
    createElement(Text, { key: 'key-submit', dimColor: true, wrap: 'truncate-end' }, `  ${t('help.key.submit')}`),
    createElement(Text, { key: 'key-mentions', dimColor: true, wrap: 'truncate-end' }, `  ${t('help.key.mentions')}`),
    createElement(Text, { key: 'key-inspector', dimColor: true, wrap: 'truncate-end' }, `  ${t('help.key.inspector')}`),
    createElement(Text, { key: 'key-cancel', dimColor: true, wrap: 'truncate-end' }, `  ${t('help.key.cancel')}`),
    createElement(Text, { key: 'key-queue', dimColor: true, wrap: 'truncate-end' }, `  ${t('help.key.queue')}`),
    createElement(Text, { key: 'key-edit', dimColor: true, wrap: 'truncate-end' }, `  ${t('help.key.edit')}`),
    createElement(Text, { key: 'commands-gap' }, ' '),
    createElement(Text, { key: 'commands-title', bold: true, wrap: 'truncate-end' }, t('help.commandsTitle')),
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
      row(command.label, t(command.descriptionKey)),
    )),
    ...descriptors.filter(descriptor => !LOCAL_COMMAND_NAMES.has(descriptor.name)).map(descriptor => createElement(
      Text,
      { key: `command-${descriptor.name}`, color: inkColor(getPalette().dim), wrap: 'truncate-end' },
      `  ${padColumns(`/${descriptor.name}`, nameWidth)}${truncateColumns(displayText(descriptor.description), descBudget)}`,
    )),
    ...(skills.length === 0 && skillError === undefined
      ? []
      : [
          createElement(Text, { key: 'skills-gap' }, ' '),
          createElement(Text, { key: 'skills-title', bold: true, wrap: 'truncate-end' }, t('help.skillsTitle')),
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
      { key: `skill-${skill.name}`, color: inkColor(getPalette().dim), wrap: 'truncate-end' },
      `  ${padColumns(`/${skill.name}`, nameWidth)}${truncateColumns(displayText(skill.description), descBudget)}`,
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
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('help.compact'), viewport.contentColumns))
  }

  const accent = panelAccent('help', getPalette().brand)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(accent.border) },
    createElement(Text, { color: inkColor(accent.title), bold: true, wrap: 'truncate-end' }, truncateColumns(`/help — keys and commands · rows ${content.length === 0 ? 0 : visibleScroll + 1}-${Math.min(content.length, visibleScroll + viewport.bodyRows)}/${content.length}`, viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...content.slice(visibleScroll, visibleScroll + viewport.bodyRows),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { wrap: 'truncate-end' }, dim(truncateColumns(t('help.footer'), viewport.contentColumns))),
  )
}

/** Collapse arbitrary metadata to one terminal row before verbose rendering. */
function entryKindLabel(entry: TranscriptEntry | undefined): string {
  switch (entry?.kind) {
    case 'user': return 'user prompt'
    case 'pending': return 'queued prompt'
    case 'assistant': return 'reply'
    case 'tool': return 'tool call'
    case 'command': return 'command'
    case 'error': return 'turn error'
    case 'turn-marker': return 'turn end'
    case 'compaction': return 'compaction'
    case 'retry': return 'retry'
    case 'files': return 'files changed'
    case 'workflow': return 'workflow run'
    default: return 'empty'
  }
}

/**
 * The Ctrl+O transcript inspector: one selected durable entry at a time,
 * with independent history selection and content scrolling. The complete
 * retained entry is converted to physical rows, but only one viewport slice
 * reaches Ink, so even a huge reasoning block cannot grow the dynamic tree.
 */
function VerbosePanel({ entries, onClose, columns, rows }: {
  entries: readonly TranscriptEntry[]
  onClose: () => void
  /** Live terminal columns from App's resize store — not useStdout, so memo cannot skip a reflow. */
  columns: number
  rows: number
}): ReactElement {
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
  const visibleScrollRef = useRef(visibleScroll)
  visibleScrollRef.current = visibleScroll

  useEffect(() => {
    cursorRef.current = cursor
  }, [cursor])

  useEffect(() => {
    const current = cursorRef.current
    const next = followInspectorCursor(current, previousLength.current, entries.length)
    if (next !== current) {
      savedScroll.current.set(current, visibleScrollRef.current)
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
      truncateColumns(t('panel.verbose.compact'), viewport.contentColumns),
    )
  }

  const title = entries.length === 0
    ? 'history details · empty'
    : `history details · entry ${cursor + 1}/${entries.length} · ${entryKindLabel(entry)} · lines ${allLines.length === 0 ? 0 : visibleScroll + 1}-${Math.min(allLines.length, visibleScroll + viewport.bodyRows)}/${allLines.length}`
  const visible = allLines.slice(visibleScroll, visibleScroll + viewport.bodyRows)
  const accent = panelAccent('history-inspector', getPalette().brand)
  return createElement(
    Box,
    {
      flexDirection: 'column',
      width: viewport.outerColumns,
      paddingX: 1,
      borderStyle: 'round',
      borderColor: inkColor(accent.border),
    },
    createElement(
      Text,
      { color: inkColor(accent.title), bold: true, wrap: 'truncate-end' },
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
      { wrap: 'truncate-end' },
      dim(truncateColumns(t('panel.verbose.footer'), viewport.contentColumns)),
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
   * event log keeps everything; /export reads all of it and Ctrl+O reads its
   * inspectable entries). */
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
 * here — the event log, the store projection, /export, and /resume keep the
 * full history; Ctrl+O keeps its inspectable subset. Ink 5's <Static> is a
 * consumption counter
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
  // The stores are closure-backed singletons whose methods never touch `this`,
  // but a bare method reference still detaches it from its receiver. One stable
  // wrapper per store keeps both the receiver and the reference identity the
  // `useSyncExternalStore` contract requires.
  const subscribeTranscript = useCallback((listener: () => void) => props.store.subscribe(listener), [props.store])
  const readTranscript = useCallback(() => props.store.getView(), [props.store])
  const view = useSyncExternalStore(subscribeTranscript, readTranscript)
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
  const subscribeCommands = useCallback((listener: () => void) => props.commands.subscribe(listener), [props.commands])
  const subscribeSkills = useCallback((listener: () => void) => props.skills.subscribe(listener), [props.skills])
  const descriptors = useSyncExternalStore(subscribeCommands, readDescriptors)
  const skills = useSyncExternalStore(subscribeSkills, readSkills)
  const [modelLabel, setModelLabel] = useState(props.model)
  const [modelOpen, setModelOpen] = useState(false)
  /** Nested /model stages; only one owns terminal input at a time. */
  const [providerOpen, setProviderOpen] = useState(false)
  const [providerAction, setProviderAction] = useState<
    | { kind: 'configure' | 'unset' | 'remove'; target: ProviderTargetView }
    | { kind: 'login' | 'logout'; target: ProviderTargetView; authorization: ProviderAuthorizationRow }
    | { kind: 'subscribe-login' | 'subscribe-logout'; target: ProviderTargetView; authorization: ProviderAuthorizationRow }
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
  const [rainbowBurstId, setRainbowBurstId] = useState(0)
  const fireRainbowBurst = (): void => {
    setRainbowBurstId(id => id + 1)
  }
  // /animation toggle: applies immediately, persists through the runner, and
  // gates every timed leaf (shimmer, chase, blink, wave) for this render.
  const [animations, setAnimations] = useState(props.animations ?? true)
  const applyAnimations = (enabled: boolean): void => {
    setAnimations(enabled)
    props.saveAnimations?.(enabled)
    notify(t('notice.animationState', { state: enabled ? 'on' : 'off' }))
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
  /** Bumped when /effort's catalog lookup must be ignored (panel closed or superseded). */
  const effortLookupEpoch = useRef(0)
  const [notice, setNotice] = useState<{ text: string; tone: NoticeTone } | undefined>(undefined)
  const notify = useCallback((text: string, tone: NoticeTone = 'info'): void => {
    setNotice({ text, tone })
  }, [])

  const {
    loadModels,
    loadModelProviders,
    loadProviderAuthorizations,
    onBridgeReady,
  } = props
  useEffect(() => {
    onBridgeReady({ notify })
  }, [notify, onBridgeReady])
  useEffect(() => {
    if (!modelOpen) return
    let cancelled = false
    setDirectory(undefined)
    setModelError(undefined)
    // Enter the promise chain before invoking the loader so a provider that
    // throws synchronously becomes an in-panel error instead of escaping the
    // React effect and tearing down Ink.
    Promise.resolve().then(() => loadModels()).then((loaded) => {
      if (!cancelled) setDirectory(loaded)
    }, (error: unknown) => {
      if (!cancelled) setModelError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
    }
  }, [loadModels, modelOpen, modelLoadEpoch])
  useEffect(() => {
    if (!modelOpen || loadModelProviders === undefined) return
    let cancelled = false
    setProviderDirectory(undefined)
    setProviderError(undefined)
    Promise.resolve().then(() => loadModelProviders()).then((loaded) => {
      if (!cancelled) setProviderDirectory(loaded)
    }, (error: unknown) => {
      if (!cancelled) setProviderError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
    }
  }, [loadModelProviders, modelOpen, modelLoadEpoch])
  useEffect(() => {
    if (!modelOpen || loadProviderAuthorizations === undefined) return
    let cancelled = false
    setAuthorizationDirectory(undefined)
    setAuthorizationError(undefined)
    Promise.resolve().then(() => loadProviderAuthorizations()).then((loaded) => {
      if (!cancelled) setAuthorizationDirectory(loaded)
    }, (error: unknown) => {
      if (!cancelled) setAuthorizationError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
    }
  }, [loadProviderAuthorizations, modelOpen, modelLoadEpoch])
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
  const [queueOpen, setQueueOpen] = useState(false)
  /**
   * How the composer delivers its next submission: `queue` waits for the next
   * turn, `steer` joins the turn already running. Tab on an empty composer
   * flips it; the prompt glyph and the placeholder both name the current mode.
   */
  const [submitMode, setSubmitMode] = useState<'queue' | 'steer'>('queue')
  const [diffView, setDiffView] = useState<GitDiffView | undefined>(undefined)
  const [reviewPickerOpen, setReviewPickerOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  const [permissionOpen, setPermissionOpen] = useState(false)
  const [resumeOpen, setResumeOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  /** /search seed: the query from `/search <text>` (cleared on open). */
  const [searchSeed, setSearchSeed] = useState('')
  const [pluginOpen, setPluginOpen] = useState(false)
  const [pluginQuery, setPluginQuery] = useState('')
  const [updateOpen, setUpdateOpen] = useState(false)
  const [updateApplying, setUpdateApplying] = useState(false)
  useEffect(() => subscribeUpdateApplyRunning(setUpdateApplying), [])
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [jobsOpen, setJobsOpen] = useState(false)
  const [statuslineOpen, setStatuslineOpen] = useState(false)
  const [statuslineItems, setStatuslineItems] = useState<readonly StatusItemId[]>(() => parseStatuslineItems(props.statusline))
  const [themeOpen, setThemeOpen] = useState(false)
  const [languageOpen, setLanguageOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [subagentOpen, setSubagentOpen] = useState(false)
  const [todosOpen, setTodosOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  /** /delete state: dedicated picker mode plus an optional pre-armed row id. */
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
  const deleteSession = props.deleteSession
  const confirmDelete = useCallback((): void => {
    const id = deleteConfirmId
    if (id === undefined) return
    setDeleteConfirmId(undefined)
    void deleteSession(id).then(outcome => {
      notify(outcome)
      // Keep the picker open and reload: a successful deletion must vanish
      // from the list immediately, not look like a no-op.
      setDeleteReloadToken(token => token + 1)
    }, (reason: unknown) => {
      notify(t('notice.deleteFailed', { message: reason instanceof Error ? reason.message : String(reason) }), 'error')
    })
  }, [deleteSession, deleteConfirmId, notify])
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
   * beyond stays in the live tree. */
  const settled = useMemo(() => settledEntryCount(view.entries), [view.entries])
  /** Next-turn rows in durable inbox order: a running tool row can split the
   * pending rows, so this maps the inbox id list onto the folded entries
   * instead of scanning the mutable tail. */
  const queuedRows = useMemo(
    () => queuedInboxRows(view.entries, view.pending['next-turn']),
    [view.entries, view.pending],
  )
  const [refreshEpoch, setRefreshEpoch] = useState(0)
  const subscribeApproval = useCallback((listener: () => void) => props.approval.subscribe(listener), [props.approval])
  const readApprovalSnapshot = useCallback(() => props.approval.getSnapshot(), [props.approval])
  const subscribeQuestions = useCallback((listener: () => void) => props.questions.subscribe(listener), [props.questions])
  const readQuestionSnapshot = useCallback(() => props.questions.getSnapshot(), [props.questions])
  const subscribeSubagents = useCallback((listener: () => void) => props.subagents.subscribe(listener), [props.subagents])
  const readAgentRows = useCallback(() => props.subagents.getSnapshot(), [props.subagents])
  const approvalSnapshot = useSyncExternalStore(subscribeApproval, readApprovalSnapshot)
  const questionSnapshot = useSyncExternalStore(subscribeQuestions, readQuestionSnapshot)
  const agentRows = useSyncExternalStore(subscribeSubagents, readAgentRows)
  const approvalPending = approvalSnapshot.pending !== undefined
  const questionPending = questionSnapshot.pending !== undefined
  /**
   * Every keyboard-owning surface that is mutually exclusive with the composer,
   * in precedence order. This ONE list drives the composer gate, the transcript
   * visibility, the frozen band's hint, and the hand-off when a human approval
   * or question arrives, so a panel cannot be wired into one of them and
   * forgotten in the others.
   */
  const panelSurfaces: readonly { readonly hint: string; readonly open: boolean; readonly close: () => void }[] = [
    { hint: 'the diff review', open: diffView !== undefined, close: () => setDiffView(undefined) },
    { hint: 'the review picker', open: reviewPickerOpen, close: () => setReviewPickerOpen(false) },
    {
      hint: '/model',
      open: modelOpen,
      close: () => {
        setModelOpen(false)
        setProviderOpen(false)
        setProviderAction(undefined)
        setEffortFor(undefined)
      },
    },
    { hint: '/help', open: helpOpen, close: () => setHelpOpen(false) },
    { hint: '/mode', open: modeOpen, close: () => setModeOpen(false) },
    { hint: '/permission', open: permissionOpen, close: () => setPermissionOpen(false) },
    { hint: '/resume', open: resumeOpen, close: () => setResumeOpen(false) },
    { hint: '/search', open: searchOpen, close: () => setSearchOpen(false) },
    { hint: '/plugin', open: pluginOpen, close: () => setPluginOpen(false) },
    { hint: '/update', open: updateOpen, close: () => setUpdateOpen(false) },
    { hint: '/schedule', open: scheduleOpen, close: () => setScheduleOpen(false) },
    { hint: '/jobs', open: jobsOpen, close: () => setJobsOpen(false) },
    { hint: '/statusline', open: statuslineOpen, close: () => setStatuslineOpen(false) },
    { hint: '/theme', open: themeOpen, close: () => setThemeOpen(false) },
    { hint: '/language', open: languageOpen, close: () => setLanguageOpen(false) },
    { hint: '/history', open: historyOpen, close: () => setHistoryOpen(false) },
    { hint: '/queue', open: queueOpen, close: () => setQueueOpen(false) },
    { hint: '/agents', open: agentsOpen, close: () => setAgentsOpen(false) },
    { hint: '/subagent', open: subagentOpen, close: () => setSubagentOpen(false) },
    { hint: '/todos', open: todosOpen, close: () => setTodosOpen(false) },
    { hint: '/usage', open: usageOpen, close: () => setUsageOpen(false) },
  ]
  const panelSurfacesRef = useRef(panelSurfaces)
  panelSurfacesRef.current = panelSurfaces
  const openPanel = panelSurfaces.find(surface => surface.open)
  // The Ctrl+O inspector is the one surface the composer already yields to
  // through verboseOpen; it rides the same gate without a panel row.
  const inspectorVisible = verboseOpen && !approvalPending && !questionPending
  // Filtering is inspector-only: the durable log and ordinary transcript keep
  // every reasoning settlement. Avoid scanning long histories while closed.
  const verboseEntries = useMemo(
    () => verboseOpen ? inspectableTranscriptEntries(view.entries) : [],
    [verboseOpen, view.entries],
  )
  const modalVisible = openPanel !== undefined || inspectorVisible || approvalPending || questionPending
  // While a deletion waits for y/n, the composer takes the keys (the resume
  // panel yields): the confirm is typed IN the input box, not as an invisible
  // panel keypress.
  const inputActive = deleteConfirmId !== undefined
    ? !approvalPending && !questionPending
    : !modalVisible
  const transcriptVisible = !modalVisible

  // Human questions outrank local inspectors. Close every open surface instead
  // of leaving it visible but keyboard-locked behind the approval.
  useEffect(() => {
    if (!approvalPending && !questionPending) return
    for (const surface of panelSurfacesRef.current) {
      if (surface.open) surface.close()
    }
    setDeleteConfirmId(undefined)
    setVerboseOpen(false)
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
  const resizeBurstHeld = useRef(false)
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

      // Hold the visible frame for the whole burst so intermediate Ink
      // relayouts (new width against still-old Static rows) never flash as
      // doubled borders. One clear + Static remount still runs after the
      // burst settles.
      if (!resizeBurstHeld.current) {
        resizeBurstHeld.current = true
        appStdout.write(SYNCHRONIZED_UPDATE_BEGIN)
      }
      setTerminalSize(next)
      if (replayTimer !== undefined) clearTimeout(replayTimer)
      replayTimer = setTimeout(() => {
        synchronizedReplayPending.current = true
        appStdout.write(RESIZE_REFLOW_CLEAR)
        setRefreshEpoch(epoch => epoch + 1)
        resizeBurstHeld.current = false
      }, RESIZE_REFLOW_DELAY_MS)
    }
    appStdout.on('resize', handleResize)
    return () => {
      appStdout.off('resize', handleResize)
      if (replayTimer !== undefined) clearTimeout(replayTimer)
      if (resizeBurstHeld.current) {
        appStdout.write(SYNCHRONIZED_UPDATE_END)
        resizeBurstHeld.current = false
      }
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
  // Pin the composer and status at the bottom: every extra chrome row
  // (completion menu, notice, todos, agents, extra editor/status rows)
  // covers live transcript instead of growing the tree.
  const dynamicRows = liveRegionBudget({
    terminalRows,
    composerRows,
    statusBarRows,
    menuRows,
    gutterRows: composerGutterRows,
    notice: notice !== undefined,
    todo: transcriptVisible && view.todos.length > 0,
    agents: transcriptVisible && agentRows.length > 0,
  })
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
    // The budget tripwire is a last-resort diagnostic: it fires only when the
    // live/static allocation already broke its contract, and Ink owns/shadows
    // console output. Everywhere else the TUI must never write to stdout.
    // eslint-disable-next-line no-console -- see the tripwire note above
    console.warn(`[dsh-code] ${liveAudit.warning}`)
  }
  const auditedLiveLines = liveAudit.allocation.live === visibleLiveLines.length
    ? visibleLiveLines
    : visibleLiveLines.slice(-liveAudit.allocation.live)
  const auditedReasoningRows = liveAudit.allocation.reasoning
  const auditedAnswerRows = liveAudit.allocation.answer
  // The surface that currently owns the keyboard, named in the frozen band:
  // an empty composer under a panel must not advertise typing it cannot
  // accept — every key actually feeds the panel (which may or may not
  // filter with it), so the honest hint names the owner and the way out.
  const keyboardOwner = approvalPending
    ? 'the approval prompt'
    : questionPending
      ? 'the question'
      : openPanel?.hint ?? (inspectorVisible ? 'history details' : undefined)
  // One way out of every panel, matching Esc: while a panel owns the keys,
  // Ctrl+C closes it instead of silently doing nothing. The composer keeps its
  // own three states (interrupt the turn / clear the draft / quit) whenever no
  // panel is open, and the approval and question bars keep theirs.
  useStableInput((input, key) => {
    if (!(key.ctrl && input === 'c')) return
    if (approvalPending || questionPending || deleteConfirmId !== undefined) return
    if (openPanel !== undefined) openPanel.close()
    else if (inspectorVisible) setVerboseOpen(false)
  }, true)
  const frozenHint = keyboardOwner === undefined
    ? undefined
    : t('frozen.keysGoTo', {
      owner: keyboardOwner,
      action: approvalPending
        ? t('frozen.action.rejects')
        : questionPending
          ? t('frozen.action.cancels')
          : updateApplying && updateOpen
            ? t('frozen.action.waits')
            : t('frozen.action.closes'),
    })
  const closeInspector = useCallback((): void => {
    setVerboseOpen(false)
  }, [])
  const refreshScreen = useCallback((opts?: { wipeScrollback?: boolean }): void => {
    // Resize / Ctrl+L wipe screen AND scrollback. A history-cap trim remounts
    // Static at the current width, so native scrollback must stay — the user
    // may be reading messages above the fold.
    const clear = opts?.wipeScrollback === false ? TRIM_REFLOW_CLEAR : RESIZE_REFLOW_CLEAR
    if (appStdout !== undefined) {
      synchronizedReplayPending.current = true
      appStdout.write(SYNCHRONIZED_UPDATE_BEGIN + clear)
    }
    setRefreshEpoch(epoch => epoch + 1)
  }, [appStdout])
  const applyRainbow = (seed?: number): void => {
    // Replace the memoized roll, then setTheme so getPalette() and the
    // painters pick the new values; persist rainbow as the active theme
    // so a mid-session /rainbow from dark/light actually sticks. The
    // source-backed rebuild (same as /theme) repaints Static history too.
    rerollRainbow(seed)
    setTheme('rainbow')
    props.saveTheme?.('rainbow')
    notify(t('notice.rainbowRolled', { seed: rainbowSeedLabel() }))
    fireRainbowBurst()
    refreshScreen()
  }
  useEffect(() => {
    if (!synchronizedReplayPending.current || appStdout === undefined) return
    synchronizedReplayPending.current = false
    appStdout.write(SYNCHRONIZED_UPDATE_END)
  }, [appStdout, refreshEpoch])
  /** The live subagent conversation currently attached as the whole view. */
  const [attachment, setAttachment] = useState<SubagentAttachment | undefined>(undefined)
  const attachStore = attachment?.store ?? EMPTY_ATTACH_STORE
  const subscribeAttached = useCallback((listener: () => void) => attachStore.subscribe(listener), [attachStore])
  const readAttached = useCallback(() => attachStore.getView(), [attachStore])
  const attachedView = useSyncExternalStore(subscribeAttached, readAttached)
  const attachedSettled = useMemo(() => settledEntryCount(attachedView.entries), [attachedView.entries])
  const attachedRowsCache = useRef<SettledRowsCache | undefined>(undefined)
  const attachedSettledRows = useMemo(() => {
    const result = computeSettledRows(
      attachedRowsCache.current,
      attachedView.entries,
      attachedSettled,
      showReasoning,
      true,
      refreshEpoch,
      terminalSize.columns,
    )
    attachedRowsCache.current = result.cache
    return result.cache.flat
  }, [attachedView.entries, attachedSettled, showReasoning, refreshEpoch, terminalSize.columns])
  /** Detach and hand the keyboard back to the /agents list. */
  const detach = useCallback((): void => {
    setAttachment(current => {
      current?.dispose()
      return undefined
    })
    refreshScreen()
    setAgentsOpen(true)
  }, [refreshScreen])
  const attachTo = useCallback((id: string, label: string): void => {
    if (props.attachSubagent === undefined) {
      notify(t('notice.attachUnavailable'), 'warning')
      return
    }
    setAttachment(current => {
      current?.dispose()
      return createSubagentAttachment(props.attachSubagent!, id, label)
    })
    setAgentsOpen(false)
    // The child's Static rows replace the parent's behind one clear + replay,
    // exactly like a theme switch or resize reflow.
    refreshScreen()
  }, [notify, props.attachSubagent, refreshScreen])
  useEffect(() => () => {
    setAttachment(current => {
      current?.dispose()
      return undefined
    })
  }, [])

  // Attachment keys: Esc/Ctrl+D detach (the composer's step-out chord),
  // Ctrl+C quits like the empty composer, `r` re-seeds from the durable log.
  useStableInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'd')) {
      detach()
      return
    }
    if (key.ctrl && input === 'c') {
      props.quit()
      return
    }
    if (input === 'r' && attachment !== undefined) {
      const id = attachment.id
      const label = attachment.label
      setAttachment(current => {
        current?.dispose()
        return current === undefined ? undefined : createSubagentAttachment(props.attachSubagent!, id, label)
      })
    }
  }, attachment !== undefined)
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
    refreshScreen({ wipeScrollback: false })
  }, [busy, refreshScreen, settledNeedsTrim, streamingActive])

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
        notify(t('notice.modelChangedPlaceholder', { model: selected }), 'warning')
      } else {
        notify(t('notice.modelNextStep', { model: selected }))
      }
      setModelOpen(false)
      setProviderOpen(false)
      setProviderAction(undefined)
      setEffortFor(undefined)
    } catch (error: unknown) {
      notify(t('notice.modelSwitchFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
    }
  }

  const reloadModelSurfaces = (): void => {
    setModelLoadEpoch(epoch => epoch + 1)
  }
  const closeModelSurface = (): void => {
    effortLookupEpoch.current += 1
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
        const raw = (model.extras)?.reasoningEfforts
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
    if (providerAction?.kind === 'subscribe-login'
      && props.beginProviderAuthorization !== undefined
      && props.cancelProviderAuthorization !== undefined
      && props.openAuthorizationUrl !== undefined
      && props.copyTextValue !== undefined) {
      const target = providerAction.target
      modelSurface = createElement(ProviderAuthorizationPanel, {
        row: providerAction.authorization,
        // A single-method provider signs in with no picker step; a provider
        // with several methods still chooses first.
        autoStartMethod: providerAction.authorization.methods.length === 1
          ? providerAction.authorization.methods[0].id
          : undefined,
        begin: props.beginProviderAuthorization,
        cancel: () => props.cancelProviderAuthorization!(providerAction.authorization),
        openUrl: props.openAuthorizationUrl,
        copy: props.copyTextValue,
        done: () => {
          const authorization = providerAction.authorization
          setProviderAction(undefined)
          // The subscription channel owns the route: drop the key reference
          // (it would resolve as a request-level override before the stored
          // sign-in record), then let the catalog serve every model.
          const enable = props.enableModelProviderSubscription
          if (enable === undefined) {
            notify(t('notice.loginUnavailable'), 'warning')
            reloadModelSurfaces()
            return
          }
          void enable(target).then(() => {
            // Materialize the catalog's model list into the profile so the
            // page's model layer shows what the subscription unlocked; the
            // route registers on the settings write, so one fresh read sees it.
            const save = props.saveModelProviderConfiguration
            const load = props.loadModels
            if (save === undefined || load === undefined) {
              reloadModelSurfaces()
              notify(t('notice.loggedIn', { provider: authorization.label }))
              return
            }
            Promise.resolve().then(() => load()).then(directory => {
              const rows = directory.rows.filter(row => row.provider === target.provider)
              if (rows.length === 0) {
                reloadModelSurfaces()
                notify(t('notice.loggedIn', { provider: authorization.label }))
                return
              }
              const configuration = {
                models: rows.map(row => ({ id: row.model, ...(row.modelName === undefined ? {} : { name: row.modelName }) })),
              }
              void save(target, configuration).then(() => {
                reloadModelSurfaces()
                notify(t('notice.loggedIn', { provider: authorization.label }))
              }, (reason: unknown) => {
                reloadModelSurfaces()
                notify(t('notice.loggedIn', { provider: authorization.label }))
                notify(reason instanceof Error ? reason.message : String(reason), 'warning')
              })
            }, () => {
              reloadModelSurfaces()
              notify(t('notice.loggedIn', { provider: authorization.label }))
            })
          }, (reason: unknown) => {
            reloadModelSurfaces()
            notify(reason instanceof Error ? reason.message : String(reason), 'error')
          })
        },
        back: () => { setProviderAction({ kind: 'configure', target: providerAction.target }) },
      })
    } else if (providerAction?.kind === 'subscribe-logout' && props.logoutProviderAuthorization !== undefined) {
      modelSurface = createElement(ProviderAuthorizationLogoutPanel, {
        row: providerAction.authorization,
        confirm: props.logoutProviderAuthorization,
        done: () => {
          setProviderAction(undefined)
          reloadModelSurfaces()
          notify(t('notice.loggedOut', { provider: providerAction.authorization.label }))
        },
        back: () => { setProviderAction({ kind: 'configure', target: providerAction.target }) },
      })
    } else if (providerAction?.kind === 'login'
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
          notify(t('notice.loggedIn', { provider: authorization.label }))
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
          notify(t('notice.loggedOut', { provider: authorization.label }))
        },
        back: () => setProviderAction(undefined),
      })
    } else if (providerAction?.kind === 'configure' && props.saveModelProviderConfiguration !== undefined) {
      const setupTarget = providerAction.target
      const setupAuthorization = authorizationForProvider(authorizationDirectory, setupTarget.provider)
      modelSurface = createElement(ProviderSetupPanel, {
        target: setupTarget,
        authorization: setupAuthorization,
        onSubscribe: (() => {
          const authorization = setupAuthorization
          if (authorization === undefined) return undefined
          if (busy) {
            notify(t('notice.loginIdleOnly'), 'warning')
            return undefined
          }
          if (authorization.inFlight) {
            notify(t('panel.provider.loginRunning'), 'warning')
            return undefined
          }
          if (authorization.record.configured) {
            if (props.logoutProviderAuthorization === undefined) {
              notify(t('notice.logoutUnavailable'), 'warning')
              return undefined
            }
            return () => { setProviderAction({ kind: 'subscribe-logout', target: setupTarget, authorization }) }
          }
          if (props.beginProviderAuthorization === undefined
            || props.cancelProviderAuthorization === undefined
            || props.openAuthorizationUrl === undefined
            || props.copyTextValue === undefined) {
            notify(t('notice.loginUnavailable'), 'warning')
            return undefined
          }
          return () => { setProviderAction({ kind: 'subscribe-login', target: setupTarget, authorization }) }
        })(),
        effortDonors,
        save: props.saveModelProviderConfiguration,
        saveCredential: props.saveModelProviderCredential,
        discover: props.discoverModelProvider
          ?? (() => Promise.reject(new Error('model discovery is unavailable in this profile; enter models by hand'))),
        done: result => {
          const target = providerAction.target
          setProviderAction(undefined)
          setProviderOpen(true)
          reloadModelSurfaces()
          notify(t('notice.providerSaved', { provider: target.displayName, suffix: result.key ? ' · API key updated' : '' }))
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
          notify(t('notice.apiKeyRemoved', { provider: target.displayName }))
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
          notify(t('notice.providerRemoved', { provider: target.displayName }))
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
            notify(t('notice.providerUnavailable'), 'warning')
            return
          }
          setProviderAction({ kind: 'configure', target })
        },
        onUnset: (target: ProviderTargetView) => {
          if (props.unsetModelProviderCredential === undefined) {
            notify(t('notice.apiKeyUnavailable'), 'warning')
            return
          }
          setProviderAction({ kind: 'unset', target })
        },
        onRemove: (target: ProviderTargetView) => {
          if (props.removeModelProvider === undefined) {
            notify(t('notice.providerRemovalUnavailable'), 'warning')
            return
          }
          setProviderAction({ kind: 'remove', target })
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
          const effortId = row.reasoning?.efforts.length === 1 ? row.reasoning.efforts[0].id : undefined
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

  if (attachment !== undefined) {
    // The attached child REPLACES the main view: its settled rows already
    // ride <Static> above (items switch), and the live region mirrors the
    // main conversation's tail with a simplified chrome budget (readonly
    // bar band + one status row + one gutter + Ink's two spare rows).
    const attachDynamicRows = Math.max(1, terminalRows - 3 - 1 - 1 - 2)
    const attachBusy = attachedView.busySince !== undefined
    const attachStreaming = attachedView.streaming !== '' || attachedView.streamingReasoning !== ''
    const attachAllLiveLines = attachedView.entries.slice(attachedSettled).flatMap(
      entry => transcriptEntryLines(entry, Math.max(1, terminalColumns - 2), showReasoning),
    )
    const attachLiveBudget = attachBusy || attachStreaming
      ? Math.max(1, Math.floor(attachDynamicRows / 3))
      : Math.max(0, attachDynamicRows - 1)
    const attachVisibleLive = attachLiveBudget === 0 ? [] : attachAllLiveLines.slice(-attachLiveBudget)
    const attachStreamRows = Math.max(1, attachDynamicRows - attachVisibleLive.length)
    const attachReasoningRows = attachedView.streamingReasoning === ''
      ? 0
      : attachedView.streaming === ''
        ? attachStreamRows
        : attachStreamRows <= 1
          ? 0
          : showReasoning
            ? Math.max(1, Math.floor(attachStreamRows / 3))
            : 1
    const attachAnswerRows = attachedView.streaming === '' ? 0 : Math.max(1, attachStreamRows - attachReasoningRows)
    const attachAudit = clampLiveAllocation(
      { live: attachVisibleLive.length, reasoning: attachReasoningRows, answer: attachAnswerRows },
      attachDynamicRows,
    )
    const attachTurns = attachedView.entries.filter(entry => entry.kind === 'turn-marker').length
    return createElement(
      Box,
      { flexDirection: 'column' },
      createElement(MemoStaticTranscript, {
        key: refreshEpoch,
        items: attachedSettledRows,
      }),
      createElement(
        Box,
        { flexDirection: 'column' },
        attachAudit.allocation.live === attachVisibleLive.length && attachVisibleLive.length > 0
          ? createElement(StyledRows, { lines: attachVisibleLive })
          : undefined,
        attachedView.streamingReasoning !== '' && attachAudit.allocation.reasoning > 0
          ? createElement(StreamTail, {
            text: showReasoning ? attachedView.streamingReasoning : 'Thinking…',
            prefix: '✻ ',
            continuationPrefix: '  ',
            dim: true,
            maxRows: attachAudit.allocation.reasoning,
            columns: Math.max(1, terminalColumns - 2),
          })
          : undefined,
        attachedView.streaming !== '' && attachAudit.allocation.answer > 0
          ? createElement(StreamTail, {
            text: attachedView.streaming,
            dim: false,
            maxRows: attachAudit.allocation.answer,
            prefix: '  ',
            columns: Math.max(1, terminalColumns - 2),
          }, attachBusy ? createElement(Caret, { animated: animations }) : undefined)
          : undefined,
        attachBusy && attachedView.streaming === '' && attachedView.streamingReasoning === ''
          ? createElement(DeepDivingLine, { since: attachedView.busySince, animated: animations })
          : undefined,
      ),
      createElement(
        Box,
        { borderStyle: 'round', borderColor: inkColor(getPalette().brandMid), paddingX: 1, flexDirection: 'column' },
        createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(
          attachment.seeded()
            ? `❯ ${t('attach.bar', { label: attachment.label })}`
            : `❯ ${t('attach.loading', { label: attachment.label })}`,
          Math.max(1, terminalColumns - 4),
        )),
      ),
      createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns(
        t('attach.status', { id: attachment.id.slice(-12), label: attachment.label, turns: attachTurns }),
        Math.max(1, terminalColumns - 2),
      )),
    )
  }
  return createElement(
    Box,
    { flexDirection: 'column' },
    createElement(MemoStaticTranscript, {
      key: refreshEpoch,
      items: attachment === undefined ? settledRows : attachedSettledRows,
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
              columns: Math.max(1, terminalColumns - 2),
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
                columns: Math.max(1, terminalColumns - 2),
              })
          : undefined,
        view.streaming !== '' && auditedAnswerRows > 0
          ? createElement(
            StreamTail,
            // The same two-column gutter as settled replies: streamed text
            // lands exactly where the assembled message will render.
            { text: view.streaming, dim: false, maxRows: auditedAnswerRows, prefix: '  ', columns: Math.max(1, terminalColumns - 2) },
            busy ? createElement(Caret, { animated: animations }) : undefined,
          )
          : undefined,
        deepDivingVisible ? createElement(DeepDivingLine, { since: view.busySince, animated: animations }) : undefined,
      )
      : undefined,
    transcriptVisible ? createElement(TodoPanel, { todos: view.todos }) : undefined,
    transcriptVisible ? createElement(AgentsLine, { rows: agentRows, total: props.subagents.getTotalSeen() }) : undefined,
    usageOpen && !approvalPending && !questionPending
      ? createElement(UsagePanel, {
        key: props.sessionKey,
        load: props.loadUsage,
        close: () => setUsageOpen(false),
      })
      : undefined,
    todosOpen && !approvalPending && !questionPending
      ? createElement(MemoTodoListPanel, {
        todos: view.todos,
        onClose: () => {
          setTodosOpen(false)
        },
      })
      : undefined,
    queueOpen && !approvalPending && !questionPending
      ? createElement(QueuePanel, {
        rows: queuedRows,
        busy,
        update: props.updateQueued,
        onClose: () => setQueueOpen(false),
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
    reviewPickerOpen && !approvalPending && !questionPending && props.listReviewBranches !== undefined && props.listReviewCommits !== undefined
      ? createElement(ReviewPickerPanel, {
        loadBranches: props.listReviewBranches,
        loadCommits: props.listReviewCommits,
        choose: argument => {
          setReviewPickerOpen(false)
          props.reviewChanges(argument)
        },
        close: () => setReviewPickerOpen(false),
      })
      : undefined,
    verboseOpen && !approvalPending && !questionPending
      ? createElement(MemoVerbosePanel, {
        entries: verboseEntries,
        onClose: closeInspector,
        columns: terminalColumns,
        rows: terminalRows,
      })
      : undefined,
    modeOpen && !approvalPending && !questionPending
      ? createElement(ModePanel, {
        current: props.mode,
        load: props.loadPresets,
        select: (id: string) => {
          void props.switchMode(id).then(label => {
            notify(t('notice.modeChangedSimple', { value: label }))
            setModeOpen(false)
          }, (reason: unknown) => notify(t('notice.modeSwitchFailed', { message: reason instanceof Error ? reason.message : String(reason) }), 'error'))
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
            notify(t('notice.permissionChangedSimple', { value: selected }))
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
        requestDelete: resumeDelete.mode ? requestDelete : undefined,
        deleteConfirmId,
        reloadToken: deleteReloadToken,
        deleteMode: resumeDelete.mode,
        presetId: resumeDelete.id,
        select: (row: SessionRow) => {
          // Defense in depth: the dedicated delete picker must never turn a
          // selection into a session switch, even if its key routing regresses.
          if (resumeDelete.mode) return
          props.switchSession(row)
          setResumeOpen(false)
        },
        close: () => setResumeOpen(false),
      })
      : undefined,
    searchOpen && !approvalPending && !questionPending && props.searchSessions !== undefined
      ? createElement(SearchPanel, {
        load: props.searchSessions,
        initialQuery: searchSeed,
        select: (row: SearchRow) => {
          setSearchOpen(false)
          props.switchSession({
            id: row.id,
            createdAt: row.updatedAt,
            updatedAt: row.updatedAt,
            cwd: '',
            workspace: '',
            subagent: row.subagent,
            resumable: row.resumable,
            live: false,
            persisted: true,
            preset: '',
          })
        },
        close: () => setSearchOpen(false),
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
          // Rainbow prints its roll seed so a lucky launch can be reproduced
          // with RAINBOW_SEED=<seed>.
          notify(name === 'rainbow'
            ? t('notice.themeRainbow', { seed: rainbowSeedLabel() })
            : t('notice.themeSaved', { name }))
          setThemeOpen(false)
          // The header whale and settled history live in the Static region,
          // which renders once and would keep the old palette's colors; the
          // same source-backed rebuild resize and Ctrl+L use repaints the
          // whole screen (scrollback included) from the new palette.
          if (name === 'rainbow') fireRainbowBurst()
          refreshScreen()
        },
        close: () => setThemeOpen(false),
      })
      : undefined,
    languageOpen && !approvalPending && !questionPending
      ? createElement(LanguagePanel, {
        current: getLanguage(),
        select: (name: LanguageName) => {
          props.saveLanguage(name)
          notify(t('notice.languageSaved', { name }))
          setLanguageOpen(false)
          // The Static region renders once; the same source-backed rebuild
          // the theme switch uses repaints translated text everywhere.
          refreshScreen()
        },
        close: () => setLanguageOpen(false),
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
        attach: props.attachSubagent === undefined ? undefined : attachTo,
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
            notify(t('notice.subagentsChanged', { value: label }))
            setSubagentOpen(false)
          } catch (reason: unknown) {
            notify(t('notice.subagentChangeFailed', { message: reason instanceof Error ? reason.message : String(reason) }), 'error')
          }
        },
        inherit: () => {
          props.clearSubagentModel()
          notify(t('notice.subagentsInherited'))
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
      createElement(Composer, {
        active: inputActive,
        frozen: modalVisible,
        frozenHint,
        busy,
        descriptors,
        skills,
        dispatch: props.dispatch,
        steer: props.steer,
        submitMode,
        cycleSubmitMode: () => {
          const next = submitMode === 'queue' ? 'steer' : 'queue'
          setSubmitMode(next)
          notify(t(next === 'steer' ? 'notice.submitMode.steer' : 'notice.submitMode.queue'))
        },
        applyEditorKeys: props.applyEditorKeys,
        interrupt: props.interrupt,
        quit: props.quit,
        openModel: () => {
          effortLookupEpoch.current += 1
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
          const epoch = ++effortLookupEpoch.current
          void props.loadModels().then((loaded) => {
            if (epoch !== effortLookupEpoch.current) return
            const [provider, model] = modelLabel.split('/')
            const row = loaded.rows.find(candidate => candidate.provider === provider && candidate.model === model)
              ?? loaded.rows.find(candidate => candidate.model === model && candidate.reasoning !== undefined)
              ?? loaded.rows.find(candidate => candidate.model === model)
            if (row === undefined) {
              notify(t('notice.modelMissing'), 'warning')
              return
            }
            const rowTag = `${row.provider}/${row.model}`
            if (loaded.reasoningFailures?.includes(rowTag) === true) {
              notify(t('notice.effortUnavailable'), 'warning')
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
        openSearch: (query: string) => {
          if (props.searchSessions === undefined) {
            notify(t('notice.sessionSearchUnavailable'), 'warning')
            return
          }
          setSearchSeed(query)
          setSearchOpen(true)
        },
        openPlugin: (query = '') => { setPluginQuery(query); setPluginOpen(true) },
        openUpdate: () => setUpdateOpen(true),
        openSchedule: () => setScheduleOpen(true),
        openJobs: () => setJobsOpen(true),
        openStatusline: () => setStatuslineOpen(true),
        openTheme: () => setThemeOpen(true),
        openLanguage: () => setLanguageOpen(true),
        saveLanguage: props.saveLanguage,
        openHistory: () => setHistoryOpen(true),
        openQueue: () => setQueueOpen(true),
        openAgents: () => setAgentsOpen(true),
        openSubagent: () => setSubagentOpen(true),
        openTodos: () => setTodosOpen(true),
        openUsage: () => setUsageOpen(true),
        openDelete: (id?: string) => {
          const armed = id === undefined || id === '' ? undefined : id
          setResumeDelete({ mode: true, ...armed === undefined ? {} : { id: armed } })
          // Confirm after the picker resolves the id against the listing —
          // the argument may be a suffix of the displayed id, not the row key.
          setDeleteConfirmId(undefined)
          setResumeOpen(true)
        },
        openDiff: (argument: string) => {
          void props.loadGitDiff(argument).then(setDiffView, (error: unknown) => {
            notify(`diff failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
          })
        },
        reviewChanges: props.reviewChanges,
        openReviewPicker: () => setReviewPickerOpen(true),
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
        updateQueued: props.updateQueued,
        historyFill,
        historyConsumed,
        animations,
        applyAnimations,
        applyRainbow,
        rainbowBurstId,
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
        animated: animations,
        columns: terminalColumns,
        items: statuslineItems,
        onRows: handleStatusRows,
      }),
    ),
  )
}
