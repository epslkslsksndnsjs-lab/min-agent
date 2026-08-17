// Minimal TUI implementation with differential rendering.

import { performance } from 'node:perf_hooks'
import { FullscreenViewport, type ScrollInfo } from './fullscreen.js'
import { getKeybindings } from './keybindings.js'
import { isKeyRelease } from './keys.js'
import { isMouseSequence } from './mouse.js'
import type { Terminal } from './terminal.js'
import {
  extractSegments,
  normalizeTerminalOutput,
  sliceByColumn,
  sliceWithWidth,
  visibleWidth,
} from './utils.js'

/**
 * Component interface — all components must implement this.
 */
export interface Component {
  /**
   * Render the component to lines for the given viewport width.
   * @param width - Current viewport width
   * @returns Array of strings, each representing a line
   */
  render(width: number): string[]

  /**
   * Optional handler for keyboard input when the component has focus.
   */
  handleInput?(data: string): void

  /**
   * If true, the component receives key release events (Kitty protocol).
   * Default is false — release events are filtered out.
   */
  wantsKeyRelease?: boolean

  /**
   * Invalidate any cached rendering state.
   */
  invalidate(): void
}

export interface TuiStopOptions {
  preserveAltScreen?: boolean
}

export interface FullscreenOptions {
  scroll: Component[]
  dock: Component
  mouse?: boolean
  viewportControls?: boolean
}

interface ExitFullscreenOptions {
  flush?: boolean
  leaveAltScreen?: boolean
}

type InputListenerResult = { consume?: boolean; data?: string } | undefined
type InputListener = (data: string) => InputListenerResult

/**
 * Interface for components that can receive focus and display a hardware
 * cursor. When focused, the component should emit CURSOR_MARKER at the cursor
 * position in its render output; the TUI finds this marker and positions the
 * hardware cursor there for proper IME candidate window positioning.
 */
export interface Focusable {
  /** Set by the TUI when focus changes. Component should emit CURSOR_MARKER when true. */
  focused: boolean
}

/** Type guard to check if a component implements Focusable. */
export function isFocusable(component: Component | null): component is Component & Focusable {
  return component !== null && 'focused' in component
}

/**
 * Cursor position marker — APC (Application Program Command) sequence.
 * Zero-width escape sequence that terminals ignore. Components emit this at
 * the cursor position when focused; the TUI finds and strips it, then
 * positions the hardware cursor there.
 */
export const CURSOR_MARKER = '\x1b_pi:c\x07'

/**
 * Container — a component that contains other components.
 */
export class Container implements Component {
  children: Component[] = []

  addChild(component: Component): void {
    this.children.push(component)
  }

  removeChild(component: Component): void {
    const index = this.children.indexOf(component)
    if (index !== -1) {
      this.children.splice(index, 1)
    }
  }

  clear(): void {
    this.children = []
  }

  invalidate(): void {
    for (const child of this.children) {
      child.invalidate?.()
    }
  }

  render(width: number): string[] {
    const lines: string[] = []
    for (const child of this.children) {
      const childLines = child.render(width)
      for (const line of childLines) {
        lines.push(line)
      }
    }
    return lines
  }
}

/**
 * TUI — main class for managing the terminal UI with differential rendering.
 */
export class TUI extends Container {
  public terminal: Terminal
  private previousLines: string[] = []
  private previousWidth = 0
  private previousHeight = 0
  private focusedComponent: Component | null = null
  private inputListeners = new Set<InputListener>()

  private renderRequested = false
  private renderTimer: NodeJS.Timeout | undefined
  private lastRenderAt = 0
  private static readonly MIN_RENDER_INTERVAL_MS = 16
  private cursorRow = 0 // Logical cursor row (end of rendered content)
  private hardwareCursorRow = 0 // Actual terminal cursor row (may differ due to IME positioning)
  private showHardwareCursor = process.env.MIN_AGENT_HARDWARE_CURSOR === '1'
  private clearOnShrink = process.env.MIN_AGENT_CLEAR_ON_SHRINK === '1' // Clear empty rows when content shrinks (default: off)
  private maxLinesRendered = 0 // Terminal working area (max lines ever rendered)
  private previousViewportTop = 0 // Previous viewport top for resize-aware cursor moves
  private fullRedrawCount = 0
  private preserveViewportOnNextRender = false // One-shot: repaint the visible viewport in place
  private stopped = false

