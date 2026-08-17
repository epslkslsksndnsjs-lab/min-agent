// src/cli.ts
// Entry point. Session persistence lives in session.ts; this module re-exports
// it and keeps the CLI wiring (user input -> agent loop -> TUI -> persist).

import { runAgent } from './agent.js'
import { Tui } from './tui.js'
import { builtinTools } from './tools.js'
import { loadSession, persistSession } from './session.js'
import type { Model, Context } from './llm.js'

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
  const tui = new Tui()

  // Each turn: user input -> runAgent -> forward events to TUI -> persist
  tui.onPrompt(async (text) => {
    try {
      context.messages.push({ role: 'user', content: text })

      tui.setBusy(true)
      const ctrl = new AbortController()
      tui.onAbort(() => ctrl.abort())  // A new AbortController is created each turn, so re-register the callback to point at the new controller

      for await (const ev of runAgent(model, context, tools, ctrl.signal)) {
        switch (ev.type) {
          case 'assistant_text': tui.printText(ev.delta); break
          case 'tool_call': tui.printToolCall(ev.name, ev.args); break
          case 'tool_result': tui.printToolResult(ev.name, ev.result); break
          case 'turn_end':
            if (ev.stopReason === 'max_tokens') tui.printText('\n[output truncated by max_tokens]')
            if (ev.stopReason === 'error') tui.printText('\n[error occurred]')
            tui.printTurnEnd()
            break
        }
      }

      await persistSession(context.messages)
    } catch (e) {
      console.error(`\n[error] ${(e as Error).message}`)
    } finally {
      tui.setBusy(false)
    }
  })

  tui.start()

}

// Only start when run directly (not when imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
