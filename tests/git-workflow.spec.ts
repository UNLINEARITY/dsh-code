import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildReviewPrompt,
  listReviewBranches,
  listReviewCommits,
  loadGitDiff,
  mergeBaseWith,
  parseGitDiffFiles,
  parseGitDiffSpec,
  parseReviewArgument,
  loadCommitDiff,
  gitBranch,
  parseReviewConclusion,
  reviewSummaryLine,
} from '../src/git-workflow.ts'

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
  await runGit(dir, 'init', '--initial-branch=main')
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

  describe('/review targets', () => {
    it('treats every argument as a note over the uncommitted working tree', () => {
      expect(parseReviewArgument('')).toEqual({ kind: 'uncommitted' })
      expect(parseReviewArgument('  ')).toEqual({ kind: 'uncommitted' })
      expect(parseReviewArgument('使用中文')).toEqual({ kind: 'custom', instructions: '使用中文' })
      expect(parseReviewArgument('focus on concurrency safety')).toEqual({ kind: 'custom', instructions: 'focus on concurrency safety' })
      expect(() => parseReviewArgument('--staged')).toThrow(/usage/)
      expect(() => parseReviewArgument('x'.repeat(4001))).toThrow(/too long/)
    })

    it('pastes the diff with priorities, anchors, truncation marker, and the note', () => {
      const prompt = buildReviewPrompt('+one line', 'working tree vs HEAD', '使用中文', 4)
      expect(prompt).toContain('```diff')
      expect(prompt).toContain('+one')
      expect(prompt).toContain('Scope: working tree vs HEAD')
      expect(prompt).toContain('diff truncated by CLI')
      expect(prompt).toContain('User note: 使用中文')
      expect(prompt).toContain('[P0]')
      expect(prompt).toContain('[P3]')
      // No note, no truncation: the markers stay out.
      const plain = buildReviewPrompt('+one', 'x')
      expect(plain).not.toContain('User note')
      expect(plain).not.toContain('truncated')
    })

    it('resolves merge bases against a real repository and degrades cleanly', async () => {
      const root = mkdtempSync(join(tmpdir(), 'dsh-review-'))
      await runGit(root, 'init', '--initial-branch=main')
      await runGit(root, 'config', 'user.email', 't@t')
      await runGit(root, 'config', 'user.name', 't')
      writeFileSync(join(root, 'a.txt'), 'one\n')
      await runGit(root, 'add', 'a.txt')
      await runGit(root, 'commit', '-m', 'first')
      const base = await mergeBaseWith(root, 'main')
      expect(base).toMatch(/^[0-9a-f]{40}$/u)
      expect(await mergeBaseWith(root, 'no-such-branch')).toBeUndefined()
    }, 15_000)
    it('lists picker branches and commits from a real repository', async () => {
      const root = mkdtempSync(join(tmpdir(), 'dsh-review-lists-'))
      await runGit(root, 'init', '--initial-branch=main')
      await runGit(root, 'config', 'user.email', 't@t')
      await runGit(root, 'config', 'user.name', 't')
      writeFileSync(join(root, 'a.txt'), 'one\n')
      await runGit(root, 'add', 'a.txt')
      await runGit(root, 'commit', '-m', 'first commit')
      writeFileSync(join(root, 'b.txt'), 'two\n')
      await runGit(root, 'add', 'b.txt')
      await runGit(root, 'commit', '-m', 'second commit')
      await runGit(root, 'branch', 'feature-x')
      await runGit(root, 'checkout', '-b', 'feature-y')
      writeFileSync(join(root, 'c.txt'), 'three\n')
      await runGit(root, 'add', 'c.txt')
      await runGit(root, 'commit', '-m', 'third commit')

      // The current branch never offers reviewing against itself.
      const branches = await listReviewBranches(root)
      expect(branches.map(branch => branch.name)).toContain('main')
      expect(branches.map(branch => branch.name)).toContain('feature-x')
      expect(branches.map(branch => branch.name)).not.toContain('feature-y')

      // Commits on the current branch, newest first, with titles and times.
      const commits = await listReviewCommits(root)
      expect(commits.map(commit => commit.title)).toEqual(['third commit', 'second commit', 'first commit'])
      expect(commits[0].sha).toMatch(/^[0-9a-f]{40}$/u)
      expect(commits[0].at).toBeGreaterThanOrEqual(commits[1].at)
    }, 15_000)
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

describe('git workflow adapters', () => {
  it('loadCommitDiff shows the parent diff and falls back to the full root patch', async () => {
    const dir = await tempRepo()
    const head = (): Promise<string> => new Promise((resolve, reject) => {
      execFile('git', ['rev-parse', 'HEAD'], { cwd: dir }, (error, stdout) => {
        if (error !== null) reject(new Error(error.message)); else resolve(stdout.trim())
      })
    })
    try {
      await writeFile(join(dir, 'a.txt'), 'one\n')
      await runGit(dir, 'add', 'a.txt')
      await runGit(dir, ...IDENTITY, 'commit', '-m', 'root')
      const rootSha = await head()
      // Root commit: no parent, so the show fallback carries the whole patch.
      const root = await loadCommitDiff(dir, rootSha)
      expect(root.title).toContain('commit')
      expect(root.files.map(file => file.path)).toContain('a.txt')

      const controller = new AbortController()
      controller.abort()
      await expect(loadCommitDiff(dir, rootSha, controller.signal)).rejects.toThrow()

      await writeFile(join(dir, 'b.txt'), 'two\n')
      await runGit(dir, 'add', 'b.txt')
      await runGit(dir, ...IDENTITY, 'commit', '-m', 'second')
      const secondSha = await head()
      const second = await loadCommitDiff(dir, secondSha)
      expect(second.files.map(file => file.path)).toEqual(['b.txt'])
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }, 30_000)

  it('gitBranch reads the checked-out branch and degrades outside a repository', async () => {
    const dir = await tempRepo()
    try {
      expect(gitBranch(dir)).toBe('main')
      const missing = gitBranch(join(dir, 'not-a-repository'))
      expect(missing).toBe('')
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('loadGitDiff surfaces a bad explicit ref instead of narrowing', async () => {
    const dir = await tempRepo()
    try {
      await writeFile(join(dir, 'a.txt'), 'x\n')
      await runGit(dir, 'add', 'a.txt')
      await runGit(dir, ...IDENTITY, 'commit', '-m', 'root')
      await expect(loadGitDiff(dir, 'no-such-ref')).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }, 30_000)
})

describe('review conclusion parsing', () => {
  it('parses whole-text JSON findings, strips [Pn] tags, and keeps the verdict', () => {
    const text = JSON.stringify({
      findings: [
        { title: ' [P1] off-by-one in loop', priority: 1, path: 'src/a.ts', range: 'L10-L12' },
        { title: 'no priority given' },
        { title: '   ', priority: 0 },
        { title: 'priority out of range', priority: 9 },
        'not an object',
      ],
      overall: 'incorrect',
    })
    const conclusion = parseReviewConclusion(text)
    expect(conclusion).toBeDefined()
    expect(conclusion!.findings.map(finding => finding.title)).toEqual(['off-by-one in loop', 'no priority given', 'priority out of range'])
    expect(conclusion!.findings[0]).toMatchObject({ priority: 1, path: 'src/a.ts', range: 'L10-L12' })
    expect(conclusion!.findings[1].priority).toBeUndefined()
    expect(conclusion!.overall).toBe('incorrect')
  })

  it('falls back to the first balanced JSON object inside prose and accepts correct', () => {
    const conclusion = parseReviewConclusion(`I reviewed it.\nhere you go: {"findings":[{"title":"x","priority":3}],"overall":"correct"} trailing words {"discarded":true}`)
    expect(conclusion).toBeDefined()
    expect(conclusion!.findings).toEqual([{ priority: 3, title: 'x' }])
    expect(conclusion!.overall).toBe('correct')
  })

  it('returns undefined for non-JSON and malformed replies', () => {
    expect(parseReviewConclusion('looks good to me')).toBeUndefined()
    expect(parseReviewConclusion('[1, 2, 3]')).toBeUndefined()
    expect(parseReviewConclusion('{"findings": 5}')).toBeDefined()
    expect(parseReviewConclusion('{not json {"a":1}')).toBeUndefined()
  })

  it('summary line counts per priority and phrases the verdicts', () => {
    const at = (findings: readonly { priority?: number; title: string }[], overall?: 'correct' | 'incorrect'): string =>
      reviewSummaryLine({ findings, ...(overall === undefined ? {} : { overall }) })
    expect(at([{ title: 'a', priority: 0 }, { title: 'b', priority: 0 }, { title: 'c', priority: 3 }, { title: 'd' }], 'incorrect'))
      .toMatch(/P0×2 P3×1/u)
    expect(at([{ title: 'only' }])).toMatch(/1/u)
    expect(at([], 'correct')).toMatch(/no issues found/u)
    expect(at([{ title: 'a', priority: 2 }], 'correct')).toMatch(/correct/u)
    expect(at([])).toBeTypeOf('string')
  })
})
