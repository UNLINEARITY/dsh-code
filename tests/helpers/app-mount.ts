/** Shared App-level TTY harness, props doubles, and stream fixtures. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import chalk from 'chalk'
import { createElement } from 'react'
import { render } from 'ink'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createToolResultMessage, createUserMessage, type ImageBlock, type ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import { App, computeSettledRows, headerPhysicalRows, queuedInboxRows, streamTailBodyColumns, type AppProps } from '../../src/app.ts'
import { stepCompletionIndex } from '../../src/completion.ts'
import { createSplitStdin } from '../../src/input-split.ts'
import { createTranscriptStore, type TranscriptStore } from '../../src/session/store.ts'
import type { TranscriptEntry } from '../../src/render/projection.ts'
import { DEFAULT_STATUSLINE_ITEMS } from '../../src/render/status.ts'
import { DEFAULT_TERMINAL_TITLE } from '../../src/ui/terminal-title.ts'
import { DARK_PALETTE, rowBackground, setTheme } from '../../src/theme.ts'
import { DSH_CODE_VERSION, _resetDshKernelVersionForTests } from '../../src/version.ts'
import type { PendingQuestion, QuestionSnapshot } from '../../src/questions.ts'

export type {
  TtyHarness,
}

export type {
  AppProps,
  ImageBlock,
  PendingQuestion,
  QuestionSnapshot,
  SessionEvent,
  TodoItem,
  ToolCallId,
  TranscriptEntry,
  TranscriptStore,
  UserMessage,
}

export {
  App,
  AttachmentId,
  DARK_PALETTE,
  DEFAULT_STATUSLINE_ITEMS,
  DEFAULT_TERMINAL_TITLE,
  DSH_CODE_VERSION,
  PassThrough,
  _resetDshKernelVersionForTests,
  chalk,
  computeSettledRows,
  headerPhysicalRows,
  createAssistantMessage,
  createElement,
  createSplitStdin,
  createToolResultMessage,
  createTranscriptStore,
  createUserMessage,
  join,
  mkdirSync,
  mkdtempSync,
  queuedInboxRows,
  render,
  rmSync,
  rowBackground,
  setTheme,
  stepCompletionIndex,
  streamTailBodyColumns,
  tmpdir,
  writeFileSync,
}

/** App-level Ctrl+O rendering regression over real Node streams. */
/**
 * Drive one live assistant attempt through the store exactly the runner does
 * (session-log v2+: durable logs are settlement-only; live typing rides the
 * process-local assistant-stream frames).
 */
export function applyStreamDeltas(
  store: TranscriptStore,
  turn: number,
  step: number,
  deltas: ReadonlyArray<{ kind: 'text' | 'reasoning'; text: string; time?: number }>,
): void {
  const attemptId = `attempt-${turn}-${step}` as never
  store.applyStreamFrame({ type: 'start', attemptId, revision: 1, turn, step })
  let index = 0
  for (const delta of deltas) {
    store.applyStreamFrame({
      type: 'chunk',
      attemptId,
      revision: 1,
      index: index++,
      time: delta.time ?? 0,
      chunk: delta.kind === 'text'
        ? { type: 'text-delta', index: 0, text: delta.text }
        : { type: 'reasoning-delta', index: 0, text: delta.text },
    } as never)
  }
}
export const wait = async (ms = 100): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
export const resizeClear = '\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H'
// The composer band's resting background (dark palette): every frame may
// carry it. A WAVE background is any OTHER truecolor 48;2 triple.
export const bandBgSeq = `48;2;${DARK_PALETTE.composerBand[0]};${DARK_PALETTE.composerBand[1]};${DARK_PALETTE.composerBand[2]}`
export const waveBgCount = (text: string): number =>
  (text.match(/48;2;\d{1,3};\d{1,3};\d{1,3}/g) ?? []).filter(seq => seq !== bandBgSeq).length
