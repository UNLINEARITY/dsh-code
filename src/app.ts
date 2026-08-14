/**
 * The Ink terminal app: whale-and-wordmark header in DeepSeek blue, the live
 * transcript, the streaming line, local notices, and the input box. All state
 * arrives through the transcript store (derived from the durable session log)
 * plus local input state; the app owns no session mutation of its own.
 *
 * Element construction uses `createElement` (not JSX): the `dsh` source launch
 * compiles this file through tsx's ESM-only hook, which does not adopt this
 * package's `jsx: react-jsx` compiler option, and the classic JSX runtime
 * would demand a React global.
 *
 * @module @deepseek-ai/dsh-tui/app
 */

import { createElement, useState, useSyncExternalStore, type ReactElement } from 'react'
import { Box, Text, useInput } from 'ink'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { TUI_RGB, brand, dim, error as paintError } from './theme.ts'
import { WHALE_GLYPH, WHALE_GLYPH_COLUMNS } from './whale-glyph.ts'
import type { TranscriptStore } from './store.ts'
import type { TranscriptEntry } from './render/projection.ts'
import { buildStatusGroups, type StatusFacts } from './render/status.ts'

/** Props the runner hands the app; callbacks stay owned by the runner. */
export interface AppProps {
  /** Event-fed transcript store for the live session. */
  store: TranscriptStore
  /** `provider/model` selection serving this session. */
  model: string
  /** Working-directory basename the session serves. */
  cwd: string
  /** Git branch name, empty outside a repository. */
  branch: string
  /** Short session identifier. */
  sessionId: string
  /** Submit one human prompt; the runner folds it into the session. */
  onSubmit(text: string): void
  /** Quit: unmount, flush, and request process exit. */
  onQuit(): void
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
    case 'error':
      return createElement(Text, null, paintError(entry.text))
    default:
      return assertNever(entry, 'transcript entry kind')
  }
}

/** The whale wordmark header in DeepSeek blue, hugging its content width. */
function Header(): ReactElement {
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
      createElement(Text, { dimColor: true }, '/help commands · Ctrl+C quit'),
    ),
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

/** The prompt box: slash commands handled locally, other text submitted. */
function Input({ busy, onSubmit, onQuit }: {
  busy: boolean
  onSubmit(text: string): void
  onQuit(): void
}): ReactElement {
  const [value, setValue] = useState('')
  const [notices, setNotices] = useState<readonly string[]>([])
  useInput((input, key) => {
    if (key.ctrl && (input === 'c' || input === 'd')) {
      onQuit()
      return
    }
    if (key.return) {
      const text = value.trim()
      setValue('')
      if (text === '') return
      if (text === '/quit') {
        onQuit()
        return
      }
      if (text === '/help') {
        setNotices([...notices, '/help show commands · /clear clear the screen · /quit exit'])
        return
      }
      if (text === '/clear') {
        setNotices([])
        console.clear()
        return
      }
      if (busy) {
        setNotices([...notices, 'the agent is working — wait for the turn to finish'])
        return
      }
      onSubmit(text)
      return
    }
    if (key.backspace || key.delete) {
      setValue(value.slice(0, -1))
      return
    }
    if (input !== '') {
      setValue(value + input)
    }
  })
  return createElement(
    Box,
    { flexDirection: 'column' },
    ...notices.map((notice, index) => createElement(Text, { key: index, dimColor: true }, notice)),
    createElement(
      Box,
      null,
      createElement(Text, { color: inkColor(TUI_RGB.brand) }, busy ? '… ' : '❯ '),
      createElement(Text, null, value),
    ),
  )
}

/** The whole terminal app; state arrives via the store, output via Ink. */
export function App({ store, model, cwd, branch, sessionId, onSubmit, onQuit }: AppProps): ReactElement {
  const view = useSyncExternalStore(store.subscribe, store.getView)
  return createElement(
    Box,
    { flexDirection: 'column' },
    createElement(Header),
    createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      ...view.entries.map((entry, index) => createElement(EntryLine, { key: index, entry })),
      view.streaming !== '' ? createElement(Text, null, view.streaming) : undefined,
      view.busy && view.streaming === '' ? createElement(Text, { dimColor: true }, 'thinking…') : undefined,
    ),
    createElement(Input, { busy: view.busy, onSubmit, onQuit }),
    createElement(StatusLine, {
      facts: { model, cwd, branch, sessionId },
      stats: view.stats,
      busy: view.busy,
    }),
  )
}
