import { describe, expect, it } from 'vitest'
import { releaseConsistencyErrors, releaseTagArgument } from '../scripts/check-release.ts'

const notes = (paths: readonly string[]): ((path: string) => boolean) => {
  const existing = new Set(paths)
  return path => existing.has(path)
}

describe('releaseTagArgument', () => {
  it('keeps an explicit workflow tag', () => {
    expect(releaseTagArgument('1.2.1', '9.9.9')).toBe('1.2.1')
  })

  it('uses package metadata only for the explicit npm publish mode', () => {
    expect(releaseTagArgument('--package-version', '1.2.1')).toBe('1.2.1')
    expect(releaseTagArgument(undefined, '1.2.1')).toBe('')
  })
})

describe('releaseConsistencyErrors', () => {
  it('accepts an aligned version with bilingual release notes', () => {
    expect(releaseConsistencyErrors('1.2.1', '1.2.1', notes([
      'docs/releases/1.2.1.md',
      'docs/releases/1.2.1_CN.md',
    ]))).toEqual([])
  })

  it('reports version and note mismatches together', () => {
    expect(releaseConsistencyErrors('1.2.1', '1.2.0', notes([]))).toEqual([
      'release tag 1.2.1 does not match package version 1.2.0',
      'missing release notes: docs/releases/1.2.1.md',
      'missing release notes: docs/releases/1.2.1_CN.md',
    ])
  })

  it('rejects tags outside the supported release naming scheme', () => {
    expect(releaseConsistencyErrors('v1.2.1', '1.2.1', notes([]))).toEqual([
      'release tag must be semver without a v prefix, received "v1.2.1"',
    ])
  })

  it('accepts the prerelease forms used by the project', () => {
    expect(releaseConsistencyErrors('1.3.0-rc.2', '1.3.0-rc.2', notes([
      'docs/releases/1.3.0-rc.2.md',
      'docs/releases/1.3.0-rc.2_CN.md',
    ]))).toEqual([])
  })
})
