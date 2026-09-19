/** Shared terminal UI contracts used by the runner, App, and composer. */

/** Visual priority for one bounded local notice. */
export type NoticeTone = 'info' | 'warning' | 'error'

/** One mutation the terminal may request for a pending next-turn inbox item. */
export type QueueMutation =
  | { readonly kind: 'remove' }
  | { readonly kind: 'edit'; readonly text: string }
  | { readonly kind: 'steer' }
