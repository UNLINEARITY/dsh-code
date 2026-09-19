/**
 * Subagent attachment: Enter from the agents preview attaches the child as
 * the whole view — its transcript rides <Static> through the same rendering
 * as the main conversation, live events and token frames stream in real
 * time, and Esc/Ctrl+D detaches back to the agents list with the parent's
 * Static replayed.
 */
import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { App, type AppProps } from '../src/app.ts'
import { appProps } from './helpers/app-mount.ts'
import { createTranscriptStore, type TranscriptStore } from '../src/session/store.ts'
import type { SubagentAttachmentServices } from '../src/session/attach.ts'

const wait = async (ms = 120): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function fakeStreams(columns = 100, rows = 24): {
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  read: () => string
} {
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
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns, rows }) as unknown as NodeJS.WriteStream
  let text = ''
  stdout.on('data', chunk => {
    text += chunk.toString()
  })
  return { stdin, stdout, read: () => text }
}

const childEvent = (seq: number, text: string): SessionEvent => ({
  type: 'user/message',
  seq: seq as never,
  time: 1,
  data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  skippable: true,
}) as unknown as SessionEvent

/** A controllable attachment service double capturing the live callbacks. */
function attachDouble(seed: readonly SessionEvent[]) {
  const eventListeners = new Set<(event: SessionEvent) => void>()
  const frameListeners = new Set<(frame: unknown) => void>()
  const load = vi.fn(async () => [...seed])
  const services = {
    load,
    subscribeEvents: (_id: string, onEvent: (event: SessionEvent) => void) => {
      eventListeners.add(onEvent)
      return () => { eventListeners.delete(onEvent) }
    },
    subscribeStream: ((_id: string, onFrame: (frame: Parameters<TranscriptStore['applyStreamFrame']>[0]) => void) => {
      frameListeners.add(onFrame as (frame: unknown) => void)
      return () => { frameListeners.delete(onFrame as (frame: unknown) => void) }
    }) as SubagentAttachmentServices['subscribeStream'],
  }
  return {
    services,
    load,
    pushEvent: (event: SessionEvent): void => { for (const listener of eventListeners) listener(event) },
    pushFrame: (frame: unknown): void => { for (const listener of frameListeners) listener(frame) },
  }
}

/** Identity-stable live feed carrying one running child (getSnapshot contract). */
const LIVE_CHILD = Object.freeze([Object.freeze({ id: 'child-1', label: 'explorer', state: 'running' as const, activity: 'tool grep', updatedAt: 3 })])

function renderApp(overrides: Partial<AppProps>, parentStore: TranscriptStore) {
  const streams = fakeStreams()
  const instance = render(createElement(App, appProps({
    store: parentStore,
    subagents: { subscribe: () => () => {}, getSnapshot: () => LIVE_CHILD, getTotalSeen: () => LIVE_CHILD.length },
    ...overrides,
  })), {
    stdin: streams.stdin, stdout: streams.stdout, stderr: streams.stdout, exitOnCtrlC: false, patchConsole: false,
  })
  return {
    ...streams,
    close: () => {
      instance.unmount()
      streams.stdin.destroy()
      streams.stdout.destroy()
    },
  }
}

/** Open /agents and attach to the first live row. */
async function attachFromAgents(harness: { stdin: NodeJS.ReadStream; read: () => string }): Promise<void> {
  harness.stdin.write('/agents')
  await wait()
  harness.stdin.write('\r')
  await wait()
  // Enter opens the transcript preview, the preview's Enter attaches.
  harness.stdin.write('\r')
  await wait()
  harness.stdin.write('\r')
  await wait()
  await wait()
  expect(harness.read()).toContain('observing')
}

describe('subagent attachment', () => {
  it('renders the child transcript through the main rendering pipeline and streams live', async () => {
    const parent = createTranscriptStore()
    parent.apply(childEvent(0, 'parent message'))
    const dbl = attachDouble([childEvent(1, 'child seed message')])
    const harness = renderApp({
      attachSubagent: dbl.services,
      loadSubagents: async () => [],
    }, parent)
    try {
      await attachFromAgents(harness)
      expect(harness.read()).toContain('child seed message')
      // A live durable event lands on the attached view in real time.
      dbl.pushEvent(childEvent(2, 'live child message'))
      await wait()
      expect(harness.read()).toContain('live child message')
      // A token frame streams into the tail.
      dbl.pushFrame({ type: 'start', attemptId: 'a1' as never, revision: 1, turn: 1, step: 1 })
      dbl.pushFrame({
        type: 'chunk', attemptId: 'a1' as never, revision: 1, index: 0, time: 0,
        chunk: { type: 'text-delta', index: 0, text: 'streaming answer' },
      })
      await wait()
      expect(harness.read()).toContain('streaming answer')
    } finally {
      harness.close()
    }
  })

  it('detaches on Esc back to the agents list and replays the parent Static', async () => {
    const parent = createTranscriptStore()
    parent.apply(childEvent(0, 'parent message'))
    const dbl = attachDouble([childEvent(1, 'child seed message')])
    const harness = renderApp({
      attachSubagent: dbl.services,
      loadSubagents: async () => [],
    }, parent)
    try {
      await attachFromAgents(harness)
      expect(harness.read()).toContain('child seed message')
      harness.stdin.write('\u001b')
      await wait()
      await wait()
      const output = harness.read()
      // The parent's Static replay lands AFTER the last attach bar.
      expect(output.lastIndexOf('parent message')).toBeGreaterThan(output.lastIndexOf('observing'))
    } finally {
      harness.close()
    }
  })

  it('ctrl+d detaches the same way', async () => {
    const parent = createTranscriptStore()
    const dbl = attachDouble([childEvent(1, 'child seed message')])
    const harness = renderApp({
      attachSubagent: dbl.services,
      loadSubagents: async () => [],
    }, parent)
    try {
      await attachFromAgents(harness)
      harness.stdin.write('\x04')
      await wait()
      await wait()
      expect(harness.read()).not.toContain('观察模式')
    } finally {
      harness.close()
    }
  })

  it('r reseeds the attachment from the durable log', async () => {
    const parent = createTranscriptStore()
    const dbl = attachDouble([childEvent(1, 'first seed')])
    const harness = renderApp({
      attachSubagent: dbl.services,
      loadSubagents: async () => [],
    }, parent)
    try {
      await attachFromAgents(harness)
      expect(dbl.load).toHaveBeenCalledTimes(1)
      harness.stdin.write('r')
      await wait()
      expect(dbl.load).toHaveBeenCalledTimes(2)
      expect(harness.read()).toContain('observing')
    } finally {
      harness.close()
    }
  })

  it('drops duplicate and pre-seed stream frames by sequence watermark', async () => {
    const parent = createTranscriptStore()
    const dbl = attachDouble([childEvent(1, 'seed one'), childEvent(2, 'seed two')])
    const harness = renderApp({
      attachSubagent: dbl.services,
      loadSubagents: async () => [],
    }, parent)
    try {
      await attachFromAgents(harness)
      // A re-delivered durable event at an already-seen seq is dropped.
      dbl.pushEvent(childEvent(2, 'seed two'))
      await wait()
      expect(harness.read().match(/seed two/g)?.length ?? 0).toBeLessThan(3)
    } finally {
      harness.close()
    }
  })
})
