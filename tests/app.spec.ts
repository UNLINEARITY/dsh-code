/** App-level Ctrl+O rendering regression over real Node streams. */

import { PassThrough } from 'node:stream'
import chalk from 'chalk'
import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage, type CallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { App, computeSettledRows, type AppProps } from '../src/app.ts'
import { createTranscriptStore } from '../src/store.ts'
import type { TranscriptEntry } from '../src/render/projection.ts'
import { DEFAULT_STATUSLINE_ITEMS } from '../src/render/status.ts'
import { setTheme } from '../src/theme.ts'
import { DSH_CODE_VERSION } from '../src/version.ts'

const wait = async (): Promise<void> => new Promise(resolve => setTimeout(resolve, 100))
const resizeClear = '\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H'
// useSyncExternalStore compares getSnapshot results by identity: these
// doubles must return one frozen object forever, or React spins into an
// infinite re-render loop (Maximum update depth exceeded).
const approvalSnapshot = Object.freeze({ pending: undefined, answered: false })
const questionSnapshot = Object.freeze({ pending: undefined })
const unsubscribe = (): void => {}
const noop = (): void => {}

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
    cyclePermission: () => '',
    setPermission: id => id,
    exportTranscript: async () => {},
    renameTitle: () => '',
    loadPresets: async () => [],
    loadPermissions: async () => [],
    switchMode: async id => id,
    createSession: noop,
    loadSessions: async () => [],
    loadSessionTranscript: async () => '',
    switchSession: noop,
    cancelSessionSwitch: () => false,
    loadPlugins: () => [],
    statusline: DEFAULT_STATUSLINE_ITEMS,
    saveStatusline: noop,
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
    const cyclePermission = vi.fn(() => 'danger-full-access')
    const instance = renderApp(harness, appProps({
      sessionId: '',
      mode: 'standard',
      permission: 'workspace-write',
      dispatch,
      switchMode,
      setPermission,
      cyclePermission,
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
      expect(cyclePermission).toHaveBeenCalledOnce()

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
})

describe('Ctrl+O history details', () => {
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
      cyclePermission: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
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
      store.apply({
        type: 'assistant/chunk',
        seq: 2,
        time: 2,
        data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking\n'.repeat(1_000) } },
      } as SessionEvent)
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
      expect(output.lastIndexOf('type a message')).toBeLessThan(output.lastIndexOf('test/model'))
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
      expect(output.lastIndexOf('type a message')).toBeLessThan(output.lastIndexOf('test/model'))
      expect(output).not.toContain('\x1b[2J')

      output = ''
      stdin.write('G')
      await wait()
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
      cyclePermission: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
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

      // /model → jump to the bottom (the DeepSeek row) → select it. The
      // deepseek tier runs the readability-extended 1.5s Wave-Ultra sweep.
      output = ''
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('G')
      await wait()
      stdin.write('\r')
      await wait()

      const label = 'deepseek-official/deepseek-reasoner'
      expect(output).toContain(label)
      // The persistent prompt marker switched to the deepseek tier glyph » in
      // the tier accent (brandBright in the dark palette) — no border wave.
      expect(output).toContain('»')
      expect(output).not.toContain('48;2;')

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
      // sparkles — the row returns to transparent (no `backgroundColor`).
      await sleep(900)
      const settled = output.length
      await sleep(400)
      const settledDelta = output.slice(settled)
      expect(settledDelta).not.toMatch(/48;2;/)
      expect(settledDelta).not.toContain('✦')

      // Switch away from DeepSeek: the prompt restores the static brand ❯ and
      // drops the » glyph — the tier accent is not sticky on other routes.
      // The panel-open frames still show the tier » in the frozen composer,
      // so the brand ❯ must be the LAST prompt painted after the selection.
      output = ''
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      const away = output.length
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
})

describe('Ctrl+R reasoning fold', () => {
  it('re-renders settled history through one clear-and-replay on toggle', async () => {
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
      cyclePermission: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
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
      expect(output).toContain('Ctrl+R to expand')
      expect(output).not.toContain('the hidden reasoning trace')

      output = ''
      stdin.write('\x12')
      await wait()
      // One source-backed replay: a single clear sequence, then the settled
      // history re-flushes with reasoning expanded.
      expect(output.match(/\x1b\[2J/g)).toHaveLength(1)
      expect(output).toContain('the hidden reasoning trace')
      expect(output).toContain('the visible answer')

      output = ''
      stdin.write('\x12')
      await wait()
      expect(output.match(/\x1b\[2J/g)).toHaveLength(1)
      expect(output).toContain('Ctrl+R to expand')
      const clearAt = output.lastIndexOf('\x1b[2J')
      expect(clearAt).toBeGreaterThanOrEqual(0)
      expect(output.slice(clearAt).includes('the hidden reasoning trace')).toBe(false)
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
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
      cyclePermission: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
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
      cyclePermission: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
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
  it('paints one DeepSeek-blue run per content type with the usage readout', async () => {
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
      cyclePermission: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
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
      // The stepless bar: one solid fill run, dim dotted track, and the
      // right-aligned readout, all on one primary-row budget.
      const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '')
      expect(stripAnsi(output)).toContain('███████████████████░░78%')
      // The fill paints one brand-blue run; the dotted track reads dim.
      expect(output).toMatch(/38;2;65;118;230m[^\x1b]*█/) // ctxFill → brand
      expect(output).toMatch(/38;2;129;133;140m[^\x1b]*░/) // track → dim gray
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
      cyclePermission: () => '',
      setPermission: id => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async id => id,
      createSession: noop,
      loadSessions: async () => [],
      loadSessionTranscript: async () => '',
      switchSession: noop,
      cancelSessionSwitch: () => false,
      loadPlugins: () => [],
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
  it('appends only the new suffix after a long history, reuses elements, and rebuilds targeted rows on toggle/replay', () => {
    // 120 settled assistant rows; every 10th carries reasoning (12 sensitive).
    const base = Array.from({ length: 120 }, (_, index) => assistantEntry(`msg-${index}`, index % 10 === 0 ? 'trace' : ''))
    let result = computeSettledRows(undefined, base, 120, false, false, 0)
    expect(result.built).toBe(120)
    const firstFlat = result.cache.flat

    // Appending one settled row builds ONLY that row — the 120-row prefix is
    // never rescanned or rebuilt, and every existing element keeps identity.
    const grown = [...base, assistantEntry('msg-120')]
    result = computeSettledRows(result.cache, grown, 121, false, false, 0)
    expect(result.built).toBe(1)
    expect(result.cache.flat).not.toBe(firstFlat)
    for (let index = 0; index < firstFlat.length; index++) {
      expect(result.cache.flat[index]).toBe(firstFlat[index])
    }

    // No boundary change: the same flat identity is returned (Static skips).
    const flatBefore = result.cache.flat
    result = computeSettledRows(result.cache, grown, 121, false, false, 0)
    expect(result.built).toBe(0)
    expect(result.cache.flat).toBe(flatBefore)

    // Reasoning toggle: only the 12 sensitive rows rebuild.
    result = computeSettledRows(result.cache, grown, 121, true, false, 0)
    expect(result.built).toBe(12)

    // Source-backed replay (epoch bump): full rebuild of the current rows.
    result = computeSettledRows(result.cache, grown, 121, true, false, 1)
    expect(result.built).toBe(121)

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
      expect(output.text).not.toContain('\x1b]0;')
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
