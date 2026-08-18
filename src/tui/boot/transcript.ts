import type { Component } from '../tui.js'
import { getKeybindings } from '../keybindings.js'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../utils.js'
import { bg, styleText } from './theme.js'

/**
 * Transcript block — one entry in the role-labeled conversation list.
 * `raw` keeps the v1 plain-line API working; the role blocks carry the
 * structured data the agent event stream maps into.
 */
export type TranscriptBlock =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; args: unknown; result: string | null; expanded: boolean; status: ToolStatus }
  | { kind: 'raw'; line: string }

export type ToolStatus = 'queued' | 'running' | 'done' | 'error'

// Status glyphs shown in front of the status word, like the upstream tool
// marker: a pulsing diamond while running, a green check on success, a red
// cross on failure, a dim dot while still queued.
const WORKING_ICON_FRAMES = ['◇', '◈', '◆', '◈'] as const

let pulseFrame = 0
/** Advance the running-tool animation frame (called by the render ticker). */
export function advanceToolPulse(): void {
  pulseFrame = (pulseFrame + 1) % WORKING_ICON_FRAMES.length
}

// Tool panel geometry — left/right padding inside the panel background.
const PANEL_PAD = 2

function toolPanelLine(line: string, width: number): string {
  const contentWidth = Math.max(1, width - PANEL_PAD * 2)
  const truncated = truncateToWidth(line, contentWidth, '')
  const padding = ' '.repeat(Math.max(0, contentWidth - visibleWidth(truncated)))
  const sidePad = ' '.repeat(PANEL_PAD)
  return bg('toolPanelBg', `${sidePad}${truncated}${padding}${sidePad}`)
}

function statusSegment(status: ToolStatus): string {
  switch (status) {
    case 'queued':
      return styleText('muted', 'queued')
    case 'running':
      return styleText('bashMode', `${WORKING_ICON_FRAMES[pulseFrame]} running`)
    case 'done':
      return styleText('success', 'done')
    case 'error':
      return styleText('error', 'error')
  }
}

function expandHint(): string {
  const key = getKeybindings().getKeys('tui.tools.expand')[0] ?? 'ctrl+o'
  return styleText('dim', `(${key} to expand)`)
}

/**
 * Transcript component — a role-labeled block list (You / Assistant / Tool)
 * rendered as wrapped rows. Assistant text streams into a single open block
 * until a user message, a tool call, or an explicit endTurn closes it.
 * Tool blocks are collapsible: collapsed they show only the status header so a
 * long result does not drown the conversation; the expand-all toggle flips
 * every tool block at once.
 */
export class Transcript implements Component {
  private blocks: TranscriptBlock[] = []
  private streamingAssistant: number | null = null // index of the open assistant block
  private lastToolIndex: number | null = null
  private toolsExpanded = false // expand-all state; new tool blocks inherit it
  /** Global transcript line -> tool block index, rebuilt every render (header rows only). */
  private lineToBlock = new Map<number, number>()

  /** Append a user message block. */
  addUser(text: string): void {
    this.closeStreaming()
    this.blocks.push({ kind: 'user', text })
  }

  /** Stream assistant text into the current Assistant block, opening one if needed. */
  appendAssistant(delta: string): void {
    if (!delta) return
    if (this.streamingAssistant === null || this.streamingAssistant >= this.blocks.length) {
      this.streamingAssistant = this.blocks.length
      this.blocks.push({ kind: 'assistant', text: '' })
    }
    const block = this.blocks[this.streamingAssistant]
    if (block?.kind === 'assistant') {
      block.text += delta
    }
  }

  /** Append a tool-call block; closes any open Assistant block. */
  addTool(name: string, args?: unknown): void {
    this.closeStreaming()
    this.blocks.push({ kind: 'tool', name, args: args ?? null, result: null, expanded: this.toolsExpanded, status: 'running' })
    this.lastToolIndex = this.blocks.length - 1
  }

  /** Attach a tool result to the last tool block and settle its status. */
  setToolResult(result: string, isError = result.startsWith('error:')): void {
    const block = this.lastToolIndex !== null ? this.blocks[this.lastToolIndex] : null
    if (block?.kind === 'tool') {
      block.result = result
      block.status = isError ? 'error' : 'done'
    }
  }

  /** Whether any tool block is still running (drives the render ticker). */
  hasRunning(): boolean {
    return this.blocks.some((b) => b.kind === 'tool' && b.status === 'running')
  }

  /** Tool block index at a global transcript line, or null when not a header row. */
  getToolBlockIndexAtLine(globalLine: number): number | null {
    return this.lineToBlock.get(globalLine) ?? null
  }

