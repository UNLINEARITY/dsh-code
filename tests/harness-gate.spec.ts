/**
 * Load-time Harness version gate: host identification from the running CLI
 * entry, exact-snapshot comparison, and the fail-open rule for unknown hosts.
 * Also pins the gate's declared snapshot to the package manifest, so a bump
 * can never drift between the two.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EXPECTED_HARNESS_VERSION,
  HARNESS_GATE_PACKAGES,
  harnessGateMessage,
  harnessVersionMismatches,
  probeRunningHarness,
  requireHarnessVersion,
  type HarnessFs,
  type HarnessProbe,
} from '../src/runner/harness-gate.ts'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-gate-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** Real-filesystem host tree under the temp dir (the default probe's path). */
async function writeHost(version: string, packages: Record<string, string> = {}): Promise<string> {
  const root = join(dir, 'host')
  await mkdir(join(root, 'lib'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }), 'utf8')
  for (const [name, packageVersion] of Object.entries(packages)) {
    await mkdir(join(root, 'node_modules', name), { recursive: true })
    await writeFile(
      join(root, 'node_modules', name, 'package.json'),
      JSON.stringify({ name, version: packageVersion }),
      'utf8',
    )
  }
  return root
}

describe('manifest contract', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies: Record<string, string>
    peerDependencies: Record<string, string>
    devDependencies: Record<string, string>
  }

  it('declares exactly the snapshot the gate enforces', () => {
    const versions = [manifest.dependencies, manifest.peerDependencies, manifest.devDependencies]
      .flatMap(group => Object.entries(group))
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
      .map(([, version]) => version)
    expect(new Set(versions)).toEqual(new Set([EXPECTED_HARNESS_VERSION]))
  })

  it('probes only packages this build actually declares', () => {
    const declared = { ...manifest.dependencies, ...manifest.peerDependencies }
    for (const name of HARNESS_GATE_PACKAGES) expect(declared[name]).toBeDefined()
  })
})

describe('probeRunningHarness', () => {
  it('identifies the host by walking up from the CLI entry to its package', async () => {
    const root = await writeHost('0.1.5-rc.2', { '@deepseek-ai/dsh-agent': '0.1.5-rc.2' })
    const entry = join(root, 'lib', 'bin.js')
    await writeFile(entry, '', 'utf8')
    const probe = probeRunningHarness(entry)
    // macOS maps /var onto /private/var, so compare the resolved root.
    expect(probe.hostRoot).toBe(realpathSync(root))
    expect(probe.hostVersion).toBe('0.1.5-rc.2')
    expect(probe.packages['@deepseek-ai/dsh-agent']).toBe('0.1.5-rc.2')
    expect(probe.packages['@deepseek-ai/dsh-session']).toBeUndefined()
  })

  it('stays silent when no ancestor is the host package', async () => {
    const entry = join(dir, 'bin.js')
    await writeFile(entry, '', 'utf8')
    expect(probeRunningHarness(entry)).toEqual({ packages: {} })
  })

  it('stays silent for a missing entry or a realpath failure', () => {
    expect(probeRunningHarness(undefined)).toEqual({ packages: {} })
    expect(probeRunningHarness('')).toEqual({ packages: {} })
    const fs: HarnessFs = {
      realpathSync: () => { throw new Error('gone') },
      readManifest: () => undefined,
    }
    expect(probeRunningHarness('/anywhere/bin.js', fs)).toEqual({ packages: {} })
  })

  it('resolves the symlinked bin to the real host root like a global install', () => {
    // A global install exposes bin/dsh as a symlink into the package; the
    // probe must follow it before walking up. Injected fs keeps this
    // portable (symlink creation needs privileges on Windows).
    const root = join(dir, 'host')
    const fs: HarnessFs = {
      realpathSync: path => (path === '/nvm/bin/dsh' ? join(root, 'lib', 'bin.js') : path),
      readManifest: path => {
        if (path === join(root, 'package.json')) return { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }
        return undefined
      },
    }
    const probe = probeRunningHarness('/nvm/bin/dsh', fs)
    expect(probe.hostRoot).toBe(root)
    expect(probe.hostVersion).toBe('0.1.5-rc.2')
  })

  it('stops at the filesystem root without a host', () => {
    const fs: HarnessFs = {
      realpathSync: path => path,
      readManifest: () => ({ name: 'something-else', version: '9.9.9' }),
    }
    expect(probeRunningHarness(join(dir, 'bin.js'), fs)).toEqual({ packages: {} })
  })
})

