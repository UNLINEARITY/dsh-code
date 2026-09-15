import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'ink'
import { createElement } from 'react'
import {
  UpdatePanel,
  clipUpdateLines,
  isUpdateApplyRunning,
  resetUpdateApply,
  runUpdateApply,
  updateFooter,
  updatePlanView,
  UPDATE_OUTPUT_CAP,
} from '../src/update-panel.ts'
import type { LauncherUpdateStatus } from '../src/update.ts'

const wait = async (ms = 120): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** A probe payload with an available aligned upgrade and no blockers. */
function upgradeStatus(overrides: Partial<LauncherUpdateStatus> = {}): LauncherUpdateStatus {
  return {
    code: { running: '1.0.6', latest: '1.0.7' },
    host: { installed: '0.1.5-rc.1', targetLine: '0.1.5-rc.2' },
    profile: { spec: '1.0.6', mounted: '1.0.6', localCheckout: false },
    plan: { dshSpec: '@deepseek-ai/dsh@0.1.5-rc.2', codeSpec: 'dsh-code@1.0.7', pluginSpecs: [] },
    blockers: { registry: null, downgrade: false, localCheckout: null },
    upToDate: false,
    ...overrides,
  }
}

/** TTY streams the panel renders through (the app-spec contract). */
function tty(columns: number, rows: number): { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream; text: () => string; reset: () => void } {
  let buffer = ''
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(value: boolean) {
      this.isRaw = value
      return this
    },
    ref() {},
    unref() {},
  }) as unknown as NodeJS.ReadStream
  const stdout = Object.assign(new PassThrough(), {
    isTTY: true,
    columns,
    rows,
    write(chunk: string) {
      buffer += chunk
      return true
    },
  }) as unknown as NodeJS.WriteStream
  return { stdin, stdout, text: () => buffer, reset: () => { buffer = '' } }
}

describe('updatePlanView', () => {
  it('renders the aligned upgrade facts with current/target arrows', () => {
    const view = updatePlanView(upgradeStatus())
    expect(view.rows.map(row => row.text)).toEqual([
      'dsh-code    1.0.6 → 1.0.7',
      'harness     0.1.5-rc.1 → 0.1.5-rc.2',
      'profile     dsh-code 1.0.6',
    ])
    expect(view.runnable).toBe(true)
  })

  it('names an install newer than npm without an upgrade arrow', () => {
    const view = updatePlanView(upgradeStatus({
      code: { running: '1.0.8', latest: '1.0.7' },
      upToDate: true,
      aheadOfRegistry: true,
    }))
    expect(view.rows.map(row => row.text).join('\n')).toContain('1.0.8 (newer than npm 1.0.7)')
    expect(view.rows.map(row => row.text).join('\n')).toContain('refusing to downgrade')
    expect(view.rows.map(row => row.text).join('\n')).not.toContain('1.0.8 → 1.0.7')
    expect(view.runnable).toBe(false)
  })

  it('marks the up-to-date state and drops runnability', () => {
    const view = updatePlanView(upgradeStatus({
      code: { running: '1.0.6', latest: '1.0.6' },
      host: { installed: '0.1.5-rc.2', targetLine: '0.1.5-rc.2' },
      upToDate: true,
    }))
    expect(view.rows.some(row => row.text.includes('already on the pinned line'))).toBe(true)
    expect(view.runnable).toBe(false)
  })

  it('names the downgrade refusal row and blocks the confirm', () => {
    const view = updatePlanView(upgradeStatus({
      code: { running: '1.0.6', latest: '1.0.6' },
      host: { installed: '0.1.5-rc.2', targetLine: '0.1.5-rc.1' },
      blockers: { registry: null, downgrade: true, localCheckout: null },
    }))
    const refusal = view.rows.find(row => row.tone === 'error')
    expect(refusal?.text).toContain('refusing to downgrade the host')
    expect(view.runnable).toBe(false)
  })

  it('lists local-checkout refusal lines as errors', () => {
    const view = updatePlanView(upgradeStatus({
      profile: { spec: 'link:C:/repo', mounted: '1.0.5', localCheckout: true },
      blockers: { registry: null, downgrade: false, localCheckout: ['dsh-code: the cli profile mounts a local checkout'] },
    }))
    expect(view.rows.filter(row => row.tone === 'error').length).toBe(1)
    expect(view.runnable).toBe(false)
  })

  it('treats a JSON-dropped blocker key as no blocker instead of crashing', () => {
    // JSON.stringify omits undefined members: an older launcher payload may
    // arrive without blockers.registry. The row body must never be undefined.
    const status = { ...upgradeStatus(), blockers: { downgrade: false } }
    const view = updatePlanView(status as unknown as LauncherUpdateStatus)
    expect(view.rows.some(row => row.text === undefined)).toBe(false)
    expect(view.rows.some(row => row.tone === 'error')).toBe(false)
    expect(view.runnable).toBe(true)
  })

  it('carries companion plugin rows', () => {
    const view = updatePlanView(upgradeStatus({
      plan: {
        dshSpec: '@deepseek-ai/dsh@0.1.5-rc.2',
        codeSpec: 'dsh-code@1.0.7',
        pluginSpecs: ['@deepseek-ai/dsh-web-search-exa@0.1.5-rc.2'],
      },
    }))
    expect(view.rows.some(row => row.text.includes('dsh-web-search-exa@0.1.5-rc.2'))).toBe(true)
  })
})

