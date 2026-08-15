import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { dshCommand, launchDsh, profileArgs } from '../bin/deepseek.mjs'

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
      }, args => ({ command: 'dsh', args: profileArgs(args) }))
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