  private fullscreen: {
    viewport: FullscreenViewport
    scroll: Component[]
    dock: Component
    mouse: boolean
    viewportControls: boolean
    inlineState: {
      previousLines: string[]
      previousWidth: number
      previousHeight: number
      cursorRow: number
      hardwareCursorRow: number
      maxLinesRendered: number
      previousViewportTop: number
    }
  } | null = null

  constructor(terminal: Terminal, showHardwareCursor?: boolean) {
    super()
    this.terminal = terminal
    if (showHardwareCursor !== undefined) {
      this.showHardwareCursor = showHardwareCursor
    }
  }

  get fullRedraws(): number {
    return this.fullRedrawCount
  }

  getShowHardwareCursor(): boolean {
    return this.showHardwareCursor
  }

  setShowHardwareCursor(enabled: boolean): void {
    if (this.showHardwareCursor === enabled) return
    this.showHardwareCursor = enabled
    if (!enabled) {
      this.terminal.hideCursor()
    }
    this.requestRender()
  }

  getClearOnShrink(): boolean {
    return this.clearOnShrink
  }

  /**
   * Set whether to trigger a full re-render when content shrinks.
   * When true, empty rows are cleared when content shrinks; when false, empty
   * rows remain (reduces redraws on slower terminals).
   */
  setClearOnShrink(enabled: boolean): void {
    this.clearOnShrink = enabled
  }

  setFocus(component: Component | null): void {
    // Clear focused flag on old component
    if (isFocusable(this.focusedComponent)) {
      this.focusedComponent.focused = false
    }

    this.focusedComponent = component

    // Set focused flag on new component
    if (isFocusable(component)) {
      component.focused = true
    }
  }

  start(): void {
    this.stopped = false
    this.terminal.start(
      (data) => this.handleInput(data),
      () => this.requestRender(),
    )
    this.terminal.hideCursor()
    this.requestRender()
  }

  addInputListener(listener: InputListener): () => void {
    this.inputListeners.add(listener)
    return () => {
      this.inputListeners.delete(listener)
    }
  }

  removeInputListener(listener: InputListener): void {
    this.inputListeners.delete(listener)
  }

  stop(options: TuiStopOptions = {}): void {
    const preserveAltScreen = options.preserveAltScreen === true && this.terminal.altScreenActive
    this.exitFullscreen({ flush: !preserveAltScreen, leaveAltScreen: !preserveAltScreen })
    this.stopped = true
    if (this.renderTimer) {
      clearTimeout(this.renderTimer)
      this.renderTimer = undefined
    }
    // Move the cursor to the end of the content to prevent overwriting/artifacts on exit
    if (!preserveAltScreen && this.previousLines.length > 0) {
      const targetRow = this.previousLines.length // Line after the last content
      const lineDiff = targetRow - this.hardwareCursorRow
      if (lineDiff > 0) {
        this.terminal.write(`\x1b[${lineDiff}B`)
      } else if (lineDiff < 0) {
        this.terminal.write(`\x1b[${-lineDiff}A`)
      }
      this.terminal.write('\r\n')
    }

    if (preserveAltScreen) {
      this.terminal.hideCursor()
    } else {
      this.terminal.showCursor()
    }
    this.terminal.stop()
  }

