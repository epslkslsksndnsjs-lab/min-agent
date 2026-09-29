/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// The engine half of QwenLM/qwen-code's workflow-orchestrator.ts (Apache-2.0):
// the five gates an `agent()` call passes, the concurrency window, replay from
// the journal, `parallel()`/`pipeline()` semantics, run-level vs agent-level
// error handling, and dispatch tracing. See PROVENANCE.md.
//
// Upstream this file also held `createProductionDispatch` — ~1450 lines that
// build a subagent out of its host (Config, SubagentManager, git worktree
// service, transcript writers, schema-mode Config overrides). That is the seam,
// not the engine: everything here reaches a subagent only through the injected
// `WorkflowAgentDispatch`. min-agent's implementation of that seam is
// ./dispatch.ts. Dropping the host half is what makes this file portable; the
// two references to it that remained were comments.

import {
  MAX_WORKFLOW_CALL_TRACES,
  readWorkflowStepId,
  type WorkflowCallTrace,
} from './correlation.js';
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as os from 'node:os';
import {
  createWorkflowSandbox,
  debugLogger,
  type WorkflowSandbox,
} from './sandbox.js';
import type {
  WorkflowAgentOpts,
  WorkflowAgentResult,
  WorkflowBudget,
  WorkflowMeta,
  WorkflowOrchestratorEmitter,
} from './sandbox.js';
import { WorkflowBudgetExceededError } from './budget.js';
import {
  isWorkflowAgentFailedError,
  isWorkflowRunLevelError,
  WorkflowAgentCapExceededError,
  WorkflowAgentFailedError,
} from './agent-failure.js';
import { resolveStallMs, runStallResilient } from './stall.js';
import {
  prepareWorkflowSchema,
  validateStructuredResult,
  type WorkflowSchemaValidate,
} from './schema.js';
import {
  DISPATCH_AFFECTING_AGENT_OPTS,
  deriveAgentKey,
  deriveArgsSeed,
  type WorkflowJournal,
  type JournalReplay,
} from './journal.js';
import { parsePositiveIntegerEnv } from './env.js';
import { stripAnsiAndControl } from './support.js';
import { WorkflowDispatchScheduler } from './dispatch-scheduler.js';

import { WORKFLOW_SUBAGENT_DISALLOWED_TOOLS } from './agent-tools.js';

export { WORKFLOW_SUBAGENT_DISALLOWED_TOOLS };

/**
 * Default ceiling on total `agent()` calls per workflow run (matches upstream
 * `hOK = 1000`). Counts EVERY dispatch — sequential, `parallel()`, and
 * `pipeline()` all funnel through the one wrapped dispatch — so a fan-out
 * cannot bypass it. The 1001st call throws. Override via env (see below).
 */
export const DEFAULT_MAX_AGENTS_PER_RUN = 1000;
export const MAX_WORKFLOW_AGENTS_ENV = 'MIN_AGENT_MAX_WORKFLOW_AGENTS';
/**
 * Absolute upper bound on the env-override agent cap. Even an operator who
 * sets `MIN_AGENT_MAX_WORKFLOW_AGENTS=999999999` cannot exceed this — the
 * intent is to catch fat-finger / misconfig that would silently uncap a
 * runaway workflow (1000-agent default × per-agent token cost). 10000 is
 * 10× the default, generous for legitimate large fan-outs.
 */
export const HARD_MAX_AGENTS_PER_RUN_CEILING = 10_000;

/**
 * Resolve the per-run agent cap, honoring `MIN_AGENT_MAX_WORKFLOW_AGENTS`.
 * Mirrors `resolveMaxConcurrentBackgroundAgents` (background-tasks.ts): a
 * non-integer / <1 override is rejected with a debug warning and the default
 * is used. An override above `HARD_MAX_AGENTS_PER_RUN_CEILING` is clamped
 * (with a debug warning) — the env knob is operator-facing, not security-
 * critical, but a misconfigured ceiling shouldn't silently uncap the run.
 */
export function resolveMaxAgentsPerRun(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[MAX_WORKFLOW_AGENTS_ENV];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_MAX_AGENTS_PER_RUN;
  }
  // Parse through the shared helper so only plain decimal integers are
  // accepted; Number() alone would let "0x10"/"1e3"/"1.0" slip through.
  const parsed = parsePositiveIntegerEnv(raw, 0);
  if (parsed < 1) {
    debugLogger.warn(
      `Invalid ${MAX_WORKFLOW_AGENTS_ENV}=${JSON.stringify(raw)}, ` +
        `using default (${DEFAULT_MAX_AGENTS_PER_RUN})`,
    );
    return DEFAULT_MAX_AGENTS_PER_RUN;
  }
  if (parsed > HARD_MAX_AGENTS_PER_RUN_CEILING) {
    debugLogger.warn(
      `${MAX_WORKFLOW_AGENTS_ENV}=${parsed} exceeds hard ceiling ` +
        `(${HARD_MAX_AGENTS_PER_RUN_CEILING}); clamping.`,
    );
    return HARD_MAX_AGENTS_PER_RUN_CEILING;
  }
  return parsed;
}

export const MAX_WORKFLOW_CONCURRENCY_ENV =
  'MIN_AGENT_MAX_WORKFLOW_CONCURRENCY';
/**
 * Absolute upper bound on the env-override concurrency window. Above this,
 * a single Node process running N concurrent LLM calls is past the point a
 * distributed worker is the better tool. 64 ≈ 4× the 16-default ceiling.
 */
export const HARD_MAX_CONCURRENCY_CEILING = 64;

/**
 * Maximum agents in flight at once within a single run, shared across all
 * `parallel()` / `pipeline()` calls. `min(16, availableParallelism()-2)`
 * mirrors upstream; `max(2, …)` floors small machines at 2 — a window of 1
 * would serialize every `parallel()` and silently defeat the point of a
 * fan-out. `MIN_AGENT_MAX_WORKFLOW_CONCURRENCY` overrides the computed value
 * with an explicit integer in `[1, HARD_MAX_CONCURRENCY_CEILING]`; an invalid
 * override falls back to the cpu-derived default with a debug warning, and an
 * over-ceiling override is clamped.
 */
export function resolveConcurrencyLimit(
  env: Record<string, string | undefined> = process.env,
  availableParallelism: () => number = os.availableParallelism,
): number {
  const raw = env[MAX_WORKFLOW_CONCURRENCY_ENV];
  if (raw !== undefined && raw.trim() !== '') {
    // Parse through the shared helper so only plain decimal integers are
    // accepted; Number() alone would let "0x10"/"1e2"/"1.0" slip through.
    const parsed = parsePositiveIntegerEnv(raw, 0);
    if (parsed >= 1) {
      if (parsed > HARD_MAX_CONCURRENCY_CEILING) {
        debugLogger.warn(
          `${MAX_WORKFLOW_CONCURRENCY_ENV}=${parsed} exceeds hard ceiling ` +
            `(${HARD_MAX_CONCURRENCY_CEILING}); clamping.`,
        );
        return HARD_MAX_CONCURRENCY_CEILING;
      }
      return parsed;
    }
    debugLogger.warn(
      `Invalid ${MAX_WORKFLOW_CONCURRENCY_ENV}=${JSON.stringify(raw)}, ` +
        `using cpu-derived default`,
    );
  }
  // `availableParallelism()` honours the process's CPU affinity mask and
  // container CPU limits; `os.cpus()` reports the host and can return an
  // empty array in some sandboxes, which used to make every run serial.
  // Floor of 2: a window of 1 turns `parallel()` into a sequence and
  // silently defeats the point of a fan-out on a small machine.
  return Math.max(2, Math.min(16, availableParallelism() - 2));
}

