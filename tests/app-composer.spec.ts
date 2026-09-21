/** Composer input: editing, completion, paste, attachments, and recall. */

import { describe, expect, it, vi } from 'vitest'
import {
  type SessionEvent,
  type ImageBlock,
  App,
  AttachmentId,
  DARK_PALETTE,
  appProps,
  chalk,
  createElement,
  createSplitStdin,
  createTranscriptStore,
  createTty,
  createUserMessage,
  noop,
  render,
  renderApp,
  stepCompletionIndex,
  unsubscribe,
  wait,
} from './helpers/app-mount.ts'

describe('mention completion scheduling', () => {
  it('debounces path lookups, keeps the previous rows, and ignores stale results', async () => {
    const harness = createTty(120, 24)
    const calls: { query: string; resolve: (rows: readonly { label: string; description: string; kind: 'file' | 'directory' }[]) => void }[] = []
    const loadMentions = vi.fn((query: string) => new Promise<readonly { label: string; description: string; kind: 'file' | 'directory' }[]>(resolve => {
      calls.push({ query, resolve })
    }))
    const instance = renderApp(harness, appProps({ loadMentions }))

    try {
      await wait()
      harness.stdin.write('@a')
      await wait(80)
      expect(calls.map(call => call.query)).toEqual(['a'])

      harness.stdin.write('b')
      await wait(80)
      expect(calls.map(call => call.query)).toEqual(['a', 'ab'])

      calls[0].resolve([{ label: 'old.ts', description: 'File', kind: 'file' }])
      await wait()
      expect(harness.output.text).not.toContain('@old.ts')

      calls[1].resolve([{ label: 'new.ts', description: 'File', kind: 'file' }])
      await wait()
      expect(harness.output.text).toContain('@new.ts')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})
describe('composer image attachments', () => {
  it('turns @ images and dragged paths into durable image blocks without a new slash command', async () => {
    const harness = createTty(120, 24)
    const dispatch = vi.fn()
    const inspectImages = vi.fn(async (paths: readonly string[]) => paths.map((path) => ({
      path,
      name: path.split(/[\\/]/u).at(-1) ?? 'image.png',
      mediaType: path.endsWith('.webp') ? 'image/webp' as const : 'image/png' as const,
      bytes: 8,
    })))
    const prepareImages = vi.fn(async (paths: readonly string[]) => paths.map((path, index) => ({
      type: 'image' as const,
      attachment: {
        attachmentId: AttachmentId(`sha-${index}`),
        mediaType: path.endsWith('.webp') ? 'image/webp' as const : 'image/png' as const,
        bytes: 8,
        width: 1,
        height: 1,
        name: path.split(/[\\/]/u).at(-1),
      },
    })))
    const instance = renderApp(harness, appProps({
      dispatch,
      inspectImages,
      prepareImages,
      loadMentions: async () => [{ label: 'docs/pic.png', description: 'File', kind: 'file', path: 'C:\\repo\\docs\\pic.png' }],
    }))
    try {
      await wait()
      harness.stdin.write('@pic')
      await wait()
      harness.stdin.write('\t')
      await wait(180)
      expect(harness.output.text).toContain('@pic.png')
      harness.stdin.write('\r')
      await wait(180)
      expect(prepareImages).toHaveBeenCalledWith(['C:\\repo\\docs\\pic.png'], expect.anything())
      expect(dispatch).toHaveBeenCalledWith('@pic.png', [expect.objectContaining({ type: 'image' })], 'session-12345678')

      harness.stdin.write('"C:\\outside\\a.png" "D:\\b.webp"')
      await wait(180)
      expect(harness.output.text).toContain('[image: a.png]')
      expect(harness.output.text).toContain('[image: b.webp]')
      harness.stdin.write('\r')
      await wait(180)
      expect(prepareImages).toHaveBeenLastCalledWith(['C:\\outside\\a.png', 'D:\\b.webp'], expect.anything())
      expect(dispatch).toHaveBeenLastCalledWith('[image: a.png] [image: b.webp]', expect.arrayContaining([
        expect.objectContaining({ type: 'image' }),
        expect.objectContaining({ type: 'image' }),
      ]), 'session-12345678')
    } finally {
      instance.unmount()
    }
  })

  it('reads a dragged path out of a real bracketed paste, tail escape and all', async () => {
    const harness = createTty(120, 24)
    const dispatch = vi.fn()
    const inspectImages = vi.fn(async (paths: readonly string[]) => paths.map(path => ({
      path,
      name: path.split(/[\\/]/u).at(-1) ?? 'shot.png',
      mediaType: 'image/png' as const,
      bytes: 8,
    })))
    const prepareImages = vi.fn(async (paths: readonly string[]) => paths.map((path, index) => ({
      type: 'image' as const,
      attachment: {
        attachmentId: AttachmentId(`dragged-${index}`),
        mediaType: 'image/png' as const,
        bytes: 8,
        width: 1,
        height: 1,
        name: path.split(/[\\/]/u).at(-1),
      },
    })))
    const instance = renderApp(harness, appProps({ dispatch, inspectImages, prepareImages }))
    try {
      await wait()
      // A drag into the terminal arrives as one bracketed paste, and Ink strips
      // only the LEADING escape: the tail marker still carries its own ESC, so
      // the payload has to be cleaned before the path is parsed.
      harness.stdin.write('\x1b[200~/tmp/shot.png\x1b[201~')
      await wait(180)
      expect(harness.output.text).toContain('[image: shot.png]')
      harness.stdin.write('\r')
      await wait(180)
      expect(prepareImages).toHaveBeenCalledWith(['/tmp/shot.png'], expect.anything())
      expect(dispatch).toHaveBeenCalledWith('[image: shot.png]', [expect.objectContaining({ type: 'image' })], 'session-12345678')
    } finally {
      instance.unmount()
    }
  })

  it('attaches a spaced CJK screenshot path without looping', async () => {
    const harness = createTty(120, 24)
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    const path = '/Users/nonlinear/Desktop/截屏2026-09-15 18.41.07.png'
    const inspectImages = vi.fn(async (paths: readonly string[]) => paths.map(item => ({
      path: item,
      name: item.split('/').at(-1) ?? 'shot.png',
      mediaType: 'image/png' as const,
      bytes: 8,
    })))
    const instance = renderApp(harness, appProps({ inspectImages }))
    try {
      await wait()
      harness.stdin.write(`\x1b[200~'${path}'\x1b[201~`)
      await wait(180)
      expect(inspectImages).toHaveBeenCalledWith([path])
      expect(harness.output.text).toContain('[image: 截屏2026-09-15 18.41.07.png]')
      expect(harness.output.text).not.toContain(`'${path}'`)
      expect(errors.join('\n')).not.toContain('Maximum update depth exceeded')
    } finally {
      spy.mockRestore()
      instance.unmount()
    }
  })

  it('attaches a file drag through the production stdin splitter like a copied path', async () => {
    const harness = createTty(120, 24)
    const path = '/Users/nonlinear/Desktop/截屏2026-09-15 18.41.07.png'
    const inspectImages = vi.fn(async (paths: readonly string[]) => paths.map(item => ({
      path: item,
      name: item.split('/').at(-1) ?? 'shot.png',
      mediaType: 'image/png' as const,
      bytes: 8,
    })))
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    const { stdin, dispose } = createSplitStdin(harness.stdin)
    const instance = render(createElement(App, appProps({ inspectImages })), {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: harness.stdout,
      stderr: harness.stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      await wait()
      // Production: no 200~/201~. The splitter used to emit one unit per
      // character (a long path nested tens of setStates → Maximum update depth).
      harness.stdin.write(`'${path}'`)
      await wait(180)
      expect(inspectImages).toHaveBeenCalledWith([path])
      expect(harness.output.text).toContain('[image: 截屏2026-09-15 18.41.07.png]')
      expect(harness.output.text).not.toContain(`'${path}'`)
      expect(errors.join('\n')).not.toContain('Maximum update depth exceeded')
    } finally {
      spy.mockRestore()
      instance.unmount()
      dispose()
    }
  })

  it('submits a draft ending in an unmatched @token instead of swallowing Enter', async () => {
    const harness = createTty(120, 24)
    const dispatch = vi.fn()
    const instance = renderApp(harness, appProps({
      dispatch,
      loadMentions: async () => [],
    }))
    try {
      await wait()
      // The mention menu opens on the trailing token even with zero matches;
      // Enter has nothing to accept, so it must submit the line.
      harness.stdin.write('hello @zzz')
      await wait(180)
      harness.stdin.write('\r')
      await wait(180)
      expect(dispatch.mock.calls.at(-1)?.[0]).toBe('hello @zzz')
    } finally {
      instance.unmount()
    }
  })

  it('submits a mention token that already spells the only candidate', async () => {
    const harness = createTty(120, 24)
    const dispatch = vi.fn()
    const instance = renderApp(harness, appProps({
      dispatch,
      loadMentions: async () => [{ label: 'src/app.ts', description: 'File', kind: 'file', path: 'src/app.ts' }],
    }))
    try {
      await wait()
      harness.stdin.write('@src/app.ts')
      await wait(240)
      harness.stdin.write('\r')
      await wait(180)
      // Accepting would re-insert the same token; Enter submits instead.
      expect(dispatch).toHaveBeenCalled()
      expect(dispatch.mock.calls.at(-1)?.[0]).toBe('@src/app.ts')
    } finally {
      instance.unmount()
    }
  })

  it('turns a dropped mixed image/file list into durable image and file blocks', async () => {
    const harness = createTty(120, 24)
    const dispatch = vi.fn()
    const inspectImages = vi.fn(async (paths: readonly string[]) => paths.map((path) => ({
      path,
      name: path.split(/[\\/]/u).at(-1) ?? 'shot.png',
      mediaType: 'image/png' as const,
      bytes: 8,
    })))
    const prepareImages = vi.fn(async (paths: readonly string[]) => paths.map((path, index) => ({
      type: 'image' as const,
      attachment: { attachmentId: AttachmentId(`img-${index}`), mediaType: 'image/png' as const, bytes: 8, width: 1, height: 1, name: path.split(/[\\/]/u).at(-1) },
    })))
    const inspectFiles = vi.fn(async (paths: readonly string[]) => paths.map((path) => ({
      path, name: path.split(/[\\/]/u).at(-1) ?? 'notes.txt', bytes: 10,
    })))
    const prepareFiles = vi.fn(async (paths: readonly string[]) => paths.map((path, index) => ({
      type: 'file' as const,
      attachment: { attachmentId: AttachmentId(`file-${index}`), name: path.split(/[\\/]/u).at(-1) ?? 'notes.txt', bytes: 10 },
    })))
    const instance = renderApp(harness, appProps({ dispatch, inspectImages, prepareImages, inspectFiles, prepareFiles }))
    try {
      await wait()
      // One paste carrying an image and a document: both register markers.
      harness.stdin.write('"C:\\repo\\shot.png" "C:\\repo\\report.pdf"')
      await wait(180)
      expect(harness.output.text).toContain('[image: shot.png]')
      expect(harness.output.text).toContain('[file: report.pdf]')
      harness.stdin.write('\r')
      await wait(180)
      expect(prepareFiles).toHaveBeenCalledWith(['C:\\repo\\report.pdf'], expect.anything())
      expect(dispatch).toHaveBeenLastCalledWith('[image: shot.png] [file: report.pdf]', expect.arrayContaining([
        expect.objectContaining({ type: 'image' }),
        expect.objectContaining({ type: 'file', attachment: expect.objectContaining({ name: 'report.pdf' }) }),
      ]), 'session-12345678')
    } finally {
      instance.unmount()
    }
  })

  it('warns but allows a text-only model when the session contains image history', async () => {
    const harness = createTty(110, 24)
    const store = createTranscriptStore()
    store.apply({
      type: 'user/message',
      seq: 1,
      time: 1,
      data: createUserMessage({
        content: [{
          type: 'image',
          attachment: { attachmentId: AttachmentId('sha-1'), mediaType: 'image/png', bytes: 8, width: 1, height: 1, name: 'pixel.png' },
        }],
        source: { kind: 'user' },
      }),
    } as unknown as SessionEvent)
    const selectModel = vi.fn(() => 'acme/text-only')
    const instance = renderApp(harness, appProps({
      store,
      loadModels: async () => ({
        rows: [{ provider: 'acme', providerName: 'Acme', model: 'text-only', modelName: 'Text only', inputModalities: ['text'] }],
        failures: [],
      }),
      selectModel,
    }))
    try {
      await wait()
      harness.stdin.write('/model')
      await wait()
      harness.stdin.write('\r')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(selectModel).toHaveBeenCalled()
      expect(harness.output.text).toContain('image history will be sent as text placeholders')
    } finally {
      instance.unmount()
    }
  })

  it('opens the /update panel with the aligned plan and closes on escape', async () => {
    const harness = createTty(120, 24)
    const instance = renderApp(harness, appProps({
      probeUpdate: () => Promise.resolve({
        code: { running: '1.0.6', latest: '1.0.7' },
        host: { installed: '0.1.5-rc.1', targetLine: '0.1.5-rc.2' },
        profile: { spec: '1.0.6', mounted: '1.0.6', localCheckout: false },
        plan: { dshSpec: '@deepseek-ai/dsh@0.1.5-rc.2', codeSpec: 'dsh-code@1.0.7', pluginSpecs: [] },
        blockers: { registry: null, downgrade: false, localCheckout: null },
        upToDate: false,
      }),
      applyUpdate: () => Promise.resolve(0),
    }))
    try {
      await wait()
      harness.stdin.write('/update')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('dsh-code    1.0.6 → 1.0.7')
      expect(harness.output.text).toContain('enter update')
      // The panel owns the keys while open: escape closes it and the
      // panel footer leaves the last frame.
      harness.output.text = ''
      harness.stdin.write('\x1b')
      await wait()
      expect(harness.output.text).not.toContain('enter update')
    } finally {
      instance.unmount()
    }
  })

  it('refuses extra tokens on a bare local command instead of sending them to the model', async () => {
    const harness = createTty(120, 24)
    const dispatch = vi.fn()
    const instance = renderApp(harness, appProps({ dispatch }))
    try {
      await wait()
      harness.stdin.write('/queue clear')
      await wait(180)
      harness.stdin.write('\r')
      await wait(180)
      expect(dispatch).not.toHaveBeenCalled()
      expect(harness.output.text).toContain('usage: /queue')
    } finally {
      instance.unmount()
    }
  })

  it('opens the /schedule panel from the command line and folds live schedule events', async () => {
    const harness = createTty(120, 24)
    const store = createTranscriptStore()
    const instance = renderApp(harness, appProps({ store }))
    try {
      store.apply({
        type: 'schedule/change',
        seq: 1,
        time: 1,
        data: { operation: 'create', schedule: { id: 'schedule-1', kind: 'every', prompt: 'check the build', everySeconds: 1800, scheduledAt: new Date(Date.now() + 90_000).toISOString() } },
      } as never)
      await wait()
      harness.stdin.write('/schedule')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('check the build')
      expect(harness.output.text).toContain('Every 30m')
      // Height budget is proven by the SchedulePanel TTY suite; here the
      // accumulated multi-frame output would miscount.
      harness.output.text = ''
      harness.stdin.write('\x1b')
      await wait()
      expect(harness.output.text).not.toContain('Every 30m')
    } finally {
      instance.unmount()
    }
  })

  it('preserves a moved cursor when an async image mention resolves', async () => {
    const harness = createTty(120, 24)
    const dispatch = vi.fn()
    let resolveInspection!: (value: readonly { path: string; name: string; mediaType: 'image/png'; bytes: number }[]) => void
    const inspectImages = vi.fn(() => new Promise<readonly { path: string; name: string; mediaType: 'image/png'; bytes: number }[]>(resolve => {
      resolveInspection = resolve
    }))
    const instance = renderApp(harness, appProps({
      dispatch,
      inspectImages,
      prepareImages: async () => [],
      loadMentions: async () => [{ label: 'docs/pic.png', description: 'File', kind: 'file', path: 'C:\\repo\\docs\\pic.png' }],
    }))
    try {
      await wait()
      harness.stdin.write('@pic')
      await wait()
      harness.stdin.write('\t')
      await wait()
      harness.stdin.write(' later')
      await wait()
      resolveInspection([{ path: 'C:\\repo\\docs\\pic.png', name: 'pic.png', mediaType: 'image/png', bytes: 8 }])
      await wait()
      harness.stdin.write('X')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(dispatch).toHaveBeenCalledWith('@pic.png laterX', [], 'session-12345678')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('anchors a dropped image at the drop-time cursor instead of the resolution-time cursor', async () => {
    const harness = createTty(120, 24)
    const dispatch = vi.fn()
    let resolveInspection!: (value: readonly { path: string; name: string; mediaType: 'image/png'; bytes: number }[]) => void
    const inspectImages = vi.fn(() => new Promise<readonly { path: string; name: string; mediaType: 'image/png'; bytes: number }[]>(resolve => {
      resolveInspection = resolve
    }))
    const instance = renderApp(harness, appProps({ dispatch, inspectImages, prepareImages: async () => [] }))
    try {
      await wait()
      harness.stdin.write('AB')
      await wait()
      harness.stdin.write('\x1b[D')
      await wait()
      harness.stdin.write('"C:\\outside\\a.png"')
      await wait()
      harness.stdin.write('\x1b[C')
      await wait()
      resolveInspection([{ path: 'C:\\outside\\a.png', name: 'a.png', mediaType: 'image/png', bytes: 8 }])
      await wait()
      harness.stdin.write('X')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(dispatch).toHaveBeenCalledWith('A [image: a.png] BX', [], 'session-12345678')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('tags an attachment delivery with the composing session for the runner-side stale guard', async () => {
    // Ink unmounts asynchronously, so a prepare resolving after the app went
    // away still reaches dispatch on the microtask timeline — the delivery
    // must carry the composing session's key (the runner drops it when the
    // active session moved on; see submissionBelongsToSession).
    const harness = createTty(120, 24)
    const dispatch = vi.fn()
    let resolvePreparation!: (value: readonly ImageBlock[]) => void
    const prepareImages = vi.fn((_paths: readonly string[], _signal?: AbortSignal) => new Promise<readonly ImageBlock[]>(resolve => {
      resolvePreparation = resolve
    }))
    const instance = renderApp(harness, appProps({
      dispatch,
      inspectImages: async paths => paths.map(path => ({ path, name: 'a.png', mediaType: 'image/png', bytes: 8 })),
      prepareImages,
    }))
    try {
      await wait()
      harness.stdin.write('"C:\\slow\\a.png"')
      await wait(150)
      harness.stdin.write('\r')
      await wait()
      expect(prepareImages).toHaveBeenCalledOnce()
      // The composer goes away mid-prepare (the real trigger is a queued
      // session switch remounting by session id).
      instance.unmount()
      resolvePreparation([])
      await wait(80)
      expect(dispatch).toHaveBeenCalledWith('[image: a.png]', [], 'session-12345678')
    } finally {
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('freezes without a caret while preparing images and restores the draft on cancellation', async () => {
    const harness = createTty(120, 24)
    const dispatch = vi.fn()
    let resolvePreparation!: (value: readonly ImageBlock[]) => void
    const prepareImages = vi.fn((_paths: readonly string[], _signal?: AbortSignal) => new Promise<readonly ImageBlock[]>(resolve => {
      resolvePreparation = resolve
    }))
    const instance = renderApp(harness, appProps({
      dispatch,
      inspectImages: async paths => paths.map(path => ({ path, name: 'a.png', mediaType: 'image/png', bytes: 8 })),
      prepareImages,
    }))
    try {
      await wait()
      harness.stdin.write('"C:\\outside\\a.png"')
      await wait()
      harness.output.text = ''
      harness.stdin.write('\r')
      await wait()
      expect(harness.output.text).toContain('processing 1 attachment')
      expect(harness.output.text).not.toContain('\x1b[7m')
      const signal = prepareImages.mock.calls[0]?.[1]
      expect(signal?.aborted).toBe(false)

      harness.stdin.write('\x1b')
      await wait()
      expect(signal?.aborted).toBe(true)
      expect(harness.output.text).toContain('[image: a.png]')
      resolvePreparation([])
      await wait()
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})
describe('multiline composer', () => {
  it('inserts newlines for the modified-Enter family and submits only on plain Enter', async () => {
    const harness = createTty(100, 24)
    const dispatched: string[] = []
    const instance = renderApp(harness, appProps({
      dispatch: text => { dispatched.push(text) },
    }))
    try {
      await wait()
      harness.stdin.write('first')
      await wait()
      // Kitty Shift+Enter (13;2) and Ctrl+Enter (13;5) normalize to the LF
      // byte; Alt+Enter keeps its escape form with meta — all three insert a
      // newline instead of submitting.
      harness.stdin.write('\x1b[13;2u')
      await wait()
      harness.stdin.write('second')
      await wait()
      harness.stdin.write('\x1b[13;5u')
      await wait()
      harness.stdin.write('third')
      await wait()
      harness.stdin.write('\x1b\r')
      await wait()
      harness.stdin.write('fourth')
      await wait()
      // Ctrl+J is the legacy-terminal newline key (bare LF, no protocol).
      harness.stdin.write('\n')
      await wait()
      harness.stdin.write('fifth')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(dispatched).toEqual(['first\nsecond\nthird\nfourth\nfifth'])
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('moves by word and line with Codex editor keys and yanks kills', async () => {
    const harness = createTty(60, 24)
    let dispatched = ''
    const instance = renderApp(harness, appProps({
      dispatch: text => { dispatched = text },
    }))
    try {
      await wait()
      harness.stdin.write('hello world')
      await wait()
      harness.stdin.write('[1;5D') // Ctrl+Left: word left
      await wait()
      harness.stdin.write('b') // Alt+B: word left again (to start)
      await wait()
      harness.stdin.write(String.fromCharCode(11)) // Ctrl+K kills to line end
      await wait()
      harness.stdin.write(String.fromCharCode(25)) // Ctrl+Y yanks the kill back
      await wait()
      harness.stdin.write('[H') // Home
      await wait()
      harness.stdin.write('[3~') // Delete forward removes 'h'
      await wait()
      harness.stdin.write(String.fromCharCode(13))
      await wait()
      expect(dispatched).toBe('ello world')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('hard-wraps a long CJK draft into multiple composer rows before submission', async () => {
    const harness = createTty(40, 30)
    let dispatched = ''
    const instance = renderApp(harness, appProps({
      dispatch: text => { dispatched = text },
    }))
    try {
      await wait()
      const draft = '一二三四五六七八九十'.repeat(2)
      harness.stdin.write(draft)
      await wait()
      harness.stdin.write(String.fromCharCode(13))
      await wait()
      expect(dispatched).toBe(draft)
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('keeps Up as caret movement inside a multiline draft instead of history recall', async () => {
    const harness = createTty(80, 24)
    let dispatched = ''
    const instance = renderApp(harness, appProps({
      dispatch: text => { dispatched = text },
      history: ['older entry'],
    }))
    try {
      await wait()
      harness.stdin.write('[200~first')
      await wait()
      harness.stdin.write('\r')
      await wait()
      harness.stdin.write('second[201~')
      await wait()
      harness.stdin.write('[A') // Up: caret to line 1 end, not recall
      await wait()
      harness.stdin.write('X')
      await wait()
      harness.stdin.write(String.fromCharCode(13))
      await wait()
      expect(dispatched).toBe('firstX\nsecond')
      expect(dispatched).not.toContain('older entry')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('renders exactly one caret and keeps movement responsive through blink frames', async () => {
    const harness = createTty(80, 24)
    let dispatched = ''
    const instance = renderApp(harness, appProps({ dispatch: text => { dispatched = text } }))
    try {
      await wait()
      harness.output.text = ''
      harness.stdin.write('[200~first\rsecond[201~')
      await wait()
      const plain = harness.output.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '')
      expect(plain).toContain('❯ first')
      expect(plain).not.toContain('❯  first')

      await new Promise(resolve => setTimeout(resolve, 560))
      harness.stdin.write('\x1b[D')
      await wait()
      harness.stdin.write('X')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(dispatched).toBe('first\nseconXd')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('keeps the functional input caret alive when decorative animations are off', async () => {
    const originalChalkLevel = chalk.level
    chalk.level = 1
    const harness = createTty(80, 24)
    const instance = renderApp(harness, appProps({ animations: false }))
    try {
      await wait()
      harness.stdin.write('x')
      await wait()
      harness.output.text = ''
      await new Promise(resolve => setTimeout(resolve, 600))
      expect(harness.output.text.length).toBeGreaterThan(0)
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
      chalk.level = originalChalkLevel
    }
  })

  it('crosses history from a recalled multiline entry; Left still edits inside', async () => {
    const harness = createTty(80, 24)
    let dispatched = ''
    const instance = renderApp(harness, appProps({
      history: ['older entry', 'first\nsecond'],
      dispatch: text => { dispatched = text },
    }))
    try {
      await wait()
      // Recall the newest multiline entry: its caret rests on the text
      // end, so the next Up crosses to the older entry (either text edge
      // switches history).
      harness.stdin.write('\x1b[A')
      await wait()
      harness.stdin.write('\x1b[A')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(dispatched).toBe('older entry')
      // Recall again (the submitted older entry is now the newest), cross
      // to the multiline entry, then step the caret inside with Left: an
      // interior caret belongs to ordinary editing, where Up/Down move
      // through the entry's rows.
      harness.stdin.write('\x1b[A')
      await wait()
      harness.stdin.write('\x1b[A')
      await wait()
      harness.stdin.write('\x1b[D')
      await wait()
      harness.stdin.write('X')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(dispatched).toBe('first\nseconXd')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('applies repeated Backspace actions from one stdin chunk in order', async () => {
    const harness = createTty(80, 24)
    let dispatched = ''
    const instance = renderApp(harness, appProps({ dispatch: text => { dispatched = text } }))
    try {
      await wait()
      harness.stdin.write('abcd')
      await wait()
      harness.stdin.write('\x7f\x7f')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(dispatched).toBe('ab')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('resets the preferred vertical column after terminal width changes', async () => {
    const harness = createTty(40, 30)
    let dispatched = ''
    const instance = renderApp(harness, appProps({ dispatch: text => { dispatched = text } }))
    try {
      await wait()
      harness.stdin.write('[200~abcdefghij\rxy\rabcdefghij[201~')
      await wait()
      harness.stdin.write('\x1b[A') // short middle line; remembers column 10
      await wait()
      Object.assign(harness.stdout, { columns: 20 })
      harness.stdout.emit('resize')
      await new Promise(resolve => setTimeout(resolve, 220))
      harness.stdin.write('\x1b[B') // must use the current column 2 after resize
      await wait()
      harness.stdin.write('X')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(dispatched).toBe('abcdefghij\nxy\nabXcdefghij')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})
describe('bracketed paste safety', () => {
  it('recovers Enter submission after a lost paste end marker', async () => {
    const { stdin, stdout, output } = createTty(100, 24)
    const store = createTranscriptStore()
    const dispatched: string[] = []
    const instance = render(createElement(App, appProps({
      store,
      dispatch: text => {
        dispatched.push(text)
      },
    })), {
      stdin,
      stdout,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      await wait()
      // A paste start marker arrives (ESC already stripped by Ink) but its
      // end marker never does.
      stdin.write('[200~hi')
      await wait()
      // While the paste is "open", Enter inserts a newline rather than submit.
      stdin.write('\r')
      await wait()
      expect(dispatched).toEqual([])

      // Past the lost-marker safety window the flag resets: Enter submits.
      await new Promise(resolve => setTimeout(resolve, 1_200))
      stdin.write('\r')
      await wait()
      expect(dispatched).toEqual(['hi'])
      expect(output.text).not.toContain('[200~')
    } finally {
      instance.unmount()
      stdin.destroy()
      stdout.destroy()
    }
  }, 20_000)
})
describe('completion menu', () => {
  it('accepts a slash command on Tab and keeps the draft editable immediately afterward', async () => {
    const harness = createTty(100, 24)
    const dispatch = vi.fn()
    const instance = renderApp(harness, appProps({
      dispatch,
      commands: {
        descriptors: [{ name: 'command-00', description: 'registry command' }],
        subscribe: () => unsubscribe,
        setAgent: noop,
      },
    }))
    try {
      await wait()
      harness.stdin.write('/command-0')
      await wait()
      // A terminal may coalesce Tab and the first argument into one read.
      harness.stdin.write('\targ')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(dispatch).toHaveBeenCalledWith('/command-00 arg')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('accepts Kitty CSI-u Tab without leaking the sequence or locking the editor', async () => {
    const harness = createTty(100, 24)
    const dispatch = vi.fn()
    const instance = renderApp(harness, appProps({
      dispatch,
      commands: {
        descriptors: [{ name: 'command-00', description: 'registry command' }],
        subscribe: () => unsubscribe,
        setAgent: noop,
      },
    }))
    try {
      await wait()
      harness.stdin.write('/command-0')
      await wait()
      // The same coalescing can happen after Kitty CSI-u normalization.
      harness.stdin.write('\x1b[9uarg')
      await wait()
      harness.stdin.write('\r')
      await wait()
      expect(dispatch).toHaveBeenCalledWith('/command-00 arg')
      expect(harness.output.text).not.toContain('[9u')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('accepts the highlighted candidate on Enter (Codex list parity with Tab)', async () => {
    const harness = createTty(100, 24)
    const dispatch = vi.fn()
    const instance = renderApp(harness, appProps({
      dispatch,
      commands: {
        descriptors: [{ name: 'command-00', description: 'registry command' }],
        subscribe: () => unsubscribe,
        setAgent: noop,
      },
    }))
    try {
      await wait()
      harness.stdin.write('/command-0')
      await wait()
      // The menu is open and nothing has been submitted yet.
      expect(harness.output.text).toContain('/command-00')
      harness.stdin.write('\r')
      await wait()
      expect(dispatch).not.toHaveBeenCalled()
      // The accepted candidate landed in the composer with its trailing
      // space; the second return submits it through the registry path.
      harness.stdin.write('\r')
      await wait()
      expect(dispatch).toHaveBeenCalledWith('/command-00')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})
describe('completion menu cursor step', () => {
  it('keeps an empty menu at zero instead of computing NaN', () => {
    expect(stepCompletionIndex(0, -1, 0)).toBe(0)
    expect(stepCompletionIndex(3, 1, 0)).toBe(0)
    expect(stepCompletionIndex(0, 1, 3)).toBe(1)
    expect(stepCompletionIndex(0, -1, 3)).toBe(2)
    // A stale negative index still lands on a real row.
    expect(stepCompletionIndex(-1, 1, 3)).toBe(0)
  })
})
describe('prompt fidelity', () => {
  it('dispatches an ordinary pasted prompt with its exact indentation and line breaks', async () => {
    const harness = createTty(100, 24)
    const dispatch = vi.fn()
    const instance = renderApp(harness, appProps({ dispatch }))
    try {
      await wait()
      // Bracketed paste of indented code: the leading spaces and the inner
      // newline are content, not noise — the composer must forward the draft
      // verbatim instead of the trimmed form.
      harness.stdin.write('\x1b[200~  if cond:\n    run()\x1b[201~')
      await wait(180)
      harness.stdin.write('\r')
      await wait()
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(dispatch).toHaveBeenCalledWith('  if cond:\n    run()')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('still routes a slash line whose draft carries the completion trailing space', async () => {
    const harness = createTty(100, 24)
    const dispatch = vi.fn()
    const instance = renderApp(harness, appProps({ dispatch }))
    try {
      await wait()
      harness.stdin.write('/help ')
      await wait()
      harness.stdin.write('\r')
      await wait()
      // '/help ' is a local TUI action: the trimmed command routes to the
      // overlay, never to dispatch.
      expect(dispatch).not.toHaveBeenCalled()
      expect(harness.output.text).toContain('/help — keys and commands')
    } finally {
      instance.unmount()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})
describe('composer band', () => {
  it('paints a three-row background band instead of a border with the draft on the middle row', async () => {
    const originalChalkLevel = chalk.level
    chalk.level = 3
    const harness = createTty(100, 24)
    const band = DARK_PALETTE.composerBand
    const bandSeq = `\u001b[48;2;${band[0]};${band[1]};${band[2]}m`
    try {
      const instance = renderApp(harness, appProps())
      try {
        await wait()
        harness.stdin.write('banded')
        await wait()
        const lines = harness.output.text.split('\n')
        const row = lines.findIndex(line => line.includes('banded'))
        expect(row).toBeGreaterThanOrEqual(0)
        // The draft row plus one blank band row above and below: three
        // consecutive rows carry the band background, no border glyphs.
        expect(lines[row]).toContain(bandSeq)
        expect(lines[row - 1]).toContain(bandSeq)
        expect(lines[row + 1]).toContain(bandSeq)
        expect(lines[row]).not.toContain('│')
        expect(lines[row - 1]).not.toContain('╭')
        expect(lines[row + 1]).not.toContain('╰')
      } finally {
        instance.unmount()
      }
    } finally {
      harness.stdin.destroy()
      harness.stdout.destroy()
      chalk.level = originalChalkLevel
    }
  })
})
describe('composer recall history', () => {
  it('records typed slash commands and prompts into one shared history', async () => {
    const harness = createTty()
    const { stdin } = harness
    const recorded: string[] = []
    const instance = renderApp(harness, appProps({
      store: createTranscriptStore(),
      recordHistory: text => {
        recorded.push(text)
      },
    }))
    try {
      await wait()
      // A plain prompt first.
      stdin.write('hello world')
      await wait()
      stdin.write('\r')
      await wait()
      // A typed slash command keeps the completion menu open, so dismiss
      // it with Esc before submitting the line.
      stdin.write('/copy')
      await wait()
      stdin.write('\x1b')
      await wait()
      stdin.write('\r')
      await wait()
      expect(recorded).toEqual(['hello world', '/copy'])
      // Up recalls the command (with the completion menu suppressed for
      // the recalled text) and the next Up walks past it to the older
      // prompt - either text edge is a valid recall position. Submitting
      // then records the walked-to prompt.
      stdin.write('\x1b[A')
      await wait()
      stdin.write('\x1b[A')
      await wait()
      stdin.write('\r')
      await wait()
      expect(recorded[recorded.length - 1]).toBe('hello world')
    } finally {
      instance.unmount()
      stdin.destroy()
      harness.stdout.destroy()
    }
  })

  it('re-asserts the tab title when the terminal regains focus', async () => {
    vi.stubEnv('TERM_PROGRAM', 'vscode')
    vi.stubEnv('VSCODE_INJECTION', '1')
    const harness = createTty()
    const instance = renderApp(harness, appProps())
    try {
      await wait()
      expect(harness.output.text).toContain('\x1b]0;deepseek\x07')
      // A background worker sharing the console overwrote the title while
      // the terminal was unfocused; focus-in re-asserts the managed label.
      harness.output.text = ''
      harness.stdin.write('\x1b[I')
      await wait()
      expect(harness.output.text).toContain('\x1b]0;deepseek\x07')
    } finally {
      instance.unmount()
      vi.unstubAllEnvs()
      harness.stdin.destroy()
      harness.stdout.destroy()
    }
  })
})
