/** Read-only Git inspection used by /diff and /review. */

import { execFile } from 'node:child_process'

export interface GitDiffSpec {
  readonly label: string
  readonly args: readonly string[]
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

function executeGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(stderr.trim() || error.message))
        return
      }
      resolve(stdout.replace(/\r\n/gu, '\n'))
    })
  })
}

/** Load one complete textual diff without invoking external diff drivers. */
export async function loadGitDiff(cwd: string, argument: string): Promise<{ title: string; text: string }> {
  const spec = parseGitDiffSpec(argument)
  try {
    const text = await executeGit(cwd, spec.args)
    return { title: `git diff - ${spec.label}`, text: text === '' ? '(no changes)' : text }
  } catch (error: unknown) {
    // An unborn repository has no HEAD. Preserve useful unstaged output for
    // the default form while still surfacing all other Git failures.
    if (argument.trim() !== '') throw error
    const text = await executeGit(cwd, ['diff', '--no-ext-diff', '--unified=3', '--'])
    return { title: 'git diff - working tree', text: text === '' ? '(no changes)' : text }
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
