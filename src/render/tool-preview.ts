/**
 * Bounded preview line for a tool invocation's raw JSON arguments: the first
 * human-meaningful string among the well-known keys (command, path, query, …)
 * with a fallback to the bounded raw JSON. Shared by the tool card in the
 * transcript and the approval bar's command preview.
 *
 * @module @deepseek-ai/dsh-code/render/tool-preview
 */

/** Keys searched in declaration order when building a preview. */
const PREVIEW_KEYS = ['command', 'cmd', 'description', 'path', 'pattern', 'query'] as const

/**
 * Resolve one bounded preview for raw tool arguments.
 * @param args - raw JSON arguments string as the model produced it.
 * @param toolName - the tool the arguments belong to (fallback label).
 * @returns the preview line; empty when nothing useful resolves.
 */
export function toolArgumentsPreview(args: string, toolName: string): string {
  if (args === '') return toolName
  try {
    const parsed: unknown = JSON.parse(args)
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      for (const key of PREVIEW_KEYS) {
        const value = record[key]
        if (typeof value === 'string' && value !== '') return value
      }
    }
  } catch {
    // Raw JSON parse failed: fall through to the bounded raw arguments.
  }
  return args.length > 80 ? `${args.slice(0, 77)}...` : args
}
