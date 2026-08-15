/**
 * Injectable process-facing effects for the TUI runner. Tests substitute the
 * Ink mount with a capturing fake and the streams with string sinks, keeping
 * the runner's lifecycle testable without a terminal.
 *
 * @module @deepseek-ai/dsh-tui/internals
 */

import { render } from 'ink'
import type { ReactElement } from 'react'

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
    const instance = render(element)
    return {
      rerender(element: ReactElement): void {
        instance.rerender(element)
      },
      unmount(): void {
        instance.unmount()
      },
    }
  },
  stderr: process.stderr,
}
