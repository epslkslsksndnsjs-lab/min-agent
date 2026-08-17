// src/tui.ts
// Terminal UI: single-line input, streaming output, Ctrl+C interrupt.

import * as readline from 'readline'

export class Tui {
  private rl: readline.Interface | null = null
  private onPromptCb: ((text: string) => void) | null = null
  private onAbortCb: (() => void) | null = null
  private aborted = false
  private busy = false  // true while the agent runs, blocking concurrent input

  /** Register the prompt callback */
  onPrompt(cb: (text: string) => void): void {
    this.onPromptCb = cb
  }

  /** Register the Ctrl+C callback */
  onAbort(cb: () => void): void {
    this.onAbortCb = cb
  }

  /** Start the TUI and begin reading input */
  start(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    process.stdin.on('keypress', (_ch: string, key: { ctrl?: boolean; name?: string } | undefined) => {
      // Only handle Ctrl+C while the agent runs; when idle, leave it to readline's default behavior
      if (this.busy && key?.ctrl && key?.name === 'c' && !this.aborted) {
        this.aborted = true
        this.onAbortCb?.()
      }
    })

    this.prompt()
  }
  private prompt(): void {
    if (!this.rl) return
    if (this.busy) return  // While the agent runs, don't show the prompt
    this.aborted = false
    this.rl.question('> ', (answer) => {
      const text = answer.trim()
      if (text) {
        this.onPromptCb?.(text)
        // Don't recurse into prompt() immediately — wait until setBusy(false) is called
      } else {
        this.prompt()  // Empty input: re-prompt without triggering the callback
      }
    })
  }

  /** Called when the agent starts running, to block new input */
  setBusy(busy: boolean): void {
    this.busy = busy
    if (!busy) this.prompt()  // Agent finished — resume input
  }

  /** Stream-print the assistant text delta */
  printText(delta: string): void {
    process.stdout.write(delta)
  }

  /** Print a tool call */
  printToolCall(name: string, args: unknown): void {
    process.stdout.write(`\n[tool: ${name}] ${JSON.stringify(args)}\n`)
  }

  /** Print a tool result */
  printToolResult(name: string, result: string): void {
    process.stdout.write(`[result: ${name}] ${result}\n`)
  }

  /** End of turn: newline */
  printTurnEnd(): void {
    process.stdout.write('\n')
  }

  /** Stop the TUI and clean up listeners */
  stop(): void {
    this.rl?.close()
    this.rl = null
    process.stdin.removeAllListeners('keypress')
  }
}
