/**
 * Load-time DeepSeek Harness version gate.
 *
 * The terminal driver is validated against exactly one Harness snapshot, and
 * the host resolves every bare `@deepseek-ai/*` import the plugin makes
 * against ITS OWN installed copies (the profile's `HostResolvedRootInclude`
 * redirects bare names to the installed-host base). No install-time or
 * load-time check exists anywhere on that path, so a user who updates `dsh`
 * would otherwise run this build against unvetted upstream code silently.
 *
 * This gate mirrors how the host itself reads its identity: the running CLI
 * entry (`process.argv[1]`) sits inside the `@deepseek-ai/dsh` package, whose
 * manifest version is released in lockstep with the Harness packages bundled
 * beside it. When the probe can identify the host it compares the running
 * versions against the one this build declares and fails fast with an
 * actionable message; when it cannot identify the host it stays silent rather
 * than brick a supported embedding on a false positive.
 *
 * @module @deepseek-ai/dsh-code/runner/harness-gate
 */

import { realpathSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The one Harness release this build was validated against. */
export const EXPECTED_HARNESS_VERSION = '0.1.5-rc.2'

/** Host packages whose bundled copy the plugin binds to at runtime. */
export const HARNESS_GATE_PACKAGES = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-session',
] as const

/** The installed-host CLI package that carries the Harness runtime. */
const HOST_PACKAGE_NAME = '@deepseek-ai/dsh'

/** Filesystem slice the probe needs; injectable so tests stay pure. */
export interface HarnessFs {
  /** Resolve a symlinked entry to its real path. */
  realpathSync(path: string): string
  /** Read and parse one package.json; undefined when absent or unreadable. */
  readManifest(path: string): { name?: unknown; version?: unknown } | undefined
}

const defaultHarnessFs: HarnessFs = {
  realpathSync: path => realpathSync(path),
  readManifest: path => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown; version?: unknown }
    } catch {
      return undefined
    }
  },
}

/** What the probe learned about the running host. */
export interface HarnessProbe {
  /** Installed-host package root, when identified. */
  readonly hostRoot?: string
  /** Installed-host CLI version (`@deepseek-ai/dsh`). */
  readonly hostVersion?: string
  /** Version of each gate package bundled beside the host, when present. */
  readonly packages: Readonly<Record<string, string | undefined>>
}

const UNKNOWN_PROBE: HarnessProbe = { packages: {} }

/**
 * Walk up from one directory to the nearest `@deepseek-ai/dsh` package root.
 * @param start - directory of the running CLI entry (already realpath'd).
 * @param fs - filesystem slice to walk with.
 * @returns the host package root, or undefined when no ancestor matches.
 */
function findHostRoot(start: string, fs: HarnessFs): string | undefined {
  let directory = start
  for (;;) {
    const manifest = fs.readManifest(join(directory, 'package.json'))
    if (manifest !== undefined && manifest.name === HOST_PACKAGE_NAME) return directory
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * Identify the running host and the Harness versions it provides.
 * @param argv1 - `process.argv[1]`, the running CLI entry path.
 * @param fs - filesystem slice; defaults to the real one.
 * @returns the probe result; `packages` is empty when the host is unknown.
 */
export function probeRunningHarness(argv1: string | undefined, fs: HarnessFs = defaultHarnessFs): HarnessProbe {
  if (argv1 === undefined || argv1 === '') return UNKNOWN_PROBE
  let entry: string
  try {
    entry = fs.realpathSync(argv1)
  } catch {
    return UNKNOWN_PROBE
  }
  const hostRoot = findHostRoot(dirname(entry), fs)
  if (hostRoot === undefined) return UNKNOWN_PROBE
  const hostManifest = fs.readManifest(join(hostRoot, 'package.json'))
  const hostVersion = typeof hostManifest?.version === 'string' ? hostManifest.version : undefined
  const packages: Record<string, string | undefined> = {}
  for (const name of HARNESS_GATE_PACKAGES) {
    const manifest = fs.readManifest(join(hostRoot, 'node_modules', name, 'package.json'))
    if (typeof manifest?.version === 'string') packages[name] = manifest.version
  }
  return { hostRoot, hostVersion, packages }
}

/** One host fact that disagrees with the version this build declares. */
export interface HarnessMismatch {
  /** What was compared: the host CLI or one bundled package. */
  readonly source: string
  /** The version this build was validated against. */
  readonly expected: string
  /** The version the running host actually provides. */
  readonly provided: string
}

/**
 * Compare one probe against the expected snapshot. Unknown facts never
 * mismatch: the gate must stay silent when it cannot judge, not brick a
 * supported embedding on missing evidence.
 * @param expected - the Harness version this build declares.
 * @param probe - the running host's identified versions.
 * @returns every concrete disagreement, empty when compatible or unknown.
 */
export function harnessVersionMismatches(expected: string, probe: HarnessProbe): readonly HarnessMismatch[] {
  const mismatches: HarnessMismatch[] = []
  if (probe.hostVersion !== undefined && probe.hostVersion !== expected) {
    mismatches.push({ source: `${HOST_PACKAGE_NAME} host`, expected, provided: probe.hostVersion })
  }
  for (const name of HARNESS_GATE_PACKAGES) {
    const provided = probe.packages[name]
    if (provided !== undefined && provided !== expected) {
      mismatches.push({ source: name, expected, provided })
    }
  }
  return mismatches
}

/**
 * Render the gate failure the user sees on stderr.
 * @param expected - the Harness version this build declares.
 * @param mismatches - the disagreements to report.
 * @param hostRoot - installed-host root, when identified, for the fix hint.
 * @returns the multi-line diagnostic.
 */
export function harnessGateMessage(expected: string, mismatches: readonly HarnessMismatch[], hostRoot?: string): string {
  const lines = [`dsh: this dsh-code build requires DeepSeek Harness ${expected}, but this dsh provides:`]
  for (const mismatch of mismatches) lines.push(`dsh:   ${mismatch.source} ${mismatch.provided}`)
  lines.push('dsh: update dsh-code to a release built for this dsh, or use a dsh matching ' + expected + '.')
  if (hostRoot !== undefined) lines.push(`dsh: running host: ${hostRoot}`)
  return lines.join('\n')
}

/**
 * Refuse to run against an identified-but-incompatible host.
 * @param expected - the Harness version this build declares.
 * @param probe - the running host's identified versions.
 * @throws an Error carrying the gate diagnostic when a version disagrees.
 */
export function requireHarnessVersion(expected: string, probe: HarnessProbe): void {
  const mismatches = harnessVersionMismatches(expected, probe)
  if (mismatches.length === 0) return
  throw new Error(harnessGateMessage(expected, mismatches, probe.hostRoot))
}
