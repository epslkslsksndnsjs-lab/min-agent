// src/llm.ts
// Unified LLM API — parses the OpenAI-compatible Completions SSE response into a unified event stream.
// Only the OpenAI-compatible format is supported (GLM, DeepSeek, Ollama, etc.).

// ===== Types =====

/** Model config */
export type Model = {
  apiKey: string
  model: string          // e.g. "gpt-4o" or "glm-5.2"
  baseUrl?: string       // default https://api.openai.com/v1
  maxTokens?: number     // if unset, the API decides the default (cli.ts sets 4096)
}

/**
 * Content block: a structured unit of message content.
 * tool_result blocks are embedded in a user message's content blocks.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }

/** Message: user / assistant share the same structure */
export type Message = {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

/** Context: plain JSON, can be stringified to disk */
export type Context = {
  systemPrompt?: string
  messages: Message[]
}

/** Stream event: the unified output exposed by the llm module */
export type StreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'usage'; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }
  | { type: 'done'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' }
  | { type: 'error'; error: Error }
  | { type: 'retry'; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }

/** Tool definition format passed in from the agent module */
export type ToolDef = {
  name: string
  description: string
  input_schema: object
}

/**
 * Retry policy for the API request (mirrors pi's `provider-retry.ts` /
 * `retry.ts`). The initial call is never counted as a retry; `maxRetries`
 * bounds the *additional* attempts.
 */
export interface RetryPolicy {
  enabled: boolean
  /** Max *additional* attempts after the initial call (0 = no retries). */
  maxRetries: number
  /** Base delay in ms; per-attempt delay is `baseDelayMs * 2^(attempt-1)`. */
  baseDelayMs: number
  /** Cap on a server-requested retry delay (ms); defaults to {@link DEFAULT_MAX_RETRY_DELAY_MS}. */
  maxRetryDelayMs?: number
}

/** Default retry policy, overridable via env (see `resolveRetryPolicy`). */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  enabled: true,
  maxRetries: 4,
  baseDelayMs: 1000,
  maxRetryDelayMs: 60_000,
}

/** Build a {@link RetryPolicy} from environment variables, falling back to defaults. */
export function resolveRetryPolicy(env: NodeJS.ProcessEnv = process.env): RetryPolicy {
  const num = (v: string | undefined, fallback: number): number => {
    const n = v === undefined ? NaN : Number(v)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }
  const enabled = env.MIN_AGENT_RETRY !== 'false'
  return {
    enabled,
    maxRetries: num(env.MIN_AGENT_MAX_RETRIES, DEFAULT_RETRY_POLICY.maxRetries),
    baseDelayMs: num(env.MIN_AGENT_BASE_DELAY_MS, DEFAULT_RETRY_POLICY.baseDelayMs),
    maxRetryDelayMs: num(env.MIN_AGENT_MAX_RETRY_DELAY_MS, DEFAULT_MAX_RETRY_DELAY_MS),
  }
}

/**
 * Callbacks emitted around each retry so callers (the TUI) can surface retry
 * progress. Mirrors pi's `RetryCallbacks`.
 */
export interface RetryCallbacks {
  /** Before the backoff sleep of each retry attempt (1-indexed). */
  onRetryScheduled?: (attempt: number, maxAttempts: number, delayMs: number, errorMessage: string) => void
  /** After the backoff sleep, immediately before the retried call starts. */
  onRetryAttemptStart?: () => void
  /** Once when the loop ends: success if a later call completed normally. */
  onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void
}

// ===== Helpers =====

// --- error classification (copied from pi: utils/retry.ts) -------------

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
  return new RegExp(patterns.join('|'), 'i')
}

/** Subscription/quota/billing exhaustion — deterministic, never retried. */
const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
  'GoUsageLimitError',
  'FreeUsageLimitError',
  'Monthly usage limit reached',
  'available balance',
  'insufficient_quota',
  'out of budget',
  'quota exceeded',
  'billing',
])

/** Transient provider/transport failures — retried with backoff. */
const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
  'overloaded',
  'rate.?limit',
  'too many requests',
  '429',
  '500',
  '502',
  '503',
  '504',
  '524',
  'service.?unavailable',
  'server.?error',
  'internal.?error',
  'provider.?returned.?error',
  'exceeded request buffer limit while retrying upstream',
  'network.?error',
  'connection.?error',
  'connection.?refused',
  'connection.?lost',
  'other side closed',
  'fetch failed',
  'getaddrinfo',
  'ENOTFOUND',
  'EAI_AGAIN',
  'upstream.?connect',
  'reset before headers',
  'socket hang up',
  'socket connection was closed',
  'timed? out',
  'timeout',
  'terminated',
  'websocket.?closed',
  'websocket.?error',
  'ended without',
  'stream ended before message_stop',
  'stream ended before a terminal response event',
  'http2 request did not get a response',
  'retry delay',
  'you can retry your request',
  'try your request again',
  'please retry your request',
  'ResourceExhausted',
])

