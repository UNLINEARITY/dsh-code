/** Terminal tab title regressions: title sanitization, the OSC sequences,
 * and the hook's write/dedupe/clear lifecycle over real Node streams. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createElement, type ReactElement } from 'react'
import { render, Text } from 'ink'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { App, type AppProps } from '../src/app.ts'
import { createTranscriptStore } from '../src/session/store.ts'
import { DEFAULT_STATUSLINE_ITEMS } from '../src/render/status.ts'
import {
  clearTerminalTitleSequence,
  DEFAULT_TERMINAL_TITLE,
  ensureVsCodeTabTitleSetting,
  MAX_TERMINAL_TITLE_CHARS,
  vscodeSettingsPath,
  sanitizeTerminalTitle,
  terminalTitleSequence,
  useTerminalTitle,
} from '../src/ui/terminal-title.ts'

const wait = async (): Promise<void> => new Promise(resolve => setTimeout(resolve, 80))

describe('sanitizeTerminalTitle', () => {
  it('strips control characters that could terminate the OSC sequence', () => {
    expect(sanitizeTerminalTitle('a\u0007b\u001b]0;evil')).toBe('ab]0;evil')
    expect(sanitizeTerminalTitle('x\r\ny')).toBe('xy')
  })
  it('strips bidi and invisible formatting codepoints', () => {
    expect(sanitizeTerminalTitle('a\u202Eb\u200dc\uFEFFd')).toBe('abcd')
  })
  it('collapses whitespace runs and trims the ends', () => {
    expect(sanitizeTerminalTitle('  refactor   db  layer ')).toBe('refactor db layer')
  })
  it('bounds the visible length', () => {
    expect([...sanitizeTerminalTitle('ab'.repeat(300))].length).toBe(MAX_TERMINAL_TITLE_CHARS)
  })
  it('reduces control-only text to nothing', () => {
    expect(sanitizeTerminalTitle('\u0007\u001b')).toBe('')
  })
})

describe('title sequences', () => {
  it('wraps the sanitized title in OSC 0 with a BEL terminator', () => {
    expect(terminalTitleSequence(DEFAULT_TERMINAL_TITLE)).toBe('\x1b]0;deepseek\x07')
    expect(terminalTitleSequence(' my  title ')).toBe('\x1b]0;my title\x07')
  })
  it('emits nothing for an empty sanitized title', () => {
    expect(terminalTitleSequence('  ')).toBe('')
  })
  it('clears with an empty OSC payload', () => {
    expect(clearTerminalTitleSequence()).toBe('\x1b]0;\x07')
  })
})

describe('useTerminalTitle over real streams', () => {
  it('writes once per title change and clears on unmount', async () => {
    const chunks: string[] = []
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 }) as unknown as NodeJS.WriteStream
    stdout.on('data', chunk => {
      chunks.push(chunk.toString())
    })
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
    function TitleProbe({ title }: { title: string }): ReactElement {
      useTerminalTitle(title)
      return createElement(Text, null, 'x')
    }
    const initialProcessTitle = process.title
    const instance = render(createElement(TitleProbe, { title: 'probe one' }), { stdin, stdout, patchConsole: false })
    await wait()
    expect(chunks.join('')).toContain('\x1b]0;probe one\x07')
    expect(process.title).toBe('probe one')
    instance.rerender(createElement(TitleProbe, { title: 'probe one' }))
    await wait()
    expect(chunks.join('').split('\x1b]0;probe one\x07')).toHaveLength(2)
    instance.rerender(createElement(TitleProbe, { title: 'probe two' }))
    await wait()
    expect(chunks.join('')).toContain('\x1b]0;probe two\x07')
    expect(process.title).toBe('probe two')
    instance.unmount()
    expect(chunks.join('')).toContain(clearTerminalTitleSequence())
    expect(process.title).toBe(initialProcessTitle)
  })
})

describe('App tab label over real streams', () => {
  interface Harness {
    stdin: NodeJS.ReadStream
    stdout: NodeJS.WriteStream
    chunks: string[]
  }

  function createHarness(columns = 100, rows = 24): Harness {
    const chunks: string[] = []
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns, rows }) as unknown as NodeJS.WriteStream
    stdout.on('data', chunk => {
      chunks.push(chunk.toString())
    })
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
    return { stdin, stdout, chunks }
  }

  const unsubscribe = (): void => {}
  const noop = (): void => {}
  const approvalSnapshot = Object.freeze({ pending: undefined, answered: false, queued: 0 })
  const questionSnapshot = Object.freeze({ pending: undefined })
  // Frozen ONCE here, not inside the getter: `Object.freeze([])` in the arrow
  // would build a fresh array per call, so useSyncExternalStore would see a new
  // identity every render and spin into "Maximum update depth exceeded".
  const emptyAgents = Object.freeze([])

  function appProps(store: ReturnType<typeof createTranscriptStore>): AppProps {
    return {
      store,
      subagents: { subscribe: () => unsubscribe, getSnapshot: () => emptyAgents, getTotalSeen: () => 0 },
      approval: { subscribe: () => unsubscribe, getSnapshot: () => approvalSnapshot },
      questions: { subscribe: () => unsubscribe, getSnapshot: () => questionSnapshot, submit: noop, cancel: noop },
      commands: { descriptors: [], subscribe: () => unsubscribe },
      skills: { rows: [], subscribe: () => unsubscribe },
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
      setPermission: (id: string) => id,
      exportTranscript: async () => {},
      renameTitle: () => '',
      copyLastResponse: async () => '',
      loadGitDiff: async () => ({ title: 'git diff', text: '' }),
      reviewChanges: noop,
      loadPresets: async () => [],
      loadPermissions: async () => [],
      switchMode: async (id: string) => id,
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
      applyEditorKeys: async () => 'ctrl+r passthrough written to test',
      history: [],
      recordHistory: noop,
      onBridgeReady: noop,
    } as unknown as AppProps
  }

  function renderApp(harness: Harness, store: ReturnType<typeof createTranscriptStore>): ReturnType<typeof render> {
    return render(createElement(App, appProps(store)), {
      stdin: harness.stdin,
      stdout: harness.stdout,
      stderr: harness.stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
  }

  it('labels the tab "deepseek" before the session has a name, and clears on exit', async () => {
    const harness = createHarness()
    const instance = renderApp(harness, createTranscriptStore())
    try {
      await wait()
      expect(harness.chunks.join('')).toContain('\x1b]0;deepseek\x07')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
    expect(harness.chunks.join('')).toContain(clearTerminalTitleSequence())
  })

  it('labels the tab with the session title once a session/title event lands', async () => {
    const store = createTranscriptStore([
      { type: 'session/title', seq: 1, time: 1, data: { title: 'refactor db layer' } } as unknown as SessionEvent,
    ])
    const harness = createHarness()
    const instance = renderApp(harness, store)
    try {
      await wait()
      expect(harness.chunks.join('')).toContain('\x1b]0;refactor db layer\x07')
      expect(harness.chunks.join('')).not.toContain('\x1b]0;deepseek\x07')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})

describe('vscodeSettingsPath (per-platform VS Code settings location)', () => {
  it('resolves the macOS bundle data folder, not XDG config', () => {
    // The bug this pins: macOS VS Code reads ~/Library/Application Support,
    // and a write to ~/.config silently no-ops (tab kept showing "node").
    // node:path uses the HOST separator even when this test exercises a
    // different target platform; normalize only the assertion surface.
    expect(vscodeSettingsPath('darwin', { HOME: '/Users/u' })?.replaceAll('\\', '/'))
      .toBe('/Users/u/Library/Application Support/Code/User/settings.json')
  })

  it('resolves XDG config on Linux and APPDATA on Windows', () => {
    expect(vscodeSettingsPath('linux', { HOME: '/home/u' })?.replaceAll('\\', '/'))
      .toBe('/home/u/.config/Code/User/settings.json')
    // node:path joins with the HOST separator; compare the structure
    // normalized so the win32 branch is verifiable from any dev platform.
    expect(vscodeSettingsPath('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })?.replaceAll('\\', '/'))
      .toBe('C:/Users/u/AppData/Roaming/Code/User/settings.json')
  })

  it('returns undefined without the platform base variable', () => {
    expect(vscodeSettingsPath('darwin', {})).toBeUndefined()
    expect(vscodeSettingsPath('win32', {})).toBeUndefined()
  })
})

describe('ensureVsCodeTabTitleSetting', () => {
  function makeSettingsDir(): string {
    return mkdtempSync(join(tmpdir(), 'dsh-title-'))
  }

  it('does nothing outside VS Code', () => {
    const dir = makeSettingsDir()
    const file = join(dir, 'settings.json')
    writeFileSync(file, '{}', 'utf8')
    const result = ensureVsCodeTabTitleSetting({ env: { TERM_PROGRAM: 'windows' }, settingsFile: file, isTTY: true })
    expect(result).toEqual({ wrote: false, reason: 'not-vscode' })
    expect(readFileSync(file, 'utf8')).toBe('{}')
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the settings file when missing', () => {
    const dir = makeSettingsDir()
    const file = join(dir, 'Code', 'User', 'settings.json')
    const result = ensureVsCodeTabTitleSetting({ env: { TERM_PROGRAM: 'vscode' }, settingsFile: file, isTTY: true })
    expect(result).toEqual({ wrote: true })
    expect(readFileSync(file, 'utf8')).toContain('"terminal.integrated.tabs.title": "${sequence}"')
    rmSync(dir, { recursive: true, force: true })
  })

  it('inserts the key into an existing file and keeps a backup', () => {
    const dir = makeSettingsDir()
    const file = join(dir, 'settings.json')
    writeFileSync(file, '{\n    "update.showReleaseNotes": false\n}', 'utf8')
    const result = ensureVsCodeTabTitleSetting({ env: { TERM_PROGRAM: 'vscode' }, settingsFile: file, isTTY: true })
    expect(result).toEqual({ wrote: true })
    const after = readFileSync(file, 'utf8')
    expect(after).toContain('"update.showReleaseNotes": false,')
    expect(after).toContain('"terminal.integrated.tabs.title": "${sequence}"')
    JSON.parse(after)
    expect(readFileSync(file + '.dsh-backup', 'utf8')).toBe('{\n    "update.showReleaseNotes": false\n}')
    rmSync(dir, { recursive: true, force: true })
  })

  it('never overwrites a value the user already set', () => {
    const dir = makeSettingsDir()
    const file = join(dir, 'settings.json')
    writeFileSync(file, '{"terminal.integrated.tabs.title": "${process}"}', 'utf8')
    const result = ensureVsCodeTabTitleSetting({ env: { TERM_PROGRAM: 'vscode' }, settingsFile: file, isTTY: true })
    expect(result).toEqual({ wrote: false, reason: 'key-present' })
    expect(readFileSync(file, 'utf8')).toBe('{"terminal.integrated.tabs.title": "${process}"}')
    rmSync(dir, { recursive: true, force: true })
  })

  it('skips an unparseable file instead of touching it', () => {
    const dir = makeSettingsDir()
    const file = join(dir, 'settings.json')
    writeFileSync(file, '{ not valid json ///', 'utf8')
    const result = ensureVsCodeTabTitleSetting({ env: { TERM_PROGRAM: 'vscode' }, settingsFile: file, isTTY: true })
    expect(result).toEqual({ wrote: false, reason: 'unparseable' })
    expect(readFileSync(file, 'utf8')).toBe('{ not valid json ///')
    rmSync(dir, { recursive: true, force: true })
  })
})
