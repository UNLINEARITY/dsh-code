/** Mention API edges: parse passthrough, prepare degradation, session tokens. */

import { describe, expect, it, vi } from 'vitest'
import { createMentions, isPathLikeMentionQuery } from '../src/mentions.ts'
import { encodeSessionReferenceUri, parseSessionReferenceText } from '@deepseek-ai/dsh-session-reference'
import { SessionId } from '@deepseek-ai/dsh-session'

/** A canonical one-mention text: the URI form the parser actually accepts. */
const mentioned = (label: string, id: string): string =>
  `see @[${label}](${encodeSessionReferenceUri(SessionId(id))})`

const fakeCtx = (services: Record<string, unknown>): never =>
  ({ get: (name: string) => services[name] }) as never

const agent = { id: 'session-agent-1' } as never

describe('isPathLikeMentionQuery', () => {
  it('treats slash-containing queries as path navigation', () => {
    expect(isPathLikeMentionQuery('src/app')).toBe(true)
    expect(isPathLikeMentionQuery('a\\b')).toBe(true)
    expect(isPathLikeMentionQuery('plain')).toBe(false)
    expect(isPathLikeMentionQuery('')).toBe(false)
  })
})

describe('createMentions without services', () => {
  it('parse passes through the shared session-reference parser', () => {
    const api = createMentions(fakeCtx({}), agent, '/w')
    const parsed = api.parse(mentioned('label', 'session-x'))
    // The opaque URI collapses to the readable @label span.
    expect(parsed.text).toBe('see @label')
    expect(parsed.references).toHaveLength(1)
  })

  it('prepare returns the text untouched without references', async () => {
    const api = createMentions(fakeCtx({}), agent, '/w')
    const parsed = parseSessionReferenceText('no references here')
    await expect(api.prepare(parsed)).resolves.toEqual({ text: 'no references here', references: [] })
  })

  it('prepare degrades to passthrough when the resolver or agent is absent', async () => {
    const parsed = parseSessionReferenceText(mentioned('title', 'session-1'))
    expect(parsed.references.length).toBeGreaterThan(0)
    const noResolver = createMentions(fakeCtx({}), agent, '/w')
    await expect(noResolver.prepare(parsed)).resolves.toEqual({ text: parsed.text, references: parsed.references })
    const noAgent = createMentions(fakeCtx({ sessionReferenceResolver: { prepare: vi.fn() } }), undefined, '/w')
    await expect(noAgent.prepare(parsed)).resolves.toEqual({ text: parsed.text, references: parsed.references })
  })

  it('prepare joins the resolver text blocks and carries additional context', async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any -- resolver double */
    const prepare = vi.fn(async () => ({
      content: [
        { type: 'text', text: 'part one ' },
        { type: 'image' as never, url: 'x' as never },
        { type: 'text', text: 'part two' },
      ],
      additionalContext: 'injected',
    }))
    const api = createMentions(fakeCtx({ sessionReferenceResolver: { prepare } }), agent, '/w')
    const parsed = parseSessionReferenceText(mentioned('title', 'session-1'))
    const result = await api.prepare(parsed)
    expect(result.text).toBe('part one part two')
    expect(result.additionalContext).toBe('injected')
    expect(result.references).toEqual(parsed.references)
    // The forwarded content keeps the readable text as one block list.
    expect((prepare.mock.calls[0] as any[])[1]).toEqual([{ type: 'text', text: parsed.text }])
    /* eslint-enable @typescript-eslint/no-explicit-any */
  })

  it('prepare rejects through the resolver failure', async () => {
    const prepare = vi.fn(async () => { throw new Error('reference resolution failed') })
    const api = createMentions(fakeCtx({ sessionReferenceResolver: { prepare } }), agent, '/w')
    const parsed = parseSessionReferenceText(mentioned('title', 'session-1'))
    await expect(api.prepare(parsed)).rejects.toThrow('reference resolution failed')
  })

  it('sessionMention formats the canonical token', () => {
    const api = createMentions(fakeCtx({}), agent, '/w')
    const token = api.sessionMention({ sessionId: SessionId('session-xyz'), label: 'my title', sameWorkspace: true, createdAt: 1 })
    expect(token).toContain('my title')
    expect(token).toContain(encodeSessionReferenceUri(SessionId('session-xyz')))
  })

  it('candidates with an agent but no file service yields empty file rows', async () => {
    const api = createMentions(fakeCtx({}), agent, '/w')
    await expect(api.candidates('needle')).resolves.toEqual([])
  })
})
