/** Authorization adapter edges: URL opening, logout guards, provider joins. */

import { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import {
  cancelProviderAuthorization,
  logoutProviderAuthorization,
  openAuthorizationUrl,
} from '../src/authorization.ts'

vi.mock('node:child_process', () => ({ spawn: vi.fn(() => ({ once: vi.fn(), unref: vi.fn() })) }))

const originalPlatform = process.platform

const fakeCtx = (services: Record<string, unknown>): never =>
  ({ get: (name: string) => services[name] }) as never

describe('openAuthorizationUrl', () => {
  it.each([
    ['not a url', false],
    ['ftp://example.com', false],
    ['file:///etc/passwd', false],
    ['javascript:alert(1)', false],
  ])('refuses %s', (raw, expected) => {
    expect(openAuthorizationUrl(raw)).toBe(expected)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('opens an https URL with the platform browser and never touches a shell', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      expect(openAuthorizationUrl('https://example.com/auth?code=1')).toBe(true)
      const [command, args, options] = vi.mocked(spawn).mock.calls.at(-1)!
      expect(command).toBe('/usr/bin/open')
      expect(args).toEqual(['https://example.com/auth?code=1'])
      expect(options).toEqual(expect.objectContaining({ detached: true, stdio: 'ignore' }))
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  it('uses explorer.exe on windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      expect(openAuthorizationUrl('http://localhost:1455/cb')).toBe(true)
      expect(vi.mocked(spawn).mock.calls.at(-1)![0]).toBe('explorer.exe')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  it('uses xdg-open on linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      expect(openAuthorizationUrl('https://example.com')).toBe(true)
      expect(vi.mocked(spawn).mock.calls.at(-1)![0]).toBe('xdg-open')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  it('returns false when the launcher cannot even spawn', () => {
    vi.mocked(spawn).mockImplementationOnce(() => { throw new Error('no browser') })
    expect(openAuthorizationUrl('https://example.com')).toBe(false)
  })
})

const logoutRow = () => ({
  key: credentialKey('llm-pi-ai', 'xai'),
  provider: 'xai',
  label: 'xai',
  methods: [{ id: 'oauth', label: 'plan' }],
  inFlight: false,
  record: { configured: true, writable: true, kind: 'grant' as const },
})

describe('logoutProviderAuthorization', () => {
  const row = logoutRow()

  it('deletes a configured writable record', async () => {
    const deleteRecord = vi.fn(async () => undefined)
    const describeRecord = vi.fn(async () => ({ configured: true, writable: true }))
    await logoutProviderAuthorization(fakeCtx({
      credentials: { describeRecord, deleteRecord },
    }), row)
    expect(deleteRecord).toHaveBeenCalledWith(row.key)
  })

  it('is a no-op when nothing is configured and refuses a read-only record', async () => {
    const deleteRecord = vi.fn(async () => undefined)
    await logoutProviderAuthorization(fakeCtx({
      credentials: { describeRecord: vi.fn(async () => ({ configured: false, writable: true })), deleteRecord },
    }), row)
    expect(deleteRecord).not.toHaveBeenCalled()
    await expect(logoutProviderAuthorization(fakeCtx({
      credentials: { describeRecord: vi.fn(async () => ({ configured: true, writable: false })), deleteRecord },
    }), row)).rejects.toThrow('read-only')
  })

  it('requires the credentials service', async () => {
    await expect(logoutProviderAuthorization(fakeCtx({}), row)).rejects.toThrow('credential storage is unavailable')
  })
})


describe('cancelProviderAuthorization', () => {
  it('forwards the key to the running attempt and tolerates a missing service', () => {
    const cancel = vi.fn()
    const key = credentialKey('llm-pi-ai', 'xai')
    cancelProviderAuthorization(fakeCtx({ authorization: { cancel } }), key)
    expect(cancel).toHaveBeenCalledWith(key)
    expect(() => cancelProviderAuthorization(fakeCtx({}), key)).not.toThrow()
  })
})
