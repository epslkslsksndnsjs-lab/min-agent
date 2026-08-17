import type { Component } from '../tui.js'
import { styleText } from './theme.js'

/**
 * Footer placeholder pinned to the bottom of the dock. The run-status line
 * (`↓ {tokens} tokens · {elapsed}`) is wired up when the agent event stream
 * is connected; until then it renders an empty row so the layout is stable.
 */
export class Footer implements Component {
  private text: string = ''

  setText(text: string): void {
    this.text = text
  }

  getText(): string {
    return this.text
  }

  invalidate(): void {
    // No cached state to invalidate currently
  }

  render(_width: number): string[] {
    return [this.text === '' ? '' : styleText('muted', this.text)]
  }
}
