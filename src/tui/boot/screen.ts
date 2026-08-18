import { Input } from '../components/input.js'
import { getKeybindings } from '../keybindings.js'
import { TUI } from '../tui.js'
import type { Terminal } from '../terminal.js'
import { advanceToolPulse, Transcript } from './transcript.js'
import { Footer } from './footer.js'
import { InputDock } from './dock.js'
import { Header } from './header.js'

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
  footer.setRequestRender(() => tui.requestRender())
  tui.enterFullscreen({ scroll: [header, transcript], dock })

  // Expand-all toggle for collapsible tool blocks. Handled at the boot layer
  // so the generic TUI core stays unaware of transcript semantics.
  tui.addInputListener((data) => {
    if (getKeybindings().matches(data, 'tui.tools.expand')) {
      transcript.toggleToolsExpanded()
      tui.requestRender()
      return { consume: true }
    }
    return undefined
  })

  // Click a tool block's header to expand/collapse just that block.
  tui.onTranscriptClick = (component, localLine) => {
    if (component !== transcript) return
    const index = transcript.getToolBlockIndexAtLine(localLine)
    if (index !== null) {
      transcript.toggleToolExpanded(index)
      tui.requestRender()
    }
  }

  // Animate running-tool markers until every tool settles.
  tui.addPulseSource(() => {
    if (transcript.hasRunning()) {
      advanceToolPulse()
      return true
    }
    return false
  })

  return { tui, transcript, input, footer }
}
