/** Shift+Tab mode-cycle stations for the terminal runner.
 *
 * Pure decision over the preset table and the committed plan fold: the runner
 * applies the returned station, so the whole cycle is testable without a
 * session.
 *
 * @module @deepseek-ai/dsh-code/mode-cycle
 */

/** One Shift+Tab station decision for the mode cycle. */
export type ModeCycleDecision =
  | { readonly kind: 'permission'; readonly preset: string }
  | { readonly kind: 'plan-on' }
  | { readonly kind: 'plan-off'; readonly preset: string }

/**
 * Decide the next Shift+Tab station. The cycle keeps the preset table's
 * own order (most restrictive first) and inserts ONE plan station between
 * the most restrictive preset and the wrap target: with the shipped three
 * presets the user sees workspace-write → danger-full-access → read-only
 * → plan → workspace-write. Plan IS the most restrictive preset plus the
 * plan prompt layer — entering it switches nothing (the cycle is already
 * parked on read-only), and leaving it lands on the next preset after the
 * most restrictive one. Without the /plan command the cycle is exactly the
 * preset table.
 *
 * `planIntent` covers the committed fold's commit lag: upstream queues a
 * plan switch during an open turn (and the command pipeline is async even
 * idle), so the durable plan/mode event lands AFTER the press that chose
 * it. While an intent from an earlier press is in flight it — not the
 * stale committed fold — decides the station, so repeated presses advance
 * the cycle instead of re-issuing the same plan transition (the stuck
 * plan-on/plan-off toggle). Undefined falls back to the committed fold.
 */
export function planCycleDecision(input: {
  readonly names: readonly string[]
  readonly current: string
  readonly inPlan: boolean
  readonly planAvailable: boolean
  readonly planIntent?: boolean
}): ModeCycleDecision | undefined {
  const names = input.names
  if (names.length === 0) return undefined
  const first = names[0]
  if ((input.planIntent ?? input.inPlan) === true) return { kind: 'plan-off', preset: names[1] ?? first }
  const at = names.indexOf(input.current)
  if (at === 0 && input.planAvailable) return { kind: 'plan-on' }
  return { kind: 'permission', preset: names[(at + 1) % names.length] ?? first }
}
