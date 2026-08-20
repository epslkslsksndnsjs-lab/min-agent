import { describe, expect, it } from 'vitest'
import { Markdown, defaultMarkdownStyle, renderMarkdown } from './markdown.js'
import { stripAnsi, visibleWidth } from '../utils.js'

function plain(lines: string[]): string {
  return lines.map((l) => stripAnsi(l)).join('\n')
}

describe('Markdown', () => {
  it('renders a top-level heading styled without a # prefix (pi layout)', () => {
    const lines = renderMarkdown('# Hello', 40)
    expect(plain(lines)).toContain('Hello')
    expect(plain(lines)).not.toContain('# Hello')
  })

  it('renders a level-3 heading with its # prefix', () => {
    const lines = renderMarkdown('### Hello', 40)
    expect(plain(lines)).toContain('### Hello')
  })

  it('renders unordered list bullets', () => {
    const lines = renderMarkdown('- a\n- b', 40)
    const text = plain(lines)
    expect(text).toContain('- a')
    expect(text).toContain('- b')
  })

  it('renders ordered list markers', () => {
    const lines = renderMarkdown('1. one\n2. two', 40)
    const text = plain(lines)
    expect(text).toContain('1. one')
    expect(text).toContain('2. two')
  })

  it('renders a fenced code block with top/bottom borders', () => {
    const lines = renderMarkdown('```ts\nconst x = 1\n```', 40)
    const text = plain(lines)
    expect(text).toContain('```ts')
    expect(text).toContain('const x = 1')
    expect(text).toContain('```')
  })

  it('renders blockquotes with a vertical border', () => {
    const lines = renderMarkdown('> quoted text', 40)
    expect(plain(lines)).toContain('│ quoted text')
  })

  it('renders a width-aware table with box-drawing borders', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    const lines = renderMarkdown(md, 40)
    const text = plain(lines)
    expect(text).toContain('┌─')
    expect(text).toContain('│ a')
    expect(text).toContain('│ 1')
    expect(text).toContain('┴')
    expect(text).toContain('┘')
  })

  it('renders inline bold, italic and code spans', () => {
    const lines = renderMarkdown('**bold** *em* `code`', 40)
    const text = plain(lines)
    expect(text).toContain('bold')
    expect(text).toContain('em')
    expect(text).toContain('code')
  })

  it('wraps long lines to the viewport width', () => {
    const longText = 'word '.repeat(40)
    const lines = renderMarkdown(longText, 20)
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(20)
    }
  })

  it('keeps CJK text within the viewport width', () => {
    const lines = renderMarkdown('\u4e2d\u6587\u6d4b\u8bd5\u5185\u5bb9'.repeat(10), 20)
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(20)
    }
  })

  it('does not shrink a streaming code block on a partial closing fence', () => {
    const partial = '```ts\nconst x = 1\n```'
    const lines = renderMarkdown(partial, 40)
    // The closing fence must still render as a full border line.
    expect(plain(lines)).toContain('```')
  })

  it('caches render output for identical text and width', () => {
    const md = new Markdown('hi', defaultMarkdownStyle)
    const a = md.render(40)
    const b = md.render(40)
    expect(a).toEqual(b)
    md.setText('bye')
    const c = md.render(40)
    expect(c).not.toEqual(a)
  })
})
