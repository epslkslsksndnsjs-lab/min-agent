// Tests for src/tui/components/input.ts — editing operations and rendering.

import { describe, it, expect, vi } from 'vitest'
import { Input } from './input.js'
import { CURSOR_MARKER } from '../tui.js'
import { stripAnsi } from '../utils.js'

describe('Input — editing', () => {
  it('inserts characters at the cursor', () => {
    const input = new Input()
    input.handleInput('h')
    input.handleInput('i')
    expect(input.getValue()).toBe('hi')
    expect(input.getCursor()).toBe(2)
  })

  it('moves the cursor with ctrl+b / ctrl+f and inserts at position', () => {
    const input = new Input()
    input.handleInput('abc')
    input.handleInput('\x02') // ctrl+b
    input.handleInput('\x02') // ctrl+b
    expect(input.getCursor()).toBe(1)
    input.handleInput('X')
    expect(input.getValue()).toBe('aXbc')
  })

  it('moves to line start/end with ctrl+a / ctrl+e', () => {
    const input = new Input()
    input.handleInput('abc')
    input.handleInput('\x01') // ctrl+a
    expect(input.getCursor()).toBe(0)
    input.handleInput('\x05') // ctrl+e
    expect(input.getCursor()).toBe(3)
  })

  it('deletes backward with backspace', () => {
    const input = new Input()
    input.handleInput('abc')
    input.handleInput('\x7f')
    expect(input.getValue()).toBe('ab')
    expect(input.getCursor()).toBe(2)
  })

  it('deletes a grapheme at a time (emoji)', () => {
    const input = new Input()
    input.handleInput('a👍b')
    input.handleInput('\x7f')
    expect(input.getValue()).toBe('a👍')
  })

  it('undoes edits with ctrl+- (word-level undo units)', () => {
    const input = new Input()
    input.handleInput('a')
    input.handleInput(' ') // whitespace + following word coalesce into one unit
    input.handleInput('b')
    input.handleInput('\x1f') // ctrl+-
    expect(input.getValue()).toBe('a')
  })

  it('deletes to line start with ctrl+u', () => {
    const input = new Input()
    input.handleInput('abc')
    input.handleInput('\x15') // ctrl+u
    expect(input.getValue()).toBe('')
  })

  it('submits on enter', () => {
    const input = new Input()
    const onSubmit = vi.fn()
    input.onSubmit = onSubmit
    input.handleInput('hello')
    input.handleInput('\r')
    expect(onSubmit).toHaveBeenCalledWith('hello')
  })

  it('cleans and inserts pasted text', () => {
    const input = new Input()
    input.handleInput('\x1b[200~line1\nline2\twith tab\x1b[201~')
    expect(input.getValue()).toBe('line1line2    with tab')
  })

  it('rejects control characters', () => {
    const input = new Input()
    input.handleInput('\x03') // ctrl+c should not insert
    expect(input.getValue()).toBe('')
  })

  it('accepts kitty CSI-u printable characters', () => {
    const input = new Input()
    input.handleInput('\x1b[97u') // 'a' via kitty protocol
    expect(input.getValue()).toBe('a')
  })
})

describe('Input — rendering', () => {
  it('renders the prompt with a fake inverse-video cursor', () => {
    const input = new Input()
    input.handleInput('ab')
    const [line] = input.render(80)
    expect(stripAnsi(line).startsWith('> ab')).toBe(true)
    expect(line).toContain('\x1b[7m') // reverse video
  })

  it('emits CURSOR_MARKER when focused', () => {
    const input = new Input()
    input.handleInput('ab')
    input.focused = true
    const [line] = input.render(80)
    expect(line).toContain(CURSOR_MARKER)
    input.focused = false
    const [unfocused] = input.render(80)
    expect(unfocused).not.toContain(CURSOR_MARKER)
  })

  it('horizontally scrolls when the value exceeds the width', () => {
    const input = new Input()
    input.handleInput('x'.repeat(100))
    const [line] = input.render(20)
    expect(stripAnsi(line).length).toBeLessThanOrEqual(20)
  })
})
