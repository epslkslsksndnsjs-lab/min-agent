// src/agent.ts
// Agent main loop: stream the LLM reply -> execute tool_calls -> feed results back into Context,
// until the model stops calling tools (end_turn / max_tokens) or is interrupted (aborted / error).

import {
  stream,
  buildAssistantMessage,
  buildToolResultMessage,
  resolveRetryPolicy,
  isRetryableAssistantError,
  getRetryDelayMs,
  retrySleep,
  type Model,
  type Context,
  type RetryPolicy,
} from './llm.js'

/** Tool definition: name + description + JSON Schema params + execute function */
export type AgentTool = {
  name: string
  description: string
  input_schema: object  // JSON Schema
  execute: (args: unknown, signal?: AbortSignal) => Promise<string>
}

/** Event stream exposed by the agent, consumed by the UI */
export type AgentEvent =
  | { type: 'assistant_text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; result: string }
  | { type: 'usage'; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }
  | { type: 'user_interject'; text: string }
  | { type: 'turn_end'; stopReason: 'end_turn' | 'max_tokens' | 'aborted' | 'error' }
  | { type: 'retry'; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }

/**
 * Run the agent loop.
 *
 * @param model    model config
 * @param context  conversation context (mutated in place)
 * @param tools    tool registry
 * @param signal   abort signal
 */
export async function* runAgent(
  model: Model,
  context: Context,
  tools: AgentTool[],
  signal?: AbortSignal,
  retry: RetryPolicy = resolveRetryPolicy(),
): AsyncGenerator<AgentEvent> {
  const toolMap = new Map(tools.map(t => [t.name, t]))
  const toolDefs = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }))

  // Per-turn retry budget for restarting the assistant call on transient
  // errors. Mirrors pi's retryAssistantCall (the message-level retry).
  let attempt = 0
  // When the turn is restarted we disable the stream's own HTTP retries so the
  // two layers don't multiply the attempt count.
  const streamRetryForRetry = (): RetryPolicy => ({ enabled: false, maxRetries: 0, baseDelayMs: retry.baseDelayMs, maxRetryDelayMs: retry.maxRetryDelayMs })

  while (true) {

    // Stream the LLM call, collecting text and tool_calls
    let text = ''
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' = 'end_turn'
    const toolCalls: { id: string; name: string; args: unknown }[] = []

    const streamRetry = attempt === 0 ? retry : streamRetryForRetry()
    let shouldRetryTurn = false
    let retryDelayMs = 0
    for await (const ev of stream(model, context, { tools: toolDefs, signal, retry: streamRetry })) {
      if (ev.type === 'text_delta') {
        text += ev.delta
        yield { type: 'assistant_text', delta: ev.delta }
      } else if (ev.type === 'tool_call') {
        toolCalls.push({ id: ev.id, name: ev.name, args: ev.args })
        yield { type: 'tool_call', id: ev.id, name: ev.name, args: ev.args }
      } else if (ev.type === 'usage') {
        yield { type: 'usage', usage: ev.usage }
      } else if (ev.type === 'done') {
        stopReason = ev.stopReason
        if (ev.stopReason === 'aborted') {
          // On abort, drop tool_calls (missing tool_result would error the API)
          context.messages.push(buildAssistantMessage(text, []))
          yield { type: 'turn_end', stopReason: 'aborted' }
          return
        }
      } else if (ev.type === 'error') {
      // Restart the assistant turn on a transient error only when no partial
      // output was produced (the error came from an exhausted HTTP retry, not a
      // mid-stream break — re-streaming would duplicate output). Mirrors pi's
      // retryAssistantCall. Mid-stream errors are surfaced and end the turn.
      if (text.length === 0 && attempt < retry.maxRetries && isRetryableAssistantError(ev.error.message)) {
        const delayMs = getRetryDelayMs(undefined, attempt, retry.baseDelayMs, retry.maxRetryDelayMs)
        yield { type: 'retry', attempt: attempt + 1, maxAttempts: retry.maxRetries, delayMs, errorMessage: ev.error.message }
        try { await retrySleep(delayMs, signal) } catch {
          // aborted during backoff — end the turn as aborted
        }
        if (signal?.aborted) {
          yield { type: 'turn_end', stopReason: 'aborted' }
          return
        }
        attempt++
        shouldRetryTurn = true
        break
      }
      context.messages.push(buildAssistantMessage(text, []))
      yield { type: 'assistant_text', delta: `\n[error] ${ev.error.message}` }
      yield { type: 'turn_end', stopReason: 'error' }
      return
    }
    }

    // The assistant turn was restarted on a transient error above: re-enter the
    // while loop to re-stream the call with HTTP retries disabled so the two
    // retry layers don't multiply the attempt count. Mirrors pi's
    // retryAssistantCall re-invoking produce().
    if (shouldRetryTurn) {
      continue
    }

    // Push the assistant reply back into context
    context.messages.push(buildAssistantMessage(text, toolCalls))

    // On max_tokens the tool args may be incomplete — don't execute, return the error to context so the model retries
    if (stopReason === 'max_tokens' && toolCalls.length > 0) {
      const results = toolCalls.map(tc => ({
        tool_use_id: tc.id,
        content: `error: output truncated by max_tokens, tool "${tc.name}" args may be incomplete.`,
      }))
      context.messages.push(buildToolResultMessage(results))
      for (let i = 0; i < toolCalls.length; i++) {
        yield { type: 'tool_result', id: toolCalls[i].id, name: toolCalls[i].name, result: results[i].content }
      }
      continue
    }

    // No tool_call -> loop ends
    // A malformed API may return tool_use but no tool_call delta; treat that as a normal end
    const reason = stopReason === 'tool_use' ? 'end_turn' : stopReason
    if (toolCalls.length === 0) {
      yield { type: 'turn_end', stopReason: reason }
      return
    }

    // Execute tool_calls sequentially to avoid concurrent writes to Context
    // Args go straight to execute — parameter validation is the caller's responsibility
    const results: { tool_use_id: string; content: string }[] = []
    for (const tc of toolCalls) {
      const tool = toolMap.get(tc.name)
      let result: string
      if (!tool) {
        result = `error: tool "${tc.name}" not found`
      } else {
        try {
          result = await tool.execute(tc.args, signal)
        } catch (e) {
          result = `error: ${(e as Error).message}`
        }
      }
      results.push({ tool_use_id: tc.id, content: result })
      yield { type: 'tool_result', id: tc.id, name: tc.name, result }
      if (signal?.aborted) break
    }

    // Backfill error results for tool_calls skipped by abort (the API requires every tool_call to have a tool_result)
    for (const tc of toolCalls.slice(results.length)) {
      results.push({ tool_use_id: tc.id, content: 'error: aborted' })
      yield { type: 'tool_result', id: tc.id, name: tc.name, result: 'error: aborted' }
    }

    // Push tool_result back into Context, move to the next loop
    context.messages.push(buildToolResultMessage(results))
  }
}
