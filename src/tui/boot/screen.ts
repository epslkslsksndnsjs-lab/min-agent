import { Input } from '../components/input.js'
import { TUI } from '../tui.js'
import type { Terminal } from '../terminal.js'
import { Footer } from './footer.js'
import { InputDock } from './dock.js'
import { Header } from './header.js'
import { Transcript } from './transcript.js'

export interface BootScreenOptions {
  /** Model id shown in the header (may be undefined before config is known). */
  model?: string
  /** Working directory shown in the header. */
  cwd: string
  /** Wordmark text (defaults to "min-agent"). */
  wordmark?: string
  /** Start hint shown in the header. */
  startHint?: string
}

export interface BootScreen {
  tui: TUI
  transcript: Transcript
  input: Input
  footer: Footer
}

/**
 * Compose the boot screen: header + empty transcript in the scroll area,
 * input dock + footer pinned to the bottom, on the alternate screen.
 */
export function createBootScreen(terminal: Terminal, options: BootScreenOptions): BootScreen {
  const transcript = new Transcript()
  const header = new Header(
    () => options.model,
    () => options.cwd,
    { wordmark: options.wordmark, startHint: options.startHint },
  )
  const input = new Input()
  const footer = new Footer()
  const dock = new InputDock(input, footer)

  const tui = new TUI(terminal)
  tui.setFocus(input)
  tui.enterFullscreen({ scroll: [header, transcript], dock })

  return { tui, transcript, input, footer }
}
