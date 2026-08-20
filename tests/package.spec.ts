import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type PackageManifest = {
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
  peerDependenciesMeta: Record<string, { optional?: boolean }>
  devDependencies: Record<string, string>
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageManifest

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
    expect(new Set(versions)).toEqual(new Set(['^0.1.0-rc.8']))
  })
})
