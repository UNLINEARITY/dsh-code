/**
 * Runner-side reads and atomic writes for the user profile's
 * `cordis.patch.yml` — the layer the /hooks and /lsp wizards edit. The file
 * is plain YAML (bundle layers carry the `!!js` tags, the user layer does
 * not); a file that fails plain-YAML parsing is refused rather than
 * rewritten, so a surprising layer never loses content. Every write goes
 * through one backup + tmp + rename path.
 *
 * @module @deepseek-ai/dsh-code/runner/profile-patch
 */

import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dump, load } from 'js-yaml'

/** One loader patch entry as the profile file spells it. */
export interface ProfilePatchRow {
  id?: string
  name?: string
  disabled?: boolean
  config?: Record<string, unknown> & { servers?: Record<string, unknown> }
  [key: string]: unknown
}

/** Refused file shape: never thrown for a missing file (empty layer). */
export class ProfilePatchShapeError extends Error {}

/**
 * Read the profile patch as rows; a missing file is an empty layer, a
 * non-array or unparsable file is refused loudly.
 * @param patchPath - absolute path to the profile's cordis.patch.yml.
 */
export function readProfilePatch(patchPath: string): readonly ProfilePatchRow[] {
  let text: string
  try {
    text = readFileSync(patchPath, 'utf8')
  } catch {
    return []
  }
  if (text.trim() === '') return []
  let doc: unknown
  try {
    doc = load(text)
  } catch (error: unknown) {
    throw new ProfilePatchShapeError(`profile patch is not plain YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(doc)) throw new ProfilePatchShapeError('profile patch is not a row array')
  return doc as ProfilePatchRow[]
}

/**
 * Persist rows atomically: timestamped backup beside the file, tmp write,
 * rename over. The dump keeps block literals readable.
 * @param patchPath - absolute path to the profile's cordis.patch.yml.
 * @param rows - the complete next row set.
 */
export function writeProfilePatch(patchPath: string, rows: readonly ProfilePatchRow[]): void {
  copyFileSync(patchPath, `${patchPath}.bak-${new Date().toISOString().replace(/[:.]/gu, '-')}`)
  const tmp = `${patchPath}.tmp`
  writeFileSync(tmp, `${dump(rows, { lineWidth: 120 })}\n`)
  renameSync(tmp, patchPath)
}

/**
 * Replace or append one row keyed by id, leaving every other row in place.
 * @param rows - the current row set.
 * @param row - the row whose id addresses it.
 */
export function upsertProfileRow(rows: readonly ProfilePatchRow[], row: ProfilePatchRow): readonly ProfilePatchRow[] {
  const id = row.id
  if (id === undefined) throw new Error('profile row upsert requires an id')
  let replaced = false
  const next = rows.map(existing => {
    if (existing.id !== id) return existing
    replaced = true
    return row
  })
  return replaced ? next : [...next, row]
}

/**
 * Merge one language-server entry into an lsp-stdio row's servers map,
 * creating the row (and its two companion rows) when absent. The map key is
 * the leading-dot extension; an existing entry for the same key is replaced.
 */
export function upsertLspServers(
  rows: readonly ProfilePatchRow[],
  entries: readonly { extension: string; language: string; command: string }[],
): readonly ProfilePatchRow[] {
  const servers: Record<string, { command: string; extensionToLanguage: Record<string, string> }> = {}
  const existingRow = rows.find(row => row.id === 'lsp-stdio')
  const existingServers = existingRow?.config?.servers
  if (existingServers !== undefined && typeof existingServers === 'object') {
    for (const [key, value] of Object.entries(existingServers)) {
      if (value !== null && typeof value === 'object') servers[key] = value as { command: string; extensionToLanguage: Record<string, string> }
    }
  }
  for (const entry of entries) {
    servers[entry.extension] = {
      command: entry.command,
      extensionToLanguage: { [entry.extension]: entry.language },
    }
  }
  const lspStdio: ProfilePatchRow = {
    id: 'lsp-stdio',
    name: '@deepseek-ai/dsh-lsp-stdio',
    config: { ...(existingRow?.config ?? {}), servers },
  }
  const withStdio = upsertProfileRow(rows, lspStdio)
  const withLsp = upsertProfileRow(withStdio, { id: 'lsp', name: '@deepseek-ai/dsh-lsp' })
  return upsertProfileRow(withLsp, { id: 'tool-lsp', name: '@deepseek-ai/dsh-tool-lsp' })
}

/**
 * Remove the listed extensions' servers from the lsp-stdio row. When the
 * last server leaves, the three rows ship disabled instead of carrying an
 * empty servers table (the config schema requires a non-empty map).
 */
export function removeLspServers(
  rows: readonly ProfilePatchRow[],
  extensions: readonly string[],
): readonly ProfilePatchRow[] {
  const drop = new Set(extensions)
  const stdioRow = rows.find(row => row.id === 'lsp-stdio')
  const servers = stdioRow?.config?.servers
  if (servers === undefined || typeof servers !== 'object') return rows
  const kept = Object.fromEntries(Object.entries(servers).filter(([extension]) => !drop.has(extension)))
  const hasServers = Object.keys(kept).length > 0
  const disabled: ProfilePatchRow = { id: 'lsp-stdio', name: '@deepseek-ai/dsh-lsp-stdio', disabled: true }
  const stdioNext: ProfilePatchRow = hasServers
    ? { id: 'lsp-stdio', name: '@deepseek-ai/dsh-lsp-stdio', config: { ...(stdioRow?.config ?? {}), servers: kept } }
    : disabled
  const withStdio = upsertProfileRow(rows, stdioNext)
  const flag = (row: ProfilePatchRow): ProfilePatchRow =>
    hasServers ? { id: row.id, name: row.name } : { id: row.id, name: row.name, disabled: true }
  const withLsp = upsertProfileRow(withStdio, flag({ id: 'lsp', name: '@deepseek-ai/dsh-lsp' }))
  return upsertProfileRow(withLsp, flag({ id: 'tool-lsp', name: '@deepseek-ai/dsh-tool-lsp' }))
}
