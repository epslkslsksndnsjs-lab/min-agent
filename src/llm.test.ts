// Tests for src/llm.ts — SSE stream parsing and context conversion.
// The LLM `stream()` function performs a real `fetch`; we stub `fetch` to return
// a Response whose body is an SSE byte stream, then assert the emitted event sequence.

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  stream,
  contextToOpenAIMessages,
  estimateTokens,
  TokenTracker,
  isRetryableAssistantError,
  formatProviderError,
  isRetryableProviderStatus,
  getRetryDelayMs,
  retrySleep,
  type Model,
  type Context,
  type StreamEvent,
  type Message,
} from './llm.js'
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

  it('converts assistant text + tool_use blocks into content + tool_calls (with its tool_result)', () => {
    const ctx: Context = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'sure' },
            { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: '/x' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
      ],
    }
    expect(contextToOpenAIMessages(ctx)).toEqual([
      {
        role: 'assistant',
        content: 'sure',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/x"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ])
  })

  it('emits a separate role:tool message for a tool_result that follows an assistant', () => {
    const ctx: Context = {
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read_file', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'file data' }] },
      ],
    }
    expect(contextToOpenAIMessages(ctx)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
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

  it('emits a usage event from the final chunk when usage is requested', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(sseBody(
      { choices: [{ delta: { content: 'hi' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } },
    ))))

    const events = await collect(stream(model, { messages: [] }))
    expect(events).toEqual([
      { type: 'text_delta', delta: 'hi' },
      { type: 'usage', usage: { promptTokens: 12, completionTokens: 5, totalTokens: 17 } },
      { type: 'done', stopReason: 'end_turn' },
    ])
  })

  it('requests usage via stream_options.include_usage', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => sseResponse(''))
    vi.stubGlobal('fetch', fetchMock)

    await collect(stream(model, { messages: [] }))
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('ignores a usage chunk that lacks total_tokens', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(sseBody(
      { choices: [], usage: { prompt_tokens: 1 } },
      { choices: [{ delta: { content: 'x' } }] },
    ))))

    const events = await collect(stream(model, { messages: [] }))
    expect(events).toEqual([
      { type: 'text_delta', delta: 'x' },
      { type: 'done', stopReason: 'end_turn' },
    ])
  })
})

// --- error classification (copied from pi: retry.ts / error-body.ts / provider-retry.ts) ---

describe('error classification (pi retry.ts)', () => {
  it('treats quota/billing exhaustion as non-retryable', () => {
    expect(isRetryableAssistantError('insufficient_quota')).toBe(false)
    expect(isRetryableAssistantError('Error: out of budget')).toBe(false)
    expect(isRetryableAssistantError('Monthly usage limit reached')).toBe(false)
    expect(isRetryableAssistantError('billing problem')).toBe(false)
  })

  it('treats transient HTTP/transport errors as retryable', () => {
    expect(isRetryableAssistantError('API 429: rate limit')).toBe(true)
    expect(isRetryableAssistantError('API 500: internal error')).toBe(true)
    expect(isRetryableAssistantError('fetch failed')).toBe(true)
    expect(isRetryableAssistantError('network error: connection refused')).toBe(true)
    expect(isRetryableAssistantError('stream ended before message_stop')).toBe(true)
    expect(isRetryableAssistantError('please retry your request')).toBe(true)
  })

  it('treats empty messages as non-retryable', () => {
    expect(isRetryableAssistantError(undefined)).toBe(false)
    expect(isRetryableAssistantError('')).toBe(false)
  })
})

describe('formatProviderError (pi error-body.ts)', () => {
  it('formats status + body', () => {
    expect(formatProviderError(429, 'rate limit', 'RateLimitError')).toBe('API 429: rate limit')
  })
  it('falls back to status + message when body is empty', () => {
    expect(formatProviderError(500, '', 'Server Error')).toBe('API 500: Server Error')
  })
  it('falls back to the raw message when there is no status', () => {
    expect(formatProviderError(undefined, undefined, 'fetch failed')).toBe('fetch failed')
  })
})

describe('isRetryableProviderStatus (pi provider-retry.ts)', () => {
  it('retries 408/409/429 and 5xx, but not other 4xx', () => {
    expect(isRetryableProviderStatus(408, undefined)).toBe(true)
    expect(isRetryableProviderStatus(429, undefined)).toBe(true)
    expect(isRetryableProviderStatus(503, undefined)).toBe(true)
    expect(isRetryableProviderStatus(400, undefined)).toBe(false)
    expect(isRetryableProviderStatus(404, undefined)).toBe(false)
  })
  it('retries an undefined status (network failure)', () => {
    expect(isRetryableProviderStatus(undefined, undefined)).toBe(true)
  })
  it('honors the x-should-retry header', () => {
    expect(isRetryableProviderStatus(400, new Headers({ 'x-should-retry': 'true' }))).toBe(true)
    expect(isRetryableProviderStatus(200, new Headers({ 'x-should-retry': 'false' }))).toBe(false)
  })
})

