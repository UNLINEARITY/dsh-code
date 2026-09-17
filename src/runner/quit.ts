/** Ordered terminal quit cleanup.
 *
 * Pure sequencing: every step rejection is contained and the exit request is
 * always reached exactly once, so a failing flush never strands the process.
 *
 * @module @deepseek-ai/dsh-code/quit
 */

/** One ordered step of the terminal quit cleanup. */
export interface QuitCleanupStep {
  /** Step label used in diagnostics and tests. */
  readonly name: string
  /** The step's async work; a rejection is contained by the sequence. */
  readonly run: () => Promise<void>
}

/**
 * Run the ordered quit cleanup, then request exit. Every step rejection is
 * contained (reported through `onError`) so a failed flush or dispose never
 * skips the remaining cleanup; the exit request is always reached exactly
 * once.
 * @param steps - the cleanup steps in dependency order (settle the visible
 * session, await the final in-flight composition, await durable recall).
 * @param exit - the terminal exit request (code 0).
 * @param onError - optional failure sink; called once per failing step and
 * itself contained, so a throwing sink cannot abort the sequence.
 * @returns the names of the steps that started, in order (for tests).
 */
export async function runQuitSequence(
  steps: readonly QuitCleanupStep[],
  exit: (code: number) => void,
  onError?: (name: string, error: unknown) => void,
): Promise<readonly string[]> {
  const started: string[] = []
  for (const step of steps) {
    started.push(step.name)
    try {
      await step.run()
    } catch (error) {
      try {
        onError?.(step.name, error)
      } catch {
        // The failure sink must never abort the cleanup sequence.
      }
    }
  }
  try {
    exit(0)
  } catch {
    // The exit request itself must not become an unhandled rejection.
  }
  return started
}
