import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { selectForkSeed } from '../src/fork.ts'

const event = (type: string, seq: number): SessionEvent => ({ type, seq, time: seq, data: {} }) as SessionEvent

describe('selectForkSeed', () => {
  const events = [
    event('turn/start', 0), event('user/message', 1), event('turn/end', 2),
    event('session/title', 3), event('turn/start', 4),
    event('user/message', 5), event('turn/end', 6),
  ]

  it('defaults to the last completed turn and keeps trailing metadata', () => {
    expect(selectForkSeed(events)).toEqual({ boundarySeq: 6, events })
    expect(selectForkSeed(events.slice(0, 4))).toEqual({ boundarySeq: 2, events: events.slice(0, 4) })
  })

  it('anchors inside a turn and never clips backward', () => {
    expect(selectForkSeed(events, 1)).toEqual({ boundarySeq: 2, events: events.slice(0, 4) })
    expect(selectForkSeed(events, 4)).toEqual({ boundarySeq: 6, events })
  })

  it('rejects open turns and invalid boundaries', () => {
    expect(() => selectForkSeed(events.slice(0, 2), 1)).toThrow('has not completed')
    expect(() => selectForkSeed([], undefined)).toThrow('no completed turn')
    expect(() => selectForkSeed(events, -1)).toThrow('non-negative integer')
  })
})
