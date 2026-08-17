import type { Component } from '../tui.js'

/**
 * Transcript component — a role-labeled block list rendered as rows.
 * v1 keeps it as a plain line list; role labels and collapsible tool blocks
 * are layered on top of this base later.
 */
export class Transcript implements Component {
  private lines: string[] = []

  /** Append a rendered row to the transcript. */
  appendLine(line: string): void {
    this.lines.push(line)
  }

  /** Append multiple rows at once. */
  appendLines(lines: readonly string[]): void {
    this.lines.push(...lines)
  }

  clear(): void {
    this.lines = []
  }

  getLines(): readonly string[] {
    return this.lines
  }

  invalidate(): void {
    // No cached state to invalidate currently
  }

  render(_width: number): string[] {
    return [...this.lines]
  }
}
