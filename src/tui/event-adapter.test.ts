// Tests for src/tui/event-adapter.ts — mapping agent events to transcript
// state, hydrating the transcript from a persisted session, and driving
// renders through the boot screen.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentEvent } from '../agent.js'
import type { Message } from '../llm.js'
import { createBootScreen } from './boot/screen.js'
import { AgentEventAdapter, hydrateTranscript } from './event-adapter.js'
import { FakeTerminal } from './fake-terminal.js'
import { stripAnsi } from './utils.js'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
})

afterEach(() => {
  vi.useRealTimers()
})

async function flushRender(): Promise<void> {
  await new Promise((resolve) => process.nextTick(resolve))
  await vi.advanceTimersByTimeAsync(16)
}

async function startBoot(): Promise<{ term: FakeTerminal; boot: ReturnType<typeof createBootScreen> }> {
  const term = new FakeTerminal(80, 24)
  const boot = createBootScreen(term, { model: 'glm-5.2', cwd: '/tmp/proj' })
  boot.tui.start()
  await flushRender()
  return { term, boot }
}

describe('AgentEventAdapter', () => {
  it('maps events to transcript state and requests a render', async () => {
    const { term, boot } = await startBoot()
    const adapter = new AgentEventAdapter(boot.transcript, () => boot.tui.requestRender())
    const events: AgentEvent[] = [
      { type: 'assistant_text', delta: 'Hel' },
      { type: 'assistant_text', delta: 'lo' },
      { type: 'tool_call', id: 't1', name: 'read_file', args: { path: '/x' } },
      { type: 'tool_result', id: 't1', name: 'read_file', result: 'data' },
      { type: 'turn_end', stopReason: 'end_turn' },
    ]
    for (const ev of events) {
      adapter.handle(ev)
      await flushRender()
    }
    const rendered = stripAnsi(term.output)
    expect(rendered).toContain('Assistant: Hello')
    // Tool blocks render collapsed; the result stays hidden until expanded
    expect(rendered).toContain('Tool: read_file')
    expect(rendered).not.toContain('data')
    boot.transcript.setToolsExpanded(true)
    boot.tui.requestRender()
    await flushRender()
    expect(stripAnsi(term.output)).toContain('data')
  })

  it('streams assistant deltas into one block and opens a new one after a tool round', async () => {
    const { boot } = await startBoot()
    const adapter = new AgentEventAdapter(boot.transcript, () => boot.tui.requestRender())
    adapter.handle({ type: 'assistant_text', delta: 'a' })
    adapter.handle({ type: 'assistant_text', delta: 'b' })
    adapter.handle({ type: 'tool_call', id: 't1', name: 'grep', args: {} })
    adapter.handle({ type: 'tool_result', id: 't1', name: 'grep', result: 'ok' })
    adapter.handle({ type: 'assistant_text', delta: 'c' })
    adapter.handle({ type: 'turn_end', stopReason: 'end_turn' })

    const blocks = boot.transcript.getBlocks()
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toMatchObject({ kind: 'assistant', text: 'ab' })
    expect(blocks[1]).toMatchObject({ kind: 'tool', name: 'grep', result: 'ok' })
    expect(blocks[2]).toMatchObject({ kind: 'assistant', text: 'c' })
  })

  it('notifies the render callback on every event', async () => {
    const { boot } = await startBoot()
    const requestRender = vi.fn()
    const adapter = new AgentEventAdapter(boot.transcript, requestRender)
    adapter.handle({ type: 'assistant_text', delta: 'x' })
    adapter.handle({ type: 'turn_end', stopReason: 'end_turn' })
    expect(requestRender).toHaveBeenCalledTimes(2)
  })

  it('appends the user turn to the transcript on submit', async () => {
    const { term, boot } = await startBoot()
    const adapter = new AgentEventAdapter(boot.transcript, () => boot.tui.requestRender(), boot.input)
    boot.input.onSubmit = (value) => adapter.submit(value)

    term.emitInput('hi')
    term.emitInput('\r')
    await flushRender()

    expect(boot.transcript.getBlocks()).toEqual([{ kind: 'user', text: 'hi' }])
    expect(boot.input.getValue()).toBe('')
    expect(stripAnsi(term.output)).toContain('You: hi')
  })
})

describe('hydrateTranscript', () => {
  it('renders string messages as role-labeled blocks', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello there' },
    ]
    const t = hydrateTranscript(messages)
    expect(t.render(80).map(stripAnsi)).toEqual(['You: hi', 'Assistant: hello there'])
  })

  it('renders tool_use / tool_result content blocks', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: '/x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data' }] },
    ]
    const t = hydrateTranscript(messages)
    t.setToolsExpanded(true)
    expect(t.render(80).map(stripAnsi)).toEqual(['Tool: read_file', '  {"path":"/x"}', '  data'])
  })

  it('attaches a tool result to the tool block that precedes it', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'a', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r1' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'b', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'r2' }] },
    ]
    const t = hydrateTranscript(messages)
    const blocks = t.getBlocks()
    expect(blocks.map((b) => (b.kind === 'tool' ? b.result : null))).toEqual(['r1', 'r2'])
  })

  it('leaves the transcript empty for no messages', () => {
    expect(hydrateTranscript([]).render(80)).toEqual([])
  })
})
