// Terminal abstraction and a real raw-mode implementation backed by
// process.stdin/stdout: alternate screen, Kitty keyboard query, bracketed
// paste, SGR mouse mode-sets, and resize handling.

import { setKittyProtocolActive } from './keys.js'
import { StdinBuffer } from './stdin-buffer.js'

/**
 * Minimal terminal interface for the TUI.
 */
export interface Terminal {
  // Start the terminal with input and resize handlers
  start(onInput: (data: string) => void, onResize: () => void): void

  // Stop the terminal and restore state
  stop(): void

  /**
   * Drain stdin before exiting to prevent Kitty key release events from
   * leaking to the parent shell over slow SSH connections.
   */
  drainInput(maxMs?: number, idleMs?: number): Promise<void>

  // Write output to the terminal
  write(data: string): void

  // Terminal dimensions
  get columns(): number
  get rows(): number

  // Whether the Kitty keyboard protocol is active
  get kittyProtocolActive(): boolean

  // Cursor positioning (relative to current position)
  moveBy(lines: number): void

  // Cursor visibility
  hideCursor(): void
  showCursor(): void

  // Clear operations
  clearLine(): void
  clearFromCursor(): void
  clearScreen(): void

  // Alternate screen buffer. The primary screen (and its scrollback) is left
  // untouched while the alt screen is active, so a full-screen view can be
  // shown and dismissed without disturbing the transcript history.
  enterAltScreen(): void
  leaveAltScreen(): void
  get altScreenActive(): boolean

  // SGR mouse tracking (?1000 + ?1006); motion tracking is deliberately never
  // enabled so native drag-selection keeps working.
  setMouseTracking(enabled: boolean): void
  get mouseTrackingActive(): boolean

  // Set the terminal window title
  setTitle(title: string): void
}

/**
 * Real terminal using process.stdin/stdout.
 */
export class ProcessTerminal implements Terminal {
  private wasRaw = false
  private started = false
  private inputHandler?: (data: string) => void
  private resizeHandler?: () => void
  private _kittyProtocolActive = false
  private _modifyOtherKeysActive = false
  private _altScreenActive = false
  private _mouseTrackingActive = false
  private stdinBuffer?: StdinBuffer
  private stdinDataHandler?: (data: string) => void
  private keyboardProtocolFallbackTimer?: ReturnType<typeof setTimeout>

