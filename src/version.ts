/** Installed dsh-code version exposed by the terminal header. */

import { readFileSync } from 'node:fs'

/** Read one package manifest version without making terminal startup depend on it. */
export function readPackageVersion(manifest = new URL('../package.json', import.meta.url)): string {
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Version of the installed dsh-code package. */
export const DSH_CODE_VERSION = readPackageVersion()