  requestRender(force = false): void {
    if (force) {
      this.fullscreen?.viewport.reset()
      // Keep the previous frame metadata so the forced full repaint can clean
      // up only the visible viewport and avoid touching scrollback.
      this.previousWidth = -1 // -1 triggers widthChanged, forcing a full clear
      this.cursorRow = 0
      this.hardwareCursorRow = 0
      this.maxLinesRendered = 0
      if (this.renderTimer) {
        clearTimeout(this.renderTimer)
        this.renderTimer = undefined
      }
      this.renderRequested = true
      process.nextTick(() => {
        if (this.stopped || !this.renderRequested) {
          return
        }
        this.renderRequested = false
        this.lastRenderAt = performance.now()
        this.doRender()
      })
      return
    }
    if (this.renderRequested) return
    this.renderRequested = true
    process.nextTick(() => this.scheduleRender())
  }

  /**
   * Request a render that keeps the user anchored at their current scroll
   * position. Normally, when content above the visible viewport changes, the
   * renderer may fall back to a full screen redraw that replays the entire
   * transcript from the top. For deliberate toggles (e.g. expanding all tool
   * output) that is jarring: it scrolls to the top and reprints everything.
   * This instead repaints only the visible viewport in place, leaving
   * scrollback untouched.
   */
  requestRenderPreservingViewport(): void {
    this.preserveViewportOnNextRender = true
    this.requestRender()
  }

  /**
   * Render a scrollable transcript window on the alternate screen with `dock`
   * pinned to the bottom rows; the primary screen stays untouched until exit.
   * Wheel tracking is enabled blind — probing is not viable (tmux never
   * answers DECRQM) and unsupporting terminals ignore the mode-sets.
   */
  enterFullscreen(options: FullscreenOptions): void {
    if (this.fullscreen) return
    this.fullscreen = {
      viewport: new FullscreenViewport(),
      scroll: options.scroll,
      dock: options.dock,
      mouse: options.mouse !== false,
      viewportControls: options.viewportControls !== false,
      inlineState: {
        previousLines: this.previousLines,
        previousWidth: this.previousWidth,
        previousHeight: this.previousHeight,
        cursorRow: this.cursorRow,
        hardwareCursorRow: this.hardwareCursorRow,
        maxLinesRendered: this.maxLinesRendered,
        previousViewportTop: this.previousViewportTop,
      },
    }
    this.terminal.enterAltScreen()
    this.terminal.hideCursor()
    this.terminal.setMouseTracking(this.fullscreen.mouse)
    this.requestRender()
  }

  /**
   * Leave fullscreen. The inline differ resumes against the entry snapshot,
   * so content produced while fullscreen flows into native scrollback.
   */
  exitFullscreen(options: ExitFullscreenOptions = {}): void {
    if (!this.fullscreen) return
    const { inlineState } = this.fullscreen
    this.fullscreen = null
    this.terminal.setMouseTracking(false)
    if (options.leaveAltScreen !== false) {
      this.terminal.leaveAltScreen()
    }
    this.previousLines = inlineState.previousLines
    this.previousWidth = inlineState.previousWidth
    this.previousHeight = inlineState.previousHeight
    this.cursorRow = inlineState.cursorRow
    this.hardwareCursorRow = inlineState.hardwareCursorRow
    this.maxLinesRendered = inlineState.maxLinesRendered
    this.previousViewportTop = inlineState.previousViewportTop
    // synchronous so the flush also happens on shutdown, where a scheduled render never fires
    if (options.flush !== false && !this.stopped) {
      this.doRender()
    }
  }

  isFullscreen(): boolean {
    return this.fullscreen !== null
  }

  /** Scroll the fullscreen transcript window (negative = up). */
  scrollBy(lines: number): void {
    if (!this.fullscreen) return
    this.fullscreen.viewport.scrollBy(lines)
    this.requestRender()
  }

  scrollToTop(): void {
    if (!this.fullscreen) return
    this.fullscreen.viewport.scrollToTop()
    this.requestRender()
  }

  scrollToBottom(): void {
    if (!this.fullscreen) return
    this.fullscreen.viewport.scrollToBottom()
    this.requestRender()
  }