describe('getRetryDelayMs (pi provider-retry.ts)', () => {
  it('prefers the retry-after-ms header', () => {
    expect(getRetryDelayMs(new Headers({ 'retry-after-ms': '50' }), 0, 1000, undefined)).toBe(50)
  })
  it('parses the retry-after header as seconds', () => {
    expect(getRetryDelayMs(new Headers({ 'retry-after': '2' }), 0, 1000, undefined)).toBe(2000)
  })
  it('falls back to exponential backoff capped by maxRetryDelayMs', () => {
    const d = getRetryDelayMs(undefined, 0, 1000, 10)
    expect(d).toBeGreaterThan(0)
    expect(d).toBeLessThanOrEqual(10)
  })
})

// --- stream request retry (pi provider-retry.ts) ------------------------

describe('stream — request retry (pi provider-retry.ts)', () => {
  const retry = { enabled: true, maxRetries: 2, baseDelayMs: 1, maxRetryDelayMs: 1000 }

  it('retries a 429 then succeeds', async () => {
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce(sseResponse('', { status: 429, statusText: 'Too Many Requests' }))
    fetchMock.mockResolvedValueOnce(sseResponse(sseBody(
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    )))
    vi.stubGlobal('fetch', fetchMock)

    const events = await collect(stream(model, { messages: [] }, { retry }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(events.some((e) => e.type === 'retry')).toBe(true)
    expect(events[events.length - 1]).toEqual({ type: 'done', stopReason: 'end_turn' })
  })

  it('exhausts retries on a persistent 500 and emits an error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse('', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    const events = await collect(stream(model, { messages: [] }, { retry }))
    expect(fetchMock).toHaveBeenCalledTimes(3) // initial + 2 retries
    expect(events[events.length - 1].type).toBe('error')
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(2)
  })

  it('does not retry a non-retryable 400', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse('', { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    const events = await collect(stream(model, { messages: [] }, { retry }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(events.some((e) => e.type === 'retry')).toBe(false)
    expect(events[events.length - 1].type).toBe('error')
  })

  it('retries a network failure (fetch throws) then succeeds', async () => {
    const fetchMock = vi.fn()
    fetchMock.mockRejectedValueOnce(new Error('fetch failed'))
    fetchMock.mockResolvedValueOnce(sseResponse(sseBody(
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    )))
    vi.stubGlobal('fetch', fetchMock)

    const events = await collect(stream(model, { messages: [] }, { retry }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(events[events.length - 1]).toEqual({ type: 'done', stopReason: 'end_turn' })
  })

  it('does not retry when the policy is disabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse('', { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)
    const disabled = { enabled: false, maxRetries: 2, baseDelayMs: 1 }

    const events = await collect(stream(model, { messages: [] }, { retry: disabled }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(events[events.length - 1].type).toBe('error')
  })

  it('yields an error (never throws) when the server requests a delay over the cap', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseResponse('', { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after-ms': '99999999' } }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const events = await collect(
      stream(model, { messages: [] }, { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, maxRetryDelayMs: 1000 } }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1) // no retry after the hard failure
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(0)
    const last = events[events.length - 1]
    expect(last.type).toBe('error')
    expect((last as { error: Error }).error.message).toMatch(/retry delay/)
  })
})

// --- retrySleep ----------------------------------------------------------

describe('retrySleep (pi retry.ts)', () => {
  it('resolves after the delay and removes its abort listener', async () => {
    const listeners = new Set<() => void>()
    const signal = {
      aborted: false,
      addEventListener: (_type: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_type: string, fn: () => void) => listeners.delete(fn),
    } as unknown as AbortSignal

    await retrySleep(1, signal)
    expect(listeners.size).toBe(0)
  })

  it('rejects when aborted during the sleep', async () => {
    const ac = new AbortController()
    const sleeping = retrySleep(10_000, ac.signal)
    ac.abort()
    await expect(sleeping).rejects.toThrow()
  })
})

// --- token accounting ----------------------------------------------------

describe('token accounting', () => {
  it('estimates tokens as chars / 4 rounded up', () => {
    expect(estimateTokens(0)).toBe(0)
    expect(estimateTokens(4)).toBe(1)
    expect(estimateTokens(5)).toBe(2)
    expect(estimateTokens(100)).toBe(25)
  })

  it('reports the character estimate while streaming', () => {
    const tracker = new TokenTracker()
    tracker.addChars(40)
    expect(tracker.reported).toBe(10)
  })

  it('never decreases when authoritative usage arrives', () => {
    const tracker = new TokenTracker()
    tracker.addChars(40) // estimate 10
    expect(tracker.reported).toBe(10)

    tracker.setAuthoritative(30)
    expect(tracker.reported).toBe(30)

    // A stale or smaller authoritative value must not lower the count
    tracker.setAuthoritative(5)
    expect(tracker.reported).toBe(30)

    tracker.addChars(40) // estimate 20, still below authoritative
    expect(tracker.reported).toBe(30)

    tracker.addChars(80) // estimate 40 now exceeds authoritative
    expect(tracker.reported).toBe(40)
  })
})
