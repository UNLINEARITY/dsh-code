/**
 * Approval freeze regression probe: real Ink TTY, the REAL answerer store,
 * and the full idle -> ask -> answer -> ask-again cycle the production
 * freezes were reported on (first ask answerable, second ask dead).
 */

import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { App, type AppProps } from '../src/app.ts'
import { mountApprovalAnswerer } from '../src/approval.ts'
import { createTranscriptStore } from '../src/store.ts'
import { DEFAULT_STATUSLINE_ITEMS } from '../src/render/status.ts'

type Listener = (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>

function fakeContext(): { ctx: Context; listener(): Listener } {
  let registered: Listener | undefined
  const ctx = {
    on(event: string, listener: Listener): () => void {
      if (event === 'approval/request') registered = listener
      return () => {}
    },
  } as unknown as Context
  return {
    ctx,
    listener: (): Listener => {
      if (registered === undefined) throw new Error('approval/request listener was not registered')
      return registered
    },
  }
}

const agent = { id: 'agent-a' } as unknown as Agent

function request(reason: string): ApprovalRequest {
  return { agent, toolName: 'pwsh', reason, callId: 'call_x' } as ApprovalRequest
}

const wait = async (ms = 120): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Normalize one forwarded rejection: a non-Error reason would lose its stack. */
function rejectionError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new Error(typeof reason === 'string' ? reason : 'upstream rejection')
}

/** Resolve-with-timeout helper: a dead approval bar never settles. */
function withTimeout<T>(promise: Promise<T>, label: string, ms = 4000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ': did not settle within ' + ms + 'ms (dead approval bar)')), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(rejectionError(error)) },
    )
  })
}

function createTty(columns = 100, rows = 24) {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(value: boolean) { this.isRaw = value; return this },
    ref() {},
    unref() {},
  }) as unknown as NodeJS.ReadStream
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns, rows }) as unknown as NodeJS.WriteStream
  const output = { text: '' }
  stdout.on('data', chunk => { output.text += chunk.toString() })
  return { stdin, stdout, output }
}

const noop = (): void => {}
const unsubscribe = (): void => {}
const frozenEmpty = Object.freeze({ pending: undefined, answered: false, queued: 0 })
const frozenQuestion = Object.freeze({ pending: undefined })
const EMPTY_AGENTS = Object.freeze([])

