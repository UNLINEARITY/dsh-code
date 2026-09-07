import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildReviewPrompt, loadGitDiff, parseGitDiffFiles, parseGitDiffSpec } from '../src/git-workflow.ts'

/** Run git in one directory, rejecting with git's own message on failure. */
function runGit(cwd: string, ...args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (error, _stdout, stderr) => {
      if (error !== null) reject(new Error(stderr.trim() || error.message))
      else resolve()
    })
  })
}

/** One throwaway git repository per test. */
async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gitwork-'))
  await runGit(dir, 'init')
  return dir
}

/** Inline commit identity: temporary repositories have no user config. */
const IDENTITY = ['-c', 'user.email=dsh@dsh', '-c', 'user.name=dsh'] as const

describe('Git workflow', () => {
  it('parses default, staged, and ref diffs without option injection', () => {
    expect(parseGitDiffSpec('')).toMatchObject({ label: 'working tree vs HEAD' })
    expect(parseGitDiffSpec('').args).toContain('--no-textconv')
    expect(parseGitDiffSpec('--staged').args).toContain('--cached')
    expect(parseGitDiffSpec('--staged').args).toContain('--no-textconv')
    expect(parseGitDiffSpec('main').args).toEqual(['diff', '--no-ext-diff', '--no-textconv', '--unified=3', 'main', '--'])
    expect(() => parseGitDiffSpec('--output=/tmp/x')).toThrow('usage')
    expect(() => parseGitDiffSpec('main other')).toThrow('usage')
  })

  it('builds an explicitly read-only, bounded review prompt', () => {
    const prompt = buildReviewPrompt('x'.repeat(20), 'working tree', 8)
    expect(prompt).toContain('Do not modify files')
    expect(prompt).toContain('diff truncated by CLI')
    expect(prompt).toContain('xxxxxxxx\n```')
  })

  it('keeps unified patches grouped by file for the terminal diff picker', () => {
    const files = parseGitDiffFiles([
      'diff --git a/src/a.ts b/src/a.ts',
      'index 0000000..1111111 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '+added',
    ].join('\n'))
    expect(files.map(file => file.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(files[0]?.lines).toContain('-old')
    expect(files[1]?.lines).toContain('+added')
  })

  it('rejects an aborted diff load instead of letting a stale repository review land', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(loadGitDiff(process.cwd(), '', controller.signal)).rejects.toThrow()
  })

  it('keeps the default diff scoped to HEAD so staged changes stay visible', async () => {
    const dir = await tempRepo()
    try {
      await writeFile(join(dir, 'a.txt'), 'one\n')
      await runGit(dir, 'add', 'a.txt')
      await runGit(dir, ...IDENTITY, 'commit', '-m', 'root')
      await writeFile(join(dir, 'b.txt'), 'new\n')
      await runGit(dir, 'add', 'b.txt')
      await writeFile(join(dir, 'a.txt'), 'one\ntwo\n')
      const view = await loadGitDiff(dir, '')
      const paths = view.files.map(file => file.path)
      expect(paths).toContain('a.txt')
      expect(paths).toContain('b.txt')
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }, 30_000)

  it('narrows to the unstaged fallback only in a repository without commits', async () => {
    const dir = await tempRepo()
    try {
      await writeFile(join(dir, 'staged.txt'), 'staged\n')
      await runGit(dir, 'add', 'staged.txt')
      const view = await loadGitDiff(dir, '')
      expect(view.title).toContain('no commits yet')
      // A staged-only change is invisible without a HEAD to diff against,
      // exactly like git itself in an unborn repository.
      expect(view.files).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }, 30_000)

  it('still rejects explicit refs in a repository without commits', async () => {
    const dir = await tempRepo()
    try {
      // Only the default form narrows to the unstaged fallback; a named
      // ref that cannot resolve must keep throwing.
      await expect(loadGitDiff(dir, 'HEAD')).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }, 30_000)

  it('surfaces an over-limit default diff instead of silently narrowing it', async () => {
    const dir = await tempRepo()
    try {
      await runGit(dir, ...IDENTITY, 'commit', '--allow-empty', '-m', 'root')
      // A staged change past the 16 MiB output limit: the unstaged
      // fallback would see nothing and used to resolve with an empty
      // diff, silently shrinking /review to a blank scope.
      await writeFile(join(dir, 'big.txt'), `+${'x'.repeat(17 * 1024 * 1024)}`)
      await runGit(dir, 'add', 'big.txt')
      await expect(loadGitDiff(dir, '')).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }, 120_000)
})
