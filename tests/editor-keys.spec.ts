/** VS Code-family keybinding repair: detection, JSONC merge, and fs orchestration regressions. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  applyCtrlRPassthrough,
  detectEditorTerminalFamily,
  editorKeybindingCandidates,
  isRemoteTerminalEnv,
  mergeCtrlRPassthrough,
  parseEditorKeysFlag,
  parseJsonc,
  resolveEditorKeysStartupHint,
  stripJsoncComments,
  type EditorKeysEnv,
  type EditorPathContext,
} from '../src/editor-keys.ts'

const linuxCtx = (homedir: string): EditorPathContext => ({ homedir, platform: 'linux' })

describe('editor family detection', () => {
  it('maps TERM_PROGRAM onto the family table case/whitespace tolerantly', () => {
    expect(detectEditorTerminalFamily({ TERM_PROGRAM: 'vscode' })).toBe('vscode')
    expect(detectEditorTerminalFamily({ TERM_PROGRAM: ' Cursor ' })).toBe('cursor')
    expect(detectEditorTerminalFamily({ TERM_PROGRAM: 'VSCodium' })).toBe('vscodium')
    expect(detectEditorTerminalFamily({ TERM_PROGRAM: 'WINDSURF' })).toBe('windsurf')
    expect(detectEditorTerminalFamily({})).toBeUndefined()
    expect(detectEditorTerminalFamily({ TERM_PROGRAM: 'iTerm.app' })).toBeUndefined()
  })

  it('treats a hosted pty (VSCODE_IPC_HOOK_CLI) as remote', () => {
    expect(isRemoteTerminalEnv({ VSCODE_IPC_HOOK_CLI: 'x' })).toBe(true)
    expect(isRemoteTerminalEnv({})).toBe(false)
    expect(isRemoteTerminalEnv({ VSCODE_IPC_HOOK_CLI: '  ' })).toBe(false)
  })

  it('resolves per-platform user keybindings paths, stable before insiders', () => {
    // Expected values go through the same join, so this suite is
    // platform-independent: the segments are the contract, not the separators.
    expect(editorKeybindingCandidates('cursor', { homedir: '/h', appdata: 'C:\\ad', platform: 'win32' })).toEqual([
      join('C:\\ad', 'Cursor', 'User', 'keybindings.json'),
    ])
    expect(editorKeybindingCandidates('vscode', { homedir: '/h', appdata: 'C:\\ad', platform: 'win32' })).toEqual([
      join('C:\\ad', 'Code', 'User', 'keybindings.json'),
      join('C:\\ad', 'Code - Insiders', 'User', 'keybindings.json'),
    ])
    expect(editorKeybindingCandidates('vscode', { homedir: '/h', platform: 'darwin' })).toEqual([
      join('/h', 'Library', 'Application Support', 'Code', 'User', 'keybindings.json'),
      join('/h', 'Library', 'Application Support', 'Code - Insiders', 'User', 'keybindings.json'),
    ])
    expect(editorKeybindingCandidates('vscodium', { homedir: '/h', platform: 'linux' })).toEqual([
      join('/h', '.config', 'VSCodium', 'User', 'keybindings.json'),
    ])
  })
})

describe('jsonc merge', () => {
  it('strips comments but keeps strings intact', () => {
    expect(stripJsoncComments('a// b\nc')).toBe('a\nc')
    expect(stripJsoncComments('{"u":"http://x/*y*/z"}')).toBe('{"u":"http://x/*y*/z"}')
    expect(stripJsoncComments('{/* c */}')).toBe('{}')
    expect(stripJsoncComments('{\n/* a\nb */\n}')).toBe('{\n\n\n}')
  })

  it('tolerates trailing commas', () => {
    expect(parseJsonc('[1, 2,]')).toEqual([1, 2])
    expect(parseJsonc('{"a": 1,}')).toEqual({ a: 1 })
  })

  it('creates a fresh document from a missing file', () => {
    const merge = mergeCtrlRPassthrough(undefined)
    if (merge.status !== 'created') throw new Error('expected created')
    const parsed = parseJsonc(merge.text) as readonly unknown[]
    expect(parsed).toHaveLength(1)
    const entry = parsed[0] as { key: string; command: string; args: { text: string }; when: string }
    expect(entry.key).toBe('ctrl+r')
    expect(entry.command).toBe('workbench.action.terminal.sendSequence')
    expect(entry.args.text).toBe('\u0012')
    expect(entry.when).toBe('terminalFocus')
  })

  it('prepends the rule to an existing document and preserves comments', () => {
    const raw = [
      '// Place your key bindings in this file to override the defaults',
      '[',
      '    {',
      '        "key": "ctrl+i",',
      '        "command": "composerMode.agent"',
      '    }',
      ']',
    ].join('\n')
    const merge = mergeCtrlRPassthrough(raw)
    if (merge.status !== 'updated') throw new Error('expected updated')
    expect(merge.text).toContain('// Place your key bindings')
    expect(merge.text).toContain('composerMode.agent')
    const parsed = parseJsonc(merge.text) as readonly { key: string }[]
    expect(parsed.map(entry => entry.key)).toEqual(['ctrl+r', 'ctrl+i'])
    // Idempotent: the merged document reports present.
    expect(mergeCtrlRPassthrough(merge.text).status).toBe('present')
  })

  it('accepts an equivalent rule in any formatting and rejects non-array roots', () => {
    const equivalent = JSON.stringify([
      { when: 'terminalFocus', args: { text: '\u0012' }, command: 'workbench.action.terminal.sendSequence', key: 'CTRL+R' },
    ], null, 2)
    expect(mergeCtrlRPassthrough(equivalent).status).toBe('present')
    const missingWhen = JSON.stringify([
      { key: 'ctrl+r', command: 'workbench.action.terminal.sendSequence', args: { text: '\u0012' } },
    ])
    expect(mergeCtrlRPassthrough(missingWhen).status).toBe('updated')
    expect(() => mergeCtrlRPassthrough('{"key": "ctrl+r"}')).toThrow(/rule array/u)
  })
})

