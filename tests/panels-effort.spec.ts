/**
 * Shared list-frame surfaces: compact single-line mode, loading/error/empty
 * states, and the mode/effort pickers' keyboard contracts.
 */

import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import { EffortPanel, ModePanel } from '../src/panels/kernel-panels.ts'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-preset-registry'
import type { ModelRow } from '../src/models.ts'

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

describe('ModePanel', () => {
  it('shows loading, then rows, filters as you type, and reloads with r', async () => {
    const streams = fakeStreams()
    let reloads = 0
    const presets: readonly AgentPreset[] = [
      { id: 'ptc', name: 'PTC', description: 'default coding preset', trust: [], path: '/presets/ptc' } as unknown as AgentPreset,
      { id: 'minimal', name: 'Minimal', description: 'reduced toolset', trust: [], path: '/presets/minimal' } as unknown as AgentPreset,
    ]
    const load = (): Promise<readonly AgentPreset[]> => new Promise(resolve => {
      reloads += 1
      setTimeout(() => resolve(presets), 30)
    })
    const instance = render(createElement(ModePanel, { current: 'ptc', load, select: vi.fn(), close: vi.fn() }), {
      stdin: streams.stdin, stdout: streams.stdout, stderr: streams.stdout, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      await wait()
      expect(streams.read()).toContain('loading')
      await wait(80)
      expect(streams.read()).toContain('PTC')
      expect(streams.read()).toContain('Minimal')
      // Typing filters; q stays query text mid-filter.
      streams.stdin.write('min')
      await wait()
      expect(streams.read()).toContain('Minimal')
      expect(streams.read().lastIndexOf('PTC')).toBeLessThan(streams.read().lastIndexOf('Minimal'))
      for (let index = 0; index < 3; index += 1) {
        streams.stdin.write('\x7f')
        await wait(40)
      }
      streams.stdin.write('r')
      await wait(150)
      expect(reloads).toBeGreaterThanOrEqual(2)
    } finally {
      instance.unmount()
      streams.stdin.destroy()
      streams.stdout.destroy()
    }
  })

  it('surfaces a failed load in place and stays closable', async () => {
    const streams = fakeStreams()
    const close = vi.fn()
    const load = (): Promise<never> => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('preset registry offline')), 30)
    })
    const instance = render(createElement(ModePanel, { current: '', load, select: vi.fn(), close }), {
      stdin: streams.stdin, stdout: streams.stdout, stderr: streams.stdout, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      await wait(80)
      expect(streams.read()).toContain('preset registry offline')
      streams.stdin.write('\x1b')
      await wait()
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      instance.unmount()
      streams.stdin.destroy()
      streams.stdout.destroy()
    }
  })
})

describe('kernel EffortPanel', () => {
  it('lists levels over the selected model and applies a pick on Enter', async () => {
    const streams = fakeStreams()
    const select = vi.fn()
    const row: ModelRow = {
      provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-chat', modelName: 'DeepSeek Chat',
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
    }
    const instance = render(createElement(EffortPanel, { row, current: 'low', select, back: vi.fn(), onExit: vi.fn() }), {
      stdin: streams.stdin, stdout: streams.stdout, stderr: streams.stdout, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      await wait()
      const output = streams.read()
      expect(output).toContain('Low')
      expect(output).toContain('High')
      streams.stdin.write('\x1b[B') // down to high
      await wait()
      streams.stdin.write('\r')
      await wait()
      expect(select).toHaveBeenCalledWith('high')
    } finally {
      instance.unmount()
      streams.stdin.destroy()
      streams.stdout.destroy()
    }
  })
})