  /** Scroll state of the fullscreen window, or null when not fullscreen. */
  getScrollInfo(): ScrollInfo | null {
    return this.fullscreen?.viewport.scrollInfo() ?? null
  }

  private scheduleRender(): void {
    if (this.stopped || this.renderTimer || !this.renderRequested) {
      return
    }
    const elapsed = performance.now() - this.lastRenderAt
    const delay = Math.max(0, TUI.MIN_RENDER_INTERVAL_MS - elapsed)
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined
      if (this.stopped || !this.renderRequested) {
        return
      }
      this.renderRequested = false
      this.lastRenderAt = performance.now()
      this.doRender()
      if (this.renderRequested) {
        this.scheduleRender()
      }
    }, delay)
  }

  private handleInput(data: string): void {
    if (this.inputListeners.size > 0) {
      let current = data
      for (const listener of this.inputListeners) {
        const result = listener(current)
        if (result?.consume) {
          return
        }
        if (result?.data !== undefined) {
          current = result.data
        }
      }
      if (current.length === 0) {
        return
      }
      data = current
    }

    if (this.fullscreen && this.handleFullscreenInput(data)) {
      return
    }

    // Pass input to the focused component (including Ctrl+C). The focused
    // component can decide how to handle Ctrl+C.
    if (this.focusedComponent?.handleInput) {
      // Filter out key release events unless the component opts in
      if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
        return
      }
      this.focusedComponent.handleInput(data)
      this.requestRender()
    }
  }

  // Mouse reports are always consumed (nothing downstream understands them);
  // viewport keys are skipped only while the fullscreen is inactive.
  private handleFullscreenInput(data: string): boolean {
    const fullscreen = this.fullscreen
    if (!fullscreen) return false

    if (isMouseSequence(data)) {
      // consumed even when disabled — mouse reports are garbage downstream
      return true
    }

    if (!fullscreen.viewportControls) return false

    const keybindings = getKeybindings()
    if (keybindings.matches(data, 'tui.viewport.pageUp')) {
      this.scrollBy(-fullscreen.viewport.pageSize())
      return true
    }
    if (keybindings.matches(data, 'tui.viewport.pageDown')) {
      this.scrollBy(fullscreen.viewport.pageSize())
      return true
    }
    if (keybindings.matches(data, 'tui.viewport.top')) {
      this.scrollToTop()
      return true
    }
    if (keybindings.matches(data, 'tui.viewport.follow')) {
      this.scrollToBottom()
      return true
    }
    return false
  }

  private static readonly SEGMENT_RESET = '\x1b[0m\x1b]8;;\x07'

  private applyLineResets(lines: string[]): string[] {
    const reset = TUI.SEGMENT_RESET
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      lines[i] = normalizeTerminalOutput(line) + reset
    }
    return lines
  }

  /** Splice overlay content into a base line at a specific column. Single-pass optimized. */
  private compositeLineAt(
    baseLine: string,
    overlayLine: string,
    startCol: number,
    overlayWidth: number,
    totalWidth: number,
  ): string {
    // Single pass through baseLine extracts both before and after segments
    const afterStart = startCol + overlayWidth
    const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true)

    // Extract overlay with width tracking (strict=true to exclude wide chars at boundary)
    const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true)

    // Pad segments to target widths
    const beforePad = Math.max(0, startCol - base.beforeWidth)
    const overlayPad = Math.max(0, overlayWidth - overlay.width)
    const actualBeforeWidth = Math.max(startCol, base.beforeWidth)
    const actualOverlayWidth = Math.max(overlayWidth, overlay.width)
    const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth)
    const afterPad = Math.max(0, afterTarget - base.afterWidth)

    // Compose result
    const r = TUI.SEGMENT_RESET
    const result =
      base.before +
      ' '.repeat(beforePad) +
      r +
      overlay.text +
      ' '.repeat(overlayPad) +
      r +
      base.after +
      ' '.repeat(afterPad)

    // Always verify and truncate to terminal width — the final safeguard
    // against width overflow which would crash the TUI. Width tracking can
    // drift from the actual visible width due to complex ANSI sequences or
    // wide characters at segment boundaries.
    const resultWidth = visibleWidth(result)
    if (resultWidth <= totalWidth) {
      return result
    }
    return sliceByColumn(result, 0, totalWidth, true)
  }

  /**
   * Find and extract the cursor position from rendered lines. Searches for
   * CURSOR_MARKER, calculates its position, and strips it from the output.
   * Only scans the bottom terminal-height lines (visible viewport).
   */
  private extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
    const viewportTop = Math.max(0, lines.length - height)
    for (let row = lines.length - 1; row >= viewportTop; row--) {
      const line = lines[row]
      const markerIndex = line.indexOf(CURSOR_MARKER)
      if (markerIndex !== -1) {
        const beforeMarker = line.slice(0, markerIndex)
        const col = visibleWidth(beforeMarker)

        // Strip the marker from the line
        lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length)

        return { row, col }
      }
    }
    return null
  }

  private renderFullscreen(): void {
    const fullscreen = this.fullscreen
    if (!fullscreen) return
    const width = this.terminal.columns
    const height = this.terminal.rows

    const transcript: string[] = []
    for (const component of fullscreen.scroll) {
      const componentLines = component.render(width)
      transcript.push(...componentLines)
    }
    const dock = fullscreen.dock.render(width)

    let frame = fullscreen.viewport.composeFrame(transcript, dock, height)
    const scrollInfo = fullscreen.viewport.scrollInfo()
    if (fullscreen.viewportControls && !scrollInfo.following) {
      // Follow hint composited over the bottom of the transcript window,
      // just above the dock.
      const followKey = getKeybindings().getKeys('tui.viewport.follow')[0] ?? 'ctrl+shift+down'
      const label = ` ${followKey} to follow `
      const labelWidth = visibleWidth(label)
      const row = fullscreen.viewport.windowHeight() - 1
      if (row >= 0 && row < frame.length && labelWidth <= width) {
        const col = Math.floor((width - labelWidth) / 2)
        frame[row] = this.compositeLineAt(frame[row], `\x1b[7m${label}\x1b[27m`, col, labelWidth, width)
      }
    }
    const cursorPos = this.extractCursorPosition(frame, height)
    this.applyLineResets(frame)
    fullscreen.viewport.paint((data) => this.terminal.write(data), frame, width, height, cursorPos)
    if (cursorPos && this.showHardwareCursor) {
      this.terminal.showCursor()
    } else {
      this.terminal.hideCursor()
    }
  }

  private doRender(): void {
    if (this.stopped) return
    if (this.fullscreen) {
      this.preserveViewportOnNextRender = false
      this.renderFullscreen()
      return
    }
    // One-shot: consume here so it never leaks into a later render.
    const preserveViewport = this.preserveViewportOnNextRender
    this.preserveViewportOnNextRender = false
    const width = this.terminal.columns
    const height = this.terminal.rows
    const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width
    const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height
    const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height
    let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop
    let viewportTop = prevViewportTop
    let hardwareCursorRow = this.hardwareCursorRow
    const computeLineDiff = (targetRow: number): number => {
      const currentScreenRow = hardwareCursorRow - prevViewportTop
      const targetScreenRow = targetRow - viewportTop
      return targetScreenRow - currentScreenRow
    }

    // Render all components to get new lines
    let newLines = this.render(width)

    // Extract cursor position before applying line resets (marker must be found first)
    const cursorPos = this.extractCursorPosition(newLines, height)

    newLines = this.applyLineResets(newLines)

    // Helper to clear the viewport and repaint the current screen. Do not
    // clear terminal scrollback: users rely on it to read long prior messages.
    const fullRender = (clear: boolean, preserveViewportFlag = false): void => {
      this.fullRedrawCount += 1
      let buffer = '\x1b[?2026h' // Begin synchronized output

      // Viewport-preserving repaint: rewrite only the visible viewport in
      // place, leaving terminal scrollback untouched. Keeps the user anchored
      // at their current focus instead of replaying the whole (now-resized)
      // transcript from the top. Only meaningful when there is a previous
      // frame on screen to paint over.
      if (preserveViewportFlag && this.previousLines.length > 0) {
        const windowStart = Math.max(0, newLines.length - height)
        const visibleCount = newLines.length - windowStart
        const prevScreenRows = Math.min(height, this.previousLines.length)
        // Move the hardware cursor up to the top of the visible screen. Use
        // the local prevViewportTop (height-adjusted earlier in doRender)
        // rather than the field, so the move stays consistent with the rest
        // of the render when the terminal height changed this frame.
        const screenRow = Math.max(0, Math.min(prevScreenRows - 1, this.hardwareCursorRow - prevViewportTop))
        if (screenRow > 0) buffer += `\x1b[${screenRow}A`
        buffer += '\r'
        // Clear the top row up front: the loop below clears it on its first
        // iteration, but when there is no content (visibleCount === 0) the
        // loop never runs and the leftover-clear moves down before clearing,
        // which would leave row 0 stale.
        if (visibleCount === 0) buffer += '\x1b[2K'
        for (let i = 0; i < visibleCount; i++) {
          if (i > 0) buffer += '\r\n'
          buffer += '\x1b[2K' // Clear current line
          buffer += newLines[windowStart + i]
        }
        // Clear any rows the previous frame used below the new content. Row 0
        // is already occupied (by content, or by the visibleCount === 0 clear
        // above), so only clear the rows below it — clamping with
        // max(visibleCount, 1) avoids emitting a newline past the last screen
        // row, which would scroll the terminal.
        if (visibleCount < prevScreenRows) {
          const leftover = prevScreenRows - Math.max(visibleCount, 1)
          for (let i = 0; i < leftover; i++) {
            buffer += '\r\n\x1b[2K'
          }
          if (leftover > 0) buffer += `\x1b[${leftover}A` // Back up to the last content row
        }
        buffer += '\x1b[?2026l' // End synchronized output
        this.terminal.write(buffer)
        this.cursorRow = Math.max(0, newLines.length - 1)
        this.hardwareCursorRow = this.cursorRow
        // Reset (not just grow) the high-water mark to the repainted content,
        // mirroring the full-redraw path. Otherwise a preserving collapse
        // leaves maxLinesRendered inflated, and the next plain render would
        // re-trigger clearOnShrink.
        this.maxLinesRendered = newLines.length
        this.previousViewportTop = windowStart
        this.positionHardwareCursor(cursorPos, newLines.length)
        this.previousLines = newLines
        this.previousWidth = width
        this.previousHeight = height
        return
      }

      const renderStart = clear && this.previousLines.length > 0 ? Math.max(0, newLines.length - height) : 0
      if (clear) {
        buffer += '\x1b[2J\x1b[H' // Clear screen and home while preserving scrollback
      }
      for (let i = renderStart; i < newLines.length; i++) {
        if (i > renderStart) buffer += '\r\n'
        buffer += newLines[i]
      }
      buffer += '\x1b[?2026l' // End synchronized output
      this.terminal.write(buffer)
      this.cursorRow = Math.max(0, newLines.length - 1)
      this.hardwareCursorRow = this.cursorRow
      // Reset max lines when clearing, otherwise track growth
      if (clear) {
        this.maxLinesRendered = newLines.length
      } else {
        this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length)
      }
      const bufferLength = Math.max(height, newLines.length)
      this.previousViewportTop = Math.max(0, bufferLength - height)
      this.positionHardwareCursor(cursorPos, newLines.length)
      this.previousLines = newLines
      this.previousWidth = width
      this.previousHeight = height
    }

    // First render — just output everything without clearing (assumes clean screen)
    if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
      fullRender(false)
      return
    }

    // Width changes always need a full re-render because wrapping changes
    if (widthChanged) {
      fullRender(true)
      return
    }

    // Height changes normally need a full re-render to keep the visible viewport aligned
    if (heightChanged) {
      fullRender(true)
      return
    }

    // Content shrunk below the working area — re-render to clear empty rows
    if (this.clearOnShrink && newLines.length < this.maxLinesRendered) {
      fullRender(true, preserveViewport)
      return
    }

    // Find first and last changed lines
    let firstChanged = -1
    let lastChanged = -1
    const maxLines = Math.max(newLines.length, this.previousLines.length)
    for (let i = 0; i < maxLines; i++) {
      const oldLine = i < this.previousLines.length ? this.previousLines[i] : ''
      const newLine = i < newLines.length ? newLines[i] : ''

      if (oldLine !== newLine) {
        if (firstChanged === -1) {
          firstChanged = i
        }
        lastChanged = i
      }
    }
    const appendedLines = newLines.length > this.previousLines.length
    if (appendedLines) {
      if (firstChanged === -1) {
        firstChanged = this.previousLines.length
      }
      lastChanged = newLines.length - 1
    }
    const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0

    // No changes — but still need to update the hardware cursor position if it moved
    if (firstChanged === -1) {
      this.positionHardwareCursor(cursorPos, newLines.length)
      this.previousViewportTop = prevViewportTop
      this.previousHeight = height
      return
    }

    // All changes are in deleted lines (nothing to render, just clear)
    if (firstChanged >= newLines.length) {
      if (this.previousLines.length > newLines.length) {
        let buffer = '\x1b[?2026h'
        // Move to end of new content (clamp to 0 for empty content)
        const targetRow = Math.max(0, newLines.length - 1)
        if (targetRow < prevViewportTop) {
          fullRender(true, preserveViewport)
          return
        }
        const lineDiff = computeLineDiff(targetRow)
        if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`
        else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`
        buffer += '\r'
        // Clear extra lines without scrolling
        const extraLines = this.previousLines.length - newLines.length
        if (extraLines > height) {
          fullRender(true, preserveViewport)
          return
        }
        if (extraLines > 0) {
          buffer += '\x1b[1B'
        }
        for (let i = 0; i < extraLines; i++) {
          buffer += '\r\x1b[2K'
          if (i < extraLines - 1) buffer += '\x1b[1B'
        }
        if (extraLines > 0) {
          buffer += `\x1b[${extraLines}A`
        }
        buffer += '\x1b[?2026l'
        this.terminal.write(buffer)
        this.cursorRow = targetRow
        this.hardwareCursorRow = targetRow
      }
      this.positionHardwareCursor(cursorPos, newLines.length)
      this.previousLines = newLines
      this.previousWidth = width
      this.previousHeight = height
      this.previousViewportTop = prevViewportTop
      return
    }

    // Differential rendering can only touch what was actually visible. If the
    // first changed line is above the previous viewport, the rows on screen no
    // longer correspond to newLines, so we have to repaint. When the transcript
    // is taller than the viewport, repaint only the visible window in place
    // instead of replaying the whole transcript (which would flicker and
    // scroll from the top). Short transcripts that fit on screen keep the
    // cheap full redraw. Only do this while the transcript is growing (the
    // streaming case); a shrink still needs a full screen redraw since the
    // removed lines are stale in scrollback above the visible window.
    if (firstChanged < prevViewportTop) {
      const preserveScrollback = newLines.length > height && newLines.length >= this.previousLines.length
      fullRender(true, preserveScrollback || preserveViewport)
      return
    }

    // Render from first changed line to end
    let buffer = '\x1b[?2026h' // Begin synchronized output
    const prevViewportBottom = prevViewportTop + height - 1
    const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged
    if (moveTargetRow > prevViewportBottom) {
      const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop))
      const moveToBottom = height - 1 - currentScreenRow
      if (moveToBottom > 0) {
        buffer += `\x1b[${moveToBottom}B`
      }
      const scroll = moveTargetRow - prevViewportBottom
      buffer += '\r\n'.repeat(scroll)
      prevViewportTop += scroll
      viewportTop += scroll
      hardwareCursorRow = moveTargetRow
    }

    // Move cursor to first changed line (use hardwareCursorRow for actual position)
    const lineDiff = computeLineDiff(moveTargetRow)
    if (lineDiff > 0) {
      buffer += `\x1b[${lineDiff}B` // Move down
    } else if (lineDiff < 0) {
      buffer += `\x1b[${-lineDiff}A` // Move up
    }

    buffer += appendStart ? '\r\n' : '\r' // Move to column 0

    // Only render changed lines (firstChanged to lastChanged), not all lines
    // to end. This reduces flicker when only a single line changes (e.g. a
    // spinner animation).
    const renderEnd = Math.min(lastChanged, newLines.length - 1)
    for (let i = firstChanged; i <= renderEnd; i++) {
      if (i > firstChanged) buffer += '\r\n'
      buffer += '\x1b[2K' // Clear current line
      const line = newLines[i]
      if (visibleWidth(line) > width) {
        // Clean up terminal state before throwing
        this.stop()

        throw new Error(
          `Rendered line ${i} exceeds terminal width (${visibleWidth(line)} > ${width}). ` +
            'This is likely caused by a TUI component not truncating its output. ' +
            'Use visibleWidth() to measure and truncateToWidth() to truncate lines.',
        )
      }
      buffer += line
    }

    // Track where the cursor ended up after rendering
    let finalCursorRow = renderEnd

    // If we had more lines before, clear them and move cursor back
    if (this.previousLines.length > newLines.length) {
      // Move to end of new content first if we stopped before it
      if (renderEnd < newLines.length - 1) {
        const moveDown = newLines.length - 1 - renderEnd
        buffer += `\x1b[${moveDown}B`
        finalCursorRow = newLines.length - 1
      }
      const extraLines = this.previousLines.length - newLines.length
      for (let i = newLines.length; i < this.previousLines.length; i++) {
        buffer += '\r\n\x1b[2K'
      }
      // Move cursor back to end of new content
      buffer += `\x1b[${extraLines}A`
    }

    buffer += '\x1b[?2026l' // End synchronized output

    // Write entire buffer at once
    this.terminal.write(buffer)

    // Track cursor position for next render
    // cursorRow tracks end of content (for viewport calculation)
    // hardwareCursorRow tracks actual terminal cursor position (for movement)
    this.cursorRow = Math.max(0, newLines.length - 1)
    this.hardwareCursorRow = finalCursorRow
    // Track the terminal's working area (grows but doesn't shrink unless cleared)
    this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length)
    this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1)

    // Position hardware cursor for IME
    this.positionHardwareCursor(cursorPos, newLines.length)

    this.previousLines = newLines
    this.previousWidth = width
    this.previousHeight = height
  }

  /**
   * Position the hardware cursor for the IME candidate window.
   */
  private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
    if (!cursorPos || totalLines <= 0) {
      this.terminal.hideCursor()
      return
    }

    // Clamp cursor position to a valid range
    const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1))
    const targetCol = Math.max(0, cursorPos.col)

    // Move cursor from current position to target
    const rowDelta = targetRow - this.hardwareCursorRow
    let buffer = ''
    if (rowDelta > 0) {
      buffer += `\x1b[${rowDelta}B` // Move down
    } else if (rowDelta < 0) {
      buffer += `\x1b[${-rowDelta}A` // Move up
    }
    // Move to absolute column (1-indexed)
    buffer += `\x1b[${targetCol + 1}G`

    if (buffer) {
      this.terminal.write(buffer)
    }

    this.hardwareCursorRow = targetRow
    if (this.showHardwareCursor) {
      this.terminal.showCursor()
    } else {
      this.terminal.hideCursor()
    }
  }
}
