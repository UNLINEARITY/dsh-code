/** Shared optional spacer row used by bounded panel layouts. */

import { createElement, type ReactElement } from 'react'
import { Text } from 'ink'

/** Codex-style panel rhythm that still participates in the row budget. */
export function PanelGap({ visible }: { visible: boolean }): ReactElement | undefined {
  return visible ? createElement(Text, null, ' ') : undefined
}
