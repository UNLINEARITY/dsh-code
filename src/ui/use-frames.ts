/** Wall-clock animation frame hook shared by independent terminal leaves. */

import { useEffect, useState } from 'react'

/**
 * Derive ticks from elapsed wall time so a stretched interval skips ahead
 * instead of slowing the animation under a busy event loop or remote shell.
 */
export function useFrames(intervalMs: number, active = true): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const startedAt = Date.now()
    setTick(0)
    const id = setInterval(() => {
      setTick(Math.max(0, Math.floor((Date.now() - startedAt) / intervalMs)))
    }, intervalMs)
    return () => {
      clearInterval(id)
    }
  }, [active, intervalMs])
  return tick
}
