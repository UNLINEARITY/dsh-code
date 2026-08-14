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
  createElement, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement,
} from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import { assertNever } from '@deepseek-ai/dsh-llm'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import type { TodoItem } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionAnswerItem } from '@deepseek-ai/dsh-user-questions'
import { TUI_RGB, brand, dim, error as paintError, warn } from './theme.ts'
import { WHALE_GLYPH, WHALE_GLYPH_COLUMNS } from './whale-glyph.ts'
import type { TranscriptStore } from './store.ts'
import type { TranscriptEntry } from './render/projection.ts'
import { renderMarkdown, type MdSegment, visibleColumns } from './render/markdown.ts'
import type { ToolDetail } from './render/tool-detail.ts'
import { caretVisible, pulseFrame } from './render/animations.ts'
import type { ApprovalStore } from './approval.ts'
import type { CommandsView } from './commands.ts'
import type { ModelDirectory, ModelRow } from './models.ts'
import type { QuestionStore } from './questions.ts'
import type { SkillsView, SkillRow } from './skills.ts'
import type { MentionCandidate } from './mentions.ts'
import { buildStatusGroups, formatTokens, type StatusFacts } from './render/status.ts'
import { displayText } from './render/text.ts'

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
  /** Git branch name, empty outside a repository. */
  branch: string
  /** Short session identifier. */
  sessionId: string
  /** Whether this session was resumed from persistence. */
  resumed: boolean
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
  /** Registers the app's notice channel with the runner (called once on mount). */
  onBridgeReady(bridge: { notify(text: string): void }): void
}

/** Ink `color` string for one palette triple. */
function inkColor(triple: readonly [number, number, number]): string {
  return `rgb(${triple[0]}, ${triple[1]}, ${triple[2]})`
}

/** Truncate text to a visible-column budget, appending … when cut. */
function truncateColumns(text: string, max: number): string {
  let columns = 0
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const width = code > 0x2e7f ? 2 : 1
    if (columns + width > max) return `${out}…`
    out += char
    columns += width
  }
  return out
}

