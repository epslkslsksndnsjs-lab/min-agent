/**
 * min-agent's implementation of the engine's `WorkflowAgentDispatch` seam.
 *
 * The engine never builds an agent. It calls one function —
 * `(prompt, opts, dispatchId) => Promise<string | object>` — and everything here
 * is what makes that true in this project:
 *
 *   - a subagent gets its OWN `Context`. The parent's messages are never
 *     touched, which is why a fan-out cannot corrupt the running conversation
 *     (`src/agent.ts:146` runs tool calls sequentially for exactly that reason);
 *   - its tools are the session's tools minus the workflow floor and any deny,
 *     bounded by `agent({tools})`, plus `structured_output` in schema mode;
 *   - every event it produces is republished onto the run's bus, because the
 *     generator has one consumer (this function) while the live view, the
 *     transcript, the token ledger and the stall watchdog all need to see it;
 *   - output tokens are reported as each dispatch settles — that one mutation
 *     is the entire budget ledger;
 *   - an agent that fails on its own throws `WorkflowAgentFailedError` with a
 *     kind, which the engine turns into `null` for the script. Anything that no
 *     later call could survive is left to throw untouched.
 */

import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { runAgent, type AgentEvent, type AgentTool } from '../agent.js';
import type { Context, Model } from '../llm.js';

import {
  STRUCTURED_OUTPUT_TOOL_NAME,
  WORKFLOW_SUBAGENT_DISALLOWED_TOOLS,
  narrowAgentTools,
} from './agent-tools.js';
import { WorkflowAgentFailedError } from './agent-failure.js';
import {
  WorkflowAgentEventType,
  type WorkflowEventEmitter,
  type WorkflowEventMap,
  type WorkflowEventPayload,
} from './events.js';
import { runStallResilient, resolveStallMs } from './stall.js';
import { prepareWorkflowSchema, type WorkflowSchemaValidate } from './schema.js';
import {
  createStructuredOutputTool,
  MAX_FAILED_STRUCTURED_OUTPUT_SUBMISSIONS,
  type StructuredOutputCapture,
} from './structured-output.js';
import { createDebugLogger, stripAnsiAndControl } from './support.js';
import { writeLine } from './jsonl.js';
import {
  WORKFLOW_SUBAGENT_SYSTEM_PROMPT,
  WORKFLOW_SUBAGENT_SYSTEM_PROMPT_WITH_SCHEMA,
  WORKFLOW_WORKTREE_NOTICE,
} from './prompts.js';
import type { WorkflowAgentDispatch, WorkflowSubagentBounds } from './orchestrator.js';
import type { WorkflowAgentOpts, WorkflowAgentResult } from './sandbox.js';
import type { WorkflowPaths } from './paths.js';
import {
  createWorktree,
  isDirty,
  isLinkedWorktree,
  newWorktreeSlug,
  removeWorktree,
  resolveRegisteredWorktree,
  worktreeHasChanges,
  type GitWorktreeInfo,
} from './worktree.js';

const debugLogger = createDebugLogger('WORKFLOW_DISPATCH');

/** What the human answered when a subagent wanted to run a tool. */
export type WorkflowApprovalOutcome = 'allow' | 'deny' | 'always';

export interface MinAgentDispatchOptions {
  runId: string;
  /** The session's model. `agent({ model })` overrides only its `model` field. */
  model: Model;
  /** The session's tools: the set a subagent is narrowed down from. */
  tools: AgentTool[];
  cwd: string;
  paths: WorkflowPaths;
  bounds: WorkflowSubagentBounds;
  /** Cancellation and the run's wall-clock cap. */
  signal?: AbortSignal;
  /** The run's event bus. Absent when nothing is watching. */
  emitter?: WorkflowEventEmitter;
  /** Output tokens of each settled dispatch, fed to the budget ledger. */
  onTokens?: (outputTokens: number) => void;
  /**
   * Ask the human before a subagent runs a tool. This is the only approval
   * channel: a pub/sub event would leave two ways to answer the same question,
   * and a tool that nobody answers is a hung run. Absent means this session has
   * no gate, which is min-agent's behavior today.
   */
  requestApproval?: (info: {
    subagentId: string;
    runId: string;
    label?: string;
    toolName: string;
    args: unknown;
  }) => Promise<WorkflowApprovalOutcome>;
  /** Env source for the stall default; injectable for tests. */
  env?: Record<string, string | undefined>;
}

