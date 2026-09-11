/** Shift+Tab mode cycle: station decisions over permission presets plus plan. */

import { describe, expect, it } from 'vitest'
import { planCycleDecision } from '../src/index.ts'

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
})