function appProps(overrides: Partial<AppProps> = {}): AppProps {
  const props: AppProps = {
    store: createTranscriptStore(),
    subagents: { subscribe: () => unsubscribe, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
    approval: { subscribe: () => unsubscribe, getSnapshot: () => frozenEmpty },
    questions: { subscribe: () => unsubscribe, getSnapshot: () => frozenQuestion, submit: noop, cancel: noop },
    commands: { descriptors: [], subscribe: () => unsubscribe, setAgent: noop },
    skills: { rows: [], subscribe: () => unsubscribe, setAgent: noop },
    model: 'test/model',
    cwd: 'dsh-cli',
    workspaceRoot: 'C:\\repo\\dsh-cli',
    branch: 'main',
    sessionId: '12345678',
    sessionKey: 'session-12345678',
    resumed: false,
    mode: 'standard',
    permission: 'workspace-write',
    dispatch: noop,
    steer: noop,
    interrupt: () => false,
    quit: noop,
    loadModels: async () => ({ rows: [], failures: [] }),
    loadMentions: async () => [],
    inspectImages: async () => [],
    prepareImages: async () => [],
    inspectFiles: async () => [],
    prepareFiles: async () => [],
    selectModel: () => 'test/model',
    subagentModel: '',
    setSubagentModel: () => '',
    clearSubagentModel: noop,
    deleteSession: async () => '',
    cycleMode: () => '',
    setPermission: id => id,
    exportTranscript: async () => {},
    renameTitle: () => '',
    copyLastResponse: async () => '',
    loadGitDiff: async () => ({ title: 'git diff', files: [] }),
    reviewChanges: noop,
    loadPresets: async () => [],
    loadPermissions: async () => [],
    switchMode: async id => id,
    createSession: noop,
    forkSession: noop,
    loadSessions: async () => [],
    loadSubagents: async () => [],
    loadSessionTranscript: async () => '',
    switchSession: noop,
    cancelSessionSwitch: () => false,
    loadPlugins: () => [],
    probeUpdate: () => Promise.reject(new Error('update probe not wired in test')),
    applyUpdate: () => Promise.resolve(0),
    loadJobs: () => [],
    statusline: DEFAULT_STATUSLINE_ITEMS,
    saveStatusline: noop,
    saveLanguage: noop,
    applyEditorKeys: async () => 'ok',
    history: [],
    recordHistory: noop,
    onBridgeReady: noop,
  }
  return Object.assign(props, overrides)
}

describe('approval freeze probe (live store, real keys)', () => {
  it('answers a first ask, then a SECOND ask after the full cycle', async () => {
    const harness = createTty()
    const ask = fakeContext()
    const approval = mountApprovalAnswerer(ask.ctx, () => true, () => 'pnpm build')
    const instance = render(createElement(App, appProps({ approval })), {
      stdin: harness.stdin,
      stdout: harness.stdout,
      stderr: harness.stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      await wait()
      // Ask #1: the production bar is answerable the first time.
      const first = ask.listener()(request('first ask'), () => Promise.resolve<ApprovalOutcome>('unavailable'))
      await wait()
      expect(harness.output.text).toContain('first ask')
      harness.stdin.write('y')
      await expect(withTimeout(first, 'ask1')).resolves.toBe('allowed-once')
      await wait()
      expect(approval.getSnapshot().pending).toBeUndefined()

      // Ask #2 after one complete cycle: reported dead in production.
      const second = ask.listener()(request('second ask'), () => Promise.resolve<ApprovalOutcome>('unavailable'))
      await wait()
      expect(harness.output.text).toContain('second ask')
      harness.stdin.write('y')
      await expect(withTimeout(second, 'ask2')).resolves.toBe('allowed-once')
      await wait()
      expect(approval.getSnapshot().pending).toBeUndefined()
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('answers two queued asks in FIFO order through real keys', async () => {
    const harness = createTty()
    const ask = fakeContext()
    const approval = mountApprovalAnswerer(ask.ctx, () => true, () => 'pnpm test')
    const instance = render(createElement(App, appProps({ approval })), {
      stdin: harness.stdin,
      stdout: harness.stdout,
      stderr: harness.stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      await wait()
      const first = ask.listener()(request('head ask'), () => Promise.resolve<ApprovalOutcome>('unavailable'))
      const second = ask.listener()(request('queued ask'), () => Promise.resolve<ApprovalOutcome>('unavailable'))
      await wait()
      expect(harness.output.text).toContain('+1 queued')
      harness.stdin.write('y')
      await expect(withTimeout(first, 'queued head')).resolves.toBe('allowed-once')
      await wait()
      expect(harness.output.text).toContain('queued ask')
      harness.stdin.write('n')
      await expect(withTimeout(second, 'queued second')).resolves.toBe('rejected')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('survives an answer immediately followed by a new ask (same tick)', async () => {
    const harness = createTty()
    const ask = fakeContext()
    const approval = mountApprovalAnswerer(ask.ctx, () => true, () => 'pnpm typecheck')
    const instance = render(createElement(App, appProps({ approval })), {
      stdin: harness.stdin,
      stdout: harness.stdout,
      stderr: harness.stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      await wait()
      const first = ask.listener()(request('ask A'), () => Promise.resolve<ApprovalOutcome>('unavailable'))
      await wait()
      // Answer via the store directly (synchronous, like the keypress path),
      // then fire the next ask BEFORE microtasks drain.
      approval.getSnapshot().pending?.answer('rejected')
      const second = ask.listener()(request('ask B'), () => Promise.resolve<ApprovalOutcome>('unavailable'))
      await expect(withTimeout(first, 'ask A')).resolves.toBe('rejected')
      await wait()
      expect(harness.output.text).toContain('ask B')
      harness.stdin.write('y')
      await expect(withTimeout(second, 'ask B')).resolves.toBe('allowed-once')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})