/**
 * Bound the resource ceiling for workflow subagents so a single `agent()`
 * call cannot loop the model indefinitely. Values mirror conservative
 * upstream defaults; P5 will refine via `budget` once it exists.
 *
 * These are floors on *safety*, not statements about how long real work
 * takes. A long-running agent — a build-and-test step, an analysis of a
 * 2 000-line file, anything that pages through large reads — exceeds 50
 * turns or 10 minutes routinely, and under the GOAL-terminal contract
 * hitting either shows up as a `null` element in `parallel()`: an agent that
 * silently went missing rather than one that visibly failed. So both are
 * operator-tunable via env, on the same env-override pattern as the other
 * workflow bounds; like `MIN_AGENT_MAX_WORKFLOW_AGENTS` (and unlike
 * `MIN_AGENT_WORKFLOW_STALL_SECONDS` / `MIN_AGENT_MAX_WORKFLOW_SECONDS`,
 * which apply valid overrides verbatim), clamped to a hard ceiling.
 *
 * Three time bounds act on a dispatch and they are NOT redundant:
 *  - `stallMs` (3 min default) — no *progress* for this long ⇒ abort + retry.
 *    Held while a tool is in flight, so a slow tool is not a stall.
 *  - `max_time_minutes` (this) — total wall time for ONE attempt, stalled or
 *    not. Bounds the case the watchdog cannot see (a model that keeps
 *    emitting progress forever).
 *  - `MIN_AGENT_MAX_WORKFLOW_SECONDS` (30min default) — the whole run,
 *    every dispatch together. Raising the per-agent bound without raising
 *    this one just moves which limit kills the run.
 */
export const DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS = 50;
export const DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES = 10;
export const WORKFLOW_SUBAGENT_MAX_TURNS_ENV =
  'MIN_AGENT_WORKFLOW_AGENT_MAX_TURNS';
export const WORKFLOW_SUBAGENT_MAX_MINUTES_ENV =
  'MIN_AGENT_WORKFLOW_AGENT_MAX_MINUTES';
/** 10× the defaults — generous for a legitimate long agent, still bounded. */
export const HARD_WORKFLOW_SUBAGENT_MAX_TURNS_CEILING = 500;
export const HARD_WORKFLOW_SUBAGENT_MAX_MINUTES_CEILING = 100;

/**
 * Resolve one env-tunable per-subagent bound. Same contract as
 * {@link resolveMaxAgentsPerRun}: a non-integer / <1 override is rejected
 * with a debug warning and the default is used; an override above the hard
 * ceiling is clamped.
 */
function resolveSubagentBound(
  envName: string,
  defaultValue: number,
  ceiling: number,
  env: Record<string, string | undefined>,
): number {
  const raw = env[envName];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const parsed = parsePositiveIntegerEnv(raw, 0);
  if (parsed < 1) {
    debugLogger.warn(
      `Invalid ${envName}=${JSON.stringify(raw)}, using default (${defaultValue})`,
    );
    return defaultValue;
  }
  if (parsed > ceiling) {
    debugLogger.warn(
      `${envName}=${parsed} exceeds hard ceiling (${ceiling}); clamping.`,
    );
    return ceiling;
  }
  return parsed;
}

/** Per-attempt turn ceiling for a workflow subagent. */
export function resolveSubagentMaxTurns(
  env: Record<string, string | undefined> = process.env,
  defaultValue = DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS,
): number {
  return resolveSubagentBound(
    WORKFLOW_SUBAGENT_MAX_TURNS_ENV,
    defaultValue,
    HARD_WORKFLOW_SUBAGENT_MAX_TURNS_CEILING,
    env,
  );
}

/** Per-attempt wall-clock ceiling, in minutes, for a workflow subagent. */
export function resolveSubagentMaxTimeMinutes(
  env: Record<string, string | undefined> = process.env,
  defaultValue = DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES,
): number {
  return resolveSubagentBound(
    WORKFLOW_SUBAGENT_MAX_MINUTES_ENV,
    defaultValue,
    HARD_WORKFLOW_SUBAGENT_MAX_MINUTES_CEILING,
    env,
  );
}

/**
 * `WorkflowExecutionError` preserves the phases and logs the script
 * accumulated before failing — without it, all diagnostic context is lost
 * when the orchestrator's catch block surfaces only `err.message`.
 *
 * `cause` carries the underlying error message but no host-realm Error
 * object: we only ever store strings to avoid re-introducing the T1
 * thrown-Error realm-escape vector.
 */
export class WorkflowExecutionError extends Error {
  override readonly name = 'WorkflowExecutionError';
  constructor(
    message: string,
    readonly phases: string[],
    readonly logs: string[],
    /**
     * The extracted meta if it was parsed before the script body threw —
     * null otherwise (no declaration in the source, or malformed meta
     * which itself was the failure). Surfaced so the tool's failure
     * display can still show the workflow's name / description / phases.
     */
    readonly meta: WorkflowMeta | null = null,
  ) {
    super(message);
  }
}

// FIX-E (Round 4 ARCH-I1): single source of truth for the dispatch return
// type is `workflow-sandbox.ts`. Re-exported here so external consumers
// (WorkflowTool) can import the alias from the orchestrator module.
export type { WorkflowAgentResult, WorkflowMeta, WorkflowOrchestratorEmitter };

