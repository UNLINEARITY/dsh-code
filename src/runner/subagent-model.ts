import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'

/** Record the active root's child route before the next step is prepared. */
export function applySubagentModel(child: Agent, root: Agent | undefined, override?: ModelSelection): void {
  if (root === undefined || child.session.header.parentSession !== root.session.id) return
  const selection = override ?? root.model.current()
  if (selection !== undefined) child.model.select(selection)
}
