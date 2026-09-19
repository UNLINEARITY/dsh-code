/** The DeepSeek model-switch easter egg animation. */

import { describe, expect, it, vi } from 'vitest'
import {
  type SessionEvent,
  App,
  PassThrough,
  appProps,
  chalk,
  createElement,
  createTranscriptStore,
  render,
  setTheme,
  wait,
  waveBgCount,
} from './helpers/app-mount.ts'

describe('DeepSeek model-switch easter egg', () => {
  it('sweeps Codex-style per-column wave backgrounds inside the composer, sparkles on the deepseek tier, then restores static; switching away restores ❯ + brand', async () => {
    // The color assertions need truecolor ANSI output; the default test
    // environment disables colors (chalk level 0), so force level 3 here and
    // restore the baseline in the finally block.
    const originalChalkLevel = chalk.level
    chalk.level = 3
    // The ignition style is picked at random; pin Math.random to 0 so the
    // Wave style runs and the deepseek-tier sparkles are guaranteed.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
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
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
    const store = createTranscriptStore()
    // The last selectable row is the official DeepSeek route; 'G' jumps to it.
    // deepseek-reasoner runs the deepseek tier (dual band + sparkles).
    const models = [
      ...Array.from({ length: 30 }, (_, index) => ({
        provider: 'acme',
        providerName: 'Acme',
        model: `model-${String(index).padStart(2, '0')}`,
        modelName: `Model ${String(index).padStart(2, '0')}`,
      })),
      { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-reasoner', modelName: 'DeepSeek-Reasoner' },
    ]
    const instance = render(createElement(App, appProps({
      store,
      model: 'acme/model-01',
      loadModels: async () => ({ rows: models, failures: [] }),
      selectModel: row => `${row.provider}/${row.model}`,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      expect(output).not.toContain('deepseek-reasoner')

      // /model → filter to the DeepSeek row → select it. The
      // deepseek tier runs the readability-extended 1.5s Wave-Ultra sweep.
      output = ''
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('deepseek')
      await wait()
      stdin.write('\r')
      await wait()

      const label = 'deepseek-official/deepseek-reasoner'
      expect(output).toContain(label)
      // The persistent prompt marker switched to the deepseek tier glyph » in
      // the tier accent. The first animation interval may already have landed
      // by the time the TTY assertion runs, so lifecycle coverage starts from
      // the stable marker instead of assuming an exact zero-tick frame.
      expect(output).toContain('»')

      // A multiline CJK draft keeps the same physical editor rows throughout
      // the animation; the wave only changes backgrounds and never flattens
      // explicit newlines into a one-row ↵ preview.
      output = ''
      stdin.write('[200~动画第一行\r动画第二行[201~')
      await wait()
      const multilineWave = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '')
      expect(multilineWave).toContain('动画第一行')
      expect(multilineWave).toContain('动画第二行')
      expect(multilineWave).not.toContain('动画第一行↵动画第二行')

      // Mid-wave (~0.7s in): the input row paints per-column wave backgrounds
      // (a truecolor `48;2;` run per sampled gradient column) while the draft
      // area stays readable — the tint blends at ≤ 0.55 toward the base.
      await sleep(700)
      const distinctBg = (): number => new Set((output.match(/48;2;\d{1,3};\d{1,3};\d{1,3}/g) ?? [])).size
      expect(distinctBg()).toBeGreaterThanOrEqual(5)

      // The nominal `· ✦ ✧` tail spans about 1.04s..1.38s. Ink intervals
      // stretch under parallel test load, so wait generously for all frames.
      await sleep(1600)
      expect(output).toContain('✦')
      expect(output).toContain('✧')

      // Past the 1.5s duration: fresh frames carry no wave backgrounds and no
      // sparkles — the band settles back to its static background color.
      await sleep(900)
      const settled = output.length
      await sleep(400)
      const settledDelta = output.slice(settled)
      expect(waveBgCount(settledDelta)).toBe(0)
      expect(settledDelta).not.toContain('✦')

      // Switch away from DeepSeek: the prompt restores the static brand ❯ and
      // drops the » glyph — the tier accent is not sticky on other routes.
      // The panel-open frames still show the tier » in the frozen composer,
      // so the brand ❯ must be the LAST prompt painted after the selection.
      // The reopened list rests on the APPLIED deepseek row: one up reaches
      // the previous acme row.
      stdin.write('\x03') // clear the multiline draft before typing /model
      await wait()
      output = ''
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      const away = output.length
      stdin.write('\x1b[A')
      await wait()
      stdin.write('\r')
      await wait()
      const awayDelta = output.slice(away)
      expect(awayDelta).toMatch(/38;2;65;118;230m❯/)
      expect(awayDelta.lastIndexOf('»')).toBeLessThan(awayDelta.lastIndexOf('38;2;65;118;230m❯'))
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
      chalk.level = originalChalkLevel
      randomSpy.mockRestore()
    }
  }, 20_000)

  it('plays the "Into the Unknown" wave on a non-DeepSeek model at an above-high effort, then restores static', async () => {
    const originalChalkLevel = chalk.level
    chalk.level = 3
    // Pin the Wave style (the unknown tier shares the deepseek Ultra
    // parameters, including the sparkle tail) and force dark.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    setTheme('dark')
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
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
    // The applied route is NON-DeepSeek, so only an above-high effort may
    // trigger the wave. acme/think advertises off/high/max with default high.
    const models = [
      { provider: 'acme', providerName: 'Acme', model: 'model-01', modelName: 'Model 01' },
      {
        provider: 'acme',
        providerName: 'Acme',
        model: 'think',
        modelName: 'Think',
        reasoning: {
          efforts: [
            { id: 'off', name: 'Off' },
            { id: 'high', name: 'High' },
            { id: 'max', name: 'Max' },
          ],
          defaultEffort: 'high',
        },
      },
    ]
    const instance = render(createElement(App, appProps({
      store: createTranscriptStore(),
      model: 'acme/model-01',
      loadModels: async () => ({ rows: models, failures: [] }),
      selectModel: row => `${row.provider}/${row.model}`,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      // The welcome header's bilingual slogan is "Into the Unknown 探索未至之
      // 境", so a bare "Into the Unknown" WITHOUT the Chinese suffix is the
      // wave wordmark's unique signal.
      const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '')
      const bareWordmark = (text: string): RegExpMatchArray | null =>
        stripAnsi(text).match(/Into the Unknown(?!\s*探索未至之境)/)

      await wait()
      // The non-DeepSeek route with no high effort never waves: static brand
      // prompt, no wordmark, no per-column background.
      expect(bareWordmark(output)).toBeNull()

      // /model → down to acme/think → its effort stage opens on the default
      // (high) → one more down reaches max → apply.
      output = ''
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('\x1b[B')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('effort for Acme · Think')
      stdin.write('\x1b[B')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('model → next step uses acme/think@max')

      // The applied label is acme/think@max — a non-DeepSeek route with an
      // effort strictly above high — so the "Into the Unknown" wave plays
      // the deepseek-tier motion: per-column backgrounds mid-wave…
      await sleep(700)
      const distinctBg = (): number => new Set((output.match(/48;2;\d{1,3};\d{1,3};\d{1,3}/g) ?? [])).size
      expect(distinctBg()).toBeGreaterThanOrEqual(5)
      // …the Into the Unknown wordmark surfaces through the middle…
      expect(bareWordmark(output)).not.toBeNull()
      // …and the prompt keeps the static brand glyph (only official DeepSeek
      // tiers swap to ›/»).
      expect(output).not.toContain('»')

      // The nominal `· ✦ ✧` tail spans about 1.04s..1.38s; wait generously.
      await sleep(1600)
      expect(output).toContain('✦')
      expect(output).toContain('✧')

      // Past the 1.5s duration: fresh frames carry no wave backgrounds and no
      // sparkles — the band settles back to its static background color.
      await sleep(900)
      const settled = output.length
      await sleep(400)
      const settledDelta = output.slice(settled)
      expect(waveBgCount(settledDelta)).toBe(0)
      expect(settledDelta).not.toContain('✦')

      // Dropping the effort back to high clears the wave state: no "Into the
      // Unknown" wordmark on a fresh trigger, static brand restored.
      output = ''
      stdin.write('/model')
      await wait()
      stdin.write('\r') // opens the model list on the APPLIED row (acme/think)
      await wait()
      stdin.write('\r') // its effort stage opens on the effective level (max)
      await wait()
      expect(output).toContain('effort for Acme · Think')
      stdin.write('g') // top of the list (off)
      await wait()
      stdin.write('\x1b[B') // one down reaches high
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('model → next step uses acme/think@high')
      await sleep(400)
      expect(bareWordmark(output)).toBeNull()
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
      chalk.level = originalChalkLevel
      setTheme('dark')
      randomSpy.mockRestore()
    }
  }, 20_000)

  it('plays the wave exactly once per trigger — busy cycles and /animation toggles never replay it', async () => {
    const originalChalkLevel = chalk.level
    chalk.level = 3
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
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
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
    const store = createTranscriptStore()
    const models = [
      ...Array.from({ length: 30 }, (_, index) => ({
        provider: 'acme',
        providerName: 'Acme',
        model: `model-${String(index).padStart(2, '0')}`,
        modelName: `Model ${String(index).padStart(2, '0')}`,
      })),
      { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-reasoner', modelName: 'DeepSeek-Reasoner' },
    ]
    const instance = render(createElement(App, appProps({
      store,
      model: 'acme/model-01',
      loadModels: async () => ({ rows: models, failures: [] }),
      selectModel: row => `${row.provider}/${row.model}`,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // Switch onto the official DeepSeek route (bottom row) — the sweep
      // must play exactly once.
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('deepseek')
      await wait()
      stdin.write('\r')
      await wait()
      output = ''
      await sleep(2600)
      expect(waveBgCount(output)).toBeGreaterThan(0)
      expect(output).toContain('✧')

      // A full busy cycle on the UNCHANGED model+effort pair drops and raises
      // the wave gate — a completed sweep must never restart from it.
      store.apply({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } as SessionEvent)
      await sleep(300)
      store.apply({ type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent)
      await sleep(300)
      let mark = output.length
      await sleep(1200)
      let delta = output.slice(mark)
      expect(waveBgCount(delta)).toBe(0)
      expect(delta).not.toContain('✦')

      // /animation off → on on the unchanged pair replays nothing either.
      output = ''
      stdin.write('/animation off')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('animations off')
      stdin.write('/animation on')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('animations on')
      mark = output.length
      await sleep(1200)
      delta = output.slice(mark)
      expect(waveBgCount(delta)).toBe(0)
      expect(delta).not.toContain('✦')

      // Modal panels freeze the composer and UNMOUNT the wave leaf; closing
      // one must NOT replay the settled sweep (the one-shot latch lives in
      // Input, surviving the leaf's unmount/remount cycle).
      output = ''
      stdin.write('/help')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('\x1b') // esc closes the help panel
      await wait()
      mark = output.length
      await sleep(1200)
      delta = output.slice(mark)
      expect(waveBgCount(delta)).toBe(0)
      expect(delta).not.toContain('✦')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
      chalk.level = originalChalkLevel
      randomSpy.mockRestore()
    }
  }, 25_000)

  it('consumes triggers that land while animations are off — /animation on never queues a wave', async () => {
    const originalChalkLevel = chalk.level
    chalk.level = 3
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
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
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
    const store = createTranscriptStore()
    const models = [
      ...Array.from({ length: 30 }, (_, index) => ({
        provider: 'acme',
        providerName: 'Acme',
        model: `model-${String(index).padStart(2, '0')}`,
        modelName: `Model ${String(index).padStart(2, '0')}`,
      })),
      { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-reasoner', modelName: 'DeepSeek-Reasoner' },
    ]
    const instance = render(createElement(App, appProps({
      store,
      model: 'acme/model-01',
      loadModels: async () => ({ rows: models, failures: [] }),
      selectModel: row => `${row.provider}/${row.model}`,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // Disable animations FIRST, then switch onto the official DeepSeek
      // route while they are off.
      stdin.write('/animation off')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('animations off')
      output = ''
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('deepseek')
      await wait()
      stdin.write('\r')
      await wait()
      // The » tier accent proves the route switch landed (its absence alone
      // would be a vacuous pass)…
      expect(output).toContain('»')
      await sleep(1000)
      // …and no wave played while animations were off.
      expect(waveBgCount(output)).toBe(0)

      // Re-enabling must not replay the silently consumed celebration.
      output = ''
      stdin.write('/animation on')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('animations on')
      const after = output.length
      await sleep(1500)
      expect(waveBgCount(output.slice(after))).toBe(0)
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
      chalk.level = originalChalkLevel
      randomSpy.mockRestore()
    }
  }, 20_000)

  it('freezes the wave and the busy shimmer entirely when animations are off', async () => {
    const originalChalkLevel = chalk.level
    chalk.level = 3
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
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
      columns: 100,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
    const store = createTranscriptStore()
    const models = [
      ...Array.from({ length: 30 }, (_, index) => ({
        provider: 'acme',
        providerName: 'Acme',
        model: `model-${String(index).padStart(2, '0')}`,
        modelName: `Model ${String(index).padStart(2, '0')}`,
      })),
      { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-reasoner', modelName: 'DeepSeek-Reasoner' },
    ]
    const instance = render(createElement(App, appProps({
      store,
      animations: false,
      model: 'acme/model-01',
      loadModels: async () => ({ rows: models, failures: [] }),
      selectModel: row => `${row.provider}/${row.model}`,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // Switch onto the official DeepSeek route with animations off: the »
      // tier accent proves the switch landed (its absence alone would be a
      // vacuous pass)…
      stdin.write('/model')
      await wait()
      stdin.write('\r')
      await wait()
      stdin.write('deepseek')
      await wait()
      stdin.write('\r')
      await wait()
      expect(output).toContain('»')
      await sleep(1000)
      // …and the sweep never paints a single wave background.
      expect(waveBgCount(output)).toBe(0)

      // Busy without streaming: the Deep diving line paints once, then never
      // re-renders — its 33ms shimmer timer stays dormant with animations off.
      store.apply({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } as SessionEvent)
      await sleep(500)
      expect(output).toContain('Deep diving')
      const painted = output.length
      await sleep(700)
      expect(output.slice(painted)).not.toContain('Deep diving')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
      chalk.level = originalChalkLevel
      randomSpy.mockRestore()
    }
  }, 15_000)
})
