import { describe, expect, it } from 'vitest'
import { latestAssistantText } from '../src/editor.ts'
import { createTranscriptView } from '../src/render/projection.ts'

describe('latestAssistantText', () => {
  it('returns the newest complete non-empty assistant response', () => {
    const view = {
      ...createTranscriptView(),
      entries: [
        { kind: 'assistant', text: 'first', reasoning: '' },
        { kind: 'assistant', text: '', reasoning: 'thinking' },
        { kind: 'assistant', text: 'latest', reasoning: '' },
      ],
    } as ReturnType<typeof createTranscriptView>
    expect(latestAssistantText(view)).toBe('latest')
    expect(latestAssistantText(createTranscriptView())).toBeUndefined()
  })
})
