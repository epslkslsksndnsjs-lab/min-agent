import type { Component } from '../tui.js'
import { Footer } from './footer.js'
import { Input } from '../components/input.js'

/**
 * Input dock: the single-line input box with the footer pinned beneath it.
 * Rendered as the fullscreen dock so both stay at the bottom of the screen.
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
    return [...this.input.render(width), ...this.footer.render(width)]
  }
}
