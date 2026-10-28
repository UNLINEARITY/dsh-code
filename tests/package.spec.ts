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
    expect(new Set(versions)).toEqual(new Set(['0.2.1-rc.4']))
  })
})