/**
 * Classify whether an error message looks like a transient provider/transport
 * failure. Mirrors pi's `isRetryableAssistantError`. Empty messages are never
 * retryable; quota/billing exhaustion is never retryable; everything else
 * matching the transient pattern is retried.
 */
export function isRetryableAssistantError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false
  if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false
  return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage)
}

/**
 * Compose a display/classification string from an HTTP error. Keeps the
 * `API <status>: <body>` shape min-agent already used (so the retryable
 * patterns above still match `429`/`500`/...) and falls back to the raw
 * message for transport failures that carry no status.
 */
export function formatProviderError(status: number | undefined, body: string | undefined, message: string): string {
  if (status !== undefined && body !== undefined && body.length > 0) return `API ${status}: ${body}`
  if (status !== undefined) return `API ${status}: ${message}`
  return message
}

const DEFAULT_MAX_RETRY_DELAY_MS = 60_000

/** Whether an HTTP status (with headers) is worth retrying. */
export function isRetryableProviderStatus(status: number | undefined, headers: Headers | undefined): boolean {
  const shouldRetry = headers?.get('x-should-retry')
  if (shouldRetry === 'true') return true
  if (shouldRetry === 'false') return false
  if (status === undefined) return true // network/transport failure, no status
  return status === 408 || status === 409 || status === 429 || status >= 500
}

function validateServerRetryDelayMs(delayMs: number, maxRetryDelayMs: number | undefined): number {
  const maxDelayMs = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS
  if (maxDelayMs > 0 && delayMs > maxDelayMs) {
    throw new Error(`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s).`)
  }
  return delayMs
}

/**
 * Compute the backoff delay for a retry attempt. Honors a server-provided
 * `retry-after-ms` / `retry-after` header first, then falls back to an
 * exponential backoff (`baseDelayMs * 2^retryIndex`) with pi's jitter, capped
 * at `maxRetryDelayMs`.
 */
export function getRetryDelayMs(headers: Headers | undefined, retryIndex: number, baseDelayMs: number, maxRetryDelayMs: number | undefined): number {
  const retryAfterMs = headers?.get('retry-after-ms')
  if (retryAfterMs) {
    const value = Number.parseFloat(retryAfterMs)
    if (!Number.isNaN(value)) return validateServerRetryDelayMs(value, maxRetryDelayMs)
  }
  const retryAfter = headers?.get('retry-after')
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter)
    const delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000
    return validateServerRetryDelayMs(delayMs, maxRetryDelayMs)
  }
  const exponentialDelay = baseDelayMs * 2 ** retryIndex
  const delayMs = exponentialDelay * (1 - Math.random() * 0.25)
  if (maxRetryDelayMs && maxRetryDelayMs > 0 && delayMs > maxRetryDelayMs) return maxRetryDelayMs
  return delayMs
}

class RetrySleepAbortError extends Error {
  constructor() {
    super('Aborted')
  }
}

/** Abortable sleep used between retry attempts. */
export function retrySleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RetrySleepAbortError())
      return
    }
    const onAbort = (): void => {
      clearTimeout(timeout)
      reject(new RetrySleepAbortError())
    }
    const timeout = setTimeout(() => {
      // Sleep completed: drop the abort hook. Without this, a long-lived
      // AbortSignal accumulates one listener per retry over a long session
      // (rejections of an already-settled promise are harmless, but the
      // listeners themselves leak).
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Convert a min-agent Context into OpenAI messages format.
 * A pure transformation — no network logic.
 */
export function contextToOpenAIMessages(context: Context): object[] {
  const messages: object[] = []
  if (context.systemPrompt) messages.push({ role: 'system', content: context.systemPrompt })

  for (const msg of context.messages) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content })
      continue
    }

    const blocks = msg.content
    if (msg.role === 'assistant') {
      const toolCalls: object[] = []
      let text = ''
      for (const b of blocks) {
        if (b.type === 'text') text += b.text
        else if (b.type === 'tool_use') {
          toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } })
        }
      }
      // OpenAI requires an assistant message to have content (non-null) or tool_calls.
      // With pure tool_call, content is null; when both are empty (e.g. an empty turn after abort/error), use an empty string as a placeholder to avoid API 400.
      const content = text || (toolCalls.length ? null : '')
      messages.push({ role: 'assistant', content, tool_calls: toolCalls.length ? toolCalls : undefined })
    } else {
      // tool_result blocks inside a user message -> OpenAI requires a separate role:tool message
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content })
        } else if (b.type === 'text') {
          messages.push({ role: 'user', content: b.text })
        }
      }
    }
  }
  return messages
}

