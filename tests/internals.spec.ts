/** Production Ink mount and terminal-mode ownership regressions. */

import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BRACKETED_PASTE_DISABLE,
  BRACKETED_PASTE_ENABLE,
  KEYBOARD_ENHANCE_DISABLE,
  KEYBOARD_ENHANCE_ENABLE,
} from '../src/keyboard.ts'

const ink = vi.hoisted(() => ({ render: vi.fn() }))

vi.mock('ink', () => ({ render: ink.render }))

const { internals } = await import('../src/internals.ts')

describe('production TUI mount', () => {
  beforeEach(() => {
    ink.render.mockReset()
  })

  it('leaves Ctrl+C with App and restores terminal protocols through its wrapper', () => {
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
    }
  })
})
