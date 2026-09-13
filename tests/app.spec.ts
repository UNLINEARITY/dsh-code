/** App-level Ctrl+O rendering regression over real Node streams. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import chalk from 'chalk'
import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage, type CallId, type ImageBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-session'
import { App, computeSettledRows, type AppProps } from '../src/app.ts'
import { createSplitStdin } from '../src/input-split.ts'
import { createTranscriptStore, type TranscriptStore } from '../src/store.ts'

/**
 * Drive one live assistant attempt through the store exactly the runner does
 * (session-log v2+: durable logs are settlement-only; live typing rides the
 * process-local assistant-stream frames).
 */
function applyStreamDeltas(
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
import type { TranscriptEntry } from '../src/render/projection.ts'
import { DEFAULT_STATUSLINE_ITEMS } from '../src/render/status.ts'
import { DEFAULT_TERMINAL_TITLE } from '../src/terminal-title.ts'
import { DARK_PALETTE, setTheme } from '../src/theme.ts'
import { DSH_CODE_VERSION, _resetDshKernelVersionForTests } from '../src/version.ts'
import type { PendingQuestion, QuestionSnapshot } from '../src/questions.ts'

const wait = async (): Promise<void> => new Promise(resolve => setTimeout(resolve, 100))
const resizeClear = '\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H'
// The composer band's resting background (dark palette): every frame may
// carry it. A WAVE background is any OTHER truecolor 48;2 triple.
const bandBgSeq = `48;2;${DARK_PALETTE.composerBand[0]};${DARK_PALETTE.composerBand[1]};${DARK_PALETTE.composerBand[2]}`
const waveBgCount = (text: string): number =>
  (text.match(/48;2;\d{1,3};\d{1,3};\d{1,3}/g) ?? []).filter(seq => seq !== bandBgSeq).length
// useSyncExternalStore compares getSnapshot results by identity: these
// doubles must return one frozen object forever, or React spins into an
// infinite re-render loop (Maximum update depth exceeded).
const approvalSnapshot = Object.freeze({ pending: undefined, answered: false, queued: 0 })
const questionSnapshot = Object.freeze({ pending: undefined })
const unsubscribe = (): void => {}
const noop = (): void => {}
/** Shared identity-stable empty subagent feed snapshot (getSnapshot contract). */
const EMPTY_AGENTS = Object.freeze([])

/** One TTY harness: the PassThrough streams Ink renders through plus the
 * accumulated stdout bytes. */
interface TtyHarness {
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  output: { text: string }
}

/** Build the real-ink TTY streams the App tests render through. */
function createTty(columns = 100, rows = 24): TtyHarness {
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
function appProps(overrides: Partial<AppProps> = {}): AppProps {
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
    commands: { descriptors: [], subscribe: () => unsubscribe },
    skills: { rows: [], subscribe: () => unsubscribe },
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
    loadGitDiff: async () => ({ title: 'git diff', text: '' }),
    reviewChanges: noop,
    loadPresets: async () => [],
    loadPermissions: async () => [],
    switchMode: async id => id,
    createSession: noop,
    forkSession: noop,
    loadSessions: async () => [],
    loadSubagents: async () => [],
    loadSessionTranscript: async () => '',
    switchSession: noop,
    cancelSessionSwitch: () => false,
    loadPlugins: () => [],
    probeUpdate: () => Promise.reject(new Error('update probe not wired in test')),
    applyUpdate: () => Promise.resolve(0),
    loadJobs: () => [],
    statusline: DEFAULT_STATUSLINE_ITEMS,
    saveStatusline: noop,
    applyEditorKeys: async () => 'ctrl+r passthrough written to test',
    history: [],
    recordHistory: noop,
    cancelQueued: noop,
    onBridgeReady: noop,
    ...overrides,
  }
}

/** Render <App> through one TTY harness. */
function renderApp(harness: TtyHarness, props: AppProps): ReturnType<typeof render> {
  return render(createElement(App, props), {
    stdin: harness.stdin,
    stdout: harness.stdout,
    stderr: harness.stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  })
}

/** One settled assistant entry (pure-cache fixture). */
function assistantEntry(text: string, reasoning = ''): TranscriptEntry {
  return { kind: 'assistant', text, reasoning }
}

describe('pre-session controls', () => {
  it('shows defaults and handles mode/permission choices before a session exists', async () => {
    const harness = createTty(140, 24)
    const dispatch = vi.fn()
    const switchMode = vi.fn(async (id: string) => id)
    const setPermission = vi.fn((id: string) => id)
    const cycleMode = vi.fn(() => 'permission → danger-full-access')
    const instance = renderApp(harness, appProps({
      sessionId: '',
      mode: 'standard',
      permission: 'workspace-write',
      dispatch,
      switchMode,
      setPermission,
      cycleMode,
      loadPresets: async () => [{ id: 'minimal', trust: 'system' }],
      loadPermissions: async () => [{ id: 'read-only' }, { id: 'workspace-write' }, { id: 'danger-full-access' }],
    }))

    try {
      await wait()
      expect(harness.output.text).toContain('/mode standard')
      expect(harness.output.text).toContain('workspace-write')

      // Bare /permission opens the bounded selection panel; enter applies
      // the cursor row without creating a session.
      harness.stdin.write('/permission')
      await wait()
      harness.stdin.write('\r')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(setPermission).toHaveBeenCalledWith('read-only')
      expect(dispatch).not.toHaveBeenCalledWith(expect.stringContaining('/permission'))

      // The direct-argument form routes through dispatch (the runner owns
      // pre-session validation), never the App-level prop.
      harness.stdin.write('/permission danger-full-access')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(dispatch).toHaveBeenCalledWith('/permission danger-full-access')

      harness.stdin.write('\x1b[Z')
      await wait()
      expect(cycleMode).toHaveBeenCalledOnce()

      harness.stdin.write('/mode')
      await wait()
      harness.stdin.write('\r')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(switchMode).toHaveBeenCalledWith('minimal')
    } finally {
      instance.unmount()
    }
  })

  it('notifies the plan station from the Shift+Tab mode cycle', async () => {
    const harness = createTty(140, 24)
    const cycleMode = vi.fn(() => 'plan → on')
    const instance = renderApp(harness, appProps({ cycleMode }))
    try {
      await wait()
      harness.output.text = ''
      harness.stdin.write('\x1b[Z')
      await wait()
      expect(cycleMode).toHaveBeenCalledOnce()
      expect(harness.output.text).toContain('plan → on')
    } finally {
      instance.unmount()
    }
  })

  it('names the plan station in the badge from the pre-session pending choice', async () => {
    const harness = createTty(140, 24)
    const instance = renderApp(harness, appProps({ sessionId: '', permission: 'read-only', pendingPlan: true }))
    try {
      await wait()
      expect(harness.output.text).toContain('plan')
      expect(harness.output.text).not.toContain('read-only (shift+tab to cycle)')
    } finally {
      instance.unmount()
    }
  })
})

describe('mention completion scheduling', () => {
  it('debounces path lookups, keeps the previous rows, and ignores stale results', async () => {
    const harness = createTty(120, 24)
    const calls: { query: string; resolve: (rows: readonly { label: string; description: string; kind: 'file' | 'directory' }[]) => void }[] = []
    const loadMentions = vi.fn((query: string) => new Promise<readonly { label: string; description: string; kind: 'file' | 'directory' }[]>(resolve => {
      calls.push({ query, resolve })
    }))
    const instance = renderApp(harness, appProps({ loadMentions }))

    try {
      await wait()
      harness.stdin.write('@a')
      await wait(80)
      expect(calls.map(call => call.query)).toEqual(['a'])

      harness.stdin.write('b')
      await wait(80)
      expect(calls.map(call => call.query)).toEqual(['a', 'ab'])

      calls[0]!.resolve([{ label: 'old.ts', description: 'File', kind: 'file' }])
      await wait()
      expect(harness.output.text).not.toContain('@old.ts')

      calls[1]!.resolve([{ label: 'new.ts', description: 'File', kind: 'file' }])
      await wait()
      expect(harness.output.text).toContain('@new.ts')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})

describe('composer image attachments', () => {
  it('turns @ images and dragged paths into durable image blocks without a new slash command', async () => {
    const harness = createTty(120, 24)
    const dispatch = vi.fn()
    const inspectImages = vi.fn(async (paths: readonly string[]) => paths.map((path) => ({
      path,
      name: path.split(/[\\/]/u).at(-1) ?? 'image.png',
      mediaType: path.endsWith('.webp') ? 'image/webp' as const : 'image/png' as const,
      bytes: 8,
    })))
    const prepareImages = vi.fn(async (paths: readonly string[]) => paths.map((path, index) => ({
      type: 'image' as const,
      attachment: {
        attachmentId: `sha-${index}`,
        mediaType: path.endsWith('.webp') ? 'image/webp' as const : 'image/png' as const,
        bytes: 8,
        width: 1,
        height: 1,
        name: path.split(/[\\/]/u).at(-1),
      },
    })))
    const instance = renderApp(harness, appProps({
      dispatch,
      inspectImages,
      prepareImages,
      loadMentions: async () => [{ label: 'docs/pic.png', description: 'File', kind: 'file', path: 'C:\\repo\\docs\\pic.png' }],
    }))
    try {
      await wait()
      harness.stdin.write('@pic')
      await wait()
      harness.stdin.write('\t')
      await wait(180)
      expect(harness.output.text).toContain('@pic.png')
      harness.stdin.write('\r')
      await wait(180)
      expect(prepareImages).toHaveBeenCalledWith(['C:\\repo\\docs\\pic.png'], expect.anything())
      expect(dispatch).toHaveBeenCalledWith('@pic.png', [expect.objectContaining({ type: 'image' })], 'session-12345678')

      harness.stdin.write('"C:\\outside\\a.png" "D:\\b.webp"')
      await wait(180)
      expect(harness.output.text).toContain('[image: a.png]')
      expect(harness.output.text).toContain('[image: b.webp]')
      harness.stdin.write('\r')
      await wait(180)
      expect(prepareImages).toHaveBeenLastCalledWith(['C:\\outside\\a.png', 'D:\\b.webp'], expect.anything())
      expect(dispatch).toHaveBeenLastCalledWith('[image: a.png] [image: b.webp]', expect.arrayContaining([
        expect.objectContaining({ type: 'image' }),
        expect.objectContaining({ type: 'image' }),
      ]), 'session-12345678')
    } finally {
      instance.unmount()
    }
  })

  it('turns a dropped mixed image/file list into durable image and file blocks', async () => {
    const harness = createTty(120, 24)
    const dispatch = vi.fn()
    const inspectImages = vi.fn(async (paths: readonly string[]) => paths.map((path) => ({
      path,
      name: path.split(/[\\/]/u).at(-1) ?? 'shot.png',
      mediaType: 'image/png' as const,
      bytes: 8,
    })))
    const prepareImages = vi.fn(async (paths: readonly string[]) => paths.map((path, index) => ({
      type: 'image' as const,
      attachment: { attachmentId: `img-${index}`, mediaType: 'image/png' as const, bytes: 8, width: 1, height: 1, name: path.split(/[\\/]/u).at(-1) },
    })))
    const inspectFiles = vi.fn(async (paths: readonly string[]) => paths.map((path) => ({
      path, name: path.split(/[\\/]/u).at(-1) ?? 'notes.txt', bytes: 10,
    })))
    const prepareFiles = vi.fn(async (paths: readonly string[]) => paths.map((path, index) => ({
      type: 'file' as const,
      attachment: { attachmentId: `file-${index}`, name: path.split(/[\\/]/u).at(-1), bytes: 10 },
    })))
    const instance = renderApp(harness, appProps({ dispatch, inspectImages, prepareImages, inspectFiles, prepareFiles }))
    try {
      await wait()
      // One paste carrying an image and a document: both register markers.
      harness.stdin.write('"C:\\repo\\shot.png" "C:\\repo\\report.pdf"')
      await wait(180)
      expect(harness.output.text).toContain('[image: shot.png]')
      expect(harness.output.text).toContain('[file: report.pdf]')
      harness.stdin.write('\r')
      await wait(180)
      expect(prepareFiles).toHaveBeenCalledWith(['C:\\repo\\report.pdf'], expect.anything())
      expect(dispatch).toHaveBeenLastCalledWith('[image: shot.png] [file: report.pdf]', expect.arrayContaining([
        expect.objectContaining({ type: 'image' }),
        expect.objectContaining({ type: 'file', attachment: expect.objectContaining({ name: 'report.pdf' }) }),
      ]), 'session-12345678')
    } finally {
      instance.unmount()
    }
  })

  it('warns but allows a text-only model when the session contains image history', async () => {
    const harness = createTty(110, 24)
    const store = createTranscriptStore()
    store.apply({
      type: 'user/message',
      seq: 1,
      time: 1,
      data: createUserMessage({
        content: [{
          type: 'image',
          attachment: { attachmentId: 'sha-1', mediaType: 'image/png', bytes: 8, width: 1, height: 1, name: 'pixel.png' },
        }],
        source: { kind: 'user' },
      }),
    } as unknown as SessionEvent)
    const selectModel = vi.fn(() => 'acme/text-only')
    const instance = renderApp(harness, appProps({
      store,
      loadModels: async () => ({
        rows: [{ provider: 'acme', providerName: 'Acme', model: 'text-only', modelName: 'Text only', inputModalities: ['text'] }],
        failures: [],
      }),
      selectModel,
    }))
    try {
      await wait()
      harness.stdin.write('/model')
      await wait()
      harness.stdin.write('\r')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(selectModel).toHaveBeenCalled()
      expect(harness.output.text).toContain('image history will be sent as text placeholders')
    } finally {
      instance.unmount()
    }
  })

  it('opens the /update panel with the aligned plan and closes on escape', async () => {
    const harness = createTty(120, 24)
    const instance = renderApp(harness, appProps({
      probeUpdate: () => Promise.resolve({
        code: { running: '1.0.6', latest: '1.0.7' },
        host: { installed: '0.1.5-rc.1', targetLine: '0.1.5-rc.2' },
        profile: { spec: '1.0.6', mounted: '1.0.6', localCheckout: false },
        plan: { dshSpec: '@deepseek-ai/dsh@0.1.5-rc.2', codeSpec: 'dsh-code@1.0.7', pluginSpecs: [] },
        blockers: { registry: null, downgrade: false, localCheckout: null },
        upToDate: false,
      }),
      applyUpdate: () => Promise.resolve(0),
    }))
    try {
      await wait()
      harness.stdin.write('/update')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('dsh-code    1.0.6 → 1.0.7')
      expect(harness.output.text).toContain('enter update')
      // The panel owns the keys while open: escape closes it and the
      // panel footer leaves the last frame.
      harness.output.text = ''
      harness.stdin.write('\x1b')
      await wait()
      expect(harness.output.text).not.toContain('enter update')
    } finally {
      instance.unmount()
    }
  })

  it('opens the /schedule panel from the command line and folds live schedule events', async () => {
    const harness = createTty(120, 24)
    const store = createTranscriptStore()
    const instance = renderApp(harness, appProps({ store }))
    try {
      store.apply({
        type: 'schedule/change',
        seq: 1,
        time: 1,
        data: { operation: 'create', schedule: { id: 'schedule-1', kind: 'every', prompt: 'check the build', everySeconds: 1800, scheduledAt: new Date(Date.now() + 90_000).toISOString() } },
      } as never)
      await wait()
      harness.stdin.write('/schedule')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('check the build')
      expect(harness.output.text).toContain('Every 30m')
      // Height budget is proven by the SchedulePanel TTY suite; here the
      // accumulated multi-frame output would miscount.
      harness.output.text = ''
      harness.stdin.write('\x1b')
      await wait()
      expect(harness.output.text).not.toContain('Every 30m')
    } finally {
      instance.unmount()
    }
  })

  it('preserves a moved cursor when an async image mention resolves', async () => {
    const harness = createTty(120, 24)
    const dispatch = vi.fn()
    let resolveInspection!: (value: readonly { path: string; name: string; mediaType: 'image/png'; bytes: number }[]) => void
    const inspectImages = vi.fn(() => new Promise<readonly { path: string; name: string; mediaType: 'image/png'; bytes: number }[]>(resolve => {
      resolveInspection = resolve
    }))
    const instance = renderApp(harness, appProps({
      dispatch,
      inspectImages,
      prepareImages: async () => [],
      loadMentions: async () => [{ label: 'docs/pic.png', description: 'File', kind: 'file', path: 'C:\\repo\\docs\\pic.png' }],
    }))
    try {
      await wait()
      harness.stdin.write('@pic')
      await wait()
      harness.stdin.write('\t')
      await wait()
      harness.stdin.write(' later')
      await wait()
      resolveInspection([{ path: 'C:\\repo\\docs\\pic.png', name: 'pic.png', mediaType: 'image/png', bytes: 8 }])
      await wait()
      harness.stdin.write('X')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(dispatch).toHaveBeenCalledWith('@pic.png laterX', [], 'session-12345678')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('anchors a dropped image at the drop-time cursor instead of the resolution-time cursor', async () => {
    const harness = createTty(120, 24)
    const dispatch = vi.fn()
    let resolveInspection!: (value: readonly { path: string; name: string; mediaType: 'image/png'; bytes: number }[]) => void
    const inspectImages = vi.fn(() => new Promise<readonly { path: string; name: string; mediaType: 'image/png'; bytes: number }[]>(resolve => {
      resolveInspection = resolve
    }))
    const instance = renderApp(harness, appProps({ dispatch, inspectImages, prepareImages: async () => [] }))
    try {
      await wait()
      harness.stdin.write('AB')
      await wait()
      harness.stdin.write('\x1b[D')
      await wait()
      harness.stdin.write('"C:\\outside\\a.png"')
      await wait()
      harness.stdin.write('\x1b[C')
      await wait()
      resolveInspection([{ path: 'C:\\outside\\a.png', name: 'a.png', mediaType: 'image/png', bytes: 8 }])
      await wait()
      harness.stdin.write('X')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(dispatch).toHaveBeenCalledWith('A [image: a.png] BX', [], 'session-12345678')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('tags an attachment delivery with the composing session for the runner-side stale guard', async () => {
    // Ink unmounts asynchronously, so a prepare resolving after the app went
    // away still reaches dispatch on the microtask timeline — the delivery
    // must carry the composing session's key (the runner drops it when the
    // active session moved on; see submissionBelongsToSession).
    const harness = createTty(120, 24)
    const dispatch = vi.fn()
    let resolvePreparation!: (value: readonly ImageBlock[]) => void
    const prepareImages = vi.fn((_paths: readonly string[], _signal?: AbortSignal) => new Promise<readonly ImageBlock[]>(resolve => {
      resolvePreparation = resolve
    }))
    const instance = renderApp(harness, appProps({
      dispatch,
      inspectImages: async paths => paths.map(path => ({ path, name: 'a.png', mediaType: 'image/png', bytes: 8 })),
      prepareImages,
    }))
    try {
      await wait()
      harness.stdin.write('"C:\\slow\\a.png"')
      await wait(150)
      harness.stdin.write('\r')
      await wait()
      expect(prepareImages).toHaveBeenCalledOnce()
      // The composer goes away mid-prepare (the real trigger is a queued
      // session switch remounting by session id).
      instance.unmount()
      resolvePreparation([])
      await wait(80)
      expect(dispatch).toHaveBeenCalledWith('[image: a.png]', [], 'session-12345678')
    } finally {
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('freezes without a caret while preparing images and restores the draft on cancellation', async () => {
    const harness = createTty(120, 24)
    const dispatch = vi.fn()
    let resolvePreparation!: (value: readonly ImageBlock[]) => void
    const prepareImages = vi.fn((_paths: readonly string[], _signal?: AbortSignal) => new Promise<readonly ImageBlock[]>(resolve => {
      resolvePreparation = resolve
    }))
    const instance = renderApp(harness, appProps({
      dispatch,
      inspectImages: async paths => paths.map(path => ({ path, name: 'a.png', mediaType: 'image/png', bytes: 8 })),
      prepareImages,
    }))
    try {
      await wait()
      harness.stdin.write('"C:\\outside\\a.png"')
      await wait()
      harness.output.text = ''
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('processing 1 attachment')
      expect(harness.output.text).not.toContain('\x1b[7m')
      const signal = prepareImages.mock.calls[0]?.[1]
      expect(signal?.aborted).toBe(false)

      harness.stdin.write('\x1b')
      await wait()
      expect(signal?.aborted).toBe(true)
      expect(harness.output.text).toContain('[image: a.png]')
      resolvePreparation([])
      await wait()
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})

describe('structured question custom answers', () => {
  it('accepts pasted multiline text without adding a newline shortcut', async () => {
    const harness = createTty(100, 24)
    const submit = vi.fn()
    const pending = {
      request: { questions: [{ id: 'details', question: 'Provide details' }] },
      resolve: noop,
      reject: noop,
    } as unknown as PendingQuestion
    const snapshot: QuestionSnapshot = { pending }
    const instance = renderApp(harness, appProps({
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => snapshot,
        submit,
        cancel: noop,
      },
    }))
    try {
      await wait()
      harness.stdin.write('\x1b[200~first line\nsecond line\x1b[201~')
      await wait(180)
      harness.stdin.write('\r')
      await wait()
      expect(submit).toHaveBeenCalledWith(pending, {
        answers: [{ id: 'details', selected: [], custom: 'first line\nsecond line' }],
      })
    } finally {
      instance.unmount()
    }
  })
})

describe('structured question multi-select', () => {
  it('toggles options with space and submits the full selection', async () => {
    const harness = createTty(100, 24)
    const submit = vi.fn()
    const pending = {
      request: {
        questions: [{
          id: 'pick',
          question: 'Which ones?',
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
          multiSelect: true,
        }],
      },
      resolve: noop,
      reject: noop,
    } as unknown as PendingQuestion
    const snapshot: QuestionSnapshot = { pending }
    const instance = renderApp(harness, appProps({
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => snapshot,
        submit,
        cancel: noop,
      },
    }))
    try {
      await wait()
      harness.stdin.write(' ')
      await wait()
      expect(harness.output.text).toContain('◉')
      harness.stdin.write('\x1b[B')
      await wait()
      harness.stdin.write(' ')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(submit).toHaveBeenCalledWith(pending, {
        answers: [{ id: 'pick', selected: ['A', 'B'] }],
      })
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('toggles options by their number keys and submits the set', async () => {
    const harness = createTty(100, 24)
    const submit = vi.fn()
    const pending = {
      request: {
        questions: [{
          id: 'pick',
          question: 'Which ones?',
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
          multiSelect: true,
        }],
      },
      resolve: noop,
      reject: noop,
    } as unknown as PendingQuestion
    const snapshot: QuestionSnapshot = { pending }
    const instance = renderApp(harness, appProps({
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => snapshot,
        submit,
        cancel: noop,
      },
    }))
    try {
      await wait()
      harness.stdin.write('1')
      await wait()
      harness.stdin.write('3')
      await wait()
      expect(harness.output.text).toContain('◉ 1. A')
      expect(harness.output.text).toContain('◉ 3. C')
      harness.stdin.write('\r')
      await wait()
      expect(submit).toHaveBeenCalledWith(pending, {
        answers: [{ id: 'pick', selected: ['A', 'C'] }],
      })
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('picks a single-select option immediately by its number key', async () => {
    const harness = createTty(100, 24)
    const submit = vi.fn()
    const pending = {
      request: {
        questions: [{
          id: 'pick',
          question: 'Which one?',
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
        }],
      },
      resolve: noop,
      reject: noop,
    } as unknown as PendingQuestion
    const snapshot: QuestionSnapshot = { pending }
    const instance = renderApp(harness, appProps({
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => snapshot,
        submit,
        cancel: noop,
      },
    }))
    try {
      await wait()
      harness.stdin.write('2')
      await wait()
      expect(submit).toHaveBeenCalledTimes(1)
      expect(submit).toHaveBeenCalledWith(pending, {
        answers: [{ id: 'pick', selected: ['B'] }],
      })
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('answers a coalesced space-then-enter chunk as toggle plus submit', async () => {
    const harness = createTty(100, 24)
    const submit = vi.fn()
    const pending = {
      request: {
        questions: [{
          id: 'pick',
          question: 'Which ones?',
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
          multiSelect: true,
        }],
      },
      resolve: noop,
      reject: noop,
    } as unknown as PendingQuestion
    const snapshot: QuestionSnapshot = { pending }
    const stdinProxy = createSplitStdin(harness.stdin as unknown as NodeJS.ReadStream)
    const instance = render(createElement(App, appProps({
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => snapshot,
        submit,
        cancel: noop,
      },
    })), {
      stdin: stdinProxy.stdin,
      stdout: harness.stdout,
      stderr: harness.stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      await wait()
      // One write, two keypresses: the exact shape that lost both keys.
      harness.stdin.write(' \r')
      await wait()
      expect(submit).toHaveBeenCalledWith(pending, {
        answers: [{ id: 'pick', selected: ['A'] }],
      })
    } finally {
      stdinProxy.dispose()
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('handles printable CSI-u space and number keys through the production stdin proxy', async () => {
    const harness = createTty(100, 24)
    const submit = vi.fn()
    const pending = {
      request: {
        questions: [{
          id: 'pick',
          question: 'Which ones?',
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
          multiSelect: true,
        }],
      },
      resolve: noop,
      reject: noop,
    } as unknown as PendingQuestion
    const snapshot: QuestionSnapshot = { pending }
    const stdinProxy = createSplitStdin(harness.stdin as unknown as NodeJS.ReadStream)
    const instance = render(createElement(App, appProps({
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => snapshot,
        submit,
        cancel: noop,
      },
    })), {
      stdin: stdinProxy.stdin,
      stdout: harness.stdout,
      stderr: harness.stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      await wait()
      harness.stdin.write('\x1b[32u')
      await wait()
      harness.stdin.write('\x1b[50u')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(submit).toHaveBeenCalledWith(pending, {
        answers: [{ id: 'pick', selected: ['A', 'B'] }],
      })
    } finally {
      stdinProxy.dispose()
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('cancels the question panel on Ctrl+C instead of handing the key to the composer', async () => {
    const harness = createTty(100, 24)
    const cancel = vi.fn()
    const pending = {
      request: {
        questions: [{
          id: 'pick',
          question: 'Which one?',
          options: [{ label: 'A' }, { label: 'B' }],
        }],
      },
      resolve: noop,
      reject: noop,
    } as unknown as PendingQuestion
    const snapshot: QuestionSnapshot = { pending }
    const instance = renderApp(harness, appProps({
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => snapshot,
        submit: noop,
        cancel,
      },
    }))
    try {
      await wait()
      harness.stdin.write('\x03')
      await wait()
      expect(cancel).toHaveBeenCalledWith(pending)
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('switches between multiple questions without losing selections', async () => {
    const harness = createTty(100, 24)
    const submit = vi.fn()
    const pending = {
      request: {
        questions: [
          {
            id: 'first',
            question: 'First?',
            options: [{ label: 'A' }, { label: 'B' }],
            multiSelect: true,
          },
          {
            id: 'second',
            question: 'Second?',
            options: [{ label: 'C' }, { label: 'D' }],
            multiSelect: true,
          },
        ],
      },
      resolve: noop,
      reject: noop,
    } as unknown as PendingQuestion
    const snapshot: QuestionSnapshot = { pending }
    const instance = renderApp(harness, appProps({
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => snapshot,
        submit,
        cancel: noop,
      },
    }))
    try {
      await wait()
      harness.stdin.write('1')
      await wait()
      harness.stdin.write('\x1b[C')
      await wait()
      expect(harness.output.text).toContain('❓ question 2/2')
      harness.stdin.write('2')
      await wait()
      harness.stdin.write('\x1b[D')
      await wait()
      expect(harness.output.text).toContain('❓ question 1/2')
      expect(harness.output.text).toContain('◉ 1. A')
      // The first selection is already part of the per-question draft; only
      // the final question needs Enter to submit the full ordered answer set.
      harness.stdin.write('\x1b[C')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(submit).toHaveBeenCalledWith(pending, {
        answers: [
          { id: 'first', selected: ['A'] },
          { id: 'second', selected: ['D'] },
        ],
      })
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})

describe('multiline composer', () => {
  it('inserts newlines for the modified-Enter family and submits only on plain Enter', async () => {
    const harness = createTty(100, 24)
    const dispatched: string[] = []
    const instance = renderApp(harness, appProps({
      dispatch: text => { dispatched.push(text) },
    }))
    try {
      await wait()
      harness.stdin.write('first')
      await wait()
      // Kitty Shift+Enter (13;2) and Ctrl+Enter (13;5) normalize to the LF
      // byte; Alt+Enter keeps its escape form with meta — all three insert a
      // newline instead of submitting.
      harness.stdin.write('\x1b[13;2u')
      await wait()
      harness.stdin.write('second')
      await wait()
      harness.stdin.write('\x1b[13;5u')
      await wait()
      harness.stdin.write('third')
      await wait()
      harness.stdin.write('\x1b\r')
      await wait()
      harness.stdin.write('fourth')
      await wait()
      // Ctrl+J is the legacy-terminal newline key (bare LF, no protocol).
      harness.stdin.write('\n')
      await wait()
      harness.stdin.write('fifth')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(dispatched).toEqual(['first\nsecond\nthird\nfourth\nfifth'])
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('moves by word and line with Codex editor keys and yanks kills', async () => {
    const harness = createTty(60, 24)
    let dispatched = ''
    const instance = renderApp(harness, appProps({
      dispatch: text => { dispatched = text },
    }))
    try {
      await wait()
      harness.stdin.write('hello world')
      await wait()
      harness.stdin.write('[1;5D') // Ctrl+Left: word left
      await wait()
      harness.stdin.write('b') // Alt+B: word left again (to start)
      await wait()
      harness.stdin.write(String.fromCharCode(11)) // Ctrl+K kills to line end
      await wait()
      harness.stdin.write(String.fromCharCode(25)) // Ctrl+Y yanks the kill back
      await wait()
      harness.stdin.write('[H') // Home
      await wait()
      harness.stdin.write('[3~') // Delete forward removes 'h'
      await wait()
      harness.stdin.write(String.fromCharCode(13))
      await wait()
      expect(dispatched).toBe('ello world')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('hard-wraps a long CJK draft into multiple composer rows before submission', async () => {
    const harness = createTty(40, 30)
    let dispatched = ''
    const instance = renderApp(harness, appProps({
      dispatch: text => { dispatched = text },
    }))
    try {
      await wait()
      const draft = '一二三四五六七八九十'.repeat(2)
      harness.stdin.write(draft)
      await wait()
      harness.stdin.write(String.fromCharCode(13))
      await wait()
      expect(dispatched).toBe(draft)
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('keeps Up as caret movement inside a multiline draft instead of history recall', async () => {
    const harness = createTty(80, 24)
    let dispatched = ''
    const instance = renderApp(harness, appProps({
      dispatch: text => { dispatched = text },
      history: ['older entry'],
    }))
    try {
      await wait()
      harness.stdin.write('[200~first')
      await wait()
      harness.stdin.write('\r')
      await wait()
      harness.stdin.write('second[201~')
      await wait()
      harness.stdin.write('[A') // Up: caret to line 1 end, not recall
      await wait()
      harness.stdin.write('X')
      await wait()
      harness.stdin.write(String.fromCharCode(13))
      await wait()
      expect(dispatched).toBe('firstX\nsecond')
      expect(dispatched).not.toContain('older entry')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('renders exactly one caret and keeps movement responsive through blink frames', async () => {
    const harness = createTty(80, 24)
    let dispatched = ''
    const instance = renderApp(harness, appProps({ dispatch: text => { dispatched = text } }))
    try {
      await wait()
      harness.output.text = ''
      harness.stdin.write('[200~first\rsecond[201~')
      await wait()
      const plain = harness.output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '')
      expect(plain).toContain('❯ first')
      expect(plain).not.toContain('❯  first')

      await new Promise(resolve => setTimeout(resolve, 560))
      harness.stdin.write('\x1b[D')
      await wait()
      harness.stdin.write('X')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(dispatched).toBe('first\nseconXd')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('crosses history from a recalled multiline entry; Left still edits inside', async () => {
    const harness = createTty(80, 24)
    let dispatched = ''
    const instance = renderApp(harness, appProps({
      history: ['older entry', 'first\nsecond'],
      dispatch: text => { dispatched = text },
    }))
    try {
      await wait()
      // Recall the newest multiline entry: its caret rests on the text
      // end, so the next Up crosses to the older entry (either text edge
      // switches history).
      harness.stdin.write('\x1b[A')
      await wait()
      harness.stdin.write('\x1b[A')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(dispatched).toBe('older entry')
      // Recall again (the submitted older entry is now the newest), cross
      // to the multiline entry, then step the caret inside with Left: an
      // interior caret belongs to ordinary editing, where Up/Down move
      // through the entry's rows.
      harness.stdin.write('\x1b[A')
      await wait()
      harness.stdin.write('\x1b[A')
      await wait()
      harness.stdin.write('\x1b[D')
      await wait()
      harness.stdin.write('X')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(dispatched).toBe('first\nseconXd')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('applies repeated Backspace actions from one stdin chunk in order', async () => {
    const harness = createTty(80, 24)
    let dispatched = ''
    const instance = renderApp(harness, appProps({ dispatch: text => { dispatched = text } }))
    try {
      await wait()
      harness.stdin.write('abcd')
      await wait()
      harness.stdin.write('\x7f\x7f')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(dispatched).toBe('ab')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('resets the preferred vertical column after terminal width changes', async () => {
    const harness = createTty(40, 30)
    let dispatched = ''
    const instance = renderApp(harness, appProps({ dispatch: text => { dispatched = text } }))
    try {
      await wait()
      harness.stdin.write('[200~abcdefghij\rxy\rabcdefghij[201~')
      await wait()
      harness.stdin.write('\x1b[A') // short middle line; remembers column 10
      await wait()
      Object.assign(harness.stdout, { columns: 20 })
      harness.stdout.emit('resize')
      await new Promise(resolve => setTimeout(resolve, 220))
      harness.stdin.write('\x1b[B') // must use the current column 2 after resize
      await wait()
      harness.stdin.write('X')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(dispatched).toBe('abcdefghij\nxy\nabXcdefghij')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})

describe('keyboard protocol and transcript alignment', () => {
  it('routes enhanced Ctrl+C through the busy interrupt contract', async () => {
    const harness = createTty(100, 24)
    const interrupt = vi.fn(() => true)
    const quit = vi.fn()
    const store = createTranscriptStore([
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } as SessionEvent,
      { type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } } as SessionEvent,
    ])
    const instance = renderApp(harness, appProps({ store, interrupt, quit }))
    try {
      await wait()
      harness.output.text = ''
      harness.stdin.write('\x1b[99;5u')
      await wait()
      expect(interrupt).toHaveBeenCalledTimes(1)
      expect(quit).not.toHaveBeenCalled()
      expect(harness.output.text).not.toContain('[99;5u')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('clears a draft on enhanced Ctrl+C before a second press quits', async () => {
    const harness = createTty(100, 24)
    const quit = vi.fn()
    const instance = renderApp(harness, appProps({ quit }))
    try {
      await wait()
      harness.stdin.write('draft')
      await wait()
      harness.stdin.write('\x1b[99;5u')
      await wait()
      expect(quit).not.toHaveBeenCalled()

      harness.output.text = ''
      harness.stdin.write('\x1b[99;5u')
      await wait()
      expect(quit).toHaveBeenCalledTimes(1)
      expect(harness.output.text).not.toContain('[99;5u')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('decodes kitty CSI-u keys: ctrl+r toggles the reasoning fold, Esc keeps its meaning', async () => {
    const harness = createTty(100, 24)
    const { stdin, output } = harness
    const interrupt = vi.fn(() => true)
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
      } as SessionEvent,
      {
        type: 'turn/start',
        seq: 2,
        time: 2,
        data: { turn: 1 },
      } as SessionEvent,
      {
        type: 'step/start',
        seq: 3,
        time: 3,
        data: { turn: 1, step: 1 },
      } as SessionEvent,
    ])
    applyStreamDeltas(store, 1, 1, [{ kind: 'reasoning', text: 'the hidden reasoning trace', time: 4 }])
    const instance = renderApp(harness, appProps({ store, interrupt }))
    try {
      await wait()
      expect(output.text).toContain('Thinking')
      expect(output.text).not.toContain('the hidden reasoning trace')
      // The kitty CSI-u form of Ctrl+R decodes to the legacy control byte
      // before Ink parses it, so the fold opens without touching the draft.
      output.text = ''
      stdin.write('[114;5u')
      await wait()
      expect(output.text).not.toContain('[114;5u')
      // The fold opens through one global source-backed replay.
      expect(output.text).toContain('the hidden reasoning trace')
      expect((output.text.match(/\x1b\[2J/gu) ?? []).length).toBe(1)

      output.text = ''
      stdin.write('[114;5u')
      await wait()
      expect(output.text).toContain('Thinking')
      expect(output.text).not.toContain('the hidden reasoning trace')
      expect((output.text.match(/\x1b\[2J/gu) ?? []).length).toBe(1)

      stdin.write('\x1b')
      await wait()
      expect(interrupt).toHaveBeenCalledTimes(1)
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('folds tool output by default and expands wrapped summaries with Ctrl+R', async () => {
    const harness = createTty(40, 30)
    const { stdin, output } = harness
    const callId = 'wide-tool' as CallId
    const store = createTranscriptStore([
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } as SessionEvent,
      { type: 'tool/call', seq: 2, time: 2, data: { turn: 1, step: 1, callId, name: 'run_code', arguments: '{}' } } as SessionEvent,
      {
        type: 'tool/result',
        seq: 3,
        time: 3,
        data: {
          turn: 1,
          step: 1,
          message: createToolResultMessage({
            callId,
            content: [{ type: 'text', text: 'summary '.repeat(12) }],
            isError: false,
          }),
        },
      } as SessionEvent,
      { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent,
    ])
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      expect(output.text).toContain('Ctrl/Alt+R')
      output.text = ''
      stdin.write('\x12')
      await wait()
      // The expanded settled card's ⎿ row wraps; every continuation line
      // starts with the four-space hanging indent, never at column zero.
      const lines = output.text.split('\n')
      const arrow = lines.findIndex(line => line.includes('\u23bf'))
      expect(arrow).toBeGreaterThanOrEqual(0)
      const continuations = lines.slice(arrow + 1).filter(line => line.trim() !== '' && line.includes('summary'))
      expect(continuations.length).toBeGreaterThan(0)
      for (const line of continuations) {
        expect(line.startsWith('    ')).toBe(true)
      }
    } finally {
      instance.unmount()
      stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('keeps the terminal cursor on Ink\'s parked row across every foreign write', async () => {
    // The IME anchor displaces the real cursor onto the composer caret cell.
    // The ledger contract refines the old write-identity guard: every write
    // that is not the anchor\'s own must start with the cancel sequence that
    // returns the cursor to Ink\'s parked row before Ink\'s relative erase
    // runs, and log-update frame rewrites re-append the anchor inside the
    // same write so a repaint can never leave the cursor displaced.
    const chunks: string[] = []
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 80,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    stdout.on('data', chunk => {
      chunks.push(chunk.toString())
    })
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
    const harness = { stdin, stdout, output: { text: '' } } as TtyHarness
    const instance = renderApp(harness, appProps())
    try {
      await wait()
      stdin.write('ab')
      await wait()
      // A frame rewrite always arrives cancel-prefixed (the cursor is back
      // on Ink's parked row before the relative erase runs) and ends with the
      // re-anchor appended inside the same write.
      const frameWrites = chunks.filter(chunk => /^\x1b\[\d+B\r\x1b\[2K/.test(chunk))
      expect(frameWrites.length).toBeGreaterThan(0)
      for (const frame of frameWrites) {
        expect(frame).toMatch(/\x1b\[\d+A\x1b\[\d+G$/)
      }
      // Writes that are neither frame rewrites nor the anchor's own moves
      // leave no anchor behind.
      for (const chunk of chunks) {
        if (!/^\x1b\[\d+B\r\x1b\[2K/.test(chunk) && !/^\x1b\[\d+B\r\x1b\[\d+A\x1b\[\d+G$/.test(chunk) && !/^\x1b\[\d+A\x1b\[\d+G$/.test(chunk)) {
          expect(chunk).not.toMatch(/\x1b\[\d+A\x1b\[\d+G$/)
        }
      }
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})

describe('Ctrl+O history details', () => {
  it('repaints the whole screen from the new palette when the theme changes', async () => {
    const harness = createTty(100, 24)
    let savedTheme = ''
    const instance = renderApp(harness, appProps({
      saveTheme: name => {
        savedTheme = name
      },
    }))
    try {
      await wait()
      // Open the theme picker and pick the second row (light).
      harness.stdin.write('/theme')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('/theme — color palette')
      harness.stdin.write('\x1b[B')
      await wait()
      harness.output.text = ''
      harness.stdin.write('\r')
      await wait()
      expect(savedTheme).toBe('light')
      // The Static region (whale header + settled rows) renders once, so the
      // theme switch must ride the same source-backed rebuild resize uses:
      // one clear sequence, then the header repaints under the new palette.
      expect(harness.output.text.match(/\x1b\[r\x1b\[0m\x1b\[H\x1b\[2J\x1b\[3J\x1b\[H/g)).toHaveLength(1)
      expect(harness.output.text.slice(harness.output.text.lastIndexOf(resizeClear) + resizeClear.length)).toContain('DeepSeek Harness')
    } finally {
      instance.unmount()
    }
  })

  it('uses an exclusive bounded screen without clearing scrollback and preserves the draft', async () => {
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
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const unsubscribe = (): void => {}
    const noop = (): void => {}
    let dispatched: string | undefined
    const store = createTranscriptStore()
    const descriptors = Array.from({ length: 30 }, (_, index) => ({
      name: `command-${String(index).padStart(2, '0')}`,
      description: `command description ${index}`,
    }))
    const skills = Array.from({ length: 20 }, (_, index) => ({
      name: `skill-${String(index).padStart(2, '0')}`,
      description: `skill description ${index}`,
      modelInvocable: true,
    }))
    const models = Array.from({ length: 100 }, (_, index) => ({
      provider: 'test',
      providerName: 'Test Provider',
      model: `model-${String(index).padStart(2, '0')}`,
      modelName: `Model ${String(index).padStart(2, '0')}`,
    }))
    const instance = render(createElement(App, {
      store,
      subagents: { subscribe: () => unsubscribe, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: { subscribe: () => unsubscribe, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors, subscribe: () => unsubscribe },
      skills: { rows: skills, subscribe: () => unsubscribe },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: (text: string) => {
        dispatched = text
      },
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: models, failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      cancelQueued: noop,
      onBridgeReady: noop,
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      stdin.write('draft')
      await wait()
      expect(output).toContain('draft')
      expect(output).toContain(`DeepSeek Harness · v${DSH_CODE_VERSION}`)
      expect(output).toContain('Into the Unknown  探索未至之境')

      for (const columns of [72, 140, 84]) {
        output = ''
        stdout.columns = columns
        stdout.emit('resize')
        await wait()
        expect(output.match(/\x1b\[r\x1b\[0m\x1b\[H\x1b\[2J\x1b\[3J\x1b\[H/g)).toHaveLength(1)
        const rebuilt = output.slice(output.lastIndexOf(resizeClear) + resizeClear.length)
        expect(rebuilt.match(/DeepSeek Harness/g)).toHaveLength(1)
        expect(output.lastIndexOf('draft')).toBeLessThan(output.lastIndexOf('test/model'))
      }

      output = ''
      stdin.write('\x0f')
      await wait()
      expect(output).toContain('history details')
      expect(output).toContain('test/model')
      expect(output).toContain('draft')
      expect(output.lastIndexOf('draft')).toBeLessThan(output.lastIndexOf('test/model'))
      expect(output).not.toContain('\x1b[2J')
      // A roomy panel may spend two of its bounded rows on title/body/footer
      // separation; newline splitting includes the final partial row, the
      // padded composer band (two blank rows), and the second status row.
      expect(output.split('\n').length).toBeLessThanOrEqual(Math.floor(stdout.rows / 2) + 2)

      output = ''
      for (const columns of [96, 68, 120]) {
        stdout.columns = columns
        stdout.emit('resize')
      }
      await wait()
      expect(output.match(/\x1b\[r\x1b\[0m\x1b\[H\x1b\[2J\x1b\[3J\x1b\[H/g)).toHaveLength(1)
      const rebuilt = output.slice(output.lastIndexOf(resizeClear) + resizeClear.length)
      expect(rebuilt.match(/DeepSeek Harness/g)).toHaveLength(1)
      expect(output).toContain('history details')
      expect(output.lastIndexOf('draft')).toBeLessThan(output.lastIndexOf('test/model'))

      output = ''
      stdin.write('\x0f')
      await wait()
      expect(output).not.toContain('\x1b[2J')
      stdin.write('\r')
      await wait()
      expect(dispatched).toBe('draft')

      store.apply({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } as SessionEvent)
      output = ''
      applyStreamDeltas(store, 1, 1, [{ kind: 'reasoning', text: 'thinking\n'.repeat(1_000), time: 2 }])
      await wait()
      expect(output).not.toContain('\x1b[2J')
      expect(output.split('\n').length).toBeLessThan(stdout.rows)

      const callId = 'long-tool' as CallId
      store.apply({
        type: 'tool/call',
        seq: 3,
        time: 3,
        data: { turn: 1, step: 1, callId, name: 'shell_command', arguments: '{}' },
      } as SessionEvent)
      store.apply({
        type: 'tool/result',
        seq: 4,
        time: 4,
        data: {
          turn: 1,
          step: 1,
          message: createToolResultMessage({
            callId,
            content: [{ type: 'text', text: Array.from({ length: 300 }, (_, index) => `tool output ${index}`).join('\n') }],
            isError: false,
          }),
        },
      } as SessionEvent)
      store.apply({
        type: 'turn/end',
        seq: 5,
        time: 5,
        data: { turn: 1, reason: { kind: 'completed' } },
      } as SessionEvent)
      await wait()
      output = ''
      stdin.write('\x0f')
      await wait()
      expect(output).toContain('history details')
      expect(output).toContain('tool output 0')
      expect(output).not.toContain('\x1b[2J')
      expect(output.split('\n').length).toBeLessThanOrEqual(stdout.rows)

      output = ''
      stdin.write('G')
      await wait()
      expect(output).toContain('tool output 299')
      expect(output).not.toContain('\x1b[2J')

      stdin.write('\x0f')
      await wait()
      output = ''
      stdin.write('/help')
      await wait()
      output = ''
      stdin.write('\r')
      await wait()
      expect(output).toContain('/help')
      expect(output).toContain('keys go to /help · esc closes')
      expect(output.lastIndexOf('keys go to /help · esc closes')).toBeLessThan(output.lastIndexOf('test/model'))
      expect(output).not.toContain('\x1b[2J')
      expect(output.split('\n').length).toBeLessThanOrEqual(stdout.rows)

      output = ''
      stdin.write('G')
      await wait()
      expect(output).toContain('/skill-19')
      expect(output).not.toContain('\x1b[2J')

      stdin.write('q')
      await wait()
      stdin.write('/model')
      await wait()
      output = ''
      stdin.write('\r')
      await wait()
      expect(output).toContain('/model')
      expect(output).toContain('keys go to /model · esc closes')
      expect(output.lastIndexOf('keys go to /model · esc closes')).toBeLessThan(output.lastIndexOf('test/model'))
      expect(output).not.toContain('\x1b[2J')

      output = ''
      // Typing filters the directory in place: '99' matches exactly the
      // Model 99 row (id and display name), replacing the old g/G jump.
      stdin.write('99')
      await wait()
      expect(output).toContain("1 of 100 match '99'")
      expect(output).toContain('Model 99')
      expect(output).not.toContain('\x1b[2J')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})

describe('DeepSeek model-switch easter egg', () => {
  it('sweeps Codex-style per-column wave backgrounds inside the composer, sparkles on the deepseek tier, then restores static; switching away restores ❯ + brand', async () => {
    // The color assertions need truecolor ANSI output; the default test
    // environment disables colors (chalk level 0), so force level 3 here and
    // restore the baseline in the finally block.
    const originalChalkLevel = chalk.level
    chalk.level = 3
    // The ignition style is picked at random; pin Math.random to 0 so the
    // Wave style runs and the deepseek-tier sparkles are guaranteed.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
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
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const unsubscribe = (): void => {}
    const noop = (): void => {}
    const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
    const store = createTranscriptStore()
    // The last selectable row is the official DeepSeek route; 'G' jumps to it.
    // deepseek-reasoner runs the deepseek tier (dual band + sparkles).
    const models = [
      ...Array.from({ length: 30 }, (_, index) => ({
        provider: 'acme',
        providerName: 'Acme',
        model: `model-${String(index).padStart(2, '0')}`,
        modelName: `Model ${String(index).padStart(2, '0')}`,
      })),
      { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-reasoner', modelName: 'DeepSeek-Reasoner' },
    ]
    const instance = render(createElement(App, {
      store,
      subagents: { subscribe: () => unsubscribe, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: { subscribe: () => unsubscribe, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => unsubscribe },
      skills: { rows: [], subscribe: () => unsubscribe },
      model: 'acme/model-01',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: models, failures: [] }),
      loadMentions: async () => [],
      selectModel: row => `${row.provider}/${row.model}`,
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      cancelQueued: noop,
      onBridgeReady: noop,
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      expect(output).not.toContain('deepseek-reasoner')

      // /model → filter to the DeepSeek row → select it. The
      // deepseek tier runs the readability-extended 1.5s Wave-Ultra sweep.
      output = ''
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('deepseek')
      await wait()
      stdin.write('\r')
      await wait()

      const label = 'deepseek-official/deepseek-reasoner'
      expect(output).toContain(label)
      // The persistent prompt marker switched to the deepseek tier glyph » in
      // the tier accent. The first animation interval may already have landed
      // by the time the TTY assertion runs, so lifecycle coverage starts from
      // the stable marker instead of assuming an exact zero-tick frame.
      expect(output).toContain('»')

      // A multiline CJK draft keeps the same physical editor rows throughout
      // the animation; the wave only changes backgrounds and never flattens
      // explicit newlines into a one-row ↵ preview.
      output = ''
      stdin.write('[200~动画第一行\r动画第二行[201~')
      await wait()
      const multilineWave = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '')
      expect(multilineWave).toContain('动画第一行')
      expect(multilineWave).toContain('动画第二行')
      expect(multilineWave).not.toContain('动画第一行↵动画第二行')

      // Mid-wave (~0.7s in): the input row paints per-column wave backgrounds
      // (a truecolor `48;2;` run per sampled gradient column) while the draft
      // area stays readable — the tint blends at ≤ 0.55 toward the base.
      await sleep(700)
      const distinctBg = (): number => new Set((output.match(/48;2;\d{1,3};\d{1,3};\d{1,3}/g) ?? [])).size
      expect(distinctBg()).toBeGreaterThanOrEqual(5)

      // The nominal `· ✦ ✧` tail spans about 1.04s..1.38s. Ink intervals
      // stretch under parallel test load, so wait generously for all frames.
      await sleep(1600)
      expect(output).toContain('✦')
      expect(output).toContain('✧')

      // Past the 1.5s duration: fresh frames carry no wave backgrounds and no
      // sparkles — the band settles back to its static background color.
      await sleep(900)
      const settled = output.length
      await sleep(400)
      const settledDelta = output.slice(settled)
      expect(waveBgCount(settledDelta)).toBe(0)
      expect(settledDelta).not.toContain('✦')

      // Switch away from DeepSeek: the prompt restores the static brand ❯ and
      // drops the » glyph — the tier accent is not sticky on other routes.
      // The panel-open frames still show the tier » in the frozen composer,
      // so the brand ❯ must be the LAST prompt painted after the selection.
      // The reopened list rests on the APPLIED deepseek row: one up reaches
      // the previous acme row.
      stdin.write('\x03') // clear the multiline draft before typing /model
      await wait()
      output = ''
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      const away = output.length
      stdin.write('\x1b[A')
      await wait()
      stdin.write('\r')
      await wait()
      const awayDelta = output.slice(away)
      expect(awayDelta).toMatch(/38;2;65;118;230m❯/)
      expect(awayDelta.lastIndexOf('»')).toBeLessThan(awayDelta.lastIndexOf('38;2;65;118;230m❯'))
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
      chalk.level = originalChalkLevel
      randomSpy.mockRestore()
    }
  }, 20_000)

  it('plays the "Into the Unknown" wave on a non-DeepSeek model at an above-high effort, then restores static', async () => {
    const originalChalkLevel = chalk.level
    chalk.level = 3
    // Pin the Wave style (the unknown tier shares the deepseek Ultra
    // parameters, including the sparkle tail) and force dark.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    setTheme('dark')
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
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const noop = (): void => {}
    const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
    // The applied route is NON-DeepSeek, so only an above-high effort may
    // trigger the wave. acme/think advertises off/high/max with default high.
    const models = [
      { provider: 'acme', providerName: 'Acme', model: 'model-01', modelName: 'Model 01' },
      {
        provider: 'acme',
        providerName: 'Acme',
        model: 'think',
        modelName: 'Think',
        reasoning: {
          efforts: [
            { id: 'off', name: 'Off' },
            { id: 'high', name: 'High' },
            { id: 'max', name: 'Max' },
          ],
          defaultEffort: 'high',
        },
      },
    ]
    const instance = render(createElement(App, {
      store: createTranscriptStore(),
      subagents: { subscribe: () => unsubscribe, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: { subscribe: () => unsubscribe, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => unsubscribe },
      skills: { rows: [], subscribe: () => unsubscribe },
      model: 'acme/model-01',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: models, failures: [] }),
      loadMentions: async () => [],
      selectModel: row => `${row.provider}/${row.model}`,
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      cancelQueued: noop,
      onBridgeReady: noop,
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      // The welcome header's bilingual slogan is "Into the Unknown 探索未至之
      // 境", so a bare "Into the Unknown" WITHOUT the Chinese suffix is the
      // wave wordmark's unique signal.
      const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '')
      const bareWordmark = (text: string): RegExpMatchArray | null =>
        stripAnsi(text).match(/Into the Unknown(?!\s*探索未至之境)/)

      await wait()
      // The non-DeepSeek route with no high effort never waves: static brand
      // prompt, no wordmark, no per-column background.
      expect(bareWordmark(output)).toBeNull()

      // /model → down to acme/think → its effort stage opens on the default
      // (high) → one more down reaches max → apply.
      output = ''
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('\x1b[B')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('effort for Acme · Think')
      stdin.write('\x1b[B')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('model → next step uses acme/think@max')

      // The applied label is acme/think@max — a non-DeepSeek route with an
      // effort strictly above high — so the "Into the Unknown" wave plays
      // the deepseek-tier motion: per-column backgrounds mid-wave…
      await sleep(700)
      const distinctBg = (): number => new Set((output.match(/48;2;\d{1,3};\d{1,3};\d{1,3}/g) ?? [])).size
      expect(distinctBg()).toBeGreaterThanOrEqual(5)
      // …the Into the Unknown wordmark surfaces through the middle…
      expect(bareWordmark(output)).not.toBeNull()
      // …and the prompt keeps the static brand glyph (only official DeepSeek
      // tiers swap to ›/»).
      expect(output).not.toContain('»')

      // The nominal `· ✦ ✧` tail spans about 1.04s..1.38s; wait generously.
      await sleep(1600)
      expect(output).toContain('✦')
      expect(output).toContain('✧')

      // Past the 1.5s duration: fresh frames carry no wave backgrounds and no
      // sparkles — the band settles back to its static background color.
      await sleep(900)
      const settled = output.length
      await sleep(400)
      const settledDelta = output.slice(settled)
      expect(waveBgCount(settledDelta)).toBe(0)
      expect(settledDelta).not.toContain('✦')

      // Dropping the effort back to high clears the wave state: no "Into the
      // Unknown" wordmark on a fresh trigger, static brand restored.
      output = ''
      stdin.write('/model')
      await wait()
      stdin.write('\r') // opens the model list on the APPLIED row (acme/think)
      await wait()
      stdin.write('\r') // its effort stage opens on the effective level (max)
      await wait()
      expect(output).toContain('effort for Acme · Think')
      stdin.write('g') // top of the list (off)
      await wait()
      stdin.write('\x1b[B') // one down reaches high
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('model → next step uses acme/think@high')
      await sleep(400)
      expect(bareWordmark(output)).toBeNull()
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
      chalk.level = originalChalkLevel
      setTheme('dark')
      randomSpy.mockRestore()
    }
  }, 20_000)

  it('plays the wave exactly once per trigger — busy cycles and /animation toggles never replay it', async () => {
    const originalChalkLevel = chalk.level
    chalk.level = 3
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
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
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const unsubscribe = (): void => {}
    const noop = (): void => {}
    const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
    const store = createTranscriptStore()
    const models = [
      ...Array.from({ length: 30 }, (_, index) => ({
        provider: 'acme',
        providerName: 'Acme',
        model: `model-${String(index).padStart(2, '0')}`,
        modelName: `Model ${String(index).padStart(2, '0')}`,
      })),
      { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-reasoner', modelName: 'DeepSeek-Reasoner' },
    ]
    const instance = render(createElement(App, {
      store,
      subagents: { subscribe: () => unsubscribe, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: { subscribe: () => unsubscribe, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => unsubscribe },
      skills: { rows: [], subscribe: () => unsubscribe },
      model: 'acme/model-01',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: models, failures: [] }),
      loadMentions: async () => [],
      selectModel: row => `${row.provider}/${row.model}`,
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      cancelQueued: noop,
      onBridgeReady: noop,
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // Switch onto the official DeepSeek route (bottom row) — the sweep
      // must play exactly once.
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('deepseek')
      await wait()
      stdin.write('\r')
      await wait()
      output = ''
      await sleep(2600)
      expect(waveBgCount(output)).toBeGreaterThan(0)
      expect(output).toContain('✧')

      // A full busy cycle on the UNCHANGED model+effort pair drops and raises
      // the wave gate — a completed sweep must never restart from it.
      store.apply({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } as SessionEvent)
      await sleep(300)
      store.apply({ type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent)
      await sleep(300)
      let mark = output.length
      await sleep(1200)
      let delta = output.slice(mark)
      expect(waveBgCount(delta)).toBe(0)
      expect(delta).not.toContain('✦')

      // /animation off → on on the unchanged pair replays nothing either.
      output = ''
      stdin.write('/animation off')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('animations off')
      stdin.write('/animation on')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('animations on')
      mark = output.length
      await sleep(1200)
      delta = output.slice(mark)
      expect(waveBgCount(delta)).toBe(0)
      expect(delta).not.toContain('✦')

      // Modal panels freeze the composer and UNMOUNT the wave leaf; closing
      // one must NOT replay the settled sweep (the one-shot latch lives in
      // Input, surviving the leaf's unmount/remount cycle).
      output = ''
      stdin.write('/help')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('\x1b') // esc closes the help panel
      await wait()
      mark = output.length
      await sleep(1200)
      delta = output.slice(mark)
      expect(waveBgCount(delta)).toBe(0)
      expect(delta).not.toContain('✦')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
      chalk.level = originalChalkLevel
      randomSpy.mockRestore()
    }
  }, 25_000)

  it('consumes triggers that land while animations are off — /animation on never queues a wave', async () => {
    const originalChalkLevel = chalk.level
    chalk.level = 3
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
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
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const unsubscribe = (): void => {}
    const noop = (): void => {}
    const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
    const store = createTranscriptStore()
    const models = [
      ...Array.from({ length: 30 }, (_, index) => ({
        provider: 'acme',
        providerName: 'Acme',
        model: `model-${String(index).padStart(2, '0')}`,
        modelName: `Model ${String(index).padStart(2, '0')}`,
      })),
      { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-reasoner', modelName: 'DeepSeek-Reasoner' },
    ]
    const instance = render(createElement(App, {
      store,
      subagents: { subscribe: () => unsubscribe, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: { subscribe: () => unsubscribe, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => unsubscribe },
      skills: { rows: [], subscribe: () => unsubscribe },
      model: 'acme/model-01',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: models, failures: [] }),
      loadMentions: async () => [],
      selectModel: row => `${row.provider}/${row.model}`,
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      cancelQueued: noop,
      onBridgeReady: noop,
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // Disable animations FIRST, then switch onto the official DeepSeek
      // route while they are off.
      stdin.write('/animation off')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('animations off')
      output = ''
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('deepseek')
      await wait()
      stdin.write('\r')
      await wait()
      // The » tier accent proves the route switch landed (its absence alone
      // would be a vacuous pass)…
      expect(output).toContain('»')
      await sleep(1000)
      // …and no wave played while animations were off.
      expect(waveBgCount(output)).toBe(0)

      // Re-enabling must not replay the silently consumed celebration.
      output = ''
      stdin.write('/animation on')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('animations on')
      const after = output.length
      await sleep(1500)
      expect(waveBgCount(output.slice(after))).toBe(0)
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
      chalk.level = originalChalkLevel
      randomSpy.mockRestore()
    }
  }, 20_000)

  it('freezes the wave and the busy shimmer entirely when animations are off', async () => {
    const originalChalkLevel = chalk.level
    chalk.level = 3
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
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
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const unsubscribe = (): void => {}
    const noop = (): void => {}
    const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
    const store = createTranscriptStore()
    const models = [
      ...Array.from({ length: 30 }, (_, index) => ({
        provider: 'acme',
        providerName: 'Acme',
        model: `model-${String(index).padStart(2, '0')}`,
        modelName: `Model ${String(index).padStart(2, '0')}`,
      })),
      { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-reasoner', modelName: 'DeepSeek-Reasoner' },
    ]
    const instance = render(createElement(App, {
      store,
      animations: false,
      subagents: { subscribe: () => unsubscribe, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: { subscribe: () => unsubscribe, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => unsubscribe },
      skills: { rows: [], subscribe: () => unsubscribe },
      model: 'acme/model-01',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: models, failures: [] }),
      loadMentions: async () => [],
      selectModel: row => `${row.provider}/${row.model}`,
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      cancelQueued: noop,
      onBridgeReady: noop,
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // Switch onto the official DeepSeek route with animations off: the »
      // tier accent proves the switch landed (its absence alone would be a
      // vacuous pass)…
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('deepseek')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('»')
      await sleep(1000)
      // …and the sweep never paints a single wave background.
      expect(waveBgCount(output)).toBe(0)

      // Busy without streaming: the Deep diving line paints once, then never
      // re-renders — its 33ms shimmer timer stays dormant with animations off.
      store.apply({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } as SessionEvent)
      await sleep(500)
      expect(output).toContain('Deep diving')
      const painted = output.length
      await sleep(700)
      expect(output.slice(painted)).not.toContain('Deep diving')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
      chalk.level = originalChalkLevel
      randomSpy.mockRestore()
    }
  }, 15_000)
})

describe('bracketed paste safety', () => {
  it('recovers Enter submission after a lost paste end marker', async () => {
    const { stdin, stdout, output } = createTty(100, 24)
    const store = createTranscriptStore()
    const dispatched: string[] = []
    const unsubscribe = (): void => {}
    const noop = (): void => {}
    const instance = render(createElement(App, {
      store,
      subagents: { subscribe: () => unsubscribe, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: { subscribe: () => unsubscribe, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => unsubscribe },
      skills: { rows: [], subscribe: () => unsubscribe },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: text => {
        dispatched.push(text)
      },
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      cancelQueued: noop,
      onBridgeReady: noop,
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // A paste start marker arrives (ESC already stripped by Ink) but its
      // end marker never does.
      stdin.write('[200~hi')
      await wait()
      // While the paste is "open", Enter inserts a newline rather than submit.
      stdin.write('\r')
      await wait()
      expect(dispatched).toEqual([])

      // Past the lost-marker safety window the flag resets: Enter submits.
      await new Promise(resolve => setTimeout(resolve, 1_200))
      stdin.write('\r')
      await wait()
      expect(dispatched).toEqual(['hi'])
      expect(output.text).not.toContain('[200~')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  }, 20_000)
})

describe('Ctrl+R reasoning fold', () => {
  it('handles Ctrl+R only while the VS Code terminal reports focus', async () => {
    vi.stubEnv('TERM_PROGRAM', 'vscode')
    vi.stubEnv('VSCODE_INJECTION', '1')
    const harness = createTty(100, 24)
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
      } as SessionEvent,
      {
        type: 'assistant/message',
        seq: 2,
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [
              { type: 'reasoning', text: 'focus-gated reasoning' },
              { type: 'text', text: 'answer' },
            ],
            source: { provider: 'p', model: 'm' },
          }),
        },
      } as SessionEvent,
    ])
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      expect(harness.output.text).toContain('Thinking (')

      harness.output.text = ''
      harness.stdin.write('\x1b[O\x12')
      await wait()
      expect(harness.output.text).not.toContain('focus-gated reasoning')

      harness.output.text = ''
      harness.stdin.write('\x1b[I\x12')
      await wait()
      expect(harness.output.text).toContain('focus-gated reasoning')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
      vi.unstubAllEnvs()
    }
  })

  it('accepts alt+r as a fold alias under the same VS Code focus gate', async () => {
    vi.stubEnv('TERM_PROGRAM', 'vscode')
    vi.stubEnv('VSCODE_INJECTION', '1')
    const harness = createTty(100, 24)
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
      } as SessionEvent,
      {
        type: 'assistant/message',
        seq: 2,
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [
              { type: 'reasoning', text: 'alias-gated reasoning' },
              { type: 'text', text: 'answer' },
            ],
            source: { provider: 'p', model: 'm' },
          }),
        },
      } as SessionEvent,
    ])
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      expect(harness.output.text).toContain('Thinking (')

      // Focus-out + alt+r stays gated exactly like ctrl+r.
      harness.output.text = ''
      harness.stdin.write('\x1b[O\x1br')
      await wait()
      expect(harness.output.text).not.toContain('alias-gated reasoning')

      // Focus-in + alt+r toggles the fold.
      harness.output.text = ''
      harness.stdin.write('\x1b[I\x1br')
      await wait()
      expect(harness.output.text).toContain('alias-gated reasoning')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
      vi.unstubAllEnvs()
    }
  })

  it('paints the collapsed streaming-thinking marker with the deep-diving shimmer', async () => {
    const harness = createTty(100, 24)
    const store = createTranscriptStore()
    const instance = renderApp(harness, appProps({ store }))
    try {
      store.apply({ type: 'request/context', seq: 1, time: 1, data: { provider: 'zai', model: 'glm-5.2', contextWindow: 128_000 } } as SessionEvent)
      store.apply({ type: 'turn/start', seq: 2, time: 2, data: { turn: 1 } } as SessionEvent)
      store.apply({ type: 'step/start', seq: 3, time: 3, data: { turn: 1, step: 1 } } as SessionEvent)
      store.apply({
        type: 'user/message', seq: 4, time: 4,
        data: createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
      } as SessionEvent)
      applyStreamDeltas(store, 1, 1, [{ kind: 'reasoning', text: 'the streaming thought', time: 5 }])
      await wait()
      const plain = harness.output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '')
      expect(plain).toContain('✻ Thinking… (Ctrl/Alt+R to expand)')
      expect(plain).not.toContain('the streaming thought')

      // Once answer text streams, the marker yields the animation (the
      // tick cadence must not race the answer paint) while staying visible;
      // the streaming text itself keeps painting.
      harness.output.text = ''
      applyStreamDeltas(store, 1, 1, [{ kind: 'text', text: 'the answer token', time: 6 }])
      await wait()
      const answering = harness.output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '')
      expect(answering).toContain('the answer token')
      expect(answering).toContain('Thinking… (Ctrl/Alt+R to expand)')

      // Ctrl+R swaps the marker for the live reasoning stream.
      harness.output.text = ''
      harness.stdin.write('\x12')
      await wait()
      const expanded = harness.output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '')
      expect(expanded).toContain('the streaming thought')
      expect(expanded).not.toContain('Thinking… (Ctrl/Alt+R to expand)')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('replays the fold globally and immediately on a busy-turn toggle', async () => {
    const harness = createTty(100, 30)
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }),
      } as SessionEvent,
      {
        type: 'assistant/message',
        seq: 2,
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [
              { type: 'reasoning', text: 'old settled reasoning' },
              { type: 'text', text: 'old answer' },
            ],
            source: { provider: 'p', model: 'm' },
          }),
        },
      } as SessionEvent,
      { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent,
    ])
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      expect(harness.output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '')).toContain('Thinking (')

      // A second turn runs; the fold toggles while that turn is busy. The
      // live region flips without a source-backed clear…
      harness.output.text = ''
      store.apply({ type: 'turn/start', seq: 4, time: 4, data: { turn: 2 } } as SessionEvent)
      store.apply({ type: 'step/start', seq: 5, time: 5, data: { turn: 2, step: 1 } } as SessionEvent)
      applyStreamDeltas(store, 2, 1, [{ kind: 'text', text: 'live answer', time: 6 }])
      await wait()
      harness.stdin.write('\x12')
      await wait()
      // The toggle replays IMMEDIATELY even mid-turn: exactly one clear, and
      // the OLD settled entry (already in native scrollback) unifies to the
      // expanded fold right away.
      expect((harness.output.text.match(/\x1b\[2J/gu) ?? []).length).toBe(1)
      expect(harness.output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '')).toContain('old settled reasoning')

      // Turn settlement adds no extra replay; the unified state persists.
      store.apply({ type: 'turn/end', seq: 7, time: 7, data: { turn: 2, reason: { kind: 'completed' } } } as SessionEvent)
      await wait()
      expect((harness.output.text.match(/\x1b\[2J/gu) ?? []).length).toBe(1)
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('repaints the settled fold through one source-backed replay on an idle toggle', async () => {
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
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const unsubscribe = (): void => {}
    const noop = (): void => {}
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
      } as SessionEvent,
      {
        type: 'assistant/message',
        seq: 2,
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [
              { type: 'reasoning', text: 'the hidden reasoning trace' },
              { type: 'text', text: 'the visible answer' },
            ],
            source: { provider: 'p', model: 'm' },
          }),
        },
      } as SessionEvent,
    ])
    const instance = render(createElement(App, {
      store,
      subagents: { subscribe: () => unsubscribe, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: { subscribe: () => unsubscribe, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => unsubscribe },
      skills: { rows: [], subscribe: () => unsubscribe },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\repo\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      cancelQueued: noop,
      onBridgeReady: noop,
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // Settled reasoning collapses behind the fold marker.
      expect(output).toContain('Thinking (')
      expect(output).not.toContain('Ctrl/Alt+R to expand')
      expect(output).not.toContain('the hidden reasoning trace')

      output = ''
      stdin.write('\x12')
      await wait()
      // An idle toggle must be VISIBLE: one source-backed replay repaints the
      // settled transcript with the expanded reasoning, exactly one clear.
      expect(output).toContain('the hidden reasoning trace')
      expect(output.match(/\x1b\[2J/gu)?.length).toBe(1)
      expect(output).toContain('DeepSeek Harness')

      output = ''
      stdin.write('\x12')
      await wait()
      // Toggling back folds again through the same single-replay contract.
      expect(output).toContain('Thinking (')
      expect(output).not.toContain('the hidden reasoning trace')
      expect(output.match(/\x1b\[2J/gu)?.length).toBe(1)
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('folds a live-region assistant entry trapped behind a running tool', async () => {
    const { stdin, stdout, output } = createTty(100, 24)
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
      } as SessionEvent,
      {
        type: 'turn/start',
        seq: 2,
        time: 2,
        data: { turn: 1 },
      } as SessionEvent,
      {
        type: 'tool/call',
        seq: 3,
        time: 3,
        data: { turn: 1, step: 1, callId: 'call-trap', name: 'run_code', arguments: '{}' },
      } as SessionEvent,
      {
        type: 'assistant/message',
        seq: 4,
        time: 4,
        data: {
          turn: 1,
          step: 2,
          message: createAssistantMessage({
            content: [
              { type: 'reasoning', text: 'the trapped reasoning trace' },
              { type: 'text', text: 'the trapped answer' },
            ],
            source: { provider: 'p', model: 'm' },
          }),
        },
      } as SessionEvent,
    ])
    const unsubscribe = (): void => {}
    const noop = (): void => {}
    const instance = render(createElement(App, {
      store,
      subagents: { subscribe: () => unsubscribe, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: { subscribe: () => unsubscribe, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => unsubscribe },
      skills: { rows: [], subscribe: () => unsubscribe },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      cancelQueued: noop,
      onBridgeReady: noop,
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // The running tool keeps the assembled assistant entry in the live
      // region, which must still respect the default fold: marker only.
      let plain = output.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      expect(plain).toContain('Thinking (')
      expect(plain).not.toContain('the trapped reasoning trace')
      expect(plain).toContain('the trapped answer')

      output.text = ''
      stdin.write('\x12')
      await wait()
      // Ctrl+R replays globally and immediately: the trapped live entry AND
      // the settled scrollback unify with one clear.
      plain = output.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      expect(plain).toContain('the trapped reasoning trace')
      expect((output.text.match(/\x1b\[2J/gu) ?? []).length).toBe(1)

      output.text = ''
      stdin.write('\x12')
      await wait()
      plain = output.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      expect(plain).toContain('Thinking (')
      expect(plain).not.toContain('the trapped reasoning trace')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  }, 20_000)

  it('replays the mid-stream fold toggle globally and settles without extra clears', async () => {
    const { stdin, stdout, output } = createTty(100, 24)
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
      } as SessionEvent,
      {
        type: 'assistant/message',
        seq: 2,
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [
              { type: 'reasoning', text: 'the hidden reasoning trace' },
              { type: 'text', text: 'the visible answer' },
            ],
            source: { provider: 'p', model: 'm' },
          }),
        },
      } as SessionEvent,
    ])
    const unsubscribe = (): void => {}
    const noop = (): void => {}
    const instance = render(createElement(App, {
      store,
      subagents: { subscribe: () => unsubscribe, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: { subscribe: () => unsubscribe, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => unsubscribe },
      skills: { rows: [], subscribe: () => unsubscribe },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      cancelQueued: noop,
      onBridgeReady: noop,
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // Start a fresh reasoning stream over the settled history.
      store.apply({ type: 'turn/start', seq: 3, time: 3, data: { turn: 2 } } as SessionEvent)
      store.apply({ type: 'step/start', seq: 4, time: 4, data: { turn: 2, step: 1 } } as SessionEvent)
      applyStreamDeltas(store, 2, 1, Array.from({ length: 10 }, (_, index) => ({
        kind: 'reasoning' as const, text: `stream-${index} `, time: 5 + index,
      })))
      await wait()
      let plain = output.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      expect(plain).toContain('Thinking')

      // Ctrl+R mid-stream replays globally: expanded reasoning appears with
      // exactly one clear.
      output.text = ''
      stdin.write('\x12')
      await wait()
      plain = output.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      expect(plain).not.toContain('Thinking')
      expect(plain).toContain('stream-9')
      expect((output.text.match(/\x1b\[2J/gu) ?? []).length).toBe(1)

      // The assembled message ends the stream WITHOUT a second clear; the
      // new settled entry still paints the assembled trace and answer.
      store.apply({
        type: 'assistant/message',
        seq: 200,
        time: 30,
        data: {
          turn: 2,
          step: 1,
          message: createAssistantMessage({
            content: [
              { type: 'reasoning', text: 'the assembled trace' },
              { type: 'text', text: 'the assembled answer' },
            ],
            source: { provider: 'p', model: 'm' },
          }),
        },
      } as SessionEvent)
      await wait()
      expect((output.text.match(/\x1b\[2J/gu) ?? []).length).toBe(1)
      expect(output.text).toContain('the assembled trace')
      expect(output.text).toContain('the assembled answer')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  }, 20_000)

  it('keeps expanded reasoning beside the streaming answer without a clear', async () => {
    const { stdin, stdout, output } = createTty(100, 24)
    const store = createTranscriptStore()
    const unsubscribe = (): void => {}
    const noop = (): void => {}
    const instance = render(createElement(App, {
      store,
      subagents: { subscribe: () => unsubscribe, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: { subscribe: () => unsubscribe, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => unsubscribe },
      skills: { rows: [], subscribe: () => unsubscribe },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      cancelQueued: noop,
      onBridgeReady: noop,
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // Expand before the stream starts; the toggle itself stays clear-free.
      stdin.write('\x12')
      await wait()
      output.text = ''
      // A fresh reasoning stream.
      store.apply({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } as SessionEvent)
      store.apply({ type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } } as SessionEvent)
      applyStreamDeltas(store, 1, 1, Array.from({ length: 10 }, (_, index) => ({
        kind: 'reasoning' as const, text: `stream-${index} `, time: 3 + index,
      })))
      await wait()
      // The first text delta keeps reasoning and answer together in the live
      // region. Nothing is promoted into Static before assistant/message.
      applyStreamDeltas(store, 1, 1, [{ kind: 'text', text: 'the visible answer', time: 13 }])
      await wait()
      const plain = output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      expect(store.getView().entries).toEqual([])
      expect(store.getView().streamingReasoning).toContain('stream-9')
      expect(output.text).not.toContain('\x1b[2J')
      expect(plain).toContain('stream-0')
      expect(plain).toContain('stream-9')
      expect(plain).toContain('the visible answer')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  }, 20_000)
})

describe('deferred session remount', () => {
  // The deferred-session path mounts the tree with the placeholder key
  // 'pending', then remounts it with the real session id after the first
  // user message. A key-change remount does not erase the <Static> rows of
  // the previous tree, so the runner must clear the screen (resizeClear)
  // before the remount — otherwise the whale header ghosts (two
  // 'DeepSeek Harness' wordmarks on screen at once). This locks the App
  // contract: a cleared key-change remount repaints exactly one header.
  it('repaints exactly one header across a cleared key-change remount', async () => {
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
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const unsubscribe = (): void => {}
    const noop = (): void => {}
    const store = createTranscriptStore()
    const descriptors = Array.from({ length: 30 }, (_, index) => ({
      name: `command-${String(index).padStart(2, '0')}`,
      description: `command description ${index}`,
    }))
    const skills = Array.from({ length: 20 }, (_, index) => ({
      name: `skill-${String(index).padStart(2, '0')}`,
      description: `skill description ${index}`,
      modelInvocable: true,
    }))
    const models = Array.from({ length: 100 }, (_, index) => ({
      provider: 'test',
      providerName: 'Test Provider',
      model: `model-${String(index).padStart(2, '0')}`,
      modelName: `Model ${String(index).padStart(2, '0')}`,
    }))
    const props = {
      store,
      subagents: { subscribe: () => unsubscribe, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: { subscribe: () => unsubscribe, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors, subscribe: () => unsubscribe },
      skills: { rows: skills, subscribe: () => unsubscribe },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: models, failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      cancelQueued: noop,
      onBridgeReady: noop,
    }
    const instance = render(createElement(App, { key: 'pending', ...props }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // Placeholder mount paints exactly one header.
      expect(output.match(/DeepSeek Harness/g)).toHaveLength(1)

      // The runner clears the screen before remounting with the real key;
      // the remounted frame must paint exactly one header again.
      output = ''
      stdout.write(resizeClear)
      instance.rerender(createElement(App, { key: 'session-7f3a', ...props }))
      await wait()
      expect(output).toContain(resizeClear)
      const postClear = output.slice(output.lastIndexOf(resizeClear) + resizeClear.length)
      expect(postClear.match(/DeepSeek Harness/g)).toHaveLength(1)
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  // Every agent message lands through the durable inbox: a queued insert
  // splice, a claim removal splice, then the durable `user/message`. The
  // queued row is REMOVED by later events, so flushing it into the
  // append-only <Static> region would ghost the retired line on screen
  // (the user sees the first message twice until a resize replays). A tiny
  // terminal forces Ink's full-screen branch, where every render rewrites
  // clearTerminal + the accumulated static + the live frame — exactly the
  // physical screen. The landed message must paint exactly once there.
  it('never flushes the queued row, so the landed first message paints once', async () => {
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
      columns: 100,
      rows: 3,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const unsubscribe = (): void => {}
    const noop = (): void => {}
    const store = createTranscriptStore()
    const descriptors = Array.from({ length: 30 }, (_, index) => ({
      name: `command-${String(index).padStart(2, '0')}`,
      description: `command description ${index}`,
    }))
    const skills = Array.from({ length: 20 }, (_, index) => ({
      name: `skill-${String(index).padStart(2, '0')}`,
      description: `skill description ${index}`,
      modelInvocable: true,
    }))
    const models = Array.from({ length: 100 }, (_, index) => ({
      provider: 'test',
      providerName: 'Test Provider',
      model: `model-${String(index).padStart(2, '0')}`,
      modelName: `Model ${String(index).padStart(2, '0')}`,
    }))
    const props = {
      store,
      subagents: { subscribe: () => unsubscribe, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: { subscribe: () => unsubscribe, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors, subscribe: () => unsubscribe },
      skills: { rows: skills, subscribe: () => unsubscribe },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: models, failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      cancelQueued: noop,
      onBridgeReady: noop,
    }
    const instance = render(createElement(App, { key: 'pending', ...props }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      output = ''
      stdout.write(resizeClear)
      instance.rerender(createElement(App, { key: 'session-7f3a', ...props }))
      await wait()

      // The deferred runner delivers the first input through the durable
      // inbox: queued insert → claim removal → durable user message.
      const first = createUserMessage({
        content: [{ type: 'text', text: 'build me a whale' }],
        source: { kind: 'user' },
      })
      store.apply({
        type: 'agent/inbox/spliced',
        seq: 1,
        time: 0,
        data: { target: 'next-turn', start: 0, inserted: [first] },
      } as SessionEvent)
      await wait()
      store.apply({
        type: 'agent/inbox/spliced',
        seq: 2,
        time: 0,
        data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
      } as SessionEvent)
      await wait()
      store.apply({ type: 'user/message', seq: 3, time: 0, data: first } as SessionEvent)
      await wait()

      // Ink's full-screen branch (dynamic frame >= terminal rows) rewrites
      // the exact physical screen every render: the accumulated static plus
      // the live frame. The durable message appears exactly once; a queued
      // row flushed to <Static> would have ghosted a second copy that only
      // a resize could erase.
      const screen = output.slice(output.lastIndexOf('\x1b[2J'))
      expect(screen.match(/build me a whale/g)).toHaveLength(1)
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})

describe('context stepless bar', () => {
  it('paints one proportional DeepSeek-blue run with the usage readout outside it', async () => {
    // The color assertions need truecolor ANSI output; force level 3 and
    // restore the baseline in the finally block.
    const originalChalkLevel = chalk.level
    chalk.level = 3
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
      columns: 140,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const unsubscribe = (): void => {}
    const noop = (): void => {}
    const store = createTranscriptStore()
    const callId = 'parse-tool' as CallId
    store.apply({ type: 'request/context', seq: 1, time: 1, data: { provider: 'p', model: 'm', contextWindow: 128_000 } } as SessionEvent)
    store.apply({
      type: 'request/header', seq: 2, time: 2,
      data: { header: { config: { provider: 'p', model: 'm' }, system: 'you are a helpful assistant' }, reason: 'initial' },
    } as unknown as SessionEvent)
    store.apply({ type: 'turn/start', seq: 3, time: 3, data: { turn: 1 } } as SessionEvent)
    store.apply({ type: 'step/start', seq: 4, time: 4, data: { turn: 1, step: 1 } } as SessionEvent)
    store.apply({
      type: 'user/message', seq: 5, time: 5,
      data: createUserMessage({ content: [{ type: 'text', text: 'please fix the failing test in the parser module' }], source: { kind: 'user' } }),
    } as SessionEvent)
    store.apply({
      type: 'assistant/message', seq: 6, time: 1_006,
      data: {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [
            { type: 'reasoning', text: 'the parser fails on empty input' },
            { type: 'text', text: 'done, fixed the parser' },
          ],
          source: { provider: 'p', model: 'm' },
        }),
        usage: { inputTokens: 100_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    } as unknown as SessionEvent)
    store.apply({
      type: 'tool/call', seq: 7, time: 2_000,
      data: { turn: 1, step: 1, callId, name: 'edit', arguments: '{"path":"src/parser.ts"}' },
    } as unknown as SessionEvent)
    store.apply({
      type: 'tool/result', seq: 8, time: 2_500,
      data: { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'patched the file' }], isError: false }) },
    } as unknown as SessionEvent)
    const instance = render(createElement(App, {
      store,
      subagents: { subscribe: () => unsubscribe, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: { subscribe: () => unsubscribe, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => unsubscribe,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => unsubscribe },
      skills: { rows: [], subscribe: () => unsubscribe },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      cancelQueued: noop,
      onBridgeReady: noop,
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // The stepless bar is purely proportional: the fill run tracks the
      // true occupancy and the dotted track shows the remainder. The usage
      // readout rides outside the bar; on this tight row the ladder has
      // already traded the absolute pair for meter resolution.
      const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '')
      expect(stripAnsi(output)).toMatch(/context [█░]+ 100K\/128K 78%/u)
      // The fill paints one brand-blue run; the dotted track reads dim.
      expect(output).toMatch(/38;2;65;118;230m[^\x1b]*█/) // ctxFill → brand
      // The drawn fill share tracks the reported percent within one column
      // of rounding at this meter width.
      const run = stripAnsi(output).match(/context ([█░]+)/u)
      const blocks = (run![1].match(/█/gu) || []).length
      const expectedFill = Math.round(100_000 / 128_000 * run![1].length)
      expect(Math.abs(blocks - expectedFill)).toBeLessThanOrEqual(1)
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
      chalk.level = originalChalkLevel
    }
  }, 15_000)
})

describe('light theme rendering', () => {
  // The active palette is process-global: the switch must survive into the
  // Ink paint path (statusToneProps and every direct token call site read
  // getPalette()), and the test must restore dark for its siblings.
  it('paints theme-aware tokens after a light switch', async () => {
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
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const noop = (): void => {}
    // vitest runs colorless (chalk level 0): force level 3 like the other
    // color-asserting App tests, and restore both chalk and the theme after.
    const originalChalkLevel = chalk.level
    chalk.level = 3
    setTheme('light')
    const instance = render(createElement(App, {
      store: createTranscriptStore(),
      subagents: { subscribe: () => noop, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: { subscribe: () => noop, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => noop,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => noop },
      skills: { rows: [], subscribe: () => noop },
      model: 'test/model',
      cwd: 'dsh-cli',
      workspaceRoot: 'C:\\repo\\dsh-cli',
      branch: 'main',
      sessionId: '12345678',
      resumed: false,
      mode: 'standard',
      permission: 'workspace-write',
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      subagentModel: '',
      setSubagentModel: () => '',
      clearSubagentModel: noop,
      deleteSession: async () => '',
      cycleMode: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSubagents: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
      loadJobs: () => [],
      statusline: DEFAULT_STATUSLINE_ITEMS,
      saveStatusline: noop,
      history: [],
      recordHistory: noop,
      cancelQueued: noop,
      onBridgeReady: noop,
    }), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    setTheme('light')
    try {
      await wait()
      // The model tone paints the LIGHT code cyan (14,116,144), not the dark
      // value (125,211,252): the mapping layer follows the palette.
      expect(output).toContain('38;2;14;116;144m')
      expect(output).not.toContain('38;2;125;211;252m')
      // The prompt marker and header keep their theme-aware brand blue.
      expect(output).toContain('38;2;65;118;230m')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
      chalk.level = originalChalkLevel
      setTheme('dark')
    }
  })
})

describe('settledRows incremental cache (pure)', () => {
  it('appends only the new suffix, keeps idle toggles clear-free, and rebuilds once on replay', () => {
    // 120 settled assistant rows, every 10th carrying reasoning.
    const base: TranscriptEntry[] = []
    for (let index = 0; index < 120; index++) {
      base.push(assistantEntry(`msg-${index}`, index % 10 === 0 ? 'trace' : ''))
    }
    let result = computeSettledRows(undefined, base, base.length, false, false, 0)
    expect(result.built).toBe(base.length)
    const firstFlat = result.cache.flat

    // Appending one settled row builds ONLY that row — the prefix is never
    // rescanned or rebuilt, and every existing element keeps identity.
    const grown = [...base, assistantEntry('msg-120')]
    result = computeSettledRows(result.cache, grown, grown.length, false, false, 0)
    expect(result.built).toBe(1)
    expect(result.cache.flat).not.toBe(firstFlat)
    for (let index = 0; index < firstFlat.length; index++) {
      expect(result.cache.flat[index]).toBe(firstFlat[index])
    }

    // No boundary change: the same flat identity is returned (Static skips).
    const flatBefore = result.cache.flat
    result = computeSettledRows(result.cache, grown, grown.length, false, false, 0)
    expect(result.built).toBe(0)
    expect(result.cache.flat).toBe(flatBefore)

    // The pure toggle step stays inert (App decides whether to trigger a
    // replay): the same Static element list remains intact.
    const flatBeforeToggle = result.cache.flat
    result = computeSettledRows(result.cache, grown, grown.length, true, false, 0)
    expect(result.built).toBe(0)
    expect(result.cache.flat).toBe(flatBeforeToggle)

    // A newly settled reasoning row captures the current mode.
    const expanded = [...grown, assistantEntry('msg-121', 'new trace')]
    result = computeSettledRows(result.cache, expanded, expanded.length, true, false, 0)
    expect(result.built).toBe(1)

    // Width changes update live geometry first; Static waits for the debounced
    // source-backed replay instead of rebuilding at an intermediate width.
    const flatBeforeResize = result.cache.flat
    result = computeSettledRows(result.cache, expanded, expanded.length, true, false, 0, 100)
    expect(result.built).toBe(0)
    expect(result.cache.flat).toBe(flatBeforeResize)
    expect(result.cache.columns).toBe(80)

    // Source-backed replay (epoch bump — resize, Ctrl+L, or an idle Ctrl+R):
    // full rebuild of the current rows UNIFORMLY at the current fold state.
    result = computeSettledRows(result.cache, expanded, expanded.length, true, false, 1, 100)
    expect(result.built).toBe(expanded.length)
    expect(result.cache.columns).toBe(100)
    expect(result.cache.showReasoning).toBe(true)
    expect(result.cache.flat.length).toBeGreaterThan(0)

    // Shrink (store.reset): the prefix truncates to empty.
    result = computeSettledRows(result.cache, [], 0, true, false, 1)
    expect(result.built).toBe(0)
    expect(result.cache.flat).toHaveLength(1)
  })
})

describe('settled tool/command name sanitization', () => {
  it('never writes raw OSC/CSI control bytes from a malicious tool or command name; renders the escaped literal', async () => {
    const harness = createTty()
    const { stdin, stdout, output } = harness
    // A tool name carrying an OSC-0 title hijack (+ BEL) and a command name
    // carrying a CSI clear-screen. Everything is seeded BEFORE the first
    // render, so the rows settle straight into <Static> and the only paint
    // path is the settled EntryLine (the running live region is a separate
    // surface).
    const oscTool = 'evil\x1b]0;pwned\x07fetch'
    const csiCommand = 'wipe\x1b[2Jfetch'
    const toolCallId = 'evil-tool' as CallId
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
      } as SessionEvent,
      {
        type: 'tool/call',
        seq: 2,
        time: 2,
        data: { turn: 1, step: 1, callId: toolCallId, name: oscTool, arguments: '{}' },
      } as SessionEvent,
      {
        type: 'tool/result',
        seq: 3,
        time: 3,
        data: {
          turn: 1,
          step: 1,
          message: createToolResultMessage({ callId: toolCallId, content: [{ type: 'text', text: 'ok' }], isError: false }),
        },
      } as SessionEvent,
      {
        type: 'command/run',
        seq: 4,
        time: 4,
        data: { commandId: 'evil-command', name: csiCommand, args: '--x' },
      } as SessionEvent,
      {
        type: 'command/done',
        seq: 5,
        time: 5,
        data: { commandId: 'evil-command', kind: 'success', text: 'done' },
      } as SessionEvent,
    ])
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      // The sanitized literals reach the terminal as visible `\xNN` text.
      expect(output.text).toContain('evil\\x1b]0;pwned\\x07fetch')
      expect(output.text).toContain('wipe\\x1b[2Jfetch')
      // The raw control sequences (OSC title hijack, CSI clear-screen) never
      // reach the terminal bytes.
      expect(output.text).not.toContain('evil\x1b]0;pwned\x07fetch')
      expect(output.text).not.toContain('wipe\x1b[2Jfetch')
      // The app writes exactly one managed tab-title OSC-0 itself
      // (terminal-title.ts), whose payload is sanitized free of control
      // bytes; in this fixture that is the "deepseek" default. Any OSC-0
      // beyond that well-formed managed sequence — in particular one riding
      // untrusted tool or command names — never reaches the terminal bytes.
      const titleOsc = /\x1b\]0;([^\x07\u0000-\u001F\u007F]*)\x07/g
      const payloads = [...output.text.matchAll(titleOsc)].map(match => match[1]!)
      expect(payloads.length).toBeGreaterThan(0)
      for (const payload of payloads) {
        expect(payload).toBe(DEFAULT_TERMINAL_TITLE)
      }
      expect(output.text.replace(titleOsc, '')).not.toContain('\x1b]0;')
      // The safe remainder of the names still renders.
      expect(output.text).toContain('evil')
      expect(output.text).toContain('wipe')
      expect(output.text).toContain('fetch')
      expect(output.text).toContain('done')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})

describe('incremental settled transcript cache', () => {
  it('shows a command/done replacement and later appends inside one settled history without ghosting', async () => {
    const harness = createTty()
    const { stdin, stdout, output } = harness
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
      } as SessionEvent,
      {
        type: 'command/run',
        seq: 2,
        time: 2,
        data: { commandId: 'lint', name: 'lint', args: 'src' },
      } as SessionEvent,
    ])
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      // While the command runs it stays in the LIVE mutable tail (a flush
      // boundary), rendering exactly one row — it never flushes to <Static>.
      expect(output.text.match(/\/lint/g)).toHaveLength(1)

      // command/done resolves the entry: it now settles, and the summary
      // appears IMMEDIATELY (the cache append path flushes the resolved
      // row) — no resize needed — exactly once.
      store.apply({
        type: 'command/done',
        seq: 3,
        time: 3,
        data: { commandId: 'lint', kind: 'success', text: 'lint passed' },
      } as SessionEvent)
      await wait()
      expect(output.text.match(/lint passed/g)).toHaveLength(1)

      // A later source-backed replay (resize) re-flushes the CURRENT row set:
      // the resolved command still appears exactly once in the rebuilt slice
      // — no ghost of the running copy.
      stdout.columns = 80
      stdout.emit('resize')
      await wait()
      expect(output.text.match(/\x1b\[2J/g)).toHaveLength(1)
      const rebuilt = output.text.slice(output.text.lastIndexOf(resizeClear) + resizeClear.length)
      expect(rebuilt).toContain('lint passed')
      expect(rebuilt.match(/lint passed/g)).toHaveLength(1)
      expect(rebuilt.match(/\/lint/g)).toHaveLength(1)

      // Later appends settle after the existing prefix; the append path adds
      // only the new rows and never re-emits the resolved command.
      const lintBefore = output.text.match(/lint passed/g)!.length
      store.apply({
        type: 'user/message',
        seq: 4,
        time: 4,
        data: createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }),
      } as SessionEvent)
      store.apply({
        type: 'assistant/message',
        seq: 5,
        time: 5,
        data: {
          turn: 1,
          step: 2,
          message: createAssistantMessage({ content: [{ type: 'text', text: 'done again' }], source: { provider: 'p', model: 'm' } }),
        },
      } as SessionEvent)
      await wait()
      expect(output.text).toContain('done again')
      expect(output.text.match(/done again/g)).toHaveLength(1)
      expect(output.text.match(/lint passed/g)!.length).toBe(lintBefore)
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('flushes a long settled history once and replays it exactly once per source-backed refresh', async () => {
    const harness = createTty()
    const { stdin, stdout, output } = harness
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }),
      } as SessionEvent,
      ...Array.from({ length: 120 }, (_, index) => ({
        type: 'assistant/message',
        seq: index + 2,
        time: index + 2,
        data: {
          turn: 1,
          step: index + 1,
          message: createAssistantMessage({ content: [{ type: 'text', text: `msg-${index}` }], source: { provider: 'p', model: 'm' } }),
        },
      }) as SessionEvent),
    ])
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      // Every settled row flushed through <Static> exactly once.
      expect(output.text.match(/msg-\d+/g)).toHaveLength(120)

      // A resize triggers one source-backed replay: one clear, then the FULL
      // history re-flushes once (no ghosts, no duplicates, no lost rows).
      output.text = ''
      stdout.columns = 80
      stdout.emit('resize')
      await wait()
      expect(output.text.match(/\x1b\[2J/g)).toHaveLength(1)
      const rebuilt = output.text.slice(output.text.lastIndexOf(resizeClear) + resizeClear.length)
      expect(rebuilt.match(/msg-\d+/g)).toHaveLength(120)
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})

describe('queued inbox rows in a mixed mutable tail', () => {
  it('collects pending rows across a running tool and cancels newest-first', async () => {
    const harness = createTty()
    const { stdin, stdout, output } = harness
    const cancelled: string[] = []
    const store = createTranscriptStore()
    const first = createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } })
    const second = createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } })
    const third = createUserMessage({ content: [{ type: 'text', text: 'three' }], source: { kind: 'user' } })
    // Mirror the runner's cancel path: the durable splice retires the pending
    // row, so the next Delete sees a shrunken queue (newest-first).
    const retire = (id: string): void => {
      cancelled.push(id)
      const index = [first.id, second.id, third.id].indexOf(id)
      store.apply({
        type: 'agent/inbox/spliced',
        seq: 100,
        time: 100,
        data: { target: 'next-turn', start: index, removedCount: 1, inserted: [] },
      } as SessionEvent)
    }
    const callId = 'live-tool' as CallId
    // Pending rows are NOT a contiguous tail: a running tool row sits between
    // the first pending row and the rest, so a naive "scan from the end until
    // the first non-pending" would lose `one`.
    store.apply({
      type: 'agent/inbox/spliced',
      seq: 1,
      time: 1,
      data: { target: 'next-turn', start: 0, inserted: [first] },
    } as SessionEvent)
    store.apply({
      type: 'tool/call',
      seq: 2,
      time: 2,
      data: { turn: 1, step: 1, callId, name: 'live', arguments: '{}' },
    } as SessionEvent)
    store.apply({
      type: 'agent/inbox/spliced',
      seq: 3,
      time: 3,
      data: { target: 'next-turn', start: 1, inserted: [second] },
    } as SessionEvent)
    store.apply({
      type: 'agent/inbox/spliced',
      seq: 4,
      time: 4,
      data: { target: 'next-turn', start: 2, inserted: [third] },
    } as SessionEvent)
    const instance = renderApp(harness, appProps({ store, cancelQueued: retire }))
    try {
      await wait()
      // Delete on the empty composer cancels the NEWEST queued message each
      // time; all three pending rows must be collected even though a running
      // tool row splits the mutable tail.
      stdin.write('\x1b[3~')
      await wait()
      stdin.write('\x1b[3~')
      await wait()
      stdin.write('\x1b[3~')
      await wait()
      expect(cancelled).toEqual([third.id, second.id, first.id])
      expect(output.text).not.toContain('\x1b[2J')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})

describe('completion menu', () => {
  it('accepts a slash command on Tab and keeps the draft editable immediately afterward', async () => {
    const harness = createTty(100, 24)
    const dispatch = vi.fn()
    const instance = renderApp(harness, appProps({
      dispatch,
      commands: {
        descriptors: [{ name: 'command-00', description: 'registry command' }],
        subscribe: () => unsubscribe,
      },
    }))
    try {
      await wait()
      harness.stdin.write('/command-0')
      await wait()
      // A terminal may coalesce Tab and the first argument into one read.
      harness.stdin.write('\targ')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(dispatch).toHaveBeenCalledWith('/command-00 arg')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('accepts Kitty CSI-u Tab without leaking the sequence or locking the editor', async () => {
    const harness = createTty(100, 24)
    const dispatch = vi.fn()
    const instance = renderApp(harness, appProps({
      dispatch,
      commands: {
        descriptors: [{ name: 'command-00', description: 'registry command' }],
        subscribe: () => unsubscribe,
      },
    }))
    try {
      await wait()
      harness.stdin.write('/command-0')
      await wait()
      // The same coalescing can happen after Kitty CSI-u normalization.
      harness.stdin.write('\x1b[9uarg')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(dispatch).toHaveBeenCalledWith('/command-00 arg')
      expect(harness.output.text).not.toContain('[9u')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('accepts the highlighted candidate on Enter (Codex list parity with Tab)', async () => {
    const harness = createTty(100, 24)
    const dispatch = vi.fn()
    const instance = renderApp(harness, appProps({
      dispatch,
      commands: {
        descriptors: [{ name: 'command-00', description: 'registry command' }],
        subscribe: () => unsubscribe,
      },
    }))
    try {
      await wait()
      harness.stdin.write('/command-0')
      await wait()
      // The menu is open and nothing has been submitted yet.
      expect(harness.output.text).toContain('/command-00')
      harness.stdin.write('\r')
      await wait()
      expect(dispatch).not.toHaveBeenCalled()
      // The accepted candidate landed in the composer with its trailing
      // space; the second return submits it through the registry path.
      harness.stdin.write('\r')
      await wait()
      expect(dispatch).toHaveBeenCalledWith('/command-00')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})

describe('prompt fidelity', () => {
  it('dispatches an ordinary pasted prompt with its exact indentation and line breaks', async () => {
    const harness = createTty(100, 24)
    const dispatch = vi.fn()
    const instance = renderApp(harness, appProps({ dispatch }))
    try {
      await wait()
      // Bracketed paste of indented code: the leading spaces and the inner
      // newline are content, not noise — the composer must forward the draft
      // verbatim instead of the trimmed form.
      harness.stdin.write('\x1b[200~  if cond:\n    run()\x1b[201~')
      await wait(180)
      harness.stdin.write('\r')
      await wait()
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(dispatch).toHaveBeenCalledWith('  if cond:\n    run()')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('still routes a slash line whose draft carries the completion trailing space', async () => {
    const harness = createTty(100, 24)
    const dispatch = vi.fn()
    const instance = renderApp(harness, appProps({ dispatch }))
    try {
      await wait()
      harness.stdin.write('/help ')
      await wait()
      harness.stdin.write('\r')
      await wait()
      // '/help ' is a local TUI action: the trimmed command routes to the
      // overlay, never to dispatch.
      expect(dispatch).not.toHaveBeenCalled()
      expect(harness.output.text).toContain('/help — keys and commands')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})

describe('short-terminal surfaces', () => {
  it('keeps the approval ask visible and answerable on an 8-row terminal', async () => {
    const harness = createTty(100, 8)
    const answers: string[] = []
    const snapshot = Object.freeze({
      pending: {
        headline: 'run the build?',
        toolName: 'bash',
        command: 'pnpm build',
        answer: (outcome: string): void => {
          answers.push(outcome)
        },
      },
      answered: false,
      queued: 0,
    })
    const instance = renderApp(harness, appProps({
      approval: { subscribe: () => unsubscribe, getSnapshot: () => snapshot },
    }))
    try {
      await wait()
      // The ask never disappears: one line states the absolute decisions.
      expect(harness.output.text).toContain('approval')
      expect(harness.output.text).toContain('y allow')
      harness.stdin.write('y')
      await wait()
      expect(answers).toEqual(['allowed-once'])
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('disables blind question picks when the options cannot render', async () => {
    const harness = createTty(100, 8)
    const submit = vi.fn()
    const cancel = vi.fn()
    const pending = {
      request: { questions: [{ id: 'pick', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] },
      resolve: noop,
      reject: noop,
    } as unknown as PendingQuestion
    const snapshot: QuestionSnapshot = { pending }
    const instance = renderApp(harness, appProps({
      questions: { subscribe: () => unsubscribe, getSnapshot: () => snapshot, submit, cancel },
    }))
    try {
      await wait()
      expect(harness.output.text).toContain('question · esc cancel')
      // Digit picks are disabled: the options are not on screen, so a blind
      // answer must not fire.
      harness.stdin.write('1')
      await wait()
      expect(submit).not.toHaveBeenCalled()
      expect(cancel).not.toHaveBeenCalled()
      harness.stdin.write('')
      await wait()
      expect(cancel).toHaveBeenCalledTimes(1)
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})

describe('mention discovery failures', () => {
  it('shows an explicit unavailable row instead of an empty menu when the search fails', async () => {
    const harness = createTty(100, 24)
    const instance = renderApp(harness, appProps({
      loadMentions: async () => {
        throw new Error('index offline')
      },
    }))
    try {
      await wait()
      harness.stdin.write('@src')
      await wait(200)
      expect(harness.output.text).toContain('workspace search unavailable')
      expect(harness.output.text).toContain('index offline')
      expect(harness.output.text).toContain('keep typing to retry')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})

describe('/agents panel', () => {
  it('opens from the composer and lists live feed rows with transcript entry', async () => {
    const agents = [
      Object.freeze({ id: 'child-session-1', label: 'explorer', state: 'running' as const, activity: 'tool grep', updatedAt: 3 }),
    ]
    const harness = createTty(100, 24)
    const instance = renderApp(harness, appProps({
      subagents: { subscribe: () => unsubscribe, getSnapshot: () => agents, getTotalSeen: () => agents.length },
      loadSubagents: async () => [{
        id: 'child-session-2', createdAt: 2, cwd: 'C:\\repo', workspace: 'repo',
        parent: 'root', subagent: true, resumable: false, live: false, persisted: true, preset: 'standard',
      }],
    }))
    try {
      await wait()
      expect(harness.output.text).toContain('agents 1 live')
      harness.stdin.write('/agents')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('/agents · 1 live · 2 total')
      expect(harness.output.text).toContain('explorer · tool grep · live')
      harness.stdin.write('q')
      await wait()
      expect(harness.output.text.lastIndexOf('type a message')).toBeGreaterThan(harness.output.text.lastIndexOf('/agents ·'))
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})

describe('/todos subpage', () => {
  it('opens the full todo list in a bounded scrollable panel and closes on q', async () => {
    const todos: TodoItem[] = Array.from({ length: 30 }, (_, index) => ({
      content: `todo-${String(index).padStart(2, '0')}`,
      status: index < 10 ? 'completed' : index < 20 ? 'in_progress' : 'pending',
    }))
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'track work' }], source: { kind: 'user' } }),
      } as SessionEvent,
      { type: 'todo/write', seq: 2, time: 2, data: { todos } } as SessionEvent,
    ])
    const harness = createTty(100, 24)
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      // The live summary line shows the counts and points at the subpage.
      expect(harness.output.text).toContain('todos 10/30')
      expect(harness.output.text).toContain('/todos')

      harness.stdin.write('/todos')
      await wait()
      // Drop the keystroke frames so the newline count measures the panel's
      // own frame only (same discipline as the Ctrl+O bounded-panel test).
      harness.output.text = ''
      harness.stdin.write('\r')
      await wait()
      const opened = harness.output.text
      expect(opened).toContain('todos · 10/30 done · 10 active · 10 pending')
      expect(opened).toContain('todo-00')
      // The panel stays strictly below the terminal height (the shared
      // viewport contract: at equality Ink clears and rewrites every frame),
      // and opening it never clears or replays the screen.
      const terminalRows = (harness.stdout as unknown as { rows?: number }).rows ?? 24
      expect(opened.split('\n').length).toBeLessThan(terminalRows)
      expect(opened).not.toContain('\x1b[2J')

      // G jumps to the tail, g back to the head; both stay inside the panel.
      harness.stdin.write('G')
      await wait()
      expect(harness.output.text).toContain('todo-29')
      harness.stdin.write('g')
      await wait()
      expect(harness.output.text).toContain('todo-00')

      // q closes the panel and the composer regains focus (the closing frame
      // repaints the composer after the panel's last frame).
      harness.stdin.write('q')
      await wait()
      expect(harness.output.text.lastIndexOf('type a message')).toBeGreaterThan(
        harness.output.text.lastIndexOf('todos · 10/30 done · 10 active'),
      )
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})

describe('approval dialog', () => {
  it('renders the Codex-style option list and answers through quick keys', async () => {
    const answers: string[] = []
    const snapshot = Object.freeze({
      pending: {
        headline: 'run the build?',
        toolName: 'bash',
        command: 'pnpm build',
        answer: (outcome: string): void => {
          answers.push(outcome)
        },
      },
      answered: false,
      queued: 0,
    })
    const harness = createTty(100, 24)
    const instance = renderApp(harness, appProps({
      approval: { subscribe: () => unsubscribe, getSnapshot: () => snapshot },
    }))
    try {
      await wait()
      expect(harness.output.text).toContain('run the build?')
      expect(harness.output.text).toContain('pnpm build')
      expect(harness.output.text).toContain('1. Yes, proceed (y)')
      expect(harness.output.text).toContain('2. No, and tell it what to do differently (n)')
      expect(harness.output.text).toContain('3. No, continue without running it (d)')
      harness.stdin.write('y')
      await wait()
      expect(answers).toEqual(['allowed-once'])
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('confirms the default selection on Enter and rejects on Esc', async () => {
    const answers: string[] = []
    const snapshot = Object.freeze({
      pending: {
        headline: 'run the build?',
        toolName: 'bash',
        command: 'pnpm build',
        answer: (outcome: string): void => {
          answers.push(outcome)
        },
      },
      answered: false,
      queued: 0,
    })
    const harness = createTty(100, 24)
    const instance = renderApp(harness, appProps({
      approval: { subscribe: () => unsubscribe, getSnapshot: () => snapshot },
    }))
    try {
      await wait()
      // Enter confirms the default-selected first option (Yes).
      harness.stdin.write('\r')
      await wait()
      expect(answers).toEqual(['allowed-once'])
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
    const second = createTty(100, 24)
    const answers2: string[] = []
    const snapshot2 = Object.freeze({
      pending: {
        headline: 'run the build?',
        toolName: 'bash',
        command: 'pnpm build',
        answer: (outcome: string): void => {
          answers2.push(outcome)
        },
      },
      answered: false,
      queued: 0,
    })
    const instance2 = renderApp(second, appProps({
      approval: { subscribe: () => unsubscribe, getSnapshot: () => snapshot2 },
    }))
    try {
      await wait()
      // Esc is Codex's cancel: an explicit rejection.
      second.stdin.write('\x1b')
      await wait()
      expect(answers2).toEqual(['rejected'])
    } finally {
      instance2.unmount()
      second.stdin.destroy()
      second.stdout.destroy()
    }
  })
})

describe('/delete and /subagent', () => {
  it('opens the resume picker in delete mode and confirms a deletion with y', async () => {
    const harness = createTty(100, 24)
    const removed: string[] = []
    const instance = renderApp(harness, appProps({
      loadSessions: async () => [{
        id: 's-1', createdAt: 1, updatedAt: 1, cwd: 'C:\\repo', workspace: 'repo',
        subagent: false, resumable: true, live: false, persisted: true, preset: 'standard',
      }],
      deleteSession: async (id: string) => {
        removed.push(id)
        return 'deleted 1 session'
      },
    }))
    try {
      await wait()
      harness.stdin.write('/delete')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('delete mode')
      harness.stdin.write('d')
      await wait()
      // The confirm prompt moves into the composer box (warn-styled).
      expect(harness.output.text).toContain('permanently delete')
      expect(harness.output.text).toContain('y delete · any other key cancels')
      harness.stdin.write('y')
      await wait()
      expect(removed).toEqual(['s-1'])
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('opens /subagent with the inherit row and applies a picked override', async () => {
    const harness = createTty(100, 24)
    const applied: string[] = []
    const instance = renderApp(harness, appProps({
      subagentModel: '',
      loadModels: async () => ({
        rows: [{ provider: 'acme', providerName: 'Acme', model: 'plain', modelName: 'Plain' }],
        failures: [],
      }),
      setSubagentModel: (row: { provider: string; model: string }) => {
        applied.push(`${row.provider}/${row.model}`)
        return `${row.provider}/${row.model}`
      },
    }))
    try {
      await wait()
      harness.stdin.write('/subagent')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('/subagent — model for delegated agents')
      expect(harness.output.text).toContain('inherit')
      harness.stdin.write('\x1b[B')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(applied).toEqual(['acme/plain'])
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})

describe('dsh kernel header line', () => {
  it('prepends the resolved kernel version above the title without extra chrome', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-kernel-header-'))
    const hostDir = join(root, '@deepseek-ai', 'dsh')
    mkdirSync(join(hostDir, 'lib'), { recursive: true })
    writeFileSync(join(hostDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' }))
    const previousArgv = process.argv[1]
    process.argv[1] = join(hostDir, 'lib', 'bin.js')
    _resetDshKernelVersionForTests()
    const harness = createTty(120, 30)
    try {
      const instance = renderApp(harness, appProps())
      try {
        await wait()
        const text = harness.output.text
        expect(text).toContain('dsh-v0.1.1-rc.2')
        expect(text.indexOf('dsh-v0.1.1-rc.2')).toBeLessThan(text.indexOf(`DeepSeek Harness · v${DSH_CODE_VERSION}`))
        expect(text).toContain('Into the Unknown  探索未至之境')
      } finally {
        instance.unmount()
      }
    } finally {
      harness.stdin.destroy()
      harness.stdout.destroy()
      process.argv[1] = previousArgv
      _resetDshKernelVersionForTests()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the historical three-line lockup when no host manifest resolves', async () => {
    const harness = createTty(120, 30)
    try {
      const instance = renderApp(harness, appProps())
      try {
        await wait()
        expect(harness.output.text).not.toContain('dsh-v')
        expect(harness.output.text).toContain(`DeepSeek Harness · v${DSH_CODE_VERSION}`)
      } finally {
        instance.unmount()
      }
    } finally {
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})

describe('composer band', () => {
  it('paints a three-row background band instead of a border with the draft on the middle row', async () => {
    const originalChalkLevel = chalk.level
    chalk.level = 3
    const harness = createTty(100, 24)
    const band = DARK_PALETTE.composerBand
    const bandSeq = `\u001b[48;2;${band[0]};${band[1]};${band[2]}m`
    try {
      const instance = renderApp(harness, appProps())
      try {
        await wait()
        harness.stdin.write('banded')
        await wait()
        const lines = harness.output.text.split('\n')
        const row = lines.findIndex(line => line.includes('banded'))
        expect(row).toBeGreaterThanOrEqual(0)
        // The draft row plus one blank band row above and below: three
        // consecutive rows carry the band background, no border glyphs.
        expect(lines[row]).toContain(bandSeq)
        expect(lines[row - 1]).toContain(bandSeq)
        expect(lines[row + 1]).toContain(bandSeq)
        expect(lines[row]).not.toContain('│')
        expect(lines[row - 1]).not.toContain('╭')
        expect(lines[row + 1]).not.toContain('╰')
      } finally {
        instance.unmount()
      }
    } finally {
      harness.stdin.destroy()
      harness.stdout.destroy()
      chalk.level = originalChalkLevel
    }
  })
})

describe('settled row cap window', () => {
  // One short assistant entry renders as exactly one physical row at 80 cols.
  const one = (text: string): TranscriptEntry => assistantEntry(text)

  it('rebuild keeps whole newest entries within the cap and reports the dropped count', () => {
    const entries = Array.from({ length: 20 }, (_, index) => one(`m${index}`))
    // Budget = cap - reserve(12): cap 20 leaves 8 rows -> newest 8 entries stay.
    const result = computeSettledRows(undefined, entries, entries.length, false, false, 0, 80, 20)
    expect(result.built).toBe(8)
    expect(result.cache.droppedEntries).toBe(12)
    expect(result.cache.entries).toHaveLength(8)
    expect(result.cache.totalRows).toBe(8)
    expect(result.cache.needsTrim).toBe(false)
    // flat = header + trim hint + the 8 window rows.
    expect(result.cache.flat).toHaveLength(1 + 1 + 8)
    expect(result.cache.flat[1]!.key).toBe('history-cap-hint')
  })

  it('append only accounts rows; the epoch-bump replay performs the actual drop', () => {
    const tight = Array.from({ length: 30 }, (_, index) => one(`t${index}`))
    // Capped rebuild (cap 30, budget 18): 18 stay, 2 drop, hint present.
    let state = computeSettledRows(undefined, tight.slice(0, 20), 20, false, false, 0, 80, 30)
    expect(state.cache.entries).toHaveLength(18)
    expect(state.cache.droppedEntries).toBe(2)
    expect(state.cache.flat).toHaveLength(1 + 1 + 18)
    // Growing inside cap + 25% hysteresis never trims: rows append, head stays.
    // (The window holds 28 of 30 — the 2 dropped at rebuild stay dropped.)
    state = computeSettledRows(state.cache, tight, tight.length, false, false, 0, 80, 30)
    expect(state.cache.needsTrim).toBe(false)
    expect(state.cache.entries).toHaveLength(28)
    expect(state.cache.totalRows).toBe(28)
    // Crossing cap + 25% (40 > 37) only flags the cache for a trimming replay.
    const big = [...tight, ...Array.from({ length: 12 }, (_, index) => one(`b${index}`))]
    state = computeSettledRows(state.cache, big, big.length, false, false, 0, 80, 30)
    expect(state.cache.needsTrim).toBe(true)
    expect(state.cache.entries).toHaveLength(40)
    expect(state.cache.flat).toHaveLength(1 + 1 + 40)
    // The replay (epoch bump) re-windows: back to the cap, flag cleared.
    state = computeSettledRows(state.cache, big, big.length, false, false, 1, 80, 30)
    expect(state.cache.needsTrim).toBe(false)
    expect(state.cache.entries).toHaveLength(18)
    expect(state.cache.droppedEntries).toBe(24)
    expect(state.cache.totalRows).toBe(18)
    expect(state.cache.flat).toHaveLength(1 + 1 + 18)
  })

  it('cap 0 disables windowing entirely', () => {
    const entries = Array.from({ length: 50 }, (_, index) => one(`m${index}`))
    const result = computeSettledRows(undefined, entries, entries.length, false, false, 0, 80, 0)
    expect(result.cache.entries).toHaveLength(50)
    expect(result.cache.droppedEntries).toBe(0)
    expect(result.cache.flat).toHaveLength(1 + 50)
    expect(result.cache.needsTrim).toBe(false)
  })

  it('the fold toggle preserves the window bookkeeping', () => {
    const entries = Array.from({ length: 20 }, (_, index) => one(`m${index}`))
    const capped = computeSettledRows(undefined, entries, entries.length, false, false, 0, 80, 20)
    const toggled = computeSettledRows(capped.cache, entries, entries.length, true, false, 0, 80, 20)
    expect(toggled.cache.droppedEntries).toBe(capped.cache.droppedEntries)
    expect(toggled.cache.totalRows).toBe(capped.cache.totalRows)
    expect(toggled.cache.flat).toBe(capped.cache.flat)
  })
})

describe('composer recall history', () => {
  it('records typed slash commands and prompts into one shared history', async () => {
    const harness = createTty()
    const { stdin } = harness
    const recorded: string[] = []
    const instance = renderApp(harness, appProps({
      store: createTranscriptStore(),
      recordHistory: text => {
        recorded.push(text)
      },
    }))
    try {
      await wait()
      // A plain prompt first.
      stdin.write('hello world')
      await wait()
      stdin.write('\r')
      await wait()
      // A typed slash command keeps the completion menu open, so dismiss
      // it with Esc before submitting the line.
      stdin.write('/copy')
      await wait()
      stdin.write('\x1b')
      await wait()
      stdin.write('\r')
      await wait()
      expect(recorded).toEqual(['hello world', '/copy'])
      // Up recalls the command (with the completion menu suppressed for
      // the recalled text) and the next Up walks past it to the older
      // prompt - either text edge is a valid recall position. Submitting
      // then records the walked-to prompt.
      stdin.write('\x1b[A')
      await wait()
      stdin.write('\x1b[A')
      await wait()
      stdin.write('\r')
      await wait()
      expect(recorded[recorded.length - 1]).toBe('hello world')
    } finally {
      instance.unmount()
      stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('re-asserts the tab title when the terminal regains focus', async () => {
    vi.stubEnv('TERM_PROGRAM', 'vscode')
    vi.stubEnv('VSCODE_INJECTION', '1')
    const harness = createTty()
    const instance = renderApp(harness, appProps())
    try {
      await wait()
      expect(harness.output.text).toContain('\x1b]0;deepseek\x07')
      // A background worker sharing the console overwrote the title while
      // the terminal was unfocused; focus-in re-asserts the managed label.
      harness.output.text = ''
      harness.stdin.write('\x1b[I')
      await wait()
      expect(harness.output.text).toContain('\x1b]0;deepseek\x07')
    } finally {
      instance.unmount()
      vi.unstubAllEnvs()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})
