/** Production Ink mount and terminal-mode ownership regressions. */

import type { ReactElement } from 'react'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BRACKETED_PASTE_DISABLE,
  BRACKETED_PASTE_ENABLE,
  KEYBOARD_ENHANCE_DISABLE,
  KEYBOARD_ENHANCE_ENABLE,
  TERMINAL_FOCUS_REPORT_DISABLE,
  TERMINAL_FOCUS_REPORT_ENABLE,
} from '../src/keyboard.ts'

const ink = vi.hoisted(() => ({ render: vi.fn() }))
const inputSplit = vi.hoisted(() => {
  const calls: { stdin: unknown; dispose: ReturnType<typeof vi.fn> }[] = []
  return {
    calls,
    createSplitStdin: vi.fn(() => {
      const entry = { stdin: new PassThrough({ objectMode: true }), dispose: vi.fn() }
      calls.push(entry)
      return entry
    }),
  }
})

vi.mock('ink', () => ({ render: ink.render }))
vi.mock('../src/input-split.ts', () => ({ createSplitStdin: inputSplit.createSplitStdin }))

const { internals, createSynchronizedStdout } = await import('../src/internals.ts')

describe('production TUI mount', () => {
  it('writes synchronized frames atomically and delegates live dimensions without a Proxy', async () => {
    const sink = Object.assign(new PassThrough(), { rows: 24, columns: 80, isTTY: true })
    const chunks: string[] = []
    sink.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))
    const stdout = createSynchronizedStdout(sink as unknown as NodeJS.WriteStream)
    const callback = vi.fn()
    try {
      stdout.write('\x1b[2Kframe', callback)
      await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1))
      expect(chunks).toEqual(['\x1b[?2026h\x1b[2Kframe\x1b[?2026l'])
      sink.rows = 48
      sink.columns = 100
      expect(stdout.rows).toBe(48)
      expect(stdout.columns).toBe(100)
      expect(stdout.isTTY).toBe(true)
    } finally {
      sink.destroy()
    }
  })

  beforeEach(() => {
    ink.render.mockReset()
    inputSplit.createSplitStdin.mockClear()
    inputSplit.calls.length = 0
  })

  it('leaves Ctrl+C with App and restores terminal protocols through its wrapper', () => {
    vi.stubEnv('TERM_PROGRAM', 'WindowsTerminal')
    vi.stubEnv('VSCODE_INJECTION', '')
    const rerender = vi.fn()
    const unmount = vi.fn()
    ink.render.mockReturnValue({ rerender, unmount })
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const element = {} as ReactElement

    try {
      const mounted = internals.mount(element)
      // stdin rides the keypress splitter so a coalesced chunk never
      // becomes one lost keypress; stdout rides the synchronized-output
      // proxy (DEC 2026) that makes every Ink frame atomic.
      expect(ink.render).toHaveBeenCalledWith(element, {
        exitOnCtrlC: false,
        stdin: inputSplit.calls[0]?.stdin,
        stdout: expect.objectContaining({ write: expect.any(Function) }),
        stderr: expect.objectContaining({ write: expect.any(Function) }),
      })
      const options = ink.render.mock.calls[0]?.[1] as { stdout: unknown; stderr: unknown }
      expect(options.stderr).toBe(options.stdout)
      expect(stdoutWrite).toHaveBeenNthCalledWith(1, KEYBOARD_ENHANCE_ENABLE + BRACKETED_PASTE_ENABLE)

      const next = {} as ReactElement
      mounted.rerender(next)
      expect(rerender).toHaveBeenCalledWith(next)

      mounted.unmount()
      expect(unmount).toHaveBeenCalledTimes(1)
      expect(inputSplit.calls[0]?.dispose).toHaveBeenCalledTimes(1)
      expect(stdoutWrite).toHaveBeenNthCalledWith(2, KEYBOARD_ENHANCE_DISABLE + BRACKETED_PASTE_DISABLE)
    } finally {
      stdoutWrite.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it('keeps bracketed paste but leaves Kitty enhancement disabled in VS Code', () => {
    vi.stubEnv('TERM_PROGRAM', 'vscode')
    vi.stubEnv('VSCODE_INJECTION', '1')
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    ink.render.mockReturnValue({ rerender: vi.fn(), unmount: vi.fn() })
    try {
      const mounted = internals.mount({} as ReactElement)
      expect(stdoutWrite).toHaveBeenNthCalledWith(1, BRACKETED_PASTE_ENABLE + TERMINAL_FOCUS_REPORT_ENABLE)
      mounted.unmount()
      expect(stdoutWrite).toHaveBeenNthCalledWith(2, BRACKETED_PASTE_DISABLE + TERMINAL_FOCUS_REPORT_DISABLE)
    } finally {
      stdoutWrite.mockRestore()
      vi.unstubAllEnvs()
    }
  })

})
