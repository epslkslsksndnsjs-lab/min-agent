// Event pipeline adapter: maps the agent event stream to transcript state.
// A thin layer — each event updates the Transcript and requests a render;
// no UI logic lives here.

import type { AgentEvent } from '../agent.js'
import { type Message } from '../llm.js'
import { Transcript } from './boot/transcript.js'
import type { Footer } from './boot/footer.js'
import type { Input } from './components/input.js'
import { styleText } from './boot/theme.js'
import { formatTokenCount } from './boot/agent-activity.js'

/**
 * Thin adapter connecting the agent event stream to the UI.
 * `handle` maps each event to transcript state, then invokes the render
 * callback so the UI repaints (render coalescing is the TUI's job).
 * When a footer is provided, the event stream also drives its activity
 * tracker (status line: thinking/executing/writing + tokens + elapsed).
 */
export class AgentEventAdapter {
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
    this.footer?.startTurn()
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
        this.transcript.addTool(ev.name, ev.args, ev.id)
        break
      case 'tool_result':
        this.transcript.setToolResultById(ev.id, ev.result, ev.result.startsWith('error:'))
        break
      case 'user_interject':
        this.transcript.addUser(ev.text)
        break
      case 'retry':
        // Surface retry progress in the transcript so the user can see the
        // assistant turn being restarted on a transient error.
        {
          const raw = ev.errorMessage
          const msg = raw.length > 80 ? `${raw.slice(0, 77)}...` : raw
          this.transcript.appendLine(styleText('bashMode', `↻ retry (${ev.attempt}/${ev.maxAttempts}) · ${msg}`))
        }
        break
      case 'usage':
        break
      case 'turn_end':
        this.transcript.endTurn()
        this.footer?.endTurn()
        break
    }
    this.footer?.feed(ev)
    this.requestRender()
  }
}

/**
 * Populate a transcript from in-memory messages, so any messages present at
 * boot are visible. Text blocks render as role-labeled
 * blocks; tool_use / tool_result content blocks pair into tool blocks.
 * Without an explicit target, a fresh transcript is created and returned.
 */
export function hydrateTranscript(messages: readonly Message[], transcript = new Transcript()): Transcript {
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
          transcript.addTool(block.name, block.input, block.id)
          break
        case 'tool_result':
          transcript.setToolResultById(block.tool_use_id, block.content, block.content.startsWith('error:'))
          break
      }
    }
  }
  return transcript
}
