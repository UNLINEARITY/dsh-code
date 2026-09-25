import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setLanguage, t } from '../src/i18n.ts'
import { appProps, createTty, renderApp, wait } from './helpers/app-mount.ts'
import {
  detectLegacySettingsGap,
  LEGACY_SETTINGS_ACTIVE,
  LEGACY_SETTINGS_IMPORTED,
  reimportLegacySettings,
  type LegacySettingsGap,
  type LegacySettingsReader,
} from '../src/runner/legacy-settings.ts'

/** A reader over a plain path→text map; unmapped paths read as missing. */
function readerOf(files: Record<string, string>): LegacySettingsReader {
  return path => files[path]
}

const HOME = '/home/user/.dsh'
const IMPORTED = join(HOME, LEGACY_SETTINGS_IMPORTED)
const PATCH = join(HOME, 'profiles', 'cli', 'cordis.patch.yml')

/** The retired global document as a 0.1.5 line would have left it. */
const FULL_LEGACY = [
  'llm-pi-ai:',
  '  providers:',
  '    openai:',
  '      apiKeyEnv: OPENAI_API_KEY',
  '      models:',
  '        - id: gpt-5.6-luna',
  'llm-deepseek:',
  '  models:',
  '    - id: deepseek-v4-pro',
  'agent-default-model:',
  '  provider: openai',
  '  model: gpt-5.6-luna',
].join('\n')

/** The profile patch as the host's import would have written it. */
const LANDED_PATCH = [
  '# comment',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      openai:',
  '        apiKeyEnv: OPENAI_API_KEY',
].join('\n')

describe('detectLegacySettingsGap', () => {
  it('stays silent with no renamed document', () => {
    expect(detectLegacySettingsGap({ home: HOME, patchPath: PATCH, read: readerOf({}) })).toBeUndefined()
  })

  it('stays silent when the renamed document carries no terminal-relevant section', () => {
    const read = readerOf({ [IMPORTED]: 'ui-onboarding:\n  seen: true\n' })
    expect(detectLegacySettingsGap({ home: HOME, patchPath: PATCH, read })).toBeUndefined()
  })

  it('stays silent when relevant sections carry no configuration', () => {
    const read = readerOf({
      [IMPORTED]: [
        'llm-pi-ai:',
        '  providers: {}',
        'llm-deepseek:',
        '  models: []',
        'agent-default-model: {}',
      ].join('\n'),
    })
    expect(detectLegacySettingsGap({ home: HOME, patchPath: PATCH, read })).toBeUndefined()
  })

  it('stays silent when the renamed document is unparseable', () => {
    const read = readerOf({ [IMPORTED]: '\tnot: [valid yaml' })
    expect(detectLegacySettingsGap({ home: HOME, patchPath: PATCH, read })).toBeUndefined()
  })

  it('cannot judge without the active profile', () => {
    const read = readerOf({ [IMPORTED]: FULL_LEGACY })
    expect(detectLegacySettingsGap({ home: HOME, patchPath: undefined, read })).toBeUndefined()
  })

  it('names every stranded section when nothing landed', () => {
    const read = readerOf({ [IMPORTED]: FULL_LEGACY })
    expect(detectLegacySettingsGap({ home: HOME, patchPath: PATCH, read })).toEqual({
      sections: ['llm-pi-ai', 'llm-deepseek', 'agent-default-model'],
      stranded: {
        'llm-pi-ai': { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'gpt-5.6-luna' }] } } },
        'llm-deepseek': { models: [{ id: 'deepseek-v4-pro' }] },
        'agent-default-model': { provider: 'openai', model: 'gpt-5.6-luna' },
      },
      importedPath: IMPORTED,
      restorePath: join(HOME, LEGACY_SETTINGS_ACTIVE),
    })
  })

  it('treats a missing patch layer as nothing landed', () => {
    const read = readerOf({ [IMPORTED]: FULL_LEGACY })
    expect(detectLegacySettingsGap({ home: HOME, patchPath: PATCH, read })?.sections).toEqual([
      'llm-pi-ai', 'llm-deepseek', 'agent-default-model',
    ])
  })

  it('treats an unparseable patch layer as nothing landed', () => {
    const read = readerOf({ [IMPORTED]: FULL_LEGACY, [PATCH]: '- id: [' })
    expect(detectLegacySettingsGap({ home: HOME, patchPath: PATCH, read })?.sections).toHaveLength(3)
  })

  it('drops a section whose id landed with config', () => {
    const read = readerOf({ [IMPORTED]: FULL_LEGACY, [PATCH]: LANDED_PATCH })
    expect(detectLegacySettingsGap({ home: HOME, patchPath: PATCH, read })?.sections).toEqual([
      'llm-deepseek', 'agent-default-model',
    ])
  })

  it('keeps a section whose row is a bare id shell', () => {
    const read = readerOf({ [IMPORTED]: FULL_LEGACY, [PATCH]: '- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n' })
    expect(detectLegacySettingsGap({ home: HOME, patchPath: PATCH, read })?.sections).toContain('llm-pi-ai')
  })

  it('reads patches that carry !!js expressions without failing', () => {
    const patch = [
      '- id: plugin-manager',
      '  disabled: !!js "!ctx.get(\'profileContext\')"',
      LANDED_PATCH,
    ].join('\n')
    const read = readerOf({ [IMPORTED]: FULL_LEGACY, [PATCH]: patch })
    expect(detectLegacySettingsGap({ home: HOME, patchPath: PATCH, read })?.sections).toEqual([
      'llm-deepseek', 'agent-default-model',
    ])
  })

  it('stays silent once every relevant section has landed', () => {
    const patch = [
      '- id: llm-pi-ai',
      '  config: { providers: { openai: {} } }',
      '- id: llm-deepseek',
      '  config: { models: [{ id: deepseek-v4-pro }] }',
      '- id: agent-default-model',
      '  config: { provider: openai }',
    ].join('\n')
    const read = readerOf({ [IMPORTED]: FULL_LEGACY, [PATCH]: patch })
    expect(detectLegacySettingsGap({ home: HOME, patchPath: PATCH, read })).toBeUndefined()
  })
})

