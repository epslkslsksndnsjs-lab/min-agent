// Markdown component — renders model output as terminal-formatted text.
//
// Ported from the pi/claude-code-tui rendering approach: marked lexes the
// source into a token tree, then each block/inline token is painted into an
// ANSI string by a small set of theme functions. Tables use box-drawing
// borders with width-aware cell wrapping; code blocks use a bordered panel
// with a single accent color (no external syntax-highlight dependency).
//
// Differences from the upstream renderer: LaTeX, terminal images, and OSC 8
// hyperlinks are intentionally omitted — this is layout only.

import { marked, type Token, type Tokens } from 'marked'
import type { Component } from '../tui.js'
import { visibleWidth, wrapTextWithAnsi } from '../utils.js'
import { styleText } from './theme.js'

/** Theme functions for markdown elements. Each takes text, returns ANSI-styled text. */
export interface MarkdownStyle {
  heading: (text: string) => string
  bold: (text: string) => string
  italic: (text: string) => string
  strikethrough: (text: string) => string
  underline: (text: string) => string
  code: (text: string) => string
  codeBlock: (text: string) => string
  codeBlockBorder: (text: string) => string
  quote: (text: string) => string
  quoteBorder: (text: string) => string
  hr: (text: string) => string
  listBullet: (text: string) => string
  link: (text: string) => string
  linkUrl: (text: string) => string
  /** Prefix applied to each rendered code block line (default: "  "). */
  codeBlockIndent?: string
}

/** Default theme mapping markdown elements to the boot palette. */
export const defaultMarkdownStyle: MarkdownStyle = {
  heading: (t) => styleText('accent', styleText('bold', t)),
  bold: (t) => styleText('bold', t),
  italic: (t) => styleText('italic', t),
  strikethrough: (t) => styleText('strikethrough', t),
  underline: (t) => styleText('underline', t),
  code: (t) => styleText('toolOutput', t),
  codeBlock: (t) => styleText('toolOutput', t),
  codeBlockBorder: (t) => styleText('muted', t),
  quote: (t) => styleText('muted', t),
  quoteBorder: (t) => styleText('muted', t),
  hr: (t) => styleText('muted', t),
  listBullet: (t) => styleText('accent', t),
  link: (t) => styleText('accent', t),
  linkUrl: (t) => styleText('muted', t),
  codeBlockIndent: '  ',
}

export interface MarkdownOptions {
  /** Background fill applied to every rendered line, extending to full width. */
  background?: (line: string, width: number) => string
  /** Horizontal/vertical padding inside the component. */
  paddingX?: number
  paddingY?: number
}

/**
 * Trim a trailing partial closing fence from the last code token so streaming
 * code blocks do not shrink/flicker when the final backtick arrives.
 */
