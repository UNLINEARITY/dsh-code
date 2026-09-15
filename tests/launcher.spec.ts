import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  buildUpdateStatus,
  bundleDowngradeRefusal,
  compareHarnessLines,
  harnessLineFromPeers,
  installedGlobalDshVersion,
  localCheckoutRefusal,
  npmInvocation,
  parsePinnedPlan,
  specVersion,
  packageVersion,
  dshCommand,
  completionScript,
  operationName,
  launchDsh,
  profileArgs,
  profileDependencySpec,
  profileHasDshCode,
  profileMountedVersion,
  profilePluginDependencies,
  runSequence,
  selfInstallHint,
  setupBundle,
  updatePlan,
  updateSteps,
} from '../bin/deepseek.mjs'
import type { PackagePeers, SpawnOptions, SpawnProcess } from '../bin/deepseek.mjs'

describe('global launcher aliases', () => {
  it('recognizes wrapper operations without stealing ordinary prompts', () => {
    expect(operationName(['doctor'])).toBe('doctor')
    expect(operationName(['explain', 'doctor'])).toBeUndefined()
    expect(completionScript('powershell')).toContain('Register-ArgumentCompleter')
    expect(() => completionScript('fish')).toThrow('completion needs one shell')
  })
  it('forwards every application argument to the cli profile', () => {
    expect(profileArgs(['--resume', 'abc123'])).toEqual(['--profile', 'cli', '--resume', 'abc123'])
  })

  it('pins setup to this release so pnpm can install it on publication day', () => {
    expect(setupBundle([])).toBe('dsh-code@1.2.0')
  })

  it('starts dsh with inherited stdio and preserves its exit code', () => {
    const child = new EventEmitter()
    const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = []
    const previousExitCode = process.exitCode
    try {
      launchDsh(['--help'], (command, args, options) => {
        calls.push({ command, args, options })
        return child
      }, args => ({ command: 'dsh', args: profileArgs(args) }), () => true, () => true)
      expect(calls).toEqual([{
        command: 'dsh',
        args: ['--profile', 'cli', '--help'],
        options: { stdio: 'inherit' },
      }])
      child.emit('exit', 23, null)
      expect(process.exitCode).toBe(23)
    } finally {
      process.exitCode = previousExitCode
    }
  })

  it('fails loudly instead of hanging when the cli profile does not mount dsh-code', () => {
    const previousExitCode = process.exitCode
    const previousError = console.error
    const messages: string[] = []
    console.error = (message: unknown) => {
      messages.push(String(message))
    }
    try {
      const launched = launchDsh(['--help'], () => {
        throw new Error('must not spawn')
      }, args => ({ command: 'dsh', args: profileArgs(args) }), () => false)
      expect(launched).toBeUndefined()
      expect(process.exitCode).toBe(1)
      expect(messages[0]).toContain('dsh plugin --profile cli add dsh-code')
    } finally {
      process.exitCode = previousExitCode
      console.error = previousError
    }
  })

  it('uses DSH’s JavaScript entrypoint on Windows instead of a command shell', () => {
    const command = dshCommand(['--continue'], {
      platform: 'win32',
      moduleUrl: 'file:///C:/npm/node_modules/dsh-code/bin/deepseek.mjs',
      fileExists: () => true,
    })
    expect(command).toEqual({
      command: process.execPath,
      args: [
        'C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
        '--profile',
        'cli',
        '--continue',
      ],
    })
  })

  it('finds globally installed DSH when npm links this launcher to a checkout', () => {    const command = dshCommand(['--help'], {
      platform: 'win32',
      moduleUrl: 'file:///C:/repo/dsh-code/bin/deepseek.mjs',
      fileExists: () => false,
      roots: ['C:\\Users\\name\\AppData\\Roaming\\npm'],
      resolvePackage: (name, options) => {
        expect(name).toBe('@deepseek-ai/dsh/lib/bin.js')
        expect(options).toEqual({ paths: ['C:\\Users\\name\\AppData\\Roaming\\npm'] })
        return 'C:\\Users\\name\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
      },
    })
    expect(command).toEqual({
      command: process.execPath,
      args: [
        'C:\\Users\\name\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
        '--profile',
        'cli',
        '--help',
      ],
    })
  })
})