/** Pad text with spaces to a visible-column target (menu name column). */
function padColumns(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleColumns(text)))
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
      ...line.segments.map((segment, at) => createElement(Text, { key: at, ...segmentProps(segment.style) }, segment.text)),
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
          createElement(Text, { dimColor: true }, `  ── ${displayText(diff.path)}${diff.truncated ? ' (diff truncated)' : ''}`),
          ...diff.lines.map((line, at) => createElement(
            Text,
            {
              key: at,
              color: line.mark === '+' ? inkColor(TUI_RGB.success) : line.mark === '-' ? inkColor(TUI_RGB.error) : inkColor(TUI_RGB.dim),
            },
            `  ${line.mark}${displayText(line.text)}`,
          )),
        )),
      )
    case 'read':
      return createElement(
        Box,
        { flexDirection: 'column' },
        createElement(Text, { dimColor: true }, `  ── ${displayText(detail.path)} · lines ${detail.offset}-${detail.lines.length > 0 ? detail.lines[detail.lines.length - 1]!.number : detail.offset - 1} of ${detail.totalLines}${detail.truncated ? ' (window truncated)' : ''}`),
        ...detail.lines.map((line, at) => createElement(
          Text,
          { key: at, dimColor: true },
          `  ${String(line.number).padStart(5, ' ')} | ${displayText(line.text)}`,
        )),
      )
    case 'web-search':
      return createElement(
        Box,
        { flexDirection: 'column' },
        ...detail.sources.map((source, at) => createElement(
          Text,
          { key: at },
          brand(`  ? ${displayText(source.title === undefined ? source.url : source.title)}`),
          createElement(Text, { dimColor: true }, dim(` - ${displayText(source.url)}`)),
        )),
        createElement(Text, { dimColor: true }, dim(`  ${detail.sources.length} sources${detail.truncated ? ' (capped)' : ''}`)),
      )
    case 'web-fetch':
      return createElement(Text, { dimColor: true }, dim(`  ${displayText(detail.url)} · HTTP ${detail.statusCode}`))
    case 'raw':
      return createElement(
        Box,
        { flexDirection: 'column' },
        ...displayText(detail.text).split('\n').slice(0, 40).map((line, at) => createElement(Text, { key: at, dimColor: true }, `  ${line}`)),
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
          null,
          mark,
          ' ',
          brand(entry.name),
          entry.preview === '' ? '' : ` ${dim(displayText(entry.preview))}`,
        ),
        entry.summary === ''
          ? undefined
          : createElement(
            Text,
            { color: entry.state === 'error' ? inkColor(TUI_RGB.error) : inkColor(TUI_RGB.dim) },
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
          null,
          mark,
          ' ',
          brand(`/${entry.name}`),
          entry.args === '' ? '' : ` ${dim(displayText(entry.args))}`,
        ),
        entry.summary === ''
          ? undefined
          : createElement(Text, { color: inkColor(TUI_RGB.dim) }, `  ⎿ ${displayText(entry.summary)}`),
      )
    }
    case 'turn-marker':
      // Non-error turn outcomes (cancel, ceiling, interruption) as dim rows.
      return createElement(Text, { dimColor: true }, `  ⏹ ${displayText(entry.text)}`)
    case 'compaction':
      // Completed compaction lifecycle: what it reclaimed, or why it failed.
      return createElement(
        Text,
        { dimColor: true },
        entry.ok
          ? `  ⧉ compacted ~${formatTokens(entry.tokens)} tokens`
          : `  ⧉ compaction failed: ${displayText(entry.error)}`,
      )
    case 'retry':
      // Provider-routed retry: amber while the backoff waits, dim once the
      // next attempt is underway.
      return createElement(
        Text,
        { color: entry.state === 'running' ? inkColor(TUI_RGB.warn) : inkColor(TUI_RGB.dim) },
        `  ↻ retry ${entry.attempt}/${entry.max} · ${displayText(entry.code)} · ${Math.round(entry.delayMs / 100) / 10}s`,
      )
    case 'files': {
      // Turn-tail deliverables: the turn's mutated files (web turnTail chips).
      const shown = entry.paths.slice(0, 3).map(path => displayText(path)).join(' · ')
      const more = entry.paths.length > 3 ? ` (+${entry.paths.length - 3} more)` : ''
      return createElement(Text, { dimColor: true }, `  ⎄ ${shown}${more}`)
    }
    case 'error':
      return createElement(Text, null, paintError(displayText(entry.text)))
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

/** Inline todo list (web TodoPanel's compact terminal form). */
function TodoPanel({ todos }: { todos: readonly TodoItem[] }): ReactElement | undefined {
  if (todos.length === 0) return undefined
  const completed = todos.filter(todo => todo.status === 'completed').length
  const inProgress = todos.filter(todo => todo.status === 'in_progress').length
  const pending = todos.length - completed - inProgress
  return createElement(
    Box,
    { flexDirection: 'column', paddingX: 1, borderStyle: 'round', borderColor: inkColor(TUI_RGB.brandDeep), alignSelf: 'flex-start', marginLeft: 1, marginTop: 1 },
    createElement(
      Text,
      { color: inkColor(TUI_RGB.brand), bold: true },
      `todos ${completed}/${todos.length}`,
      createElement(Text, { dimColor: true }, ` · ${inProgress} active · ${pending} pending`),
    ),
    ...todos.map((todo, index) => createElement(
      Text,
      {
        key: index,
        color: todo.status === 'completed'
          ? inkColor(TUI_RGB.success)
          : todo.status === 'in_progress'
            ? inkColor(TUI_RGB.brandBright)
            : inkColor(TUI_RGB.dim),
      },
      `${todoMark(todo.status)} ${displayText(todo.content)}`,
    )),
  )
}

/**
 * The footer status line: Claude-Code-style identity facts (model, working
 * directory, git branch, session) beside the web composer's session figures
 * (turns/steps, model and tool wall time, cache hit, token totals), joined
 * by brand-colored pipes.
 */
