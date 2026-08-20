// Tests for src/tui/utils.ts — visible-width measurement, ANSI handling,
// column slicing, truncation, and wrapping.

import { describe, it, expect } from 'vitest'
import {
  normalizeTerminalOutput,
  sliceByColumn,
  sliceWithWidth,
  stripAnsi,
  truncateToWidth,
  visibleContentSpan,
  visibleWidth,
  wrapTextWithAnsi,
} from './utils.js'

describe('visibleWidth', () => {
  it('counts ASCII as one column per char', () => {
    expect(visibleWidth('abc')).toBe(3)
    expect(visibleWidth('')).toBe(0)
  })

  it('counts CJK as two columns', () => {
    expect(visibleWidth('\u4e2d\u6587')).toBe(4)
    expect(visibleWidth('a\u4e2db')).toBe(4)
  })

  it('ignores ANSI escape codes', () => {
    expect(visibleWidth('\x1b[31mred\x1b[0m')).toBe(3)
    expect(visibleWidth('\x1b[1m\x1b[36mbold\x1b[0m')).toBe(4)
  })

  it('counts emoji as two columns', () => {
    expect(visibleWidth('👍')).toBe(2)
    expect(visibleWidth('a👍b')).toBe(4)
  })

  it('expands tabs to three columns', () => {
    expect(visibleWidth('a\tb')).toBe(5)
  })
})

describe('stripAnsi', () => {
  it('removes CSI, OSC, and two-byte escapes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
    expect(stripAnsi('\x1b]0;title\x07text')).toBe('text')
    expect(stripAnsi('\x1bMc')).toBe('c')
  })

  it('leaves plain text untouched', () => {
    expect(stripAnsi('plain')).toBe('plain')
  })
})

describe('sliceByColumn / sliceWithWidth', () => {
  it('slices ASCII by column', () => {
    expect(sliceByColumn('hello world', 0, 5)).toBe('hello')
    expect(sliceByColumn('hello world', 6, 5)).toBe('world')
  })

  it('slices CJK by visual columns', () => {
    expect(sliceByColumn('\u4e2d\u6587abc', 0, 4)).toBe('\u4e2d\u6587')
    expect(sliceByColumn('\u4e2d\u6587abc', 4, 3)).toBe('abc')
  })

  it('preserves ANSI codes in the slice', () => {
    // The trailing reset sits past the slice boundary and is dropped, exactly
    // like the styling that belongs to the excluded columns
    expect(sliceByColumn('\x1b[31mred\x1b[0m', 0, 3)).toBe('\x1b[31mred')
  })

  it('returns actual width from sliceWithWidth', () => {
    const result = sliceWithWidth('\u4e2d\u6587abc', 0, 4)
    expect(result.text).toBe('\u4e2d\u6587')
    expect(result.width).toBe(4)
  })

  it('excludes wide chars that would extend past the range when strict', () => {
    // The CJK character spans cols 1-3; a strict slice ending at col 2 must exclude it
    expect(sliceByColumn('a\u4e2db', 0, 2, true)).toBe('a')
  })
})

describe('truncateToWidth', () => {
  it('truncates with an ellipsis', () => {
    expect(truncateToWidth('hello world', 8)).toBe('hello...')
  })

  it('keeps short text intact', () => {
    expect(truncateToWidth('hi', 8)).toBe('hi')
  })

  it('accounts for CJK width', () => {
    expect(truncateToWidth('\u4e2d\u6587\u6d4b\u8bd5', 6)).toBe('\u4e2d...')
  })

  it('pads to the requested width when requested', () => {
    expect(truncateToWidth('hi', 5, '...', true)).toBe('hi   ')
  })
})

describe('normalizeTerminalOutput', () => {
  it('expands tabs to three spaces', () => {
    expect(normalizeTerminalOutput('a\tb')).toBe('a   b')
  })

  it('leaves text without tabs or AM vowels untouched', () => {
    expect(normalizeTerminalOutput('plain')).toBe('plain')
  })
})

describe('wrapTextWithAnsi', () => {
  it('wraps long words by grapheme', () => {
    const lines = wrapTextWithAnsi('abcdefghij', 5)
    expect(lines.join('|')).toBe('abcde|fghij')
  })

  it('wraps on word boundaries', () => {
    const lines = wrapTextWithAnsi('hello world foo', 10)
    expect(lines.length).toBe(2)
    expect(lines[0]).toBe('hello')
    expect(lines[1]).toBe('world foo')
  })
})

describe('visibleContentSpan', () => {
  it('finds the span of visible content', () => {
    expect(visibleContentSpan('  hello  ', 10)).toEqual({ from: 2, to: 7 })
  })

  it('returns null for empty content', () => {
    expect(visibleContentSpan('   ', 10)).toBeNull()
  })
})