describe('harnessVersionMismatches', () => {
  const probe = (hostVersion?: string, packages: Record<string, string | undefined> = {}): HarnessProbe =>
    ({ hostVersion, packages })

  it('accepts an exact match and treats unknown facts as silent', () => {
    expect(harnessVersionMismatches('0.1.5-rc.2', probe('0.1.5-rc.2'))).toEqual([])
    expect(harnessVersionMismatches('0.1.5-rc.2', probe(undefined))).toEqual([])
    expect(harnessVersionMismatches('0.1.5-rc.2', { hostVersion: undefined, packages: { '@deepseek-ai/dsh-agent': undefined } })).toEqual([])
  })

  it('reports a newer host as the primary mismatch', () => {
    const mismatches = harnessVersionMismatches('0.1.5-rc.2', probe('0.1.6-alpha.2'))
    expect(mismatches).toEqual([
      { source: '@deepseek-ai/dsh host', expected: '0.1.5-rc.2', provided: '0.1.6-alpha.2' },
    ])
  })

  it('reports each disagreeing bundled package separately', () => {
    const mismatches = harnessVersionMismatches('0.1.5-rc.2', probe('0.1.5-rc.2', {
      '@deepseek-ai/dsh-agent': '0.1.6-alpha.2',
      '@deepseek-ai/dsh-session': '0.1.5-rc.2',
    }))
    expect(mismatches).toEqual([
      { source: '@deepseek-ai/dsh-agent', expected: '0.1.5-rc.2', provided: '0.1.6-alpha.2' },
    ])
  })

  it('collects every disagreement at once', () => {
    const mismatches = harnessVersionMismatches('0.1.5-rc.2', probe('0.1.6-alpha.2', {
      '@deepseek-ai/dsh-agent': '0.1.6-alpha.1',
      '@deepseek-ai/dsh-session': '0.1.6-alpha.2',
    }))
    expect(mismatches).toHaveLength(3)
    expect(mismatches.map(mismatch => mismatch.source)).toEqual([
      '@deepseek-ai/dsh host',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-session',
    ])
  })
})

describe('requireHarnessVersion', () => {
  it('passes on a compatible host', () => {
    expect(() => requireHarnessVersion('0.1.5-rc.2', {
      hostRoot: '/host',
      hostVersion: '0.1.5-rc.2',
      packages: { '@deepseek-ai/dsh-agent': '0.1.5-rc.2' },
    })).not.toThrow()
  })

  it('throws a diagnostic naming both versions, the fix, and the host root', () => {
    expect(() => requireHarnessVersion('0.1.5-rc.2', {
      hostRoot: '/nvm/lib/node_modules/@deepseek-ai/dsh',
      hostVersion: '0.1.6-alpha.2',
      packages: {},
    })).toThrow(/requires DeepSeek Harness 0\.1\.5-rc\.2[\s\S]*0\.1\.6-alpha\.2[\s\S]*update dsh-code[\s\S]*running host: \/nvm/)
  })

  it('stays silent for an unidentified host instead of bricking the run', () => {
    expect(() => requireHarnessVersion('0.1.5-rc.2', { packages: {} })).not.toThrow()
  })
})

describe('harnessGateMessage', () => {
  it('lists one line per mismatch under a single header', () => {
    const message = harnessGateMessage('0.1.5-rc.2', [
      { source: '@deepseek-ai/dsh host', expected: '0.1.5-rc.2', provided: '0.1.6-alpha.2' },
    ])
    expect(message.split('\n')).toHaveLength(3)
    expect(message).toContain('dsh:   @deepseek-ai/dsh host 0.1.6-alpha.2')
  })
})
