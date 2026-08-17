// Tests for src/tui/stdin-buffer.ts — sequence splitting and paste handling.

import { describe, it, expect, vi } from 'vitest'
import { StdinBuffer } from './stdin-buffer.js'

describe('StdinBuffer', () => {
  it('emits single characters for plain input', () => {
    const buffer = new StdinBuffer()
    const data: string[] = []
    buffer.on('data', (sequence) => data.push(sequence))
    buffer.process('abc')
    expect(data).toEqual(['a', 'b', 'c'])
  })

  it('accumulates split escape sequences until complete', () => {
    const buffer = new StdinBuffer()
    const data: string[] = []
    buffer.on('data', (sequence) => data.push(sequence))
    buffer.process('\x1b[')
    expect(data).toEqual([])
    buffer.process('<35;20;5m')
    expect(data).toEqual(['\x1b[<35;20;5m'])
  })

  it('flushes incomplete sequences after the timeout', () => {
    vi.useFakeTimers()
    try {
      const buffer = new StdinBuffer()
      const data: string[] = []
      buffer.on('data', (sequence) => data.push(sequence))
      buffer.process('\x1b[')
      expect(data).toEqual([])
      vi.advanceTimersByTime(10)
      expect(data).toEqual(['\x1b['])
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits bracketed paste content as a paste event', () => {
    const buffer = new StdinBuffer()
    const pastes: string[] = []
    buffer.on('paste', (content) => pastes.push(content))
    buffer.process('\x1b[200~hello world\x1b[201~')
    expect(pastes).toEqual(['hello world'])
  })

  it('handles paste split across chunks', () => {
    const buffer = new StdinBuffer()
    const pastes: string[] = []
    buffer.on('paste', (content) => pastes.push(content))
    buffer.process('\x1b[200~hel')
    buffer.process('lo\x1b[201~')
    expect(pastes).toEqual(['hello'])
  })

  it('emits input around a paste separately', () => {
    const buffer = new StdinBuffer()
    const data: string[] = []
    const pastes: string[] = []
    buffer.on('data', (sequence) => data.push(sequence))
    buffer.on('paste', (content) => pastes.push(content))
    buffer.process('a\x1b[200~b\x1b[201~c')
    expect(data).toEqual(['a', 'c'])
    expect(pastes).toEqual(['b'])
  })

  it('dedupes a kitty CSI-u printable followed by the raw codepoint', () => {
    const buffer = new StdinBuffer()
    const data: string[] = []
    buffer.on('data', (sequence) => data.push(sequence))
    // Terminal sends \x1b[97u (kitty) then 'a' (legacy fallback for the same key)
    buffer.process('\x1b[97ua')
    expect(data).toEqual(['\x1b[97u'])
  })

  it('emits legacy mouse sequences as single events', () => {
    const buffer = new StdinBuffer()
    const data: string[] = []
    buffer.on('data', (sequence) => data.push(sequence))
    buffer.process('\x1b[M\x00\x1c\x20')
    expect(data).toEqual(['\x1b[M\x00\x1c\x20'])
  })

  it('can be destroyed without error', () => {
    const buffer = new StdinBuffer()
    buffer.process('abc')
    buffer.destroy()
    expect(buffer.getBuffer()).toBe('')
  })
})
