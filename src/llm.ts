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

/** Tool definition format passed in from the agent module */
export type ToolDef = {
  name: string
  description: string
  parameters: object
}

// ===== Helpers =====

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
  opts: { tools?: ToolDef[]; signal?: AbortSignal } = {},
): AsyncGenerator<StreamEvent> {
  const url = `${model.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`
  const messages = contextToOpenAIMessages(context)

  const body: Record<string, unknown> = { model: model.model, stream: true, messages, stream_options: { include_usage: true } }
  if (model.maxTokens) body.max_tokens = model.maxTokens
  if (opts.tools?.length) {
    body.tools = opts.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }

  // Send the request
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${model.apiKey}` },
      body: JSON.stringify(body),
      signal: opts.signal,
    })
  } catch (e) {
    if (opts.signal?.aborted) { yield { type: 'done', stopReason: 'aborted' }; return }
    yield { type: 'error', error: e as Error }; return
  }

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => 'unknown error')
    yield { type: 'error', error: new Error(`API ${response.status}: ${text}`) }; return
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
