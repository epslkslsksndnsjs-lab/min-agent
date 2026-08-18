// Activity tracker for the boot agent run. Copied from @mycode/mycode-tui's
// AgentActivityTracker: it derives what the agent is doing right now (and how
// many output tokens it has produced since the user's last message) from the
// event stream, so the status line can show more than a static "Working...".
//
// Output tokens accumulate per turn (reset on each user message) and lean on a
// character-based estimate between authoritative usage reports, kept monotonic
// so the count never dips when final usage arrives.

export type AgentActivity = 'waiting' | 'thinking' | 'writing' | 'executing'

export const AGENT_ACTIVITY_LABELS: Record<AgentActivity, string> = {
  waiting: 'Waiting',
  thinking: 'Thinking',
  writing: 'Writing',
  executing: 'Executing',
}

/** Fallback estimate for providers that only report usage when the message completes. */
const CHARS_PER_TOKEN_ESTIMATE = 4

export class AgentActivityTracker {
  private activity: AgentActivity = 'waiting'
  private completedTokens = 0
  private streamingUsageTokens = 0
  private streamingChars = 0
  private runningToolCount = 0
  // Live count leans on the character estimate between authoritative usage
  // reports; keeping the reported value monotonic prevents it dipping when
  // usage arrives at message end.
  private reportedTokens = 0

  /** Start of a new turn (user message): reset counters and show "thinking". */
  reset(): void {
    this.activity = 'thinking'
    this.completedTokens = 0
    this.streamingUsageTokens = 0
    this.streamingChars = 0
    this.runningToolCount = 0
    this.reportedTokens = 0
  }

  onThinking(): void {
    this.activity = 'thinking'
  }

  onWriting(chars: number): void {
    this.activity = 'writing'
    this.streamingChars += chars
    this.reportedTokens = Math.max(this.reportedTokens, this.currentTokens())
  }

  onExecutingStart(): void {
    this.runningToolCount++
    this.activity = 'executing'
  }

  onExecutingEnd(): void {
    this.runningToolCount = Math.max(0, this.runningToolCount - 1)
    if (this.runningToolCount === 0) this.activity = 'thinking'
  }

  /** Authoritative usage for the in-flight message (overrides the estimate). */
  setAuthoritative(totalTokens: number): void {
    this.streamingUsageTokens = totalTokens
    this.reportedTokens = Math.max(this.reportedTokens, this.currentTokens())
  }

  /** End of turn: fold streaming tokens into the completed total and idle. */
  onTurnEnd(): void {
    this.completedTokens += this.streamingUsageTokens > 0 ? this.streamingUsageTokens : this.estimatedStreamingTokens()
    this.streamingUsageTokens = 0
    this.streamingChars = 0
    this.activity = 'waiting'
  }

  getStatus(): { activity: AgentActivity; direction: 'down' | 'up'; tokens: number } {
    return {
      activity: this.activity,
      direction: this.activity === 'executing' ? 'up' : 'down',
      tokens: this.reportedTokens,
    }
  }

  private currentTokens(): number {
    return this.completedTokens + Math.max(this.streamingUsageTokens, this.estimatedStreamingTokens())
  }

  private estimatedStreamingTokens(): number {
    return Math.round(this.streamingChars / CHARS_PER_TOKEN_ESTIMATE)
  }
}

/** Format a token count compactly: 950 -> "950", 1250 -> "1.3k", 12000 -> "12k". */
export function formatTokenCount(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1000000) return `${Math.round(count / 1000)}k`
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`
  return `${Math.round(count / 1000000)}M`
}

/** Format elapsed milliseconds the way the working loader does: "3s", "1m 03s", "1h 02m 03s". */
export function formatWorkingElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) {
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) {
    return `${hours}h ${remainingMinutes.toString().padStart(2, '0')}m ${seconds.toString().padStart(2, '0')}s`
  }
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return `${days}d ${remainingHours.toString().padStart(2, '0')}h ${remainingMinutes.toString().padStart(2, '0')}m ${seconds.toString().padStart(2, '0')}s`
}
