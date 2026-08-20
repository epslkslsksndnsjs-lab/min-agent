// Tests for src/tui/mouse.ts — SGR mouse sequence parsing.

import { describe, expect, it } from 'vitest'
import {
  isMouseSequence,
  isWheelDown,
  isWheelUp,
  MOUSE_BUTTON_LEFT,
  MOUSE_WHEEL_DOWN,
  MOUSE_WHEEL_UP,
  parseSgrMouseEvent,
} from './mouse.js'

describe('isMouseSequence', () => {
  it('recognizes SGR and legacy mouse reports', () => {
    expect(isMouseSequence('\x1b[<0;10;5M')).toBe(true)
    expect(isMouseSequence('\x1b[<65;1;1m')).toBe(true)
    expect(isMouseSequence('\x1b[M')).toBe(true)
  })

  it('rejects non-mouse sequences', () => {
    expect(isMouseSequence('\x1b[A')).toBe(false)
    expect(isMouseSequence('a')).toBe(false)
    expect(isMouseSequence('\x1b[10;5M')).toBe(false)
  })
})

describe('parseSgrMouseEvent', () => {
  it('parses a left-button press with coordinates', () => {
    const event = parseSgrMouseEvent('\x1b[<0;10;5M')
    expect(event).toEqual({
      button: MOUSE_BUTTON_LEFT,
      x: 10,
      y: 5,
      press: true,
      motion: false,
      shift: false,
      alt: false,
      ctrl: false,
    })
  })

  it('parses a button release (lowercase m)', () => {
    const event = parseSgrMouseEvent('\x1b[<0;10;5m')
    expect(event?.press).toBe(false)
    expect(event?.button).toBe(MOUSE_BUTTON_LEFT)
  })

  it('parses wheel up and wheel down', () => {
    expect(isWheelUp(parseSgrMouseEvent('\x1b[<64;20;3M')!)).toBe(true)
    expect(isWheelDown(parseSgrMouseEvent('\x1b[<65;20;3M')!)).toBe(true)
    expect(parseSgrMouseEvent('\x1b[<64;20;3M')?.button).toBe(MOUSE_WHEEL_UP)
    expect(parseSgrMouseEvent('\x1b[<65;20;3M')?.button).toBe(MOUSE_WHEEL_DOWN)
  })

  it('parses modifier bits (shift, alt, ctrl)', () => {
    const shift = parseSgrMouseEvent('\x1b[<4;1;1M')
    expect(shift?.shift).toBe(true)
    expect(shift?.alt).toBe(false)
    expect(shift?.ctrl).toBe(false)

    const alt = parseSgrMouseEvent('\x1b[<8;1;1M')
    expect(alt?.alt).toBe(true)

    const ctrl = parseSgrMouseEvent('\x1b[<16;1;1M')
    expect(ctrl?.ctrl).toBe(true)
  })

  it('strips modifier and motion bits from the button code', () => {
    const drag = parseSgrMouseEvent('\x1b[<32;10;5M')
    expect(drag?.button).toBe(MOUSE_BUTTON_LEFT)
    expect(drag?.motion).toBe(true)

    const rightDrag = parseSgrMouseEvent('\x1b[<34;10;5M')
    expect(rightDrag?.button).toBe(2)
    expect(rightDrag?.motion).toBe(true)
  })

  it('returns null for malformed sequences', () => {
    expect(parseSgrMouseEvent('\x1b[<0;10;5')).toBeNull()
    expect(parseSgrMouseEvent('\x1b[<a;b;cM')).toBeNull()
    expect(parseSgrMouseEvent('not a mouse event')).toBeNull()
    expect(parseSgrMouseEvent('\x1b[<0;10;5X')).toBeNull()
  })
})
