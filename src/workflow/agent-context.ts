// Which agent is currently executing, and how deeply nested it is.
//
// min-agent's tool functions are plain `execute(args, signal)` calls, so
// nothing in the loop knows "who" is running. That matters for two things this
// port needs: a workflow subagent's tool calls must be attributable (the live
// view groups them by `subagentId`), and a nested run must be able to tell it
// is nested. Both are AsyncLocalStorage reads, not parameters every call site
// would have to thread.
//
// Adapted from QwenLM/qwen-code packages/core/src/agents/runtime/agent-context.ts
// (Apache-2.0, see PROVENANCE.md). Upstream's module also carries the per-agent
// content-generator view, the LlmChat frame and the tool allowlist frames; those
// are dropped because min-agent has no per-agent Config to shadow — a subagent's
// tools are the array it is handed, so allowlisting is decided at construction
// time (see ./agent-tools.ts) rather than read from a frame here.

export interface AgentFrame {
  agentId: string;
  /** 0 for a child of the top-level session, 1 for its child, and so on. */
  depth: number;
  /** The agent that spawned this one, or null when the session spawned it. */
  parentAgentId: string | null;
  /** Workflow run this frame belongs to, when it was dispatched by a script. */
  runId?: string;
  /** The `agent()` dispatch id, so a tool call can be filed under its step. */
  dispatchId?: string;
}

interface AsyncLocalStorageLike<T> {
  run<R>(store: T, callback: () => R): R;
  exit<R>(callback: () => R): R;
  getStore(): T | undefined;
}

// Resolved through require rather than a top-level import so this module stays
// loadable where `node:async_hooks` types are not present in a test's graph.
import { AsyncLocalStorage } from 'node:async_hooks';

const storage: AsyncLocalStorageLike<AgentFrame | null> =
  new AsyncLocalStorage<AgentFrame | null>();

/** Run `fn` as the given agent, so any tool it triggers is attributable. */
export function runWithAgentContext<T>(
  agentId: string,
  fn: () => T,
  options: {
    depth?: number;
    parentAgentId?: string | null;
    runId?: string;
    dispatchId?: string;
  } = {},
): T {
  const parent = storage.getStore() ?? null;
  const frame: AgentFrame = {
    agentId,
    depth: options.depth ?? (parent === null ? 0 : parent.depth + 1),
    parentAgentId: options.parentAgentId ?? parent?.agentId ?? null,
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
    ...(options.dispatchId !== undefined ? { dispatchId: options.dispatchId } : {}),
  };
  return storage.run(frame, fn);
}

/** The id of the agent currently executing, or null in the top-level session. */
export function getCurrentAgentId(): string | null {
  return storage.getStore()?.agentId ?? null;
}

/** Depth of the current frame; -1 when there is none, so a child is 0. */
export function getCurrentAgentDepth(): number {
  const frame = storage.getStore();
  return frame ? frame.depth - 1 : -1;
}

/** The full frame, for a registry or a transcript writer that needs the chain. */
export function getCurrentAgentFrame(): AgentFrame | null {
  return storage.getStore() ?? null;
}

/**
 * Run `fn` with no agent frame. Notification and telemetry paths need this:
 * a completion event delivered while a subagent is executing must not be
 * attributed to that subagent.
 */
export function runOutsideAgentContext<T>(fn: () => T): T {
  return storage.exit(() => storage.run(null, fn));
}

/** True when no agent frame is active — the top-level user session. */
export function isTopLevelSession(): boolean {
  return getCurrentAgentId() === null;
}

/**
 * The 0-based depth a child spawned by the current invoker would take: 0 from
 * the top-level session, parent depth + 1 inside a frame. Single source of the
 * launch-depth formula, so a schema-time gate and a runtime guard cannot drift.
 */
export function childLaunchDepth(): number {
  return getCurrentAgentId() !== null ? getCurrentAgentDepth() + 1 : 0;
}

/**
 * Whether the current invoker may start a nested agent, given a maximum nesting
 * level (1-based: a top-level child is level 1).
 */
export function canSpawnNestedAgent(maxDepth: number): boolean {
  return childLaunchDepth() + 1 <= maxDepth;
}
