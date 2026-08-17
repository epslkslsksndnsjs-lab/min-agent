import type { Component } from '../tui.js'
import { styleText } from './theme.js'

/**
 * Run-status line rendered above the input dock. Shows `↓ {tokens} tokens ·
 * {elapsed}` once the agent starts streaming; before that it returns no rows so
 * the input prompt sits at the bottom of the screen.
 */

/** Format a token count with thousands separators, e.g. 12345 -> "12,345". */
export function formatTokens(tokens: number): string {
  return tokens.toLocaleString('en-US')
}

/** Format elapsed milliseconds as mm:ss, or h:mm:ss past an hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

export class Footer implements Component {
  private tokens = 0
  private elapsedMs = 0
  private active = false

  setTokens(tokens: number): void {
    this.tokens = tokens
    this.active = true
  }

  setElapsed(ms: number): void {
    this.elapsedMs = ms
    this.active = true
  }

  invalidate(): void {
    // No cached state to invalidate currently
  }

  render(_width: number): string[] {
    if (!this.active) return []
    const line = `↓ ${formatTokens(this.tokens)} tokens · ${formatElapsed(this.elapsedMs)}`
    return [styleText('muted', line)]
  }
}
