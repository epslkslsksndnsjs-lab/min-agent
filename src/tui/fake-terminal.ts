// In-memory Terminal implementation for tests. Records the emitted byte
// stream and exposes hooks to inject input and resize events, so TUI behavior
// can be asserted without a real terminal.

import type { Terminal } from './terminal.js'

export class FakeTerminal implements Terminal {
  output = ''
  clipboard = ''
  lastOpenedLink: string | null = null
  private _columns: number
  private _rows: number
  private _kittyProtocolActive = false
  private _altScreenActive = false
  private _mouseTrackingActive = false
  private inputHandler?: (data: string) => void
  private resizeHandler?: () => void
  private stopped = false

  constructor(columns = 80, rows = 24) {
    this._columns = columns
    this._rows = rows
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.stopped = false
    this.inputHandler = onInput
    this.resizeHandler = onResize
  }

  stop(): void {
    this.stopped = true
    this.inputHandler = undefined
    this.resizeHandler = undefined
  }

  async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {
    // Nothing to drain in a fake terminal
  }

  write(data: string): void {
    this.output += data
  }

  get columns(): number {
    return this._columns
  }

  get rows(): number {
    return this._rows
  }

  setSize(columns: number, rows: number): void {
    this._columns = columns
    this._rows = rows
  }

  get kittyProtocolActive(): boolean {
    return this._kittyProtocolActive
  }

  /** Simulate a kitty protocol response from the terminal. */
  emitKittyProtocolResponse(): void {
    this._kittyProtocolActive = true
    this.inputHandler?.('\x1b[?1u')
  }

  moveBy(lines: number): void {
    if (lines > 0) {
      this.write(`\x1b[${lines}B`)
    } else if (lines < 0) {
      this.write(`\x1b[${-lines}A`)
    }
  }

  hideCursor(): void {
    this.write('\x1b[?25l')
  }

  showCursor(): void {
    this.write('\x1b[?25h')
  }

  clearLine(): void {
    this.write('\x1b[K')
  }

  clearFromCursor(): void {
    this.write('\x1b[J')
  }

  clearScreen(): void {
    this.write('\x1b[2J\x1b[H')
  }

  enterAltScreen(): void {
    if (this._altScreenActive) return
    this._altScreenActive = true
    this.write('\x1b[?1049h')
  }

  leaveAltScreen(): void {
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
    this.write(enabled ? '\x1b[?1002h\x1b[?1006h' : '\x1b[?1006l\x1b[?1002l')
  }

  get mouseTrackingActive(): boolean {
    return this._mouseTrackingActive
  }

  setTitle(title: string): void {
    this.write(`\x1b]0;${title}\x07`)
  }

  copyToClipboard(text: string): void {
    this.clipboard = text
  }

  openLink(url: string): void {
    this.lastOpenedLink = url
  }

  /** Simulate keyboard input arriving from the terminal. */
  emitInput(data: string): void {
    this.inputHandler?.(data)
  }

  /** Simulate a terminal resize (fires the registered resize handler). */
  emitResize(): void {
    this.resizeHandler?.()
  }

  get stoppedState(): boolean {
    return this.stopped
  }
}