function newSubagentId(): string {
  return `workflow-agent-${randomBytes(4).toString('hex')}`;
}

/**
 * The answer a no-schema agent gives: the last assistant message that actually
 * contains prose. A final turn holding only tool_use blocks is not an answer,
 * so keep walking back.
 */
function finalAssistantText(context: Context): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i];
    if (message.role !== 'assistant') continue;
    if (typeof message.content === 'string') return message.content;
    for (const block of message.content) {
      if (block.type === 'text' && block.text.length > 0) return block.text;
    }
  }
  return '';
}

/** Why a schema-mode agent ended without a valid submission. */
function describeMissingStructuredOutput(capture: StructuredOutputCapture | undefined): string {
  if (!capture) {
    return `agent({schema}): the subagent ended without calling ${STRUCTURED_OUTPUT_TOOL_NAME}.`;
  }
  if (capture.failedSubmissions >= MAX_FAILED_STRUCTURED_OUTPUT_SUBMISSIONS) {
    return (
      `agent({schema}): ${capture.failedSubmissions} submissions were rejected and the run ended. ` +
      `Last validation error: ${stripAnsiAndControl(capture.lastError ?? 'unknown')}`
    );
  }
  return (
    `agent({schema}): the subagent ended without a valid ${STRUCTURED_OUTPUT_TOOL_NAME} call` +
    (capture.lastError ? `; last error: ${stripAnsiAndControl(capture.lastError)}` : '.')
  );
}

/**
 * `agent({stallMs})`: `0` disables the watchdog, absent takes the env default,
 * and a non-number is refused by the sandbox before it gets here.
 */

