/**
 * Read-only Git inspection used by /diff and /review. Every diff
 * invocation carries --no-ext-diff and --no-textconv, so configured
 * external diff drivers and text converters can never execute as a
 * side effect of reading a diff.
 */

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
  if (value === '') return { label: 'working tree vs HEAD', args: ['diff', '--no-ext-diff', '--no-textconv', '--unified=3', 'HEAD', '--'] }
  if (value === '--staged' || value === '--cached') {
    return { label: 'staged changes', args: ['diff', '--no-ext-diff', '--no-textconv', '--unified=3', '--cached', '--'] }
  }
  if (value.startsWith('-') || /\s/u.test(value)) throw new Error('usage: /diff [--staged|git-ref]')
  return { label: `changes since ${value}`, args: ['diff', '--no-ext-diff', '--no-textconv', '--unified=3', value, '--'] }
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

/** Arguments for the unstaged-only fallback below. */
const UNSTAGED_DIFF_ARGS = ['diff', '--no-ext-diff', '--no-textconv', '--unified=3', '--'] as const

/** Whether the repository has at least one commit (a HEAD revision). */
function hasHeadRevision(cwd: string, signal?: AbortSignal): Promise<boolean> {
  return executeGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], signal)
    .then(() => true)
    .catch(() => false)
}

/**
 * Load one complete textual diff without invoking external programs.
 * @param signal - aborted by the caller on session switches/quit, killing the
 * git subprocess instead of letting a stale repository's diff land later.
 */
export async function loadGitDiff(cwd: string, argument: string, signal?: AbortSignal): Promise<GitDiffView> {
  const spec = parseGitDiffSpec(argument)
  try {
    const text = await executeGit(cwd, spec.args, signal)
    return { title: `git diff - ${spec.label}`, files: parseGitDiffFiles(text) }
  } catch (error: unknown) {
    // Only a repository without commits (no HEAD to diff against) may
    // narrow the default form to the unstaged fallback. Every other
    // failure — output past the buffer limit, a corrupt index, a missing
    // repository, or the caller aborting between the two calls — must
    // surface, not silently shrink what /diff and /review end up seeing
    // (an aborted probe would otherwise masquerade as an unborn repo).
    if (argument.trim() !== '' || signal?.aborted === true || (await hasHeadRevision(cwd, signal))) throw error
    const text = await executeGit(cwd, UNSTAGED_DIFF_ARGS, signal)
    return { title: 'git diff - working tree (no commits yet)', files: parseGitDiffFiles(text) }
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