function trimPartialClosingFences(tokens: readonly Token[]): void {
  const token = tokens[tokens.length - 1]
  if (token?.type === 'list') {
    trimPartialClosingFences(token.items[token.items.length - 1]?.tokens ?? [])
    return
  }
  if (token?.type === 'blockquote') {
    trimPartialClosingFences(token.tokens ?? [])
    return
  }
  if (token?.type !== 'code') {
    return
  }

  const marker = /^(`{3,}|~{3,})/.exec(token.raw)?.[1]
  const lastLine = token.raw.split('\n').pop()
  if (!marker || !lastLine || lastLine.length >= marker.length || lastLine !== marker[0]?.repeat(lastLine.length)) {
    return
  }

  token.text = token.text.slice(0, -lastLine.length).replace(/\n$/, '')
}

interface InlineStyleContext {
  applyText: (text: string) => string
  stylePrefix: string
}

export class Markdown implements Component {
  private text: string
  private style: MarkdownStyle
  private options: MarkdownOptions
  private paddingX: number
  private paddingY: number

  // Render cache
  private cachedText?: string
  private cachedWidth?: number
  private cachedLines?: string[]

  constructor(text: string, style: MarkdownStyle = defaultMarkdownStyle, options: MarkdownOptions = {}) {
    this.text = text
    this.style = style
    this.options = options
    this.paddingX = options.paddingX ?? 0
    this.paddingY = options.paddingY ?? 0
  }

  setText(text: string): void {
    this.text = text
    this.invalidate()
  }

  invalidate(): void {
    this.cachedText = undefined
    this.cachedWidth = undefined
    this.cachedLines = undefined
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
      return this.cachedLines
    }

    const contentWidth = Math.max(1, width - this.paddingX * 2)
    const text = this.text

    if (!text || text.trim() === '') {
      const result: string[] = []
      this.cachedText = this.text
      this.cachedWidth = width
      this.cachedLines = result
      return result
    }

    const normalizedText = text.replace(/\t/g, '   ')
    const tokens = marked.lexer(normalizedText)
    trimPartialClosingFences(tokens)

    const renderedLines: string[] = []
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      const nextToken = tokens[i + 1]
      const tokenLines = this.renderToken(token, contentWidth, nextToken?.type)
      for (const line of tokenLines) renderedLines.push(line)
    }

    // Wrap lines (no padding, no background yet).
    const wrappedLines: string[] = []
    for (const line of renderedLines) {
      for (const wrappedLine of wrapTextWithAnsi(line, contentWidth)) {
        wrappedLines.push(wrappedLine)
      }
    }

    // Apply margins and background to each wrapped line.
    const leftMargin = ' '.repeat(this.paddingX)
    const rightMargin = ' '.repeat(this.paddingX)
    const bgFn = this.options.background
    const contentLines: string[] = []

    for (const line of wrappedLines) {
      const lineWithMargins = leftMargin + line + rightMargin
      if (bgFn) {
        contentLines.push(bgFn(lineWithMargins, width))
      } else {
        const visibleLen = visibleWidth(lineWithMargins)
        const padding = ' '.repeat(Math.max(0, width - visibleLen))
        contentLines.push(lineWithMargins + padding)
      }
    }

    // Top/bottom padding (empty lines).
    const emptyLine = ' '.repeat(width)
    const emptyLines: string[] = []
    for (let i = 0; i < this.paddingY; i++) {
      emptyLines.push(bgFn ? bgFn(emptyLine, width) : emptyLine)
    }

    const result = emptyLines.concat(contentLines, emptyLines)

    this.cachedText = this.text
    this.cachedWidth = width
    this.cachedLines = result

    return result.length > 0 ? result : ['']
  }

  private renderToken(token: Token, width: number, nextTokenType?: string): string[] {
    const lines: string[] = []

    switch (token.type) {
      case 'heading': {
        const headingLevel = token.depth
        const headingPrefix = `${'#'.repeat(headingLevel)} `
        const headingStyleFn =
          headingLevel === 1
            ? (t: string) => this.style.heading(styleText('underline', t))
            : (t: string) => this.style.heading(t)

        const headingStyleContext: InlineStyleContext = {
          applyText: headingStyleFn,
          stylePrefix: '',
        }

        const headingText = this.renderInlineTokens(token.tokens || [], headingStyleContext)
        const styledHeading =
          headingLevel >= 3 ? headingStyleFn(headingPrefix) + headingText : headingText
        lines.push(styledHeading)
        if (nextTokenType && nextTokenType !== 'space') {
          lines.push('')
        }
        break
      }

      case 'paragraph': {
        const paragraphText = this.renderInlineTokens(token.tokens || [])
        lines.push(paragraphText)
        if (nextTokenType && nextTokenType !== 'list' && nextTokenType !== 'space') {
          lines.push('')
        }
        break
      }

      case 'text':
        lines.push(this.renderInlineTokens([token]))
        break

      case 'code': {
        const indent = this.style.codeBlockIndent ?? '  '
        lines.push(this.style.codeBlockBorder(`\`\`\`${token.lang || ''}`))
        const codeLines = token.text.split('\n')
        for (const codeLine of codeLines) {
          lines.push(`${indent}${this.style.codeBlock(codeLine)}`)
        }
        lines.push(this.style.codeBlockBorder('```'))
        if (nextTokenType && nextTokenType !== 'space') {
          lines.push('')
        }
        break
      }

      case 'list': {
        const listLines = this.renderList(token as Tokens.List, 0, width)
        lines.push(...listLines)
        break
      }

      case 'table': {
        lines.push(...this.renderTable(token as Tokens.Table, width, nextTokenType))
        break
      }

      case 'blockquote': {
        const quoteStyle = (t: string) => this.style.quote(this.style.italic(t))
        const quoteBorder = this.style.quoteBorder('│ ')
        const quoteContentWidth = Math.max(1, width - quoteBorder.length)

        const quoteTokens = token.tokens || []
        const renderedQuoteLines: string[] = []
        for (let i = 0; i < quoteTokens.length; i++) {
          const quoteToken = quoteTokens[i]
          const nextQuoteToken = quoteTokens[i + 1]
          renderedQuoteLines.push(
            ...this.renderToken(quoteToken, quoteContentWidth, nextQuoteToken?.type),
          )
        }
        while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === '') {
          renderedQuoteLines.pop()
        }

        for (const quoteLine of renderedQuoteLines) {
          const wrappedLines = wrapTextWithAnsi(quoteLine, quoteContentWidth)
          for (const wrappedLine of wrappedLines) {
            lines.push(quoteBorder + quoteStyle(wrappedLine))
          }
        }
        if (nextTokenType && nextTokenType !== 'space') {
          lines.push('')
        }
        break
      }

      case 'hr':
        lines.push(this.style.hr('─'.repeat(Math.min(width, 80))))
        if (nextTokenType && nextTokenType !== 'space') {
          lines.push('')
        }
        break

      case 'html':
        if ('raw' in token && typeof token.raw === 'string') {
          lines.push(token.raw.trim())
        }
        break

      case 'space':
        lines.push('')
        break

      default:
        if ('text' in token && typeof token.text === 'string') {
          lines.push(token.text)
        }
    }

    return lines
  }

  private renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
    const resolved = styleContext ?? { applyText: (t: string) => t, stylePrefix: '' }
    const { applyText } = resolved
    let result = ''

    for (const token of tokens) {
      switch (token.type) {
        case 'escape':
          result += applyText(token.text)
          break

        case 'text':
          if (token.tokens && token.tokens.length > 0) {
            result += this.renderInlineTokens(token.tokens, resolved)
          } else {
            result += applyText(token.text)
          }
          break

        case 'paragraph':
          result += this.renderInlineTokens(token.tokens || [], resolved)
          break

        case 'strong':
          result += this.style.bold(this.renderInlineTokens(token.tokens || [], resolved))
          break

        case 'em':
          result += this.style.italic(this.renderInlineTokens(token.tokens || [], resolved))
          break

        case 'codespan':
          result += this.style.code(token.text)
          break

        case 'link': {
          const linkText = this.renderInlineTokens(token.tokens || [], resolved)
          const styledLink = this.style.link(this.style.underline(linkText))
          if (token.text === token.href) {
            result += styledLink
          } else {
            result += styledLink + this.style.linkUrl(` (${token.href})`)
          }
          break
        }

        case 'br':
          result += '\n'
          break

        case 'del':
          result += this.style.strikethrough(this.renderInlineTokens(token.tokens || [], resolved))
          break

        case 'html':
          if ('raw' in token && typeof token.raw === 'string') {
            result += applyText(token.raw)
          }
          break

        default:
          if ('text' in token && typeof token.text === 'string') {
            result += applyText(token.text)
          }
      }
    }

    return result
  }

  /**
   * Render a list with proper nesting support.
   */
  private renderList(token: Tokens.List, depth: number, width: number): string[] {
    const lines: string[] = []
    const indent = '    '.repeat(depth)
    const startNumber = typeof token.start === 'number' ? token.start : 1

    for (let i = 0; i < token.items.length; i++) {
      const item = token.items[i]
      const isLastItem = i === token.items.length - 1
      const bullet = token.ordered ? `${startNumber + i}. ` : '- '
      const taskMarker = item.task ? `[${item.checked ? 'x' : ' '}] ` : ''
      const marker = bullet + taskMarker
      const firstPrefix = indent + this.style.listBullet(marker)
      const continuationPrefix = indent + ' '.repeat(visibleWidth(marker))
      const itemWidth = Math.max(1, width - visibleWidth(firstPrefix))
      let renderedAnyLine = false

      for (const itemToken of item.tokens) {
        if (itemToken.type === 'list') {
          lines.push(...this.renderList(itemToken as Tokens.List, depth + 1, width))
          renderedAnyLine = true
          continue
        }

        const itemLines = this.renderToken(itemToken, itemWidth, undefined)
        for (const line of itemLines) {
          for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
            const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix
            lines.push(linePrefix + wrappedLine)
            renderedAnyLine = true
          }
        }
      }

      if (!renderedAnyLine) {
        lines.push(firstPrefix)
      }

      if (token.loose && !isLastItem) {
        lines.push('')
      }
    }

    return lines
  }

  /**
   * Render a table with width-aware cell wrapping using box-drawing borders.
   */
  private renderTable(token: Tokens.Table, availableWidth: number, nextTokenType?: string): string[] {
    const lines: string[] = []
    const numCols = token.header.length
    if (numCols === 0) {
      return lines
    }

    // Border overhead: "│ " + (n-1) * " │ " + " │" = 3n + 1
    const borderOverhead = 3 * numCols + 1
    const availableForCells = availableWidth - borderOverhead
    if (availableForCells < numCols) {
      // Too narrow to render a stable table; fall back to raw markdown.
      const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : []
      if (nextTokenType && nextTokenType !== 'space') {
        fallbackLines.push('')
      }
      return fallbackLines
    }

    const maxUnbrokenWordWidth = 30

    const naturalWidths: number[] = []
    const minWordWidths: number[] = []
    for (let i = 0; i < numCols; i++) {
      const headerText = this.renderInlineTokens(token.header[i].tokens || [])
      naturalWidths[i] = visibleWidth(headerText)
      minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth))
    }
    for (const row of token.rows) {
      for (let i = 0; i < row.length; i++) {
        const cellText = this.renderInlineTokens(row[i].tokens || [])
        naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText))
        minWordWidths[i] = Math.max(minWordWidths[i] || 1, this.getLongestWordWidth(cellText, maxUnbrokenWordWidth))
      }
    }

    let minColumnWidths = minWordWidths
    let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0)

    if (minCellsWidth > availableForCells) {
      minColumnWidths = new Array(numCols).fill(1)
      const remaining = availableForCells - numCols

      if (remaining > 0) {
        const totalWeight = minWordWidths.reduce((total, w) => total + Math.max(0, w - 1), 0)
        const growth = minWordWidths.map((w) => (totalWeight > 0 ? Math.floor((Math.max(0, w - 1) / totalWeight) * remaining) : 0))
        for (let i = 0; i < numCols; i++) {
          minColumnWidths[i] += growth[i] ?? 0
        }
        const allocated = growth.reduce((total, w) => total + w, 0)
        let leftover = remaining - allocated
        for (let i = 0; leftover > 0 && i < numCols; i++) {
          minColumnWidths[i]++
          leftover--
        }
      }
      minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0)
    }

    const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead
    let columnWidths: number[]

    if (totalNaturalWidth <= availableWidth) {
      columnWidths = naturalWidths.map((w, index) => Math.max(w, minColumnWidths[index]))
    } else {
      const totalGrowPotential = naturalWidths.reduce((total, w, index) => total + Math.max(0, w - minColumnWidths[index]), 0)
      const extraWidth = Math.max(0, availableForCells - minCellsWidth)
      columnWidths = minColumnWidths.map((minWidth, index) => {
        const naturalWidth = naturalWidths[index]
        const minWidthDelta = Math.max(0, naturalWidth - minWidth)
        const grow = totalGrowPotential > 0 ? Math.floor((minWidthDelta / totalGrowPotential) * extraWidth) : 0
        return minWidth + grow
      })
      const allocated = columnWidths.reduce((a, b) => a + b, 0)
      let remaining = availableForCells - allocated
      while (remaining > 0) {
        let grew = false
        for (let i = 0; i < numCols && remaining > 0; i++) {
          if (columnWidths[i] < naturalWidths[i]) {
            columnWidths[i]++
            remaining--
            grew = true
          }
        }
        if (!grew) break
      }
    }

    const topBorderCells = columnWidths.map((w) => '─'.repeat(w))
    lines.push(`┌─${topBorderCells.join('─┬─')}─┐`)

    const headerCellLines: string[][] = token.header.map((cell, i) => {
      const text = this.renderInlineTokens(cell.tokens || [])
      return wrapTextWithAnsi(text, Math.max(1, columnWidths[i]))
    })
    const headerLineCount = Math.max(...headerCellLines.map((c) => c.length))
    for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
      const rowParts = headerCellLines.map((cellLines, colIdx) => {
        const text = cellLines[lineIdx] || ''
        const padded = text + ' '.repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)))
        return this.style.bold(padded)
      })
      lines.push(`│ ${rowParts.join(' │ ')} │`)
    }

    const separatorCells = columnWidths.map((w) => '─'.repeat(w))
    const separatorLine = `├─${separatorCells.join('─┼─')}─┤`
    lines.push(separatorLine)

    for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
      const row = token.rows[rowIndex]
      const rowCellLines: string[][] = row.map((cell, i) => {
        const text = this.renderInlineTokens(cell.tokens || [])
        return wrapTextWithAnsi(text, Math.max(1, columnWidths[i]))
      })
      const rowLineCount = Math.max(...rowCellLines.map((c) => c.length))
      for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
        const rowParts = rowCellLines.map((cellLines, colIdx) => {
          const text = cellLines[lineIdx] || ''
          return text + ' '.repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)))
        })
        lines.push(`│ ${rowParts.join(' │ ')} │`)
      }
      if (rowIndex < token.rows.length - 1) {
        lines.push(separatorLine)
      }
    }

    const bottomBorderCells = columnWidths.map((w) => '─'.repeat(w))
    lines.push(`└─${bottomBorderCells.join('─┴─')}─┘`)

    if (nextTokenType && nextTokenType !== 'space') {
      lines.push('')
    }

    return lines
  }

  /** Visible width of the longest word in a string. */
  private getLongestWordWidth(text: string, maxWidth?: number): number {
    const words = text.split(/\s+/).filter((w) => w.length > 0)
    let longest = 0
    for (const word of words) {
      longest = Math.max(longest, visibleWidth(word))
    }
    if (maxWidth === undefined) {
      return longest
    }
    return Math.min(longest, maxWidth)
  }
}

/** Convenience helper: render markdown to lines with the default theme. */
export function renderMarkdown(text: string, width: number, options?: MarkdownOptions): string[] {
  return new Markdown(text, defaultMarkdownStyle, options).render(width)
}