export interface WorkflowRunRequest {
  script: string;
  args: unknown;
  maxWallClockMs?: number;
  // FIX-D (Round 3 ARCH-I1): `signal` was previously declared here but never
  // read by `run()` — cancellation flows through `createProductionDispatch`'s
  // closure-captured signal, not via per-run state. Removed to prevent
  // P2 authors from extending the wrong field.
  /**
   * T40 (PR #4732 R4): caller-owned AbortController linked to the wall-clock
   * timeout. When the sandbox times out, this controller is aborted BEFORE
   * the rejection propagates — letting in-flight subagent dispatches see
   * the cancellation and stop burning tokens. The caller (`WorkflowTool`)
   * also threads this same controller's signal into `createProductionDispatch`
   * and aborts it in its own `finally` block to clean up on normal completion.
   * If omitted, the wall-clock still rejects but in-flight subagents continue
   * until their internal `max_time_minutes` limit.
   */
  abortOnTimeout?: AbortController;
  /**
   * P4b: optional host-side event channel. When provided, the orchestrator
   * fires `agentDispatched` / `agentCompleted` inside `countedDispatch`
   * and the sandbox fires `phaseStarted` / `logAppended` from `safePhase`
   * / `safeLog`. Wired into `SandboxOptions.emitter` and used by
   * `WorkflowTool` to keep the `WorkflowRunRegistry` record in sync
   * with the run state for the pill + dialog + detail body.
   */
  emitter?: WorkflowOrchestratorEmitter;
  /**
   * P4b: pre-generated run identifier. Callers that need the id at
   * register-time (e.g. `WorkflowTool` registering the run with
   * `WorkflowRunRegistry` before `run()` resolves) must pre-generate
   * one and pass it here. The orchestrator does NOT validate the
   * shape — it trusts the caller (the production caller uses
   * `wf_<8hex>` to match `generateRunId()`). Omitted by tests and by
   * the historical contract; orchestrator falls back to its own
   * generator so existing call sites work unchanged.
   */
  runId?: string;
  /**
   * P5: optional token budget — the turn's `+500k` target or an operator's
   * per-run cap (see `workflow-budget.ts`). When provided, `countedDispatch`
   * checks `budget.remaining() > 0` BEFORE each `agent()` dispatch and
   * throws `WorkflowBudgetExceededError` if the cap is hit. Also
   * surfaced via `SandboxOptions.budget` so the script-side `budget`
   * global reads the live state (`budget.spent()` / `budget.remaining()`
   * for dynamic-loop patterns).
   *
   * Token recording happens inside the production dispatch
   * (`createProductionDispatch` reads `subagent.core.stats.getSummary
   * (...).outputTokens` after each successful execute and reports back
   * via the `onTokens` callback the WorkflowTool wires through). Test
   * dispatches that want to assert budget gating should call
   * `budget.recordSpent(N)` directly.
   */
  budget?: WorkflowBudget;
  /**
   * P-nested: resolver for the `workflow(nameOrRef, args)` global. When
   * provided, the top-level sandbox exposes `workflow`, which resolves a
   * saved workflow (by name from `.qwen/workflows/<name>.js`, or by
   * `{scriptPath}`) and runs it as a nested orchestration that shares THIS
   * run's agent-count cap, concurrency window, token budget, and emitter
   * (so nested phases/logs and token spend roll into the same registry
   * entry). Nesting is limited to a single level: the nested sandbox is
   * created without a `workflow` impl, so a second-level `workflow()` call
   * throws. When omitted, `workflow()` throws "unavailable". The production
   * caller (`WorkflowTool`) wires `resolveSavedWorkflowScript(ref, config)`;
   * tests inject a mock resolver.
   */
  resolveSavedWorkflow?: (
    nameOrRef: string | { scriptPath: string },
  ) => Promise<{ script: string; scriptPath?: string; name?: string }>;
  /**
   * P6: append-only resume journal for THIS run. When provided, every live
   * `agent()` dispatch appends a `started` then a `result` line keyed by the
   * rolling prefix-hash. Always set by the production caller (`WorkflowTool`)
   * so any run is resumable; omitted by tests that don't exercise resume.
   */
  journal?: WorkflowJournal;
  /**
   * P6: replay maps loaded from a prior run's journal. Present only when
   * resuming (`Workflow({resumeFromRunId})`). Cached results are served for
   * the longest unchanged prefix; the first cache miss flips the run to
   * live for the remainder ("first miss invalidates the suffix").
   */
  resumeReplay?: JournalReplay;
  /** Per-run scheduler shared with the registry-owned run handle. */
  scheduler?: WorkflowDispatchScheduler;
}

export interface WorkflowRunOutcome {
  runId: string;
  result: unknown;
  phases: string[];
  logs: string[];
  /**
   * The script's `export const meta = {...}` declaration (P4). `null` when
   * the script omits the declaration. Surfaced verbatim from the sandbox's
   * `getMeta()` so callers (`/workflows` listing, phase-tree UI) can read
   * the workflow's name / description / phases / whenToUse without
   * re-parsing the script source.
   */
  meta: WorkflowMeta | null;
}

export type WorkflowAgentDispatch = (
  prompt: string,
  opts: WorkflowAgentOpts,
  dispatchId?: string,
) => Promise<WorkflowAgentResult>;

/**
 * The script-facing `agent()` — `countedDispatch`, the wrapper the sandbox
 * actually calls. Wider than the dispatch it wraps by exactly one value:
 * `null`, for an agent that failed on its own terms. The wrapped dispatch
 * only ever resolves with a result or throws; deciding that a given throw is
 * the agent's failure rather than the run's belongs to the wrapper.
 */
export type WorkflowCountedDispatch = (
  prompt: string,
  opts: WorkflowAgentOpts,
  workflowCallId?: string,
) => Promise<WorkflowAgentResult | null>;

/**
 * The per-run figures the registry mirrors: this run's own spend and the cap
 * on this run alone, which differ from `spent()` / `total` when the budget is
 * the whole turn's.
 */
function runBudgetFigures(
  budget: WorkflowBudget,
): [spent: number, total: number | null] {
  return [
    budget.runSpent ? budget.runSpent() : budget.spent(),
    budget.runCap ? budget.runCap() : budget.total,
  ];
}

function generateRunId(): string {
  return `wf_${randomBytes(8).toString('hex')}`;
}

/**
 * Sanitize a user-controlled string for safe interpolation into an error
 * message. Control characters (CR / LF / NUL / etc.) are replaced with a
 * single space so a model-authored agentType cannot fragment a single-line
 * error across log records / OTLP fields / display payloads. P3 R2
 * self-review surfaced this; the corresponding throw site is in
 * `runOverridePath` for `opts.agentType`.
 */
function sanitizeForErrorMessage(value: string): string {
  // Shared with the extension converters via stripAnsiAndControl: strips ANSI/VT
  // escape sequences and removes C0/C1 control chars (incl. the C1 range the old
  // local regex missed). Removing rather than spacing still keeps the error
  // single-line, which is the original intent here.
  return stripAnsiAndControl(value);
}

export interface WorkflowSubagentBounds {
  max_turns: number;
  max_time_minutes: number;
}

/**
 * Build the production agent-dispatch function.
 *
 * Wraps AgentHeadless.create + execute + getFinalText into the
 * `(prompt, opts) => Promise<string>` shape required by the sandbox.
 *
 * Dynamic import lets test mocks swap agent-headless without static-import
 * hoisting interference.
 *
 * FIX-6 (ARCH-C1): accepts an optional AbortSignal and threads it into
 * subagent.execute() so cancellation from the caller propagates correctly.
 * When signal is undefined, subagent.execute() runs without external abort.
 *
 * P3 dispatch routing — two paths:
 *
 *  - **Fast path** (no `agentType` and no `model`): direct
 *    `AgentHeadless.create` with the default workflow subagent prompt and
 *    the hardcoded resource bounds + disallowed-tool floor. P1/P2 behaviour
 *    unchanged — zero added overhead, no SubagentManager touch.
 *
 *  - **Override path** (`agentType` and/or `model` set): route through
 *    `SubagentManager.createAgentHeadless` so per-call model overrides go
 *    through `buildRuntimeContentGeneratorView` (provider routing) and
 *    per-agent MCP servers / hooks get their own ToolRegistry + lifecycle.
 *    `dispose()` runs in a `finally` block so the rebuilt registry never
 *    leaks past a dispatch — even on a thrown subagent.execute().
 */
