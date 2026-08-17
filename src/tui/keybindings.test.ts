// Tests for src/tui/keybindings.ts — keybinding resolution and conflict detection.

import { describe, it, expect, afterEach } from 'vitest'
import { KeybindingsManager, TUI_KEYBINDINGS } from './keybindings.js'
import { setKittyProtocolActive } from './keys.js'

afterEach(() => {
  setKittyProtocolActive(false)
})

describe('KeybindingsManager — default bindings', () => {
  it('resolves default keys for an action', () => {
    const kb = new KeybindingsManager(TUI_KEYBINDINGS)
    expect(kb.getKeys('tui.editor.cursorLeft')).toEqual(['left', 'ctrl+b'])
  })

  it('matches default key sequences', () => {
    const kb = new KeybindingsManager(TUI_KEYBINDINGS)
    expect(kb.matches('\x1b[D', 'tui.editor.cursorLeft')).toBe(true)
    expect(kb.matches('\x02', 'tui.editor.cursorLeft')).toBe(true) // ctrl+b
    expect(kb.matches('\x1b[C', 'tui.editor.cursorLeft')).toBe(false) // right arrow
  })
})

describe('KeybindingsManager — user overrides', () => {
  it('replaces default keys with user bindings', () => {
    const kb = new KeybindingsManager(TUI_KEYBINDINGS, {
      'tui.editor.cursorLeft': 'ctrl+g',
    })
    expect(kb.matches('\x07', 'tui.editor.cursorLeft')).toBe(true) // ctrl+g
    expect(kb.matches('\x02', 'tui.editor.cursorLeft')).toBe(false) // ctrl+b removed
  })

  it('adds keys without removing defaults when the new key is not claimed elsewhere', () => {
    const kb = new KeybindingsManager(TUI_KEYBINDINGS, {
      'tui.editor.cursorLeft': ['left', 'ctrl+g'],
    })
    expect(kb.matches('\x1b[D', 'tui.editor.cursorLeft')).toBe(true)
    expect(kb.matches('\x07', 'tui.editor.cursorLeft')).toBe(true)
  })

  it('updates bindings via setUserBindings', () => {
    const kb = new KeybindingsManager(TUI_KEYBINDINGS)
    kb.setUserBindings({ 'tui.editor.undo': 'ctrl+z' })
    expect(kb.matches('\x1a', 'tui.editor.undo')).toBe(true) // ctrl+z
    expect(kb.matches('\x1f', 'tui.editor.undo')).toBe(false) // ctrl+- removed
  })
})

describe('KeybindingsManager — conflict detection', () => {
  it('reports conflicts when two actions claim the same key', () => {
    const kb = new KeybindingsManager(TUI_KEYBINDINGS, {
      'tui.editor.cursorLeft': 'ctrl+x',
      'tui.editor.cursorRight': 'ctrl+x',
    })
    const conflicts = kb.getConflicts()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.key).toBe('ctrl+x')
    expect(conflicts[0]!.keybindings).toContain('tui.editor.cursorLeft')
    expect(conflicts[0]!.keybindings).toContain('tui.editor.cursorRight')
  })

  it('reports no conflicts for default bindings', () => {
    const kb = new KeybindingsManager(TUI_KEYBINDINGS)
    expect(kb.getConflicts()).toEqual([])
  })

  it('yields a default key to an explicit claim in the same scope', () => {
    const kb = new KeybindingsManager(TUI_KEYBINDINGS, {
      'tui.editor.cursorRight': 'left',
    })
    // 'left' is explicitly claimed by cursorRight in the editor scope, so
    // cursorLeft's default 'left' binding is dropped without a conflict.
    expect(kb.matches('\x1b[D', 'tui.editor.cursorLeft')).toBe(false)
    expect(kb.matches('\x1b[D', 'tui.editor.cursorRight')).toBe(true)
    expect(kb.getConflicts()).toEqual([])
  })
})