describe('updateFooter and clipUpdateLines', () => {
  it('names the confirm key only when the plan is runnable', () => {
    expect(updateFooter('plan', true, false)).toBe('enter update · r recheck · esc close')
    expect(updateFooter('plan', false, true)).toBe('up to date · r recheck · esc close')
    expect(updateFooter('plan', false, false)).toBe('blocked · r recheck · esc close')
    expect(updateFooter('apply', true, false)).toBe('updating… · ↑↓ scroll · esc waits')
  })

  it("keeps only the newest UPDATE_OUTPUT_CAP lines", () => {
    const lines = Array.from({ length: UPDATE_OUTPUT_CAP + 250 }, (_, index) => `line ${index}`)
    const clipped = clipUpdateLines(lines)
    expect(clipped.length).toBe(UPDATE_OUTPUT_CAP)
    expect(clipped[0]).toBe(`line ${250}`)
  })
})

describe('runUpdateApply', () => {
  afterEach(() => { resetUpdateApply() })

  it('reuses the in-flight promise so a second confirm cannot spawn another child', async () => {
    let starts = 0
    let resolveApply: (code: number) => void = () => {}
    const apply = (): Promise<number> => {
      starts += 1
      return new Promise(resolve => { resolveApply = resolve })
    }
    const plan = upgradeStatus().plan
    const first = runUpdateApply(apply, plan)
    const second = runUpdateApply(apply, plan)
    expect(first).toBe(second)
    expect(starts).toBe(1)
    expect(isUpdateApplyRunning()).toBe(true)
    resolveApply(0)
    await expect(first).resolves.toBe(0)
    expect(isUpdateApplyRunning()).toBe(false)
  })

  it('replays buffered lines to a listener that attaches after the child started', async () => {
    let resolveApply: (code: number) => void = () => {}
    let onLine: (line: string) => void = () => {}
    const apply = (emit: (line: string) => void): Promise<number> => {
      onLine = emit
      return new Promise(resolve => { resolveApply = resolve })
    }
    const early: string[] = []
    const promise = runUpdateApply(apply, upgradeStatus().plan, line => early.push(line))
    onLine('first')
    const late: string[] = []
    void runUpdateApply(apply, upgradeStatus().plan, line => late.push(line))
    expect(late).toEqual(['first'])
    onLine('second')
    expect(early).toEqual(['first', 'second'])
    expect(late).toEqual(['first', 'second'])
    resolveApply(0)
    await promise
  })
})