// useSyncExternalStore compares getSnapshot results by identity: these
// doubles must return one frozen object forever, or React spins into an
// infinite re-render loop (Maximum update depth exceeded).
export const approvalSnapshot = Object.freeze({ pending: undefined, answered: false, queued: 0 })
export const questionSnapshot = Object.freeze({ pending: undefined })
export const unsubscribe = (): void => {}
export const noop = (): void => {}
/** Shared identity-stable empty subagent feed snapshot (getSnapshot contract). */
export const EMPTY_AGENTS = Object.freeze([])
/** One TTY harness: the PassThrough streams Ink renders through plus the
 * accumulated stdout bytes. */
interface TtyHarness {
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  output: { text: string }
}
/** Build the real-ink TTY streams the App tests render through. */
export function createTty(columns = 100, rows = 24): TtyHarness {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(value: boolean) {
      this.isRaw = value
      return this
    },
    ref() {},
    unref() {},
  }) as unknown as NodeJS.ReadStream
  const stdout = Object.assign(new PassThrough(), {
    isTTY: true,
    columns,
    rows,
  }) as unknown as NodeJS.WriteStream
  const output = { text: '' }
  stdout.on('data', chunk => {
    output.text += chunk.toString()
  })
  return { stdin, stdout, output }
}
/** The shared App props with inert doubles; override per test. */
export function appProps(overrides: Partial<AppProps> = {}): AppProps {
  return {
    store: createTranscriptStore(),
    subagents: { subscribe: () => unsubscribe, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
    approval: { subscribe: () => unsubscribe, getSnapshot: () => approvalSnapshot },
    questions: {
      subscribe: () => unsubscribe,
      getSnapshot: () => questionSnapshot,
      submit: noop,
      cancel: noop,
    },
    commands: { descriptors: [], subscribe: () => unsubscribe, setAgent: noop },
    skills: { rows: [], subscribe: () => unsubscribe, setAgent: noop },
    model: 'test/model',
    cwd: 'dsh-cli',
    workspaceRoot: 'C:\\repo\\dsh-cli',
    branch: 'main',
    sessionId: '12345678',
    sessionKey: 'session-12345678',
    resumed: false,
    mode: 'standard',
    permission: 'workspace-write',
    dispatch: noop,
    steer: noop,
    interrupt: () => false,
    quit: noop,
    loadModels: async () => ({ rows: [], failures: [] }),
    loadMentions: async () => [],
    inspectImages: async () => [],
    prepareImages: async () => [],
    inspectFiles: async () => [],
    prepareFiles: async () => [],
    selectModel: () => 'test/model',
    subagentModel: '',
    setSubagentModel: () => '',
    clearSubagentModel: noop,
    deleteSession: async () => '',
    cycleMode: () => '',
    setPermission: id => id,
    exportTranscript: async () => {},
    renameTitle: () => '',
    copyLastResponse: async () => '',
    loadGitDiff: async () => ({ title: 'git diff', files: [] }),
    reviewChanges: noop,
    loadPresets: async () => [],
    loadPermissions: async () => [],
    switchMode: async id => id,
    createSession: noop,
    forkSession: noop,
    loadSessions: async () => [],
    loadSubagents: async () => [],
    loadSessionTranscript: async () => '',
    loadUsage: async () => ({ turns: [] }),
    switchSession: noop,
    cancelSessionSwitch: () => false,
    loadPlugins: () => [],
    probeUpdate: () => Promise.reject(new Error('update probe not wired in test')),
    applyUpdate: () => Promise.resolve(0),
    loadJobs: () => [],
    statusline: DEFAULT_STATUSLINE_ITEMS,
    saveStatusline: noop,
    saveLanguage: noop,
    applyEditorKeys: async () => 'ctrl+r passthrough written to test',
    history: [],
    recordHistory: noop,
    updateQueued: noop,
    onBridgeReady: noop,
    ...overrides,
  }
}
/** Render <App> through one TTY harness. */
export function renderApp(harness: TtyHarness, props: AppProps): ReturnType<typeof render> {
  return render(createElement(App, props), {
    stdin: harness.stdin,
    stdout: harness.stdout,
    stderr: harness.stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  })
}
/** One settled assistant entry (pure-cache fixture). */
export function assistantEntry(text: string, reasoning = ''): TranscriptEntry {
  return { kind: 'assistant', text, reasoning }
}