function StatusLine({ facts, stats, busy }: {
  facts: StatusFacts
  stats: Parameters<typeof buildStatusGroups>[1]
  busy: boolean
}): ReactElement {
  const groups = buildStatusGroups(facts, stats)
  const children: ReactElement[] = [
    busy
      ? createElement(Pulse)
      : createElement(Text, { color: inkColor(TUI_RGB.brand) }, '○'),
    createElement(Text, null, ' '),
  ]
  groups.forEach((group, index) => {
    if (index > 0) children.push(createElement(Text, { dimColor: true }, dim(' | ')))
    children.push(createElement(Text, { dimColor: true }, group))
  })
  // Left-aligned status bar; the top margin keeps it clear of the input box.
  return createElement(
    Box,
    { paddingX: 1, marginTop: 1 },
    ...children,
  )
}

/** The y/n approval bar rendered while an approval ask is pending. */
function ApprovalBar({ approval, locked }: { approval: ApprovalStore; locked: boolean }): ReactElement | undefined {
  const snapshot = useSyncExternalStore(approval.subscribe, approval.getSnapshot)
  useInput((input) => {
    if (locked || snapshot.pending === undefined || snapshot.answered) return
    if (input === 'y' || input === 'Y') {
      snapshot.pending.answer('allowed-once')
      return
    }
    if (input === 'n' || input === 'N') {
      snapshot.pending.answer('rejected')
    }
  })
  if (snapshot.pending === undefined) return undefined
  const { pending, answered } = snapshot
  return createElement(
    Box,
    { flexDirection: 'column', paddingX: 1, borderStyle: 'round', borderColor: inkColor(TUI_RGB.warn), alignSelf: 'flex-start', marginLeft: 1, marginTop: 1 },
    createElement(Text, { color: inkColor(TUI_RGB.warn), bold: true }, '⏸ waiting for approval'),
    createElement(Text, null, warn(displayText(pending.headline))),
    pending.command === '' ? undefined : createElement(Text, { dimColor: true }, dim(`  ${displayText(pending.command)}`)),
    answered
      ? createElement(Text, { dimColor: true }, '  submitted…')
      : createElement(Text, { dimColor: true }, dim('  y allow once · n reject')),
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
function QuestionBar({ store, locked }: { store: QuestionStore; locked: boolean }): ReactElement | undefined {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const pending = snapshot.pending
  const [index, setIndex] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState<readonly number[]>([])
  const [mode, setMode] = useState<'options' | 'custom'>('options')
  const [custom, setCustom] = useState('')
  const [answers, setAnswers] = useState<readonly AskUserQuestionAnswerItem[]>([])
  const [submitted, setSubmitted] = useState(false)

  // A new request resets the walk; questions without options start in the
  // custom-answer box (a free-form question).
  useEffect(() => {
    const question = pending?.request.questions[0]
    setIndex(0)
    setCursor(0)
    setSelected([])
    setMode(question?.options === undefined || question.options.length === 0 ? 'custom' : 'options')
    setCustom('')
    setAnswers([])
    setSubmitted(false)
  }, [pending])

  const question = pending?.request.questions[index]
  const options = question?.options ?? []
  const isPlan = question?.intent?.kind === 'plan-review'
  const isMulti = question?.multiSelect === true

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
    setIndex(index + 1)
    setCursor(0)
    setSelected([])
    setMode('options')
    setCustom('')
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

  useInput((input, key) => {
    if (locked || pending === undefined || question === undefined || submitted) return
    if (key.escape) {
      store.cancel(pending)
      return
    }
    if (mode === 'custom' || options.length === 0) {
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
      if (key.backspace) {
        setCustom(current => current.slice(0, -1))
        return
      }
      if (input !== '' && !key.ctrl && !key.meta) {
        setCustom(current => current + input)
      }
      return
    }
    if (key.upArrow) {
      setCursor(current => (current + options.length - 1) % options.length)
      return
    }
    if (key.downArrow) {
      setCursor(current => (current + 1) % options.length)
      return
    }
    if (key.return) {
      commitOption()
      return
    }
    if (key.tab || input === 'c' || input === 'C') {
      setMode('custom')
      return
    }
    if (input === ' ' && isMulti) {
      setSelected(current => current.includes(cursor) ? current.filter(at => at !== cursor) : [...current, cursor])
    }
  })

  if (pending === undefined || question === undefined) return undefined
  return createElement(
    Box,
    { flexDirection: 'column', paddingX: 1, borderStyle: 'round', borderColor: inkColor(isPlan ? TUI_RGB.brand : TUI_RGB.brandDeep), alignSelf: 'flex-start', marginLeft: 1, marginTop: 1 },
    createElement(
      Text,
      { color: inkColor(isPlan ? TUI_RGB.brand : TUI_RGB.brandDeep), bold: true },
      isPlan ? `📋 plan review (${index + 1}/${pending.request.questions.length})` : `❓ question ${index + 1}/${pending.request.questions.length}`,
    ),
    question.header === undefined ? undefined : createElement(Text, { bold: true }, displayText(question.header)),
    createElement(Text, null, displayText(question.question)),
    question.detail === undefined
      ? undefined
      : isPlan
        ? createElement(MarkdownBody, { text: question.detail })
        : createElement(Text, { dimColor: true }, displayText(question.detail)),
    submitted
      ? createElement(Text, { dimColor: true }, '  submitted…')
      : createElement(
        Box,
        { flexDirection: 'column', marginLeft: 1 },
        ...(mode === 'custom' || options.length === 0
          ? [
            createElement(Text, { color: inkColor(TUI_RGB.brandBright) }, `  custom: ${custom}${submitted ? '' : '▌'}`),
            createElement(Text, { dimColor: true }, dim('  type your answer · enter submit · esc interrupt')),
          ]
          : options.map((option, at) => {
            const chosen = isMulti && selected.includes(at)
            const approve = isPlan && question.intent?.approve === option.label
            const mark = approve ? '✓ ' : chosen ? '◉ ' : at === cursor ? '❯ ' : '  '
            return createElement(
              Text,
              {
                key: at,
                color: at === cursor ? inkColor(TUI_RGB.brandBright) : chosen || approve ? inkColor(TUI_RGB.success) : inkColor(TUI_RGB.text),
              },
              `${mark}${displayText(option.label)}${option.description === undefined ? '' : dim(` — ${displayText(option.description)}`)}`,
            )
          })),
        createElement(Text, { dimColor: true }, dim(isMulti
          ? '  ↑↓ move · space toggle · enter submit · c custom · esc interrupt'
          : '  ↑↓ move · enter submit · c custom · esc interrupt')),
      ),
  )
}

/** The /model panel: a scrolling list over the advisory model directory. */
function ModelPanel({ directory, error, onSelect, onClose }: {
  directory: ModelDirectory | undefined
  error: string | undefined
  onSelect(row: ModelRow): void
  onClose(): void
}): ReactElement {
  const [cursor, setCursor] = useState(0)
  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose()
      return
    }
    const rows = directory?.rows ?? []
    if (key.upArrow) {
      setCursor(cursor > 0 ? cursor - 1 : rows.length - 1)
      return
    }
    if (key.downArrow) {
      setCursor(cursor < rows.length - 1 ? cursor + 1 : 0)
      return
    }
    if (key.return && rows[cursor] !== undefined) {
      onSelect(rows[cursor])
    }
  })
  const rows = directory?.rows ?? []
  const window = 8
  const first = Math.max(0, Math.min(cursor - Math.floor(window / 2), rows.length - window))
  const visible = rows.slice(Math.max(0, first), Math.max(0, first) + window)
  return createElement(
    Box,
    { flexDirection: 'column', paddingX: 1, borderStyle: 'round', borderColor: inkColor(TUI_RGB.brand), alignSelf: 'flex-start', marginLeft: 1, marginTop: 1 },
    createElement(Text, { color: inkColor(TUI_RGB.brand), bold: true }, '/model — select the model for the next step'),
    directory === undefined && error === undefined
      ? createElement(Text, { dimColor: true }, '  loading models…')
      : undefined,
    error !== undefined
      ? createElement(Text, { color: inkColor(TUI_RGB.error) }, `  ${error}`)
      : undefined,
    ...visible.map((row) => {
      const index = rows.indexOf(row)
      const label = displayText(`${row.providerName} · ${row.modelName}`)
      return createElement(
        Text,
        {
          key: `${row.provider}/${row.model}`,
          color: index === cursor ? inkColor(TUI_RGB.brandBright) : inkColor(TUI_RGB.dim),
        },
        `${index === cursor ? '❯ ' : '  '}${label}`,
      )
    }),
    createElement(Text, { dimColor: true }, dim('  ↑↓ move · enter select · esc close')),
  )
}

