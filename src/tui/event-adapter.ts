// Event pipeline adapter: maps the agent event stream to transcript state.
// A thin layer — each event updates the Transcript and requests a render;
// no UI logic lives here.

import type { AgentEvent } from '../agent.js'
import type { Message } from '../llm.js'
import { Transcript } from './boot/transcript.js'
import type { Input } from './components/input.js'

/**
 * Thin adapter connecting the agent event stream to the UI.
 * `handle` maps each event to transcript state, then invokes the render
 * callback so the UI repaints (render coalescing is the TUI's job).
 */
export class AgentEventAdapter {
  constructor(
    private readonly transcript: Transcript,
    private readonly requestRender: () => void,
    private readonly input?: Input,
  ) {}

  /** Append the user's prompt to the transcript, clear the input, and render. */
  submit(text: string): void {
    this.transcript.addUser(text)
    this.input?.setValue('')
    this.requestRender()
  }

  /** Map one agent event to transcript state and request a render. */
  handle(ev: AgentEvent): void {
    switch (ev.type) {
      case 'assistant_text':
        // Streams into its own Assistant block (no separate thinking stage)
        this.transcript.appendAssistant(ev.delta)
        break
      case 'tool_call':
        this.transcript.addTool(ev.name, ev.args)
        break
      case 'tool_result':
        this.transcript.setToolResult(ev.result)
        break
      case 'turn_end':
        this.transcript.endTurn()
        break
    }
    this.requestRender()
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
