// src/run-agent-fake.ts
// Deterministic stress-test stand-in for the real agent loop. It emits the same
// AgentEvent stream a model + agent would, without touching any network or tool,
// so the TUI can be exercised under extreme load (a long think delay, many tool
// calls, and a long streamed reply). Gated by MIN_AGENT_FAKE=1 or model "abc".
//
// Lifecycle (configurable via env, defaults tuned for a ~30 minute run):
//  - each turn: think 10s, then a batch of tool calls, then streamed text
//  - tools accumulate across turns up to TOOL_TARGET (default 500)
//  - streamed chars accumulate across turns up to CHAR_TARGET (default 30000)
//  - every INTERJECT_EVERY chars of streamed output, a user_interject event is
//    emitted (simulating the user typing a message mid-stream); the next turn
//    begins after the current stream finishes, so the transcript shows the
//    interjection as a "You:" block between two assistant turns.

import type { AgentEvent } from './agent.js'

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'))
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('aborted', 'AbortError'))
      },
      { once: true },
    )
  })

const THINK_MS = Number(process.env.FAKE_THINK_MS ?? 10000)
const TOOL_TARGET = Number(process.env.FAKE_TOOL_TARGET ?? 500)
const CHAR_TARGET = Number(process.env.FAKE_CHAR_TARGET ?? 30000)
const INTERJECT_EVERY = Number(process.env.FAKE_INTERJECT_EVERY ?? 200)
const LIFECYCLE_MS = Number(process.env.FAKE_LIFECYCLE_MS ?? 30 * 60 * 1000)
// Realistic pacing: a tool call + its result lands about every TOOL_GAP_MS
// (a model does not fire hundreds per second), and streamed text is emitted
// one character at a time with CHAR_GAP_MS between characters.
const TOOL_GAP_MS = Number(process.env.FAKE_TOOL_GAP_MS ?? 1500)
const CHAR_GAP_MS = Number(process.env.FAKE_CHAR_GAP_MS ?? 15)

/**
 * Emits a multi-turn fake agent run whose aggregate load matches the spec:
 * ~10s think per turn, TOOL_TARGET tool calls total, CHAR_TARGET streamed
 * characters total, a user interjection every INTERJECT_EVERY characters, and
 * a hard LIFECYCLE_MS cap so the run terminates even under manual inspection.
 * Pacing is realistic (tools ~1.5s apart, streamed chars ~15ms apart) so the
 * TUI is exercised at human-observable speed across the full 30 minute window.
 */
export async function* runAgentFake(signal: AbortSignal): AsyncGenerator<AgentEvent> {
  const startedAt = Date.now()
  let toolCount = 0
  let charCount = 0
  let turn = 0

  while (true) {
    if (signal.aborted) return
    // Keep emitting until the lifecycle elapses; load targets are aggregate
    // floors, not early-exit conditions — the run must fill the whole window.
    const expired = Date.now() - startedAt >= LIFECYCLE_MS
    if (expired) break

    turn += 1

    // 1) Think for THINK_MS before producing anything.
    await sleep(THINK_MS, signal)
    if (signal.aborted) return

    // 2) A batch of tool calls (call + result), no real execution.
    //    Paced ~TOOL_GAP_MS apart so the TUI shows them arrive one at a time.
    const toolsThisTurn = Math.min(50, TOOL_TARGET - toolCount)
    for (let i = 0; i < toolsThisTurn; i++) {
      if (signal.aborted) return
      if (Date.now() - startedAt >= LIFECYCLE_MS) break
      yield { type: 'tool_call', id: `fake-${toolCount}`, name: 'fake_tool', args: { i: toolCount } }
      await sleep(TOOL_GAP_MS * 0.8, signal)
      // Every 7th call fails to exercise the error (red X) state.
      const failed = toolCount % 7 === 6
      yield {
        type: 'tool_result',
        id: `fake-${toolCount}`,
        name: 'fake_tool',
        result: failed ? `error: boom at ${toolCount}` : `ok ${toolCount}`,
      }
      toolCount += 1
      await sleep(TOOL_GAP_MS * 0.2, signal)
      await sleep(2, signal)
    }

    // 3) Stream characters one at a time to mimic token-by-token output.
    let sinceInterject = 0
    while (charCount < CHAR_TARGET && Date.now() - startedAt < LIFECYCLE_MS) {
      if (signal.aborted) return
      yield { type: 'assistant_text', delta: 'x' }
      charCount += 1
      sinceInterject += 1
      // Interject once we've streamed INTERJECT_EVERY chars since the last one.
      if (sinceInterject >= INTERJECT_EVERY && charCount < CHAR_TARGET) {
        sinceInterject = 0
        yield { type: 'user_interject', text: `user interjection @${charCount} chars` }
      }
      await sleep(CHAR_GAP_MS, signal)
    }

    yield { type: 'turn_end', stopReason: 'end_turn' }
  }
}

export const FAKE_LIMITS = { THINK_MS, TOOL_TARGET, CHAR_TARGET, INTERJECT_EVERY, LIFECYCLE_MS }