/**
 * The /help overlay: one scrolling card with the keyboard map, the TUI-local
 * commands, the live registry commands, and the user-invocable skills — the
 * real command surface, replacing the one-line notice.
 */
function HelpPanel({ descriptors, skills, onClose }: {
  descriptors: readonly CommandDescriptor[]
  skills: readonly SkillRow[]
  onClose(): void
}): ReactElement {
  useInput((input, key) => {
    if (key.escape || input === 'q') onClose()
  })
  const columns = useStdout().stdout?.columns ?? 80
  const nameWidth = 18
  const descBudget = Math.max(24, columns - nameWidth - 8)
  const row = (label: string, description: string): ReactElement => createElement(
    Text,
    { dimColor: true },
    `  ${padColumns(label, nameWidth)}${dim(truncateColumns(displayText(description), descBudget))}`,
  )
  const registryWindow = descriptors.slice(0, 8)
  const skillWindow = skills.slice(0, 6)
  return createElement(
    Box,
    { flexDirection: 'column', paddingX: 1, borderStyle: 'round', borderColor: inkColor(TUI_RGB.brand), alignSelf: 'flex-start', marginLeft: 1, marginTop: 1 },
    createElement(Text, { color: inkColor(TUI_RGB.brand), bold: true }, '/help — keys and commands'),
    createElement(Text, { bold: true }, ' keys'),
    createElement(Text, { dimColor: true }, '  enter submit · alt+enter / ctrl+j newline · up/down history · tab complete'),
    createElement(Text, { dimColor: true }, '  tab also completes bare workspace paths · @ mentions files and sessions'),
    createElement(Text, { dimColor: true }, '  ctrl+o verbose transcript · ctrl+r thinking · shift+tab permission preset'),
    createElement(Text, { dimColor: true }, '  esc interrupt the running turn · ctrl+c cancel / clear / quit · ctrl+d exit'),
    createElement(Text, { dimColor: true }, '  ctrl+k cut to end of line · ctrl+u clear line · ctrl+a / ctrl+e line ends'),
    createElement(Text, { bold: true }, ' commands'),
    row('/help', 'show this overlay'),
    row('/model', 'switch the model'),
    row('/clear', 'clear the screen'),
    row('/export', 'export the transcript to markdown (/export [path])'),
    row('/title', 'rename this session (/title <text>)'),
    row('/quit', 'exit'),
    ...registryWindow.map(descriptor => createElement(
      Text,
      { key: descriptor.name, dimColor: true },
      `  ${padColumns(`/${descriptor.name}`, nameWidth)}${dim(truncateColumns(displayText(descriptor.description), descBudget))}`,
    )),
    descriptors.length > registryWindow.length
      ? createElement(Text, { dimColor: true }, `  … ${descriptors.length - registryWindow.length} more — type / in the input for the live menu`)
      : undefined,
    skillWindow.length > 0 ? createElement(Text, { bold: true }, ' skills') : undefined,
    ...skillWindow.map(skill => createElement(
      Text,
      { key: skill.name, dimColor: true },
      `  ${padColumns(`/${skill.name}`, nameWidth)}${dim(truncateColumns(displayText(skill.description), descBudget))}`,
    )),
    skills.length > skillWindow.length
      ? createElement(Text, { dimColor: true }, `  … ${skills.length - skillWindow.length} more`)
      : undefined,
    createElement(Text, { dimColor: true }, dim('  esc or q close')),
  )
}

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
  if (prefix === '') return all.slice(0, 10)
  return all.filter(candidate => candidate.label.slice(1).startsWith(prefix)).slice(0, 10)
}

