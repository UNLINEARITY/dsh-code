/**
 * Injectable process-facing effects for the TUI runner. Tests substitute the
 * Ink mount with a capturing fake and the streams with string sinks, keeping
 * the runner's lifecycle testable without a terminal.
 *
 * @module @deepseek-ai/dsh-tui/internals
 */

import { render } from 'ink'
import type { ReactElement } from 'react'
import { BRACKETED_PASTE_DISABLE, BRACKETED_PASTE_ENABLE, KEYBOARD_ENHANCE_DISABLE, KEYBOARD_ENHANCE_ENABLE } from './keyboard.ts'

/** A mounted terminal app instance; the runner owns unmount ordering. */
export interface TuiMount {
  /** Replace the root element while preserving Ink's single terminal owner. */
  rerender(element: ReactElement): void
  /** Tear the terminal app down before flush and exit. */
  unmount(): void
}

/** The Ink mount seam: renders the app element and returns its handle. */
export type Mount = (element: ReactElement) => TuiMount

/** Substitutable runner effects; production values write to the real terminal. */
export const internals: {
  /** Ink renderer mount; tests substitute a fake that captures the element. */
  mount: Mount
  /** Diagnostics stream for direct-driver failures. */
  stderr: { write(chunk: string): unknown }
} = {
  mount: (element: ReactElement): TuiMount => {
    // Codex keyboard_modes parity: push the kitty keyboard protocol so
    // modified controls remain distinguishable, and enable bracketed paste so
    // pasted newlines insert instead of submitting. Both are inert in
    // terminals without support.
    process.stdout.write(KEYBOARD_ENHANCE_ENABLE + BRACKETED_PASTE_ENABLE)
    // App owns Ctrl+C's deliberate three-state contract (interrupt, clear
    // draft, quit). Ink's default `exitOnCtrlC: true` would intercept the
    // normalized control byte first, unmount only its renderer, and leave the
    // Harness runner plus the pushed keyboard protocol alive.
    const instance = render(element, { exitOnCtrlC: false })
    return {
      rerender(element: ReactElement): void {
        instance.rerender(element)
      },
      unmount(): void {
        instance.unmount()
        // Pop the stack so the parent shell does not inherit enhanced key
        // reporting (Codex resets even harder on forced exit).
        process.stdout.write(KEYBOARD_ENHANCE_DISABLE + BRACKETED_PASTE_DISABLE)
      },
    }
  },
  stderr: process.stderr,
}
