import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { listPluginRows } from '../src/plugin-inventory.ts'

describe('plugin inventory', () => {
  it('projects non-group loader entries and all fiber phases', () => {
    const entries = [
      { id: 'group', disabled: false, options: { group: true, name: 'cordis:group' } },
      { id: 'active', disabled: false, options: { name: '@test/active' }, fiber: { state: 2 } },
      { id: 'failed', disabled: true, options: { name: '@test/failed' }, fiber: { state: 3 } },
    ]
    const ctx = { get: () => ({ entries: () => entries }) } as unknown as Context
    expect(listPluginRows(ctx)).toEqual([
      { entryId: 'active', moduleName: '@test/active', enabled: true, phase: 'active' },
      { entryId: 'failed', moduleName: '@test/failed', enabled: false, phase: 'failed' },
    ])
  })
})