export class WorkflowOrchestrator {
  constructor(private readonly dispatch: WorkflowAgentDispatch) {}

  async run(req: WorkflowRunRequest): Promise<WorkflowRunOutcome> {
    // Signal threading: createProductionDispatch closure-captures a signal
    // for subagent.execute cancellation. P2 additionally derives a per-run
    // scheduler from req.abortOnTimeout?.signal so wall-clock abort drains
    // queued dispatches promptly. Sync-loop protection is the 30s vm
    // timeout in workflow-sandbox.ts; async-loop cancellation flows through
    // dispatch's subagent.execute path.
    //
    // P4b: callers (`WorkflowTool`) may pre-generate `runId` and pass it
    // in so they can register the run with `WorkflowRunRegistry` BEFORE
    // `run()` resolves — necessary because the registry needs the id at
    // emit time, not at resolve time. The orchestrator trusts the caller
    // and does not validate the shape — the only production caller
    // (`WorkflowTool`) uses the same `wf_<8hex>` generator as
    // `generateRunId()`. When omitted, the orchestrator generates one
    // as before.
    const runId = req.runId ?? generateRunId();

    const maxAgents = resolveMaxAgentsPerRun();
    const signal = req.abortOnTimeout?.signal;

    // P2: the concurrency window throttles AGENT DISPATCHES, not orchestration
    // thunks. parallel()/pipeline() compose promises freely; only the leaf
    // agent() calls acquire a slot. This gives the correct "N agents in flight
    // per run" semantics AND avoids a re-entrancy deadlock (F1, P2 review): if
    // the window sat at the thunk level, a nested parallel()/pipeline() — e.g.
    // a pipeline stage that fans out, the canonical /deep-research shape —
    // would hold every slot while awaiting inner work that can never acquire
    // one. One shared scheduler per run keeps total in-flight agents under the
    // cap across all fan-out calls.
    const scheduler =
      req.scheduler ??
      new WorkflowDispatchScheduler(resolveConcurrencyLimit(), signal);

    // R12 (doudouOUC): entry-gate rejections must settle through the pause
    // gate like every other settlement path below. A bare Promise.reject
    // delivers immediately while the run is `paused`, so a script that
    // catches the rejection keeps executing during pause — silently
    // ineffective pause on the budget / agent-cap path.
    const rejectThroughPauseGate = (error: unknown): Promise<never> =>
      scheduler.waitUntilRunning().then(
        () => {
          throw error;
        },
        () => {
          throw error;
        },
      );

    // Every agent() call — sequential, parallel(), or pipeline() — funnels
    // through this one wrapped dispatch: the counter enforces the per-run agent
    // cap regardless of launch path (increment-then-check: calls 1..max pass,
    // the (max+1)th throws), and scheduler.run enforces the dispatch window.
    let agentCount = 0;
    let dispatchTraceCount = 0;
    const emitter = req.emitter;
    const budget = req.budget;
    const dependencyContext = new AsyncLocalStorage<{ tails: string[] }>();
    const issueDispatchTrace = (
      prompt: string,
      opts: WorkflowAgentOpts,
      cached = false,
      workflowCallId?: string,
    ): string => {
      const id = `dispatch-${(dispatchTraceCount += 1)}`;
      const store = dependencyContext.getStore();
      const dependsOn = Array.from(new Set(store?.tails ?? []));
      if (store) store.tails = [id];
      try {
        emitter?.dispatchQueued?.({
          id,
          ...(opts.stepId !== undefined ? { stepId: opts.stepId } : {}),
          ...(workflowCallId ? { workflowCallId } : {}),
          ...(typeof opts.label === 'string' ? { label: opts.label } : {}),
          prompt,
          dependsOn,
          queuedAt: Date.now(),
          ...(cached ? { cached: true } : {}),
        });
      } catch (e) {
        debugLogger.warn('emitter.dispatchQueued threw:', e);
      }
      return id;
    };

    // P6: resume journal state. `prefixHash` chains across sequential
    // agent() calls; `hadMiss` enforces the "first miss invalidates the
    // suffix" invariant (once any dispatch runs live, no later dispatch
    // trusts the cache). `journalAgentId` numbers journal entries.
    const journal = req.journal;
    const replay = req.resumeReplay;
    // Seed the chain with the run's `args` so a resume with different args
    // produces a disjoint key space (every dispatch misses → re-runs live)
    // rather than silently replaying the prior run's results.
    let prefixHash = deriveArgsSeed(req.args);
    let hadMiss = false;
    const replayPrefix = new Set<string>();
    let replayBarrier: Promise<void> | undefined;
    let executionClosed = false;
    const assertExecutionOpen = (): void => {
      if (executionClosed || signal?.aborted) {
        throw new DOMException('Workflow run has ended.', 'AbortError');
      }
    };
    let journalAgentId = 0;
    // The sandbox is assigned before its script can call countedDispatch.
    // Keeping the reference here lets resume diagnostics enter the sandbox's
    // source-of-truth log buffer as well as the live emitter stream.
    const parentSandboxRef: { current: WorkflowSandbox | undefined } = {
      current: undefined,
    };

    const countedDispatch: WorkflowCountedDispatch = async (
      prompt,
      opts,
      workflowCallId,
    ) => {
      assertExecutionOpen();
      const stepId = readWorkflowStepId(opts.stepId);
      if (stepId !== undefined) opts = { ...opts, stepId };
      // Must run before deriveAgentKey below: hash.update() throws an
      // opaque ERR_INVALID_ARG_TYPE for a non-string prompt, preempting
      // the dispatch's boundary error on the journaled path.
      if (typeof prompt !== 'string' || prompt.length === 0) {
        return rejectThroughPauseGate(
          new Error('agent() requires a non-empty string prompt.'),
        );
      }
      // A schema is prepared before the cache is consulted, synchronously so
      // the key chain below keeps its call order. A schema that cannot be
      // prepared is held as data rather than thrown: the call still takes its
      // key, still misses the cache (a result journaled under a broken schema
      // is not trusted) and still passes the replay barrier and admission,
      // then settles as this agent's own failure before anything dispatches.
      const schemaPreparation =
        opts.schema === undefined
          ? undefined
          : prepareWorkflowSchema(opts.schema);
      const schemaError =
        schemaPreparation !== undefined && !schemaPreparation.ok
          ? schemaPreparation.error
          : undefined;
      // P6: journal cache lookup — runs BEFORE the budget gate + agent
      // counter so a cached result is free (no token spend, no agent-cap
      // slot, no live dispatch). The key is computed SYNCHRONOUSLY here so
      // the rolling prefix chains in deterministic call order even under
      // parallel()/pipeline() fan-out (the thunks' synchronous prefixes run
      // in array/microtask order).
      let journalKey: string | undefined;
      // Captured per-dispatch (NOT read from the shared counter later) so a
      // concurrent dispatch can't clobber the id used in the result append.
      let journalEntryId: string | undefined;
      let respawnLine: string | undefined;
      if (journal) {
        journalKey = deriveAgentKey(prefixHash, prompt, opts);
        prefixHash = journalKey;
        if (!hadMiss && replay && schemaError === undefined) {
          const cached = replay.results.get(journalKey);
          // A journaled structured result is served only if it passes this
          // call's validator: an older runtime could journal one its shared
          // validator skipped. The copy it validated (and may have coerced)
          // is what the script gets; the journal and replay map are
          // untouched. One that fails is a miss and re-runs live.
          let cachedResult = cached?.result;
          let cacheUsable = cached !== undefined;
          if (cached !== undefined && schemaPreparation?.ok) {
            const checked = validateStructuredResult(
              cached.result,
              schemaPreparation.validate,
            );
            if ('error' in checked) {
              debugLogger.info(
                `[Workflow] resume cache entry no longer satisfies its ` +
                  `schema for runId=${runId}; re-running live: ` +
                  sanitizeForErrorMessage(checked.error),
              );
              cacheUsable = false;
            } else {
              cachedResult = checked.value;
            }
          }
          if (cacheUsable) {
            const replayed = cachedResult;
            replayPrefix.add(journalKey);
            // Cache hit: surface dispatch + completion to the registry so
            // the UI counters advance, then return the cached result. A
            // prior `started`-without-`result` for this key means the agent
            // was respawned in an earlier resume — log it for diagnostics.
            const respawns = replay.started.get(journalKey);
            if (respawns && respawns.length > 0) {
              debugLogger.info(
                `[Workflow] resume cache hit after ${respawns.length} prior ` +
                  `respawn(s) for runId=${runId}.`,
              );
            }
            const label =
              typeof opts.label === 'string' ? opts.label : undefined;
            const dispatchId = issueDispatchTrace(
              prompt,
              opts,
              true,
              workflowCallId,
            );
            try {
              emitter?.agentDispatched?.(label);
            } catch (e) {
              debugLogger.warn('emitter.agentDispatched threw:', e);
            }
            try {
              emitter?.agentCompleted?.(label);
            } catch (e) {
              debugLogger.warn('emitter.agentCompleted threw:', e);
            }
            try {
              emitter?.dispatchSettled?.(dispatchId, undefined, Date.now());
            } catch (e) {
              debugLogger.warn('emitter.dispatchSettled threw:', e);
            }
            // Resolve even if the gate aborts: rejecting an already-cached
            // result at teardown would surface an unobserved rejection for
            // fire-and-forget calls on a correctly-cancelled run.
            return scheduler.waitUntilRunning().then(
              () => replayed as WorkflowAgentResult,
              () => replayed as WorkflowAgentResult,
            );
          }
        }
        // Running live over a key the journal started but never finished:
        // the previous run either failed this dispatch or was interrupted
        // with it in flight. Both re-run, but they are worth telling apart —
        // a failure is likely to repeat, an interruption is not — so report
        // which one instead of leaving the operator to infer it from a
        // missing result.
        //
        // A key that HAS a journaled result is excluded even though it is
        // running live: once any call misses, the prefix invariant sends
        // every later call live too, including ones that completed last
        // time. Those are re-run because of what happened upstream of them,
        // and calling that a respawn would blame the invariant on the agent
        // — in the ordinary interrupted fan-out (one agent in flight, its
        // siblings already done) it would report every sibling as
        // interrupted as well.
        const priorStarts = replay?.started.get(journalKey);
        if (
          priorStarts &&
          priorStarts.length > 0 &&
          !replay?.results.has(journalKey)
        ) {
          const name =
            typeof opts.label === 'string'
              ? `"${stripAnsiAndControl(opts.label)}"`
              : 'an agent';
          respawnLine = replay?.failed.has(journalKey)
            ? `[resume] re-running ${name}: it failed in the previous run`
            : `[resume] respawning ${name}: interrupted in a previous run ` +
              `(${priorStarts.length} prior attempt${priorStarts.length === 1 ? '' : 's'})`;
        }
        if (!hadMiss && replay) {
          // Queue the rewrite synchronously, before any concurrent suffix call
          // can dispatch or append. Even an unawaited call must persist it.
          replayBarrier = journal.retainReplayPrefix(new Set(replayPrefix));
          void replayBarrier.catch(() => undefined);
        }
        hadMiss = true;
      }
      if (replayBarrier) await replayBarrier;
      assertExecutionOpen();

      // P5 R3 (wenshao #7): budget gate runs BEFORE `agentCount += 1`
      // so budget-rejected dispatches don't consume agent-cap slots.
      // Previously the order was reversed: budget exhaustion incremented
      // `agentCount` on every subsequent call, eventually tripping the
      // agent-count cap and surfacing the WRONG terminal error
      // (`Workflow exceeded the maximum of N agent() calls per run`)
      // when the real cause was budget exhaustion. Reordering also keeps
      // `agentCount` and `agentsDispatched` (registry counter, fired
      // below) counting the same set of calls.
      //
      // P5: budget gate (entry check). When a per-run token cap is set
      // (MIN_AGENT_MAX_TOKENS_PER_WORKFLOW), fail-fast at fire time if the
      // cap is already busted. Token recording happens inside the production
      // dispatch (createProductionDispatch reads subagent stats and reports
      // back via the onTokens callback the WorkflowTool wires). No-op when
      // `budget.total === null` (no cap), because `budget.remaining()`
      // returns `Infinity` — the check never fires.
      //
      // P5 R1 (Critical #2): a SECOND gate fires inside `scheduler.run` below.
      // Without it, a `parallel([N thunks])` queues all N gate checks
      // synchronously (spent=0 at check time) → every queued dispatch
      // passes the entry gate → budget overshoots by up to
      // `(N-1) × per_dispatch_tokens`, not the documented
      // `(concurrency_window-1) × per_dispatch_tokens`. The in-scheduler
      // re-check observes budget mutations from already-completed in-flight
      // dispatches, restoring the documented overshoot bound.
      if (budget && budget.total !== null && budget.remaining() <= 0) {
        debugLogger.warn(
          `[Workflow] budget gate refused dispatch at entry: ` +
            `runId=${runId} spent=${budget.spent()} total=${budget.total}`,
        );
        return rejectThroughPauseGate(
          new WorkflowBudgetExceededError(runId, budget.total, budget.spent()),
        );
      }
      // P5 R3 (wenshao #7): agent-count cap runs AFTER the budget gate.
      // See the reordering rationale at the top of countedDispatch.
      if (agentCount >= maxAgents) {
        return rejectThroughPauseGate(
          new WorkflowAgentCapExceededError(maxAgents),
        );
      }
      agentCount += 1;
      if (journal && journalKey !== undefined) {
        journalEntryId = String((journalAgentId += 1));
      }
      // P4b: emit dispatch-start outside the scheduler so the registry
      // sees "queued" the moment the script issued the call, not after
      // a slot frees. Symmetric agentCompleted fires after the dispatch
      // settles (success or thrown) — defensive try/catch on both so a
      // subscriber error never propagates into the script.
      const label = typeof opts.label === 'string' ? opts.label : undefined;
      const dispatchId = issueDispatchTrace(
        prompt,
        opts,
        false,
        workflowCallId,
      );
      try {
        emitter?.agentDispatched?.(label);
      } catch (e) {
        debugLogger.warn('emitter.agentDispatched threw:', e);
      }
      let completionEmitted = false;
      const emitCompletion = (error?: unknown): void => {
        if (completionEmitted) return;
        completionEmitted = true;
        const message =
          error === undefined
            ? undefined
            : error instanceof Error
              ? error.message
              : String(error);
        try {
          emitter?.agentCompleted?.(label, message);
        } catch (e) {
          debugLogger.warn('emitter.agentCompleted threw:', e);
        }
        try {
          emitter?.dispatchSettled?.(dispatchId, message, Date.now());
        } catch (e) {
          debugLogger.warn('emitter.dispatchSettled threw:', e);
        }
      };
      return scheduler
        .run(async () => {
          try {
            assertExecutionOpen();
            try {
              emitter?.dispatchStarted?.(dispatchId, Date.now());
            } catch (e) {
              debugLogger.warn('emitter.dispatchStarted threw:', e);
            }
            // P5 R1 (Critical #2): re-check the gate at slot-acquire time so
            // queued thunks see budget updates from already-completed in-
            // flight dispatches. Without this, the entry gate above is
            // bypassed by `parallel()` (all N thunks fire-check-queue in one
            // microtask burst with spent=0).
            if (budget && budget.total !== null && budget.remaining() <= 0) {
              debugLogger.warn(
                `[Workflow] budget gate refused dispatch at slot-acquire: ` +
                  `runId=${runId} spent=${budget.spent()} total=${budget.total}`,
              );
              throw new WorkflowBudgetExceededError(
                runId,
                budget.total,
                budget.spent(),
              );
            }
            if (
              journal &&
              journalKey !== undefined &&
              journalEntryId !== undefined
            ) {
              journal
                .append({
                  type: 'started',
                  key: journalKey,
                  agentId: journalEntryId,
                })
                .catch((e) =>
                  debugLogger.warn(`journal started-append failed: ${e}`),
                );
            }
            if (respawnLine) {
              parentSandboxRef.current?.appendLog(respawnLine);
              try {
                emitter?.resumeRespawn?.(respawnLine);
              } catch (e) {
                debugLogger.warn('emitter.resumeRespawn threw:', e);
              }
            }
            if (schemaError !== undefined) {
              throw new Error(schemaError);
            }
            const result = await this.dispatch(prompt, opts, dispatchId);
            emitCompletion();
            // P6: append the live result to the journal so a later resume
            // serves it from cache. Only JSON-serializable results are
            // resumable; a non-serializable result is skipped (the next
            // resume re-runs that dispatch live). Fire-and-forget — a
            // journal write failure must not fail the dispatch.
            if (!executionClosed && journal && journalKey !== undefined) {
              journal
                .append({
                  type: 'result',
                  key: journalKey,
                  agentId: journalEntryId ?? '',
                  result,
                })
                .catch((e) =>
                  debugLogger.warn(`journal result-append failed: ${e}`),
                );
            }
            // P5: re-snapshot the budget after successful completion so the
            // registry sees the cumulative spent. The dispatch's onTokens
            // callback (when wired) has already called budget.recordSpent
            // before this point. Skipped when no budget — there is nothing
            // for the registry to mirror.
            if (budget) {
              try {
                emitter?.budgetUpdated?.(...runBudgetFigures(budget));
              } catch (e) {
                debugLogger.warn('emitter.budgetUpdated threw:', e);
              }
            }
            return result;
          } catch (err) {
            emitCompletion(err);
            // P5 R3 (bot #1): the dispatch's reportTokens runs in a
            // `finally` (R3 #6), so `budget.spent()` advances even when
            // the dispatch throws. Mirror that mutation to the registry
            // via `budgetUpdated` here, otherwise:
            //  (a) `entry.tokensSpent` (UI) and `budget.spent()` (host)
            //      diverge — a failed dispatch's burn is invisible in
            //      the dialog, and
            //  (b) after R2 #12 dropped `safeEmitUpdate` from
            //      `agentCompleted`, the error arm produces ZERO UI
            //      re-renders, freezing the agent counter until the
            //      next success.
            if (budget) {
              try {
                emitter?.budgetUpdated?.(...runBudgetFigures(budget));
              } catch (e) {
                debugLogger.warn('emitter.budgetUpdated threw:', e);
              }
            }
            // Journal only an admitted agent's own failure. Run-level limits
            // and cancellation leave the call interrupted, not failed.
            if (
              journal &&
              journalKey !== undefined &&
              !executionClosed &&
              !signal?.aborted &&
              !isWorkflowRunLevelError(err)
            ) {
              journal
                .append({
                  type: 'failed',
                  key: journalKey,
                  agentId: journalEntryId ?? '',
                })
                .catch((e) =>
                  debugLogger.warn(`journal failed-append failed: ${e}`),
                );
            }
            if (
              executionClosed ||
              signal?.aborted ||
              isWorkflowRunLevelError(err)
            ) {
              throw err;
            }
            // Every other rejection belongs to this admitted agent. Settle it
            // here so sequential and fan-out calls share one contract even
            // for failures that predate WorkflowAgentFailedError markers.
            if (isWorkflowAgentFailedError(err)) {
              debugLogger.warn(
                `[Workflow] agent settled to null (${err.kind}): ${err.message}`,
              );
            } else {
              debugLogger.warn(
                `[Workflow] agent settled to null: ${extractErrorMessage(err)}`,
              );
            }
            return null;
          }
        })
        .then(
          // Resolve even if the gate aborts: a successful dispatch must not
          // turn into a teardown rejection — for a fire-and-forget call the
          // script never attached a handler, so the rejection would surface
          // as a spurious process-level unhandledRejection alarm on a
          // correctly-cancelled run.
          (result) =>
            scheduler.waitUntilRunning().then(
              () => result,
              () => result,
            ),
          (error) => {
            // A queued job can be rejected by scheduler abort without ever
            // invoking its thunk. Settle the issued counter here as well;
            // emitCompletion's latch keeps dispatch/slot failures exactly-once.
            emitCompletion(error);
            return scheduler.waitUntilRunning().then(
              () => {
                throw error;
              },
              () => {
                throw error;
              },
            );
          },
        );
    };

    const parallelImpl = makeParallelImpl(signal, dependencyContext);
    const pipelineImpl = makePipelineImpl(signal, dependencyContext);

    // P-nested: build the host-side `workflow(nameOrRef, args)` impl. Only
    // wired at the top level (when a resolver is provided). The nested
    // sandbox shares THIS run's countedDispatch (so agentCount cap + budget
    // gate are global across parent + nested), the same concurrency window
    // (every leaf dispatch closes over the shared scheduler),
    // the same budget, and the same emitter (nested phase()/log() and token
    // spend roll into the same registry entry). Crucially the nested sandbox
    // is created WITHOUT a `workflow` impl — that throws on a second-level
    // `workflow()` call, enforcing the single-level nesting limit.
    let workflowCallCount = 0;
    const recordCall = (call: WorkflowCallTrace): void => {
      try {
        emitter?.workflowCallUpdated?.({ ...call });
      } catch (error) {
        debugLogger.warn('emitter.workflowCallUpdated threw:', error);
      }
    };
    const resolveSavedWorkflow = req.resolveSavedWorkflow;
    const workflowImpl = resolveSavedWorkflow
      ? async (
          nameOrRef: string | { scriptPath: string },
          nestedArgs: unknown,
          stepId?: string,
        ): Promise<unknown> => {
          const call: WorkflowCallTrace = {
            id: `workflow-call-${++workflowCallCount}`,
            ...(stepId !== undefined
              ? { stepId: readWorkflowStepId(stepId) }
              : {}),
            ...(typeof nameOrRef === 'string'
              ? { workflowName: nameOrRef }
              : {}),
            status: 'running',
            startedAt: Date.now(),
          };
          const recorded = workflowCallCount <= MAX_WORKFLOW_CALL_TRACES;
          if (recorded) recordCall(call);
          else if (workflowCallCount === MAX_WORKFLOW_CALL_TRACES + 1) {
            try {
              emitter?.workflowCallsTruncated?.();
            } catch (error) {
              debugLogger.warn('emitter.workflowCallsTruncated threw:', error);
            }
          }
          let nestedSandbox: WorkflowSandbox | undefined;
          try {
            const resolved = await resolveSavedWorkflow(nameOrRef);
            if (resolved.name) call.workflowName = resolved.name;
            nestedSandbox = createWorkflowSandbox({
              args: nestedArgs,
              runId,
              // Each sandbox closes over its own call, including parallel and cached dispatches.
              dispatch: (prompt, opts) =>
                countedDispatch(prompt, opts, call.id),
              parallel: parallelImpl,
              pipeline: pipelineImpl,
              abortOnTimeout: req.abortOnTimeout,
              emitter,
              budget,
              scheduler,
              // No workflow implementation: preserve single-level nesting.
            });
            const result = await nestedSandbox.run(resolved.script);
            call.status = signal?.aborted ? 'cancelled' : 'completed';
            return result;
          } catch (error) {
            call.status = signal?.aborted ? 'cancelled' : 'failed';
            try {
              const message =
                typeof error === 'string'
                  ? error
                  : error && typeof error === 'object'
                    ? Object.getOwnPropertyDescriptor(error, 'message')?.value
                    : undefined;
              if (typeof message === 'string') call.error = message;
            } catch {
              // Observing an error must not replace the original rejection.
            }
            throw error;
          } finally {
            call.endedAt = Date.now();
            if (recorded) recordCall(call);
            for (const line of nestedSandbox?.getLogs() ?? []) {
              parentSandboxRef.current?.appendLog(line);
            }
          }
        }
      : undefined;

    const sandbox = createWorkflowSandbox({
      args: req.args,
      maxWallClockMs: req.maxWallClockMs,
      runId,
      dispatch: countedDispatch,
      parallel: parallelImpl,
      pipeline: pipelineImpl,
      workflow: workflowImpl,
      abortOnTimeout: req.abortOnTimeout,
      emitter,
      budget,
      scheduler,
    });
    parentSandboxRef.current = sandbox;
    try {
      let result: unknown;
      try {
        result = await dependencyContext.run({ tails: [] }, () =>
          sandbox.run(req.script),
        );
      } finally {
        executionClosed = true;
        await replayBarrier;
      }
      return {
        runId,
        result,
        phases: sandbox.getPhases(),
        logs: sandbox.getLogs(),
        meta: sandbox.getMeta(),
      };
    } catch (err) {
      // T19 (PR #4732 R1): preserve phases and logs accumulated before the
      // script failed so the caller can surface them in the error display.
      // We only carry primitive strings across the boundary — no host-realm
      // Error instance — to avoid reintroducing the T1 escape vector.
      //
      // Cross-realm `instanceof Error` is false for vm-realm Error objects,
      // so duck-type on `.message` instead. `String(vmError)` would coerce
      // to "Error: <msg>" which is the wrong shape for a clean message.
      throw new WorkflowExecutionError(
        extractErrorMessage(err),
        sandbox.getPhases(),
        sandbox.getLogs(),
        sandbox.getMeta(),
      );
    }
  }
}