/** Type for an OpenAI SSE chunk */
type OpenAIChunk = {
  choices: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string
  }>
  /** Present on the final chunk when the request asks for usage (stream_options.include_usage). */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

/** Parse one line of SSE data, accumulate tool_calls, return text_delta and stop_reason */
function handleSSELine(
  data: string,
  toolCallBuffers: Map<number, { id: string; name: string; argsBuf: string }>,
): {
  textDelta: string | null
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | null
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null
} {
  let chunk: OpenAIChunk
  try { chunk = JSON.parse(data) as OpenAIChunk } catch { return { textDelta: null, stopReason: null, usage: null } }

  let textDelta: string | null = null
  let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | null = null
  let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null

  // The usage chunk carries no choices — parse it before the choice guard.
  if (chunk.usage?.total_tokens !== undefined) {
    usage = {
      promptTokens: chunk.usage.prompt_tokens ?? 0,
      completionTokens: chunk.usage.completion_tokens ?? 0,
      totalTokens: chunk.usage.total_tokens,
    }
  }

  const choice = chunk.choices[0]
  if (!choice) return { textDelta: null, stopReason: null, usage }

  if (choice.delta?.content) textDelta = choice.delta.content

  // tool_call deltas: accumulate name + arguments partial JSON by index
  if (choice.delta?.tool_calls) {
    for (const tc of choice.delta.tool_calls) {
      const idx = tc.index ?? 0
      if (!toolCallBuffers.has(idx)) {
        toolCallBuffers.set(idx, { id: tc.id ?? `call_${idx}`, name: '', argsBuf: '' })
      }
      const entry = toolCallBuffers.get(idx)!
      if (tc.id) entry.id = tc.id
      if (tc.function?.name) entry.name = tc.function.name
      if (tc.function?.arguments) entry.argsBuf += tc.function.arguments
    }
  }

  // finish_reason mapping: tool_calls -> tool_use, length -> max_tokens, stop -> end_turn (default)
  if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use'
  else if (choice.finish_reason === 'length') stopReason = 'max_tokens'

  return { textDelta, stopReason, usage }
}

/** At stream end: emit the accumulated tool_calls in order */
function flushToolCalls(
  toolCallBuffers: Map<number, { id: string; name: string; argsBuf: string }>,
): { id: string; name: string; args: unknown }[] {
  const calls: { id: string; name: string; args: unknown }[] = []
  for (const [, tc] of [...toolCallBuffers].sort((a, b) => a[0] - b[0])) {
    let args: unknown = {}
    if (tc.argsBuf) {
      try { args = JSON.parse(tc.argsBuf) } catch { args = {} }
    }
    calls.push({ id: tc.id, name: tc.name, args })
  }
  return calls
}

// ===== stream function =====

/**
 * Call the OpenAI Completions API (streaming) and return a unified event stream.
 *
 * @param model    model config
 * @param context  conversation context
 * @param opts     tools + abort signal
 */
