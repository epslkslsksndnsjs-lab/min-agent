// Tests for src/tui/keys.ts — key sequence matching and parsing.

import { describe, it, expect, afterEach } from 'vitest'
import {
  decodeKittyPrintable,
  isKeyRelease,
  matchesKey,
  parseKey,
  setKittyProtocolActive,
} from './keys.js'

afterEach(() => {
  setKittyProtocolActive(false)
})

describe('matchesKey — plain and control keys', () => {
  it('matches plain letters', () => {
    expect(matchesKey('a', 'a')).toBe(true)
    expect(matchesKey('b', 'a')).toBe(false)
  })

  it('matches legacy control characters', () => {
    expect(matchesKey('\r', 'enter')).toBe(true)
    expect(matchesKey('\n', 'enter')).toBe(true) // legacy: \n is enter when kitty is off
    expect(matchesKey('\t', 'tab')).toBe(true)
    expect(matchesKey('\x7f', 'backspace')).toBe(true)
    expect(matchesKey('\x1b', 'escape')).toBe(true)
    expect(matchesKey('\x03', 'ctrl+c')).toBe(true)
    expect(matchesKey('\x01', 'ctrl+a')).toBe(true)
    expect(matchesKey(' ', 'space')).toBe(true)
  })

  it('matches shift+tab via CSI Z', () => {
    expect(matchesKey('\x1b[Z', 'shift+tab')).toBe(true)
  })

  it('matches alt+letter via ESC prefix in legacy mode', () => {
    expect(matchesKey('\x1bx', 'alt+x')).toBe(true)
  })
})

describe('matchesKey — cursor keys', () => {
  it('matches arrow keys', () => {
    expect(matchesKey('\x1b[A', 'up')).toBe(true)
    expect(matchesKey('\x1b[B', 'down')).toBe(true)
    expect(matchesKey('\x1b[C', 'right')).toBe(true)
    expect(matchesKey('\x1b[D', 'left')).toBe(true)
  })

  it('matches home/end/delete', () => {
    expect(matchesKey('\x1b[H', 'home')).toBe(true)
    expect(matchesKey('\x1b[F', 'end')).toBe(true)
    expect(matchesKey('\x1b[3~', 'delete')).toBe(true)
  })

  it('matches ctrl+left', () => {
    expect(matchesKey('\x1b[1;5D', 'ctrl+left')).toBe(true)
  })
})

describe('matchesKey — kitty protocol', () => {
  it('matches CSI-u sequences when the protocol is active', () => {
    setKittyProtocolActive(true)
    // \x1b[13u = enter with modifier 0 (mod value 1 - 1)
    expect(matchesKey('\x1b[13u', 'enter')).toBe(true)
    expect(matchesKey('\x1b[97u', 'a')).toBe(true)
    expect(matchesKey('\x1b[97;5u', 'ctrl+a')).toBe(true)
  })

  it('matches modified enter via CSI-u', () => {
    setKittyProtocolActive(true)
    // shift+enter: codepoint 13, modifier value 2 -> bits 1
    expect(matchesKey('\x1b[13;2u', 'shift+enter')).toBe(true)
  })

  it('matches kitty escape codepoint', () => {
    setKittyProtocolActive(true)
    expect(matchesKey('\x1b[27u', 'escape')).toBe(true)
  })
})

describe('parseKey', () => {
  it('parses plain and special keys', () => {
    expect(parseKey('a')).toBe('a')
    expect(parseKey('\r')).toBe('enter')
    expect(parseKey('\x03')).toBe('ctrl+c')
    expect(parseKey('\x1b[A')).toBe('up')
    expect(parseKey('\x1b[Z')).toBe('shift+tab')
    expect(parseKey('\x7f')).toBe('backspace')
    expect(parseKey('\t')).toBe('tab')
    expect(parseKey(' ')).toBe('space')
  })

  it('parses kitty CSI-u sequences', () => {
    setKittyProtocolActive(true)
    expect(parseKey('\x1b[13u')).toBe('enter')
    expect(parseKey('\x1b[97u')).toBe('a')
    expect(parseKey('\x1b[97;5u')).toBe('ctrl+a')
  })
})

describe('isKeyRelease', () => {
  it('detects kitty release events', () => {
    expect(isKeyRelease('\x1b[97;1:3u')).toBe(true)
    expect(isKeyRelease('\x1b[97;1:2u')).toBe(false) // repeat
    expect(isKeyRelease('\x1b[97u')).toBe(false) // press
  })

  it('ignores bracketed paste content', () => {
    expect(isKeyRelease('\x1b[200~90:62:3F:A5\x1b[201~')).toBe(false)
  })
})

describe('decodeKittyPrintable', () => {
  it('decodes plain CSI-u printable characters', () => {
    expect(decodeKittyPrintable('\x1b[97u')).toBe('a')
    expect(decodeKittyPrintable('\x1b[20013u')).toBe('\u4e2d') // U+4E2D
  })

  it('rejects control sequences', () => {
    expect(decodeKittyPrintable('\x1b[1;5u')).toBeUndefined() // ctrl+a
  })
})
