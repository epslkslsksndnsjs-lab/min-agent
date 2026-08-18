// Tests for src/tui/boot/footer.ts — the activity status line and its formatters.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Footer } from './footer.js'
import { formatTokenCount, formatWorkingElapsed } from './agent-activity.js'
import { stripAnsi } from '../utils.js'

describe('formatTokenCount', () => {
  it('formats compactly like the upstream loader', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(950)).toBe('950')
    expect(formatTokenCount(1250)).toBe('1.3k')
    expect(formatTokenCount(12000)).toBe('12k')
    expect(formatTokenCount(1_250_000)).toBe('1.3M')
  })
})

describe('formatWorkingElapsed', () => {
  it('renders sub-minute durations as seconds', () => {
    expect(formatWorkingElapsed(0)).toBe('0s')
    expect(formatWorkingElapsed(3000)).toBe('3s')
    expect(formatWorkingElapsed(59_000)).toBe('59s')
  })

  it('renders minute-long durations as "Mm SSs"', () => {
    expect(formatWorkingElapsed(65_000)).toBe('1m 05s')
    expect(formatWorkingElapsed(3_599_000)).toBe('59m 59s')
  })

  it('renders hour-long durations as "Hh MMm SSs"', () => {
    expect(formatWorkingElapsed(3_600_000)).toBe('1h 00m 00s')
    expect(formatWorkingElapsed(7_261_000)).toBe('2h 01m 01s')
  })

  it('clamps negative values to zero', () => {
    expect(formatWorkingElapsed(-100)).toBe('0s')
  })
})

describe('Footer', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] }))
  afterEach(() => vi.useRealTimers())

  it('renders no rows while idle (before the first turn)', () => {
    const footer = new Footer()
    footer.setRequestRender(() => {})
    expect(footer.render(80)).toEqual([])
  })

  it('shows a Thinking line (no arrow yet) right after submit', () => {
    const footer = new Footer()
    footer.setRequestRender(() => {})
    footer.startTurn()
    const line = stripAnsi(footer.render(80)[0])
    expect(line).toContain('Thinking')
    expect(line).toContain('0s')
  })

  it('shows a Writing line with a down arrow once text streams', () => {
    const footer = new Footer()
    footer.setRequestRender(() => {})
    footer.startTurn()
    footer.feed({ type: 'assistant_text', delta: 'abcdefgh' }) // 8 chars -> estimate 2
    const line = stripAnsi(footer.render(80)[0])
    expect(line).toContain('Writing')
    expect(line).toContain('↓ 2 tokens')
  })

  it('shows an Executing line with an up arrow while a tool runs', () => {
    const footer = new Footer()
    footer.setRequestRender(() => {})
    footer.startTurn()
    footer.feed({ type: 'assistant_text', delta: 'abcdefgh' }) // 2 tokens
    footer.feed({ type: 'tool_call', id: 't1', name: 'read_file', args: {} })
    const line = stripAnsi(footer.render(80)[0])
    expect(line).toContain('Executing')
    expect(line).toContain('↑ 2 tokens')
  })

  it('hides the line again after the turn ends', () => {
    const footer = new Footer()
    footer.setRequestRender(() => {})
    footer.startTurn()
    footer.feed({ type: 'assistant_text', delta: 'hi' })
    footer.endTurn()
    expect(footer.render(80)).toEqual([])
  })
})