/**
 * Settle a batch of thunks into a position-aligned `Array<T|null>` —
 * errors-as-data: a thunk or admitted agent that rejects becomes `null` at
 * its index, never collapsing the batch.
 * `Promise.resolve().then(t)` funnels a synchronously-throwing thunk into the
 * rejection path. Cancellation and run-level dispatch gates reject the whole
 * batch because no later agent call can succeed under either condition.
 * Concurrency is bounded at the dispatch layer (scheduler.run in countedDispatch),
 * not here — so nesting a parallel()/pipeline() inside a thunk cannot deadlock.
 *
 * Abort responsiveness: this function awaits `Promise.allSettled` which only
 * settles after every thunk settles. That is NOT a long wait in practice
 * because the dispatch signal (workflow-orchestrator.ts countedDispatch +
 * createProductionDispatch) is threaded through to `subagent.execute(ctx,
 * signal)`, so each in-flight thunk reacts to abort and rejects promptly. The
 * scheduler's separate `addEventListener('abort')` listener drains the
 * not-yet-started queued thunks instantly. So the apparent "wait for all to
 * complete" is in reality "wait for all to reach an abort-aware rejection",
 * which fires immediately after the signal — not after each subagent's full
 * 10-min internal timeout.
 */
async function settleToNullArray(
  thunks: Array<() => Promise<unknown>>,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const settled = await Promise.allSettled(
    thunks.map((t) => Promise.resolve().then(t)),
  );
  // Use DOMException('AbortError') for consistency with the scheduler's
  // abort path so HOST-side callers seeing this rejection directly can
  // classify it via isAbortError() (utils/errors.ts). NOTE: this name is
  // NOT preserved across the vm boundary — vmAsync (workflow-sandbox.ts)
  // re-throws the script-visible rejection as a fresh vm-realm `new
  // Error(msg)`, and the orchestrator's outer catch then wraps it as
  // WorkflowExecutionError. So isAbortError() at the WorkflowTool layer
  // returns false either way; the DOMException is purely a host-internal
  // consistency choice, not a script-observable one.
  if (signal?.aborted)
    throw new DOMException('Workflow run aborted.', 'AbortError');
  const visitedReasons = new WeakSet<object>();
  const findRunFailureReason = (reason: unknown): unknown | undefined => {
    if (reason === null || typeof reason !== 'object') return undefined;
    if (visitedReasons.has(reason)) return undefined;
    visitedReasons.add(reason);
    try {
      if ((reason as { __wfRunFailure?: unknown }).__wfRunFailure === true) {
        return reason;
      }
      const errors = (reason as { errors?: unknown })?.errors;
      if (!Array.isArray(errors)) return undefined;
      for (const error of errors) {
        const runFailure = findRunFailureReason(error);
        if (runFailure !== undefined) return runFailure;
      }
    } catch {
      return undefined;
    }
    return undefined;
  };
  for (const result of settled) {
    if (result.status !== 'rejected') continue;
    const runFailure = findRunFailureReason(result.reason);
    if (runFailure !== undefined) throw runFailure;
  }
  // Errors-as-data: a rejected thunk becomes null at its index. Log the
  // discarded rejection reason at debug level so operators investigating a
  // workflow that returned unexpected nulls can disambiguate between (a) a
  // dispatch failure (rate limit / model outage), (b) a pipeline stage
  // exception, and (c) a non-JSON-serializable thunk
  // return — all of which surface as the same `null` to the script by
  // design. The log line is the only operator-side signal of which path
  // fired; the contract to the script stays opaque.
  return settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    const reason = r.reason as { message?: unknown };
    debugLogger.warn(
      `Workflow thunk at index ${i} rejected: ${String(reason?.message ?? r.reason)}`,
    );
    return null;
  });
}