  /** Toggle a single tool block's expanded state. */
  toggleToolExpanded(index: number): void {
    const block = this.blocks[index]
    if (block?.kind === 'tool') block.expanded = !block.expanded
  }

  /** Whether new tool blocks start expanded (the expand-all state). */
  getToolsExpanded(): boolean {
    return this.toolsExpanded
  }

  /** Expand or collapse every tool block; new blocks inherit the state. */
  setToolsExpanded(expanded: boolean): void {
    this.toolsExpanded = expanded
    for (const block of this.blocks) {
      if (block.kind === 'tool') {
        block.expanded = expanded
      }
    }
  }

  /** Flip the expand-all state across every tool block. */
  toggleToolsExpanded(): void {
    this.setToolsExpanded(!this.toolsExpanded)
  }

  /** End of turn: close the streaming Assistant block so the next delta opens a new one. */
  endTurn(): void {
    this.closeStreaming()
  }

  private closeStreaming(): void {
    this.streamingAssistant = null
  }

  /** Append a raw, pre-rendered row (v1 API). */
  appendLine(line: string): void {
    this.blocks.push({ kind: 'raw', line })
  }

  /** Append multiple raw rows (v1 API). */
  appendLines(lines: readonly string[]): void {
    for (const line of lines) this.appendLine(line)
  }

  clear(): void {
    this.blocks = []
    this.streamingAssistant = null
    this.lastToolIndex = null
    this.lineToBlock.clear()
  }

  getBlocks(): readonly TranscriptBlock[] {
    return this.blocks
  }

  /** Raw rows only (v1 API) — role-labeled blocks are read via getBlocks(). */
  getLines(): readonly string[] {
    return this.blocks.filter((b): b is { kind: 'raw'; line: string } => b.kind === 'raw').map((b) => b.line)
  }

  invalidate(): void {
    // No cached state to invalidate currently
  }

  render(width: number): string[] {
    const lines: string[] = []
    this.lineToBlock.clear()
    for (let bi = 0; bi < this.blocks.length; bi++) {
      const block = this.blocks[bi]
      const startLine = lines.length
      switch (block.kind) {
        case 'raw':
          lines.push(block.line)
          break
        case 'user':
          this.renderLabeled('You: ', block.text, width, lines)
          break
        case 'assistant':
          this.renderLabeled('Assistant: ', block.text, width, lines)
          break
        case 'tool':
          this.renderTool(block, bi, width, lines)
          break
      }
      // First line of a tool block is its status header — map it for click-to-toggle.
      if (block.kind === 'tool' && lines.length > startLine) {
        this.lineToBlock.set(startLine, bi)
      }
    }
    return lines
  }

  private renderLabeled(label: string, text: string, width: number, out: string[]): void {
    const labelStyled = styleText('bold', label)
    const labelWidth = label.length
    if (!text) {
      out.push(truncateToWidth(labelStyled, width))
      return
    }
    const contentWidth = Math.max(1, width - labelWidth)
    const wrapped = wrapTextWithAnsi(text, contentWidth)
    out.push(truncateToWidth(labelStyled + wrapped[0], width))
    const indent = ' '.repeat(labelWidth)
    for (const line of wrapped.slice(1)) {
      out.push(truncateToWidth(indent + line, width))
    }
  }

  private renderTool(
    block: { name: string; args: unknown; result: string | null; expanded: boolean; status: ToolStatus },
    index: number,
    width: number,
    out: string[],
  ): void {
    const header = styleText('muted', block.name) + styleText('dim', ' · ') + statusSegment(block.status)

    if (!block.expanded) {
      // Only the latest tool block carries the expand hint — others stay terse.
      const isLatest = index === this.blocks.length - 1
      const hint = isLatest ? ` ${expandHint()}` : ''
      out.push(toolPanelLine(truncateToWidth(header + hint, width - PANEL_PAD * 2), width))
      return
    }

    out.push(toolPanelLine(truncateToWidth(header, width - PANEL_PAD * 2), width))
    out.push(toolPanelLine('', width))
    const indent = '  '
    if (block.args !== null && block.args !== undefined) {
      this.renderIndented(`args: ${this.formatValue(block.args)}`, indent, width, out)
    }
    if (block.result !== null) {
      this.renderIndented(`result: ${block.result}`, indent, width, out)
    }
  }

  private formatValue(value: unknown): string {
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  private renderIndented(text: string, indent: string, width: number, out: string[]): void {
    const contentWidth = Math.max(1, width - PANEL_PAD * 2 - indent.length)
    const wrapped = wrapTextWithAnsi(text, contentWidth)
    for (const line of wrapped) {
      out.push(toolPanelLine(indent + truncateToWidth(line, contentWidth), width))
    }
  }
}
