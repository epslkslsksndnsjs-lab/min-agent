// Event pipeline adapter: maps the agent event stream to transcript state.
// A thin layer — each event updates the Transcript and requests a render;
// no UI logic lives here.

import type { AgentEvent } from '../agent.js'
import { TokenTracker, type Message } from '../llm.js'
import { Transcript } from './boot/transcript.js'
import type { Footer } from './boot/footer.js'
import type { Input } from './components/input.js'

/**
 * Thin adapter connecting the agent event stream to the UI.
 * `handle` maps each event to transcript state, then invokes the render
 * callback so the UI repaints (render coalescing is the TUI's job).
 * When a footer is provided, token usage (estimate + authoritative) and the
 * elapsed time of the current turn are reported to it.
 */
export class AgentEventAdapter {
  private readonly tokenTracker = new TokenTracker()
  private turnStartedAt = 0
  private elapsedTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly transcript: Transcript,
    private readonly requestRender: () => void,
    private readonly input?: Input,
    private readonly footer?: Footer,
  ) {}

  /** Append the user's prompt to the transcript, clear the input, and render. */
  submit(text: string): void {
    this.transcript.addUser(text)
    this.input?.setValue('')
    this.turnStartedAt = Date.now()
    this.updateFooter()
    this.requestRender()
    this.startElapsedTicker()
  }

  /** Map one agent event to transcript state and request a render. */
  handle(ev: AgentEvent): void {
    switch (ev.type) {
      case 'assistant_text':
        // Streams into its own Assistant block (no separate thinking stage)
        this.transcript.appendAssistant(ev.delta)
        this.tokenTracker.addChars(ev.delta.length)
        break
      case 'tool_call':
        this.transcript.addTool(ev.name, ev.args)
        break
      case 'tool_result':
        this.transcript.setToolResult(ev.result)
        break
      case 'usage':
        this.tokenTracker.setAuthoritative(ev.usage.totalTokens)
        break
      case 'turn_end':
        this.transcript.endTurn()
        this.stopElapsedTicker()
        break
    }
    this.updateFooter()
    this.requestRender()
  }

  /**
   * Keep the elapsed timer advancing during long stretches without stream
   * events (e.g. the model's think delay), so the footer clock does not freeze
   * between deltas. The token estimate still updates on each event.
   */
  private startElapsedTicker(): void {
    this.stopElapsedTicker()
    this.elapsedTimer = setInterval(() => {
      if (this.turnStartedAt > 0) this.updateFooter()
    }, 250)
  }

  private stopElapsedTicker(): void {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer)
      this.elapsedTimer = undefined
    }
  }

  private updateFooter(): void {
    if (!this.footer) return
    this.footer.setTokens(this.tokenTracker.reported)
    if (this.turnStartedAt > 0) {
      this.footer.setElapsed(Date.now() - this.turnStartedAt)
    }
  }
}

/**
 * Build a transcript from persisted session messages, so a previous
 * conversation is visible at boot. Text blocks render as role-labeled
 * blocks; tool_use / tool_result content blocks pair into tool blocks.
 */
export function hydrateTranscript(messages: readonly Message[]): Transcript {
  const transcript = new Transcript()
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      if (msg.role === 'user') transcript.addUser(msg.content)
      else transcript.appendAssistant(msg.content)
      continue
    }
    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          if (msg.role === 'user') transcript.addUser(block.text)
          else transcript.appendAssistant(block.text)
          break
        case 'tool_use':
          transcript.addTool(block.name, block.input)
          break
        case 'tool_result':
          transcript.setToolResult(block.content)
          break
      }
    }
  }
  return transcript
}
