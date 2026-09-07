import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  harnessLineFromPeers,
  npmInvocation,
  dshCommand,
  completionScript,
  operationName,
  launchDsh,
  profileArgs,
  profileDependencySpec,
  profileHasDshCode,
  profileMountedVersion,
  runSequence,
  setupBundle,
  updatePlan,
} from '../bin/deepseek.mjs'

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
    expect(setupBundle([])).toBe('dsh-code@1.0.4')
  })

  it('starts dsh with inherited stdio and preserves its exit code', () => {
    const child = new EventEmitter()
    const calls = []
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
    const messages = []
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

  it('finds globally installed DSH when npm links this launcher to a checkout', () => {
    const command = dshCommand(['--help'], {
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
      lineLocked: true,
      codeSpec: 'dsh-code@1.0.5',
      profileStep: true,
    })
    const fallback = updatePlan({ latestCode: '1.0.5', peers: undefined, profileSpec: undefined })
    expect(fallback.dshSpec).toBe('@deepseek-ai/dsh@latest')
    expect(fallback.lineLocked).toBe(false)
    const linked = updatePlan({ latestCode: '1.0.5', peers: { '@deepseek-ai/dsh-session': '0.1.2-rc.1' }, profileSpec: 'link:C:/repo/dsh-cli' })
    expect(linked.profileStep).toBe(false)
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
    const children = []
    const started = []
    const fakeSpawn = (command, args) => {
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
})