  get kittyProtocolActive(): boolean {
    return this._kittyProtocolActive
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.started = true
    this.inputHandler = onInput
    this.resizeHandler = onResize

    // Save previous state and enable raw mode
    this.wasRaw = process.stdin.isRaw ?? false
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true)
    }
    process.stdin.setEncoding('utf8')
    process.stdin.resume()

    // Enable bracketed paste mode — terminal wraps pastes in \x1b[200~ ... \x1b[201~
    process.stdout.write('\x1b[?2004h')

    // Set up resize handler immediately
    process.stdout.on('resize', this.resizeHandler)

    // Refresh terminal dimensions — they may be stale after suspend/resume
    // (SIGWINCH is lost while the process is stopped). Unix only.
    if (process.platform !== 'win32') {
      process.kill(process.pid, 'SIGWINCH')
    }

    // Query and enable the Kitty keyboard protocol
    this.queryAndEnableKittyProtocol()
  }

  /**
   * Set up StdinBuffer to split batched input into individual sequences so
   * components receive single events. Also watches for the Kitty protocol
   * response and enables it when detected; doing this after buffer parsing
   * handles the case where the response arrives split across multiple events.
   */
  private setupStdinBuffer(): void {
    this.stdinBuffer = new StdinBuffer({ timeout: 10 })

    // Kitty protocol response pattern: \x1b[?<flags>u
    const kittyResponsePattern = /^\x1b\[\?(\d+)u$/

    this.stdinBuffer.on('data', (sequence) => {
      // Check for the Kitty protocol response (only if not already enabled)
      if (!this._kittyProtocolActive) {
        const match = sequence.match(kittyResponsePattern)
        if (match) {
          this.clearKeyboardProtocolFallbackTimer()
          this._kittyProtocolActive = true
          setKittyProtocolActive(true)

          // Enable the Kitty keyboard protocol (push flags)
          // Flag 1 = disambiguate escape codes
          // Flag 2 = report event types (press/repeat/release)
          // Flag 4 = report alternate keys (shifted key, base layout key)
          process.stdout.write('\x1b[>7u')
          return // Don't forward the protocol response to the TUI
        }
      }

      if (this.inputHandler) {
        this.inputHandler(sequence)
      }
    })

    // Re-wrap paste content with bracketed paste markers for editor handling
    this.stdinBuffer.on('paste', (content) => {
      if (this.inputHandler) {
        this.inputHandler(`\x1b[200~${content}\x1b[201~`)
      }
    })

    this.stdinDataHandler = (data: string) => {
      this.stdinBuffer!.process(data)
    }
  }

  /**
   * Query the terminal for Kitty keyboard protocol support and enable it if
   * available. Sends CSI ? u to query current flags; if the terminal responds
   * with CSI ? <flags> u it supports the protocol and we enable it with CSI
   * > 7 u.
   *
   * If no response arrives shortly after startup, fall back to xterm
   * modifyOtherKeys mode 2. This is needed for tmux, which forwards modified
   * enter keys as CSI-u when extended-keys is enabled but may not answer the
   * Kitty query.
   */
  private queryAndEnableKittyProtocol(): void {
    this.setupStdinBuffer()
    process.stdin.on('data', this.stdinDataHandler!)
    process.stdout.write('\x1b[?u')
    this.clearKeyboardProtocolFallbackTimer()
    this.keyboardProtocolFallbackTimer = setTimeout(() => {
      this.keyboardProtocolFallbackTimer = undefined
      if (!this._kittyProtocolActive && !this._modifyOtherKeysActive) {
        process.stdout.write('\x1b[>4;2m')
        this._modifyOtherKeysActive = true
      }
    }, 150)
  }

  private clearKeyboardProtocolFallbackTimer(): void {
    if (!this.keyboardProtocolFallbackTimer) {
      return
    }
    clearTimeout(this.keyboardProtocolFallbackTimer)
    this.keyboardProtocolFallbackTimer = undefined
  }

  async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
    if (this._kittyProtocolActive) {
      // Disable the Kitty keyboard protocol first so any late key releases do
      // not generate new escape sequences.
      process.stdout.write('\x1b[<u')
      this._kittyProtocolActive = false
      setKittyProtocolActive(false)
    }
    if (this._modifyOtherKeysActive) {
      process.stdout.write('\x1b[>4;0m')
      this._modifyOtherKeysActive = false
    }

    const previousHandler = this.inputHandler
    this.inputHandler = undefined

    let lastDataTime = Date.now()
    const onData = () => {
      lastDataTime = Date.now()
    }

    process.stdin.on('data', onData)
    const endTime = Date.now() + maxMs

    try {
      while (true) {
        const now = Date.now()
        const timeLeft = endTime - now
        if (timeLeft <= 0) break
        if (now - lastDataTime >= idleMs) break
        await new Promise((resolve) => setTimeout(resolve, Math.min(idleMs, timeLeft)))
      }
    } finally {
      process.stdin.removeListener('data', onData)
      this.inputHandler = previousHandler
    }
  }

  stop(): void {
    this.started = false
    this.clearKeyboardProtocolFallbackTimer()

    if (this._mouseTrackingActive) {
      process.stdout.write('\x1b[?1006l\x1b[?1002l')
      this._mouseTrackingActive = false
    }
    if (this._altScreenActive) {
      this.releaseAltScreen()
    }

    // Disable bracketed paste mode
    process.stdout.write('\x1b[?2004l')

    // Disable the Kitty keyboard protocol if not already done by drainInput()
    if (this._kittyProtocolActive) {
      process.stdout.write('\x1b[<u')
      this._kittyProtocolActive = false
      setKittyProtocolActive(false)
    }
    if (this._modifyOtherKeysActive) {
      process.stdout.write('\x1b[>4;0m')
      this._modifyOtherKeysActive = false
    }

    // Clean up StdinBuffer
    if (this.stdinBuffer) {
      this.stdinBuffer.destroy()
      this.stdinBuffer = undefined
    }

    // Remove event handlers
    if (this.stdinDataHandler) {
      process.stdin.removeListener('data', this.stdinDataHandler)
      this.stdinDataHandler = undefined
    }
    this.inputHandler = undefined
    if (this.resizeHandler) {
      process.stdout.removeListener('resize', this.resizeHandler)
      this.resizeHandler = undefined
    }

    // Pause stdin to prevent any buffered input (e.g. Ctrl+D) from being
    // re-interpreted after raw mode is disabled. This fixes a race condition
    // where Ctrl+D could close the parent shell over SSH.
    process.stdin.pause()

    // Restore the previous raw mode state
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(this.wasRaw)
    }
  }

  write(data: string): void {
    process.stdout.write(data)
  }

  get columns(): number {
    return process.stdout.columns || Number(process.env.COLUMNS) || 80
  }

  get rows(): number {
    return process.stdout.rows || Number(process.env.LINES) || 24
  }

  moveBy(lines: number): void {
    if (lines > 0) {
      process.stdout.write(`\x1b[${lines}B`)
    } else if (lines < 0) {
      process.stdout.write(`\x1b[${-lines}A`)
    }
  }

  hideCursor(): void {
    process.stdout.write('\x1b[?25l')
  }

  showCursor(): void {
    process.stdout.write('\x1b[?25h')
  }

  clearLine(): void {
    process.stdout.write('\x1b[K')
  }

  clearFromCursor(): void {
    process.stdout.write('\x1b[J')
  }

  clearScreen(): void {
    process.stdout.write('\x1b[2J\x1b[H') // Clear screen and move to home (1,1)
  }

  enterAltScreen(): void {
    if (this._altScreenActive) return
    this._altScreenActive = true
    this.write('\x1b[?1049h')
  }

  leaveAltScreen(): void {
    this.releaseAltScreen()
  }

  private releaseAltScreen(): void {
    if (!this._altScreenActive) return
    this._altScreenActive = false
    this.write('\x1b[?1049l')
  }

  get altScreenActive(): boolean {
    return this._altScreenActive
  }

  setMouseTracking(enabled: boolean): void {
    if (enabled === this._mouseTrackingActive) return
    this._mouseTrackingActive = enabled
    // ?1002 (button-event tracking) reports drag motion for in-app selection
    // but not hover, keeping passive mouse movement unreported.
    this.write(enabled ? '\x1b[?1002h\x1b[?1006h' : '\x1b[?1006l\x1b[?1002l')
  }

  get mouseTrackingActive(): boolean {
    return this._mouseTrackingActive
  }

  setTitle(title: string): void {
    // OSC 0;title BEL — set terminal window title
    process.stdout.write(`\x1b]0;${title}\x07`)
  }
}
