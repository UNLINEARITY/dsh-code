import { describe, expect, it, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  applyPendingPermission,
  cyclePermission,
  effectivePermission,
  selectPermission,
  type PermissionPresetsService,
} from '../src/permissions.ts'

function service(): PermissionPresetsService & { set: ReturnType<typeof vi.fn> } {
  return {
    names: ['read-only', 'workspace-write', 'danger-full-access'],
    defaultPreset: 'workspace-write',
    resolve: vi.fn((name: string) => {
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(name)) throw new Error(`unknown preset ${name}`)
      return { sandbox: name, approval: 'ask' }
    }),
    current: vi.fn(() => 'workspace-write'),
    set: vi.fn(),
  }
}

describe('permission preset policy', () => {
  it('uses the configured default and cycles without a session or durable write', () => {
    const presets = service()
    expect(effectivePermission(presets, undefined, undefined)).toBe('workspace-write')
    expect(cyclePermission(presets, undefined, undefined)).toBe('danger-full-access')
    expect(selectPermission(presets, undefined, 'read-only')).toBe('read-only')
    expect(presets.set).not.toHaveBeenCalled()
  })

  it('applies selections to active sessions and materializes a pending first-session pick', () => {
    const presets = service()
    const session = { events: [] } as unknown as Session
    expect(cyclePermission(presets, session, undefined)).toBe('danger-full-access')
    expect(presets.set).toHaveBeenLastCalledWith(session, 'danger-full-access')

    applyPendingPermission(presets, session, 'read-only')
    expect(presets.set).toHaveBeenLastCalledWith(session, 'read-only')
  })

  it('rejects unknown presets before writing active or pending state', () => {
    const presets = service()
    const session = { events: [] } as unknown as Session
    expect(() => selectPermission(presets, session, 'missing')).toThrow('unknown preset missing')
    expect(presets.set).not.toHaveBeenCalled()
  })
})
