// src/cli.ts
// Entry point. Wires user input -> agent loop -> TUI. Conversations are
// ephemeral: nothing is persisted to disk across restarts.

import { runAgent } from './agent.js'
import { runAgentFake } from './run-agent-fake.js'
import { builtinTools } from './tools.js'
import { buildMinAgentSystemPrompt } from './system-prompt.js'
import type { Model, Context } from './llm.js'
import { createBootScreen } from './tui/boot/screen.js'
import { AgentEventAdapter, hydrateTranscript } from './tui/event-adapter.js'
import { ProcessTerminal } from './tui/terminal.js'

async function main() {
  const model: Model = {
    apiKey: process.env.MIN_AGENT_API_KEY ?? '',
    model: process.env.MIN_AGENT_MODEL ?? 'glm-5.2',
    baseUrl: process.env.MIN_AGENT_BASE_URL ?? 'https://api.openai.com/v1',
    maxTokens: 4096,
  }

  // Initialize context: system prompt uses a dedicated field; conversations are
  // ephemeral, so messages start empty (no session file is loaded).
  const context: Context = {
    systemPrompt: await buildMinAgentSystemPrompt(),
    messages: [],
  }

  const tools = builtinTools()

  // Stress-test stand-in: emit a synthetic event stream instead of calling a model.
  const useFake = process.env.MIN_AGENT_FAKE === '1' || model.model === 'abc'

  const terminal = new ProcessTerminal()
  const boot = createBootScreen(terminal, {
    model: model.model,
    cwd: process.cwd(),
    wordmark: 'min-agent',
    startHint: 'type to start',
  })
  // Replay the persisted conversation so it is visible at boot
  hydrateTranscript(context.messages, boot.transcript)
  terminal.setTitle('min-agent')

  const { tui, input } = boot
  const adapter = new AgentEventAdapter(boot.transcript, () => tui.requestRender(), input, boot.footer)

  let busy = false
  let ctrl: AbortController | null = null
  // Ctrl+C / Escape routes through Input's cancel binding; abort only the
  // running turn (a null controller while idle is a no-op).
  input.onEscape = () => ctrl?.abort()

  // Each turn: user input -> runAgent -> forward events to the TUI
  input.onSubmit = (text) => {
    if (busy) return // Block concurrent turns while the agent runs
    void runTurn(text)
  }

  async function runTurn(text: string): Promise<void> {
    busy = true
    adapter.submit(text)
    context.messages.push({ role: 'user', content: text })
    ctrl = new AbortController()
    try {
      const source = useFake
        ? runAgentFake(ctrl.signal)
        : runAgent(model, context, tools, ctrl.signal)
      for await (const ev of source) {
        if (ev.type === 'turn_end' && ev.stopReason === 'max_tokens') {
          adapter.handle({ type: 'assistant_text', delta: '\n[output truncated by max_tokens]' })
        }
        adapter.handle(ev)
      }
    } catch (e) {
      adapter.handle({ type: 'assistant_text', delta: `\n[error] ${(e as Error).message}` })
    } finally {
      ctrl = null
      busy = false
    }
  }


  tui.start()
}

// Only start when run directly (not when imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
