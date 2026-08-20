// Tests for src/tui/boot/transcript.ts — role-labeled blocks
// (You / Assistant / Tool) rendered as wrapped rows.

import { describe, it, expect } from 'vitest'
import { Transcript } from './boot/transcript.js'
import { stripAnsi } from './utils.js'

// Strip ANSI and trailing whitespace (lines are padded to full width).
const clean = (s: string) => stripAnsi(s).trim()

describe('Transcript role-labeled blocks', () => {
  it('renders a user block with the You label', () => {
    const t = new Transcript()
    t.addUser('hello')
    expect(t.render(80).map(clean)).toEqual(['You: hello'])
  })

  it('streams assistant text into a single block across deltas', () => {
    const t = new Transcript()
    t.appendAssistant('Hel')
    t.appendAssistant('lo ')
    t.appendAssistant('world')
    expect(t.getBlocks()).toHaveLength(1)
    // Assistant text renders as Markdown without an "Assistant: " prefix.
    expect(t.render(80).map(clean)).toEqual(['Hello world'])
  })

  it('starts a fresh assistant block after a user turn', () => {
    const t = new Transcript()
    t.addUser('hi')
    t.appendAssistant('one')
    t.addUser('again')
    t.appendAssistant('two')
    expect(t.render(80).map(clean)).toEqual([
      'You: hi',
      'one',
      'You: again',
      'two',
    ])
  })

  it('endTurn closes the streaming assistant block', () => {
    const t = new Transcript()
    t.appendAssistant('part one')
    t.endTurn()
    t.appendAssistant('part two')
    expect(t.getBlocks()).toHaveLength(2)
  })

  it('renders tool blocks collapsed with the name, status, and expand hint', () => {
    const t = new Transcript()
    t.addTool('read_file', { path: '/tmp/x' })
    t.setToolResult('contents')
    expect(t.getBlocks()).toMatchObject([{ kind: 'tool', name: 'read_file', expanded: false, status: 'done' }])
    const lines = t.render(80).map(stripAnsi)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('read_file')
    expect(lines[0]).toContain('done')
    expect(lines[0]).toContain('(ctrl+o to expand)')
  })

  it('expands all tool blocks and renders args and result', () => {
    const t = new Transcript()
    t.addTool('read_file', { path: '/tmp/x' })
    t.setToolResult('contents')
    t.setToolsExpanded(true)
    const lines = t.render(80).map(stripAnsi)
    expect(lines[0]).toContain('read_file')
    expect(lines[0]).toContain('done')
    expect(lines.some((l) => l.includes('args:'))).toBe(true)
    expect(lines.some((l) => l.includes('result: contents'))).toBe(true)
  })

  it('collapses all tool blocks again via setToolsExpanded(false)', () => {
    const t = new Transcript()
    t.addTool('read_file', { path: '/tmp/x' })
    t.setToolResult('contents')
    t.setToolsExpanded(true)
    t.setToolsExpanded(false)
    const lines = t.render(80).map(stripAnsi)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('read_file')
    expect(lines[0]).toContain('(ctrl+o to expand)')
  })

  it('toggles the expand-all state across every tool block', () => {
    const t = new Transcript()
    t.addTool('a')
    t.addTool('b')
    t.toggleToolsExpanded()
    expect(t.getToolsExpanded()).toBe(true)
    expect(t.getBlocks().map((b) => (b.kind === 'tool' ? b.expanded : null))).toEqual([true, true])
    t.toggleToolsExpanded()
    expect(t.getToolsExpanded()).toBe(false)
    expect(t.getBlocks().map((b) => (b.kind === 'tool' ? b.expanded : null))).toEqual([false, false])
  })

  it('new tool blocks inherit the expand-all state', () => {
    const t = new Transcript()
    t.addTool('before')
    expect(t.getBlocks()).toMatchObject([{ kind: 'tool', name: 'before', expanded: false }])
    t.setToolsExpanded(true)
    t.addTool('after')
    // The flip applies to existing blocks; new ones start from the state
    expect(t.getBlocks()).toMatchObject([
      { kind: 'tool', name: 'before', expanded: true },
      { kind: 'tool', name: 'after', expanded: true },
    ])
  })

  it('renders an expanded tool block without args or result', () => {
    const t = new Transcript()
    t.addTool('read_file')
    t.setToolsExpanded(true)
    const lines = t.render(80).map(stripAnsi)
    expect(lines[0]).toContain('read_file')
    expect(lines.some((l) => l.includes('args:'))).toBe(false)
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

  it('matches tool results to their id, not just the last block (batched tool calls)', () => {
    const t = new Transcript()
    t.addTool('a', undefined, 'id-a')
    t.addTool('b', undefined, 'id-b')
    t.setToolResultById('id-a', 'result a')
    t.setToolResultById('id-b', 'result b')
    const blocks = t.getBlocks()
    expect(blocks[0]).toMatchObject({ kind: 'tool', name: 'a', result: 'result a', status: 'done' })
    expect(blocks[1]).toMatchObject({ kind: 'tool', name: 'b', result: 'result b', status: 'done' })
  })

  it('marks a tool error by id', () => {
    const t = new Transcript()
    t.addTool('a', undefined, 'id-a')
    t.setToolResultById('id-a', 'error: boom')
    expect(t.getBlocks()[0]).toMatchObject({ kind: 'tool', name: 'a', status: 'error' })
  })

  it('tracks the four tool statuses (running -> done / error)', () => {
    const t = new Transcript()
    t.addTool('a')
    expect(t.getBlocks()[0]).toMatchObject({ kind: 'tool', status: 'running' })
    t.setToolResult('ok')
    expect(t.getBlocks()[0]).toMatchObject({ status: 'done' })

    const t2 = new Transcript()
    t2.addTool('b')
    expect(t2.getBlocks()[0]).toMatchObject({ status: 'running' })
    t2.setToolResult('error: boom')
    expect(t2.getBlocks()[0]).toMatchObject({ status: 'error' })

    const lines = t2.render(80).map(stripAnsi)
    expect(lines[0]).toContain('b')
    expect(lines[0]).toContain('error')
  })

  it('wraps long assistant text across multiple lines', () => {
    const t = new Transcript()
    t.appendAssistant(Array.from({ length: 12 }, (_, i) => `w${i}`).join(' '))
    const lines = t.render(20).map(clean)
    expect(lines.length).toBeGreaterThan(1)
    // Assistant text renders as Markdown, no "Assistant: " prefix.
    expect(lines[0]).toMatch(/^w0/)
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