export async function* stream(
  model: Model,
  context: Context,
  opts: { tools?: ToolDef[]; signal?: AbortSignal; retry?: RetryPolicy } = {},
): AsyncGenerator<StreamEvent> {
  const url = `${model.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`
  const messages = contextToOpenAIMessages(context)

  const body: Record<string, unknown> = { model: model.model, stream: true, messages, stream_options: { include_usage: true } }
  if (model.maxTokens) body.max_tokens = model.maxTokens
  if (opts.tools?.length) {
    body.tools = opts.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }))
  }

  const policy = opts.retry
  const maxRetries = policy?.enabled ? policy.maxRetries : 0

  // Retry loop around the HTTP request (copied from pi: provider-retry.ts).
  // Only the request itself is retried here, before any SSE bytes are yielded,
  // so a retry never duplicates streamed output. SSE parse errors below are
  // surfaced as `error` and left to the agent layer (which only retries a full
  // turn when no partial output was produced).
  let response!: Response
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${model.apiKey}` },
        body: JSON.stringify(body),
        signal: opts.signal,
      })
    } catch (e) {
      if (opts.signal?.aborted) { yield { type: 'done', stopReason: 'aborted' }; return }
      const message = (e as Error).message
      if (attempt >= maxRetries || !isRetryableAssistantError(message)) {
        yield { type: 'error', error: new Error(message) }; return
      }
      const delayMs = getRetryDelayMs(undefined, attempt, policy!.baseDelayMs, policy!.maxRetryDelayMs)
      yield { type: 'retry', attempt: attempt + 1, maxAttempts: maxRetries, delayMs, errorMessage: message }
      try { await retrySleep(delayMs, opts.signal) } catch { yield { type: 'done', stopReason: 'aborted' }; return }
      continue
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => 'unknown error')
      const errorMessage = formatProviderError(response.status, text, response.statusText)
      if (opts.signal?.aborted) { yield { type: 'done', stopReason: 'aborted' }; return }
      if (attempt >= maxRetries || !isRetryableProviderStatus(response.status, response.headers)) {
        yield { type: 'error', error: new Error(errorMessage) }; return
      }
      let delayMs: number
      try {
        delayMs = getRetryDelayMs(response.headers, attempt, policy!.baseDelayMs, policy!.maxRetryDelayMs)
      } catch (e) {
        // A server-requested delay above the cap (validateServerRetryDelayMs
        // throws) is a hard failure, not a retryable condition: surface it as
        // an error event. stream() must never throw — the agent loop consumes
        // failures via the event stream and has no try/catch around it.
        yield { type: 'error', error: e as Error }; return
      }
      yield { type: 'retry', attempt: attempt + 1, maxAttempts: maxRetries, delayMs, errorMessage }
      try { await retrySleep(delayMs, opts.signal) } catch { yield { type: 'done', stopReason: 'aborted' }; return }
      continue
    }

    // Success: ok response with a body — break out to SSE parsing.
    break
  }

  // Parse SSE line by line
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn'
  const toolCallBuffers = new Map<number, { id: string; name: string; argsBuf: string }>()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') continue

        const result = handleSSELine(data, toolCallBuffers)
        if (result.textDelta) yield { type: 'text_delta', delta: result.textDelta }
        if (result.usage) yield { type: 'usage', usage: result.usage }
        if (result.stopReason) stopReason = result.stopReason
      }
    }
  } catch (e) {
    if (opts.signal?.aborted) { yield { type: 'done', stopReason: 'aborted' }; return }
    yield { type: 'error', error: e as Error }; return
  }

  // Emit the accumulated tool_calls
  for (const tc of flushToolCalls(toolCallBuffers)) {
    yield { type: 'tool_call', id: tc.id, name: tc.name, args: tc.args }
  }
  yield { type: 'done', stopReason: opts.signal?.aborted ? 'aborted' : stopReason }
}

// ===== token accounting =====

/** Character-per-token ratio used by the streaming estimate before authoritative usage arrives. */
export const CHARS_PER_TOKEN_ESTIMATE = 4

/** Estimate the token count from a character count (streaming fallback). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE)
}

/**
 * Tracks the reported token count during streaming. The character-based
 * estimate grows monotonically; authoritative usage (final-chunk
 * `total_tokens`) only ever raises the reported value, so the count never
 * dips when the real number lands.
 */
export class TokenTracker {
  private chars = 0
  private authoritative = 0

  /** Account for newly streamed characters (drives the fallback estimate). */
  addChars(n: number): void {
    this.chars += n
  }

  /** Report authoritative usage from the final chunk. Never lowers the count. */
  setAuthoritative(totalTokens: number): void {
    this.authoritative = Math.max(this.authoritative, totalTokens)
  }

  /** Monotonic reported count: the higher of the estimate and authoritative usage. */
  get reported(): number {
    return Math.max(estimateTokens(this.chars), this.authoritative)
  }
}

// ===== message building helpers =====

/** Accumulate one round of stream events into an assistant message */
export function buildAssistantMessage(
  text: string,
  toolCalls: { id: string; name: string; args: unknown }[],
): Message {
  const content: ContentBlock[] = []
  if (text) content.push({ type: 'text', text })
  for (const tc of toolCalls) {
    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args })
  }
  return { role: 'assistant', content }
}

/** Build a tool_result user message */
export function buildToolResultMessage(
  results: { tool_use_id: string; content: string }[],
): Message {
  return {
    role: 'user',
    content: results.map(r => ({
      type: 'tool_result' as const,
      tool_use_id: r.tool_use_id,
      content: r.content,
    })),
  }
}
