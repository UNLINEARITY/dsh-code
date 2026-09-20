/** Plugin and statusline panels plus the job clock: render smoke and keys. */

import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import { JobsPanel, PluginPanel, runClock, StatuslinePanel, type JobRow } from '../src/panels/kernel-panels.ts'
import type { PluginRow } from '../src/plugin-inventory.ts'
import { DEFAULT_STATUSLINE_ITEMS } from '../src/render/status.ts'

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

const pluginRows = (): readonly PluginRow[] => [
  { entryId: 'tool-web', moduleName: '@deepseek-ai/dsh-web', phase: 'active', enabled: true },
  { entryId: 'tool-lsp', moduleName: '@deepseek-ai/dsh-tool-lsp', phase: null, enabled: false },
]

describe('PluginPanel', () => {
  it('lists registry rows, filters as you type, and expands the selection', async () => {
    const streams = fakeStreams()
    const closeSpy = vi.fn()
    const instance = render(createElement(PluginPanel, { load: pluginRows, close: closeSpy }), {
      stdin: streams.stdin, stdout: streams.stdout, stderr: streams.stdout, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      await wait()
      let output = streams.read()
      expect(output).toContain('● tool-web · active')
      expect(output).toContain('○ tool-lsp · not mounted')
      // Enter expands the cursor row with its module name.
      streams.stdin.write('\r')
      await wait()
      output = streams.read()
      expect(output).toContain('@deepseek-ai/dsh-web')
      // Typing filters; q becomes query text mid-filter, then closes empty.
      streams.stdin.write('lsp')
      await wait()
      expect(streams.read()).toContain('tool-lsp')
      streams.stdin.write('\r') // toggle expansion off (still filtered)
      await wait()
      streams.stdin.write('\u001b')
      await wait()
      expect(closeSpy).toHaveBeenCalledTimes(1)
    } finally {
      instance.unmount()
      streams.stdin.destroy()
      streams.stdout.destroy()
    }
  })
})

describe('runClock', () => {
  it('formats seconds under a minute and minutes beyond (TurnStatus shape)', () => {
    expect(runClock(0)).toBe('0s')
    expect(runClock(45_000)).toBe('45s')
    expect(runClock(123_000)).toBe('2m03s')
    expect(runClock(3_600_000)).toBe('60m00s')
  })
})

describe('JobsPanel', () => {
  it('renders registry snapshots with state marks and closes on q', async () => {
    const streams = fakeStreams()
    const close = vi.fn()
    const jobs: readonly JobRow[] = [
      { id: 'bash-1', kind: 'bash', label: 'pnpm test', status: 'running', startedAt: 1_000 },
      { id: 'bash-2', kind: 'bash', label: 'pnpm build', status: 'completed', startedAt: 1_000, finishedAt: 2_000, detail: 'exit 0' },
    ]
    const instance = render(createElement(JobsPanel, { load: () => jobs, close }), { stdin: streams.stdin, stdout: streams.stdout, stderr: streams.stdout, exitOnCtrlC: false, patchConsole: false })
    try {
      await wait()
      const output = streams.read()
      expect(output).toContain('bash-1')
      expect(output).toContain('pnpm test')
      expect(output).toContain('pnpm build')
      streams.stdin.write('q')
      await wait()
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      instance.unmount()
      streams.stdin.destroy()
      streams.stdout.destroy()
    }
  })
})

describe('StatuslinePanel', () => {
  it('toggles an item with space (committing immediately) and closes on enter', async () => {
    const streams = fakeStreams()
    const change = vi.fn()
    const close = vi.fn()
    const instance = render(createElement(StatuslinePanel, {
      enabled: DEFAULT_STATUSLINE_ITEMS,
      change,
      close,
    }), { stdin: streams.stdin, stdout: streams.stdout, stderr: streams.stdout, exitOnCtrlC: false, patchConsole: false })
    try {
      await wait()
      expect(change).not.toHaveBeenCalled()
      streams.stdin.write(' ')
      await wait()
      expect(change).toHaveBeenCalledTimes(1)
      const saved = change.mock.calls[0][0] as readonly string[]
      expect(saved).toHaveLength(DEFAULT_STATUSLINE_ITEMS.length - 1)
      // d restores the shipped default set in one keystroke.
      streams.stdin.write('d')
      await wait()
      expect(change).toHaveBeenCalledTimes(2)
      expect(change.mock.calls[1][0]).toEqual(DEFAULT_STATUSLINE_ITEMS)
      streams.stdin.write('\r')
      await wait()
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      instance.unmount()
      streams.stdin.destroy()
      streams.stdout.destroy()
    }
  })
})
