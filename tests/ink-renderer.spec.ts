/** Interpret the final screen and scrollback, not ANSI-stripped write chunks. */
import { createElement } from 'react'
import { Box, Static, Text, render } from 'ink'
import headless from '@xterm/headless'
import { describe, expect, it, vi } from 'vitest'
import { createSynchronizedStdout } from '../src/internals.ts'
import { App } from '../src/app.ts'
import { appProps, createAssistantMessage, createTranscriptStore, createTty, type SessionEvent } from './helpers/app-mount.ts'

function screenHarness(rows = 24) {
  const tty = createTty(100, rows)
  const terminal = new headless.Terminal({ cols: 100, rows, convertEol: true, allowProposedApi: true, scrollback: 10_000 })
  tty.stdout.on('data', (chunk: Buffer) => terminal.write(chunk.toString()))
  const stdout = createSynchronizedStdout(tty.stdout)
  return {
    tty, terminal, stdout,
    async lines() {
      await new Promise<void>(resolve => terminal.write('', resolve))
      const buffer = terminal.buffer.active
      return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? '')
    },
    dispose() {
      terminal.dispose()
      tty.stdin.destroy()
      tty.stdout.destroy()
    },
  }
}

function view(items: string[], rows: number, staticKey = 0, prefix = 'live') {
  return createElement(Box, { flexDirection: 'column' },
    createElement(Static<string>, { key: staticKey, items, children: item => createElement(Text, { key: item }, item) }),
    createElement(Box, { flexDirection: 'column', height: rows },
      ...Array.from({ length: 5 }, (_, index) => createElement(Text, { key: index }, `${prefix}-${index}`))),
  )
}

describe('Ink terminal-state regressions', () => {
  it.each([24, 30])('recovers from a %i-row padded frame without scrollback gaps or duplicates', async (height) => {
    const screen = screenHarness()
    const instance = render(view(['static-A'], 5), {
      stdin: screen.tty.stdin, stdout: screen.stdout, stderr: screen.tty.stdout, patchConsole: false, exitOnCtrlC: false,
    })
    try {
      await vi.waitFor(() => expect(screen.tty.output.text).toContain('live-4'))
      instance.rerender(view(['static-A'], height))
      await vi.waitFor(() => expect(screen.tty.output.text).toContain('\x1b[3J'))
      instance.rerender(view(['static-A', 'static-B'], 5))
      await vi.waitFor(async () => {
        const lines = await screen.lines()
        expect(lines.slice(0, 7)).toEqual(['static-A', 'static-B', 'live-0', 'live-1', 'live-2', 'live-3', 'live-4'])
      })
      // A normal frame following recovery must erase exactly its live rows.
      instance.rerender(view(['static-A', 'static-B', 'static-C'], 5, 0, 'updated'))
      await vi.waitFor(async () => expect((await screen.lines()).slice(0, 8)).toEqual([
        'static-A', 'static-B', 'static-C', 'updated-0', 'updated-1', 'updated-2', 'updated-3', 'updated-4',
      ]))
      // App's resize/fold replay remounts Static. Its old window must not be
      // appended to the replacement window on a subsequent clear-all.
      instance.rerender(view(['replacement'], height, 1))
      await vi.waitFor(async () => expect((await screen.lines())[0]).toBe('replacement'))
      instance.rerender(view(['replacement', 'next'], 5, 1))
      await vi.waitFor(async () => expect((await screen.lines()).slice(0, 7)).toEqual([
        'replacement', 'next', 'live-0', 'live-1', 'live-2', 'live-3', 'live-4',
      ]))
    } finally {
      instance.unmount()
      screen.dispose()
    }
  })

  it('keeps App history unique through menu overflow, multiline paste and rows-only resize', async () => {
    const screen = screenHarness()
    const history: SessionEvent[] = Array.from({ length: 30 }, (_, index) => ({
      type: 'assistant/message', seq: index + 1, time: index + 1,
      data: { turn: index + 1, step: 1, message: createAssistantMessage({
        content: [{ type: 'text', text: `history-marker-${index}` }], source: { provider: 'p', model: 'm' },
      }) },
    } as SessionEvent))
    const store = createTranscriptStore(history)
    const instance = render(createElement(App, appProps({ store })), {
      stdin: screen.tty.stdin, stdout: screen.stdout, stderr: screen.tty.stdout, patchConsole: false, exitOnCtrlC: false,
    })
    try {
      await vi.waitFor(() => expect(screen.tty.output.text).toContain('history-marker-29'))
      await vi.waitFor(async () => expect((await screen.lines()).join('\n')).toContain('12345678'))
      // The two-row status bar is persistent chrome, not a temporary overlay.
      // Its extra row must cross into Static rather than vanish at the split.
      await vi.waitFor(async () => expect((await screen.lines()).filter(line => line.includes('history-marker-'))).toHaveLength(30))
      screen.tty.stdin.write('/')
      await vi.waitFor(async () => expect((await screen.lines()).join('\n')).toContain('/help'))
      screen.tty.stdin.write('\x1b')
      await vi.waitFor(async () => expect((await screen.lines()).join('\n')).not.toContain('show this overlay'))
      screen.tty.stdin.write('\x1b[200~' + Array.from({ length: 12 }, (_, index) => `draft-${index}`).join('\n') + '\x1b[201~')
      await vi.waitFor(async () => expect((await screen.lines()).join('\n')).toContain('draft-11'))
      screen.tty.stdin.write('\x03')
      await vi.waitFor(async () => expect((await screen.lines()).join('\n')).not.toContain('draft-11'))
      const markers = (await screen.lines()).filter(line => line.includes('history-marker-'))
      expect(new Set(markers).size).toBe(markers.length)
      for (const rows of [48, 24]) {
        const before = screen.tty.output.text.length
        screen.terminal.resize(100, rows)
        screen.tty.stdout.rows = rows
        screen.tty.stdout.emit('resize')
        await vi.waitFor(() => expect(screen.tty.output.text.slice(before)).toContain('\x1b[2J'))
        await vi.waitFor(async () => {
          const lines = await screen.lines()
          const current = lines.filter(line => line.includes('history-marker-'))
          expect(current).toHaveLength(30)
          expect(new Set(current).size).toBe(30)
        })
      }
    } finally {
      instance.unmount()
      screen.dispose()
    }
  }, 15_000)
})
