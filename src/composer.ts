/** Composer input, command routing, attachments, and one-shot composer animations. */

import { basename } from 'node:path'
import { createElement, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { Box, Text, useStdin, useStdout } from 'ink'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import type { ContentBlock, FileBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import {
  looksLikeImagePath,
  looksLikePathDraft,
  parsePastedAttachmentPaths,
  type FilePathInspection,
  type ImagePathInspection,
} from './attachments.ts'
import { CompletionMenu, completionMenuRowCount } from './completion-panel.ts'
import {
  BARE_LOCAL_COMMANDS,
  completionCandidates,
  slashNameAndArgs,
  stepCompletionIndex,
  type CompletionCandidate,
} from './completion.ts'
import { isSlashLine, submissionPayload } from './commands.ts'
import type { SkillRow } from './skills.ts'
import { isPathLikeMentionQuery, type MentionCandidate } from './mentions.ts'
import {
  beginRecall,
  recallNewer,
  recallOlder,
  appendRecall,
  type RecallState,
} from './history.ts'
import { parseReviewArgument, type ReviewSelection } from './git-workflow.ts'
import { parseLanguageName, t, type LanguageName } from './i18n.ts'
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
import { parseRainbowArgument, rainbowRoll } from './rainbow.ts'
import {
  BUSY_CHASE_TICK_MS,
  CARET_BLINK_TICK_MS,
  DEEPSEEK_WAVE_TICK_MS,
  busyChaseFrame,
  deepseekWaveColumnBg,
  deepseekWaveDuration,
  deepseekWaveSpark,
  deepseekWaveWordHue,
  deepseekWaveWordVisible,
  flowColor,
  parseAnimationsArgument,
  RAINBOW_BURST_DURATION_MS,
  RAINBOW_BURST_TICK_MS,
  rainbowBurstColumnBg,
  type DeepseekWaveStyle,
  type DeepseekWaveTier,
} from './render/animations.ts'
import {
  caretSite,
  clampCursor,
  deleteBackward,
  deleteForward,
  deleteWordBackward,
  deleteWordForward,
  editorModel,
  editorRowParts,
  insertText,
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
  type EditResult,
  type EditorRowModel,
} from './render/editor.ts'
import { imeCursorRowsUp, useImeCursorAnchor } from './render/ime-cursor.ts'
import { rankByName } from './render/fuzzy.ts'
import { visibleColumns } from './render/markdown.ts'
import { displayText, singleLineText, truncateColumns } from './render/text.ts'
import type { TranscriptEntry } from './render/projection.ts'
import { sanitizeTerminalTitle, terminalTitleSequence } from './terminal-title.ts'
import {
  FLOW_ANCHORS,
  getPalette,
  inkColor,
  isPrismatic,
  isRainbow,
  themeFlow,
  type RgbTriple,
} from './theme.ts'
import type { NoticeTone, QueueMutation } from './ui-contract.ts'
import { useFrames } from './use-frames.ts'
import { useStableInput } from './use-stable-input.ts'

/** Theme-coordinated hues for the one-shot composer wave. */
function deepseekWaveHues(tier: DeepseekWaveTier): readonly [RgbTriple, RgbTriple, RgbTriple] {
  const palette = getPalette()
  if (isRainbow()) {
    const anchors = rainbowRoll().flowAnchors
    const stride = Math.max(1, Math.floor(anchors.length / 3))
    return [anchors[0], anchors[stride], anchors[stride * 2]]
  }
  if (isPrismatic()) return [FLOW_ANCHORS[0], FLOW_ANCHORS[1], FLOW_ANCHORS[2]]
  return tier === 'flash'
    ? [palette.brandBright, palette.brand, palette.brandMid]
    : [palette.brandBright, palette.code, palette.brandMid]
}

/** Original web StateDot chase used by the busy composer marker. */
function BusyChase({ animated = true }: { animated?: boolean }): ReactElement {
  const tick = useFrames(BUSY_CHASE_TICK_MS, animated)
  // Flowing themes (prismatic, rainbow) ride their anchor walk while busy;
  // every other theme (and the frozen state) keeps the palette's live accent.
  const flow = themeFlow()
  const marker = flow !== undefined && animated
    ? flowColor(tick * BUSY_CHASE_TICK_MS + flow.phaseMs, flow.anchors)
    : getPalette().brandBright
  return createElement(Text, { color: inkColor(marker) }, busyChaseFrame(tick) + ' ')
}

/** One resettable input-caret phase shared by the entire composer. */
function useCursorBlink(active: boolean): { visible: boolean; reset: () => void } {
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

/** Collapse the verbose editor draft into one bounded, display-safe row. */
function verboseLine(text: string, columns: number): string {
  return truncateColumns(displayText(text).replace(/\n/gu, ' ↵ ').replace(/\t/gu, '  '), Math.max(1, columns))
}

/** The empty-composer placeholder text (shared by the static and wave paths). */
const composerPlaceholder = (mode: 'queue' | 'steer'): string =>
  t(mode === 'steer' ? 'composer.placeholderSteer' : 'composer.placeholder')

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
    const cell = cells[start]
    let end = start + 1
    while (end < cells.length && sameCellStyle(cells[end], cell)) end += 1
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
    column += cells[index].width ?? visibleColumns(cells[index].char)
    if (column > target) return undefined
  }
  return undefined
}

/**
 * Wall-clock wave frames — strictly ONE sweep per MOUNT; the mount-spanning
 * one-shot latch (surviving modal unmounts) lives in Composer as `wavePlayedKey`.
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
  /** Empty-composer placeholder for the delivery mode in force. */
  placeholder: string
  promptColor: string
  /** Fires EXACTLY ONCE when this sweep ends for any reason — completed,
   * cancelled by the gate, or unmounted (a modal panel froze the composer) —
   * so Composer's played-key latch survives the leaf's unmount/remount cycle. */
  onSettled: () => void
}

