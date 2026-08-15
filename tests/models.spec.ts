/** Model directory reasoning surface and model-selection precedence. */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, type LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import {
  buildModelSelection,
  loadModelDirectory,
  mapReasoning,
  resolveEffectiveSelection,
  type ModelRow,
} from '../src/models.ts'

describe('mapReasoning', () => {
  it('maps adapter effort metadata onto the panel shape', () => {
    const reasoning: LlmModelReasoningInfo = {
      efforts: [
        { id: ReasoningEffortId('off'), name: 'Off' },
        { id: ReasoningEffortId('high'), name: 'High', description: 'balanced' },
      ],
      defaultEffort: ReasoningEffortId('high'),
    }
    expect(mapReasoning(reasoning)).toEqual({
      efforts: [
        { id: 'off', name: 'Off' },
        { id: 'high', name: 'High', description: 'balanced' },
      ],
      defaultEffort: 'high',
    })
  })

  it('omits the default when the adapter declares none', () => {
    expect(mapReasoning({ efforts: [{ id: ReasoningEffortId('max'), name: 'Max' }] })).toEqual({
      efforts: [{ id: 'max', name: 'Max' }],
    })
  })
})

describe('resolveEffectiveSelection', () => {
  const defaults: ModelSelection = { provider: 'route', model: 'default-model' }
  const logged = { provider: 'route', model: 'resumed-model', reasoningEffort: 'high' }

  it('prefers the in-process pick over the logged header and defaults', () => {
    const picked: ModelSelection = { provider: 'route', model: 'picked-model', reasoningEffort: 'max' }
    expect(resolveEffectiveSelection(picked, logged, defaults)).toBe(picked)
  })

  it('falls back to the logged request header, carrying its effort', () => {
    expect(resolveEffectiveSelection(undefined, logged, defaults)).toEqual({
      provider: 'route',
      model: 'resumed-model',
      reasoningEffort: 'high',
    })
  })

  it('keeps the deployment default when nothing else selects', () => {
    expect(resolveEffectiveSelection(undefined, undefined, defaults)).toBe(defaults)
  })
})

describe('buildModelSelection', () => {
  const row: ModelRow = {
    provider: 'deepseek-official',
    providerName: 'DeepSeek',
    model: 'deepseek-v4',
    modelName: 'V4',
    reasoning: {
      efforts: [
        { id: 'off', name: 'Off' },
        { id: 'high', name: 'High' },
        { id: 'max', name: 'Max' },
      ],
      defaultEffort: 'high',
    },
  }

  it('records an advertised effort', () => {
    expect(buildModelSelection(row, 'max')).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4',
      reasoningEffort: 'max',
    })
  })

  it('leaves the effort to the model default when none is chosen', () => {
    expect(buildModelSelection(row)).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4' })
  })

  it('rejects an effort the row does not advertise', () => {
    expect(() => buildModelSelection(row, 'low')).toThrow('does not support reasoning effort "low"')
  })
})

describe('loadModelDirectory reasoning', () => {
  it('attaches advertised reasoning levels to each row', async () => {
    const llm = {
      listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash', name: 'V4 Flash' }],
      resolveModelInfo: async (provider: string, model: string) => ({
        provider,
        id: model,
        name: model,
        reasoning: {
          efforts: [
            { id: ReasoningEffortId('off'), name: 'Off' },
            { id: ReasoningEffortId('max'), name: 'Max' },
          ],
          defaultEffort: ReasoningEffortId('max'),
        },
      }),
    }
    const ctx = { get: (name: string): unknown => (name === 'llm' ? llm : undefined) } as unknown as Context
    const directory = await loadModelDirectory(ctx)
    expect(directory.rows).toEqual([
      {
        provider: 'deepseek-official',
        providerName: 'DeepSeek',
        model: 'deepseek-v4-flash',
        modelName: 'V4 Flash',
        reasoning: {
          efforts: [
            { id: 'off', name: 'Off' },
            { id: 'max', name: 'Max' },
          ],
          defaultEffort: 'max',
        },
      },
    ])
    expect(directory.failures).toEqual([])
  })

  it('degrades one model capability failure to a row without reasoning', async () => {
    const llm = {
      listProviders: () => [{ id: 'route', name: 'Route' }],
      listModels: async () => [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      resolveModelInfo: async (_provider: string, model: string) => {
        if (model === 'b') throw new Error('capability offline')
        return {
          provider: 'route',
          id: model,
          name: model,
          reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] },
        }
      },
    }
    const ctx = { get: (name: string): unknown => (name === 'llm' ? llm : undefined) } as unknown as Context
    const directory = await loadModelDirectory(ctx)
    expect(directory.rows).toEqual([
      {
        provider: 'route',
        providerName: 'Route',
        model: 'a',
        modelName: 'A',
        reasoning: { efforts: [{ id: 'high', name: 'High' }] },
      },
      { provider: 'route', providerName: 'Route', model: 'b', modelName: 'B' },
    ])
    expect(directory.failures).toEqual([])
  })

  it('keeps rows unadorned when the service exposes no capability lookup', async () => {
    const llm = {
      listProviders: () => [{ id: 'route', name: 'Route' }],
      listModels: async () => [{ id: 'a', name: 'A' }],
    }
    const ctx = { get: (name: string): unknown => (name === 'llm' ? llm : undefined) } as unknown as Context
    const directory = await loadModelDirectory(ctx)
    expect(directory.rows).toEqual([
      { provider: 'route', providerName: 'Route', model: 'a', modelName: 'A' },
    ])
    expect(directory.failures).toEqual([])
  })
})
