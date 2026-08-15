/**
 * Model directory for the `/model` panel: the in-process equivalent of the
 * web host's model catalog (`buildModelCatalog`), reading the advisory
 * `ctx.llm` registry directly. Catalog membership is advisory — a route
 * serving a model it stopped advertising stays usable — so selection never
 * fails on catalog absence alone.
 *
 * @module @deepseek-ai/dsh-tui/models
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import {
  ReasoningEffortId,
  type LlmModelInfo,
  type LlmModelReasoningInfo,
  type LlmResolvedModelInfo,
} from '@deepseek-ai/dsh-llm'

/** Display metadata for one adapter-owned reasoning effort (mirrors `LlmReasoningEffortInfo`). */
export interface ModelReasoningEffort {
  /** Opaque value accepted by the model's `GenerateOptions.reasoningEffort`. */
  id: string
  /** Human-readable effort name for selectors. */
  name: string
  /** Optional user-facing distinction from otherwise similar efforts. */
  description?: string
}

/** Selectable reasoning efforts for one model (mirrors `LlmModelReasoningInfo`). */
export interface ModelReasoning {
  /** Supported efforts in adapter-preferred display order. */
  efforts: readonly ModelReasoningEffort[]
  /** Adapter-configured default materialized when callers omit an effort. */
  defaultEffort?: string
}

/** One selectable row in the `/model` panel. */
export interface ModelRow {
  /** Registered provider route. */
  provider: string
  /** Display name of the provider route. */
  providerName: string
  /** Provider-owned model id. */
  model: string
  /** Human-readable model name. */
  modelName: string
  /** Adapter-owned selectable reasoning levels when the model exposes any. */
  reasoning?: ModelReasoning
}

/** The resolved directory: rows plus per-provider discovery failures. */
export interface ModelDirectory {
  /** Advisory rows, provider-major in registry order. */
  rows: readonly ModelRow[]
  /** Provider ids whose model listing failed; those providers contribute no rows. */
  failures: readonly string[]
}

/** Map an adapter's reasoning capability onto the panel's plain-id shape. */
export function mapReasoning(reasoning: LlmModelReasoningInfo): ModelReasoning {
  return {
    efforts: reasoning.efforts.map(effort => ({
      id: effort.id,
      name: effort.name,
      ...effort.description === undefined ? {} : { description: effort.description },
    })),
    ...reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort },
  }
}

/**
 * Resolve the effective model selection for one live session, in the
 * documented precedence: the in-process explicit pick, then the session's
 * last `request/header` config, then the deployment default.
 * @param picked - the explicit selection made in this process, when any.
 * @param logged - the last logged request header config, when any.
 * @param defaults - the deployment default selection.
 * @returns the effective selection, carrying a reasoning effort when one is in force.
 */
export function resolveEffectiveSelection(
  picked: ModelSelection | undefined,
  logged: { provider: string; model: string; reasoningEffort?: string } | undefined,
  defaults: ModelSelection,
): ModelSelection {
  if (picked !== undefined) return picked
  if (logged !== undefined) {
    return {
      provider: logged.provider,
      model: logged.model,
      ...logged.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(logged.reasoningEffort) },
    }
  }
  return defaults
}

/**
 * Build the selection one `/model` pick applies, rejecting an effort the
 * row does not advertise. The row is the picker's source of truth, so a
 * stale directory cannot smuggle an unsupported effort into the next step
 * (the request pipeline would reject it before network I/O regardless).
 * @param row - the picked model row.
 * @param effortId - the chosen advertised effort, or undefined for the model default.
 * @returns the selection the runner records for the next assembled step.
 */
export function buildModelSelection(row: ModelRow, effortId?: string): ModelSelection {
  if (effortId !== undefined && row.reasoning !== undefined
    && !row.reasoning.efforts.some(effort => effort.id === effortId)) {
    throw new Error(`model ${row.provider}/${row.model} does not support reasoning effort "${effortId}"`)
  }
  return {
    provider: row.provider,
    model: row.model,
    ...effortId === undefined ? {} : { reasoningEffort: ReasoningEffortId(effortId) },
  }
}

/** Display label for one applied selection: `provider/model` or `provider/model@effort`. */
export function modelSelectionLabel(selection: ModelSelection): string {
  return selection.reasoningEffort === undefined
    ? `${selection.provider}/${selection.model}`
    : `${selection.provider}/${selection.model}@${selection.reasoningEffort}`
}

/**
 * Load the selectable model directory from the live `ctx.llm` registry.
 * Providers are listed synchronously; each provider's models are discovered
 * with a bounded parallel fan-out whose failures degrade to that provider
 * contributing no rows (mirrors the web catalog's per-provider failures).
 * Each row's reasoning levels are resolved per exact model like the web
 * catalog (`buildModelCatalog`); a single model's capability lookup failure
 * degrades to that row having no effort picker rather than hiding the model.
 * @param ctx - context carrying the `llm` service.
 * @returns the resolved directory; empty rows when `llm` is unavailable.
 */
export async function loadModelDirectory(ctx: Context): Promise<ModelDirectory> {
  const llm = ctx.get('llm')
  if (llm === undefined) return { rows: [], failures: [] }
  const resolveModelInfo = (llm as { resolveModelInfo?: (provider: string, model: string) => Promise<LlmResolvedModelInfo> }).resolveModelInfo
  const providers = llm.listProviders()
  const listed = await Promise.all(providers.map(async (provider) => {
    try {
      const models: readonly LlmModelInfo[] = await llm.listModels(provider.id)
      const rows = await Promise.all(models.map(async (model): Promise<ModelRow> => {
        const row: ModelRow = {
          provider: provider.id,
          providerName: provider.name,
          model: model.id,
          modelName: model.name,
        }
        if (resolveModelInfo === undefined) return row
        try {
          const resolved = await resolveModelInfo(provider.id, model.id)
          return resolved.reasoning === undefined
            ? row
            : { ...row, reasoning: mapReasoning(resolved.reasoning) }
        } catch {
          return row
        }
      }))
      return {
        provider: provider.id,
        providerName: provider.name,
        models: rows,
      }
    } catch {
      return { provider: provider.id, providerName: provider.name, models: [] as ModelRow[], failed: true }
    }
  }))
  const rows = listed.flatMap(entry => entry.models)
  const failures = listed.filter(entry => 'failed' in entry && entry.failed === true).map(entry => entry.provider)
  return { rows, failures }
}
