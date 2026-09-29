# Vendored sources in `src/workflow/`

This directory contains code ported from **QwenLM/qwen-code** (Apache License 2.0),
so that the workflow orchestration engine keeps the same semantics as upstream.
Upstream copyright and `SPDX-License-Identifier` headers are preserved in every
ported file. This file records the mapping and the changes, as Apache-2.0 §4(b) requires.

Upstream root: https://github.com/QwenLM/qwen-code
Files read from: `packages/core/src/`

| Local file | Upstream path | Changes made |
|---|---|---|
| `env.ts` | `utils/env.ts` | none |
| `agent-failure.ts` | `agents/runtime/workflow-agent-failure.ts` | none |
| `dispatch-scheduler.ts` | `agents/runtime/workflow-dispatch-scheduler.ts` | jobs carry a caller-chosen `id` and an admission `ordinal`; the scheduler now emits `queued`/`started`/`settled` dispatch events, which the stall watchdog needs to distinguish "queued, never started" from "started, no progress" |
| `meta-literal.ts` | `agents/runtime/workflow-meta-literal.ts` | none |
| `script-shape.ts` | `agents/runtime/workflow-script-shape.ts` | none |
| `size.ts` | `agents/runtime/workflow-size.ts` | import path rebased to `./env.js` |
| `correlation.ts` | `agents/workflow-correlation.ts` | none |
| `agent-tools.ts` | `agents/runtime/workflow-agent-tools.ts` | the MCP-pattern, `exec` and `agentType` branches are gone (min-agent has none of those surfaces); entry validation and availability narrowing are split, so `describeAgentToolAllowEntryProblem` judges spelling only |
| `events.ts` | `agents/runtime/agent-events.ts` | payload shapes rebased onto min-agent types (tool output is a `string`, no `@google/genai` parts); `AgentEventEmitter` reimplemented dependency-free; every payload carries `runId` + `dispatchId`; added `WORKFLOW_PROGRESS_EVENTS` for the stall watchdog |
| `sandbox.ts` | `agents/runtime/workflow-sandbox.ts` | imports rebased; `agent({effort})` and `agent({agentType})` removed, along with `isolation:'remote'`; host-side tool-name canonicalization removed, since min-agent has exactly one spelling per tool; env names `QWEN_CODE_*` → `MIN_AGENT_*`; message examples use min-agent's tool names |
| `schema.ts` | `agents/runtime/workflow-schema.ts` | imports rebased |
| `schema-validator.ts` | `utils/schemaValidator.ts` | debug logger import rebased; `ajv` + `ajv-formats` added as dependencies (upstream already depended on both) |
| `structured-output.ts` | `tools/syntheticOutput.ts` | rewritten against min-agent's `AgentTool` instead of `BaseDeclarativeTool`; the tool description is min-agent's own wording; the telemetry redaction placeholder and the deferred-tool/`alwaysLoad` wiring have no counterpart here and are omitted |
| `support.ts` | `utils/textUtils.ts` + `utils/debugLogger.ts` | reimplemented: debug logging appends to a file rather than stderr, because the TUI owns the screen and a stray write corrupts the diffed frame |
| `events.ts` | `agents/runtime/agent-events.ts` | payload shapes rebased onto min-agent types (tool output is a `string`, no `@google/genai` parts); `AgentEventEmitter` reimplemented as a dependency-free `WorkflowEventEmitter`; every payload carries `runId` + `dispatchId`; added `WORKFLOW_PROGRESS_EVENTS` for the stall watchdog |

## Not ported, and why

- `mcp__<server>__*` tool-name patterns from `permissions/rule-parser.ts` — min-agent
  has no MCP servers, so those branches would be dead code.
- `agent({ effort })` — min-agent's `Model` carries no reasoning-effort or temperature
  field (`llm.ts:8-13`), so there is nothing honest to map the option onto.
- `agent({ agentType })` — min-agent has no declarative-agent registry
  (`.qwen/agents/<name>.md` equivalent).

## Provenance note on prompt text

`workflow-prompts.ts` in upstream states at `:10-11` that its subagent system prompt was
taken verbatim from a third-party closed-source binary. That text is **not** reused here;
`src/workflow/prompts.ts` carries min-agent's own wording of the same behavioral
constraints.
