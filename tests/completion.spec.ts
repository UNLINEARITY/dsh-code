/** Slash-command completion: full default list (skills included), prefix filter, shadowing, dedup. */

import { describe, expect, it } from 'vitest'
import { completionCandidates } from '../src/app.ts'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import type { SkillRow } from '../src/skills.ts'

const skill = (name: string, modelInvocable = true): SkillRow => ({
  name,
  description: `${name} does things`,
  modelInvocable,
})

describe('completionCandidates', () => {
  it('shows the full merged list on a bare /, skills included (no slice cap)', () => {
    const descriptors: readonly CommandDescriptor[] = [
      { name: 'compact', description: 'shrink history' },
    ]
    const skills: readonly SkillRow[] = [
      skill('review'),
      skill('agentic-workflow'),
    ]
    const rows = completionCandidates('/', descriptors, skills)
    // 31 local commands + 1 registry command + 1 unshadowed skill (/review is local).
    expect(rows).toHaveLength(33)
    expect(rows.filter(row => row.origin === 'command')).toHaveLength(32)
    expect(rows.filter(row => row.origin === 'skill').map(row => row.label))
      .toEqual(['/agentic-workflow'])
    expect(rows[0]).toMatchObject({ label: '/help', origin: 'command' })
    expect(rows.at(-1)).toMatchObject({ label: '/agentic-workflow', origin: 'skill' })
  })

  it('returns nothing for non-slash input', () => {
    expect(completionCandidates('hello world', [], [])).toEqual([])
  })

  it('filters by typed prefix across commands and skills', () => {
    const descriptors: readonly CommandDescriptor[] = [{ name: 'compact', description: 'shrink history' }]
    const skills: readonly SkillRow[] = [skill('review'), skill('model-check')]
    const rows = completionCandidates('/mo', descriptors, skills)
    // Prefix hits first in source order (model, mode, then the
    // model-check skill), gapped subsequence matches after (animation,
    // permission).
    expect(rows.slice(0, 3).map(row => row.label)).toEqual(['/model', '/mode', '/model-check'])
    expect(rows.map(row => row.label)).toContain('/animation')
  })

  it('matches ordered subsequences and ranks prefix hits first', () => {
    // Prefix hits lead (model, mode); the gapped subsequence matches follow
    // in source order (animation's m…o, permission's m…o).
    const mo = completionCandidates('/mo', [], []).map(row => row.label)
    expect(mo.slice(0, 2)).toEqual(['/model', '/mode'])
    expect(mo).toContain('/animation')
    expect(mo).toContain('/permission')
    // `md` is a gapped subsequence of the model family only.
    expect(completionCandidates('/md', [], []).map(row => row.label)).toContain('/mode')
    expect(completionCandidates('/md', [], []).map(row => row.label)).not.toContain('/animation')
    // `dmo` is no one's ordered subsequence and matches nothing.
    expect(completionCandidates('/dmo', [], [])).toEqual([])
    // Matching is case-insensitive on both sides.
    expect(completionCandidates('/MD', [], []).map(row => row.label)).toContain('/mode')
  })

  it('keeps every local command reachable with an empty prefix', () => {
    const localNames = completionCandidates('/', [], [])
      .map(row => row.label)
    for (const name of ['/help', '/quit', '/export', '/title', '/theme', '/rainbow', '/mode', '/permission']) {
      expect(localNames).toContain(name)
    }
  })

  it('does not expose generic kernel-inspection commands as DSH-Code commands', () => {
    const names = completionCandidates('/', [], []).map(row => row.label)
    // /jobs came back with the rc.8 host jobs registry (a real read-only
    // capability); settings/mcp/hooks stay out as non-core views.
    for (const name of ['/settings', '/mcp', '/hooks']) expect(names).not.toContain(name)
  })

  it('offers /permission before any session exists and shadows the registry child', () => {
    const rows = completionCandidates('/per', [], [])
    expect(rows.map(row => row.label)).toEqual(['/permission'])
    const registry = completionCandidates('/', [{ name: 'permission', description: 'registry child' }], [])
    const permission = registry.filter(row => row.label === '/permission')
    expect(permission).toEqual([
      { label: '/permission', description: 'inspect or select the permission preset (/permission [preset])', origin: 'command' },
    ])
  })

  it('local commands shadow registry descriptors, which shadow skills', () => {
    const descriptors: readonly CommandDescriptor[] = [
      { name: 'help', description: 'registry help' },
      { name: 'compact', description: 'shrink history' },
    ]
    const skills: readonly SkillRow[] = [
      skill('compact'),
      skill('review'),
    ]
    const rows = completionCandidates('/', descriptors, skills)
    const help = rows.find(row => row.label === '/help')
    expect(help?.description).toBe('show this overlay')
    // `/compact` stays a registry command; the skill never renders.
    const compact = rows.find(row => row.label === '/compact')
    expect(compact?.description).toBe('shrink history')
    expect(rows.filter(row => row.label === '/compact')).toHaveLength(1)
    expect(rows.map(row => row.label)).toContain('/review')
  })

  it('collapses duplicate registry names to one row', () => {
    const descriptors: readonly CommandDescriptor[] = [
      { name: 'dup', description: 'first' },
      { name: 'dup', description: 'second' },
    ]
    const rows = completionCandidates('/', descriptors, [])
    expect(rows.filter(row => row.label === '/dup')).toEqual([
      { label: '/dup', description: 'first', origin: 'command' },
    ])
  })
})
