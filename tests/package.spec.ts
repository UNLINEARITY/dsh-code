import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type PackageManifest = {
  packageManager: string
  bundleDependencies: boolean
  scripts: Record<string, string>
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
  peerDependenciesMeta: Record<string, { optional?: boolean }>
  devDependencies: Record<string, string>
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageManifest

describe('package tooling contract', () => {
  it('pins the pnpm release used by local and CI installs', () => {
    expect(manifest.packageManager).toBe('pnpm@12.4.1')
  })
  it('supports npm publish with audited bundled dependencies instead of a hard refusal', () => {
    expect(manifest.bundleDependencies).toBe(true)
    expect(manifest.scripts.prepublishOnly).toContain('scripts/verify-publish.ts')
    expect(manifest.scripts.prepublishOnly).not.toContain('throw new Error')
  })
})

describe('package peer dependencies', () => {
  it('uses host-owned Harness packages without shipping a second runtime', () => {
    const hostBundled = JSON.parse(readFileSync(new URL('./host-bundled.json', import.meta.url), 'utf8')) as string[]
    expect(Object.keys(manifest.dependencies).filter(name => name.startsWith('@deepseek-ai/'))).toEqual([])
    for (const name of Object.keys(manifest.peerDependencies).filter(name => name.startsWith('@deepseek-ai/'))) {
      // Optional extensions are compiled locally but installed into the
      // profile only when enabled; host-owned packages need no extra copy.
      if (!hostBundled.includes(name) || manifest.devDependencies[name] === undefined) continue
      expect(manifest.devDependencies[name]).toBe(manifest.peerDependencies[name])
    }
  })
  it('leaves Harness peers for the DSH profile instead of npm auto-installation', () => {
    expect(Object.keys(manifest.peerDependenciesMeta).sort()).toEqual(
      Object.keys(manifest.peerDependencies).sort(),
    )
    expect(
      Object.values(manifest.peerDependenciesMeta).every(metadata => metadata.optional === true),
    ).toBe(true)
  })

  it('keeps every Harness package on one release candidate line', () => {
    const versions = [manifest.dependencies, manifest.peerDependencies, manifest.devDependencies]
      .flatMap(group => Object.entries(group))
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
      .map(([, version]) => version)
    expect(new Set(versions)).toEqual(new Set(['0.2.2-rc.1']))
  })
})
