// src/agent.ts
// Agent main loop: stream the LLM reply -> execute tool_calls -> feed results back into Context,
// until the model stops calling tools (end_turn / max_tokens) or is interrupted (aborted / error).

import { stream, buildAssistantMessage, buildToolResultMessage, type Model, type Context } from './llm.js'

/** Tool definition: name + description + JSON Schema params + execute function */
export type AgentTool = {
  name: string
  description: string
  parameters: object  // JSON Schema
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

/** Compaction threshold: compact old messages once count exceeds this */
const COMPACT_THRESHOLD = 50
/** Number of recent messages to keep during compaction */
const KEEP_RECENT = 20

/**
 * Conversation compaction: when messages exceed the threshold, ask the LLM to
 * summarize the old ones and replace them with the summary, so the context
 * stays within the model's window.
 */
async function compactContext(model: Model, context: Context, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return  // Don't compact on abort — avoid corrupting context with an empty summary
  if (context.messages.length < COMPACT_THRESHOLD) return

  const oldMessages = context.messages.slice(0, -KEEP_RECENT)
  const recentMessages = context.messages.slice(-KEEP_RECENT)

  // Serialize old messages to plain text for the LLM to summarize
  const conversationText = oldMessages
    .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n')

  // Collect the summary from a single stream call
  const summaryContext: Context = {
    systemPrompt: 'Summarize the following conversation into a concise context summary, preserving key decisions, completed work, and pending items.',
    messages: [{ role: 'user', content: conversationText }],
  }

  let summary = ''
  let failed = false
  for await (const ev of stream(model, summaryContext, { signal })) {
    if (ev.type === 'text_delta') summary += ev.delta
    else if (ev.type === 'error' || ev.type === 'done' && ev.stopReason === 'aborted') { failed = true; break }
  }

  // On compaction failure, keep the original messages — safer than an empty summary
  if (failed || !summary) return

  // Replace old messages with the summary, keeping recent ones
  context.messages = [
    { role: 'user', content: `[context summary]\n${summary}` },
    ...recentMessages,
  ]
}

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
): AsyncGenerator<AgentEvent> {
  const toolMap = new Map(tools.map(t => [t.name, t]))
  const toolDefs = tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))

  while (true) {
    // Compact first so the LLM call below sees bounded history
    await compactContext(model, context, signal)

    // Stream the LLM call, collecting text and tool_calls
    let text = ''
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' = 'end_turn'
    const toolCalls: { id: string; name: string; args: unknown }[] = []

    for await (const ev of stream(model, context, { tools: toolDefs, signal })) {
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
          // On abort, drop tool_calls (missing tool_result would error the API after session restore)
          context.messages.push(buildAssistantMessage(text, []))
          yield { type: 'turn_end', stopReason: 'aborted' }
          return
        }
      } else if (ev.type === 'error') {
        context.messages.push(buildAssistantMessage(text, []))
        yield { type: 'assistant_text', delta: `\n[error] ${ev.error.message}` }
        yield { type: 'turn_end', stopReason: 'error' }
        return
      }
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
