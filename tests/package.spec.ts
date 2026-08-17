import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type PackageManifest = {
  peerDependencies: Record<string, string>
  peerDependenciesMeta: Record<string, { optional?: boolean }>
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
})
