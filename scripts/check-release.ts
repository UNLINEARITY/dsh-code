import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const RELEASE_TAG = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/u

/** Return every release-identity mismatch without performing side effects. */
export function releaseConsistencyErrors(
  tag: string,
  version: string,
  noteExists: (path: string) => boolean,
): readonly string[] {
  const errors: string[] = []
  if (!RELEASE_TAG.test(tag)) {
    errors.push(`release tag must be semver without a v prefix, received "${tag}"`)
    return errors
  }
  if (version !== tag) errors.push(`release tag ${tag} does not match package version ${version}`)
  for (const suffix of ['.md', '_CN.md']) {
    const path = `docs/releases/${tag}${suffix}`
    if (!noteExists(path)) errors.push(`missing release notes: ${path}`)
  }
  return errors
}

function main(): void {
  const tag = process.argv[2] ?? ''
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('package.json has no string version')
  const errors = releaseConsistencyErrors(tag, manifest.version, existsSync)
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`release check: ${error}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`release check: ${tag} matches package metadata and bilingual notes\n`)
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) main()
