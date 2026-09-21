/** Settled transcript rendering, caches, and row budgets. */

import { describe, expect, it, vi } from 'vitest'
import { visibleColumns } from '../src/render/markdown.ts'
import {
  type TranscriptEntry,
  type ToolCallId,
  type SessionEvent,
  App,
  DEFAULT_TERMINAL_TITLE,
  PassThrough,
  appProps,
  applyStreamDeltas,
  assistantEntry,
  chalk,
  computeSettledRows,
  createAssistantMessage,
  createElement,
  createToolResultMessage,
  createTranscriptStore,
  createTty,
  createUserMessage,
  render,
  renderApp,
  resizeClear,
  streamTailBodyColumns,
  wait,
} from './helpers/app-mount.ts'

describe('keyboard protocol and transcript alignment', () => {
  it('routes enhanced Ctrl+C through the busy interrupt contract', async () => {
    const harness = createTty(100, 24)
    const interrupt = vi.fn(() => true)
    const quit = vi.fn()
    const store = createTranscriptStore([
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } as SessionEvent,
      { type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } } as SessionEvent,
    ])
    const instance = renderApp(harness, appProps({ store, interrupt, quit }))
    try {
      await wait()
      harness.output.text = ''
      harness.stdin.write('\x1b[99;5u')
      await wait()
      expect(interrupt).toHaveBeenCalledTimes(1)
      expect(quit).not.toHaveBeenCalled()
      expect(harness.output.text).not.toContain('[99;5u')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('clears a draft on enhanced Ctrl+C before a second press quits', async () => {
    const harness = createTty(100, 24)
    const quit = vi.fn()
    const instance = renderApp(harness, appProps({ quit }))
    try {
      await wait()
      harness.stdin.write('draft')
      await wait()
      harness.stdin.write('\x1b[99;5u')
      await wait()
      expect(quit).not.toHaveBeenCalled()

      harness.output.text = ''
      harness.stdin.write('\x1b[99;5u')
      await wait()
      expect(quit).toHaveBeenCalledTimes(1)
      expect(harness.output.text).not.toContain('[99;5u')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('decodes kitty CSI-u keys: ctrl+r toggles the reasoning fold, Esc keeps its meaning', async () => {
    const harness = createTty(100, 24)
    const { stdin, output } = harness
    const interrupt = vi.fn(() => true)
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
      } as SessionEvent,
      {
        type: 'turn/start',
        seq: 2,
        time: 2,
        data: { turn: 1 },
      } as SessionEvent,
      {
        type: 'step/start',
        seq: 3,
        time: 3,
        data: { turn: 1, step: 1 },
      } as SessionEvent,
    ])
    applyStreamDeltas(store, 1, 1, [{ kind: 'reasoning', text: 'the hidden reasoning trace', time: 4 }])
    const instance = renderApp(harness, appProps({ store, interrupt }))
    try {
      await wait()
      expect(output.text).toContain('Thinking')
      expect(output.text).not.toContain('the hidden reasoning trace')
      // The kitty CSI-u form of Ctrl+R decodes to the legacy control byte
      // before Ink parses it, so the fold opens without touching the draft.
      output.text = ''
      stdin.write('[114;5u')
      await wait()
      expect(output.text).not.toContain('[114;5u')
      // The fold opens through one global source-backed replay.
      expect(output.text).toContain('the hidden reasoning trace')
      expect((output.text.match(/\x1b\[2J/gu) ?? []).length).toBe(1)

      output.text = ''
      stdin.write('[114;5u')
      await wait()
      expect(output.text).toContain('Thinking')
      expect(output.text).not.toContain('the hidden reasoning trace')
      expect((output.text.match(/\x1b\[2J/gu) ?? []).length).toBe(1)

      stdin.write('\x1b')
      await wait()
      expect(interrupt).toHaveBeenCalledTimes(1)
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('folds tool output by default and expands full detail with Ctrl+R', async () => {
    const harness = createTty(40, 30)
    const { stdin, output } = harness
    const callId = 'wide-tool' as ToolCallId
    const store = createTranscriptStore([
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } as SessionEvent,
      { type: 'tool/call', seq: 2, time: 2, data: { turn: 1, step: 1, callId, name: 'run_code', arguments: '{}' } } as SessionEvent,
      {
        type: 'tool/result',
        seq: 3,
        time: 3,
        data: {
          turn: 1,
          step: 1,
          message: createToolResultMessage({
            callId,
            content: [{ type: 'text', text: 'summary '.repeat(12) }],
            isError: false,
          }),
        },
      } as SessionEvent,
      { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent,
    ])
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      expect(output.text).toContain('Ctrl/Alt+R')
      output.text = ''
      stdin.write('\x12')
      await wait()
      // Expanded raw detail supersedes the bounded ⎿ summary instead of
      // printing the same output twice. Every wrapped detail row keeps the
      // tool card's four-space gutter.
      expect(output.text).not.toContain('\u23bf')
      expect(output.text).toContain('(end of output)')
      const detailLines = output.text.split('\n').filter(line => line.includes('summary'))
      expect(detailLines.length).toBeGreaterThan(0)
      for (const line of detailLines) expect(line.startsWith('    ')).toBe(true)
    } finally {
      instance.unmount()
      stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('keeps the terminal cursor on Ink\'s parked row across every foreign write', async () => {
    // The IME anchor displaces the real cursor onto the composer caret cell.
    // The ledger contract refines the old write-identity guard: every write
    // that is not the anchor\'s own must start with the cancel sequence that
    // returns the cursor to Ink\'s parked row before Ink\'s relative erase
    // runs, and log-update frame rewrites re-append the anchor inside the
    // same write so a repaint can never leave the cursor displaced.
    const chunks: string[] = []
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 80,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
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
    const harness = { stdin, stdout, output: { text: '' } }
    const instance = renderApp(harness, appProps())
    try {
      await wait()
      stdin.write('ab')
      await wait()
      // A frame rewrite always arrives cancel-prefixed (the cursor is back
      // on Ink's parked row before the relative erase runs) and ends with the
      // re-anchor appended inside the same write.
      const frameWrites = chunks.filter(chunk => /^\x1b\[\d+B\r\x1b\[2K/.test(chunk))
      expect(frameWrites.length).toBeGreaterThan(0)
      for (const frame of frameWrites) {
        expect(frame).toMatch(/\x1b\[\d+A\x1b\[\d+G$/)
      }
      // Writes that are neither frame rewrites nor the anchor's own moves
      // leave no anchor behind.
      for (const chunk of chunks) {
        if (!/^\x1b\[\d+B\r\x1b\[2K/.test(chunk) && !/^\x1b\[\d+B\r\x1b\[\d+A\x1b\[\d+G$/.test(chunk) && !/^\x1b\[\d+A\x1b\[\d+G$/.test(chunk)) {
          expect(chunk).not.toMatch(/\x1b\[\d+A\x1b\[\d+G$/)
        }
      }
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})
describe('context stepless bar', () => {
  it('paints one proportional DeepSeek-blue run with the usage readout outside it', async () => {
    // The color assertions need truecolor ANSI output; force level 3 and
    // restore the baseline in the finally block.
    const originalChalkLevel = chalk.level
    chalk.level = 3
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
      columns: 140,
      rows: 24,
    }) as unknown as NodeJS.WriteStream
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const store = createTranscriptStore()
    const callId = 'parse-tool' as ToolCallId
    store.apply({ type: 'request/context', seq: 1, time: 1, data: { provider: 'p', model: 'm', contextWindow: 128_000 } } as SessionEvent)
    store.apply({
      type: 'request/header', seq: 2, time: 2,
      data: { header: { config: { provider: 'p', model: 'm' }, system: 'you are a helpful assistant' }, reason: 'initial' },
    } as unknown as SessionEvent)
    store.apply({ type: 'turn/start', seq: 3, time: 3, data: { turn: 1 } } as SessionEvent)
    store.apply({ type: 'step/start', seq: 4, time: 4, data: { turn: 1, step: 1 } } as SessionEvent)
    store.apply({
      type: 'user/message', seq: 5, time: 5,
      data: createUserMessage({ content: [{ type: 'text', text: 'please fix the failing test in the parser module' }], source: { kind: 'user' } }),
    } as SessionEvent)
    store.apply({
      type: 'assistant/message', seq: 6, time: 1_006,
      data: {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [
            { type: 'reasoning', text: 'the parser fails on empty input' },
            { type: 'text', text: 'done, fixed the parser' },
          ],
          source: { provider: 'p', model: 'm' },
        }),
        usage: { inputTokens: 100_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    } as unknown as SessionEvent)
    store.apply({
      type: 'tool/call', seq: 7, time: 2_000,
      data: { turn: 1, step: 1, callId, name: 'edit', arguments: '{"path":"src/parser.ts"}' },
    } as unknown as SessionEvent)
    store.apply({
      type: 'tool/result', seq: 8, time: 2_500,
      data: { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'patched the file' }], isError: false }) },
    } as unknown as SessionEvent)
    const instance = render(createElement(App, appProps({
      store,
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // The stepless bar is purely proportional: the fill run tracks the
      // true occupancy and the dotted track shows the remainder. The usage
      // readout rides outside the bar; on this tight row the ladder has
      // already traded the absolute pair for meter resolution.
      const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '')
      expect(stripAnsi(output)).toMatch(/context [█░]+ 100K\/128K 78%/u)
      // The fill paints one brand-blue run; the dotted track reads dim.
      expect(output).toMatch(/38;2;65;118;230m[^\x1b]*█/) // ctxFill → brand
      // The drawn fill share tracks the reported percent within one column
      // of rounding at this meter width.
      const run = stripAnsi(output).match(/context ([█░]+)/u)
      const blocks = (run![1].match(/█/gu) || []).length
      const expectedFill = Math.round(100_000 / 128_000 * run![1].length)
      expect(Math.abs(blocks - expectedFill)).toBeLessThanOrEqual(1)
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
      chalk.level = originalChalkLevel
    }
  }, 15_000)
})
describe('settledRows incremental cache (pure)', () => {
  it('appends only the new suffix, keeps idle toggles clear-free, and rebuilds once on replay', () => {
    // 120 settled assistant rows, every 10th carrying reasoning.
    const base: TranscriptEntry[] = []
    for (let index = 0; index < 120; index++) {
      base.push(assistantEntry(`msg-${index}`, index % 10 === 0 ? 'trace' : ''))
    }
    let result = computeSettledRows(undefined, base, base.length, false, false, 0)
    expect(result.built).toBe(base.length)
    const firstFlat = result.cache.flat

    // Appending one settled row builds ONLY that row — the prefix is never
    // rescanned or rebuilt, and every existing element keeps identity.
    const grown = [...base, assistantEntry('msg-120')]
    result = computeSettledRows(result.cache, grown, grown.length, false, false, 0)
    expect(result.built).toBe(1)
    expect(result.cache.flat).not.toBe(firstFlat)
    for (let index = 0; index < firstFlat.length; index++) {
      expect(result.cache.flat[index]).toBe(firstFlat[index])
    }

    // No boundary change: the same flat identity is returned (Static skips).
    const flatBefore = result.cache.flat
    result = computeSettledRows(result.cache, grown, grown.length, false, false, 0)
    expect(result.built).toBe(0)
    expect(result.cache.flat).toBe(flatBefore)

    // The pure toggle step stays inert (App decides whether to trigger a
    // replay): the same Static element list remains intact.
    const flatBeforeToggle = result.cache.flat
    result = computeSettledRows(result.cache, grown, grown.length, true, false, 0)
    expect(result.built).toBe(0)
    expect(result.cache.flat).toBe(flatBeforeToggle)

    // A newly settled reasoning row captures the current mode.
    const expanded = [...grown, assistantEntry('msg-121', 'new trace')]
    result = computeSettledRows(result.cache, expanded, expanded.length, true, false, 0)
    expect(result.built).toBe(1)

    // Width changes update live geometry first; Static waits for the debounced
    // source-backed replay instead of rebuilding at an intermediate width.
    const flatBeforeResize = result.cache.flat
    result = computeSettledRows(result.cache, expanded, expanded.length, true, false, 0, 100)
    expect(result.built).toBe(0)
    expect(result.cache.flat).toBe(flatBeforeResize)
    expect(result.cache.columns).toBe(80)

    // Source-backed replay (epoch bump — resize, Ctrl+L, or an idle Ctrl+R):
    // full rebuild of the current rows UNIFORMLY at the current fold state.
    result = computeSettledRows(result.cache, expanded, expanded.length, true, false, 1, 100)
    expect(result.built).toBe(expanded.length)
    expect(result.cache.columns).toBe(100)
    expect(result.cache.showReasoning).toBe(true)
    expect(result.cache.flat.length).toBeGreaterThan(0)

    // Shrink (store.reset): the prefix truncates to empty.
    result = computeSettledRows(result.cache, [], 0, true, false, 1)
    expect(result.built).toBe(0)
    expect(result.cache.flat).toHaveLength(1)
  })
})
describe('settled tool/command name sanitization', () => {
  it('never writes raw OSC/CSI control bytes from a malicious tool or command name; renders the escaped literal', async () => {
    const harness = createTty()
    const { stdin, stdout, output } = harness
    // A tool name carrying an OSC-0 title hijack (+ BEL) and a command name
    // carrying a CSI clear-screen. Everything is seeded BEFORE the first
    // render, so the rows settle straight into <Static> and the only paint
    // path is the settled EntryLine (the running live region is a separate
    // surface).
    const oscTool = 'evil\x1b]0;pwned\x07fetch'
    const csiCommand = 'wipe\x1b[2Jfetch'
    const toolCallId = 'evil-tool' as ToolCallId
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
      } as SessionEvent,
      {
        type: 'tool/call',
        seq: 2,
        time: 2,
        data: { turn: 1, step: 1, callId: toolCallId, name: oscTool, arguments: '{}' },
      } as SessionEvent,
      {
        type: 'tool/result',
        seq: 3,
        time: 3,
        data: {
          turn: 1,
          step: 1,
          message: createToolResultMessage({ callId: toolCallId, content: [{ type: 'text', text: 'ok' }], isError: false }),
        },
      } as SessionEvent,
      {
        type: 'command/run',
        seq: 4,
        time: 4,
        data: { commandId: 'evil-command', name: csiCommand, args: '--x' },
      } as SessionEvent,
      {
        type: 'command/done',
        seq: 5,
        time: 5,
        data: { commandId: 'evil-command', kind: 'success', text: 'done' },
      } as SessionEvent,
    ])
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      // The sanitized literals reach the terminal as visible `\xNN` text.
      expect(output.text).toContain('evil\\x1b]0;pwned\\x07fetch')
      expect(output.text).toContain('wipe\\x1b[2Jfetch')
      // The raw control sequences (OSC title hijack, CSI clear-screen) never
      // reach the terminal bytes.
      expect(output.text).not.toContain('evil\x1b]0;pwned\x07fetch')
      expect(output.text).not.toContain('wipe\x1b[2Jfetch')
      // The app writes exactly one managed tab-title OSC-0 itself
      // (terminal-title.ts), whose payload is sanitized free of control
      // bytes; in this fixture that is the "deepseek" default. Any OSC-0
      // beyond that well-formed managed sequence — in particular one riding
      // untrusted tool or command names — never reaches the terminal bytes.
      const titleOsc = /\x1b\]0;([^\x07\u0000-\u001F\u007F]*)\x07/g
      const payloads = [...output.text.matchAll(titleOsc)].map(match => match[1])
      expect(payloads.length).toBeGreaterThan(0)
      for (const payload of payloads) {
        expect(payload).toBe(DEFAULT_TERMINAL_TITLE)
      }
      expect(output.text.replace(titleOsc, '')).not.toContain('\x1b]0;')
      // The safe remainder of the names still renders.
      expect(output.text).toContain('evil')
      expect(output.text).toContain('wipe')
      expect(output.text).toContain('fetch')
      expect(output.text).toContain('done')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})
describe('incremental settled transcript cache', () => {
  it('shows a command/done replacement and later appends inside one settled history without ghosting', async () => {
    const harness = createTty()
    const { stdin, stdout, output } = harness
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
      } as SessionEvent,
      {
        type: 'command/run',
        seq: 2,
        time: 2,
        data: { commandId: 'lint', name: 'lint', args: 'src' },
      } as SessionEvent,
    ])
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      // While the command runs it stays in the LIVE mutable tail (a flush
      // boundary), rendering exactly one row — it never flushes to <Static>.
      expect(output.text.match(/\/lint/g)).toHaveLength(1)

      // command/done resolves the entry: it now settles, and the summary
      // appears IMMEDIATELY (the cache append path flushes the resolved
      // row) — no resize needed — exactly once.
      store.apply({
        type: 'command/done',
        seq: 3,
        time: 3,
        data: { commandId: 'lint', kind: 'success', text: 'lint passed' },
      } as SessionEvent)
      await wait()
      expect(output.text.match(/lint passed/g)).toHaveLength(1)

      // A later source-backed replay (resize) re-flushes the CURRENT row set:
      // the resolved command still appears exactly once in the rebuilt slice
      // — no ghost of the running copy.
      stdout.columns = 80
      stdout.emit('resize')
      await wait()
      expect(output.text.match(/\x1b\[2J/g)).toHaveLength(1)
      const rebuilt = output.text.slice(output.text.lastIndexOf(resizeClear) + resizeClear.length)
      expect(rebuilt).toContain('lint passed')
      expect(rebuilt.match(/lint passed/g)).toHaveLength(1)
      expect(rebuilt.match(/\/lint/g)).toHaveLength(1)

      // Later appends settle after the existing prefix; the append path adds
      // only the new rows and never re-emits the resolved command.
      const lintBefore = output.text.match(/lint passed/g)!.length
      store.apply({
        type: 'user/message',
        seq: 4,
        time: 4,
        data: createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }),
      } as SessionEvent)
      store.apply({
        type: 'assistant/message',
        seq: 5,
        time: 5,
        data: {
          turn: 1,
          step: 2,
          message: createAssistantMessage({ content: [{ type: 'text', text: 'done again' }], source: { provider: 'p', model: 'm' } }),
        },
      } as SessionEvent)
      await wait()
      expect(output.text).toContain('done again')
      expect(output.text.match(/done again/g)).toHaveLength(1)
      expect(output.text.match(/lint passed/g)!.length).toBe(lintBefore)
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('flushes a long settled history once and replays it exactly once per source-backed refresh', async () => {
    const harness = createTty()
    const { stdin, stdout, output } = harness
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }),
      } as SessionEvent,
      ...Array.from({ length: 120 }, (_, index) => ({
        type: 'assistant/message',
        seq: index + 2,
        time: index + 2,
        data: {
          turn: 1,
          step: index + 1,
          message: createAssistantMessage({ content: [{ type: 'text', text: `msg-${index}` }], source: { provider: 'p', model: 'm' } }),
        },
      }) as SessionEvent),
    ])
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      // Every historical row appears; only the bounded physical-row tail may
      // repaint while editor/status row reports settle after mount.
      const initialMessages = output.text.match(/msg-\d+/g) ?? []
      expect(new Set(initialMessages)).toHaveLength(120)
      expect(output.text.match(/msg-0/g)).toHaveLength(1)
      const visibleOutput = output.text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, '')
      expect(visibleOutput).not.toMatch(/(?:\n[ \t]*){10}/u)

      // A resize triggers one source-backed replay: one clear, then the FULL
      // history re-flushes once (no ghosts, no duplicates, no lost rows).
      output.text = ''
      stdout.columns = 80
      stdout.emit('resize')
      await wait()
      expect(output.text.match(/\x1b\[2J/g)).toHaveLength(1)
      const rebuilt = output.text.slice(output.text.lastIndexOf(resizeClear) + resizeClear.length)
      expect(rebuilt.match(/msg-\d+/g)).toHaveLength(120)
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})
describe('physical-row transcript viewport', () => {
  it('fills stream contraction with real settled rows and no blank frame', async () => {
    const harness = createTty(100, 24)
    const history = Array.from({ length: 30 }, (_, index) => ({
      type: 'assistant/message',
      seq: index + 1,
      time: index + 1,
      data: {
        turn: index + 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: `tail-${index}` }],
          source: { provider: 'p', model: 'm' },
        }),
      },
    } as SessionEvent))
    const store = createTranscriptStore(history)
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      harness.output.text = ''
      store.apply({ type: 'turn/start', seq: 31, time: 31, data: { turn: 31 } } as SessionEvent)
      applyStreamDeltas(store, 31, 1, [{ kind: 'text', text: 'live answer' }])
      await wait()
      expect(harness.output.text).toContain('tail-29')
      expect(harness.output.text).toContain('live answer')
      expect(harness.output.text).not.toContain('\x1b[2J')
      // VS Code auto-wraps a row painted at exactly stdout.columns. Every
      // first-token row—including the stretched status bar—must leave one
      // physical column unused or the unreported wrap lifts the bottom band.
      const firstTokenFrame = harness.output.text
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, '')
        .replace(/\x1b\][^\x07]*\x07/gu, '')
      expect(Math.max(...firstTokenFrame.split('\n').map(visibleColumns))).toBeLessThan(harness.stdout.columns)

      harness.output.text = ''
      store.apply({
        type: 'assistant/message',
        seq: 32,
        time: 32,
        data: {
          turn: 31,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: 'settled answer' }],
            source: { provider: 'p', model: 'm' },
          }),
        },
      } as SessionEvent)
      store.apply({ type: 'turn/end', seq: 33, time: 33, data: { turn: 31, reason: { kind: 'completed' } } } as SessionEvent)
      await wait()
      const visible = harness.output.text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, '')
      expect(visible).toContain('settled answer')
      expect(visible).toContain('tail-29')
      expect(visible).not.toMatch(/(?:\n[ \t]*){6}/u)
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})

describe('stream wrap budget', () => {
  it('wraps streamed body text at the same column settled markdown uses', () => {
    const terminal = 80
    const row = terminal - 2
    // Settled assistant markdown wraps at row-2 after the two-column gutter.
    expect(streamTailBodyColumns(row, '  ')).toBe(row - 2)
    expect(streamTailBodyColumns(row, '✻ ', '  ')).toBe(row - 2)
  })
})
describe('settled row cap window', () => {
  // One short assistant entry renders as exactly one physical row at 80 cols.
  const one = (text: string): TranscriptEntry => assistantEntry(text)

  it('rebuild keeps whole newest entries within the cap and reports the dropped count', () => {
    const entries = Array.from({ length: 20 }, (_, index) => one(`m${index}`))
    // Budget = cap - reserve(12): cap 20 leaves 8 rows -> newest 8 entries stay.
    const result = computeSettledRows(undefined, entries, entries.length, false, false, 0, 80, 20)
    expect(result.built).toBe(8)
    expect(result.cache.droppedEntries).toBe(12)
    expect(result.cache.entries).toHaveLength(8)
    expect(result.cache.totalRows).toBe(8)
    expect(result.cache.needsTrim).toBe(false)
    // flat = header + trim hint + the 8 window rows.
    expect(result.cache.flat).toHaveLength(1 + 1 + 8)
    expect(result.cache.flat[1].key).toBe('history-cap-hint')
  })

  it('append only accounts rows; the epoch-bump replay performs the actual drop', () => {
    const tight = Array.from({ length: 30 }, (_, index) => one(`t${index}`))
    // Capped rebuild (cap 30, budget 18): 18 stay, 2 drop, hint present.
    let state = computeSettledRows(undefined, tight.slice(0, 20), 20, false, false, 0, 80, 30)
    expect(state.cache.entries).toHaveLength(18)
    expect(state.cache.droppedEntries).toBe(2)
    expect(state.cache.flat).toHaveLength(1 + 1 + 18)
    // Growing inside cap + 25% hysteresis never trims: rows append, head stays.
    // (The window holds 28 of 30 — the 2 dropped at rebuild stay dropped.)
    state = computeSettledRows(state.cache, tight, tight.length, false, false, 0, 80, 30)
    expect(state.cache.needsTrim).toBe(false)
    expect(state.cache.entries).toHaveLength(28)
    expect(state.cache.totalRows).toBe(28)
    // Crossing cap + 25% (40 > 37) only flags the cache for a trimming replay.
    const big = [...tight, ...Array.from({ length: 12 }, (_, index) => one(`b${index}`))]
    state = computeSettledRows(state.cache, big, big.length, false, false, 0, 80, 30)
    expect(state.cache.needsTrim).toBe(true)
    expect(state.cache.entries).toHaveLength(40)
    expect(state.cache.flat).toHaveLength(1 + 1 + 40)
    // The replay (epoch bump) re-windows: back to the cap, flag cleared.
    state = computeSettledRows(state.cache, big, big.length, false, false, 1, 80, 30)
    expect(state.cache.needsTrim).toBe(false)
    expect(state.cache.entries).toHaveLength(18)
    expect(state.cache.droppedEntries).toBe(24)
    expect(state.cache.totalRows).toBe(18)
    expect(state.cache.flat).toHaveLength(1 + 1 + 18)
  })

  it('cap 0 disables windowing entirely', () => {
    const entries = Array.from({ length: 50 }, (_, index) => one(`m${index}`))
    const result = computeSettledRows(undefined, entries, entries.length, false, false, 0, 80, 0)
    expect(result.cache.entries).toHaveLength(50)
    expect(result.cache.droppedEntries).toBe(0)
    expect(result.cache.flat).toHaveLength(1 + 50)
    expect(result.cache.needsTrim).toBe(false)
  })

  it('the fold toggle preserves the window bookkeeping', () => {
    const entries = Array.from({ length: 20 }, (_, index) => one(`m${index}`))
    const capped = computeSettledRows(undefined, entries, entries.length, false, false, 0, 80, 20)
    const toggled = computeSettledRows(capped.cache, entries, entries.length, true, false, 0, 80, 20)
    expect(toggled.cache.droppedEntries).toBe(capped.cache.droppedEntries)
    expect(toggled.cache.totalRows).toBe(capped.cache.totalRows)
    expect(toggled.cache.flat).toBe(capped.cache.flat)
  })
})