/** The completion menu snapshot the input editor publishes to the app. */
export interface MenuState {
  /** Whether the menu is on screen (slash or @mention). */
  active: boolean
  /** Whether the menu is driven by an @mention token. */
  mention: boolean
  /** Highlighted candidate index (wraps by row count). */
  index: number
  /** Rendered rows in display order. */
  rows: readonly CompletionCandidate[]
}

/**
 * The completion menu, rendered after the status line — the very last
 * element in the tree. Being last in the layout flow, opening or closing it
 * moves nothing above it: the transcript, input box, and status line all
 * stay put (the Claude-Code dropdown treatment adapted to Ink, whose
 * absolute positioning cannot place children above their parent).
 */
function CompletionMenu({ state }: { state: MenuState }): ReactElement | undefined {
  if (!state.active) return undefined
  const columns = useStdout().stdout?.columns ?? 80
  const nameWidth = Math.min(18, Math.max(0, ...state.rows.map(row => visibleColumns(row.label))) + 2)
  const descBudget = Math.max(24, columns - nameWidth - 8)
  return createElement(
    Box,
    { flexDirection: 'column', marginTop: 1, marginLeft: 2 },
    ...(state.rows.length === 0
      ? [createElement(Text, { key: 'loading', dimColor: true }, 'searching…')]
      : state.rows.map((candidate, index) => createElement(
        Text,
        {
          key: candidate.label,
          color: index === state.index % state.rows.length ? inkColor(TUI_RGB.brandBright) : inkColor(TUI_RGB.dim),
        },
        `${index === state.index % state.rows.length ? '❯ ' : '  '}${padColumns(candidate.label, nameWidth)}${dim(truncateColumns(displayText(candidate.description), descBudget))}`,
      ))),
    createElement(Text, { dimColor: true }, dim(state.mention ? '↑↓ choose · tab insert' : '↑↓ choose · tab complete')),
  )
}