describe('cli profile readiness', () => {
  it('accepts a profile whose bundles mount dsh-code', () => {
    expect(profileHasDshCode(
      'C:/profiles/cli',
      path => path.endsWith('package.json'),
      () => JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-code'] } } }),
    )).toBe(true)
  })

  it('accepts a profile whose dependencies list dsh-code', () => {
    expect(profileHasDshCode(
      'C:/profiles/cli',
      path => path.endsWith('package.json'),
      () => JSON.stringify({ dependencies: { 'dsh-code': '0.6.0' } }),
    )).toBe(true)
  })

  it('rejects a bare profile, a missing profile, and unreadable manifests', () => {
    const bare = profileHasDshCode(
      'C:/profiles/cli',
      path => path.endsWith('package.json'),
      () => JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
    )
    expect(bare).toBe(false)
    expect(profileHasDshCode('C:/profiles/cli', () => false)).toBe(false)
    expect(profileHasDshCode(
      'C:/profiles/cli',
      path => path.endsWith('package.json'),
      () => '{not json',
    )).toBe(false)
  })
})

describe('npm invocation', () => {
  it('prefers the JavaScript entrypoint over the Windows .cmd shim', () => {
    const besideNode = npmInvocation({
      fileExists: path => path.endsWith('npm-cli.js'),
      roots: [],
    })
    expect(besideNode.command).toBe(process.execPath)
    expect(besideNode.args[0].endsWith('npm-cli.js')).toBe(true)
    const fromRoot = npmInvocation({
      fileExists: () => false,
      roots: ['C:/npm'],
      resolvePackage: name => `C:/npm/node_modules/${name}`,
    })
    expect(fromRoot.command).toBe(process.execPath)
    expect(fromRoot.args[0]).toContain('npm/bin/npm-cli.js')
    const fallback = npmInvocation({ fileExists: () => false, roots: [] })
    expect(typeof fallback.command).toBe('string')
    expect(fallback.args).toEqual([])
  })
})

