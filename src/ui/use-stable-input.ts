/** Stable Ink input subscription for stateful keyboard-owned surfaces. */

import { useCallback, useRef } from 'react'
import { useInput, type Key } from 'ink'

/**
 * Ink re-subscribes its input effect whenever the handler identity changes.
 * Keep ownership stable while a surface updates cursor, scroll, or draft state.
 */
export function useStableInput(handler: (input: string, key: Key) => void, active: boolean): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  const stableHandler = useCallback((input: string, key: Key): void => {
    handlerRef.current(input, key)
  }, [])
  useInput(stableHandler, { isActive: active })
}