/**
 * The prompt box: TUI-local slash commands handled locally, other lines
 * dispatched; input editing keeps a cursor with history and completion.
 * While a modal (approval / question / model panel) owns the keys, the
 * box passes every key through untouched.
 */
function Input({ active, busy, descriptors, skills, dispatch, steer, interrupt, quit, openModel, openHelp, notify, toggleReasoning, toggleVerbose, loadMentions, cyclePermission, exportTranscript, renameTitle, onMenuState }: {
  active: boolean
  busy: boolean
  descriptors: readonly CommandDescriptor[]
  skills: readonly SkillRow[]
  dispatch(text: string): void
  steer(text: string): void
  interrupt(): boolean
  quit(): void
  openModel(): void
  openHelp(): void
  notify(text: string): void
  toggleReasoning(): void
  toggleVerbose(): void
  loadMentions(query: string, signal?: AbortSignal): Promise<readonly MentionCandidate[]>
  cyclePermission(): string
  exportTranscript(argument: string): Promise<void>
  renameTitle(argument: string): string
  onMenuState(state: MenuState): void
}): ReactElement {
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const history = useRef<readonly string[]>([])
  const historyIndex = useRef<number | null>(null)
  const draft = useRef('')
  const [completionIndex, setCompletionIndex] = useState(0)
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
  // when it already looks like a path (Claude-Code bare Tab completion).
  const bareTokenMatch = /([^\s]+)$/u.exec(lastLine)
  const bareToken = bareTokenMatch === null ? '' : bareTokenMatch[1] ?? ''
  const pathActive = !mentionActive
    && (bareToken.includes('/') || bareToken === '.' || bareToken === '..')
  const pathTokenStart = beforeCursor.length - bareToken.length
  const [pathRows, setPathRows] = useState<readonly MentionCandidate[]>([])

  useEffect(() => {
    if (!pathActive) {
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
  }, [pathActive, bareToken])

  useEffect(() => {
    if (!mentionActive) {
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
  }, [mentionActive, mentionToken?.query])

  const menuActive = (slashActive || mentionActive || pathActive) && !busy
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

  // The menu renders at the very bottom of the app (after the status line),
  // where opening it moves nothing above it — the App needs this snapshot.
  // Notify only on change; an unconditional set would re-render in a loop.
  const menuStateKey = useRef('')
  useEffect(() => {
    const key = JSON.stringify([menuActive, mentionActive, completionIndex, menuRows.map(row => row.label)])
    if (key === menuStateKey.current) return
    menuStateKey.current = key
    onMenuState({
      active: menuActive,
      mention: mentionActive,
      index: completionIndex,
      rows: menuRows,
    })
  }, [menuActive, mentionActive, completionIndex, menuRows, onMenuState])

  useInput((input, key) => {
    // Modal ownership: approval/question/model dialogs consume all keys.
    if (!active) return
    // Shift+Tab cycles the permission preset (Claude-Code convention).
    if (key.tab && key.shift) {
      const next = cyclePermission()
      if (next !== '') notify(`permission → ${next}`)
      return
    }
    // Ctrl+R toggles the thinking display (Claude-Code reasoning fold).
    if (key.ctrl && input === 'r') {
      toggleReasoning()
      return
    }
    // Ctrl+O toggles the verbose transcript (Claude-Code convention): tool
    // cards expand to their structured presentation bodies.
    if (key.ctrl && input === 'o') {
      toggleVerbose()
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
      } else {
        quit()
      }
      return
    }
    if (key.ctrl && input === 'd') {
      if (busy) notify('cancel the running turn before exiting (Esc or Ctrl+C)')
      else quit()
      return
    }
    if (key.escape) {
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
        return
      }
      const text = value.trim()
      setValue('')
      setCursor(0)
      setCompletionIndex(0)
      if (text === '') return
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
        console.clear()
        return
      }
      if (text === '/export' || text.startsWith('/export ')) {
        void exportTranscript(text.slice(8))
        return
      }
      if (text === '/title' || text.startsWith('/title ')) {
        notify(renameTitle(text.slice(7)))
        return
      }
      if (text === '/model' || text.startsWith('/model ')) {
        openModel()
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
        return
      }
      historyIndex.current = next
      setValue(entries[next] ?? '')
      setCursor((entries[next] ?? '').length)
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
      return
    }
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setValue(value.slice(0, cursor - 1) + value.slice(cursor))
        setCursor(cursor - 1)
        setCompletionIndex(0)
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
      return
    }
    // Readline parity: Ctrl+K cuts from the cursor to the end of the line.
    if (key.ctrl && input === 'k') {
      setValue(value.slice(0, cursor))
      return
    }
    // Ctrl+L refreshes the screen (readline convention; same as /clear).
    if (key.ctrl && input === 'l') {
      console.clear()
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
    }
  })

  return createElement(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    busy && value === ''
      ? createElement(Text, { dimColor: true }, dim('  enter steers the running turn · esc or ctrl+c cancels'))
      : undefined,
    // The framed input box: a visible boundary so the prompt never blends
    // into the transcript above it; the cursor block sits immediately after
    // the prompt marker (leftmost), with the dim placeholder trailing it —
    // no extra space, so the empty state reads `❯ ▮type a message…`.
    createElement(
      Box,
      { borderStyle: 'round', borderColor: inkColor(TUI_RGB.dim), paddingX: 1 },
      createElement(Text, { color: inkColor(TUI_RGB.brand) }, busy ? '… ' : '❯ '),
      value === ''
        ? undefined
        : createElement(Text, null, value.slice(0, cursor)),
      createElement(CursorBlock, { char: value.slice(cursor, cursor + 1) === '' ? ' ' : value.slice(cursor, cursor + 1) }),
      value === '' && !busy
        ? createElement(Text, { dimColor: true }, 'type a message · / commands · @ mentions')
        : createElement(Text, null, value.slice(cursor + 1)),
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
  const [notices, setNotices] = useState<readonly string[]>([])
  const notify = (text: string): void => {
    setNotices(current => [...current, text])
  }

  useEffect(() => {
    props.onBridgeReady({ notify })
  }, [])
  useEffect(() => {
    if (!modelOpen || directory !== undefined) return
    let cancelled = false
    setModelError(undefined)
    props.loadModels().then((loaded) => {
      if (!cancelled) setDirectory(loaded)
    }, (error: unknown) => {
      if (!cancelled) setModelError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
    }
  }, [modelOpen])

  const busy = view.busy
  const [showReasoning, setShowReasoning] = useState(false)
  const [verbose, setVerbose] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [menuState, setMenuState] = useState<MenuState>({ active: false, mention: false, index: 0, rows: [] })
  const approvalSnapshot = useSyncExternalStore(props.approval.subscribe, props.approval.getSnapshot)
  const questionSnapshot = useSyncExternalStore(props.questions.subscribe, props.questions.getSnapshot)
  // While any modal owns the keys, the prompt box passes everything through.
  const inputActive = !modelOpen && !helpOpen && approvalSnapshot.pending === undefined && questionSnapshot.pending === undefined
  // Layered ownership: question > approval > model panel; each bar answers
  // only while no higher-priority modal is on screen.
  const questionPending = questionSnapshot.pending !== undefined
  // Claude-Code spacing: one blank row before each user prompt (except the
  // first) separates replies from the next turn.
  const transcriptRows: ReactElement[] = []
  view.entries.forEach((entry, index) => {
    if (entry.kind === 'user' && index > 0) {
      transcriptRows.push(createElement(Text, { key: `gap-${index}` }, ' '))
    }
    transcriptRows.push(createElement(EntryLine, { key: index, entry, showReasoning, verbose }))
  })
  return createElement(
    Box,
    { flexDirection: 'column' },
    createElement(Header, { resumed: props.resumed }),
    createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      ...transcriptRows,
      view.streamingReasoning !== ''
        ? createElement(
          Text,
          { dimColor: true, italic: true },
          showReasoning ? `  ✻ ${displayText(view.streamingReasoning)}` : '  ✻ Thinking…',
        )
        : undefined,
      view.streaming !== ''
        ? createElement(Text, null, displayText(view.streaming), busy ? createElement(Caret) : undefined)
        : undefined,
      busy && view.streaming === '' && view.streamingReasoning === '' ? createElement(Text, { dimColor: true }, 'Deep diving...') : undefined,
    ),
    createElement(TodoPanel, { todos: view.todos }),
    createElement(QuestionBar, { store: props.questions, locked: modelOpen || helpOpen }),
    createElement(ApprovalBar, { approval: props.approval, locked: modelOpen || helpOpen || questionPending }),
    modelOpen
      ? createElement(ModelPanel, {
        directory,
        error: modelError,
        onSelect: (row: ModelRow) => {
          setModelLabel(props.selectModel(row))
          notify(`model → next step uses ${row.provider}/${row.model}`)
          setModelOpen(false)
        },
        onClose: () => {
          setModelOpen(false)
        },
      })
      : undefined,
    helpOpen
      ? createElement(HelpPanel, {
        descriptors,
        skills,
        onClose: () => {
          setHelpOpen(false)
        },
      })
      : undefined,
    createElement(
      Box,
      { flexDirection: 'column' },
      ...notices.slice(-3).map((notice, index) => createElement(Text, { key: index, dimColor: true }, notice)),
    ),
    createElement(Input, {
      active: inputActive,
      busy,
      descriptors,
      skills,
      dispatch: props.dispatch,
      steer: props.steer,
      interrupt: props.interrupt,
      quit: props.quit,
      openModel: () => {
        setModelOpen(true)
      },
      openHelp: () => {
        setHelpOpen(true)
      },
      notify,
      toggleVerbose: () => {
        notify(verbose ? 'verbose off' : 'verbose on · tool cards expand (ctrl+o)')
        setVerbose(current => !current)
      },
      toggleReasoning: () => {
        setShowReasoning(current => !current)
      },
      loadMentions: props.loadMentions,
      cyclePermission: props.cyclePermission,
      exportTranscript: props.exportTranscript,
      renameTitle: props.renameTitle,
      onMenuState: setMenuState,
    }),
    createElement(StatusLine, {
      facts: {
        model: modelLabel,
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
    }),
    createElement(CompletionMenu, { state: menuState }),
  )
}
