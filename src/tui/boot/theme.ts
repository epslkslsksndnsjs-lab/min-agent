// Minimal ANSI styling helpers for boot components.

export type TextStyle = 'dim' | 'muted' | 'accent' | 'bold'

const STYLE_CODES: Record<TextStyle, string> = {
  dim: '\x1b[2m',
  muted: '\x1b[90m',
  accent: '\x1b[36m',
  bold: '\x1b[1m',
}

const RESET = '\x1b[0m'

/** Wrap text in an ANSI style, resetting afterwards. */
export function styleText(style: TextStyle, text: string): string {
  return `${STYLE_CODES[style]}${text}${RESET}`
}
