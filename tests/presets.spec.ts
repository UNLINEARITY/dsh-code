import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { isBlankSession, resolvePreset, selectPreset, switchPreset, type AgentPresetsService } from '../src/presets.ts'

describe('agent preset policy', () => {
  it('treats only turn/start as the mode lock', () => {
    expect(isBlankSession([])).toBe(true)
    expect(isBlankSession([{ type: 'session/title' } as SessionEvent])).toBe(true)
    expect(isBlankSession([{ type: 'turn/start' } as SessionEvent])).toBe(false)
  })

  it('uses the latest logged selection and standard for legacy sessions', () => {
    const header = { id: 's', createdAt: 0, version: 0 } as Session['header']
    expect(resolvePreset({ header, events: [] })).toBe('standard')
    expect(resolvePreset({
      header: { ...header, agentPreset: 'code' },
      events: [
        { type: 'agent-preset/selected', data: { agentPreset: 'minimal' } },
        { type: 'agent-preset/selected', data: { agentPreset: 'cordis' } },
      ] as SessionEvent[],
    })).toBe('cordis')
  })

  it('resolves a pending choice without an Agent and recomposes only an active blank session', async () => {
    const resolve = vi.fn().mockResolvedValue({ id: 'minimal' })
    const recompose = vi.fn()
    const service = { resolve, recompose } as unknown as AgentPresetsService

    await expect(selectPreset(service, undefined, 'minimal')).resolves.toMatchObject({ id: 'minimal' })
    expect(resolve).toHaveBeenCalledWith('minimal')
    expect(recompose).not.toHaveBeenCalled()
  })

  it('logs a switch only after recompose succeeds', async () => {
    const append = vi.fn()
    const agent = { ctx: {}, session: { events: [], append } } as unknown as Agent
    const service = { recompose: vi.fn().mockResolvedValue({ id: 'code' }) } as unknown as AgentPresetsService
    await expect(switchPreset(service, agent, 'code')).resolves.toMatchObject({ id: 'code' })
    expect(append).toHaveBeenCalledWith('agent-preset/selected', { agentPreset: 'code' })

    append.mockClear()
    service.recompose = vi.fn().mockRejectedValue(new Error('broken'))
    await expect(switchPreset(service, agent, 'broken')).rejects.toThrow('broken')
    expect(append).not.toHaveBeenCalled()
  })
})
