/** Production Ink mount and terminal-mode ownership regressions. */

import type { ReactElement } from 'react'
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

vi.mock('ink', () => ({ render: ink.render }))

const { internals } = await import('../src/internals.ts')

describe('production TUI mount', () => {
  beforeEach(() => {
    ink.render.mockReset()
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
      expect(ink.render).toHaveBeenCalledWith(element, { exitOnCtrlC: false })
      expect(stdoutWrite).toHaveBeenNthCalledWith(1, KEYBOARD_ENHANCE_ENABLE + BRACKETED_PASTE_ENABLE)

      const next = {} as ReactElement
      mounted.rerender(next)
      expect(rerender).toHaveBeenCalledWith(next)

      mounted.unmount()
      expect(unmount).toHaveBeenCalledTimes(1)
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
