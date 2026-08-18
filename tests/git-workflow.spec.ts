import { describe, expect, it } from 'vitest'
import { buildReviewPrompt, parseGitDiffFiles, parseGitDiffSpec } from '../src/git-workflow.ts'

describe('Git workflow', () => {
  it('parses default, staged, and ref diffs without option injection', () => {
    expect(parseGitDiffSpec('')).toMatchObject({ label: 'working tree vs HEAD' })
    expect(parseGitDiffSpec('--staged').args).toContain('--cached')
    expect(parseGitDiffSpec('main').args).toEqual(['diff', '--no-ext-diff', '--unified=3', 'main', '--'])
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
})