describe('reimportLegacySettings', () => {
  /** A gap carrying the parsed FULL_LEGACY payloads. */
  function gapOf(): LegacySettingsGap {
    const gap = detectLegacySettingsGap({ home: HOME, patchPath: PATCH, read: readerOf({ [IMPORTED]: FULL_LEGACY }) })
    if (gap === undefined) throw new Error('fixture must detect a gap')
    return gap
  }

  /** A settings service recording update calls, optionally failing by ns. */
  function settingsOf(failures: ReadonlySet<string> = new Set()) {
    const calls: Array<{ ns: string; patch: Record<string, unknown> }> = []
    const service = {
      update: async (ns: string, patch: Record<string, unknown>): Promise<void> => {
        calls.push({ ns, patch })
        if (failures.has(ns)) throw new Error(`boom\n on ${ns}`)
      },
    }
    return { service, calls }
  }

  it('re-runs the host import through the live settings service', async () => {
    const { service, calls } = settingsOf()
    await expect(reimportLegacySettings(service, gapOf())).resolves.toEqual({
      recovered: ['llm-pi-ai', 'llm-deepseek', 'agent-default-model'],
      failed: [],
    })
    expect(calls.map(call => call.ns)).toEqual(['llm-pi-ai', 'llm-deepseek', 'agent-default-model'])
    expect(calls[0].patch).toEqual({ providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'gpt-5.6-luna' }] } } })
    expect(calls[2].patch).toEqual({ provider: 'openai', model: 'gpt-5.6-luna' })
  })

  it('continues past a rejected section and collapses its reason to one line', async () => {
    const { service, calls } = settingsOf(new Set(['llm-deepseek']))
    await expect(reimportLegacySettings(service, gapOf())).resolves.toEqual({
      recovered: ['llm-pi-ai', 'agent-default-model'],
      failed: [{ ns: 'llm-deepseek', message: 'boom on llm-deepseek' }],
    })
    expect(calls.map(call => call.ns)).toEqual(['llm-pi-ai', 'llm-deepseek', 'agent-default-model'])
  })

  it('writes nothing without a settings service', async () => {
    const { calls } = settingsOf()
    await expect(reimportLegacySettings(undefined, gapOf())).resolves.toEqual({ recovered: [], failed: [] })
    expect(calls).toHaveLength(0)
  })
})

describe('legacy-settings startup notice', () => {
  it('renders the migration warning as one physical line through the live notice channel', async () => {
    setLanguage('en')
    const harness = createTty(120, 24)
    let notify: ((text: string, tone?: 'info' | 'warning' | 'error') => void) | undefined
    const instance = renderApp(harness, appProps({
      onBridgeReady: bridge => { notify = bridge.notify },
    }))
    try {
      await wait()
      expect(notify).toBeTypeOf('function')
      notify!(t('notice.legacySettingsUnmigrated'), 'warning')
      await wait(200)
      const text = harness.output.text
      expect(text).toContain('legacy settings not migrated')
      expect(text).toContain('restore settings.yaml from settings.yaml.imported')
      // One notice line: the recovery guidance never wraps into a panel.
      const lines = text.split('\n').filter(line => line.includes('not migrated'))
      expect(lines).toHaveLength(1)
    } finally {
      instance.unmount()
      setLanguage('en')
    }
  })

  it('renders the recovered outcome through the same one-line channel', async () => {
    setLanguage('zh')
    const harness = createTty(120, 24)
    let notify: ((text: string, tone?: 'info' | 'warning' | 'error') => void) | undefined
    const instance = renderApp(harness, appProps({
      onBridgeReady: bridge => { notify = bridge.notify },
    }))
    try {
      await wait()
      notify!(t('notice.legacySettingsRecovered', { sections: 'llm-pi-ai, agent-default-model' }))
      await wait(200)
      const text = harness.output.text
      expect(text).toContain('旧版设置（llm-pi-ai, agent-default-model）已自动重新导入')
      expect(text.split('\n').filter(line => line.includes('已自动重新导入'))).toHaveLength(1)
    } finally {
      instance.unmount()
      setLanguage('en')
    }
  })
})
