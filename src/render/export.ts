/**
 * Markdown export of one transcript view: the /export command's pure
 * formatter. Deterministic and side-effect free — the runner owns the file
 * write, so tests drive the builder with folded views directly.
 *
 * @module @deepseek-ai/dsh-code/render/export
 */

import { assertNever } from '@deepseek-ai/dsh-llm'
import type { TranscriptView } from './projection.ts'

/**
 * Render the transcript as a standalone markdown document.
 * @param view - the folded transcript view to export.
 * @param sessionId - the full session identity for the header.
 * @returns the complete markdown text.
 */
export function buildExportMarkdown(view: TranscriptView, sessionId: string): string {
  const out: string[] = [
    view.title === ''
      ? `# dsh session ${sessionId}`
      : `# ${view.title}`,
    `> session ${sessionId}`,
    '',
  ]
  for (const entry of view.entries) {
    switch (entry.kind) {
      case 'user':
        if (entry.notice) {
          out.push(`> ⤷ context: ${entry.text}`, '')
        } else {
          out.push('## user', '', entry.text, '')
        }
        break
      case 'assistant':
        if (entry.reasoning !== '') {
          out.push('<details><summary>thinking</summary>', '', entry.reasoning, '', '</details>', '')
        }
        out.push('## assistant', '', entry.text, '')
        break
      case 'tool':
        out.push(`### tool \`${entry.name}\``, '')
        if (entry.preview !== '') out.push(`- args: ${entry.preview}`)
        if (entry.summary !== '') out.push(`- ${entry.state === 'error' ? 'error' : 'result'}: ${entry.summary}`)
        out.push('')
        break
      case 'command':
        out.push(`### /${entry.name}${entry.args === '' ? '' : ` ${entry.args}`}`, '')
        if (entry.summary !== '') out.push(`- ${entry.state === 'error' ? 'error' : 'result'}: ${entry.summary}`)
        out.push('')
        break
      case 'error':
        out.push(`> ⨯ ${entry.text}`, '')
        break
      case 'turn-marker':
        out.push(`> ${entry.text}`, '')
        break
      case 'compaction':
        out.push(entry.ok
          ? `> compacted ~${entry.tokens} tokens`
          : `> compaction failed: ${entry.error}`, '')
        break
      case 'retry':
        out.push(`> retry ${entry.attempt}/${entry.max} (${entry.code})`, '')
        break
      case 'files':
        out.push(`> files changed: ${entry.paths.join(', ')}`, '')
        break
      default:
        assertNever(entry, 'transcript entry kind')
    }
  }
  if (view.streaming !== '') out.push('## assistant (streaming)', '', view.streaming, '')
  const { stats } = view
  out.push('---', '')
  out.push(`- model: ${view.model === '' ? '(none yet)' : view.model}`)
  out.push(`- turns: ${stats.turns} · steps: ${stats.steps}`)
  out.push(`- tokens: ↑${stats.usage.inputTokens} ↓${stats.usage.outputTokens} · cache read ${stats.usage.cacheReadTokens}`)
  out.push(`- todos: ${view.todos.length}`)
  return out.join('\n')
}