describe('apply and startup hint', () => {
  let root = ''
  const keysPath = (): string => join(root, '.config', 'Cursor', 'User', 'keybindings.json')
  const flagPath = (): string => join(root, 'flag', 'editor-keys.json')
  const makeEnv = (term: string, extra: NodeJS.ProcessEnv = {}): EditorKeysEnv => ({
    env: { TERM_PROGRAM: term, ...extra },
    paths: linuxCtx(root),
    flagPath: flagPath(),
  })

  afterAll(() => {
    if (root !== '') rmSync(root, { recursive: true, force: true })
  })

  it('creates the rule file and marks the flag on a fresh cursor environment', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-editor-keys-'))
    const summary = await applyCtrlRPassthrough(makeEnv('cursor'))
    expect(summary).toMatch(/written to Cursor/u)
    const parsed = parseJsonc(readFileSync(keysPath(), 'utf8')) as readonly unknown[]
    expect(parsed).toHaveLength(1)
    const flag = parseEditorKeysFlag(readFileSync(flagPath(), 'utf8'))
    expect(flag.hintShownAt).toBeDefined()
  })

  it('backs up an existing file and is idempotent afterwards', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-editor-keys-'))
    mkdirSync(join(root, '.config', 'Cursor', 'User'), { recursive: true })
    const original = '// mine\n[\n    {\n        "key": "ctrl+i",\n        "command": "composerMode.agent"\n    }\n]\n'
    writeFileSync(keysPath(), original, 'utf8')
    const env = makeEnv('cursor')
    const summary = await applyCtrlRPassthrough(env)
    expect(summary).toMatch(/written/u)
    expect(readFileSync(keysPath() + '.dsh-bak', 'utf8')).toBe(original)
    expect(existsSync(keysPath())).toBe(true)
    const second = await applyCtrlRPassthrough(env)
    expect(second).toMatch(/already configured/u)
  })

  it('refuses non-family and remote environments without touching disk', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-editor-keys-'))
    await expect(applyCtrlRPassthrough({ env: {}, paths: linuxCtx(root), flagPath: flagPath() })).rejects.toThrow(/TERM_PROGRAM/u)
    await expect(applyCtrlRPassthrough(makeEnv('vscode', { VSCODE_IPC_HOOK_CLI: 'x' }))).rejects.toThrow(/remote/u)
    expect(existsSync(keysPath())).toBe(false)
    expect(existsSync(flagPath())).toBe(false)
  })

  it('hints once per install and stays silent once the rule exists', async () => {
    // Fresh cursor environment: hint fires once and marks the flag.
    root = mkdtempSync(join(tmpdir(), 'dsh-editor-keys-'))
    let env = makeEnv('cursor')
    await expect(resolveEditorKeysStartupHint(env)).resolves.toMatch(/\/vscode-keys/u)
    expect(parseEditorKeysFlag(readFileSync(flagPath(), 'utf8')).hintShownAt).toBeDefined()
    await expect(resolveEditorKeysStartupHint(env)).resolves.toBeUndefined()

    // A user who already added the rule never sees the hint.
    root = mkdtempSync(join(tmpdir(), 'dsh-editor-keys-'))
    env = makeEnv('cursor')
    mkdirSync(join(root, '.config', 'Cursor', 'User'), { recursive: true })
    const created = mergeCtrlRPassthrough(undefined)
    writeFileSync(keysPath(), created.status === 'created' ? created.text : '', 'utf8')
    await expect(resolveEditorKeysStartupHint(env)).resolves.toBeUndefined()
    expect(parseEditorKeysFlag(readFileSync(flagPath(), 'utf8')).hintShownAt).toBeDefined()

    // Outside the family: silent and unmarked.
    root = mkdtempSync(join(tmpdir(), 'dsh-editor-keys-'))
    env = makeEnv('cursor')
    env.env = {}
    await expect(resolveEditorKeysStartupHint(env)).resolves.toBeUndefined()
    expect(existsSync(flagPath())).toBe(false)
  })
})
