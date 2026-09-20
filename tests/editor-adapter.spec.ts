/** Host clipboard adapter: process spawn shape and platform branches. */

import { describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { copyText } from '../src/editor.ts'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const originalPlatform = process.platform

const fakeChild = (code: number, stderr = '') => {
  const listeners = new Map<string, (argument?: unknown) => void>()
  return {
    stderr: { on: (_: string, handler: (chunk: unknown) => void): void => { if (stderr !== '') handler(stderr) } },
    stdin: { end: vi.fn() },
    once: (event: string, handler: (argument?: unknown) => void): void => { listeners.set(event, handler) },
    // Drive exit asynchronously so the promise wiring settles first; fail()
    // drives the spawn-error path instead.
    trigger: (): void => { listeners.get('exit')?.(code) },
    fail: (): void => { listeners.get('error')?.(new Error('spawn failed')) },
  }
}

describe('copyText', () => {
  it('pipes UTF-8 through pbcopy on darwin', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      const child = fakeChild(0)
      vi.mocked(spawn).mockReturnValueOnce(child as never)
      const promise = copyText('你好 world')
      child.trigger()
      await promise
      expect(spawn).toHaveBeenCalledWith('pbcopy', [], expect.objectContaining({ windowsHide: true }))
      expect(child.stdin.end).toHaveBeenCalledWith('你好 world')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  it('uses the UTF-8 PowerShell pipeline on win32', async () => {
    const child = fakeChild(0)
    vi.mocked(spawn).mockReturnValueOnce(child as never)
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const promise = copyText('text')
      child.trigger()
      await promise
      const [command, args] = vi.mocked(spawn).mock.calls.at(-1)!
      expect(command).toBe('powershell.exe')
      expect(String(args[3])).toContain('[Console]::InputEncoding')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  it('falls back to xclip on other platforms and reports the exit failure', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const child = fakeChild(0)
      vi.mocked(spawn).mockReturnValueOnce(child as never)
      const ok = copyText('text')
      child.trigger()
      await ok
      expect(spawn).toHaveBeenCalledWith('xclip', ['-selection', 'clipboard'], expect.anything())

      const failing = fakeChild(1, 'no display')
      vi.mocked(spawn).mockReturnValueOnce(failing as never)
      const rejected = copyText('text')
      failing.trigger()
      await expect(rejected).rejects.toThrow('xclip exited with code 1: no display')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  it('rejects through the spawn error path when the command is missing', async () => {
    const child = fakeChild(0)
    vi.mocked(spawn).mockReturnValueOnce(child as never)
    const promise = copyText('text')
    child.fail()
    await expect(promise).rejects.toThrow('spawn failed')
  })
})
