/** Interface language: catalog access, switching, and the /language picker. */

import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { PassThrough } from 'node:stream'
import { render } from 'ink'
import {
  getLanguage,
  LANGUAGES,
  LANGUAGE_NAMES,
  parseLanguageName,
  setLanguage,
  t,
} from '../src/i18n.ts'
import { LanguagePanel } from '../src/panels/language-panel.ts'

describe('i18n catalog', () => {
  it('defaults to english and switches catalogs live', () => {
    try {
      setLanguage('en')
      expect(getLanguage()).toBe('en')
      expect(t('composer.placeholder')).toBe('type a message · / commands · @ mentions · tab steers')
      setLanguage('zh')
      expect(getLanguage()).toBe('zh')
      expect(t('composer.placeholder')).toBe('输入消息 · / 命令 · @ 引用 · tab 插队')
      setLanguage('en')
      expect(t('composer.placeholder')).toBe('type a message · / commands · @ mentions · tab steers')
    } finally {
      setLanguage('en')
    }
  })

  it('fills {n} placeholders and leaves unknown ones literal', () => {
    try {
      setLanguage('en')
      expect(t('time.hoursAgo', { n: 3 })).toBe('3h ago')
      setLanguage('zh')
      expect(t('time.hoursAgo', { n: 3 })).toBe('3 小时前')
      expect(t('time.minutesAgo', { missing: 1 })).toBe('{n} 分钟前')
    } finally {
      setLanguage('en')
    }
  })

  it('parses persisted names with an english fallback', () => {
    expect(parseLanguageName('en')).toBe('en')
    expect(parseLanguageName('zh')).toBe('zh')
    expect(parseLanguageName(undefined)).toBe('en')
    expect(parseLanguageName('jp')).toBe('en')
    expect(parseLanguageName(42)).toBe('en')
    expect(LANGUAGE_NAMES).toEqual(['en', 'zh'])
    expect(LANGUAGES.map(language => language.id)).toEqual(['en', 'zh'])
  })

  it('translates startup notices and the welcome hint', () => {
    try {
      setLanguage('en')
      expect(t('notice.noSessionYet')).toMatch(/no session yet/)
      expect(t('notice.themeConfigUnreadable', { message: 'boom' })).toContain('boom')
      expect(t('header.hint')).toContain('/help')
      setLanguage('zh')
      expect(t('notice.noSessionYet')).toContain('会话')
      expect(t('header.hint')).toContain('中断')
      expect(t('header.hintResumed')).toContain('已恢复')
      expect(t('notice.sessionCreated', { id: 'abc', mode: 'standard' })).toContain('abc')
      expect(t('notice.copied')).toContain('回复')
      expect(t('notice.copyEmpty')).toContain('复制')
    } finally {
      setLanguage('en')
    }
  })

  it('translates the panel chrome and notices that used to be hardcoded', () => {
    try {
      setLanguage('en')
      expect(t('notice.updateInstalled')).toBe('update installed — restart dsh to activate')
      expect(t('notice.updateFailedExit', { code: 2 })).toBe('update failed (exit 2)')
      expect(t('help.title', { from: 1, to: 2, total: 3 })).toBe('/help — keys and commands · rows 1-2/3')
      expect(t('completion.footer.complete', { count: 4 })).toBe('↑↓ choose · 4 items · tab complete')
      expect(t('status.agents.live', { count: 1 })).toBe('agents 1 live')
      expect(t('status.todos.progress', { done: 1, total: 3 })).toBe('todos 1/3')
      expect(t('panel.confirm.title', { action: t('panel.confirm.removeKey') })).toBe('/model — remove API key')
      setLanguage('zh')
      expect(t('notice.updateInstalled')).toContain('重启')
      expect(t('notice.permissionChangeFailed', { message: 'x' })).toContain('权限')
      expect(t('notice.modelLookupFailed', { message: 'x' })).toContain('模型')
      expect(t('notice.diffFailed', { message: 'x' })).toContain('diff')
      expect(t('notice.imageChecking', { name: 'a.png' })).toContain('图片')
      expect(t('notice.attachmentsProcessing', { count: 2, plural: 's' })).toContain('附件')
      expect(t('notice.sessionSwitchCancelled')).toContain('会话')
      expect(t('help.title', { from: 1, to: 2, total: 3 })).toContain('按键')
      expect(t('completion.searchUnavailable', { message: 'offline' })).toContain('搜索')
      expect(t('completion.footer.insert', { count: 2 })).toContain('插入')
      expect(t('status.agents.total', { total: 4 })).toContain('共')
      expect(t('status.todos.counts', { active: 1, pending: 2 })).toContain('待处理')
      expect(t('language.compact')).toContain('关闭')
      expect(t('theme.footer')).toContain('选择')
      expect(t('theme.footerMore', { count: 2 })).toContain('2')
      expect(t('panel.setup.officialDefault')).toContain('官方')
      expect(t('panel.setup.addById')).toContain('ID')
      expect(t('panel.setup.saving')).toContain('保存')
      expect(t('panel.confirm.removeProvider')).toContain('供应商')
      expect(t('panel.confirm.keyStays')).toContain('模型')
      expect(t('panel.update.installedDetail')).toContain('ctrl+c')
    } finally {
      setLanguage('en')
    }
  })

  it('translates model/provider chrome while preserving technical values', () => {
    try {
      setLanguage('zh')
      expect(t('panel.model.titleMatches', { filtered: 1, total: 3, query: 'deepseek-chat' }))
        .toContain('deepseek-chat')
      expect(t('panel.model.titleMatches', { filtered: 1, total: 3, query: 'deepseek-chat' }))
        .toContain('1/3')
      expect(t('panel.provider.failure', { providers: 'openai' })).toContain('openai')
      expect(t('panel.setup.title', { provider: 'custom-api' })).toContain('custom-api')
    } finally {
      setLanguage('en')
    }
  })
})

describe('LanguagePanel', () => {
  it('lists both languages, marks the active one, and applies a selection', async () => {
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
      columns: 80,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const picked: string[] = []
    const instance = render(createElement(LanguagePanel, {
      current: 'en',
      select: name => {
        picked.push(name)
      },
      close: () => {},
    }), { stdin, stdout, stderr: stdout, exitOnCtrlC: false, patchConsole: false })
    try {
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(output).toContain('English')
      expect(output).toContain('中文')
      expect(output).toContain('●')
      // Cursor rests on the current language (English); Enter applies it.
      stdin.write('\r')
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(picked).toEqual(['en'])
      // Down to Chinese, Enter applies zh.
      stdin.write('\x1b[B')
      await new Promise(resolve => setTimeout(resolve, 50))
      stdin.write('\r')
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(picked).toEqual(['en', 'zh'])
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})