export function createMinAgentDispatch(
  options: MinAgentDispatchOptions,
): WorkflowAgentDispatch {
  const {
    runId,
    model,
    tools,
    cwd,
    paths,
    bounds,
    signal,
    emitter,
    onTokens,
    requestApproval,
  } = options;
  const stallEnv = options.env;

  return async function dispatch(
    prompt: string,
    agentOpts: WorkflowAgentOpts,
    dispatchId?: string,
  ): Promise<WorkflowAgentResult> {
    const label = typeof agentOpts.label === 'string' && agentOpts.label.length > 0
      ? agentOpts.label
      : undefined;
    const subagentId = newSubagentId();
    // Every counter lives out here so the bus payloads and the watchdog both
    // read the same truth as the ledger does.
    let rounds = 0;
    let toolCalls = 0;
    let outputTokens = 0;

    const traceId = dispatchId ?? subagentId;
    /** Publish to the run's bus and, while an attempt is live, its own bus. */
    let attemptEmitter: WorkflowEventEmitter | undefined;
    function emit<E extends keyof WorkflowEventMap>(
      type: E,
      payload: WorkflowEventPayload<E>,
    ): void {
      const base = {
        subagentId,
        runId,
        dispatchId: traceId,
        round: rounds,
        timestamp: Date.now(),
      };
      const full = { ...base, ...payload } as WorkflowEventMap[E];
      emitter?.emit(type, full);
      attemptEmitter?.emit(type, full);
    }

    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new WorkflowAgentFailedError(
        'agent(): the prompt must be a non-empty string.',
        'error',
      );
    }

    // ---- schema mode -------------------------------------------------------
    let validate: WorkflowSchemaValidate | undefined;
    if (agentOpts.schema !== undefined) {
      const prepared = prepareWorkflowSchema(agentOpts.schema);
      if (!prepared.ok) {
        // Refused before the agent starts. An unsatisfiable schema would spend a
        // whole dispatch to produce nothing, and would read as a model failure
        // rather than as the configuration error it is.
        throw new WorkflowAgentFailedError(
          `agent({schema}): ${stripAnsiAndControl(prepared.error)}`,
          'no_structured_output',
        );
      }
      validate = prepared.validate;
    }

    // ---- tools -------------------------------------------------------------
    const denies = [
      ...WORKFLOW_SUBAGENT_DISALLOWED_TOOLS,
      ...(Array.isArray(agentOpts.disallowedTools) ? agentOpts.disallowedTools : []),
    ];
    let allowedNames = tools
      .map((tool) => tool.name)
      .filter((name) => !denies.includes(name));
    if (validate) allowedNames = [...allowedNames, STRUCTURED_OUTPUT_TOOL_NAME];
    if (Array.isArray(agentOpts.tools)) {
      allowedNames = narrowAgentTools({
        requested: agentOpts.tools,
        available: allowedNames,
        denies,
        schema: validate !== undefined,
      });
    }

    let capture: StructuredOutputCapture | undefined;
    const subTools: AgentTool[] = [];
    for (const name of allowedNames) {
      if (name === STRUCTURED_OUTPUT_TOOL_NAME && validate) {
        const bundle = createStructuredOutputTool(
          agentOpts.schema as Record<string, unknown>,
          validate,
        );
        capture = bundle.capture;
        subTools.push(bundle.tool);
        continue;
      }
      const tool = tools.find((candidate) => candidate.name === name);
      // A name this session does not have is simply not offered: the model
      // cannot call what it was never shown.
      if (tool) subTools.push(tool);
    }

    // ---- where it runs -----------------------------------------------------
    let worktree: GitWorktreeInfo | undefined;
    let runCwd = cwd;
    if (agentOpts.isolation === 'worktree' && typeof agentOpts.workingDir === 'string' && agentOpts.workingDir) {
      throw new WorkflowAgentFailedError(
        'agent(): isolation and workingDir are mutually exclusive — isolation creates a worktree, workingDir pins one that already exists.',
        'error',
      );
    }
    if (agentOpts.isolation === 'worktree') {
      if (await isLinkedWorktree(cwd)) {
        throw new WorkflowAgentFailedError(
          "agent({isolation:'worktree'}): this session already runs inside a linked worktree, and worktrees of worktrees are not supported. Pass the directory as workingDir instead.",
          'error',
        );
      }
      if (await isDirty(cwd)) {
        throw new WorkflowAgentFailedError(
          "agent({isolation:'worktree'}): the working tree has uncommitted changes, so a fresh worktree from HEAD would not be the state you are looking at. Commit or stash them, or pin an existing directory with workingDir.",
          'error',
        );
      }
      worktree = await createWorktree(cwd, newWorktreeSlug(), {
        worktreesRoot: path.join(paths.projectRoot, 'worktrees'),
      });
      runCwd = worktree.path;
    } else if (typeof agentOpts.workingDir === 'string' && agentOpts.workingDir) {
      const pinned = await resolveRegisteredWorktree(cwd, agentOpts.workingDir);
      if (pinned === null) {
        throw new WorkflowAgentFailedError(
          `agent({workingDir}): ${stripAnsiAndControl(agentOpts.workingDir)} is not a registered linked worktree of this repository.`,
          'error',
        );
      }
      runCwd = pinned.path;
    }

    // min-agent's tools read the process cwd, so pinning an agent to a worktree
    // means binding the directory for the duration of this dispatch.
    const previousCwd = process.cwd();
    if (runCwd !== previousCwd) {
      try {
        process.chdir(runCwd);
      } catch (error) {
        if (worktree) await removeWorktree(worktree).catch(() => false);
        throw new WorkflowAgentFailedError(
          `agent(): cannot enter ${stripAnsiAndControl(runCwd)}: ${String(error)}`,
          'error',
        );
      }
    }

    const context: Context = {
      systemPrompt: [
        validate ? WORKFLOW_SUBAGENT_SYSTEM_PROMPT_WITH_SCHEMA : WORKFLOW_SUBAGENT_SYSTEM_PROMPT,
        worktree || runCwd !== previousCwd ? WORKFLOW_WORKTREE_NOTICE : '',
      ]
        .filter(Boolean)
        .join('\n'),
      messages: [{ role: 'user', content: prompt }],
    };

    const gatedTools = requestApproval
      ? subTools.map((tool) => gateTool(tool, requestApproval, { subagentId, runId, label, emit, roundsOf: () => rounds }))
      : subTools;

    const transcriptPath = paths.transcriptPath(runId, subagentId);
    const record = async (line: Record<string, unknown>): Promise<void> => {
      try {
        await writeLine(transcriptPath, { subagentId, runId, at: Date.now(), ...line });
      } catch (error) {
        // A transcript is a diagnostic. Failing to write one must never fail a
        // dispatch that is otherwise working.
        debugLogger.warn(`transcript write failed for ${subagentId}: ${String(error)}`);
      }
    };

    emit('start', {
      tools: gatedTools.map((tool) => tool.name),
      model: typeof agentOpts.model === 'string' ? agentOpts.model : model.model,
      ...(label !== undefined ? { label } : {}),
    });
    await record({ type: 'start', prompt, tools: gatedTools.map((tool) => tool.name) });

    const outcome = await runStallResilient(
      async (attemptSignal, attemptBus) => {
        attemptEmitter = attemptBus;
        const controller = new AbortController();
        const abortWith = (reason: unknown): void => {
          if (!controller.signal.aborted) controller.abort(reason);
        };
        const forwardParentAbort = (): void => abortWith(attemptSignal.reason);
        if (attemptSignal.aborted) abortWith(attemptSignal.reason);
        else attemptSignal.addEventListener('abort', forwardParentAbort, { once: true });

        const deadline = setTimeout(
          () => abortWith('workflow-timeout'),
          bounds.max_time_minutes * 60_000,
        );

        const effectiveModel: Model =
          typeof agentOpts.model === 'string' && agentOpts.model.length > 0
            ? { ...model, model: agentOpts.model }
            : model;

        try {
          for await (const event of runAgent(
            effectiveModel,
            context,
            gatedTools,
            controller.signal,
          )) {
            publish(event);
            await record({ type: 'agent_event', event });

            if (event.type === 'usage') outputTokens += event.usage.completionTokens;
            if (event.type === 'tool_call') {
              toolCalls++;
              // One round per tool step: min-agent's loop has no explicit round
              // marker, and a step is what the ceiling is really about.
              rounds++;
              if (rounds >= bounds.max_turns) abortWith('workflow-max-turns');
            }
            if (controller.signal.aborted) break;

            // Schema mode ends the agent the moment a submission validates —
            // the model has answered, and any further turn is paid for twice.
            if (capture?.accepted) break;
          }
        } finally {
          clearTimeout(deadline);
          attemptSignal.removeEventListener('abort', forwardParentAbort);
          attemptEmitter = undefined;
        }

        if (controller.signal.aborted) {
          const reason = controller.signal.reason;
          if (reason === 'workflow-timeout') {
            throw new WorkflowAgentFailedError(
              `did not complete within ${bounds.max_time_minutes} minutes.`,
              'timeout',
              'TIMEOUT',
            );
          }
          if (reason === 'workflow-max-turns') {
            throw new WorkflowAgentFailedError(
              `did not complete (turn ceiling: ${bounds.max_turns}).`,
              'max_turns',
              'MAX_TURNS',
            );
          }
          // Parent abort — cancellation or the run's wall clock. Not this agent's
          // failure, so it is not retried and not recorded as one.
          throw new Error('Agent execution aborted.');
        }

        if (validate) {
          if (!capture?.accepted) {
            throw new WorkflowAgentFailedError(
              describeMissingStructuredOutput(capture),
              'no_structured_output',
            );
          }
          return { result: capture.value as object };
        }
        return { result: finalAssistantText(context) };
      },
      {
        stallMs: resolveStallMs(agentOpts.stallMs, stallEnv),
        ...(signal !== undefined ? { signal } : {}),
        label: label ?? subagentId,
      },
    ).catch(async (error: unknown) => {
      // A failed fan-out must not leave one directory per attempt behind.
      if (worktree) {
        const changed = await worktreeHasChanges(worktree);
        if (!changed) await removeWorktree(worktree).catch(() => false);
        worktree = undefined;
      }
      throw error;
    });

    let result = outcome.result;
    if (worktree) {
      if (await worktreeHasChanges(worktree)) {
        // Keeping it and saying so beats discarding an agent's edits.
        result = typeof result === 'string'
          ? `${result}\n\n[worktree preserved at ${worktree.path} on branch ${worktree.branch}]`
          : { ...result, worktree: { path: worktree.path, branch: worktree.branch } };
      } else {
        await removeWorktree(worktree).catch((error) =>
          debugLogger.warn(`worktree cleanup failed: ${String(error)}`),
        );
      }
    }

    if (runCwd !== previousCwd) {
      try {
        process.chdir(previousCwd);
      } catch (error) {
        debugLogger.error(`cannot restore cwd ${previousCwd}: ${String(error)}`);
      }
    }

    onTokens?.(outputTokens);
    emit('finish', {
      stopReason: 'end_turn',
      rounds,
      totalToolCalls: toolCalls,
      outputTokens,
    });
    await record({ type: 'finish', result: preview(result) });

    return result;

    /** Re-publish one subagent generator event onto the buses. */
    function publish(event: AgentEvent): void {
      switch (event.type) {
        case 'assistant_text':
          emit('stream_text', { delta: event.delta });
          break;
        case 'tool_call':
          emit('tool_call', { callId: event.id, name: event.name, args: event.args });
          break;
        case 'tool_result':
          emit('tool_result', {
            callId: event.id,
            name: event.name,
            success: !event.result.startsWith('error:'),
            result: event.result,
          });
          break;
        case 'usage':
          emit('usage_metadata', {
            promptTokens: event.usage.promptTokens,
            completionTokens: event.usage.completionTokens,
            totalTokens: event.usage.totalTokens,
          });
          break;
        case 'retry':
          emit('retry', {
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            errorMessage: event.errorMessage,
          });
          break;
        case 'user_interject':
          emit('external_message', { text: event.text });
          break;
        case 'turn_end':
          emit('round_end', { });
          break;
      }
    }
  };
}

/** Wrap a tool so the human can veto it. */
function gateTool(
  tool: AgentTool,
  requestApproval: NonNullable<MinAgentDispatchOptions['requestApproval']>,
  ctx: {
    subagentId: string;
    runId: string;
    label?: string;
    emit: <E extends keyof WorkflowEventMap>(
      type: E,
      payload: WorkflowEventPayload<E>,
    ) => void;
    roundsOf: () => number;
  },
): AgentTool {
  return {
    ...tool,
    execute: async (args: unknown, signal?: AbortSignal): Promise<string> => {
      const outcome = await requestApproval({
        subagentId: ctx.subagentId,
        runId: ctx.runId,
        ...(ctx.label !== undefined ? { label: ctx.label } : {}),
        toolName: tool.name,
        args,
      });
      if (outcome === 'deny') {
        // A denial is returned to the model as a tool error rather than thrown,
        // so the agent can still finish and say what it wanted to do.
        return `error: the user denied this ${tool.name} call from a workflow agent`;
      }
      return tool.execute(args, signal);
    },
  };
}

/** Keep a transcript line bounded; the full result is in the journal. */
function preview(result: WorkflowAgentResult): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return text.length > 4096 ? `${text.slice(0, 4096)}…` : text;
}
