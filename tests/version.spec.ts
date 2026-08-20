/** Kernel-version resolver rules: the manifest walk must only trust the real host package. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { _resetDshKernelVersionForTests, dshKernelVersion, resolveDshHostVersion } from '../src/version.ts'

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** Create an isolated fixture tree and write one manifest file inside it. */
function makeFixture(manifestPath: string, manifest: Record<string, unknown> | string): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-version-'))
  roots.push(root)
  const file = join(root, manifestPath)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  return root
}

describe('resolveDshHostVersion', () => {
  it('resolves the host manifest above a lib entry (npm-global layout)', () => {
    const root = makeFixture(
      join('@deepseek-ai', 'dsh', 'package.json'),
      { name: '@deepseek-ai/dsh', version: '0.1.0-rc.8' },
    )
    mkdirSync(join(root, '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    expect(resolveDshHostVersion(join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))).toBe('0.1.0-rc.8')
  })

  it('resolves when the entry sits directly beside the manifest', () => {
    const root = makeFixture('host/package.json', { name: '@deepseek-ai/dsh', version: '1.2.3' })
    expect(resolveDshHostVersion(join(root, 'host', 'bin.js'))).toBe('1.2.3')
  })

  it('ignores manifests from other packages', () => {
    const root = makeFixture('vitest/package.json', { name: 'vitest', version: '9.9.9' })
    expect(resolveDshHostVersion(join(root, 'vitest', 'lib', 'cli.js'))).toBeUndefined()
  })

  it('treats malformed manifests as absent', () => {
    const root = makeFixture('host/package.json', 'not json at all')
    expect(resolveDshHostVersion(join(root, 'host', 'bin.js'))).toBeUndefined()
  })

  it('rejects empty versions', () => {
    const root = makeFixture('host/package.json', { name: '@deepseek-ai/dsh', version: '' })
    expect(resolveDshHostVersion(join(root, 'host', 'bin.js'))).toBeUndefined()
  })

  it('stops climbing after four levels without a host manifest', () => {
    const root = makeFixture('marker/package.json', { name: 'marker', version: '0.0.0' })
    const entry = join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'bin.js')
    mkdirSync(dirname(entry), { recursive: true })
    expect(resolveDshHostVersion(entry)).toBeUndefined()
  })

  it('returns undefined for missing or empty entries', () => {
    expect(resolveDshHostVersion(undefined)).toBeUndefined()
    expect(resolveDshHostVersion('')).toBeUndefined()
  })
})

describe('dshKernelVersion memo', () => {
  it('memoizes the first probe until the test reset', () => {
    const root = makeFixture(
      join('@deepseek-ai', 'dsh', 'package.json'),
      { name: '@deepseek-ai/dsh', version: '0.1.0-rc.8' },
    )
    const previous = process.argv[1]
    try {
      process.argv[1] = join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      _resetDshKernelVersionForTests()
      expect(dshKernelVersion()).toBe('0.1.0-rc.8')
      process.argv[1] = join(root, 'unrelated.js')
      expect(dshKernelVersion()).toBe('0.1.0-rc.8')
    } finally {
      process.argv[1] = previous
      _resetDshKernelVersionForTests()
    }
  })
})
