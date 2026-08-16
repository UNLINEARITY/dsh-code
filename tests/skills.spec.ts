/** User-invocable skill watch: filtering, dedup against nothing, change refresh. */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { watchSkills } from '../src/skills.ts'

function summary(name: string, model: boolean, user: boolean): SkillSummary {
  return {
    name,
    description: `${name} does things`,
    invocation: { modelInvocable: model, userInvocable: user },
    source: 'project-dsh',
    provider: 'filesystem',
  }
}

/** Registry double plus context double feeding {@link watchSkills}. */
function harness(initial: readonly SkillSummary[]): {
  ctx: Context
  setCatalog(next: readonly SkillSummary[]): void
  fireChange(): void
} {
  let catalog = initial
  const listeners = new Set<() => void>()
  const registry = {
    list: async (): Promise<readonly SkillSummary[]> => catalog,
  }
  const ctx = {
    get: (name: string): unknown => (name === 'skills' ? registry : undefined),
    on: (event: string, listener: () => void): (() => void) => {
      if (event === 'skills/change') listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  } as unknown as Context
  return {
    ctx,
    setCatalog: (next: readonly SkillSummary[]) => {
      catalog = next
    },
    fireChange: () => {
      for (const listener of listeners) listener()
    },
  }
}

const agent = {
  session: { header: { cwd: 'C:/work' } },
} as unknown as Agent

describe('watchSkills', () => {
  it('serves only user-invocable skills, name-sorted, with the model flag', async () => {
    const { ctx } = harness([
      summary('zeta', true, true),
      summary('alpha', true, false),
      summary('beta', false, true),
    ])
    const view = watchSkills(ctx)
    view.setAgent(agent)
    await new Promise(resolve => setImmediate(resolve))
    expect(view.rows).toEqual([
      { name: 'beta', description: 'beta does things', modelInvocable: false },
      { name: 'zeta', description: 'zeta does things', modelInvocable: true },
    ])
  })

  it('reloads on skills/change', async () => {
    const { ctx, setCatalog, fireChange } = harness([summary('alpha', true, true)])
    const view = watchSkills(ctx)
    view.setAgent(agent)
    await new Promise(resolve => setImmediate(resolve))
    const seen: number[] = []
    view.subscribe(() => seen.push(view.rows.length))
    setCatalog([summary('alpha', true, true), summary('gamma', true, true)])
    fireChange()
    await new Promise(resolve => setImmediate(resolve))
    expect(view.rows).toHaveLength(2)
    expect(seen).toEqual([2])
  })

  it('stays empty without a skills service', () => {
    const ctx = { get: (): undefined => undefined, on: (): (() => void) => () => {} } as unknown as Context
    const view = watchSkills(ctx)
    view.setAgent(agent)
    expect(view.rows).toEqual([])
  })

  it('keeps the last good rows when a reload rejects', async () => {
    const { ctx, fireChange } = harness([summary('alpha', true, true)])
    // Rebind the registry's list to reject after the first good load.
    const registry = (ctx as unknown as { get(name: string): unknown }).get('skills') as {
      list: () => Promise<readonly SkillSummary[]>
    }
    const view = watchSkills(ctx)
    view.setAgent(agent)
    await new Promise(resolve => setImmediate(resolve))
    expect(view.rows).toHaveLength(1)
    registry.list = () => Promise.reject(new Error('watcher offline'))
    fireChange()
    await new Promise(resolve => setImmediate(resolve))
    expect(view.rows).toHaveLength(1)
    expect(view.error).toBe('watcher offline')
  })

  it('contains a synchronous catalog failure', async () => {
    const { ctx, fireChange } = harness([summary('alpha', true, true)])
    const registry = (ctx as unknown as { get(name: string): unknown }).get('skills') as {
      list: () => Promise<readonly SkillSummary[]>
    }
    const view = watchSkills(ctx)
    view.setAgent(agent)
    await new Promise(resolve => setImmediate(resolve))
    registry.list = () => { throw new Error('watcher exploded') }
    fireChange()
    await new Promise(resolve => setImmediate(resolve))
    expect(view.rows).toHaveLength(1)
    expect(view.error).toBe('watcher exploded')
  })

  it('never lets an older agent’s catalog overwrite the current agent', async () => {
    const deferred: Array<{ resolve(rows: readonly SkillSummary[]): void }> = []
    const registry = {
      list: (): Promise<readonly SkillSummary[]> => new Promise(resolve => {
        deferred.push({ resolve })
      }),
    }
    const ctx = {
      get: (name: string): unknown => (name === 'skills' ? registry : undefined),
      on: (): (() => void) => () => {},
    } as unknown as Context
    const view = watchSkills(ctx)
    const agentA = { session: { header: { cwd: 'C:/a' } } } as unknown as Agent
    const agentB = { session: { header: { cwd: 'C:/b' } } } as unknown as Agent
    view.setAgent(agentA)
    view.setAgent(agentB)
    // Let both reloads reach the registry: deferred[0] is agent A's load,
    // deferred[1] is agent B's.
    await new Promise(resolve => setImmediate(resolve))
    expect(deferred).toHaveLength(2)
    // The newer agent's catalog lands first, then the older one's — the stale
    // result must be dropped.
    deferred[1]?.resolve([summary('beta', true, true)])
    await new Promise(resolve => setImmediate(resolve))
    expect(view.rows.map(row => row.name)).toEqual(['beta'])
    deferred[0]?.resolve([summary('alpha', true, true)])
    await new Promise(resolve => setImmediate(resolve))
    expect(view.rows.map(row => row.name)).toEqual(['beta'])
  })
})
