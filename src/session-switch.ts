/** Latest-wins, idle-bound queue for safe Agent session changes. */

export interface IdleActivity {
  readonly status: 'idle' | 'running'
  whenIdle(): Promise<void>
}

interface Request<T> {
  readonly activity: IdleActivity
  readonly value: T
}

export class SessionSwitchQueue<T> {
  private pending: Request<T> | undefined
  private pumping = false
  private running = false

  constructor(
    private readonly execute: (value: T) => Promise<void>,
    private readonly failed: (error: unknown) => void,
  ) {}

  /** Queue a request; a later request replaces any request still waiting. */
  request(activity: IdleActivity, value: T): 'queued' | 'started' {
    this.pending = { activity, value }
    const outcome = activity.status === 'running' || this.pumping ? 'queued' : 'started'
    if (!this.pumping) void this.pump()
    return outcome
  }

  /** Cancel only work that has not begun activation. */
  cancel(): boolean {
    if (this.pending === undefined) return false
    this.pending = undefined
    return true
  }

  /**
   * Whether a queued change is being activated right now. Between the idle
   * wait and the handoff the old session is still installed, so a submission
   * made in that window would start a turn the handoff then discards; callers
   * use this to refuse one instead of losing it.
   */
  get activating(): boolean {
    return this.running
  }

  private async pump(): Promise<void> {
    this.pumping = true
    try {
      while (this.pending !== undefined) {
        const observed = this.pending
        await observed.activity.whenIdle()
        // Another request replaced this one while the turn was converging.
        if (this.pending !== observed) continue
        this.pending = undefined
        this.running = true
        try {
          await this.execute(observed.value)
        } catch (error: unknown) {
          this.failed(error)
        } finally {
          this.running = false
        }
      }
    } finally {
      this.pumping = false
      // A request may land between the loop condition and finally.
      if (this.pending !== undefined) void this.pump()
    }
  }
}