describe('UpdatePanel lifecycle', () => {
  afterEach(() => { resetUpdateApply() })

  it("probes, confirms, streams apply output, and lands on the restart hint", async () => {
    const harness = tty(100, 24)
    const notices: string[] = []
    const applyCalls: ((line: string) => void)[] = []
    const apply = (onLine: (line: string) => void): Promise<number> => {
      applyCalls.push(onLine)
      return new Promise(resolve => { releaseApply = resolve })
    }
    let releaseApply: (code: number) => void = () => {}
    const instance = render(createElement(UpdatePanel, {
      probe: () => Promise.resolve(upgradeStatus()),
      apply,
      close: () => instance.unmount(),
      notify: (text: string) => { notices.push(text) },
    }), { stdin: harness.stdin, stdout: harness.stdout, stderr: harness.stdout, exitOnCtrlC: false })
    await wait()
    let text = harness.text()
    expect(text).toContain('dsh-code    1.0.6 → 1.0.7')
    expect(text).toContain('enter update')
    // Confirm: the apply child starts and streams sanitized lines.
    harness.stdin.write('\r')
    await wait()
    expect(applyCalls.length).toBe(1)
    text = harness.text()
    expect(text).toContain('updating…')
    applyCalls[0]('npm install  ')
    applyCalls[0]('added 42 packages')
    await wait()
    text = harness.text()
    expect(text).toContain('added 42 packages')
    // Panel stays inside the terminal height budget while streaming: count
    // ONE fresh frame, not the accumulated multi-phase byte history.
    harness.reset()
    applyCalls[0]('final verification line')
    await wait()
    expect(harness.text().split('\n').length).toBeLessThan(24)
    releaseApply(0)
    await wait()
    text = harness.text()
    expect(text).toContain('restart dsh to load the new version')
    expect(notices).toContain('update installed — restart dsh to activate')
    instance.unmount()
  })

  it("keeps escape locked while the update child runs", async () => {
    const harness = tty(100, 24)
    let releaseApply: (code: number) => void = () => {}
    let closed = false
    const instance = render(createElement(UpdatePanel, {
      probe: () => Promise.resolve(upgradeStatus()),
      apply: () => new Promise<number>(resolve => { releaseApply = resolve }),
      close: () => { closed = true },
      notify: () => {},
    }), { stdin: harness.stdin, stdout: harness.stdout, stderr: harness.stdout, exitOnCtrlC: false })
    await wait()
    harness.stdin.write('\r')
    await wait()
    harness.stdin.write('\x1b')
    await wait()
    expect(closed).toBe(false)
    releaseApply(1)
    await wait()
    harness.stdin.write('\x1b')
    await wait()
    expect(closed).toBe(true)
    instance.unmount()
  })

  it("reconnects to the running apply after unmount and does not start a second child", async () => {
    const harness = tty(100, 24)
    let starts = 0
    let releaseApply: (code: number) => void = () => {}
    const apply = (): Promise<number> => {
      starts += 1
      return new Promise(resolve => { releaseApply = resolve })
    }
    const first = render(createElement(UpdatePanel, {
      probe: () => Promise.resolve(upgradeStatus()),
      apply,
      close: () => {},
      notify: () => {},
    }), { stdin: harness.stdin, stdout: harness.stdout, stderr: harness.stdout, exitOnCtrlC: false })
    await wait()
    harness.stdin.write('\r')
    await wait()
    expect(starts).toBe(1)
    first.unmount()
    harness.reset()
    const second = render(createElement(UpdatePanel, {
      probe: () => Promise.resolve(upgradeStatus()),
      apply,
      close: () => {},
      notify: () => {},
    }), { stdin: harness.stdin, stdout: harness.stdout, stderr: harness.stdout, exitOnCtrlC: false })
    await wait()
    expect(harness.text()).toContain('updating…')
    harness.stdin.write('\r')
    await wait()
    expect(starts).toBe(1)
    releaseApply(0)
    await wait()
    expect(harness.text()).toContain('restart dsh to load the new version')
    second.unmount()
  })

  it("shows the probe failure with a retry hint and keeps the panel open", async () => {
    const harness = tty(100, 24)
    const instance = render(createElement(UpdatePanel, {
      probe: () => Promise.reject(new Error('ECONNRESET')),
      apply: () => Promise.resolve(0),
      close: () => instance.unmount(),
      notify: () => {},
    }), { stdin: harness.stdin, stdout: harness.stdout, stderr: harness.stdout, exitOnCtrlC: false })
    await wait()
    expect(harness.text()).toContain('ECONNRESET')
    expect(harness.text()).toContain('r recheck')
    instance.unmount()
  })
})
