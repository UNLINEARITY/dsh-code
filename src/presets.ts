/** Agent-preset policy kept independent from the Ink surface. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentPreset, AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** One discoverable agent composition. */
export type PresetRow = AgentPreset

/** Public compatibility alias for the official upstream service type. */
export type AgentPresetsService = AgentPresets

/** Read an optional Cordis service without requiring its package at build time. */
export function agentPresetsFrom(ctx: Context): AgentPresetsService | undefined {
  return ctx.get('agentPresets')
}

/** A preset may change only before the first durable turn begins. */
export function isBlankSession(events: readonly SessionEvent[]): boolean {
  return !events.some(event => event.type === 'turn/start')
}

/** Latest logged selection wins; legacy sessions deliberately fall back to standard. */
export function resolvePreset(session: Pick<Session, 'header' | 'events'>): string {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index] as unknown as { type: string; data?: { agentPreset?: string } }
    if (event.type === 'agent-preset/selected' && event.data?.agentPreset !== undefined) {
      return event.data.agentPreset
    }
  }
  return session.header.agentPreset ?? 'standard'
}

/** Resolve a pre-session choice, or recompose an active blank Agent. */
export async function selectPreset(
  service: AgentPresetsService,
  agent: Agent | undefined,
  presetId: string,
): Promise<PresetRow> {
  if (agent !== undefined) return switchPreset(service, agent, presetId)
  const preset = await service.resolve(presetId)
  if (preset.broken !== undefined) throw new Error(preset.broken)
  return preset
}

/** Recompose atomically from the caller's perspective, logging only success. */
export async function switchPreset(
  service: AgentPresetsService,
  agent: Agent,
  presetId: string,
): Promise<PresetRow> {
  if (!isBlankSession(agent.session.events)) {
    throw new Error('mode is locked after the first turn; use /new <mode>')
  }
  const preset = await service.recompose(agent.ctx, presetId)
  const writable = agent.session as unknown as { append(type: string, data: unknown): void }
  writable.append('agent-preset/selected', { agentPreset: preset.id })
  return preset
}
