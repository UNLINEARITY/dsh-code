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
  createElement, useEffect, useRef, useState, useSyncExternalStore, type ReactElement,
} from 'react'
import { Box, Text, useInput } from 'ink'
import { assertNever } from '@deepseek-ai/dsh-llm'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import type { TodoItem } from '@deepseek-ai/dsh-session'
import { TUI_RGB, brand, dim, error as paintError, warn } from './theme.ts'
import { WHALE_GLYPH, WHALE_GLYPH_COLUMNS } from './whale-glyph.ts'
import type { TranscriptStore } from './store.ts'
import type { TranscriptEntry } from './render/projection.ts'
import type { ApprovalStore } from './approval.ts'
import type { CommandsView } from './commands.ts'
import type { ModelDirectory, ModelRow } from './models.ts'
import type { SkillsView, SkillRow } from './skills.ts'
import { buildStatusGroups, type StatusFacts } from './render/status.ts'

/** Props the runner hands the app; callbacks stay owned by the runner. */
export interface AppProps {
  /** Event-fed transcript store for the live session. */
  store: TranscriptStore
  /** Approval-question store fed by the answerer listener. */
  approval: ApprovalStore
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
  /** Interrupt the running turn (Esc); true when a turn was cancelled. */
  interrupt(): boolean
  /** Quit: unmount, flush, and request process exit. */
  quit(): void
  /** Load the selectable model directory (called when /model opens). */
  loadModels(): Promise<ModelDirectory>
  /** Apply one /model selection; returns the display label. */
  selectModel(row: ModelRow): string
  /** Registers the app's notice channel with the runner (called once on mount). */
  onBridgeReady(bridge: { notify(text: string): void }): void
}

/** Ink `color` string for one palette triple. */
function inkColor(triple: readonly [number, number, number]): string {
  return `rgb(${triple[0]}, ${triple[1]}, ${triple[2]})`
}

/** One settled transcript row. */
function EntryLine({ entry }: { entry: TranscriptEntry }): ReactElement {
  switch (entry.kind) {
    case 'user':
      return createElement(Text, null, brand('❯ '), entry.text)
    case 'assistant':
      return createElement(Text, null, entry.text)
    case 'tool': {
      const mark = entry.state === 'running'
        ? createElement(Text, { color: inkColor(TUI_RGB.brandBright) }, '◐')
        : entry.state === 'error'
          ? createElement(Text, { color: inkColor(TUI_RGB.error) }, '⨯')
          : createElement(Text, { color: inkColor(TUI_RGB.success) }, '⏺')
      return createElement(
        Text,
        null,
        mark,
        ' ',
        brand(entry.name),
        entry.summary === '' ? '' : ` ${dim(entry.summary)}`,
      )
    }
    case 'command': {
      const mark = entry.state === 'running'
        ? createElement(Text, { color: inkColor(TUI_RGB.brandBright) }, '◐')
        : entry.state === 'error'
          ? createElement(Text, { color: inkColor(TUI_RGB.error) }, '⨯')
          : createElement(Text, { color: inkColor(TUI_RGB.success) }, '⏺')
      return createElement(
        Text,
        null,
        mark,
        ' ',
        brand(`/${entry.name}`),
        entry.args === '' ? '' : ` ${dim(entry.args)}`,
        entry.summary === '' ? '' : ` ${dim(entry.summary)}`,
      )
    }
    case 'error':
      return createElement(Text, null, paintError(entry.text))
    default:
      return assertNever(entry, 'transcript entry kind')
  }
}

/** The whale wordmark header in DeepSeek blue, hugging its content width. */
function Header({ resumed }: { resumed: boolean }): ReactElement {
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
      createElement(
        Text,
        { dimColor: true },
        resumed ? 'resumed session · /help commands · Esc interrupt' : '/help commands · Esc interrupt · Ctrl+C quit',
      ),
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
    { flexDirection: 'column', paddingX: 1, borderStyle: 'round', borderColor: inkColor(TUI_RGB.brandDeep), alignSelf: 'flex-start', marginLeft: 1 },
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
      `${todoMark(todo.status)} ${todo.content}`,
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
      ? createElement(Text, { color: inkColor(TUI_RGB.brandBright) }, '● ')
      : createElement(Text, { color: inkColor(TUI_RGB.brand) }, '○ '),
  ]
  groups.forEach((group, index) => {
    if (index > 0) children.push(createElement(Text, { dimColor: true }, dim(' | ')))
    children.push(createElement(Text, { dimColor: true }, group))
  })
  return createElement(Box, { paddingX: 1 }, ...children)
}

