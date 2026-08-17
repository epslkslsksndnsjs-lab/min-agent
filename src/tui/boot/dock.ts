import type { Component } from '../tui.js'
import { Footer } from './footer.js'
import { Input } from '../components/input.js'

/**
 * Input dock: the run-status line above the single-line input box. When the
 * status line is active it appears just above the prompt; when inactive the
 * prompt sits at the bottom of the screen.
 */
export class InputDock implements Component {
  private footer: Footer

  constructor(
    readonly input: Input,
    footer?: Footer,
  ) {
    this.footer = footer ?? new Footer()
  }

  getFooter(): Footer {
    return this.footer
  }

  invalidate(): void {
    this.input.invalidate()
    this.footer.invalidate()
  }

  render(width: number): string[] {
    const footerLines = this.footer.render(width)
    const inputLines = this.input.render(width)
    // When the status line is active, lift it a few rows above the prompt so
    // it reads as a status band rather than hugging the input line.
    if (footerLines.length > 0) {
      return [...footerLines, '', '', ...inputLines]
    }
    return inputLines
  }
}