describe('update orchestration', () => {
  it('derives the compatible harness line from the target release peers', () => {
    expect(harnessLineFromPeers({ '@deepseek-ai/dsh-session': '0.1.2-rc.1', '@deepseek-ai/cordis': '^4.0.1' })).toBe('0.1.2-rc.1')
    expect(harnessLineFromPeers({ '@deepseek-ai/dsh-llm': '0.1.2-rc.1' })).toBe('0.1.2-rc.1')
    expect(harnessLineFromPeers({ '@deepseek-ai/cordis': '^4.0.1' })).toBeUndefined()
    expect(harnessLineFromPeers(undefined)).toBeUndefined()
  })

  it('pins both installs to one line and skips the profile for checkout mounts', () => {
    const pinned = updatePlan({ latestCode: '1.0.5', peers: { '@deepseek-ai/dsh-session': '0.1.2-rc.1' }, profileSpec: '^1.0.4' })
    expect(pinned).toEqual({
      dshSpec: '@deepseek-ai/dsh@0.1.2-rc.1',
      line: '0.1.2-rc.1',
      lineLocked: true,
      codeSpec: 'dsh-code@1.0.5',
      profileStep: true,
      pluginSpecs: [],
    })
    const fallback = updatePlan({ latestCode: '1.0.5', peers: undefined, profileSpec: undefined })
    expect(fallback.dshSpec).toBe('@deepseek-ai/dsh@latest')
    expect(fallback.line).toBeUndefined()
    expect(fallback.lineLocked).toBe(false)
    const linked = updatePlan({ latestCode: '1.0.5', peers: { '@deepseek-ai/dsh-session': '0.1.2-rc.1' }, profileSpec: 'link:C:/repo/dsh-cli' })
    expect(linked.profileStep).toBe(false)
  })

  it('carries profile companion plugins to the target line in one update', () => {
    const plugins = [
      { name: '@deepseek-ai/dsh-web-search-exa', spec: '0.1.2-rc.1' },
      { name: '@deepseek-ai/dsh-web-search-perplexity', spec: '0.1.5-rc.1' },
    ]
    const plan = updatePlan({
      latestCode: '1.0.6',
      peers: { '@deepseek-ai/dsh-session': '0.1.5-rc.1' },
      profileSpec: '^1.0.5',
      profilePlugins: plugins,
    })
    // Only the plugin still pinned off the line rides along.
    expect(plan.pluginSpecs).toEqual(['@deepseek-ai/dsh-web-search-exa@0.1.5-rc.1'])
    // No locked line or a checkout mount never touches companion plugins.
    expect(updatePlan({ latestCode: '1.0.6', peers: undefined, profileSpec: '^1.0.5', profilePlugins: plugins }).pluginSpecs).toEqual([])
    expect(updatePlan({ latestCode: '1.0.6', peers: { '@deepseek-ai/dsh-session': '0.1.5-rc.1' }, profileSpec: 'link:C:/repo', profilePlugins: plugins }).pluginSpecs).toEqual([])
  })

  it('builds update steps that fail loudly and retryably', () => {
    const plan = updatePlan({
      latestCode: '1.0.6',
      peers: { '@deepseek-ai/dsh-session': '0.1.5-rc.1' },
      profileSpec: '^1.0.5',
      profilePlugins: [{ name: '@deepseek-ai/dsh-web-search-exa', spec: '0.1.2-rc.1' }],
    })
    const npm = { command: 'npm', args: [] }
    const { steps, blockers } = updateSteps({ plan, npm, resolveCommand: args => ({ command: 'dsh', args }) })
    expect(blockers).toEqual([])
    expect(steps.map(step => step.label)).toEqual([
      'npm install',
      'dsh plugin add',
      'dsh plugin add @deepseek-ai/dsh-web-search-exa@0.1.5-rc.1',
    ])
    // The two mandatory steps stop the sequence on failure — a half-run
    // update would strand host and bundle on different lines — and each
    // names the exact manual command to recover with.
    expect(steps[0]).toMatchObject({ fatal: true, remedy: 'npm install -g @deepseek-ai/dsh@0.1.5-rc.1 dsh-code@1.0.6' })
    expect(steps[1]).toMatchObject({ fatal: true, remedy: 'dsh plugin --profile cli add dsh-code@1.0.6' })
    // The companion carry is best-effort: one plugin without a build on the
    // target line must not strand the finished upgrade.
    expect(steps[2]).toMatchObject({ fatal: false, remedy: 'dsh plugin --profile cli add @deepseek-ai/dsh-web-search-exa@0.1.5-rc.1' })

    // Unresolvable dsh commands are blockers, enforced before any step runs:
    // starting the host install without a working profile step is the
    // half-updated state the plan refuses to create.
    const unresolvable = updateSteps({ plan, npm, resolveCommand: () => undefined })
    expect(unresolvable.blockers).toEqual([
      'dsh-code: could not resolve the dsh command for the profile update',
      'dsh-code: could not resolve the dsh command for @deepseek-ai/dsh-web-search-exa@0.1.5-rc.1',
    ])
    expect(unresolvable.steps).toHaveLength(1)

    // A checkout-mounted profile carries no steps beyond the host install.
    const linked = updatePlan({ latestCode: '1.0.6', peers: { '@deepseek-ai/dsh-session': '0.1.5-rc.1' }, profileSpec: 'link:C:/repo' })
    const checkout = updateSteps({ plan: linked, npm, resolveCommand: () => undefined })
    expect(checkout.steps).toHaveLength(1)
    expect(checkout.blockers).toEqual([])
  })

  it('pins the missing-host guidance to this launcher line and release', () => {
    expect(selfInstallHint({ version: '1.0.8', peers: { '@deepseek-ai/dsh-session': '0.1.5-rc.2' } }))
      .toBe('npm install -g @deepseek-ai/dsh@0.1.5-rc.2 dsh-code@1.0.8')
    // No readable peers: the command stays usable, only the host pin drops.
    expect(selfInstallHint({ version: '1.0.8', peers: undefined }))
      .toBe('npm install -g @deepseek-ai/dsh dsh-code@1.0.8')
  })

  it('refuses an apply that would walk the bundle back over npm latest', () => {
    // The GitHub-release path can put a launcher ahead of the registry; an
    // apply computed from npm's older latest would downgrade the bundle and,
    // for 1.0.7, reinstall the unbootable release.
    expect(bundleDowngradeRefusal('1.0.7', '1.0.8')).toContain('refusing to downgrade the bundle')
    expect(bundleDowngradeRefusal('1.0.7', '1.0.8')).toContain('dsh-code@1.0.7')
    expect(bundleDowngradeRefusal('1.0.8', '1.0.8')).toBeUndefined()
    expect(bundleDowngradeRefusal('1.0.9', '1.0.8')).toBeUndefined()
    expect(bundleDowngradeRefusal(undefined, '1.0.8')).toBeUndefined()
  })

  it('collects only harness companion plugins from the profile manifest', () => {
    const manifest = JSON.stringify({
      dependencies: {
        '@deepseek-ai/dsh-web-search-exa': '0.1.2-rc.1',
        '@deepseek-ai/dsh-web-search-perplexity': '0.1.2-rc.1',
        'dsh-code': 'link:C:/repo/dsh-cli',
        '@deepseek-ai/dsh-base': '0.1.2-rc.1',
        '@openguardrails/dsh-tui': '^0.1.2',
        '@deepseek-ai/dsh-local-dev-mount': 'link:C:/dev/plugin',
      },
    })
    expect(profilePluginDependencies(
      'C:/profiles/cli',
      path => path.endsWith('package.json'),
      () => manifest,
    )).toEqual([
      { name: '@deepseek-ai/dsh-web-search-exa', spec: '0.1.2-rc.1' },
      { name: '@deepseek-ai/dsh-web-search-perplexity', spec: '0.1.2-rc.1' },
    ])
    expect(profilePluginDependencies('C:/profiles/cli', () => false)).toEqual([])
    expect(profilePluginDependencies('C:/profiles/cli', () => true, () => 'not json')).toEqual([])
  })

  it('refuses to pair an older local checkout with the newer global host', () => {
    // A link/file-mounted profile runs the checkout's own build; upgrading
    // the global host beside older local code breaks the next launch. The
    // refusal names both versions and the two ways forward.
    const refusal = localCheckoutRefusal('1.0.5', '1.0.6', 'dsh-code@1.0.6')!
    expect(refusal[0]).toContain('dsh-code 1.0.5')
    expect(refusal[0]).toContain('1.0.6')
    expect(refusal[1]).toContain('refusing to install')
    expect(refusal[3]).toContain('dsh plugin --profile cli add dsh-code@1.0.6')
    // An up-to-date checkout or no checkout at all lets the upgrade proceed.
    expect(localCheckoutRefusal('1.0.6', '1.0.6', 'dsh-code@1.0.6')).toBeUndefined()
    const unread = localCheckoutRefusal(undefined, '1.0.6', 'dsh-code@1.0.6')!
    expect(unread[0]).toContain('version could not be read')
    expect(unread[3]).toContain('dsh plugin --profile cli add dsh-code@1.0.6')
  })

  it('orders harness lines so a downgrade plan is detectable', () => {
    expect(compareHarnessLines('0.1.5-rc.1', '0.1.2-rc.1')).toBeGreaterThan(0)
    expect(compareHarnessLines('0.1.2-rc.1', '0.1.5-rc.1')).toBeLessThan(0)
    expect(compareHarnessLines('0.1.5-rc.1', '0.1.5-rc.1')).toBe(0)
    // Final beats its own prereleases; alpha sorts below rc.
    expect(compareHarnessLines('0.1.5', '0.1.5-rc.9')).toBeGreaterThan(0)
    expect(compareHarnessLines('0.1.5-rc.1', '0.1.5-alpha.9')).toBeGreaterThan(0)
    // Unparseable values never block (compare as equal).
    expect(compareHarnessLines('weird', '0.1.5-rc.1')).toBe(0)
  })

  it('reads the globally installed host version across npm roots', () => {
    const manifestAt = (version: string) => JSON.stringify({ version })
    // node:path joins with the host separator; the probes below match the
    // second root's manifest regardless of slash direction.
    const isManifest = (path: string) => path.endsWith(join('@deepseek-ai', 'dsh', 'package.json'))
    const inSecondRoot = (path: string) => path.split(/[\\/]/u).includes('npm-b')
    expect(installedGlobalDshVersion(
      ['C:/npm-a', 'C:/npm-b'],
      path => isManifest(path) && inSecondRoot(path),
      () => manifestAt('0.1.5-rc.1'),
    )).toBe('0.1.5-rc.1')
    expect(installedGlobalDshVersion(['C:/npm-a'], () => false)).toBeUndefined()
    // A root with an unreadable manifest falls through to the next root.
    expect(installedGlobalDshVersion(
      ['C:/npm-a', 'C:/npm-b'],
      isManifest,
      path => inSecondRoot(path) ? manifestAt('0.1.2-rc.1') : 'not json',
    )).toBe('0.1.2-rc.1')
  })

  describe('buildUpdateStatus', () => {
    const registry = (): Record<string, PackagePeers | undefined> => ({
      // view(subject) returns the FIELD value, so the peers map is bare.
      'dsh-code@1.2.0': { '@deepseek-ai/dsh-session': '0.1.5-rc.2' },
    })
    // Profile readers stay injectable: the real machine state must not leak
    // into these contract tests (a link-mounted dev profile would flip every
    // fixture into the local-checkout refusal).
    const readers = { readSpec: () => packageVersion, readMounted: () => packageVersion, readPlugins: () => [] }

    it('reports an aligned upgrade with the plugin carry and no blockers', () => {
      const status = buildUpdateStatus({
        view: subjectParts => subjectParts[0] === 'dsh-code' ? '1.2.0' : registry()[subjectParts[0]],
        installedDsh: () => '0.1.5-rc.1',
        ...readers,
      })
      expect(status.code).toEqual({ running: packageVersion, latest: '1.2.0' })
      expect(status.host).toEqual({ installed: '0.1.5-rc.1', targetLine: '0.1.5-rc.2' })
      expect(status.plan.dshSpec).toBe('@deepseek-ai/dsh@0.1.5-rc.2')
      expect(status.plan.codeSpec).toBe('dsh-code@1.2.0')
      expect(status.blockers).toEqual({ registry: null, downgrade: false, localCheckout: null })
      expect(status.upToDate).toBe(false)
    })

    it('marks everything current as up to date', () => {
      const status = buildUpdateStatus({
        view: subjectParts => subjectParts[0] === 'dsh-code'
          ? packageVersion
          : subjectParts[0] === 'dsh-code@' + packageVersion
            ? { '@deepseek-ai/dsh-session': '0.1.5-rc.1' }
            : undefined,
        installedDsh: () => '0.1.5-rc.1',
        ...readers,
      })
      expect(status.upToDate).toBe(true)
    })

    it('flags the downgrade refusal when the installed host is newer than the pinned line', () => {
      // The release-ordering window: npm's latest matches this launcher, but
      // the line it pins is older than the host already installed globally.
      const status = buildUpdateStatus({
        view: subjectParts => subjectParts[0] === 'dsh-code'
          ? packageVersion
          : subjectParts[0] === 'dsh-code@' + packageVersion
            ? { '@deepseek-ai/dsh-session': '0.1.5-rc.1' }
            : undefined,
        installedDsh: () => '0.1.5-rc.2',
        ...readers,
      })
      expect(status.blockers.downgrade).toBe(true)
      expect(status.upToDate).toBe(false)
    })

    it('flags a launcher ahead of npm without offering a downgrade', () => {
      const status = buildUpdateStatus({
        view: subjectParts => subjectParts[0] === 'dsh-code'
          ? '1.0.7'
          : subjectParts[0] === 'dsh-code@1.0.7'
            ? { '@deepseek-ai/dsh-session': '0.1.5-rc.2' }
            : undefined,
        installedDsh: () => '0.1.5-rc.2',
        ...readers,
      })
      expect(status.upToDate).toBe(true)
      expect(status.aheadOfRegistry).toBe(true)
      expect(status.blockers.downgrade).toBe(false)
    })

    it('surfaces the npm registry failure instead of guessing', () => {
      const status = buildUpdateStatus({ view: () => undefined, installedDsh: () => '0.1.5-rc.1', ...readers })
      expect(status.blockers.registry).toContain('could not read the latest dsh-code version')
      expect(status.code.latest).toBeNull()
      expect(status.upToDate).toBe(false)
    })
  })

  it('parses a pinned apply plan from --dsh/--code/--plugin flags', () => {
    expect(specVersion('@deepseek-ai/dsh@0.1.5-rc.2')).toBe('0.1.5-rc.2')
    expect(specVersion('dsh-code@1.0.8')).toBe('1.0.8')
    expect(parsePinnedPlan(['update', '--apply'])).toBeUndefined()
    expect(parsePinnedPlan([
      'update', '--apply',
      '--dsh', '@deepseek-ai/dsh@0.1.5-rc.2',
      '--code', 'dsh-code@1.0.8',
      '--plugin', '@deepseek-ai/dsh-web-search-exa@0.1.5-rc.2',
    ])).toEqual({
      dshSpec: '@deepseek-ai/dsh@0.1.5-rc.2',
      codeSpec: 'dsh-code@1.0.8',
      pluginSpecs: ['@deepseek-ai/dsh-web-search-exa@0.1.5-rc.2'],
    })
  })

  it('reads the profile dependency spec and the actually mounted version', () => {
    const manifest = JSON.stringify({ dependencies: { 'dsh-code': '1.0.5', '@deepseek-ai/dsh-base': '0.1.2-rc.1' } })
    expect(profileDependencySpec(
      'C:/profiles/cli',
      path => path.endsWith('package.json'),
      () => manifest,
    )).toBe('1.0.5')
    expect(profileMountedVersion(
      'C:/profiles/cli',
      path => path.endsWith(join('node_modules', 'dsh-code', 'package.json')),
      () => JSON.stringify({ version: '1.0.5' }),
    )).toBe('1.0.5')
    expect(profileDependencySpec('C:/profiles/cli', () => false)).toBeUndefined()
    expect(profileMountedVersion('C:/profiles/cli', () => false)).toBeUndefined()
  })

  it('runs update steps in order and stops at the first failure', async () => {
    const children: EventEmitter[] = []
    const started: string[] = []
    const fakeSpawn: SpawnProcess = (command, args) => {
      started.push(`${command} ${args.join(' ')}`)
      const child = new EventEmitter()
      children.push(child)
      return child
    }
    const done = runSequence([
      { command: 'npm.cmd', args: ['install', '-g', 'dsh-code@1.0.5'], label: 'npm install' },
      { command: 'node', args: ['dsh', 'plugin', 'add', 'dsh-code@1.0.5'], label: 'dsh plugin add' },
    ], fakeSpawn)
    await new Promise(resolve => setImmediate(resolve))
    expect(started).toHaveLength(1)
    children[0].emit('exit', 0, null)
    await new Promise(resolve => setImmediate(resolve))
    expect(started).toHaveLength(2)
    children[1].emit('exit', 7, null)
    await expect(done).resolves.toBe(7)

    const aborted = runSequence([
      { command: 'npm.cmd', args: ['install', '-g', 'x'], label: 'npm install' },
      { command: 'node', args: ['dsh'], label: 'dsh plugin add' },
    ], fakeSpawn)
    await new Promise(resolve => setImmediate(resolve))
    children[2].emit('exit', 3, null)
    await expect(aborted).resolves.toBe(3)
    expect(started).toHaveLength(3)
  })

  it('reports a best-effort step failure and keeps the sequence running', async () => {
    const children: EventEmitter[] = []
    const started: string[] = []
    const fakeSpawn: SpawnProcess = (command, args) => {
      started.push(`${command} ${args.join(' ')}`)
      const child = new EventEmitter()
      children.push(child)
      return child
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const done = runSequence([
        { command: 'node', args: ['dsh'], label: 'npm install', fatal: true },
        { command: 'node', args: ['dsh'], label: 'dsh plugin add @deepseek-ai/dsh-web-search-exa', fatal: false, remedy: 'dsh plugin --profile cli add @deepseek-ai/dsh-web-search-exa@0.1.5-rc.1' },
        { command: 'node', args: ['dsh'], label: 'dsh plugin add @deepseek-ai/dsh-web-search-perplexity', fatal: false },
      ], fakeSpawn)
      await new Promise(resolve => setImmediate(resolve))
      children[0].emit('exit', 0, null)
      await new Promise(resolve => setImmediate(resolve))
      children[1].emit('exit', 7, null)
      await new Promise(resolve => setImmediate(resolve))
      // The failed carry did not strand the remaining carries.
      expect(started).toHaveLength(3)
      children[2].emit('exit', 0, null)
      // The incomplete pass still reports non-zero, with the retry command.
      await expect(done).resolves.toBe(7)
      expect(errorSpy.mock.calls.some(call => String(call[0]).includes('@deepseek-ai/dsh-web-search-exa@0.1.5-rc.1'))).toBe(true)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
