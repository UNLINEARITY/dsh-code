import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  dshCommand,
  launchDsh,
  profileArgs,
  profileHasDshCode,
} from '../bin/deepseek.mjs'

describe('global launcher aliases', () => {
  it('forwards every application argument to the cli profile', () => {
    expect(profileArgs(['--resume', 'abc123'])).toEqual(['--profile', 'cli', '--resume', 'abc123'])
  })

  it('starts dsh with inherited stdio and preserves its exit code', () => {
    const child = new EventEmitter()
    const calls = []
    const previousExitCode = process.exitCode
    try {
      launchDsh(['--help'], (command, args, options) => {
        calls.push({ command, args, options })
        return child
      }, args => ({ command: 'dsh', args: profileArgs(args) }), () => true)
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