/**
 * The self-contained wave leaf: it owns its 33ms tick, so the sweep
 * re-renders ONLY this component at ~30fps — Composer's derived editor state
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
  // unmount (a modal opened and froze the composer) — latching Composer's
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
    const tail = placeholder ? props.placeholder : parts.after
    for (const span of splitGraphemes(tail)) push(span.text, placeholder ? { dim: true } : {})
    while (usedColumns < props.bandWidth) push(' ')

    const middleBandRow = Math.floor(totalBandRows / 2)
    if (bandRow === middleBandRow && deepseekWaveWordVisible(tick, tier, style)) {
      const word = tier === 'unknown' ? 'Into the Unknown' : 'deepseek'
      const start = Math.max(2, Math.floor((props.bandWidth - word.length) / 2))
      const indices = Array.from({ length: word.length }, (_, at) => cellIndexAtColumn(cells, start + at))
      if (indices.every(index => index !== undefined && (cells[index].char === ' ' || cells[index].dim === true))) {
        for (let at = 0; at < word.length; at += 1) {
          const cell = cells[indices[at]!]
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
      if (spark !== null && lastIndex !== undefined && cells[lastIndex].char === ' ') {
        cells[lastIndex].char = spark
        cells[lastIndex].color = props.promptColor
        cells[lastIndex].bold = true
        cells[lastIndex].dim = false
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
 * The /rainbow celebration leaf: a FIXED seven-color ribbon that slides
 * across the three-row composer band. Same cell model as ComposerWave so
 * CJK/emoji stay atomic; no wordmark, no sparkles — the spectrum is the
 * show. Strictly one-shot per burst id (Composer latches onSettled).
 */
