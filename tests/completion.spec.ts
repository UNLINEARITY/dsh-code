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
    // 14 local commands + 1 registry command + 2 skills, all present.
    expect(rows).toHaveLength(17)
    expect(rows.filter(row => row.origin === 'command')).toHaveLength(15)
    expect(rows.filter(row => row.origin === 'skill').map(row => row.label))
      .toEqual(['/review', '/agentic-workflow'])
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
    expect(rows.map(row => row.label)).toEqual(['/model', '/mode', '/model-check'])
  })

  it('keeps every local command reachable with an empty prefix', () => {
    const localNames = completionCandidates('/', [], [])
      .map(row => row.label)
    for (const name of ['/help', '/quit', '/export', '/title', '/theme']) {
      expect(localNames).toContain(name)
    }
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
    expect(help?.description).toBe('show commands')
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
