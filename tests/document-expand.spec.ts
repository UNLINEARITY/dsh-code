/**
 * Document viewer expansion: the agents/resume transcript preview grows to a
 * near-fullscreen overlay on Enter/f, Esc returns to the list directly, and
 * `r` re-reads the same document while a subagent keeps running.
 */
import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import { AgentsPanel } from '../src/panels/kernel-panels.ts'
import { expandedDocumentViewport, panelViewport } from '../src/render/inspector.ts'
import type { SubagentRow } from '../src/session/subagents.ts'
import type { SessionRow } from '../src/session/session-directory.ts'

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

const liveRow = (id: string): SubagentRow =>
  ({ id, label: `agent ${id.slice(-4)}`, activity: 'work', state: 'running', updatedAt: 1 })

const persistedRow = (id: string, title?: string): SessionRow =>
  ({ id, createdAt: 1, updatedAt: 1, cwd: '/w', workspace: 'w', subagent: true, resumable: false, live: false, persisted: true, preset: 'ptc', ...(title === undefined ? {} : { title }) })

const markdown = (paragraphs: number): string =>
  Array.from({ length: paragraphs }, (_, index) => `## turn ${index}\n\nline one of turn ${index} with some words to wrap\n\nline two of turn ${index}`).join('\n\n')

function renderAgents(readTranscript: ReturnType<typeof vi.fn>, text: string) {
  readTranscript.mockImplementation(async () => text)
  const streams = fakeStreams()
  const instance = render(createElement(AgentsPanel, {
    live: [liveRow('session-child-0001')],
    load: async () => [persistedRow('session-child-0002', 'settled')],
    readTranscript: readTranscript as unknown as (id: string, signal?: AbortSignal) => Promise<string>,
    attach: undefined,
    close: () => {},
  }), { stdin: streams.stdin, stdout: streams.stdout, stderr: streams.stdout, exitOnCtrlC: false, patchConsole: false })
  return {
    ...streams,
    close: () => {
      instance.unmount()
      streams.stdin.destroy()
      streams.stdout.destroy()
    },
  }
}

/** Count document body lines currently visible (rows inside the panel frame). */
const visibleBodyLines = (output: string): number => {
  const clean = output.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
  const lines = clean.split(/\r\n|\r|\n/).filter(line => /turn \d/.test(line) || /line (one|two) of turn/.test(line))
  return new Set(lines).size
}

describe('document expansion viewport', () => {
  it('nearly doubles the body budget without reaching terminal height', () => {
    const panel = panelViewport(100, 24)
    const expanded = expandedDocumentViewport(100, 24)
    expect(expanded.bodyRows).toBeGreaterThan(panel.bodyRows)
    // 24-row terminal: 6 preview rows grow past 10, and the frame plus the
    // bottom live region still fit inside the terminal.
    expect(panel.bodyRows).toBe(6)
    expect(expanded.bodyRows).toBeGreaterThanOrEqual(10)
    expect(expanded.bodyRows + 4 + 2 + 6).toBeLessThanOrEqual(24)
  })
})

describe('agents transcript expansion', () => {
  it('enter opens the preview, enter again expands, esc returns to the list', async () => {
    const read = vi.fn()
    const harness = renderAgents(read, markdown(12))
    try {
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(harness.read()).toContain('turn 0')
      const before = visibleBodyLines(harness.read())
      // Enter again: the document expands to the near-fullscreen overlay.
      harness.stdin.write('\r')
      await wait()
      const after = visibleBodyLines(harness.read())
      expect(after).toBeGreaterThan(before)
      expect(harness.read()).toContain('expanded')
      // Esc leaves for the list directly — the preview is not a level to
      // back through.
      harness.stdin.write('\u001b')
      await wait()
      expect(harness.read()).toContain('agent 0001')
    } finally {
      harness.close()
    }
  })

  it('ctrl+d leaves the expanded document like esc', async () => {
    const read = vi.fn()
    const harness = renderAgents(read, markdown(4))
    try {
      await wait()
      harness.stdin.write('\r')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(harness.read()).toContain('expanded')
      harness.stdin.write('\x04')
      await wait()
      expect(harness.read()).toContain('agent 0001')
    } finally {
      harness.close()
    }
  })

  it('r re-reads the same child while the document stays open', async () => {
    const read = vi.fn()
    const harness = renderAgents(read, markdown(2))
    try {
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(read).toHaveBeenCalledTimes(1)
      harness.stdin.write('\r')
      await wait()
      harness.stdin.write('r')
      await wait()
      expect(read).toHaveBeenCalledTimes(2)
      expect(read.mock.calls[1][0]).toBe(read.mock.calls[0][0])
      expect(harness.read()).toContain('expanded')
    } finally {
      harness.close()
    }
  })

  it('keeps the scroll position inside the expanded window when expanding near the bottom', async () => {
    const read = vi.fn()
    const harness = renderAgents(read, markdown(30))
    try {
      await wait()
      harness.stdin.write('\r')
      await wait()
      // Jump to the preview's bottom, then expand: the clamped scroll must
      // not exceed the (larger) expanded window's maximum.
      harness.stdin.write('G')
      await wait()
      harness.stdin.write('\r')
      await wait()
      await wait()
      const clean = harness.read().replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
      // The expanded footer (with `esc/ctrl+d back`) is the last one written.
      const footer = clean.split(/\r\n|\r|\n/).filter(line => /lines \d+-\d+.*ctrl\+d/.test(line)).at(-1) ?? ''
      const match = /lines (\d+)-(\d+)\/(\d+)/.exec(footer)
      expect(match).toBeDefined()
      expect(Number(match![2])).toBeLessThanOrEqual(Number(match![3]))
      expect(Number(match![2]) - Number(match![1]) + 1).toBeGreaterThanOrEqual(10)
    } finally {
      harness.close()
    }
  })
})
