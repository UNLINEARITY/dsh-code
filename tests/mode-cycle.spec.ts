/** Shift+Tab mode cycle: station decisions over permission presets plus plan. */

import { describe, expect, it } from 'vitest'
import { planCycleDecision } from '../src/runner/mode-cycle.ts'

const names = ['read-only', 'workspace-write', 'danger-full-access']

describe('planCycleDecision', () => {
  it('advances permission presets in table order', () => {
    expect(planCycleDecision({ names, current: 'workspace-write', inPlan: false, planAvailable: true }))
      .toEqual({ kind: 'permission', preset: 'danger-full-access' })
    expect(planCycleDecision({ names, current: 'danger-full-access', inPlan: false, planAvailable: true }))
      .toEqual({ kind: 'permission', preset: 'read-only' })
  })

  it('offers the plan station after the most restrictive preset', () => {
    expect(planCycleDecision({ names, current: 'read-only', inPlan: false, planAvailable: true }))
      .toEqual({ kind: 'plan-on' })
  })

  it('skips the plan station without the plan command', () => {
    expect(planCycleDecision({ names, current: 'read-only', inPlan: false, planAvailable: false }))
      .toEqual({ kind: 'permission', preset: 'workspace-write' })
  })

  it('leaves plan onto the preset after the most restrictive one', () => {
    expect(planCycleDecision({ names, current: 'read-only', inPlan: true, planAvailable: true }))
      .toEqual({ kind: 'plan-off', preset: 'workspace-write' })
  })

  it('maps an unknown current to the first preset (upstream cycle convention) and refuses empty tables', () => {
    expect(planCycleDecision({ names, current: 'mystery', inPlan: false, planAvailable: true }))
      .toEqual({ kind: 'permission', preset: 'read-only' })
    expect(planCycleDecision({ names: [], current: 'read-only', inPlan: false, planAvailable: true }))
      .toBeUndefined()
  })

  it('covers the plan-commit lag: an in-flight on-intent reads as in-plan', () => {
    // /plan went out during an open turn: upstream queued the switch and the
    // committed plan/mode fold is still false. The next press must see the
    // user's choice, not the stale fold — otherwise it re-issues plan-on and
    // the cycle never leaves the plan station.
    expect(planCycleDecision({ names, current: 'read-only', inPlan: false, planIntent: true, planAvailable: true }))
      .toEqual({ kind: 'plan-off', preset: 'workspace-write' })
  })

  it('covers the plan-commit lag: an in-flight off-intent advances permissions', () => {
    // /plan off went out while busy: the fold still says plan, but the press
    // already switched permission durably to the station after plan. The next
    // press must advance the preset cycle instead of re-issuing plan-off (the
    // reported stuck toggle).
    expect(planCycleDecision({ names, current: 'workspace-write', inPlan: true, planIntent: false, planAvailable: true }))
      .toEqual({ kind: 'permission', preset: 'danger-full-access' })
  })
})
