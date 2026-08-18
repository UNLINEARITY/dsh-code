import { describe, expect, it } from 'vitest'
import { buildReviewPrompt, parseGitDiffSpec } from '../src/git-workflow.ts'

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
})