function ComposerRainbowBurst(props: Omit<ComposerWaveProps, 'tier' | 'style'>): ReactElement {
  const durationMs = RAINBOW_BURST_DURATION_MS
  const { tick, done } = useWaveFrames(props.active, durationMs)
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
  if (!props.active || done || tick * RAINBOW_BURST_TICK_MS >= durationMs) return props.fallback
  const bandRgb = getPalette().composerBand
  const totalBandRows = props.rows.length + 2
  const burstBg = (row: number, column: number): string => {
    const rgb = rainbowBurstColumnBg(tick, column, props.bandWidth, bandRgb, row, totalBandRows)
    return rgb === null ? props.bandBg : inkColor(rgb)
  }
  const blankBandRow = (row: number): ReactElement => {
    const blanks: ComposerCell[] = []
    for (let column = 0; column < props.bandWidth; column += 1) {
      blanks.push({ char: ' ', width: 1, backgroundColor: burstBg(row, column) })
    }
    return createElement(Text, { key: `blank-${row}` }, ...waveRowSpans(blanks))
  }
  const editorBurstRows = props.rows.map((row, visibleIndex) => {
    const sourceIndex = props.windowStart + visibleIndex
    const bandRow = visibleIndex + 1
    const parts = editorRowParts(row, sourceIndex, props.caretRow, props.cursor)
    const placeholder = sourceIndex === 0 && props.value === ''
    const cells: ComposerCell[] = []
    let usedColumns = 0
    const push = (char: string, extra: Omit<ComposerCell, 'char' | 'width' | 'backgroundColor'> = {}): void => {
      const width = visibleColumns(char)
      cells.push({ char, width, backgroundColor: burstBg(bandRow, usedColumns), ...extra })
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
    const tail = placeholder ? props.placeholder : parts.after
    for (const span of splitGraphemes(tail)) push(span.text, placeholder ? { dim: true } : {})
    while (usedColumns < props.bandWidth) push(' ')
    return createElement(Text, { key: `editor-${sourceIndex}`, wrap: 'truncate-end' }, ...waveRowSpans(cells))
  })
  return createElement(
    Box,
    { flexDirection: 'column', width: props.bandWidth },
    blankBandRow(0),
    ...editorBurstRows,
    blankBandRow(totalBandRows - 1),
  )
}

/** One-word kind label per entry, so the inspector's ←→ walk names what
 * each step is instead of leaving the reader to infer it from the body. */

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
export function Composer({ active, frozen, frozenHint, busy, descriptors, skills, dispatch, steer, submitMode, cycleSubmitMode, interrupt, quit, openModel, openEffort, openHelp, openMode, openPermission, openResume, openSearch, openPlugin, openUpdate, openSchedule, openJobs, openStatusline, openTheme, openLanguage, saveLanguage, openHistory, openQueue, openAgents, openSubagent, openTodos, openUsage, openDelete, openDiff, openReviewPicker, reviewChanges, deleteConfirm, confirmDelete, cancelDelete, createSession, forkSession, cancelSessionSwitch, notify, applyEditorKeys, hasNotice, dismissNotice, toggleReasoning, openVerbose, clearView, refresh, loadMentions, inspectImages, prepareImages, inspectFiles, prepareFiles, cycleMode, exportTranscript, renameTitle, copyLastResponse, recallSpace, recordLocal, recordHistory, queued, updateQueued, historyFill, historyConsumed, animations, applyAnimations, applyRainbow, rainbowBurstId, waveTier, waveStyle, maxRows, anchorRowsBelow, tabTitle, onEditorRows, onMenuRows, sessionKey }: {
  active: boolean
  frozen: boolean
  /** Frozen-band hint naming the surface that owns the keyboard; an empty
   * draft otherwise advertises typing that the composer cannot accept. */
  frozenHint?: string
  busy: boolean
  descriptors: readonly CommandDescriptor[]
  skills: readonly SkillRow[]
  dispatch: (text: string, attachments?: readonly ContentBlock[], origin?: string) => void
  /** Submit as steering into the running turn (see {@link AppProps.steer}). */
  steer: (text: string, attachments?: readonly ContentBlock[], origin?: string) => void
  /** Delivery mode the next submission uses; Tab on an empty composer flips it. */
  submitMode: 'queue' | 'steer'
  /** Flip {@link submitMode} and report the new mode. */
  cycleSubmitMode: () => void
  /** The full current session identity ('' while pending); the delivery origin. */
  sessionKey: string
  interrupt: () => boolean
  quit: () => void
  openModel: () => void
  openEffort: () => void
  openHelp: () => void
  openMode: () => void
  openPermission: () => void
  openResume: () => void
  /** Open the /search panel with an optional seed query. */
  openSearch: (query: string) => void
  openPlugin: (query?: string) => void
  /** Open the /update panel (aligned upgrade surface). */
  openUpdate: () => void
  /** Open the /schedule reminder panel (read-only catalog). */
  openSchedule: () => void
  openJobs: () => void
  openStatusline: () => void
  openTheme: () => void
  /** Open the /language picker (bare /language). */
  openLanguage: () => void
  /** Apply and persist a language chosen by argument. */
  saveLanguage: (name: LanguageName) => void
  openHistory: () => void
  openQueue: () => void
  /** Open the /agents panel (live subagent feed + transcript entry). */
  openAgents: () => void
  /** Open the /subagent model panel. */
  openSubagent: () => void
  /** Open the /todos subpage (full todo list in one bounded panel). */
  openTodos: () => void
  openUsage: () => void
  /** Open the dedicated /delete picker, optionally pre-armed on one id. */
  openDelete: (id?: string) => void
  openDiff: (argument: string) => void
  reviewChanges: (selection: ReviewSelection) => void
  /** Open the /review candidate picker (bare /review). */
  openReviewPicker: () => void
  /** The row id awaiting y/n in this box, when a deletion is pending. */
  deleteConfirm?: string
  /** Confirm the pending deletion (y in the box). */
  confirmDelete: () => void
  /** Cancel the pending deletion (any other key in the box). */
  cancelDelete: () => void
  createSession: (mode?: string) => void
  forkSession: (argument: string) => void
  cancelSessionSwitch: () => boolean
  notify: (text: string, tone?: NoticeTone) => void
  /** Apply the Ctrl+R passthrough to the detected editor (/vscode-keys); resolves to a one-line summary. */
  applyEditorKeys: () => Promise<string>
  hasNotice: boolean
  dismissNotice: () => void
  toggleReasoning: () => void
  openVerbose: () => void
  clearView: () => void
  refresh: () => void
  loadMentions: (query: string, signal?: AbortSignal) => Promise<readonly MentionCandidate[]>
  inspectImages: (paths: readonly string[]) => Promise<readonly ImagePathInspection[]>
  prepareImages: (paths: readonly string[], signal?: AbortSignal) => Promise<readonly ImageBlock[]>
  inspectFiles: (paths: readonly string[]) => Promise<readonly FilePathInspection[]>
  prepareFiles: (paths: readonly string[], signal?: AbortSignal) => Promise<readonly FileBlock[]>
  cycleMode: () => string
  exportTranscript: (argument: string) => Promise<void>
  renameTitle: (argument: string) => string
  copyLastResponse: () => Promise<string>
  /** Newest-first recall space (persistent + in-session, deduped). */
  recallSpace: readonly string[]
  /** Record one in-session submission (deduped, local only). */
  recordLocal: (text: string) => void
  /** Persist one submission to the global history file. */
  recordHistory: (text: string) => void
  /** Next-turn inbox rows, ordered exactly as the durable inbox. */
  queued: readonly Extract<TranscriptEntry, { kind: 'pending' }>[]
  updateQueued?: (messageId: string, action: QueueMutation) => void
  /** Accepted /history entry waiting to be placed into the composer. */
  historyFill: { text: string; index: number } | undefined
  /** Marks the accepted entry consumed (called after the fill is applied). */
  historyConsumed: () => void
  /** Whether timed animations run (shimmer, chase, blink, wave). */
  animations: boolean
  /** Apply and report one /animation toggle (App persists through the runner). */
  applyAnimations: (enabled: boolean) => void
  /** Reroll or pin the rainbow palette (switches to rainbow if needed). */
  applyRainbow: (seed?: number) => void
  /** Monotonic id of the in-flight /rainbow composer burst; 0 means none. */
  rainbowBurstId: number
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
  onEditorRows: (rows: number) => void
  /** Reports the open completion menu's physical row count (0 when closed)
   * for the same reason: the dynamic budget must reserve it, not overflow. */
  onMenuRows: (rows: number) => void
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

  // A /history panel acceptance lands as a fill: append the sanitized text to
  // the composer and resume recall from that entry. Appending (never
  // replacing) is what keeps a half-written draft and its prepared
  // attachments from being destroyed by picking a history entry.
  useEffect(() => {
    if (historyFill === undefined) return
    const safe = sanitizeDraftText(historyFill.text)
    const current = valueRef.current
    const joined = appendRecall(current, safe)
    valueRef.current = joined
    cursorRef.current = joined.length
    setValue(joined)
    setCursor(joined.length)
    resetCursorBlink()
    preferredColumnRef.current = null
    setDismissedMenuValue(undefined)
    recall.current = {
      entries: recallSpace,
      index: historyFill.index,
      // The draft this fill appended to stays reachable: Down walks back to it.
      savedDraft: current,
      lastRecalled: joined,
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
      // `Readable.read` is declared `any`; the assertion names its real result
      // union once so the normalization and the focus-event stripping below
      // stay type-checked. Node hands back a Buffer unless an encoding was set,
      // and null once the stream ends.
      const chunk = originalRead(...args) as string | Buffer | null
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
      stdin.read = originalRead
    }
  }, [focusReporting, inputStdout, stdin])

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
  const slashActive = candidates.length > 0 && value.startsWith('/') && !value.includes(' ') && !value.includes('\n') && !looksLikePathDraft(value)

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
      notify(t('notice.attachmentAlready', { name: inspection.name }), 'warning')
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
    notify(t('notice.attachmentsChecking', { count: total, plural: total === 1 ? '' : 's' }))
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
        notify(t('notice.attachmentsAlready'), 'warning')
        return
      }
      const current = valueRef.current
      const anchor = remapStableRange(originalValue, current, { start: originalCursor, end: originalCursor })
      if (anchor === undefined) {
        notify(t('notice.attachmentDraftChanged'), 'warning')
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
      notify(t('notice.attachmentsReady', { count, plural: count === 1 ? '' : 's' }))
    }, (reason: unknown) => {
      notify(t('notice.attachmentFailed', { message: reason instanceof Error ? reason.message : String(reason) }), 'error')
    })
  }

  useEffect(() => {
    const requestId = mentionRequestRef.current + 1
    mentionRequestRef.current = requestId
    if (!active || !mentionActive) {
      setMentionRows(current => current.length === 0 ? current : [])
      setMentionError(current => current === undefined ? current : undefined)
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
  }, [active, loadMentions, mentionActive, mentionToken?.query])

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

  /**
   * What accepting the highlighted completion candidate would insert, or ''
   * when nothing can be accepted (no rows, or an image row that resolves
   * asynchronously). The Enter branch uses it to tell a real accept from a
   * no-op that must fall through to submission.
   */
  const highlightedCompletion = (): string => {
    if (mentionActive) {
      const row = rankedMentionRows[completionIndex % Math.max(1, rankedMentionRows.length)]
      if (row === undefined) return ''
      if (row.kind === 'file' && row.path !== undefined && looksLikeImagePath(row.path)) return ''
      return row.label.startsWith('@') ? row.label : `@${row.label}${row.kind === 'directory' ? '/' : ''}`
    }
    const candidate = candidates[completionIndex % Math.max(1, candidates.length)]
    return candidate === undefined ? '' : `${candidate.label} `
  }

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
              notify(t('notice.imageDraftChanged'), 'warning')
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
              notify(t('notice.attachmentAlready', { name: inspection.name }), 'warning')
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
            notify(t('notice.imageReady', { name: inspection.name }))
          }, (reason: unknown) => {
            notify(t('notice.imageFailed', { message: reason instanceof Error ? reason.message : String(reason) }), 'error')
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
    // A file drag (any OS / terminal) often writes the path without
    // bracketed-paste wrappers, so it lands as ordinary insert. If the whole
    // draft is one drop path, attach it the same way a copied pathname paste
    // would.
    const dropped = parsePastedAttachmentPaths(edit.value)
    if (dropped.images.length > 0 || dropped.files.length > 0) {
      valueRef.current = ''
      cursorRef.current = 0
      setValue('')
      setCursor(0)
      insertDroppedAttachments(dropped.images, dropped.files)
    }
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
    notify(t('notice.imageCancelled'), 'warning')
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
        notify(t('notice.permissionChangeFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
      }
      return
    }
    // Tab on an EMPTY composer picks how the next submission is delivered:
    // queue for the next turn, or steer into the turn already running. With a
    // draft present Tab stays the completion key (handled with the menu
    // below), so this only claims the keypress when nothing is being typed.
    if (key.tab && liveValue === '' && !menuActive) {
      cycleSubmitMode()
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
      if (busy) notify(t('notice.cancelBeforeExit'), 'warning')
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
        updateQueued?.(queued[queued.length - 1].messageId, { kind: 'remove' })
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
        // Accepting can be a no-op: the menu is open with no matches yet, the
        // slash line already spells its candidate, or a mention insertion
        // repeats the token already in the draft. Enter must reach the submit
        // path in every one of those cases, or the message cannot be sent.
        const highlighted = highlightedCompletion()
        const repeatsToken = mentionActive && mentionToken !== undefined && cursor === liveValue.length
          && liveValue.slice(mentionToken.start, cursor) === highlighted
        // The slash rule is a whole-list exact match, not a highlighted-row
        // comparison: typing `/mode` once the list is open must run the
        // command even when the highlight happens to rest on `/model`.
        const exactSlash = !mentionActive && candidates.some(candidate => candidate.label === liveValue)
        const acceptNoop = highlighted === '' || repeatsToken || exactSlash
        if (!acceptNoop) {
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
        if (isSlashLine(text)) notify(t('notice.commandAttachments'), 'warning')
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
          if (submitMode === 'steer') steer(text, blocks, originSession)
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
          error => notify(t('notice.copyFailed', { message: error instanceof Error ? error.message : String(error) }), 'error'),
        )
        return
      }
      if (text === '/diff' || text.startsWith('/diff ')) {
        openDiff(text.slice(5))
        return
      }
      if (text === '/review' || text.startsWith('/review ')) {
        const argument = text.slice(7).trim()
        if (argument === '') {
          openReviewPicker()
          return
        }
        try {
          reviewChanges(parseReviewArgument(argument))
        } catch (error: unknown) {
          notify(error instanceof Error ? error.message : String(error), 'warning')
        }
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
      if (text === '/search' || text.startsWith('/search ')) {
        openSearch(text.slice(7).trim())
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
      if (text === '/language' || text.startsWith('/language ')) {
        const argument = text.slice('/language'.length).trim()
        if (argument === '') openLanguage()
        else if (argument === 'en' || argument === 'zh') {
          saveLanguage(parseLanguageName(argument))
          notify(t('notice.languageSaved', { name: argument }))
          refresh()
        } else notify(t('notice.usage.language'), 'warning')
        return
      }
      if (text === '/animation' || text.startsWith('/animation ')) {
        const parsed = parseAnimationsArgument(text.slice('/animation'.length))
        if (parsed === 'toggle') applyAnimations(!animations)
        else if (parsed === 'usage') notify(t('notice.usage.animation'), 'info')
        else applyAnimations(parsed.enabled)
        return
      }
      if (text === '/rainbow' || text.startsWith('/rainbow ')) {
        const parsed = parseRainbowArgument(text.slice('/rainbow'.length))
        if (parsed === 'usage') notify(t('notice.usage.rainbow'), 'warning')
        else applyRainbow(parsed === 'random' ? undefined : parsed.seed)
        return
      }
      if (text === '/history') {
        openHistory()
        return
      }
      if (text === '/queue') {
        openQueue()
        return
      }
      if (text === '/usage') {
        openUsage()
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
      const slash = slashNameAndArgs(text)
      if (slash !== undefined && BARE_LOCAL_COMMANDS.has(slash.name) && slash.args !== '') {
        notify(t('notice.usage.bareCommand', { name: slash.name }), 'warning')
        return
      }
      // Delivery mode: everything above this point is a local command or a
      // panel opener and always runs out of band. A real prompt follows the
      // composer's Tab choice — `steer` joins the running turn, the default
      // queues it for the next one.
      if (submitMode === 'steer') steer(text)
      else dispatch(text)
      return
    }
    // The modified-Enter newline family: Ctrl+J arrives as a bare LF (Ink
    // names it 'enter', not 'return'), and the kitty layer normalizes
    // Ctrl/Shift+Enter to the same byte. Alt+Enter reaches here as a bare CR
    // with no flags — Ink's parser drops the escape and reports no meta, and
    // plain Enter always carries key.return — so a flagless CR is Alt+Enter.
    // Only plain Enter submits. app.spec's "modified-Enter family" test pins
    // this exact parser shape; an Ink upgrade that changes it fails there.
    if (input === '\n' || input === '\r') {
      applyEdit(insertText(liveValue, liveCursor, '\n'))
      return
    }
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
      setCompletionIndex(index => stepCompletionIndex(index, -1, menuRows.length))
      return
    }
    if (menuActive && key.downArrow) {
      setCompletionIndex(index => stepCompletionIndex(index, 1, menuRows.length))
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
      // Bracketed-paste wrappers arrive as escape sequences Ink has stripped
      // only ONE leading ESC from, so the tail marker still carries its own:
      // strip both spellings before the payload is read, or a dragged path
      // reaches the attachment parser with a trailing control byte and fails.
      // Markers may ride their own chunk or the edges of a content chunk; the
      // open-paste flag is tracked so a chunk that is exactly LF inserts
      // instead of submitting.
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
      }
      if (text.includes(PASTE_END_MARKER)) {
        pasteBracketRef.current = false
        pasteBracketCancelRef.current?.()
      }
      text = stripPasteMarkers(text)
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
  const burstKey = rainbowBurstId > 0 ? `rainbow:${rainbowBurstId}` : null
  const [burstPlayedKey, setBurstPlayedKey] = useState<string | null>(null)
  useEffect(() => {
    if (!animations && burstKey !== null && burstKey !== burstPlayedKey) setBurstPlayedKey(burstKey)
  }, [animations, burstKey, burstPlayedKey])
  const burstArmed = burstKey !== null && burstKey !== burstPlayedKey

  // Every exclusive panel keeps the composer as a stable visual anchor, but
  // freezes it to one row: no menu, multiline wrap, or animation.
  const tierActive = waveTier !== null
  const tierHues = waveTier === null ? null : deepseekWaveHues(waveTier)
  const promptColor = tierHues === null ? inkColor(getPalette().brand) : inkColor(tierHues[0])
  const waveGlyph = waveTier === 'flash' ? '›' : waveTier === 'deepseek' ? '»' : '❯'
  // Steer mode owns the prompt glyph in every paint path (static band, wave,
  // rainbow burst), so the mode is visible without reading the placeholder.
  const promptGlyph = submitMode === 'steer' ? '↳' : waveGlyph
  const placeholderText = composerPlaceholder(submitMode)
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
    return () => {
      if (menuHeightRows !== 0) onMenuRows(0)
    }
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
      createElement(Text, { color: promptColor, bold: tierActive ? true : undefined }, submitMode === 'steer' ? '↳ ' : busy ? '… ' : `${promptGlyph} `),
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
    const row = editorViewModel.rows[index]
    const parts = editorRowParts(row, index, caret.row, clampedCursor, !preparingImages)
    const placeholder = index === 0 && value === '' && !busy && !preparingImages
    const tail = placeholder ? placeholderText : parts.after
    const consumed = 2 + visibleColumns(parts.before) + visibleColumns(parts.caret) + visibleColumns(tail)
    editorRows.push(createElement(
      Text,
      { key: index, backgroundColor: bandBg, wrap: 'truncate-end' },
      index === 0
        ? preparingImages
          ? createElement(Text, { color: inkColor(getPalette().warn), bold: true }, '… ')
          : submitMode === 'steer'
            ? createElement(Text, { color: promptColor, bold: true }, '↳ ')
            : busy
              ? createElement(BusyChase, { animated: animations })
              : createElement(Text, { color: promptColor, bold: tierActive ? true : undefined }, `${promptGlyph} `)
        : '  ',
      parts.before,
      parts.hasCaret
        ? createElement(Text, { key: 'caret', inverse: cursorVisible || undefined }, parts.caret)
        : null,
      placeholder
        ? createElement(Text, { dimColor: true }, tail)
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
    burstArmed
      ? createElement(ComposerRainbowBurst, {
        key: burstKey,
        active: !busy && !preparingImages && animations,
        onSettled: () => {
          if (burstKey !== null) setBurstPlayedKey(burstKey)
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
        placeholder: placeholderText,
        promptColor,
      })
      : createElement(ComposerWave, {
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
        placeholder: placeholderText,
        promptColor,
      }),
  )
}

/** One cached settled row: the row Box plus its roomy-prompt spacers. */
