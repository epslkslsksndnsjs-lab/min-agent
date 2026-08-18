// Minimal ANSI styling helpers for boot components.

export type TextStyle =
  | 'dim'
  | 'muted'
  | 'accent'
  | 'bold'
  | 'success'
  | 'error'
  | 'warning'
  | 'bashMode'
  | 'toolTitle'
  | 'toolOutput'

// Foreground colors. Names mirror the upstream palette so component code reads
// the same way; values are fixed for the boot theme (no runtime theme swap).
const STYLE_CODES: Record<TextStyle, string> = {
  dim: '\x1b[2m',
  muted: '\x1b[90m',
  accent: '\x1b[36m',
  bold: '\x1b[1m',
  success: '\x1b[32m',
  error: '\x1b[31m',
  warning: '\x1b[33m',
  bashMode: '\x1b[35m',
  toolTitle: '\x1b[96m',
  toolOutput: '\x1b[90m',
}

export type BgStyle = 'toolPanelBg'

// Subtle surface behind tool blocks so each one reads as a unit. A dark 256
// color works on both light and dark terminals without inverting text.
const BG_CODES: Record<BgStyle, string> = {
  toolPanelBg: '\x1b[48;5;235m',
}

const RESET = '\x1b[0m'

/** Wrap text in an ANSI foreground style, resetting afterwards. */
export function styleText(style: TextStyle, text: string): string {
  return `${STYLE_CODES[style]}${text}${RESET}`
}

/** Wrap text in an ANSI background style, resetting afterwards. */
export function bg(style: BgStyle, text: string): string {
  return `${BG_CODES[style]}${text}${RESET}`
}