/** The y/n approval bar rendered while an approval ask is pending. */
function ApprovalBar({ approval }: { approval: ApprovalStore }): ReactElement | undefined {
  const snapshot = useSyncExternalStore(approval.subscribe, approval.getSnapshot)
  if (snapshot.pending === undefined) return undefined
  const { pending, answered } = snapshot
  return createElement(
    Box,
    { flexDirection: 'column', paddingX: 1, borderStyle: 'round', borderColor: inkColor(TUI_RGB.warn), alignSelf: 'flex-start', marginLeft: 1 },
    createElement(Text, { color: inkColor(TUI_RGB.warn), bold: true }, '⏸ waiting for approval'),
    createElement(Text, null, warn(pending.headline)),
    pending.command === '' ? undefined : createElement(Text, { dimColor: true }, dim(`  ${pending.command}`)),
    answered
      ? createElement(Text, { dimColor: true }, '  submitted…')
      : createElement(Text, { dimColor: true }, dim('  y allow once · n reject')),
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
    { flexDirection: 'column', paddingX: 1, borderStyle: 'round', borderColor: inkColor(TUI_RGB.brand), alignSelf: 'flex-start', marginLeft: 1 },
    createElement(Text, { color: inkColor(TUI_RGB.brand), bold: true }, '/model — select the model for the next step'),
    directory === undefined && error === undefined
      ? createElement(Text, { dimColor: true }, '  loading models…')
      : undefined,
    error !== undefined
      ? createElement(Text, { color: inkColor(TUI_RGB.error) }, `  ${error}`)
      : undefined,
    ...visible.map((row) => {
      const index = rows.indexOf(row)
      const label = `${row.providerName} · ${row.modelName}`
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

/** One completion candidate row. */
interface CompletionCandidate {
  /** Insertion text for the command name (with leading slash). */
  label: string
  /** Human-readable description shown beside the label. */
  description: string
  /** Candidate origin; skills land the same literal text but route through the prompt. */
  origin: 'command' | 'skill'
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
    { label: '/quit', description: 'exit', origin: 'command' },
  ]
  const registry = descriptors.map((descriptor): CompletionCandidate => ({
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

/**
 * The prompt box: TUI-local slash commands handled locally, other lines
 * dispatched; input editing keeps a cursor with history and completion.
 */
function Input({ busy, descriptors, skills, dispatch, interrupt, quit, openModel, notify }: {
  busy: boolean
  descriptors: readonly CommandDescriptor[]
  skills: readonly SkillRow[]
  dispatch(text: string): void
  interrupt(): boolean
  quit(): void
  openModel(): void
  notify(text: string): void
}): ReactElement {
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const history = useRef<readonly string[]>([])
  const historyIndex = useRef<number | null>(null)
  const draft = useRef('')
  const [completionIndex, setCompletionIndex] = useState(0)
  const candidates = completionCandidates(value, descriptors, skills)
  const completionActive = candidates.length > 0 && value.startsWith('/') && !value.includes(' ') && !value.includes('\n')

  useInput((input, key) => {
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
        notify('/model switch · /clear clear the screen · /quit exit · other /commands reach the registry · Esc or Ctrl+C interrupts the running turn')
        return
      }
      if (text === '/clear') {
        console.clear()
        return
      }
      if (text === '/model' || text.startsWith('/model ')) {
        openModel()
        return
      }
      if (busy) {
        notify('the agent is working — Esc or Ctrl+C interrupts the turn')
        return
      }
      dispatch(text)
      return
    }
    if (completionActive && key.upArrow) {
      setCompletionIndex(index => (index + candidates.length - 1) % candidates.length)
      return
    }
    if (completionActive && key.downArrow) {
      setCompletionIndex(index => (index + 1) % candidates.length)
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
    if (key.tab && completionActive) {
      const candidate = candidates[completionIndex % candidates.length]
      if (candidate !== undefined) {
        setValue(`${candidate.label} `)
        setCursor(candidate.label.length + 1)
        setCompletionIndex(0)
      }
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

  const shown = completionActive && !busy
  return createElement(
    Box,
    { flexDirection: 'column' },
    shown
      ? createElement(
        Box,
        { flexDirection: 'column', marginLeft: 1 },
        ...candidates.map((candidate, index) => createElement(
          Text,
          {
            key: candidate.label,
            color: index === completionIndex % candidates.length ? inkColor(TUI_RGB.brandBright) : inkColor(TUI_RGB.dim),
          },
          `${index === completionIndex % candidates.length ? '❯ ' : '  '}${candidate.label} ${dim(candidate.description)}`,
        )),
        createElement(Text, { dimColor: true }, dim('  ↑↓ choose · tab complete')),
      )
      : undefined,
    createElement(
      Box,
      null,
      createElement(Text, { color: inkColor(TUI_RGB.brand) }, busy ? '… ' : '❯ '),
      createElement(Text, null, value.slice(0, cursor)),
      createElement(Text, { inverse: true }, value.slice(cursor, cursor + 1) === '' ? ' ' : value.slice(cursor, cursor + 1)),
      createElement(Text, null, value.slice(cursor + 1)),
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
  return createElement(
    Box,
    { flexDirection: 'column' },
    createElement(Header, { resumed: props.resumed }),
    createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      ...view.entries.map((entry, index) => createElement(EntryLine, { key: index, entry })),
      view.streaming !== '' ? createElement(Text, null, view.streaming) : undefined,
      busy && view.streaming === '' ? createElement(Text, { dimColor: true }, 'thinking…') : undefined,
    ),
    createElement(TodoPanel, { todos: view.todos }),
    createElement(ApprovalBar, { approval: props.approval }),
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
    createElement(
      Box,
      { flexDirection: 'column' },
      ...notices.slice(-3).map((notice, index) => createElement(Text, { key: index, dimColor: true }, notice)),
    ),
    createElement(Input, {
      busy,
      descriptors,
      skills,
      dispatch: props.dispatch,
      interrupt: props.interrupt,
      quit: props.quit,
      openModel: () => {
        setModelOpen(true)
      },
      notify,
    }),
    createElement(StatusLine, {
      facts: { model: modelLabel, cwd: props.cwd, branch: props.branch, sessionId: props.sessionId },
      stats: view.stats,
      busy,
    }),
  )
}
