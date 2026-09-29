/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Adapted for min-agent from QwenLM/qwen-code
// packages/core/src/agents/runtime/agent-events.ts — see src/workflow/PROVENANCE.md.
// The event vocabulary and the `subagentId`/`runId`/`round`/`callId` correlation
// fields are kept, because the live view groups a scattered stream of tool calls
// by exactly those four. Payload shapes follow min-agent's own types instead of
// `@google/genai` parts: min-agent's tool output is a plain string
// (`agent.ts:19-24`), so `outputChunk`/`result` are strings here.

/** The event names, kept as a const object so the map below stays exhaustive. */
export const WorkflowAgentEventType = {
  START: 'start',
  ROUND_START: 'round_start',
  ROUND_END: 'round_end',
  STREAM_TEXT: 'stream_text',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  TOOL_OUTPUT_UPDATE: 'tool_output_update',
  TOOL_WAITING_APPROVAL: 'tool_waiting_approval',
  USAGE_METADATA: 'usage_metadata',
  EXTERNAL_MESSAGE: 'external_message',
  RETRY: 'retry',
  FINISH: 'finish',
  ERROR: 'error',
  STATUS_CHANGE: 'status_change',
} as const;

export type WorkflowAgentEventName =
  (typeof WorkflowAgentEventType)[keyof typeof WorkflowAgentEventType];

export type WorkflowRunStatus =
  | 'running'
  | 'pausing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** The four fields every payload carries — what the UI groups and nests by. */
export interface WorkflowEventBase {
  /** The subagent that produced this event. */
  subagentId: string;
  /** The workflow run this dispatch belongs to. */
  runId: string;
  /** This `agent()` dispatch's id, chosen by the caller of the scheduler. */
  dispatchId: string;
  /** 1-based model round within the subagent. */
  round: number;
  timestamp: number;
}

export interface WorkflowStartEvent extends WorkflowEventBase {
  /** Short display name from `agent({ label })`, when the script set one. */
  label?: string;
  model?: string;
  tools: string[];
}

export interface WorkflowRoundEvent extends WorkflowEventBase {}

export interface WorkflowStreamTextEvent extends WorkflowEventBase {
  delta: string;
}

export interface WorkflowToolCallEvent extends WorkflowEventBase {
  callId: string;
  name: string;
  args: unknown;
}

export interface WorkflowToolResultEvent extends WorkflowEventBase {
  callId: string;
  name: string;
  success: boolean;
  /** The tool's string result, or the error text when `success` is false. */
  result: string;
  durationMs?: number;
}

/**
 * Incremental progress for a tool call that is still running. min-agent's
 * `AgentTool.execute` returns a single `Promise<string>` and cannot report
 * partial output, so this event is emitted by whoever *can* observe progress —
 * the approval gate, a background shell, or the subagent's own round boundary.
 * The stall watchdog reads it as "progress", which is why it exists as its own
 * type rather than being folded into TOOL_RESULT.
 */
export interface WorkflowToolOutputUpdateEvent extends WorkflowEventBase {
  callId: string;
  outputChunk: string;
}

/**
 * A tool call inside a workflow subagent needs the user's decision. It surfaces
 * here rather than inside the subagent, because the subagent has no way to ask:
 * `respond` is the only channel back, and the parent owns the terminal.
 */
export interface WorkflowApprovalEvent extends WorkflowEventBase {
  callId: string;
  name: string;
  args: unknown;
  /** What the user is being asked to accept, in one line. */
  description: string;
  respond: (outcome: WorkflowApprovalOutcome) => void;
}

export type WorkflowApprovalOutcome = 'allow' | 'deny' | 'always';

export interface WorkflowUsageEvent extends WorkflowEventBase {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface WorkflowExternalMessageEvent extends WorkflowEventBase {
  text: string;
}

export interface WorkflowRetryEvent extends WorkflowEventBase {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
}

export interface WorkflowFinishEvent extends WorkflowEventBase {
  /** min-agent's turn_end reason, or an engine-level reason. */
  stopReason: 'end_turn' | 'max_tokens' | 'aborted' | 'error' | string;
  rounds?: number;
  totalToolCalls?: number;
  outputTokens?: number;
}

export interface WorkflowErrorEvent extends WorkflowEventBase {
  error: string;
}

export interface WorkflowStatusChangeEvent extends WorkflowEventBase {
  previousStatus: WorkflowRunStatus;
  newStatus: WorkflowRunStatus;
}

export interface WorkflowEventMap {
  start: WorkflowStartEvent;
  round_start: WorkflowRoundEvent;
  round_end: WorkflowRoundEvent;
  stream_text: WorkflowStreamTextEvent;
  tool_call: WorkflowToolCallEvent;
  tool_result: WorkflowToolResultEvent;
  tool_output_update: WorkflowToolOutputUpdateEvent;
  tool_waiting_approval: WorkflowApprovalEvent;
  usage_metadata: WorkflowUsageEvent;
  external_message: WorkflowExternalMessageEvent;
  retry: WorkflowRetryEvent;
  finish: WorkflowFinishEvent;
  error: WorkflowErrorEvent;
  status_change: WorkflowStatusChangeEvent;
}

export type WorkflowEventListener<E extends keyof WorkflowEventMap> = (
  payload: WorkflowEventMap[E],
) => void;

/**
 * A typed publish/subscribe bus, one per workflow run.
 *
 * The agent loop in min-agent is an async generator with exactly one consumer,
 * and a workflow needs many observers of the same stream (live view, stall
 * watchdog, token ledger, journal writer). This bus is the fan-out point: the
 * dispatch is the generator's only consumer and re-arms every event onto here.
 */
export class WorkflowEventEmitter {
  private readonly listeners = new Map<
    keyof WorkflowEventMap,
    Set<(...args: never[]) => void>
  >();

  on<E extends keyof WorkflowEventMap>(
    event: E,
    listener: WorkflowEventListener<E>,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (...args: never[]) => void);
    return () => this.off(event, listener);
  }

  off<E extends keyof WorkflowEventMap>(
    event: E,
    listener: WorkflowEventListener<E>,
  ): void {
    this.listeners.get(event)?.delete(listener as (...args: never[]) => void);
  }

  emit<E extends keyof WorkflowEventMap>(event: E, payload: WorkflowEventMap[E]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copy first: a listener may unsubscribe while we are iterating it.
    for (const listener of [...set]) {
      (listener as (p: WorkflowEventMap[E]) => void)(payload);
    }
  }

  listenerCount(event: keyof WorkflowEventMap): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}

/** Progress signals the stall watchdog counts as "the subagent is alive". */
export const WORKFLOW_PROGRESS_EVENTS = [
  'stream_text',
  'tool_call',
  'tool_result',
  'tool_output_update',
  'usage_metadata',
  'round_end',
] as const satisfies readonly (keyof WorkflowEventMap)[];
