import { readFileSync } from 'node:fs'
import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

type PackageManifest = {
  dependencies: Record<string, string>
}

/** The manifest this bundle ships. */
const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageManifest

/**
 * The @deepseek-ai packages a stock host install resolves: the direct
 * dependencies of @deepseek-ai/dsh plus every transitive package npm's flat
 * global tree hoists beside them. Generated from an installed host of the
 * aligned line:
 *
 *   ls <global root>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai \
 *     | sed 's|^|@deepseek-ai/|' | sort | node -e "…write the JSON array"
 *
 * Regenerate whenever the bundle aligns to a new harness line: an upstream
 * line that stops shipping a package turns every patch row over that
 * package into a boot failure, and this fixture is what lets the suite
 * catch that before a release instead of in a user's terminal.
 */
const hostBundled = JSON.parse(
  readFileSync(new URL('./host-bundled.json', import.meta.url), 'utf8'),
) as string[]

/**
 * cordis evaluates `!!js` expressions at load time (tool mode, platform
 * conditionals); the invariant below only needs them recognized as "not a
 * literal", so the tag constructs to a marker without evaluating anything.
 */
const patchSchema = DEFAULT_SCHEMA.extend(
  new Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: () => true, construct: () => ({ js: true }) }),
)

/** The package part of a module reference ('@scope/name/sub' → '@scope/name'). */
function packageOf(module: string): string {
  const parts = module.split('/')
  return module.startsWith('@') ? parts.slice(0, 2).join('/') : String(parts[0])
}

type PatchRow = { id?: string; name?: string; disabled?: unknown }
type PatchEntry = { insert?: PatchRow[] }

const patch = load(
  readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'),
  { schema: patchSchema },
) as PatchEntry[]

describe('bundle patch rows', () => {
  // The 1.0.7 release mounted an enabled row over @deepseek-ai/dsh-tool-
  // session-query — a package the host does not bundle and the bundle only
  // declared as an optional peer, which autoInstallPeers: false keeps out of
  // every profile. The loader resolved rows from the profile directory and
  // the boot died on ERR_MODULE_NOT_FOUND before drawing a frame. A row that
  // ships enabled is imported at boot, so its module must come from the
  // bundle itself, from a real dependency (installed into the profile with
  // the bundle), or from the host install; anything else cannot boot.
  it('mounts every load-bearing row from the bundle, its dependencies, or the host install', () => {
    const shippable = new Set([...Object.keys(manifest.dependencies ?? {}), ...hostBundled])
    const violations: string[] = []
    for (const entry of patch) {
      for (const row of entry.insert ?? []) {
        if (row.name === undefined) continue
        if (row.disabled === true) continue // ships disabled: never imported at boot
        const isSelf = row.name === 'dsh-code' || row.name.startsWith('dsh-code/')
        if (isSelf || shippable.has(packageOf(row.name))) continue
        violations.push(`${row.id ?? '(unnamed row)'} → ${row.name}`)
      }
    }
    expect(violations).toEqual([])
  })
})
