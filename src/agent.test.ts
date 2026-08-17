// Tests for src/agent.ts — the agent loop driven by a mocked LLM `stream`.
// `runAgent` imports `stream` from './llm.js'; we replace it with a controllable
// mock so the model is fully faked and no network is touched.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { runAgent, type AgentTool, type AgentEvent } from './agent.js'
import { stream, type Model, type Context, type StreamEvent } from './llm.js'

vi.mock('./llm.js', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('./llm.js')
  return { ...actual, stream: vi.fn() }
})

const model: Model = { apiKey: 'k', model: 'm' }

function mockStream(...sequences: StreamEvent[][]): void {
  const viMock = vi.mocked(stream)
  viMock.mockReset()
  // mockImplementationOnce queues FIFO, so call N uses sequences[N-1].
  for (const seq of sequences) {
    viMock.mockImplementationOnce(async function* () {
      for (const ev of seq) yield ev
    })
  }
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runAgent — event sequence', () => {
  it('streams text deltas and ends the turn on end_turn', async () => {
    mockStream([
      { type: 'text_delta', delta: 'hello ' },
      { type: 'text_delta', delta: 'world' },
      { type: 'done', stopReason: 'end_turn' },
    ])

    const ctx: Context = { messages: [] }
    const events = await collect(runAgent(model, ctx, [], undefined))

    expect(events).toEqual([
      { type: 'assistant_text', delta: 'hello ' },
      { type: 'assistant_text', delta: 'world' },
      { type: 'turn_end', stopReason: 'end_turn' },
    ])
    // The assistant reply is written back into the context.
    expect(ctx.messages).toHaveLength(1)
    expect(ctx.messages[0]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'hello world' }] })
  })

  it('executes a tool call, feeds the result back, and continues to a final text turn', async () => {
    const tool: AgentTool = {
      name: 'read_file',
      description: 'read',
      parameters: {},
      execute: async () => 'file contents',
    }
    mockStream(
      [
        { type: 'text_delta', delta: 'let me read' },
        { type: 'tool_call', id: 'c1', name: 'read_file', args: { path: '/tmp/x' } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', delta: 'done' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    )

    const ctx: Context = { messages: [] }
    const events = await collect(runAgent(model, ctx, [tool], undefined))

    expect(events).toEqual([
      { type: 'assistant_text', delta: 'let me read' },
      { type: 'tool_call', id: 'c1', name: 'read_file', args: { path: '/tmp/x' } },
      { type: 'tool_result', id: 'c1', name: 'read_file', result: 'file contents' },
      { type: 'assistant_text', delta: 'done' },
      { type: 'turn_end', stopReason: 'end_turn' },
    ])
    // assistant turn, tool_result turn, final assistant turn
    expect(ctx.messages).toHaveLength(3)
    expect(ctx.messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'file contents' }],
    })
  })

  it('surfaces an error event and turns the turn_end reason to error', async () => {
    mockStream([
      { type: 'text_delta', delta: 'partial' },
      { type: 'error', error: new Error('boom') },
    ])

    const ctx: Context = { messages: [] }
    const events = await collect(runAgent(model, ctx, [], undefined))

    expect(events).toEqual([
      { type: 'assistant_text', delta: 'partial' },
      { type: 'assistant_text', delta: '\n[error] boom' },
      { type: 'turn_end', stopReason: 'error' },
    ])
  })

  it('handles an aborted done event by ending the turn without tool calls', async () => {
    mockStream([
      { type: 'text_delta', delta: 'thinking' },
      { type: 'done', stopReason: 'aborted' },
    ])

    const ctx: Context = { messages: [] }
    const events = await collect(runAgent(model, ctx, [], undefined))

    expect(events).toEqual([
      { type: 'assistant_text', delta: 'thinking' },
      { type: 'turn_end', stopReason: 'aborted' },
    ])
    // On abort the partial text is kept but tool calls are dropped.
    expect(ctx.messages).toHaveLength(1)
    expect(ctx.messages[0].role).toBe('assistant')
  })
})
