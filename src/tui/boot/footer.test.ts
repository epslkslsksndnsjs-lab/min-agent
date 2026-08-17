// Tests for src/tui/boot/footer.ts — token/elapsed formatting and the footer line.

import { describe, it, expect } from 'vitest'
import { Footer, formatTokens, formatElapsed } from './footer.js'
import { stripAnsi } from '../utils.js'

describe('formatTokens', () => {
  it('formats a token count with thousands separators', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(12345)).toBe('12,345')
    expect(formatTokens(1234567)).toBe('1,234,567')
  })
})

describe('formatElapsed', () => {
  it('renders sub-hour durations as mm:ss', () => {
    expect(formatElapsed(0)).toBe('00:00')
    expect(formatElapsed(500)).toBe('00:00')
    expect(formatElapsed(65_000)).toBe('01:05')
    expect(formatElapsed(3_599_000)).toBe('59:59')
  })

  it('renders hour-long durations as h:mm:ss', () => {
    expect(formatElapsed(3_600_000)).toBe('1:00:00')
    expect(formatElapsed(7_200_000 + 61_000)).toBe('2:01:01')
  })

  it('clamps negative values to zero', () => {
    expect(formatElapsed(-100)).toBe('00:00')
  })
})

describe('Footer', () => {
  it('renders no rows until stats are set', () => {
    expect(new Footer().render(80)).toEqual([])
  })

  it('renders the run-status line with tokens and elapsed time', () => {
    const footer = new Footer()
    footer.setTokens(12345)
    footer.setElapsed(65_000)
    expect(stripAnsi(footer.render(80)[0])).toBe('↓ 12,345 tokens · 01:05')
  })

  it('renders a zeroed line once active', () => {
    const footer = new Footer()
    footer.setTokens(0)
    expect(stripAnsi(footer.render(80)[0])).toBe('↓ 0 tokens · 00:00')
  })
})
