// Tests for src/llm.ts — SSE stream parsing and context conversion.
// The LLM `stream()` function performs a real `fetch`; we stub `fetch` to return
// a Response whose body is an SSE byte stream, then assert the emitted event sequence.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { stream, contextToOpenAIMessages, type Model, type Context, type StreamEvent } from './llm.js'
import { collect } from './test-utils.js'

// --- helpers -------------------------------------------------------------

const model: Model = { apiKey: 'test-key', model: 'test-model', baseUrl: 'https://example.com/v1' }

/** Build an SSE body from a list of OpenAI chunk objects. */
function sseBody(...chunks: unknown[]): string {
  return chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('')
}

/** Wrap a string body in a Response with an in-memory ReadableStream. */
function sseResponse(body: string, init: ResponseInit = {}): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body))
      controller.close()
    },
  })
  return new Response(stream, init)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// --- contextToOpenAIMessages --------------------------------------------

describe('contextToOpenAIMessages', () => {
  it('includes the system prompt as a system message', () => {
    const ctx: Context = { systemPrompt: 'be helpful', messages: [] }
    expect(contextToOpenAIMessages(ctx)).toEqual([{ role: 'system', content: 'be helpful' }])
  })

  it('passes string-content messages through verbatim', () => {
    const ctx: Context = { messages: [{ role: 'user', content: 'hello' }] }
    expect(contextToOpenAIMessages(ctx)).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('converts assistant text + tool_use blocks into content + tool_calls', () => {
    const ctx: Context = {
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'sure' },
          { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: '/x' } },
        ],
      }],
    }
    expect(contextToOpenAIMessages(ctx)).toEqual([{
      role: 'assistant',
      content: 'sure',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/x"}' } }],
    }])
  })

  it('emits a separate role:tool message for tool_result blocks', () => {
    const ctx: Context = {
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'file data' }],
      }],
    }
    expect(contextToOpenAIMessages(ctx)).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'file data' },
    ])
  })

  it('uses null content for a pure tool_use assistant turn', () => {
    const ctx: Context = {
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'read_file', input: {} }],
      }],
    }
    const [m] = contextToOpenAIMessages(ctx) as Array<{ content: unknown }>
    expect(m.content).toBeNull()
  })
})

// --- stream parsing ------------------------------------------------------

describe('stream — SSE parsing', () => {
  it('emits text_delta events then a done(end_turn) on a text stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(sseBody(
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' world' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ))))

    const events = await collect(stream(model, { messages: [] }))
    expect(events).toEqual([
      { type: 'text_delta', delta: 'Hello' },
      { type: 'text_delta', delta: ' world' },
      { type: 'done', stopReason: 'end_turn' },
    ])
  })

  it('accumulates streamed tool_call deltas and emits a tool_call + done(tool_use)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(sseBody(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"/tmp/x"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ))))

    const events = await collect(stream(model, { messages: [] }))
    expect(events).toEqual([
      { type: 'tool_call', id: 'c1', name: 'read_file', args: { path: '/tmp/x' } },
      { type: 'done', stopReason: 'tool_use' },
    ])
  })

  it('maps finish_reason length to done(max_tokens)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(sseBody(
      { choices: [{ delta: { content: 'trunc' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ))))

    const events = await collect(stream(model, { messages: [] }))
    expect(events[events.length - 1]).toEqual({ type: 'done', stopReason: 'max_tokens' })
  })

  it('emits an error event when fetch throws (network failure)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))

    const events = await collect(stream(model, { messages: [] }))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('error')
    if (events[0].type === 'error') {
      expect(events[0].error).toBeInstanceOf(Error)
      expect(events[0].error.message).toBe('network down')
    }
  })

  it('emits an error event on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse('', { status: 500, statusText: 'Server Error' })))

    const events = await collect(stream(model, { messages: [] }))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('error')
    if (events[0].type === 'error') {
      expect(events[0].error).toBeInstanceOf(Error)
      expect(events[0].error.message).toContain('API 500')
    }
  })

  it('tolerates unparseable SSE lines without emitting events for them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(
      `data: not-json\n\n` + sseBody({ choices: [{ delta: { content: 'ok' } }] }),
    )))

    const events = await collect(stream(model, { messages: [] }))
    expect(events).toEqual([
      { type: 'text_delta', delta: 'ok' },
      { type: 'done', stopReason: 'end_turn' },
    ])
  })
})
