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
import { LanguagePanel } from '../src/language-panel.ts'

describe('i18n catalog', () => {
  it('defaults to english and switches catalogs live', () => {
    try {
      setLanguage('en')
      expect(getLanguage()).toBe('en')
      expect(t('composer.placeholder')).toBe('type a message · / commands · @ mentions')
      setLanguage('zh')
      expect(getLanguage()).toBe('zh')
      expect(t('composer.placeholder')).toBe('输入消息 · / 命令 · @ 引用')
      setLanguage('en')
      expect(t('composer.placeholder')).toBe('type a message · / commands · @ mentions')
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
