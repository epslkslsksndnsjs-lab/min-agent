import type { Component } from '../tui.js'
import { styleText } from './theme.js'
import { truncateToWidth, visibleWidth } from '../utils.js'
import * as os from 'node:os'

/** ~-abbreviate the working directory for display. */
export function formatSplashCwd(cwd: string): string {
  const normalized = cwd.replace(/\\/g, '/')
  const home = os.homedir().replace(/\\/g, '/')
  if (home && normalized === home) {
    return '~'
  }
  if (home && normalized.startsWith(`${home}/`)) {
    return `~${normalized.slice(home.length)}`
  }
  return normalized
}

function truncatePathMiddle(value: string, width: number): string {
  if (visibleWidth(value) <= width) {
    return value
  }
  if (width <= 1) {
    return truncateToWidth(value, width, '')
  }

  const ellipsis = '…'
  const normalized = value.replace(/\\/g, '/')
  const prefix = normalized.startsWith('~/') ? '~/' : normalized.startsWith('/') ? '/' : ''
  const body = prefix ? normalized.slice(prefix.length) : normalized
  const parts = body.split('/').filter((part) => part.length > 0)
  const last = parts.pop() ?? ''
  const previous = parts.pop()
  const suffix = previous ? `${previous}/${last}` : last
  const candidate = `${prefix}${ellipsis}/${suffix}`
  if (visibleWidth(candidate) <= width) {
    return candidate
  }

  return truncateToWidth(candidate, width)
}

export interface HeaderMetadataLine {
  label: string
  value: string
}

export interface HeaderOptions {
  wordmark?: string
  startHint?: string
  getExtraMetadata?: () => readonly HeaderMetadataLine[]
}

/**
 * Boot screen header: wordmark + model + cwd + start hint. Deliberately
 * renders no version string.
 */
export class Header implements Component {
  private readonly wordmarkRaw: string[]
  private readonly logoCanvasWidth: number
  private readonly gutter = 4
  private readonly labelWidth = 9

  constructor(
    private readonly getModelId: () => string | undefined,
    private readonly getCwd: () => string,
    private readonly options: HeaderOptions = {},
  ) {
    this.wordmarkRaw = (options.wordmark ?? 'min-agent').split('\n')
    this.logoCanvasWidth = this.wordmarkRaw.reduce((max, line) => Math.max(max, visibleWidth(line)), 0)
  }

  invalidate(): void {
    // Render output is derived from current session state
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    const paddingX = safeWidth > 1 ? 1 : 0
    const contentWidth = Math.max(1, safeWidth - paddingX * 2)
    const metaWidth = contentWidth - this.logoCanvasWidth - this.gutter
    const showMeta = metaWidth >= this.labelWidth + 8
    const valueWidth = Math.max(1, metaWidth - this.labelWidth)
    const labelled = (label: string, value: string) => {
      const displayValue =
        label === 'cwd' ? truncatePathMiddle(value, valueWidth) : truncateToWidth(value, valueWidth)
      return styleText('dim', label.padEnd(this.labelWidth)) + styleText('muted', displayValue)
    }
    const extraMetadata = this.options.getExtraMetadata?.() ?? []
    const startHint = this.options.startHint ?? 'type to start'
    const metaLines = showMeta
      ? [
          labelled('model', this.getModelId() ?? '—'),
          labelled('cwd', formatSplashCwd(this.getCwd())),
          ...extraMetadata.map((line) => labelled(line.label, line.value)),
          '',
          styleText('dim', startHint),
        ]
      : []
    const metaStart = Math.max(0, Math.floor((this.wordmarkRaw.length - metaLines.length) / 2))
    // Render enough rows for the wordmark plus any meta lines that fall below
    // it (a one-line wordmark must still show model/cwd/hint beneath).
    const totalLines = Math.max(this.wordmarkRaw.length, metaStart + metaLines.length)
    const lines: string[] = []
    for (let index = 0; index < totalLines; index++) {
      const line = this.wordmarkRaw[index] ?? ''
      const colored = styleText('bold', styleText('accent', line))
      const meta = index >= metaStart && index < metaStart + metaLines.length ? metaLines[index - metaStart] : ''
      const padding = showMeta
        ? ' '.repeat(Math.max(0, this.logoCanvasWidth - visibleWidth(line) + this.gutter))
        : ''
      const content = truncateToWidth(colored + padding + meta, contentWidth, '')
      lines.push(
        ' '.repeat(paddingX) + content + ' '.repeat(Math.max(0, safeWidth - paddingX - visibleWidth(content))),
      )
    }

    return lines
  }
}
