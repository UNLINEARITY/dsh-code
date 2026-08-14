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
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'

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
}

/** The resolved directory: rows plus per-provider discovery failures. */
export interface ModelDirectory {
  /** Advisory rows, provider-major in registry order. */
  rows: readonly ModelRow[]
  /** Provider ids whose model listing failed; those providers contribute no rows. */
  failures: readonly string[]
}

/**
 * Load the selectable model directory from the live `ctx.llm` registry.
 * Providers are listed synchronously; each provider's models are discovered
 * with a bounded parallel fan-out whose failures degrade to that provider
 * contributing no rows (mirrors the web catalog's per-provider failures).
 * @param ctx - context carrying the `llm` service.
 * @returns the resolved directory; empty rows when `llm` is unavailable.
 */
export async function loadModelDirectory(ctx: Context): Promise<ModelDirectory> {
  const llm = ctx.get('llm')
  if (llm === undefined) return { rows: [], failures: [] }
  const providers = llm.listProviders()
  const listed = await Promise.all(providers.map(async (provider) => {
    try {
      const models: readonly LlmModelInfo[] = await llm.listModels(provider.id)
      return {
        provider: provider.id,
        providerName: provider.name,
        models: models.map(model => ({
          provider: provider.id,
          providerName: provider.name,
          model: model.id,
          modelName: model.name,
        })),
      }
    } catch {
      return { provider: provider.id, providerName: provider.name, models: [] as ModelRow[], failed: true }
    }
  }))
  const rows = listed.flatMap(entry => entry.models)
  const failures = listed.filter(entry => 'failed' in entry && entry.failed === true).map(entry => entry.provider)
  return { rows, failures }
}
