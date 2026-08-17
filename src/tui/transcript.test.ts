// Tests for src/tui/boot/transcript.ts — role-labeled blocks
// (You / Assistant / Tool) rendered as wrapped rows.

import { describe, it, expect } from 'vitest'
import { Transcript } from './boot/transcript.js'
import { stripAnsi } from './utils.js'

describe('Transcript role-labeled blocks', () => {
  it('renders a user block with the You label', () => {
    const t = new Transcript()
    t.addUser('hello')
    expect(t.render(80).map(stripAnsi)).toEqual(['You: hello'])
  })

  it('streams assistant text into a single block across deltas', () => {
    const t = new Transcript()
    t.appendAssistant('Hel')
    t.appendAssistant('lo ')
    t.appendAssistant('world')
    expect(t.getBlocks()).toHaveLength(1)
    expect(t.render(80).map(stripAnsi)).toEqual(['Assistant: Hello world'])
  })

  it('starts a fresh assistant block after a user turn', () => {
    const t = new Transcript()
    t.addUser('hi')
    t.appendAssistant('one')
    t.addUser('again')
    t.appendAssistant('two')
    expect(t.render(80).map(stripAnsi)).toEqual([
      'You: hi',
      'Assistant: one',
      'You: again',
      'Assistant: two',
    ])
  })

  it('endTurn closes the streaming assistant block', () => {
    const t = new Transcript()
    t.appendAssistant('part one')
    t.endTurn()
    t.appendAssistant('part two')
    expect(t.getBlocks()).toHaveLength(2)
  })

  it('renders tool blocks with name, args, and result', () => {
    const t = new Transcript()
    t.addTool('read_file', { path: '/tmp/x' })
    t.setToolResult('contents')
    expect(t.render(80).map(stripAnsi)).toEqual([
      'Tool: read_file',
      '  {"path":"/tmp/x"}',
      '  contents',
    ])
  })

  it('renders a tool block without args or result', () => {
    const t = new Transcript()
    t.addTool('read_file')
    expect(t.render(80).map(stripAnsi)).toEqual(['Tool: read_file'])
  })

  it('keeps the tool result attached to the last tool block', () => {
    const t = new Transcript()
    t.addTool('a')
    t.addTool('b')
    t.setToolResult('result for b')
    const blocks = t.getBlocks()
    expect(blocks).toHaveLength(2)
    expect(blocks[1]).toMatchObject({ kind: 'tool', name: 'b', result: 'result for b' })
    expect(blocks[0]).toMatchObject({ kind: 'tool', name: 'a', result: null })
  })

  it('wraps long assistant text and indents continuation lines', () => {
    const t = new Transcript()
    t.appendAssistant(Array.from({ length: 12 }, (_, i) => `w${i}`).join(' '))
    const lines = t.render(20).map(stripAnsi)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[0]).toMatch(/^Assistant: /)
    for (const line of lines.slice(1)) {
      expect(line.startsWith(' '.repeat('Assistant: '.length))).toBe(true)
    }
  })

  it('keeps legacy raw lines working', () => {
    const t = new Transcript()
    t.appendLine('You: legacy')
    expect(t.render(80)).toEqual(['You: legacy'])
    expect(t.getLines()).toEqual(['You: legacy'])
  })

  it('clears all blocks', () => {
    const t = new Transcript()
    t.addUser('a')
    t.appendAssistant('b')
    t.clear()
    expect(t.render(80)).toEqual([])
    expect(t.getBlocks()).toEqual([])
  })
})