/**
 * Build the host-side `parallel(thunks)` impl. Each thunk is a vm-realm
 * function whose agent() calls throttle through the per-run concurrency window
 * at the dispatch layer. A thunk that rejects, or resolves to a non-JSON-
 * serializable value, becomes `null` at its index (errors-as-data). `parallel()`
 * itself rejects when given invalid arguments (non-array / non-function
 * element), when the run is aborted, or when a token/agent-cap or container
 * policy gate refuses a dispatch. The sandbox wrapper revives the result array
 * into the vm realm (per-element JSON round-trip) — this host array never
 * reaches the script directly.
 */
function makeParallelImpl(
  signal: AbortSignal | undefined,
  dependencyContext: AsyncLocalStorage<{ tails: string[] }>,
): (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]> {
  return (thunks) => {
    if (!Array.isArray(thunks)) {
      return Promise.reject(
        new Error(
          'parallel() expects an array of thunks (functions returning promises).',
        ),
      );
    }
    for (const t of thunks) {
      if (typeof t !== 'function') {
        return Promise.reject(
          new Error(
            'parallel() expects an array of functions, not values — wrap each ' +
              'call: parallel([() => agent(...), () => agent(...)]).',
          ),
        );
      }
    }
    const parent = dependencyContext.getStore();
    const inheritedTails = parent?.tails ?? [];
    const branches = thunks.map((thunk) => {
      const store = { tails: [...inheritedTails] };
      return {
        store,
        thunk: () => dependencyContext.run(store, thunk),
      };
    });
    return settleToNullArray(
      branches.map(({ thunk }) => thunk),
      signal,
    ).then((result) => {
      if (parent && branches.length > 0) {
        parent.tails = mergeFanoutTails(
          parent.tails,
          inheritedTails,
          branches.flatMap(({ store }) => store.tails),
        );
      }
      return result;
    });
  };
}

