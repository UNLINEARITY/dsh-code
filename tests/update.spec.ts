import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { applyLauncherUpdate, createLineSplitter, launcherUpdateCommand, probeLauncherUpdate } from '../src/update.ts'

/** A spawn double: an EventEmitter with stdout/stderr emitters and exit. */
function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  Object.assign(child, { stdout, stderr, kill: () => {} })
  return child
}

const emit = (stream: EventEmitter, text: string): void => { stream.emit('data', Buffer.from(text)) }

describe('update line splitter', () => {
  it('splits chunks on newline boundaries and keeps a split tail pending', () => {
    const lines: string[] = []
    const split = createLineSplitter(line => lines.push(line))
    split('added 1 package\r\nadded 2 ')
    split('packages\n')
    expect(lines).toEqual(['added 1 package', 'added 2 packages'])
  })

  it('drops blank lines so panel rows are not spent on gaps', () => {
    const lines: string[] = []
    const split = createLineSplitter(line => lines.push(line))
    split('a\n\n\nb\n')
    expect(lines).toEqual(['a', 'b'])
  })
})

describe('launcherUpdateCommand', () => {
  it('spawns node with the sibling launcher entrypoint and given args', () => {
    const command = launcherUpdateCommand(['update', '--json'], 'file:///C:/repo/dsh-cli/lib/index.mjs')
    expect(command.command).toBe(process.execPath)
    expect(command.args[0]).toBe('C:\\repo\\dsh-cli\\bin\\deepseek.mjs')
    expect(command.args.slice(1)).toEqual(['update', '--json'])
  })
})

describe('probeLauncherUpdate', () => {
  it('resolves with the parsed json status on exit 0', async () => {
    const child = fakeChild()
    const promise = probeLauncherUpdate(() => child)
    emit(child.stdout!, '{"code":{"running":"1.0.6","latest":"1.0.7"}}')
    child.emit('exit', 0)
    await expect(promise).resolves.toEqual({ code: { running: '1.0.6', latest: '1.0.7' } })
  })

  it('rejects with the stderr tail when the probe exits non-zero', async () => {
    const child = fakeChild()
    const promise = probeLauncherUpdate(() => child)
    emit(child.stderr!, 'npm warn config\nECONNRESET\n')
    child.emit('exit', 1)
    await expect(promise).rejects.toThrow(
      'update probe failed: ECONNRESET',
    )
  })

  it('rejects on an unreadable payload', async () => {
    const child = fakeChild()
    const promise = probeLauncherUpdate(() => child)
    emit(child.stdout!, 'not json')
    child.emit('exit', 0)
    await expect(promise).rejects.toThrow('update probe returned an unreadable status')
  })

  it('rejects when the process cannot start', async () => {
    const child = fakeChild()
    const promise = probeLauncherUpdate(() => child)
    child.emit('error', new Error('enoent'))
    await expect(promise).rejects.toThrow('update probe failed to start: enoent')
  })
})

describe('applyLauncherUpdate', () => {
  it('streams stdout and stderr lines to the callback and resolves the exit code', async () => {
    const child = fakeChild()
    const lines: string[] = []
    const promise = applyLauncherUpdate(line => lines.push(line), () => child)
    emit(child.stdout!, 'dsh-code: installing\n')
    emit(child.stderr!, 'npm warn cache\n')
    emit(child.stdout!, 'cli profile now mounts dsh-code 1.0.7')
    child.emit('close', 0)
    await expect(promise).resolves.toBe(0)
    expect(lines).toEqual(['dsh-code: installing', 'npm warn cache', 'cli profile now mounts dsh-code 1.0.7'])
  })

  it('propagates a non-zero exit code for the failure surface', async () => {
    const child = fakeChild()
    const promise = applyLauncherUpdate(() => {}, () => child)
    child.emit('close', 1)
    await expect(promise).resolves.toBe(1)
  })

  it('rejects only when the update could not start', async () => {
    const child = fakeChild()
    const promise = applyLauncherUpdate(() => {}, () => child)
    child.emit('error', new Error('spawn blocked'))
    await expect(promise).rejects.toThrow('update failed to start: spawn blocked')
  })
})
