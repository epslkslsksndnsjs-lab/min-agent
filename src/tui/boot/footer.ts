import type { Component } from '../tui.js'
import type { AgentEvent } from '../../agent.js'
import { styleText } from './theme.js'
import {
  AGENT_ACTIVITY_LABELS,
  AgentActivityTracker,
  formatTokenCount,
  formatWorkingElapsed,
} from './agent-activity.js'

/**
 * Run-status line rendered above the input dock. Mirrors @mycode/mycode-tui:
 * the line is empty while idle (waiting) and, while the agent is active, shows
 * an animated spinner plus `Activity · elapsed · ↓/↑ tokens tokens` so the user
 * can always tell whether the run is alive or stuck. Tokens reset per turn and
 * use the compact `1.2k` formatter; the arrow points down while receiving
 * (thinking/writing) and up while a tool is executing.
 */

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_INTERVAL_MS = 80

export class Footer implements Component {
  private readonly tracker = new AgentActivityTracker()
  private active = false
  private workingStartedAt = 0
  private spinnerFrame = 0
  private animTimer: ReturnType<typeof setInterval> | undefined
  private requestRender: () => void = () => {}
  /** Set while a retry backoff is in progress; cleared when the next output arrives. */
  private retryNotice: string | null = null

  /** Wire the render callback used to advance the spinner animation. */
  setRequestRender(fn: () => void): void {
    this.requestRender = fn
  }

  /** Begin a turn: reset per-turn state, show "thinking", start the spinner. */
  startTurn(): void {
    this.tracker.reset()
    this.workingStartedAt = Date.now()
    this.active = true
    this.startSpinner()
  }

  /** Feed one agent event into the activity tracker. */
  feed(ev: AgentEvent): void {
    // A new user message starts a fresh turn.
    if (ev.type === 'user_interject') {
      this.startTurn()
      return
    }
    // If the status line was idle (after turn_end or before the first submit),
    // the first produced event opens a new turn so the spinner reappears.
    if (!this.active && (ev.type === 'tool_call' || ev.type === 'assistant_text')) {
      this.startTurn()
    }
    // Any fresh output clears a pending retry notice.
    if (ev.type === 'assistant_text' || ev.type === 'tool_call' || ev.type === 'turn_end') {
      this.retryNotice = null
    }
    switch (ev.type) {
      case 'retry':
        this.retryNotice = `retry ${ev.attempt}/${ev.maxAttempts}`
        break
      case 'assistant_text':
        this.tracker.onWriting(ev.delta)
        break
      case 'tool_call':
        this.tracker.onExecutingStart()
        break
      case 'tool_result':
        this.tracker.onExecutingEnd()
        break
      case 'usage':
        this.tracker.setAuthoritative(ev.usage.completionTokens)
        break
      case 'turn_end':
        break
    }
  }

  /** End of turn: fold tokens and hide the line until the next turn starts. */
  endTurn(): void {
    this.tracker.onTurnEnd()
    this.active = false
    this.stopSpinner()
  }

  invalidate(): void {
    // No cached state to invalidate; the line is recomputed on each render.
  }

  private startSpinner(): void {
    this.stopSpinner()
    this.animTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length
      this.requestRender()
    }, SPINNER_INTERVAL_MS)
  }

  private stopSpinner(): void {
    if (this.animTimer) {
      clearInterval(this.animTimer)
      this.animTimer = undefined
    }
  }

  render(width: number): string[] {
    if (!this.active) return []
    const status = this.tracker.getStatus()
    const elapsed = formatWorkingElapsed(Date.now() - this.workingStartedAt)
    const arrow = status.direction === 'down' ? '↓' : '↑'
    const tokenPart = status.tokens > 0 ? `${arrow} ${formatTokenCount(status.tokens)} tokens` : ''
    const activityLabel = this.retryNotice ?? AGENT_ACTIVITY_LABELS[status.activity]
    const parts = [activityLabel]
    if (tokenPart) parts.push(tokenPart)
    parts.push(elapsed)
    const line = parts.join(' · ')
    const spinner = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length]
    return [styleText('accent', `${spinner} `) + styleText('muted', line)]
  }
}
