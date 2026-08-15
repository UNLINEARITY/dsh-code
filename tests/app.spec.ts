/** App-level Ctrl+O rendering regression over real Node streams. */

import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage, type CallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { App } from '../src/app.ts'
import { createTranscriptStore } from '../src/store.ts'
import { DEFAULT_STATUSLINE_ITEMS } from '../src/render/status.ts'

const wait = async (): Promise<void> => new Promise(resolve => setTimeout(resolve, 100))
const resizeClear = '\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H'
// useSyncExternalStore compares getSnapshot results by identity: these
// doubles must return one frozen object forever, or React spins into an
// infinite re-render loop (Maximum update depth exceeded).
const approvalSnapshot = Object.freeze({ pending: undefined, answered: false })
const questionSnapshot = Object.freeze({ pending: undefined })

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
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
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
      // separation; newline splitting includes the final partial row and the
      // second status row.
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
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: [], failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      cyclePermission: () => '',
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
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
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: models, failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      cyclePermission: () => '',
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
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
      dispatch: noop,
      steer: noop,
      interrupt: () => false,
      quit: noop,
      loadModels: async () => ({ rows: models, failures: [] }),
      loadMentions: async () => [],
      selectModel: () => 'test/model',
      cyclePermission: () => '',
      exportTranscript: async () => {},
      renameTitle: () => '',
      loadPresets: async () => [],
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
