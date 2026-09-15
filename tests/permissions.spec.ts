import { describe, expect, it, vi } from 'vitest'
import type { PresetSpec } from '@deepseek-ai/dsh-permission-presets'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  applyPendingPermission,
  cyclePermission,
  effectivePermission,
  selectPermission,
  type PermissionPresetsService,
} from '../src/permissions.ts'

/** The three shipped preset bundles, in declaration order. */
const PRESETS: Readonly<Record<string, PresetSpec>> = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'ask' },
}

/** The public slice of the preset service this policy suite drives. */
type PresetServiceDouble = Pick<PermissionPresetsService, 'names' | 'defaultPreset' | 'resolve' | 'current' | 'set'>

/**
 * Preset-service double plus the spy recording its durable writes. The spy is
 * returned separately because `set` is a method on the real service: reading it
 * off the instance would detach it from its receiver.
 */
function service(): { presets: PermissionPresetsService; set: ReturnType<typeof vi.fn> } {
  const set = vi.fn()
  const double: PresetServiceDouble = {
    names: Object.keys(PRESETS),
    defaultPreset: 'workspace-write',
    resolve: vi.fn((name: string): PresetSpec => {
      const spec = PRESETS[name]
      if (spec === undefined) throw new Error(`unknown preset ${name}`)
      return spec
    }),
    current: vi.fn(() => 'workspace-write'),
    set,
  }
  // The real service is a class with private state, so no structural double
  // can satisfy it: the double cast is the point of this fixture.
  return { presets: double as unknown as PermissionPresetsService, set }
}

describe('permission preset policy', () => {
  it('uses the configured default and cycles without a session or durable write', () => {
    const { presets, set } = service()
    expect(effectivePermission(presets, undefined, undefined)).toBe('workspace-write')
    expect(cyclePermission(presets, undefined, undefined)).toBe('danger-full-access')
    expect(selectPermission(presets, undefined, 'read-only')).toBe('read-only')
    expect(set).not.toHaveBeenCalled()
  })

  it('applies selections to active sessions and materializes a pending first-session pick', () => {
    const { presets, set } = service()
    const session = { events: [] } as unknown as Session
    expect(cyclePermission(presets, session, undefined)).toBe('danger-full-access')
    expect(set).toHaveBeenLastCalledWith(session, 'danger-full-access')

    applyPendingPermission(presets, session, 'read-only')
    expect(set).toHaveBeenLastCalledWith(session, 'read-only')
  })

  it('rejects unknown presets before writing active or pending state', () => {
    const { presets, set } = service()
    const session = { events: [] } as unknown as Session
    expect(() => selectPermission(presets, session, 'missing')).toThrow('unknown preset missing')
    expect(set).not.toHaveBeenCalled()
  })
})
