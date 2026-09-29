/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Adapted for min-agent from QwenLM/qwen-code
// packages/core/src/agents/runtime/workflow-agent-tools.ts — see PROVENANCE.md.
// Three upstream branches are absent here because min-agent has no equivalent of
// what they guard: MCP tool patterns (`mcp__server__tool`), the code-mode `exec`
// surface, and `agentType` allowlists. Dropping them keeps every remaining check
// reachable; keeping them would have added branches that can never fire.

/** Most names a refusal lists before it says how many more there were. */
const MAX_LISTED_TOOL_NAMES = 10;

/** The synthetic tool a schema-mode agent answers through. */
export const STRUCTURED_OUTPUT_TOOL_NAME = 'structured_output';

/**
 * Why an `agent({ tools })` entry cannot name a tool to allow, or `null` when it
 * can. The entry is echoed as written, so a caller that shows the reason must
 * strip control characters from it.
 */
export function describeAgentToolAllowEntryProblem(
  name: string,
): string | null {
  if (typeof name !== 'string') {
    return `${JSON.stringify(name)} is not a tool name; the allowlist takes strings.`;
  }
  if (name !== name.trim() || name.length === 0) {
    return `${JSON.stringify(name)} is not a usable tool name; the allowlist takes exact, trimmed tool names.`;
  }
  if (name.includes('*')) {
    return `${JSON.stringify(name)} is a pattern, and the allowlist takes exact tool names; omit tools to keep every tool this agent may already use.`;
  }
  // An entry that names no tool in this session would be accepted and silently
  // dropped, so it is refused — the same reason upstream refuses them. The
  // availability check itself lives in narrowAgentTools, which is where the
  // session's tool list is known.
  return null;
}

/** Why a `disallowedTools` entry is unusable, or `null` when it is not. */
export function describeAgentToolDenyEntryProblem(name: unknown): string | null {
  if (typeof name !== 'string') {
    return `${JSON.stringify(name)} is not a tool name; denies take strings.`;
  }
  if (name !== name.trim() || name.length === 0) {
    return `${JSON.stringify(name)} is not a usable tool name; trim it.`;
  }
  return null;
}

/** `"a", "b", "c"`, capped, for a refusal message. */
export function listToolNames(names: readonly string[]): string {
  const shown = names
    .slice(0, MAX_LISTED_TOOL_NAMES)
    .map((name) => JSON.stringify(name))
    .join(', ');
  const more = names.length - MAX_LISTED_TOOL_NAMES;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

export interface AgentToolNarrowingInput {
  /** The script's `tools` entries, exactly as the sandbox handed them over. */
  readonly requested: readonly string[];
  /** Every tool the subagent could be given before this call narrows it. */
  readonly available: readonly string[];
  /** Every deny that applies: the workflow floor plus this call's. */
  readonly denies: readonly string[];
  /** Whether the agent answers through `structured_output`. */
  readonly schema: boolean;
}

/**
 * The tools a dispatch narrowed by `agent({ tools })` may be declared: the
 * requested names, bounded by what is available, minus every deny, plus
 * `structured_output` for a schema agent. Throws, naming the entries as written,
 * when the bound or the denies leave nothing — such an agent could only spend its
 * dispatch without being able to act.
 *
 * An allowlist only ever narrows: it cannot bring back a tool the workflow floor
 * or a deny took away, because denies are applied after it.
 */
export function narrowAgentTools(input: AgentToolNarrowingInput): string[] {
  if (input.requested.length === 0) {
    throw new Error('agent({tools}): the allowlist is empty; omit tools to keep every tool this agent may already use.');
  }
  const requested = [...new Set(input.requested)];

  const bounded = requested.filter((name) => input.available.includes(name));
  if (bounded.length === 0) {
    throw new Error(
      `agent({tools}): none of ${listToolNames(requested)} is a tool this subagent has (${listToolNames(input.available)}).`,
    );
  }

  const allowed = bounded.filter((name) => !input.denies.includes(name));
  if (allowed.length === 0) {
    throw new Error(
      `agent({tools}): every tool in ${listToolNames(bounded)} is denied for this agent, by disallowedTools or by the tools no workflow subagent may use.`,
    );
  }

  if (input.schema && !allowed.includes(STRUCTURED_OUTPUT_TOOL_NAME)) {
    allowed.push(STRUCTURED_OUTPUT_TOOL_NAME);
  }
  return allowed;
}

/**
 * The tools no workflow subagent may use, whatever the script or the session
 * says. min-agent's equivalents of upstream's control-plane floor: a subagent
 * cannot fan out further (no nested `workflow`), cannot ask the human anything,
 * and cannot touch the parent's own run.
 */
export const WORKFLOW_SUBAGENT_DISALLOWED_TOOLS: readonly string[] = [
  'workflow',
];