/**
 * Build the host-side `pipeline(items, ...stages)` impl as parallel-of-chains.
 *
 * Each item becomes one chain that runs the stages in sequence — staggered,
 * with NO barrier between stages, so item A can be in stage 3 while item B is
 * still in stage 1. Stage callbacks receive `(prev, item, idx)`; the first
 * stage's `prev` is the item itself. An ordinary stage error, a `null`, or a
 * non-JSON-serializable value drops that item to `null` and skips its remaining
 * stages, leaving other items unaffected. A token/agent-cap refusal rejects
 * the batch. Concurrency is bounded at the dispatch layer, and the result array
 * shares parallel()'s per-element vm-realm revival.
 */
function makePipelineImpl(
  signal: AbortSignal | undefined,
  dependencyContext: AsyncLocalStorage<{ tails: string[] }>,
): (
  items: unknown[],
  ...stages: Array<
    (prev: unknown, item: unknown, idx: number) => Promise<unknown>
  >
) => Promise<unknown[]> {
  return (items, ...stages) => {
    if (!Array.isArray(items)) {
      return Promise.reject(
        new Error(
          'pipeline() expects an array of items as its first argument.',
        ),
      );
    }
    for (const s of stages) {
      if (typeof s !== 'function') {
        return Promise.reject(
          new Error(
            'pipeline() stages must be functions: ' +
              'pipeline(items, item => ..., result => ...).',
          ),
        );
      }
    }
    const parent = dependencyContext.getStore();
    const inheritedTails = parent?.tails ?? [];
    const branches = items.map((item, idx) => {
      const store = { tails: [...inheritedTails] };
      return {
        store,
        thunk: () =>
          dependencyContext.run(store, () =>
            runPipelineChain(item, idx, stages),
          ),
      };
    });
    return settleToNullArray(
      branches.map(({ thunk }) => thunk),
      signal,
    ).then((result) => {
      if (parent && branches.length > 0) {
        parent.tails = mergeFanoutTails(
          parent.tails,
          inheritedTails,
          branches.flatMap(({ store }) => store.tails),
        );
      }
      return result;
    });
  };
}

