/**
 * Full-stack approval freeze probe: the product's split-stdin proxy, the real
 * App, the real answerer store, and an instrumented source stdin whose raw
 * mode is tracked across the whole cycle. Flags: raw left OFF while an ask is
 * pending, or a negative Ink raw-mode reference count.
 */

import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { App, type AppProps } from '../src/app.ts'
import { approvalCommandPreview } from '../src/index.ts'
import { mountApprovalAnswerer } from '../src/approval.ts'
import { createSplitStdin } from '../src/input-split.ts'
import { createTranscriptStore } from '../src/session/store.ts'
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
      if (registered === undefined) throw new Error('listener missing')
      return registered
    },
  }
}

const agent = { id: 'agent-a' } as unknown as Agent
const request = (reason: string): ApprovalRequest =>
  ({ agent, toolName: 'pwsh', reason, callId: 'call_x' } as ApprovalRequest)

const wait = async (ms = 150): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Normalize one forwarded rejection: a non-Error reason would lose its stack. */
function rejectionError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new Error(typeof reason === 'string' ? reason : 'upstream rejection')
}

function withTimeout<T>(promise: Promise<T>, label: string, ms = 4000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ': DEAD (no settle in ' + ms + 'ms)')), ms)
    promise.then(v => { clearTimeout(timer); resolve(v) }, (e: unknown) => { clearTimeout(timer); reject(rejectionError(e)) })
  })
}

/** Fake REAL process.stdin with raw-mode instrumentation. */
function createRealStdin() {
  const state = { raw: false, reads: 0, log: [] as string[] }
  const stream = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode(value: boolean) {
      state.raw = value
      state.log.push('raw=' + value)
      return this
    },
    ref() { state.log.push('ref') },
    unref() { state.log.push('unref') },
  }) as unknown as NodeJS.ReadStream
  return { stream, state }
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
    loadUsage: async () => ({ turns: [] }),
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

describe('full-stack approval probe (split stdin, real mount shape)', () => {
  it('keeps raw mode on and keys answering across two complete ask cycles', async () => {
    const real = createRealStdin()
    const proxy = createSplitStdin(real.stream)
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 24 }) as unknown as NodeJS.WriteStream
    const output = { text: '' }
    stdout.on('data', c => { output.text += c.toString() })
    const ask = fakeContext()
    const approval = mountApprovalAnswerer(ask.ctx, () => true, () => 'pnpm build')
    const instance = render(createElement(App, appProps({ approval })), {
      exitOnCtrlC: false,
      stdin: proxy.stdin as unknown as NodeJS.ReadStream,
      stdout,
    })
    try {
      await wait()
      const first = ask.listener()(request('first ask'), () => Promise.resolve<ApprovalOutcome>('unavailable'))
      await wait()
      expect(output.text).toContain('first ask')
      if (!real.state.raw) throw new Error('raw mode OFF while ask #1 pending: ' + JSON.stringify(real.state.log))
      real.stream.write('y')
      await expect(withTimeout(first, 'ask1 via split stdin')).resolves.toBe('allowed-once')
      await wait()

      const second = ask.listener()(request('second ask'), () => Promise.resolve<ApprovalOutcome>('unavailable'))
      await wait()
      expect(output.text).toContain('second ask')
      if (!real.state.raw) throw new Error('raw mode OFF while ask #2 pending: ' + JSON.stringify(real.state.log))
      real.stream.write('y')
      await expect(withTimeout(second, 'ask2 via split stdin')).resolves.toBe('allowed-once')
      await wait()
      // A1 regression: with the App's always-active input anchor holding the
      // reference count >= 1, the REAL stdin must never leave raw mode while
      // the app is mounted — before the anchor, every approval cycle dropped
      // the count to zero twice (setRawMode(false) + unref), and the
      // cooked-mode windows stranded keystrokes in the line buffer.
      expect(real.state.log.filter(entry => entry === 'raw=false' || entry === 'unref')).toEqual([])
    } finally {
      instance.unmount()
      proxy.dispose()
      real.stream.destroy()
      stdout.destroy()
    }
  })
})

describe('approval body completeness', () => {
  it('shows the full long argument payload in the wrapped bar body', async () => {
    const args = JSON.stringify({ action: 'install_bundle', target: '/Users/nonlinear/GitHub/dsh-code/lite-preset' })
    const harness = fakeContext()
    const store = createTranscriptStore()
    store.apply({
      type: 'tool/call', seq: 1, time: 0,
      data: { turn: 1, step: 1, callId: 'c9', name: 'plugin_manager', arguments: args },
    } as never)
    const approval = mountApprovalAnswerer(harness.ctx, () => true, req => approvalCommandPreview(store.getView().entries, req.callId, req.toolName))
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true, isRaw: false,
      setRawMode(value: boolean) { this.isRaw = value; return this },
      ref() {}, unref() {},
    }) as unknown as NodeJS.ReadStream
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 140, rows: 30 }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => { output += chunk.toString() })
    const instance = render(createElement(App, appProps({ approval })), {
      stdin, stdout, stderr: stdout, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      const settled = harness.listener()({
        callId: 'c9', toolName: 'plugin_manager',
        reason: 'escalate sandbox to danger-full-access: plugin_manager',
        answer: () => {}, signal: undefined,
      } as unknown as ApprovalRequest, () => Promise.resolve<ApprovalOutcome>('unavailable'))
      await wait()
      // The whole argument payload — path included — is visible in the body,
      // with no card-preview ellipsis cutting it at 80 characters.
      expect(output).toContain('/Users/nonlinear/GitHub/dsh-code/lite-preset')
      expect(output).toContain('"action":"install_bundle"')
      expect(output).not.toContain('lite-pr...')
      void settled
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})
