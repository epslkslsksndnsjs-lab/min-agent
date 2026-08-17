// Tests for src/tui/fullscreen.ts — frame composition and differential paint.

import { describe, it, expect } from 'vitest'
import { clippedFullscreenDockHeight, FullscreenViewport } from './fullscreen.js'

describe('clippedFullscreenDockHeight', () => {
  it('clips the dock to leave a minimum transcript window', () => {
    expect(clippedFullscreenDockHeight(2, 24)).toBe(2)
    expect(clippedFullscreenDockHeight(30, 24)).toBe(21) // 24 - 3 min transcript rows
  })
})

describe('FullscreenViewport.composeFrame', () => {
  it('pins the dock to the bottom and pads the transcript window', () => {
    const viewport = new FullscreenViewport()
    const frame = viewport.composeFrame(['a', 'b'], ['> ', ''], 6)
    expect(frame).toEqual(['a', 'b', '', '', '> ', ''])
    expect(viewport.windowHeight()).toBe(4)
  })

  it('keeps following the transcript end as content appends', () => {
    const viewport = new FullscreenViewport()
    viewport.composeFrame(['a'], ['> '], 4)
    viewport.composeFrame(['a', 'b', 'c'], ['> '], 4)
    const frame = viewport.composeFrame(['a', 'b', 'c', 'd'], ['> '], 4)
    expect(frame.slice(0, 3)).toEqual(['b', 'c', 'd'])
  })

  it('pauses following when scrolled up', () => {
    const viewport = new FullscreenViewport()
    // transcript longer than the window so there is room to scroll
    viewport.composeFrame(['a', 'b', 'c', 'd', 'e'], ['> '], 4)
    expect(viewport.scrollInfo().following).toBe(true)
    viewport.scrollBy(-1)
    expect(viewport.scrollInfo().following).toBe(false)
    const frame = viewport.composeFrame(['a', 'b', 'c', 'd', 'e', 'f'], ['> '], 4)
    // frozen at the previous scroll position (scrollTop 1)
    expect(frame.slice(0, 3)).toEqual(['b', 'c', 'd'])
    viewport.scrollToBottom()
    const following = viewport.composeFrame(['a', 'b', 'c', 'd', 'e', 'f', 'g'], ['> '], 4)
    expect(following.slice(0, 3)).toEqual(['e', 'f', 'g'])
  })
})

describe('FullscreenViewport.paint', () => {
  it('paints a full frame with absolute addressing on first paint', () => {
    const viewport = new FullscreenViewport()
    let out = ''
    viewport.paint((data) => (out += data), ['a', 'b', 'c'], 3, 3, null)
    expect(out).toContain('\x1b[?2026h')
    expect(out).toContain('\x1b[2J\x1b[H')
    expect(out).toContain('\x1b[1;1H\x1b[2Ka')
    expect(out).toContain('\x1b[3;1H\x1b[2Kc')
    expect(out).toContain('\x1b[?2026l')
  })

  it('repaints only changed rows on subsequent paints', () => {
    const viewport = new FullscreenViewport()
    let out = ''
    viewport.paint((data) => (out += data), ['a', 'b', 'c'], 3, 3, null)
    const firstPaint = out
    out = ''
    viewport.paint((data) => (out += data), ['a', 'B', 'c'], 3, 3, null)
    expect(out).not.toContain('a')
    expect(out).toContain('\x1b[2;1H\x1b[2KB')
    expect(out).not.toContain('c')
    expect(firstPaint.length).toBeGreaterThan(0)
  })

  it('positions the cursor when cursorPos is given', () => {
    const viewport = new FullscreenViewport()
    let out = ''
    viewport.paint((data) => (out += data), ['a', 'b', 'c'], 3, 3, { row: 2, col: 1 })
    expect(out).toContain('\x1b[3;2H')
  })

  it('clamps overwide lines instead of wrapping the grid', () => {
    const viewport = new FullscreenViewport()
    let out = ''
    viewport.paint((data) => (out += data), ['toolong', 'b'], 3, 2, null)
    expect(out).not.toContain('\x1b[1;1H\x1b[2Ktoolong')
  })

  it('reset forces a full repaint', () => {
    const viewport = new FullscreenViewport()
    let out = ''
    viewport.paint((data) => (out += data), ['a', 'b'], 3, 2, null)
    viewport.reset()
    out = ''
    viewport.paint((data) => (out += data), ['a', 'b'], 3, 2, null)
    expect(out).toContain('\x1b[2J\x1b[H')
  })
})
