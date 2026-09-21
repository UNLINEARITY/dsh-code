/** Overlay views and theme surfaces (Ctrl+O, Ctrl+R, header, light theme). */

import { describe, expect, it, vi } from 'vitest'
import {
  type ToolCallId,
  type SessionEvent,
  App,
  DSH_CODE_VERSION,
  EMPTY_AGENTS,
  PassThrough,
  _resetDshKernelVersionForTests,
  appProps,
  applyStreamDeltas,
  approvalSnapshot,
  chalk,
  createAssistantMessage,
  createElement,
  createToolResultMessage,
  createTranscriptStore,
  createTty,
  createUserMessage,
  join,
  mkdirSync,
  mkdtempSync,
  questionSnapshot,
  render,
  renderApp,
  resizeClear,
  rmSync,
  setTheme,
  tmpdir,
  wait,
  writeFileSync,
} from './helpers/app-mount.ts'

describe('Ctrl+O history details', () => {
  it('labels each inspected entry with its kind in the title', async () => {
    const harness = createTty(100, 24)
    const store = createTranscriptStore()
    store.apply({
      type: 'user/message',
      seq: 1,
      time: 1,
      data: createUserMessage({
        content: [{ type: 'text', text: 'draft' }],
        source: { kind: 'user' },
      }),
    } as never)
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      harness.stdin.write('\x0f')
      await wait()
      // The newest entry is the user prompt: its kind names it in the title.
      expect(harness.output.text).toContain('user prompt')
      // Step back to... the store only has one entry, so also confirm the
      // label slot exists even when the walk rests on the only entry.
      expect(harness.output.text).toMatch(/history details · entry 1\/1 · user prompt · lines/)
    } finally {
      instance.unmount()
    }
  })

  it('skips reasoning-only assistant settlements in navigation', async () => {
    const harness = createTty(120, 18)
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({
          content: [{ type: 'text', text: 'Commit the completed changes.' }],
          source: { kind: 'user' },
        }),
      } as SessionEvent,
      {
        type: 'assistant/message',
        seq: 2,
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: 'Committed the verified changes successfully.' }],
            source: { provider: 'p', model: 'm' },
          }),
        },
      } as SessionEvent,
      {
        type: 'assistant/message',
        seq: 3,
        time: 3,
        data: {
          turn: 1,
          step: 2,
          message: createAssistantMessage({
            content: [{ type: 'reasoning', text: '**Committing changes to repository**' }],
            source: { provider: 'p', model: 'm' },
          }),
        },
      } as SessionEvent,
    ])
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      harness.output.text = ''
      harness.stdin.write('\x0f')
      await wait()
      expect(harness.output.text).toContain('history details · entry 2/2 · reply')
      expect(harness.output.text).toContain('Committed the verified changes successfully.')
      expect(harness.output.text).not.toContain('Committing changes to repository')
    } finally {
      instance.unmount()
    }
  })

  it('reflows the inspector border when the terminal narrows', async () => {
    const harness = createTty(100, 24)
    const store = createTranscriptStore()
    store.apply({
      type: 'user/message',
      seq: 1,
      time: 1,
      data: createUserMessage({
        content: [{ type: 'text', text: 'draft' }],
        source: { kind: 'user' },
      }),
    } as never)
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      harness.stdin.write('\x0f')
      await wait()
      expect(harness.output.text).toContain('history details')
      harness.output.text = ''
      Object.assign(harness.stdout, { columns: 40 })
      harness.stdout.emit('resize')
      await wait(180)
      expect(harness.output.text).toContain('history details')
      const rebuilt = harness.output.text.includes(resizeClear)
        ? harness.output.text.slice(harness.output.text.lastIndexOf(resizeClear) + resizeClear.length)
        : harness.output.text
      const plain = rebuilt.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      const dashes = Math.max(0, ...plain.split('\n').map(line => (line.match(/─/g) ?? []).length))
      expect(dashes).toBeGreaterThan(8)
      expect(dashes).toBeLessThan(50)
    } finally {
      instance.unmount()
    }
  })

  it('repaints the whole screen from the new palette when the theme changes', async () => {
    const harness = createTty(100, 24)
    let savedTheme = ''
    const instance = renderApp(harness, appProps({
      saveTheme: name => {
        savedTheme = name
      },
    }))
    try {
      await wait()
      // Open the theme picker and pick the second row (light).
      harness.stdin.write('/theme')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('/theme — color palette')
      harness.stdin.write('\x1b[B')
      await wait()
      harness.output.text = ''
      harness.stdin.write('\r')
      await wait()
      expect(savedTheme).toBe('light')
      // The Static region (whale header + settled rows) renders once, so the
      // theme switch must ride the same source-backed rebuild resize uses:
      // one clear sequence, then the header repaints under the new palette.
      expect(harness.output.text.match(/\x1b\[r\x1b\[0m\x1b\[H\x1b\[2J\x1b\[3J\x1b\[H/g)).toHaveLength(1)
      expect(harness.output.text.slice(harness.output.text.lastIndexOf(resizeClear) + resizeClear.length)).toContain('DeepSeek Harness')
    } finally {
      instance.unmount()
    }
  })

  it('uses an exclusive bounded screen without clearing scrollback and preserves the draft', async () => {
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
    const unsubscribe = (): void => {}
    const noop = (): void => {}
    let dispatched: string | undefined
    const store = createTranscriptStore()
    const descriptors = Array.from({ length: 30 }, (_, index) => ({
      name: `command-${String(index).padStart(2, '0')}`,
      description: `command description ${index}`,
    }))
    const skills = Array.from({ length: 20 }, (_, index) => ({
      name: `skill-${String(index).padStart(2, '0')}`,
      description: `skill description ${index}`,
      modelInvocable: true,
    }))
    const models = Array.from({ length: 100 }, (_, index) => ({
      provider: 'test',
      providerName: 'Test Provider',
      model: `model-${String(index).padStart(2, '0')}`,
      modelName: `Model ${String(index).padStart(2, '0')}`,
    }))
    const instance = render(createElement(App, appProps({
      store,
      commands: { descriptors, subscribe: () => unsubscribe, setAgent: noop },
      skills: { rows: skills, subscribe: () => unsubscribe, setAgent: noop },
      dispatch: (text: string) => {
        dispatched = text
      },
      loadModels: async () => ({ rows: models, failures: [] }),
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      stdin.write('draft')
      await wait()
      expect(output).toContain('draft')
      expect(output).toContain(`DeepSeek Harness · v${DSH_CODE_VERSION}`)
      expect(output).toContain('Into the Unknown  探索未至之境')

      for (const columns of [72, 140, 84]) {
        output = ''
        stdout.columns = columns
        stdout.emit('resize')
        await wait()
        expect(output.match(/\x1b\[r\x1b\[0m\x1b\[H\x1b\[2J\x1b\[3J\x1b\[H/g)).toHaveLength(1)
        const rebuilt = output.slice(output.lastIndexOf(resizeClear) + resizeClear.length)
        expect(rebuilt.match(/DeepSeek Harness/g)).toHaveLength(1)
        expect(output.lastIndexOf('draft')).toBeLessThan(output.lastIndexOf('test/model'))
      }

      output = ''
      stdin.write('\x0f')
      await wait()
      expect(output).toContain('history details')
      expect(output).toContain('test/model')
      expect(output).toContain('draft')
      expect(output.lastIndexOf('draft')).toBeLessThan(output.lastIndexOf('test/model'))
      expect(output).not.toContain('\x1b[2J')
      // A roomy panel may spend two of its bounded rows on title/body/footer
      // separation; newline splitting includes the final partial row, the
      // padded composer band (two blank rows), and the second status row.
      expect(output.split('\n').length).toBeLessThanOrEqual(Math.floor(stdout.rows / 2) + 2)

      output = ''
      for (const columns of [96, 68, 120]) {
        stdout.columns = columns
        stdout.emit('resize')
      }
      await wait()
      expect(output.match(/\x1b\[r\x1b\[0m\x1b\[H\x1b\[2J\x1b\[3J\x1b\[H/g)).toHaveLength(1)
      const rebuilt = output.slice(output.lastIndexOf(resizeClear) + resizeClear.length)
      expect(rebuilt.match(/DeepSeek Harness/g)).toHaveLength(1)
      expect(output).toContain('history details')
      expect(output.lastIndexOf('draft')).toBeLessThan(output.lastIndexOf('test/model'))

      output = ''
      stdin.write('\x0f')
      await wait()
      expect(output).not.toContain('\x1b[2J')
      stdin.write('\r')
      await wait()
      expect(dispatched).toBe('draft')

      store.apply({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } as SessionEvent)
      output = ''
      applyStreamDeltas(store, 1, 1, [{ kind: 'reasoning', text: 'thinking\n'.repeat(1_000), time: 2 }])
      await wait()
      expect(output).not.toContain('\x1b[2J')
      expect(output.split('\n').length).toBeLessThan(stdout.rows)

      const callId = 'long-tool' as ToolCallId
      store.apply({
        type: 'tool/call',
        seq: 3,
        time: 3,
        data: { turn: 1, step: 1, callId, name: 'shell_command', arguments: '{}' },
      } as SessionEvent)
      store.apply({
        type: 'tool/result',
        seq: 4,
        time: 4,
        data: {
          turn: 1,
          step: 1,
          message: createToolResultMessage({
            callId,
            content: [{ type: 'text', text: Array.from({ length: 300 }, (_, index) => `tool output ${index}`).join('\n') }],
            isError: false,
          }),
        },
      } as SessionEvent)
      store.apply({
        type: 'turn/end',
        seq: 5,
        time: 5,
        data: { turn: 1, reason: { kind: 'completed' } },
      } as SessionEvent)
      await wait()
      output = ''
      stdin.write('\x0f')
      await wait()
      expect(output).toContain('history details')
      expect(output).toContain('tool output 0')
      expect(output).not.toContain('\x1b[2J')
      expect(output.split('\n').length).toBeLessThanOrEqual(stdout.rows)

      output = ''
      stdin.write('G')
      await wait()
      expect(output).toContain('tool output 299')
      expect(output).not.toContain('\x1b[2J')

      stdin.write('\x0f')
      await wait()
      output = ''
      stdin.write('/help')
      await wait()
      output = ''
      stdin.write('\r')
      await wait()
      expect(output).toContain('/help')
      expect(output).toContain('keys go to /help · esc closes')
      expect(output.lastIndexOf('keys go to /help · esc closes')).toBeLessThan(output.lastIndexOf('test/model'))
      expect(output).not.toContain('\x1b[2J')
      expect(output.split('\n').length).toBeLessThanOrEqual(stdout.rows)

      output = ''
      stdin.write('G')
      await wait()
      expect(output).toContain('/skill-19')
      expect(output).not.toContain('\x1b[2J')

      stdin.write('q')
      await wait()
      stdin.write('/model')
      await wait()
      output = ''
      stdin.write('\r')
      await wait()
      expect(output).toContain('/model')
      expect(output).toContain('keys go to /model · esc closes')
      expect(output.lastIndexOf('keys go to /model · esc closes')).toBeLessThan(output.lastIndexOf('test/model'))
      expect(output).not.toContain('\x1b[2J')

      output = ''
      // Typing filters the directory in place: '99' matches exactly the
      // Model 99 row (id and display name), replacing the old g/G jump.
      stdin.write('99')
      await wait()
      expect(output).toContain("1 of 100 match '99'")
      expect(output).toContain('Model 99')
      expect(output).not.toContain('\x1b[2J')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })
})

describe('bottom-anchored modal viewport', () => {
  it('fills the rows above /help with frozen real history instead of blanks', async () => {
    const harness = createTty(100, 24)
    const store = createTranscriptStore(Array.from({ length: 30 }, (_, index) => ({
      type: 'assistant/message',
      seq: index + 1,
      time: index + 1,
      data: {
        turn: index + 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: `modal-tail-${index}` }],
          source: { provider: 'p', model: 'm' },
        }),
      },
    } as SessionEvent)))
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      harness.output.text = ''
      harness.stdin.write('/help')
      await wait()
      harness.output.text = ''
      harness.stdin.write('\r')
      await wait()
      const visible = harness.output.text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, '')
      expect(visible).toContain('/help')
      expect(visible).toContain('modal-tail-29')
      expect(visible).not.toMatch(/(?:\n[ \t]*){6}/u)
      expect(harness.output.text).not.toContain('\x1b[2J')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})

describe('Ctrl+R reasoning fold', () => {
  it('handles Ctrl+R only while the VS Code terminal reports focus', async () => {
    vi.stubEnv('TERM_PROGRAM', 'vscode')
    vi.stubEnv('VSCODE_INJECTION', '1')
    const harness = createTty(100, 24)
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
      } as SessionEvent,
      {
        type: 'assistant/message',
        seq: 2,
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [
              { type: 'reasoning', text: 'focus-gated reasoning' },
              { type: 'text', text: 'answer' },
            ],
            source: { provider: 'p', model: 'm' },
          }),
        },
      } as SessionEvent,
    ])
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      expect(harness.output.text).toContain('Thinking (')

      harness.output.text = ''
      harness.stdin.write('\x1b[O\x12')
      await wait()
      expect(harness.output.text).not.toContain('focus-gated reasoning')

      harness.output.text = ''
      harness.stdin.write('\x1b[I\x12')
      await wait()
      expect(harness.output.text).toContain('focus-gated reasoning')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
      vi.unstubAllEnvs()
    }
  })

  it('accepts alt+r as a fold alias under the same VS Code focus gate', async () => {
    vi.stubEnv('TERM_PROGRAM', 'vscode')
    vi.stubEnv('VSCODE_INJECTION', '1')
    const harness = createTty(100, 24)
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
      } as SessionEvent,
      {
        type: 'assistant/message',
        seq: 2,
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [
              { type: 'reasoning', text: 'alias-gated reasoning' },
              { type: 'text', text: 'answer' },
            ],
            source: { provider: 'p', model: 'm' },
          }),
        },
      } as SessionEvent,
    ])
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      expect(harness.output.text).toContain('Thinking (')

      // Focus-out + alt+r stays gated exactly like ctrl+r.
      harness.output.text = ''
      harness.stdin.write('\x1b[O\x1br')
      await wait()
      expect(harness.output.text).not.toContain('alias-gated reasoning')

      // Focus-in + alt+r toggles the fold.
      harness.output.text = ''
      harness.stdin.write('\x1b[I\x1br')
      await wait()
      expect(harness.output.text).toContain('alias-gated reasoning')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
      vi.unstubAllEnvs()
    }
  })

  it('paints the collapsed streaming-thinking marker with the deep-diving shimmer', async () => {
    const harness = createTty(100, 24)
    const store = createTranscriptStore()
    const instance = renderApp(harness, appProps({ store }))
    try {
      store.apply({ type: 'request/context', seq: 1, time: 1, data: { provider: 'zai', model: 'glm-5.2', contextWindow: 128_000 } } as SessionEvent)
      store.apply({ type: 'turn/start', seq: 2, time: 2, data: { turn: 1 } } as SessionEvent)
      store.apply({ type: 'step/start', seq: 3, time: 3, data: { turn: 1, step: 1 } } as SessionEvent)
      store.apply({
        type: 'user/message', seq: 4, time: 4,
        data: createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
      } as SessionEvent)
      applyStreamDeltas(store, 1, 1, [{ kind: 'reasoning', text: '**the streaming thought** with `pnpm test`', time: 5 }])
      await wait()
      const plain = harness.output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '')
      expect(plain).toContain('✻ Thinking… (Ctrl/Alt+R to expand)')
      expect(plain).not.toContain('the streaming thought')

      // Once answer text streams, the marker yields the animation (the
      // tick cadence must not race the answer paint) while staying visible;
      // the streaming text itself keeps painting.
      harness.output.text = ''
      applyStreamDeltas(store, 1, 1, [{ kind: 'text', text: 'the answer token', time: 6 }])
      await wait()
      const answering = harness.output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '')
      expect(answering).toContain('the answer token')
      expect(answering).toContain('Thinking… (Ctrl/Alt+R to expand)')

      // Ctrl+R swaps the marker for the live reasoning stream.
      harness.output.text = ''
      harness.stdin.write('\x12')
      await wait()
      const expanded = harness.output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '')
      expect(expanded).toContain('**the streaming thought** with `pnpm test`')
      expect(expanded).not.toContain('Thinking… (Ctrl/Alt+R to expand)')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('replays the fold globally and immediately on a busy-turn toggle', async () => {
    const harness = createTty(100, 30)
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }),
      } as SessionEvent,
      {
        type: 'assistant/message',
        seq: 2,
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [
              { type: 'reasoning', text: 'old settled reasoning' },
              { type: 'text', text: 'old answer' },
            ],
            source: { provider: 'p', model: 'm' },
          }),
        },
      } as SessionEvent,
      { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent,
    ])
    const instance = renderApp(harness, appProps({ store }))
    try {
      await wait()
      expect(harness.output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '')).toContain('Thinking (')

      // A second turn runs; the fold toggles while that turn is busy. The
      // live region flips without a source-backed clear…
      harness.output.text = ''
      store.apply({ type: 'turn/start', seq: 4, time: 4, data: { turn: 2 } } as SessionEvent)
      store.apply({ type: 'step/start', seq: 5, time: 5, data: { turn: 2, step: 1 } } as SessionEvent)
      applyStreamDeltas(store, 2, 1, [{ kind: 'text', text: 'live answer', time: 6 }])
      await wait()
      harness.stdin.write('\x12')
      await wait()
      // The toggle replays IMMEDIATELY even mid-turn: exactly one clear, and
      // the OLD settled entry (already in native scrollback) unifies to the
      // expanded fold right away.
      expect((harness.output.text.match(/\x1b\[2J/gu) ?? []).length).toBe(1)
      expect(harness.output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '')).toContain('old settled reasoning')

      // Turn settlement adds no extra replay; the unified state persists.
      store.apply({ type: 'turn/end', seq: 7, time: 7, data: { turn: 2, reason: { kind: 'completed' } } } as SessionEvent)
      await wait()
      expect((harness.output.text.match(/\x1b\[2J/gu) ?? []).length).toBe(1)
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('repaints the settled fold through one source-backed replay on an idle toggle', async () => {
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
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
      } as SessionEvent,
      {
        type: 'assistant/message',
        seq: 2,
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [
              { type: 'reasoning', text: 'the hidden reasoning trace' },
              { type: 'text', text: 'the visible answer' },
            ],
            source: { provider: 'p', model: 'm' },
          }),
        },
      } as SessionEvent,
    ])
    const instance = render(createElement(App, appProps({
      store,
      workspaceRoot: 'C:\repo\dsh-cli',
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // Settled reasoning collapses behind the fold marker.
      expect(output).toContain('Thinking (')
      expect(output).not.toContain('Ctrl/Alt+R to expand')
      expect(output).not.toContain('the hidden reasoning trace')

      output = ''
      stdin.write('\x12')
      await wait()
      // An idle toggle must be VISIBLE: one source-backed replay repaints the
      // settled transcript with the expanded reasoning, exactly one clear.
      expect(output).toContain('the hidden reasoning trace')
      expect(output.match(/\x1b\[2J/gu)?.length).toBe(1)
      expect(output).toContain('DeepSeek Harness')

      output = ''
      stdin.write('\x12')
      await wait()
      // Toggling back folds again through the same single-replay contract.
      expect(output).toContain('Thinking (')
      expect(output).not.toContain('the hidden reasoning trace')
      expect(output.match(/\x1b\[2J/gu)?.length).toBe(1)
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  })

  it('folds a live-region assistant entry trapped behind a running tool', async () => {
    const { stdin, stdout, output } = createTty(100, 24)
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
        type: 'tool/call',
        seq: 3,
        time: 3,
        data: { turn: 1, step: 1, callId: 'call-trap', name: 'run_code', arguments: '{}' },
      } as SessionEvent,
      {
        type: 'assistant/message',
        seq: 4,
        time: 4,
        data: {
          turn: 1,
          step: 2,
          message: createAssistantMessage({
            content: [
              { type: 'reasoning', text: 'the trapped reasoning trace' },
              { type: 'text', text: 'the trapped answer' },
            ],
            source: { provider: 'p', model: 'm' },
          }),
        },
      } as SessionEvent,
    ])
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
      // The running tool keeps the assembled assistant entry in the live
      // region, which must still respect the default fold: marker only.
      let plain = output.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      expect(plain).toContain('Thinking (')
      expect(plain).not.toContain('the trapped reasoning trace')
      expect(plain).toContain('the trapped answer')

      output.text = ''
      stdin.write('\x12')
      await wait()
      // Ctrl+R replays globally and immediately: the trapped live entry AND
      // the settled scrollback unify with one clear.
      plain = output.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      expect(plain).toContain('the trapped reasoning trace')
      expect((output.text.match(/\x1b\[2J/gu) ?? []).length).toBe(1)

      output.text = ''
      stdin.write('\x12')
      await wait()
      plain = output.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      expect(plain).toContain('Thinking (')
      expect(plain).not.toContain('the trapped reasoning trace')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  }, 20_000)

  it('replays the mid-stream fold toggle globally and settles without extra clears', async () => {
    const { stdin, stdout, output } = createTty(100, 24)
    const store = createTranscriptStore([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
      } as SessionEvent,
      {
        type: 'assistant/message',
        seq: 2,
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [
              { type: 'reasoning', text: 'the hidden reasoning trace' },
              { type: 'text', text: 'the visible answer' },
            ],
            source: { provider: 'p', model: 'm' },
          }),
        },
      } as SessionEvent,
    ])
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
      // Start a fresh reasoning stream over the settled history.
      store.apply({ type: 'turn/start', seq: 3, time: 3, data: { turn: 2 } } as SessionEvent)
      store.apply({ type: 'step/start', seq: 4, time: 4, data: { turn: 2, step: 1 } } as SessionEvent)
      applyStreamDeltas(store, 2, 1, Array.from({ length: 10 }, (_, index) => ({
        kind: 'reasoning' as const, text: `stream-${index} `, time: 5 + index,
      })))
      await wait()
      let plain = output.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      expect(plain).toContain('Thinking')

      // Ctrl+R mid-stream replays globally: expanded reasoning appears with
      // exactly one clear.
      output.text = ''
      stdin.write('\x12')
      await wait()
      plain = output.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      expect(plain).not.toContain('Thinking')
      expect(plain).toContain('stream-9')
      expect((output.text.match(/\x1b\[2J/gu) ?? []).length).toBe(1)

      // The assembled message ends the stream WITHOUT a second clear; the
      // new settled entry still paints the assembled trace and answer.
      store.apply({
        type: 'assistant/message',
        seq: 200,
        time: 30,
        data: {
          turn: 2,
          step: 1,
          message: createAssistantMessage({
            content: [
              { type: 'reasoning', text: 'the assembled trace' },
              { type: 'text', text: 'the assembled answer' },
            ],
            source: { provider: 'p', model: 'm' },
          }),
        },
      } as SessionEvent)
      await wait()
      expect((output.text.match(/\x1b\[2J/gu) ?? []).length).toBe(1)
      expect(output.text).toContain('the assembled trace')
      expect(output.text).toContain('the assembled answer')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  }, 20_000)

  it('keeps expanded reasoning beside the streaming answer without a clear', async () => {
    const { stdin, stdout, output } = createTty(100, 24)
    const store = createTranscriptStore()
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
      // Expand before the stream starts; the toggle itself stays clear-free.
      stdin.write('\x12')
      await wait()
      output.text = ''
      // A fresh reasoning stream.
      store.apply({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } as SessionEvent)
      store.apply({ type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } } as SessionEvent)
      applyStreamDeltas(store, 1, 1, Array.from({ length: 10 }, (_, index) => ({
        kind: 'reasoning' as const, text: `stream-${index} `, time: 3 + index,
      })))
      await wait()
      // The first text delta keeps reasoning and answer together in the live
      // region. Nothing is promoted into Static before assistant/message.
      applyStreamDeltas(store, 1, 1, [{ kind: 'text', text: 'the visible answer', time: 13 }])
      await wait()
      const plain = output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      expect(store.getView().entries).toEqual([])
      expect(store.getView().streamingReasoning).toContain('stream-9')
      expect(output.text).not.toContain('\x1b[2J')
      expect(plain).toContain('stream-0')
      expect(plain).toContain('stream-9')
      expect(plain).toContain('the visible answer')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  }, 20_000)
})
describe('light theme rendering', () => {
  // The active palette is process-global: the switch must survive into the
  // Ink paint path (statusToneProps and every direct token call site read
  // getPalette()), and the test must restore dark for its siblings.
  it('paints theme-aware tokens after a light switch', async () => {
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
    const noop = (): void => {}
    // vitest runs colorless (chalk level 0): force level 3 like the other
    // color-asserting App tests, and restore both chalk and the theme after.
    const originalChalkLevel = chalk.level
    chalk.level = 3
    setTheme('light')
    const instance = render(createElement(App, appProps({
      store: createTranscriptStore(),
      subagents: { subscribe: () => noop, getSnapshot: () => EMPTY_AGENTS, getTotalSeen: () => 0 },
      approval: { subscribe: () => noop, getSnapshot: () => approvalSnapshot },
      questions: {
        subscribe: () => noop,
        getSnapshot: () => questionSnapshot,
        submit: noop,
        cancel: noop,
      },
      commands: { descriptors: [], subscribe: () => noop, setAgent: noop },
      skills: { rows: [], subscribe: () => noop, setAgent: noop },
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    setTheme('light')
    try {
      await wait()
      // The model tone paints the LIGHT code cyan (14,116,144), not the dark
      // value (125,211,252): the mapping layer follows the palette.
      expect(output).toContain('38;2;14;116;144m')
      expect(output).not.toContain('38;2;125;211;252m')
      // The prompt marker and header keep their theme-aware brand blue.
      expect(output).toContain('38;2;65;118;230m')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
      chalk.level = originalChalkLevel
      setTheme('dark')
    }
  })
})
describe('dsh kernel header line', () => {
  it('prepends the resolved kernel version above the title without extra chrome', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-kernel-header-'))
    const hostDir = join(root, '@deepseek-ai', 'dsh')
    mkdirSync(join(hostDir, 'lib'), { recursive: true })
    writeFileSync(join(hostDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' }))
    const previousArgv = process.argv[1]
    process.argv[1] = join(hostDir, 'lib', 'bin.js')
    _resetDshKernelVersionForTests()
    const harness = createTty(120, 30)
    try {
      const instance = renderApp(harness, appProps())
      try {
        await wait()
        const text = harness.output.text
        expect(text).toContain('dsh-v0.1.1-rc.2')
        expect(text.indexOf('dsh-v0.1.1-rc.2')).toBeLessThan(text.indexOf(`DeepSeek Harness · v${DSH_CODE_VERSION}`))
        expect(text).toContain('Into the Unknown  探索未至之境')
      } finally {
        instance.unmount()
      }
    } finally {
      harness.stdin.destroy()
      harness.stdout.destroy()
      process.argv[1] = previousArgv
      _resetDshKernelVersionForTests()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the historical three-line lockup when no host manifest resolves', async () => {
    const harness = createTty(120, 30)
    try {
      const instance = renderApp(harness, appProps())
      try {
        await wait()
        expect(harness.output.text).not.toContain('dsh-v')
        expect(harness.output.text).toContain(`DeepSeek Harness · v${DSH_CODE_VERSION}`)
      } finally {
        instance.unmount()
      }
    } finally {
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})
