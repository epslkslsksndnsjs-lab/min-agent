import type { Component } from '../tui.js'
import { truncateToWidth, wrapTextWithAnsi } from '../utils.js'
import { styleText } from './theme.js'

/**
 * Transcript block — one entry in the role-labeled conversation list.
 * `raw` keeps the v1 plain-line API working; the role blocks carry the
 * structured data the agent event stream maps into.
 */
export type TranscriptBlock =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; args: unknown; result: string | null }
  | { kind: 'raw'; line: string }

/**
 * Transcript component — a role-labeled block list (You / Assistant / Tool)
 * rendered as wrapped rows. Assistant text streams into a single open block
 * until a user message, a tool call, or an explicit endTurn closes it.
 */
export class Transcript implements Component {
  private blocks: TranscriptBlock[] = []
  private streamingAssistant: number | null = null // index of the open assistant block
  private lastToolIndex: number | null = null

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
    this.blocks.push({ kind: 'tool', name, args: args ?? null, result: null })
    this.lastToolIndex = this.blocks.length - 1
  }

  /** Attach a tool result to the last tool block. */
  setToolResult(result: string): void {
    const block = this.lastToolIndex !== null ? this.blocks[this.lastToolIndex] : null
    if (block?.kind === 'tool') {
      block.result = result
    }
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
    for (const block of this.blocks) {
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
          this.renderTool(block, width, lines)
          break
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
    block: { name: string; args: unknown; result: string | null },
    width: number,
    out: string[],
  ): void {
    out.push(truncateToWidth(styleText('bold', 'Tool: ') + block.name, width))
    const indent = '  '
    if (block.args !== null && block.args !== undefined) {
      this.renderIndented(JSON.stringify(block.args), indent, width, out)
    }
    if (block.result !== null) {
      this.renderIndented(block.result, indent, width, out)
    }
  }

  private renderIndented(text: string, indent: string, width: number, out: string[]): void {
    const contentWidth = Math.max(1, width - indent.length)
    const wrapped = wrapTextWithAnsi(text, contentWidth)
    for (const line of wrapped) {
      out.push(indent + truncateToWidth(line, contentWidth))
    }
  }
}
