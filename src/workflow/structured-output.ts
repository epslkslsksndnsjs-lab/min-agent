/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported for min-agent from QwenLM/qwen-code packages/core/src/tools/syntheticOutput.ts
// — see PROVENANCE.md. Upstream built this on its own tool base classes
// (`BaseDeclarativeTool`, `ToolResult`, a deferred-tool registry); min-agent's tool
// shape is `AgentTool` (`src/agent.ts:19-24`), whose `execute` returns the string the
// model reads. The load-bearing property is preserved exactly: the tool's parameter
// schema IS the script's schema, so the model has to conform to be able to call it at
// all.
//
// Two upstream concerns have no counterpart here and are deliberately absent: the
// telemetry/chat-recording redaction placeholder (min-agent keeps no long-lived
// transcript store) and the `alwaysLoad`/deferred-tool wiring (min-agent declares
// every tool it is given, on every turn).

import type { AgentTool } from '../agent.js';
import { STRUCTURED_OUTPUT_TOOL_NAME } from './agent-tools.js';
import type { WorkflowSchemaValidate } from './schema.js';

/**
 * Failed `structured_output` submissions that end the dispatch. Each failure
 * hands the validator's message back to the model, so a third failure means
 * three chances spent — after that the agent has proven it cannot satisfy this
 * schema and further turns only cost.
 */
export const MAX_FAILED_STRUCTURED_OUTPUT_SUBMISSIONS = 3;

const STRUCTURED_OUTPUT_DESCRIPTION = `Submit your final answer as one structured object that conforms to this tool's parameter schema.

This is the ONLY way to deliver a result in structured-output mode. The first call with valid arguments ends your run. Do NOT write the final answer as plain prose — anything you emit as text is discarded.

Read, search and run whatever tools you need first. Then call this tool once, passing the whole result as arguments that validate against the schema. If validation rejects them, the error tells you which fields; correct them and call again.

The arguments you pass ARE the return value. Do not summarize them.`;

/** What one `agent({schema})` call tracks across the subagent's turns. */
export interface StructuredOutputCapture {
  /** Set once a submission validated; this object is the `agent()` result. */
  value?: unknown;
  /** True when a valid submission was captured — the dispatch stops on this. */
  accepted: boolean;
  /** Rejected submissions so far. */
  failedSubmissions: number;
  /** The last validation message, for the failure text `agent()` records. */
  lastError?: string;
  /** True once the third rejection fired; the dispatch ends the agent as failed. */
  exhausted: boolean;
}

export interface StructuredOutputToolBundle {
  tool: AgentTool;
  readonly capture: StructuredOutputCapture;
}

/**
 * The per-call `structured_output` tool. `validate` is compiled for this one
 * call (see `prepareWorkflowSchema`), so a schema that fails to compile or
 * contradicts itself never reaches the model, and `$id` collisions between
 * sibling dispatches cannot silently borrow each other's validator.
 */
export function createStructuredOutputTool(
  schema: Record<string, unknown>,
  validate: WorkflowSchemaValidate,
): StructuredOutputToolBundle {
  const capture: StructuredOutputCapture = {
    accepted: false,
    failedSubmissions: 0,
    exhausted: false,
  };

  const tool: AgentTool = {
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    // The model-facing parameter schema is the script's schema, unmodified:
    // this is what makes the constraint real rather than a request in prose.
    input_schema: schema,
    execute: async (args: unknown): Promise<string> => {
      // A second valid submission cannot happen in practice — the dispatch ends
      // the run on the first — but the guard keeps the captured value immutable
      // if a caller drives the tool by hand.
      if (capture.accepted) {
        return 'Structured output already accepted. Your run is ending; do not send further content.';
      }

      const error = validate(args);
      if (error !== null) {
        capture.failedSubmissions++;
        capture.lastError = error;
        if (capture.failedSubmissions >= MAX_FAILED_STRUCTURED_OUTPUT_SUBMISSIONS) {
          capture.exhausted = true;
          return `Rejected: ${error} This was submission ${capture.failedSubmissions} of ${MAX_FAILED_STRUCTURED_OUTPUT_SUBMISSIONS} — the run ends now and no result will be returned.`;
        }
        return `Rejected: ${error} Correct the fields named above and call this tool again.`;
      }

      capture.value = args;
      capture.accepted = true;
      return 'Structured output accepted. Your run is ending now; do not send further content.';
    },
  };

  return { tool, capture };
}
