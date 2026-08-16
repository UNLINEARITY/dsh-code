/** Installed package-version surface for the terminal header. */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DSH_CODE_VERSION, readPackageVersion } from '../src/version.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

describe('readPackageVersion', () => {
  it('matches the installed package manifest', () => {
    expect(DSH_CODE_VERSION).toBe(manifest.version)
  })

  it('falls back without making startup depend on package metadata', () => {
    expect(readPackageVersion(new URL('./missing-package.json', import.meta.url))).toBe('0.0.0')
  })
})
