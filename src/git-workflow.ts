/** Read-only Git inspection used by /diff and /review. */

import { execFile } from 'node:child_process'

export interface GitDiffSpec {
  readonly label: string
  readonly args: readonly string[]
}

/** One file section from a unified diff, retained in source order. */
export interface GitDiffFile {
  readonly path: string
  readonly lines: readonly string[]
}

/** A parsed diff ready for a file-oriented terminal viewport. */
export interface GitDiffView {
  readonly title: string
  readonly files: readonly GitDiffFile[]
}

/** Split Git's stable `diff --git` framing without interpreting patch content. */
export function parseGitDiffFiles(text: string): readonly GitDiffFile[] {
  if (text === '') return []
  const chunks = text.split(/(?=^diff --git )/mu).filter(chunk => chunk !== '')
  return chunks.map((chunk, index) => {
    const lines = chunk.replace(/\n$/u, '').split('\n')
    const plus = lines.find(line => line.startsWith('+++ b/'))
    const minus = lines.find(line => line.startsWith('--- a/'))
    const header = /^diff --git a\/(.+) b\/(.+)$/u.exec(lines[0] ?? '')
    const path = plus?.slice(6) || minus?.slice(6) || header?.[2] || header?.[1] || `file ${index + 1}`
    return { path, lines }
  })
}

/** Parse the intentionally small, option-safe /diff argument vocabulary. */
export function parseGitDiffSpec(argument: string): GitDiffSpec {
  const value = argument.trim()
  if (value === '') return { label: 'working tree vs HEAD', args: ['diff', '--no-ext-diff', '--unified=3', 'HEAD', '--'] }
  if (value === '--staged' || value === '--cached') {
    return { label: 'staged changes', args: ['diff', '--no-ext-diff', '--unified=3', '--cached', '--'] }
  }
  if (value.startsWith('-') || /\s/u.test(value)) throw new Error('usage: /diff [--staged|git-ref]')
  return { label: `changes since ${value}`, args: ['diff', '--no-ext-diff', '--unified=3', value, '--'] }
}

function executeGit(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(stderr.trim() || error.message))
        return
      }
      resolve(stdout.replace(/\r\n/gu, '\n'))
    })
  })
}

/**
 * Load one complete textual diff without invoking external diff drivers.
 * @param signal - aborted by the caller on session switches/quit, killing the
 * git subprocess instead of letting a stale repository's diff land later.
 */
export async function loadGitDiff(cwd: string, argument: string, signal?: AbortSignal): Promise<GitDiffView> {
  const spec = parseGitDiffSpec(argument)
  try {
    const text = await executeGit(cwd, spec.args, signal)
    return { title: `git diff - ${spec.label}`, files: parseGitDiffFiles(text) }
  } catch (error: unknown) {
    // An unborn repository has no HEAD. Preserve useful unstaged output for
    // the default form while still surfacing all other Git failures.
    if (argument.trim() !== '') throw error
    const text = await executeGit(cwd, ['diff', '--no-ext-diff', '--unified=3', '--'], signal)
    return { title: 'git diff - working tree', files: parseGitDiffFiles(text) }
  }
}

/** Review prompt capped before it reaches a provider context window. */
export function buildReviewPrompt(diff: string, label: string, maxChars = 200_000): string {
  const truncated = diff.length > maxChars
  const body = truncated ? diff.slice(0, maxChars) : diff
  return [
    'Review the following Git changes. Do not modify files or run write operations.',
    'Lead with concrete bugs, regressions, security risks, and missing tests, ordered by severity.',
    `Scope: ${label}${truncated ? ' (diff truncated by CLI)' : ''}`,
    '',
    '```diff',
    body,
    '```',
  ].join('\n')
}