function mergeFanoutTails(
  currentParentTails: readonly string[],
  inheritedTails: readonly string[],
  branchTails: readonly string[],
): string[] {
  const inherited = new Set(inheritedTails);
  // A dispatching branch always ends on its fresh dispatch id; a branch that
  // never dispatched still carries its inherited seed. Merging that seed back
  // would re-inject ancestor ids as redundant transitive dependsOn edges —
  // unless no branch dispatched at all, where the inherited tails must pass
  // through unchanged (same contract as an empty fan-out).
  const newBranchTails = branchTails.filter((tail) => !inherited.has(tail));
  const merged =
    newBranchTails.length > 0
      ? [
          ...newBranchTails,
          ...currentParentTails.filter((tail) => !inherited.has(tail)),
        ]
      : currentParentTails;
  return Array.from(new Set(merged));
}

/**
 * Run one item through every stage in order. `null` is the universal drop
 * sentinel: a stage that returns `null` (or throws — surfaced as a rejection
 * that the batch maps to `null`) short-circuits the rest of the chain.
 */
async function runPipelineChain(
  item: unknown,
  idx: number,
  stages: Array<
    (prev: unknown, item: unknown, idx: number) => Promise<unknown>
  >,
): Promise<unknown> {
  let prev: unknown = item;
  for (const stage of stages) {
    if (prev === null) break;
    prev = await stage(prev, item, idx);
  }
  return prev;
}

/**
 * Duck-typed message extraction. `instanceof Error` is realm-local; vm-realm
 * Errors raised inside the sandbox are NOT instances of host Error from the
 * orchestrator's perspective, so the standard `err instanceof Error ?
 * err.message : String(err)` pattern produces "Error: msg" via toString().
 * This helper falls back to the .message property regardless of realm.
 */
function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === 'string') return m;
    return String(m);
  }
  return String(err);
}
