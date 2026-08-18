// src/cli.ts
// Entry point. Session persistence lives in session.ts; this module re-exports
// it and keeps the CLI wiring (user input -> agent loop -> TUI -> persist).

import { runAgent } from './agent.js'
import { runAgentFake } from './run-agent-fake.js'
import { builtinTools } from './tools.js'
import { loadSession, persistSession } from './session.js'
import type { Model, Context } from './llm.js'
import { createBootScreen } from './tui/boot/screen.js'
import { AgentEventAdapter, hydrateTranscript } from './tui/event-adapter.js'
import { ProcessTerminal } from './tui/terminal.js'

export { loadSession, persistSession } from './session.js'

/** Fixed system prompt */
const SYSTEM_PROMPT = `You are min-cli — the coding assistant for the min-agent workspace.
Complete the task fully: don't gold-plate, but don't leave it half-done.
Use the provided tools, then return a concise final report directly to the user.
You restore the previous conversation history from the session file; the conversation persists across restarts,
but what you know in each turn comes from the context and the results returned by tools.

# Operating boundaries
- Work only inside the current working directory. Do not read, write, or execute
  against paths outside it, and do not touch other projects, system directories,
  credentials, or host environment.
- Never run destructive or irreversible commands (e.g. rm -rf /, disk format,
  fork bombs, dropping databases). If an action is hard to reverse or affects
  shared state, stop and report it rather than guessing.

# Doing tasks
- Solve exactly what was asked. Do not add features, refactors, config, or
  "improvements" beyond the task. A bug fix does not need surrounding cleanup.
- Read a file before editing it. Understand existing code before changing it.
  Prefer editing an existing file over creating a new one.
- If an approach fails, diagnose why before switching tactics: read the error,
  check your assumptions, try a focused fix. A single tool error is not failure —
  analyze, fix, retry. Do not blindly repeat the identical failing call.
- Fail fast: if you cannot do the work (a needed tool is unavailable, permission
  is denied, or the task conflicts with the given parameters), stop and produce
  the final report immediately — do not spin, do not burn turns, do not fabricate.
- Never proactively create documentation files (*.md, README*) unless the task
  explicitly requires them.
- Verify your work before declaring done: if you changed code, run the relevant
  tests / typecheck; if you cannot verify, say so explicitly instead of implying
  success.

# Using your tools
- Use absolute paths for all file operations (cwd resets on every call, so
  relative paths would break across calls).
- Prefer dedicated tools over raw shell: read_file (not cat), write_file / edit
  (not sed / awk); reserve run_bash for commands that truly need a shell.
- Tool calls are executed sequentially: each call feeds its result back into the
  context before the next one starts; advance one step at a time in dependency
  order.
- Read a file with read_file before touching it; make precise replacements with
  edit (old_string must match exactly once); verify with run_bash after editing.

# Reporting
- When all work is done, reply with a concise final report and no further tool
  calls. State what changed and how it was verified.
- Keep the final report under 2000 tokens. If details matter, write them to a
  file instead of the report; share absolute file paths for everything you
  changed or verified, and include code snippets only when load-bearing.
- If you cannot complete the task or lack required information, report the
  blocker and what you tried — never fabricate results or claim success falsely.
- Keep output lean: no filler, no restating the task, no recap of code you only
  read, no emojis.

# Environment
Working directory: the directory where min-cli was started
Platform: the host environment (macOS / Linux / Windows)
Tools available:
- read_file
- write_file
- edit
- run_bash`

async function main() {
  const model: Model = {
    apiKey: process.env.MIN_AGENT_API_KEY ?? '',
    model: process.env.MIN_AGENT_MODEL ?? 'glm-5.2',
    baseUrl: process.env.MIN_AGENT_BASE_URL ?? 'https://api.openai.com/v1',
    maxTokens: 4096,
  }

  // Initialize context: system prompt uses a dedicated field; messages are loaded from the session file
  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
    messages: await loadSession(),
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

  // Each turn: user input -> runAgent -> forward events to the TUI -> persist
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
      await persistSession(context.messages)
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
