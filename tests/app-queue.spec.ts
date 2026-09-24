/** Queued submissions, pre-session controls, and session remount. */

import { describe, expect, it, vi } from 'vitest'
import {
  type UserMessage,
  type TranscriptEntry,
  type ToolCallId,
  App,
  PassThrough,
  appProps,
  chalk,
  createElement,
  createTranscriptStore,
  createTty,
  createUserMessage,
  queuedInboxRows,
  render,
  renderApp,
  resizeClear,
  rowBackground,
  wait,
} from './helpers/app-mount.ts'
import { fixtureEvent } from './helpers/events.ts'

describe('queuedInboxRows', () => {
  it('uses next-turn inbox order and excludes next-step rows', () => {
    const entries: readonly TranscriptEntry[] = [
      { kind: 'pending', messageId: 'turn-second' as never, target: 'next-turn', text: 'second' },
      { kind: 'pending', messageId: 'step-only' as never, target: 'next-step', text: 'steer' },
      { kind: 'pending', messageId: 'turn-first' as never, target: 'next-turn', text: 'first' },
    ]
    expect(queuedInboxRows(entries, ['turn-first', 'turn-second', 'missing']))
      .toMatchObject([{ text: 'first' }, { text: 'second' }])
  })
})
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
      loadPresets: async () => [{ id: 'minimal', trust: 'system', path: 'C:\\repo\\presets\\minimal\\agent.yml' }],
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
    const props = appProps({
      store,
      commands: { descriptors, subscribe: () => unsubscribe, setAgent: noop },
      skills: { rows: skills, subscribe: () => unsubscribe, setAgent: noop },
      loadModels: async () => ({ rows: models, failures: [] }),
    })
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
    const props = appProps({
      store,
      commands: { descriptors, subscribe: () => unsubscribe, setAgent: noop },
      skills: { rows: skills, subscribe: () => unsubscribe, setAgent: noop },
      loadModels: async () => ({ rows: models, failures: [] }),
    })
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
      store.apply(fixtureEvent({
        type: 'agent/inbox/spliced',
        seq: 1,
        time: 0,
        data: { target: 'next-turn', start: 0, inserted: [first] },
      }))
      await wait()
      store.apply(fixtureEvent({
        type: 'agent/inbox/spliced',
        seq: 2,
        time: 0,
        data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] as UserMessage[] },
      }))
      await wait()
      store.apply(fixtureEvent({ type: 'user/message', seq: 3, time: 0, data: first }))
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
describe('queued inbox rows in a mixed mutable tail', () => {
  it('collects pending rows across a running tool and cancels newest-first', async () => {
    const harness = createTty()
    const { stdin, stdout, output } = harness
    const cancelled: string[] = []
    const store = createTranscriptStore()
    const first = createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } })
    const second = createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } })
    const third = createUserMessage({ content: [{ type: 'text', text: 'three' }], source: { kind: 'user' } })
    // Mirror the runner's remove path: the durable splice retires the pending
    // row, so the next Delete sees a shrunken queue (newest-first). Only the
    // remove action retires a row — edit and steer must reuse the same splice.
    const retire = (id: string): void => {
      cancelled.push(id)
      // The runner echoes back the durable message id as a plain string; the
      // index lookup is over the matching durable ids.
      const ids: readonly string[] = [first.id, second.id, third.id]
      const index = ids.indexOf(id)
      store.apply(fixtureEvent({
        type: 'agent/inbox/spliced',
        seq: 100,
        time: 100,
        data: { target: 'next-turn', start: index, removedCount: 1, inserted: [] as UserMessage[] },
      }))
    }
    const callId = 'live-tool' as ToolCallId
    // Pending rows are NOT a contiguous tail: a running tool row sits between
    // the first pending row and the rest, so a naive "scan from the end until
    // the first non-pending" would lose `one`.
    store.apply(fixtureEvent({
      type: 'agent/inbox/spliced',
      seq: 1,
      time: 1,
      data: { target: 'next-turn', start: 0, inserted: [first] },
    }))
    store.apply(fixtureEvent({
      type: 'tool/call',
      seq: 2,
      time: 2,
      data: { turn: 1, step: 1, callId, name: 'live', arguments: '{}' },
    }))
    store.apply(fixtureEvent({
      type: 'agent/inbox/spliced',
      seq: 3,
      time: 3,
      data: { target: 'next-turn', start: 1, inserted: [second] },
    }))
    store.apply(fixtureEvent({
      type: 'agent/inbox/spliced',
      seq: 4,
      time: 4,
      data: { target: 'next-turn', start: 2, inserted: [third] },
    }))
    const instance = renderApp(harness, appProps({
      store,
      updateQueued: (id, action) => {
        if (action.kind === 'remove') retire(id)
      },
    }))
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

  it('paints each prompt delivery kind as its own full-width bar', async () => {
    const harness = createTty(100, 30)
    const { stdin, stdout } = harness
    const level = chalk.level
    // Ink only emits truecolor sequences at level 3; the bar tints are RGB.
    chalk.level = 3
    const store = createTranscriptStore()
    const plain = createUserMessage({ content: [{ type: 'text', text: 'typed idle' }], source: { kind: 'user' } })
    const queued = createUserMessage({ content: [{ type: 'text', text: 'after the turn' }], source: { kind: 'user' } })
    const steered = createUserMessage({ content: [{ type: 'text', text: 'mid turn' }], source: { kind: 'user' } })
    store.apply(fixtureEvent({ type: 'user/message', seq: 1, time: 1, data: plain }))
    // A submission only counts as queued/steered when a turn is already
    // running; `followup` on an idle driver is the ordinary path.
    store.apply(fixtureEvent({ type: 'turn/start', seq: 2, time: 2, data: { turn: 1 } }))
    store.apply(fixtureEvent({ type: 'agent/inbox/spliced', seq: 3, time: 3, data: { target: 'next-turn', start: 0, inserted: [queued] } }))
    store.apply(fixtureEvent({ type: 'user/message', seq: 4, time: 4, data: queued }))
    store.apply(fixtureEvent({ type: 'agent/inbox/spliced', seq: 5, time: 5, data: { target: 'next-step', start: 0, inserted: [steered] } }))
    store.apply(fixtureEvent({ type: 'user/message', seq: 6, time: 6, data: steered }))
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      // One derived background per delivery kind, straight through Ink's
      // renderer. The RGB comes from the palette color blended over the
      // surface, so a theme change repaints the bars.
      const bar = (color: 'prompt' | 'queued' | 'steered'): string => {
        const [r, g, b] = rowBackground(color)!.replace(/[^0-9,]/gu, '').split(',').map(Number)
        return `48;2;${r};${g};${b}`
      }
      expect(harness.output.text).toContain(bar('prompt'))
      expect(harness.output.text).toContain(bar('queued'))
      expect(harness.output.text).toContain(bar('steered'))
      expect(harness.output.text).toContain('typed idle')
      expect(harness.output.text).toContain('after the turn')
      expect(harness.output.text).toContain('mid turn')
    } finally {
      chalk.level = level
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('flips queue and steer with Tab on an empty composer and submits accordingly', async () => {
    const harness = createTty()
    const { stdin, stdout } = harness
    const dispatched: string[] = []
    const steered: string[] = []
    const instance = renderApp(harness, appProps({
      dispatch: text => { dispatched.push(text) },
      steer: text => { steered.push(text) },
    }))
    try {
      await wait()
      // Empty composer + Tab: the prompt glyph and the placeholder both name
      // the mode, and the toggle reports itself.
      expect(harness.output.text).toContain('❯ ')
      stdin.write('\t')
      await wait()
      expect(harness.output.text).toContain('↳ ')
      expect(harness.output.text).toContain('steer into this turn')

      stdin.write('join the running turn')
      await wait()
      stdin.write('\r')
      await wait()
      expect(steered).toEqual(['join the running turn'])
      expect(dispatched).toEqual([])

      // Tab again returns to the queue, and the next submission follows it.
      stdin.write('\t')
      await wait()
      stdin.write('wait for the next turn')
      await wait()
      stdin.write('\r')
      await wait()
      expect(dispatched).toEqual(['wait for the next turn'])
      expect(steered).toEqual(['join the running turn'])
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('queues a busy submission for the next turn instead of steering the running one', async () => {
    const harness = createTty()
    const { stdin, stdout } = harness
    const dispatched: string[] = []
    const store = createTranscriptStore()
    // A running turn makes the composer's submission path the interesting one.
    store.apply(fixtureEvent({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } }))
    const instance = renderApp(harness, appProps({
      store,
      dispatch: text => { dispatched.push(text) },
    }))
    try {
      await wait()
      stdin.write('queue this for later')
      await wait()
      stdin.write('\r')
      await wait()
      // The runner owns `followup`; the composer only dispatches. Steering a
      // running turn is a deliberate `/queue` + enter action, never implicit.
      expect(dispatched).toEqual(['queue this for later'])
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})
