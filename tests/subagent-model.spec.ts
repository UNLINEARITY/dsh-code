import { describe, expect, it, vi } from 'vitest'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { applySubagentModel } from '../src/runner/subagent-model.ts'

function agent(id: string, parentSession?: string, selection?: ModelSelection) {
  const select = vi.fn()
  return {
    select,
    agent: {
      session: { id, header: { parentSession } },
      model: { current: () => selection, select },
    } as unknown as Agent,
  }
}

describe('subagent model selection', () => {
  it('records a pending root pick before the child prepares its next step', () => {
    const root = agent('root', undefined, { provider: 'route', model: 'pending' })
    const child = agent('child', 'root')
    applySubagentModel(child.agent, root.agent)
    expect(child.select).toHaveBeenCalledWith({ provider: 'route', model: 'pending' })
  })

  it('applies the explicit override and clears its effort when following the root again', () => {
    const root = agent('root', undefined, { provider: 'route', model: 'default' })
    const child = agent('child', 'root')
    const override = { provider: 'other', model: 'special', reasoningEffort: 'high' } as ModelSelection
    applySubagentModel(child.agent, root.agent, override)
    applySubagentModel(child.agent, root.agent)
    expect(child.select.mock.calls).toEqual([[override], [{ provider: 'route', model: 'default' }]])
  })

  it('does not change the root or children of a different session during a switch', () => {
    const root = agent('root', undefined, { provider: 'route', model: 'pending' })
    const foreign = agent('child', 'old-root')
    applySubagentModel(root.agent, root.agent)
    applySubagentModel(foreign.agent, root.agent, { provider: 'override', model: 'special' })
    expect(root.select).not.toHaveBeenCalled()
    expect(foreign.select).not.toHaveBeenCalled()
  })

  it('leaves upstream defaults in place without an active root or model', () => {
    const root = agent('root')
    const child = agent('child', 'root')
    applySubagentModel(child.agent, undefined)
    applySubagentModel(child.agent, root.agent)
    expect(child.select).not.toHaveBeenCalled()
  })
})
