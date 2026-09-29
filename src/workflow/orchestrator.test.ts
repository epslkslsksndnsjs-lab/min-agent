/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// T7 (PR #4732 R1): the `vi as vitest` alias diverges from every other
// test file in the repo. Use `vi` directly.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  WorkflowOrchestrator,
  WorkflowExecutionError,
  DEFAULT_MAX_AGENTS_PER_RUN,
  resolveMaxAgentsPerRun,
  resolveConcurrencyLimit,
  resolveSubagentMaxTurns,
  resolveSubagentMaxTimeMinutes,
  DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS,
  DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES,
  WORKFLOW_SUBAGENT_DISALLOWED_TOOLS,
} from './orchestrator.js';
import { WorkflowAgentEventType, type WorkflowEventEmitter } from './events.js';
import { WorkflowDispatchScheduler } from './dispatch-scheduler.js';
import {
  isWorkflowAgentFailedError,
  WorkflowAgentCapExceededError,
  WorkflowAgentFailedError,
} from './agent-failure.js';
import { DISPATCH_AFFECTING_AGENT_OPTS } from './journal.js';
import { SchemaValidator } from './schema-validator.js';
import type { WorkflowOrchestratorEmitter } from './sandbox.js';


describe('WorkflowOrchestrator', () => {
  it('runs a script with injected mock dispatch and returns the script value', async () => {
    const orchestrator = new WorkflowOrchestrator(
      async (prompt) => `mock:${prompt}`,
    );
    const outcome = await orchestrator.run({
      script: `phase("plan");
               const x = await agent("hi", { label: "a" });
               return x;`,
      args: undefined,
    });
    expect(outcome.result).toBe('mock:hi');
    expect(outcome.runId).toMatch(/^wf_[0-9a-f]{16}$/);
    expect(outcome.phases).toEqual(['plan']);
  });

  it('passes args through to the script', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'unused');
    const outcome = await orchestrator.run({
      script: `return args.who`,
      args: { who: 'world' },
    });
    expect(outcome.result).toBe('world');
  });

  // P4: outcome.meta surfaces the extracted `export const meta = {...}`
  // declaration. Null when the script omits it.
  it('outcome.meta is null when the script has no meta declaration', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'unused');
    const outcome = await orchestrator.run({
      script: `return 1`,
      args: undefined,
    });
    expect(outcome.meta).toBeNull();
  });

  it('outcome.meta is the parsed meta when the script declares one', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'unused');
    const outcome = await orchestrator.run({
      script: `export const meta = { name: 'demo', description: 'demo workflow', phases: [{ title: 'plan' }] }
               return 1`,
      args: undefined,
    });
    expect(outcome.meta).toEqual({
      name: 'demo',
      description: 'demo workflow',
      phases: [{ title: 'plan' }],
    });
    expect(outcome.result).toBe(1);
  });

  // P4: a script body that throws still surfaces the meta on the wrapped
  // WorkflowExecutionError so the user-facing display can identify which
  // workflow ran before the body failed.
  it('WorkflowExecutionError carries meta when the body throws AFTER meta parsed', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'unused');
    let caught: unknown;
    try {
      await orchestrator.run({
        script: `export const meta = { name: 'fails', description: 'will throw' }
                 throw new Error("body boom")`,
        args: undefined,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkflowExecutionError);
    expect((caught as WorkflowExecutionError).meta).toEqual({
      name: 'fails',
      description: 'will throw',
    });
  });

  it('surfaces a thrown error from the script', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'unused');
    await expect(
      orchestrator.run({
        script: `throw new Error("boom")`,
        args: undefined,
      }),
    ).rejects.toThrow(/boom/);
  });

  it('runId is stable for the lifetime of a single run call', async () => {
    const captured: string[] = [];
    const orchestrator = new WorkflowOrchestrator(async (prompt) => {
      captured.push(prompt);
      return 'ok';
    });
    const outcome = await orchestrator.run({
      script: `await agent("first"); await agent("second"); return 0;`,
      args: undefined,
    });
    expect(captured).toEqual(['first', 'second']);
    expect(outcome.runId).toMatch(/^wf_[0-9a-f]{16}$/);
  });

  // TST-C1: concurrent runs must produce distinct runIds.
  it('runId is unique across concurrent runs', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'ok');
    const [a, b, c] = await Promise.all([
      orchestrator.run({ script: 'return 1', args: undefined }),
      orchestrator.run({ script: 'return 2', args: undefined }),
      orchestrator.run({ script: 'return 3', args: undefined }),
    ]);
    expect(a.runId).not.toBe(b.runId);
    expect(b.runId).not.toBe(c.runId);
    expect(a.runId).not.toBe(c.runId);
  });

  it('settles an unclassified dispatch rejection to null', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => {
      throw new Error('agent-crashed');
    });
    await expect(
      orchestrator.run({
        script: 'const value = await agent("x"); return value;',
        args: undefined,
      }),
    ).resolves.toMatchObject({ result: null });
  });

  // P4b Round 5 (wenshao): the emitter field on WorkflowRunRequest and
  // its firing sites (sandbox safePhase, sandbox safeLog, orchestrator
  // countedDispatch before + after) are the only channel that keeps the
  // WorkflowRunRegistry record in sync with the live run. If a refactor
  // drops one of these callback sites — or removes the defensive
  // try/catch around `agentCompleted` on the rejection path — the UI
  // would show stale dispatch counts or missing phases with no test
  // catching it. These three tests pin the contract.

  it('emitter callbacks fire in expected order with expected args', async () => {
    const orchestrator = new WorkflowOrchestrator(
      async (prompt) => `mock:${prompt}`,
    );
    const events: Array<{ kind: string; payload: unknown }> = [];
    const emitter = {
      phaseStarted: (title: string) =>
        events.push({ kind: 'phase', payload: title }),
      agentDispatched: (label?: string) =>
        events.push({ kind: 'dispatched', payload: label }),
      agentCompleted: (label?: string, error?: string) =>
        events.push({ kind: 'completed', payload: { label, error } }),
      logAppended: (line: string) =>
        events.push({ kind: 'log', payload: line }),
    };
    const outcome = await orchestrator.run({
      script: `
        phase('Plan');
        log('starting');
        await agent('q1', { label: 'first' });
        phase('Build');
        await agent('q2', { label: 'second' });
        return 'ok';
      `,
      args: undefined,
      emitter,
    });

    expect(outcome.result).toBe('ok');
    expect(outcome.phases).toEqual(['Plan', 'Build']);
    // Event ordering: phase('Plan') → log('starting') → dispatch first →
    // complete first → phase('Build') → dispatch second → complete second.
    // No barriers between sandbox-side emits (phase/log) and dispatch
    // emits — the test only pins the relative ordering across the run,
    // not exact wall-clock interleaving.
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      'phase',
      'log',
      'dispatched',
      'completed',
      'phase',
      'dispatched',
      'completed',
    ]);
    expect(events[0]!.payload).toBe('Plan');
    expect(events[1]!.payload).toBe('starting');
    expect(events[2]!.payload).toBe('first');
    expect(events[3]!.payload).toEqual({ label: 'first', error: undefined });
    expect(events[4]!.payload).toBe('Build');
    expect(events[5]!.payload).toBe('second');
    expect(events[6]!.payload).toEqual({ label: 'second', error: undefined });
  });

  it('agentCompleted carries the error message on dispatch rejection', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => {
      throw new Error('dispatch-boom');
    });
    const completions: Array<{ label?: string; error?: string }> = [];
    const emitter = {
      agentCompleted: (label?: string, error?: string) =>
        completions.push({ label, error }),
    };
    await expect(
      orchestrator.run({
        script: `await agent("x", { label: "doomed" }); return 0;`,
        args: undefined,
        emitter,
      }),
    ).resolves.toMatchObject({ result: 0 });

    expect(completions).toHaveLength(1);
    expect(completions[0]).toEqual({
      label: 'doomed',
      error: 'dispatch-boom',
    });
  });

  it('records dependency tails across sequential, parallel, and pipeline dispatches', async () => {
    const orchestrator = new WorkflowOrchestrator(
      async (prompt) => `mock:${prompt}`,
    );
    const queued: Array<{
      id: string;
      label?: string;
      dependsOn: string[];
    }> = [];

    await orchestrator.run({
      script: `
        phase('Inspect');
        await agent('inspect', { label: 'inspect' });
        phase('Review');
        await parallel([
          () => agent('correctness', { label: 'correctness' }),
          () => agent('architecture', { label: 'architecture' }),
        ]);
        phase('Fix');
        await pipeline(
          ['a', 'b'],
          (_prev, item) => agent('verify ' + item, { label: 'verify-' + item }),
          (_prev, item) => agent('fix ' + item, { label: 'fix-' + item }),
        );
      `,
      args: undefined,
      emitter: {
        dispatchQueued: (event) => queued.push(event),
      },
    });

    const ids = new Map(queued.map((event) => [event.label, event.id]));
    const dependencies = (label: string) =>
      queued
        .find((event) => event.label === label)!
        .dependsOn.map((id) => queued.find((event) => event.id === id)!.label);

    expect(dependencies('inspect')).toEqual([]);
    expect(dependencies('correctness')).toEqual(['inspect']);
    expect(dependencies('architecture')).toEqual(['inspect']);
    expect(dependencies('verify-a')).toEqual(['correctness', 'architecture']);
    expect(dependencies('verify-b')).toEqual(['correctness', 'architecture']);
    expect(dependencies('fix-a')).toEqual(['verify-a']);
    expect(dependencies('fix-b')).toEqual(['verify-b']);
    expect(new Set(ids.values()).size).toBe(7);
  });

  it.each(['parallel', 'pipeline'] as const)(
    'preserves newer parent dependencies when an un-awaited %s settles',
    async (kind) => {
      const queued: Array<{
        id: string;
        label?: string;
        dependsOn: string[];
      }> = [];
      const orchestrator = new WorkflowOrchestrator(
        async (prompt) => `${prompt}-done`,
      );
      const fanout =
        kind === 'parallel'
          ? `parallel([() => agent('fanout', { label: 'fanout' })])`
          : `pipeline([0], () => agent('fanout', { label: 'fanout' }))`;

      await orchestrator.run({
        script: `
          const pending = ${fanout};
          await agent('parent', { label: 'parent' });
          await pending;
          await agent('joined', { label: 'joined' });
        `,
        args: undefined,
        scheduler: new WorkflowDispatchScheduler(2),
        emitter: {
          dispatchQueued: (event) => queued.push(event),
        },
      });

      const labelsById = new Map(
        queued.map((event) => [event.id, event.label]),
      );
      const joined = queued.find((event) => event.label === 'joined');
      expect(joined?.dependsOn.map((id) => labelsById.get(id)).sort()).toEqual([
        'fanout',
        'parent',
      ]);
    },
  );

  it('emits queued, started, and settled lifecycle events for one dispatch', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'done');
    const events: string[] = [];

    await orchestrator.run({
      script: `await agent('inspect', { label: 'scope' });`,
      args: undefined,
      emitter: {
        dispatchQueued: ({ id, label }) => events.push(`queued:${id}:${label}`),
        dispatchStarted: (id) => events.push(`started:${id}`),
        dispatchSettled: (id, error) =>
          events.push(`settled:${id}:${error ?? 'ok'}`),
      },
    });

    expect(events).toHaveLength(3);
    const dispatchId = events[0]!.split(':')[1];
    expect(events).toEqual([
      `queued:${dispatchId}:scope`,
      `started:${dispatchId}`,
      `settled:${dispatchId}:ok`,
    ]);
  });

  it('passes the recorded dispatch id into the production dispatch boundary', async () => {
    const receivedIds: Array<string | undefined> = [];
    const orchestrator = new WorkflowOrchestrator(
      async (_prompt, _opts, dispatchId) => {
        receivedIds.push(dispatchId);
        return 'done';
      },
    );

    await orchestrator.run({
      script: `await agent('inspect', { label: 'scope' });`,
      args: undefined,
    });

    expect(receivedIds).toEqual(['dispatch-1']);
  });

  it('preserves the dependency tail across empty parallel helpers', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'done');
    const queued: Array<{
      id: string;
      label?: string;
      dependsOn: string[];
    }> = [];

    await orchestrator.run({
      script: `
        await agent('before', { label: 'before' });
        await parallel([]);
        await agent('after parallel', { label: 'after-parallel' });
        await pipeline([], () => agent('unused'));
        await agent('after pipeline', { label: 'after-pipeline' });
      `,
      args: undefined,
      emitter: {
        dispatchQueued: (event) => queued.push(event),
      },
    });

    const labelById = new Map(
      queued.map((event) => [event.id, event.label ?? event.id]),
    );
    const dependsOn = (label: string) =>
      queued
        .find((event) => event.label === label)!
        .dependsOn.map((id) => labelById.get(id));

    expect(dependsOn('after-parallel')).toEqual(['before']);
    expect(dependsOn('after-pipeline')).toEqual(['after-parallel']);
  });

  it('does not re-inject inherited tails from a fan-out branch that never dispatches', async () => {
    const orchestrator = new WorkflowOrchestrator(
      async (prompt) => `${prompt}`,
    );
    const queued: Array<{
      id: string;
      label?: string;
      dependsOn: string[];
    }> = [];

    await orchestrator.run({
      script: `
        await agent('a', { label: 'a' });
        const pending = parallel([
          () => agent('b', { label: 'b' }),
          () => 42,
        ]);
        await agent('m', { label: 'm' });
        await pending;
        await agent('z', { label: 'z' });
      `,
      args: undefined,
      scheduler: new WorkflowDispatchScheduler(2),
      emitter: {
        dispatchQueued: (event) => queued.push(event),
      },
    });

    const labelsById = new Map(queued.map((event) => [event.id, event.label]));
    const dependsOn = (label: string) =>
      queued
        .find((event) => event.label === label)!
        .dependsOn.map((id) => labelsById.get(id))
        .sort();

    expect(dependsOn('b')).toEqual(['a']);
    expect(dependsOn('m')).toEqual(['a']);
    // The no-dispatch branch must not re-inject the ancestor 'a' edge.
    expect(dependsOn('z')).toEqual(['b', 'm']);
  });

  it('keeps inherited tails when no fan-out branch issues a dispatch', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'done');
    const queued: Array<{
      id: string;
      label?: string;
      dependsOn: string[];
    }> = [];

    await orchestrator.run({
      script: `
        await agent('before', { label: 'before' });
        await parallel([() => 1, () => 2]);
        await agent('after', { label: 'after' });
      `,
      args: undefined,
      emitter: {
        dispatchQueued: (event) => queued.push(event),
      },
    });

    const labelById = new Map(
      queued.map((event) => [event.id, event.label ?? event.id]),
    );
    const after = queued.find((event) => event.label === 'after');
    expect(after?.dependsOn.map((id) => labelById.get(id))).toEqual(['before']);
  });

  it('emitter subscriber errors do not break the run (defensive try/catch)', async () => {
    const orchestrator = new WorkflowOrchestrator(
      async (prompt) => `mock:${prompt}`,
    );
    // Every callback throws — should be swallowed so the orchestration
    // still completes. Without the defensive try/catch around each emit
    // site, the first thrown subscriber error would surface as the run
    // failure even though the script body is fine.
    const emitter = {
      phaseStarted: () => {
        throw new Error('phase-subscriber-boom');
      },
      agentDispatched: () => {
        throw new Error('dispatched-subscriber-boom');
      },
      agentCompleted: () => {
        throw new Error('completed-subscriber-boom');
      },
      logAppended: () => {
        throw new Error('log-subscriber-boom');
      },
      dispatchQueued: () => {
        throw new Error('queued-subscriber-boom');
      },
      dispatchStarted: () => {
        throw new Error('started-subscriber-boom');
      },
      dispatchSettled: () => {
        throw new Error('settled-subscriber-boom');
      },
    };
    const outcome = await orchestrator.run({
      script: `
        phase('Plan');
        log('hello');
        const a = await agent('q1');
        return a;
      `,
      args: undefined,
      emitter,
    });
    expect(outcome.result).toBe('mock:q1');
    expect(outcome.phases).toEqual(['Plan']);
  });

  // ── P5: budget gate via WorkflowRunRequest.budget ─────────────────────

  it('P5: budget gate refuses to dispatch once budget is exhausted', async () => {
    const { WorkflowBudgetImpl } = await import('./budget.js');
    const budget = new WorkflowBudgetImpl(1000);
    // Pre-burn the budget so the first agent() call lands over-cap.
    budget.recordSpent(1000);

    let dispatchCalls = 0;
    const orchestrator = new WorkflowOrchestrator(async () => {
      dispatchCalls += 1;
      return 'never reached';
    });
    let caught: unknown;
    try {
      await orchestrator.run({
        script: `await agent('q1'); return 0;`,
        args: undefined,
        budget,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    // Cross-realm: the sandbox wraps the host error in a vm-realm Error
    // (per T1/T8/T14 defense). The dispatch is never invoked because the
    // gate short-circuits before scheduler.run.
    expect(String(caught)).toContain('token budget exceeded');
    expect(String(caught)).toContain('1000');
    expect(dispatchCalls).toBe(0);
  });

  it('P5: budget gate stops further dispatches mid-run on overshoot', async () => {
    const { WorkflowBudgetImpl } = await import('./budget.js');
    const budget = new WorkflowBudgetImpl(100);
    // Each dispatch burns 60 tokens; the budget should run out after 2.
    let dispatchCalls = 0;
    const orchestrator = new WorkflowOrchestrator(async () => {
      dispatchCalls += 1;
      budget.recordSpent(60);
      return 'ok';
    });
    let caught: unknown;
    try {
      await orchestrator.run({
        script: `await agent('q1'); await agent('q2'); await agent('q3'); return 'done';`,
        args: undefined,
        budget,
      });
    } catch (e) {
      caught = e;
    }
    // q1 = 60/100, q2 = 120/100 (overshoot), q3 = gate refuses
    expect(dispatchCalls).toBe(2);
    expect(String(caught)).toContain('token budget exceeded');
    expect(budget.spent()).toBe(120);
  });

  it('P5: budget.total === null (no cap) — gate never fires', async () => {
    const { WorkflowBudgetImpl } = await import('./budget.js');
    const budget = new WorkflowBudgetImpl(null);
    let dispatchCalls = 0;
    const orchestrator = new WorkflowOrchestrator(async () => {
      dispatchCalls += 1;
      budget.recordSpent(1_000_000); // each agent burns 1M tokens
      return 'ok';
    });
    const outcome = await orchestrator.run({
      script: `await agent('q1'); await agent('q2'); await agent('q3'); return 'done';`,
      args: undefined,
      budget,
    });
    expect(outcome.result).toBe('done');
    expect(dispatchCalls).toBe(3);
    expect(budget.spent()).toBe(3_000_000);
    expect(budget.remaining()).toBe(Infinity);
  });

  it('P5: no budget passed (legacy callers) — gate never fires', async () => {
    let dispatchCalls = 0;
    const orchestrator = new WorkflowOrchestrator(async () => {
      dispatchCalls += 1;
      return 'ok';
    });
    const outcome = await orchestrator.run({
      script: `await agent('q1'); await agent('q2'); return 'done';`,
      args: undefined,
    });
    expect(outcome.result).toBe('done');
    expect(dispatchCalls).toBe(2);
  });

  it('P5 R1 #2: parallel-batch overshoot is bounded by the in-scheduler re-check', async () => {
    // R1 Critical #2 — without the slot-acquire gate, a parallel() of N
    // thunks queues them all in one microtask burst with spent=0, so the
    // entry gate passes for every queued dispatch and the budget
    // overshoots by up to `(N-1) × per_dispatch_tokens`.
    //
    // With the slot-acquire re-check, the gate observes budget mutations
    // from already-completed in-flight dispatches at slot-acquire time, so
    // queued thunks that arrive AFTER the budget is busted are refused and
    // the run-level limit rejects the batch.
    const { WorkflowBudgetImpl } = await import('./budget.js');
    const budget = new WorkflowBudgetImpl(100);
    const scheduler = new WorkflowDispatchScheduler(1);
    let dispatchCalls = 0;
    let dispatched = 0;
    let completed = 0;
    const orchestrator = new WorkflowOrchestrator(async () => {
      dispatchCalls += 1;
      budget.recordSpent(40); // 3 successful dispatches saturate the cap
      return 'ok';
    });
    // 10 thunks — far more than the budget (100 / 40 ≈ 3 successful).
    // The slot-acquire gate must reject the rest BEFORE this.dispatch
    // runs, so `dispatchCalls` is exactly 3, NOT 10.
    await expect(
      orchestrator.run({
        script: `const results = await parallel(Array.from({length: 10}, () => () => agent('q'))); return results;`,
        args: undefined,
        budget,
        scheduler,
        emitter: {
          agentDispatched: () => dispatched++,
          agentCompleted: () => completed++,
        },
      }),
    ).rejects.toThrow(/token budget exceeded/);
    // ASSERT it doesn't reach 10 (the without-fix overshoot value):
    // with the scheduler pinned to limit 1, slot-acquire re-checks are
    // serialized, so exactly 3 dispatches pass (spent 0/40/80 at acquire;
    // cap 100).
    expect(dispatchCalls).toBe(3);
    expect(dispatched).toBe(10);
    expect(completed).toBe(dispatched);
  });

  it('reports respawns only after the slot-acquire budget gate admits them', async () => {
    const { WorkflowBudgetImpl } = await import('./budget.js');
    const { buildReplay, deriveAgentKey, deriveArgsSeed } = await import(
      './journal.js'
    );
    const budget = new WorkflowBudgetImpl(100);
    const scheduler = new WorkflowDispatchScheduler(1);
    let dispatchCalls = 0;
    const orchestrator = new WorkflowOrchestrator(async () => {
      dispatchCalls += 1;
      budget.recordSpent(40);
      return 'ok';
    });
    let key = deriveArgsSeed(undefined);
    const priorEntries: Array<import('./journal.js').JournalEntry> =
      [];
    for (let i = 0; i < 10; i++) {
      key = deriveAgentKey(key, 'q', {});
      priorEntries.push({
        type: 'started',
        key,
        agentId: String(i + 1),
      });
    }
    const { journal, entries } = memoryJournal();
    const respawns: string[] = [];

    await expect(
      orchestrator.run({
        script: `return await parallel(Array.from({length: 10}, () => () => agent('q')));`,
        args: undefined,
        budget,
        scheduler,
        journal,
        resumeReplay: buildReplay(priorEntries),
        emitter: { resumeRespawn: (line) => respawns.push(line) },
      }),
    ).rejects.toThrow(/token budget exceeded/);

    expect(dispatchCalls).toBe(3);
    expect(entries.filter((entry) => entry.type === 'started')).toHaveLength(3);
    expect(respawns).toHaveLength(3);
  });

  it('does not invent prior attempts across repeated budget-limited resumes', async () => {
    const { WorkflowBudgetImpl } = await import('./budget.js');
    const { buildReplay } = await import('./journal.js');
    const { journal, entries } = memoryJournal();
    const script = `return await parallel(Array.from({length: 10}, (_, i) => () => agent('slot' + i)));`;
    for (let round = 0; round < 4; round++) {
      const budget = new WorkflowBudgetImpl(100);
      const dispatched: string[] = [];
      const respawns: string[] = [];
      const orchestrator = new WorkflowOrchestrator(async (prompt) => {
        dispatched.push(prompt);
        budget.recordSpent(40);
        return prompt;
      });
      const run = orchestrator.run({
        script,
        args: undefined,
        budget,
        scheduler: new WorkflowDispatchScheduler(1),
        journal,
        resumeReplay: buildReplay(entries),
        emitter: { resumeRespawn: (line) => respawns.push(line) },
      });
      if (round < 3) {
        await expect(run).rejects.toThrow(/token budget exceeded/);
      } else {
        await expect(run).resolves.toMatchObject({
          result: Array.from({ length: 10 }, (_, i) => `slot${i}`),
        });
      }
      expect(dispatched).toEqual(
        Array.from(
          { length: Math.min(3, 10 - round * 3) },
          (_, i) => `slot${round * 3 + i}`,
        ),
      );
      expect(respawns).toEqual([]);
      const starts = entries.filter((entry) => entry.type === 'started');
      expect(starts).toHaveLength(Math.min(10, (round + 1) * 3));
      expect(entries.filter((entry) => entry.type === 'result')).toHaveLength(
        starts.length,
      );
      expect(entries.filter((entry) => entry.type === 'failed')).toEqual([]);
    }
  });

  // R1 #4 fix landed in production code (debugLogger.warn at both gate
  // sites); no dedicated test — debugLogger has its own enable/disable
  // gating and a spy here would be brittle. Manual verification path:
  // run with DEBUG=WORKFLOW=1 and trigger a budget-exhausted dispatch.

  // A turn target is gated on the whole turn's spend — the main loop and
  // every other run included — while the registry keeps mirroring this run
  // alone: its own spend, and no cap, since the target is not this run's.
  it('gates a turn target on the turn spend and reports only the run to the registry', async () => {
    const { WorkflowBudgetImpl } = await import('./budget.js');
    let turnSpent = 499_999;
    const budget = new WorkflowBudgetImpl(500_000, {
      source: 'directive',
      turnSpent: () => turnSpent,
    });
    let dispatchCalls = 0;
    const orchestrator = new WorkflowOrchestrator(async () => {
      dispatchCalls += 1;
      // Tokens spent elsewhere in the turn while this agent ran.
      turnSpent += 10;
      return 'ok';
    });
    const budgetUpdates: Array<{ spent: number; total: number | null }> = [];
    const caught = await orchestrator
      .run({
        script: `await agent('q1'); await agent('q2'); return 'done';`,
        args: undefined,
        budget,
        emitter: {
          budgetUpdated: (spent, total) => budgetUpdates.push({ spent, total }),
        },
      })
      .catch((e: unknown) => e);

    expect(dispatchCalls).toBe(1);
    expect(String(caught)).toContain(
      'token budget exceeded (500009 / 500000 output tokens)',
    );
    expect(budget.runSpent()).toBe(0);
    expect(budgetUpdates).toEqual([{ spent: 0, total: null }]);
  });

  // ── P5 T4: budgetUpdated emitter event ─────────────────────────────────

  it('P5 T4: budgetUpdated fires after each successful completion with cumulative spent + total', async () => {
    const { WorkflowBudgetImpl } = await import('./budget.js');
    const budget = new WorkflowBudgetImpl(1000);
    const orchestrator = new WorkflowOrchestrator(async (prompt) => {
      // Simulate the production-dispatch onTokens callback writing into
      // the budget BEFORE the orchestrator's then() re-snapshots.
      budget.recordSpent(prompt === 'q1' ? 150 : 250);
      return 'ok';
    });
    const budgetUpdates: Array<{ spent: number; total: number | null }> = [];
    const emitter = {
      budgetUpdated: (spent: number, total: number | null) =>
        budgetUpdates.push({ spent, total }),
    };
    await orchestrator.run({
      script: `await agent('q1'); await agent('q2'); return 'done';`,
      args: undefined,
      budget,
      emitter,
    });
    expect(budgetUpdates).toEqual([
      { spent: 150, total: 1000 },
      { spent: 400, total: 1000 },
    ]);
  });

  it('P5 T4: budgetUpdated does NOT fire when no budget is passed', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'ok');
    const budgetUpdates: number[] = [];
    const emitter = {
      budgetUpdated: (spent: number) => budgetUpdates.push(spent),
    };
    await orchestrator.run({
      script: `await agent('q1'); return 'done';`,
      args: undefined,
      emitter,
      // budget intentionally omitted
    });
    expect(budgetUpdates).toEqual([]);
  });

  it('P5 R3 #1: budgetUpdated DOES fire on dispatch rejection (so UI/registry see the burn-then-fail spend)', async () => {
    // R3 #1 (bot): the production dispatch's reportTokens runs in a
    // `finally` (R3 #6), so `budget.spent()` advances even when
    // `subagent.execute()` throws. If the error arm of `countedDispatch`
    // does NOT fire `budgetUpdated`, the registry's `tokensSpent` /
    // `perPhaseTokens` never see those tokens — divergence between
    // `budget.spent()` (host) and `entry.tokensSpent` (UI). Worse,
    // R2 #12 dropped `safeEmitUpdate` from `agentCompleted` and made
    // `budgetUpdated` the sole UI driver, so dispatch errors produce
    // ZERO UI re-renders unless `budgetUpdated` fires on the error
    // arm too.
    const { WorkflowBudgetImpl } = await import('./budget.js');
    const budget = new WorkflowBudgetImpl(1000);
    const orchestrator = new WorkflowOrchestrator(async () => {
      // Mirror the production reportTokens-in-finally semantics:
      // record tokens BEFORE the throw, exactly as production does.
      budget.recordSpent(150);
      throw new Error('dispatch-boom');
    });
    const budgetUpdates: Array<{ spent: number; total: number | null }> = [];
    const completions: Array<{ label?: string; error?: string }> = [];
    const emitter = {
      budgetUpdated: (spent: number, total: number | null) =>
        budgetUpdates.push({ spent, total }),
      agentCompleted: (label?: string, error?: string) =>
        completions.push({ label, error }),
    };
    await expect(
      orchestrator.run({
        script: `await agent('q1'); return 'done';`,
        args: undefined,
        budget,
        emitter,
      }),
    ).resolves.toMatchObject({ result: 'done' });
    expect(completions).toHaveLength(1);
    expect(completions[0]?.error).toBe('dispatch-boom');
    // R3 #1 contract: error arm now fires budgetUpdated with the
    // cumulative spent at throw time, so the registry mirrors the
    // burn that the failed dispatch incurred.
    expect(budgetUpdates).toEqual([{ spent: 150, total: 1000 }]);
  });

  it('P5 R3 #7: budget rejection does NOT consume agent-cap slots (correct terminal error after exhaustion)', async () => {
    // wenshao R3 #7: if `agentCount += 1` runs before the budget gate,
    // every budget-rejected call still increments agentCount and the
    // SUBSEQUENT call eventually trips `agentCount > maxAgents` —
    // surfacing the wrong terminal error ("exceeded the maximum of N
    // agent() calls per run") when the real cause is budget exhaustion.
    const { WorkflowBudgetImpl } = await import('./budget.js');
    const budget = new WorkflowBudgetImpl(100);
    budget.recordSpent(100); // pre-bust the budget so every dispatch rejects
    let dispatchCalls = 0;
    const orchestrator = new WorkflowOrchestrator(async () => {
      dispatchCalls += 1;
      return 'never';
    });
    let caught: unknown;
    try {
      // Loop the script so we accumulate many budget rejections, well
      // past `maxAgents` had the old ordering been in place.
      // try/catch in script so loop continues despite per-call throws.
      await orchestrator.run({
        script: `
          let lastErr = null;
          for (let i = 0; i < 1100; i++) {
            try { await agent('q' + i); } catch (e) { lastErr = e.message; }
          }
          return lastErr;
        `,
        args: undefined,
        budget,
      });
    } catch (e) {
      caught = e;
    }
    // Real production dispatch is never called.
    expect(dispatchCalls).toBe(0);
    // R3 #7 contract: the script saw budget-exceeded errors, NOT
    // agent-count-exceeded errors. The latter would indicate the old
    // ordering still applies.
    // The orchestrator wraps script-thrown errors in
    // WorkflowExecutionError; the script swallowed each per-call throw
    // and returned the last message, so the run COMPLETED successfully.
    expect(caught).toBeUndefined();
  });

  it('P5 R3 #1: budgetUpdated does NOT fire when no budget passed AND dispatch rejects', async () => {
    // Budget-less callers must not get spurious budgetUpdated events
    // — the orchestrator's `if (budget)` gate covers both the success
    // and error arms.
    const orchestrator = new WorkflowOrchestrator(async () => {
      throw new Error('boom');
    });
    const budgetUpdates: number[] = [];
    const emitter = {
      budgetUpdated: (spent: number) => budgetUpdates.push(spent),
    };
    await expect(
      orchestrator.run({
        script: `await agent('q1'); return 'done';`,
        args: undefined,
        emitter,
        // budget intentionally omitted
      }),
    ).resolves.toMatchObject({ result: 'done' });
    expect(budgetUpdates).toEqual([]);
  });

  it('P5 T4: budgetUpdated subscriber error does not break the run', async () => {
    const { WorkflowBudgetImpl } = await import('./budget.js');
    const budget = new WorkflowBudgetImpl(1000);
    const orchestrator = new WorkflowOrchestrator(async () => {
      budget.recordSpent(100);
      return 'ok';
    });
    const emitter = {
      budgetUpdated: () => {
        throw new Error('budget-subscriber-boom');
      },
    };
    const outcome = await orchestrator.run({
      script: `await agent('q1'); return 'done';`,
      args: undefined,
      budget,
      emitter,
    });
    expect(outcome.result).toBe('done');
  });

  // ── P-nested: workflow() global ───────────────────────────────────────

  it('P-nested: workflow(name) resolves via injected resolver and returns nested result', async () => {
    const orchestrator = new WorkflowOrchestrator(
      async (prompt) => `agent:${prompt}`,
    );
    const resolveSavedWorkflow = async (
      ref: string | { scriptPath: string },
    ) => {
      expect(ref).toBe('child');
      return {
        script: `return 'nested-' + (await agent('inner'));`,
        name: 'child',
      };
    };
    const outcome = await orchestrator.run({
      script: `const r = await workflow('child'); return 'parent:' + r;`,
      args: undefined,
      resolveSavedWorkflow,
    });
    expect(outcome.result).toBe('parent:nested-agent:inner');
  });

  it('does not mirror an unconsumed agent failure after it settles to null', async () => {
    const orchestrator = new WorkflowOrchestrator(() =>
      Promise.reject(new Error('nested-boom')),
    );
    const appendedLogs: string[] = [];
    const outcome = await orchestrator.run({
      script: `return 'parent:' + (await workflow('child'));`,
      args: undefined,
      emitter: {
        logAppended: (line) => appendedLogs.push(line),
      },
      resolveSavedWorkflow: async () => ({
        // The dispatch trace and failures list carry the failure. The agent
        // promise resolves to null, so it is not an unhandled rejection.
        script: `agent('x'); return 'child-done';`,
      }),
    });
    expect(outcome.result).toBe('parent:child-done');
    expect(outcome.logs).toEqual([]);
    expect(appendedLogs).toEqual([]);
  });

  it('keeps a nested agent result behind the shared pause gate', async () => {
    let finishDispatch: ((value: string) => void) | undefined;
    const scheduler = new WorkflowDispatchScheduler(1);
    const orchestrator = new WorkflowOrchestrator(
      () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    );
    const run = orchestrator.run({
      script: `return await workflow('child');`,
      args: undefined,
      scheduler,
      resolveSavedWorkflow: async () => ({
        script: `return await agent('inner');`,
      }),
    });
    await vi.waitFor(() => expect(finishDispatch).toBeDefined());

    scheduler.pause();
    finishDispatch?.('nested result');
    await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));
    let settled = false;
    // Two arms: under a rejection-shaped gate regression the promise
    // rejects, and a fulfillment-only attach would escape as an
    // unhandledRejection instead of failing the intended assertion.
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // Flush all microtasks + a timer tick so the negative check
    // distinguishes the pause gate from a gate-less resolve
    // (which settles in a few microtasks without one).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    scheduler.resume();
    await expect(run).resolves.toMatchObject({ result: 'nested result' });
  });

  // R12 (doudouOUC): the budget gate and agent cap used to return bare
  // Promise.reject, bypassing the pause gate — a paused run whose script
  // caught the rejection kept executing. Entry-gate rejections must
  // settle through the same gate as every other settlement path.
  it('holds a budget-gate rejection behind the pause gate until resume', async () => {
    const { WorkflowBudgetImpl } = await import('./budget.js');
    const budget = new WorkflowBudgetImpl(100);
    budget.recordSpent(100); // already over cap at entry
    const scheduler = new WorkflowDispatchScheduler(1);
    scheduler.pause();
    expect(scheduler.snapshot().state).toBe('paused');

    let dispatchCalls = 0;
    const orchestrator = new WorkflowOrchestrator(async () => {
      dispatchCalls += 1;
      return 'unused';
    });
    const run = orchestrator.run({
      script: `
        let msg = 'none';
        try { await agent('over-budget'); } catch (e) { msg = e.message; }
        return msg;
      `,
      args: undefined,
      budget,
      scheduler,
    });

    let settled = false;
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // Flush microtasks + a timer tick: without the gate the rejection
    // settles in a few microtasks, so a still-pending run after a tick
    // proves the pause gate held it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    scheduler.resume();
    await expect(run).resolves.toMatchObject({
      result: expect.stringContaining('token budget exceeded'),
    });
    expect(dispatchCalls).toBe(0);
  });

  it('holds an agent-cap rejection behind the pause gate until resume', async () => {
    const prev = process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'];
    process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'] = '1';
    try {
      const scheduler = new WorkflowDispatchScheduler(1);
      scheduler.pause();
      expect(scheduler.snapshot().state).toBe('paused');

      let dispatchCalls = 0;
      const orchestrator = new WorkflowOrchestrator(async () => {
        dispatchCalls += 1;
        return 'ok';
      });
      const run = orchestrator.run({
        script: `
          const p = agent('first');
          let msg = 'none';
          try { await agent('second'); } catch (e) { msg = e.message; }
          return msg;
        `,
        args: undefined,
        scheduler,
      });

      let settled = false;
      void run.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);

      scheduler.resume();
      await expect(run).resolves.toMatchObject({
        result: expect.stringMatching(/exceeded the maximum of 1 agent/),
      });
      // 'first' passed the cap and dispatched on resume; 'second' never did.
      await vi.waitFor(() => expect(dispatchCalls).toBe(1));
    } finally {
      if (prev === undefined)
        delete process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'];
      else process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'] = prev;
    }
  });

  it('preserves an entry-gate rejection when cancellation aborts its pause gate', async () => {
    // Mirrors the dispatch-error variant: abort rejects the gate waiter,
    // and the reject arm must still surface the real entry-gate error.
    const { WorkflowBudgetImpl } = await import('./budget.js');
    const budget = new WorkflowBudgetImpl(100);
    budget.recordSpent(100);
    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    scheduler.pause();
    expect(scheduler.snapshot().state).toBe('paused');

    const orchestrator = new WorkflowOrchestrator(async () => 'unused');
    const run = orchestrator.run({
      script: `
        let msg = 'none';
        try { await agent('over-budget'); } catch (e) { msg = e.message; }
        return msg;
      `,
      args: undefined,
      budget,
      scheduler,
    });

    // Mirror the sibling hold tests: a bare Promise.reject regression
    // settles the run during this wait, and abort() then finds no
    // waiters — the unsettled assertion is what pins the gate.
    let settled = false;
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    controller.abort();

    await expect(run).resolves.toMatchObject({
      result: expect.stringContaining('token budget exceeded'),
    });
  });

  it('P-nested: nested args are passed to the child script', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'unused');
    const resolveSavedWorkflow = async () => ({
      script: `return args.x * 2;`,
    });
    const outcome = await orchestrator.run({
      script: `return await workflow('child', { x: 21 });`,
      args: undefined,
      resolveSavedWorkflow,
    });
    expect(outcome.result).toBe(42);
  });

  it('P-nested: nested agents share the parent agent-count cap', async () => {
    // Cap is read from env; set a tiny cap so parent(1) + nested(2) trips it.
    const prev = process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'];
    process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'] = '2';
    try {
      let dispatchCalls = 0;
      const orchestrator = new WorkflowOrchestrator(async () => {
        dispatchCalls += 1;
        return 'ok';
      });
      const resolveSavedWorkflow = async () => ({
        // nested fires 2 agents; with parent's 1 already spent and cap=2,
        // the 2nd nested agent (3rd overall) must throw the cap error.
        script: `await agent('n1'); await agent('n2'); return 'done';`,
      });
      let caught: unknown;
      try {
        await orchestrator.run({
          script: `await agent('p1'); return await workflow('child');`,
          args: undefined,
          resolveSavedWorkflow,
        });
      } catch (e) {
        caught = e;
      }
      // parent p1 (1) + nested n1 (2) pass; nested n2 (3) trips the cap.
      expect(dispatchCalls).toBe(2);
      expect(String(caught)).toMatch(/exceeded the maximum of 2 agent/);
    } finally {
      if (prev === undefined)
        delete process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'];
      else process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'] = prev;
    }
  });

  it('P-nested: nested agents share the parent token budget', async () => {
    const { WorkflowBudgetImpl } = await import('./budget.js');
    const budget = new WorkflowBudgetImpl(100);
    const orchestrator = new WorkflowOrchestrator(async () => {
      budget.recordSpent(60); // each agent burns 60 → 2 agents = 120 > 100
      return 'ok';
    });
    const resolveSavedWorkflow = async () => ({
      script: `await agent('n1'); await agent('n2'); return 'done';`,
    });
    let caught: unknown;
    try {
      await orchestrator.run({
        script: `await agent('p1'); return await workflow('child');`,
        args: undefined,
        budget,
        resolveSavedWorkflow,
      });
    } catch (e) {
      caught = e;
    }
    // parent p1 spends 60; nested n1 spends 60 (total 120); nested n2 gated.
    expect(String(caught)).toMatch(/token budget exceeded/);
    expect(budget.spent()).toBe(120);
  });

  it('P-nested: single-level limit — a nested workflow() call throws', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'ok');
    const resolveSavedWorkflow = async () => ({
      // The nested script tries to nest again — must throw.
      script: `return await workflow('grandchild');`,
    });
    let caught: unknown;
    try {
      await orchestrator.run({
        script: `return await workflow('child');`,
        args: undefined,
        resolveSavedWorkflow,
      });
    } catch (e) {
      caught = e;
    }
    expect(String(caught)).toMatch(/workflow\(\) is unavailable here/);
    expect(String(caught)).toMatch(/single level/);
  });

  it('P-nested: workflow() throws when no resolver is wired', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'ok');
    let caught: unknown;
    try {
      await orchestrator.run({
        script: `return await workflow('child');`,
        args: undefined,
        // resolveSavedWorkflow omitted
      });
    } catch (e) {
      caught = e;
    }
    expect(String(caught)).toMatch(/workflow\(\) is unavailable here/);
  });

  it('P-nested: resolver rejection (workflow not found) surfaces to the parent script', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'ok');
    const resolveSavedWorkflow = async () => {
      throw new Error(`workflow('child'): no workflow with that name.`);
    };
    const outcome = await orchestrator.run({
      script: `try { await workflow('child'); return 'no-throw'; }
               catch (e) { return 'caught:' + e.message; }`,
      args: undefined,
      resolveSavedWorkflow,
    });
    expect(outcome.result).toMatch(/caught:.*no workflow with that name/);
  });

  // ── P6: resume journal ────────────────────────────────────────────────

  it('P6: a normal run journals a started+result per agent() call', async () => {
    const { buildReplay } = await import('./journal.js');
    const entries: Array<import('./journal.js').JournalEntry> = [];
    const journal = {
      path: 'mem',
      retainReplayPrefix: async () => {},
      append: (e: import('./journal.js').JournalEntry) => {
        entries.push(e);
        return Promise.resolve();
      },
      load: () => Promise.resolve(buildReplay(entries)),
    } as unknown as import('./journal.js').WorkflowJournal;

    const orchestrator = new WorkflowOrchestrator(
      async (prompt) => `r:${prompt}`,
    );
    await orchestrator.run({
      script: `await agent('a'); await agent('b'); return 'done';`,
      args: undefined,
      journal,
    });
    // 2 agents → 2 started + 2 result.
    expect(entries.filter((e) => e.type === 'started')).toHaveLength(2);
    const results = entries.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect((results[0] as { result: unknown }).result).toBe('r:a');
    expect((results[1] as { result: unknown }).result).toBe('r:b');
  });

  // The boundary check runs before deriveAgentKey: hash.update() throws an
  // opaque ERR_INVALID_ARG_TYPE for a non-string prompt, which would
  // preempt the dispatch's descriptive error on the journaled path.
  it('P6: rejects an invalid prompt before journal key derivation', async () => {
    const entries: Array<import('./journal.js').JournalEntry> = [];
    const journal = {
      append: (e: import('./journal.js').JournalEntry) => {
        entries.push(e);
        return Promise.resolve();
      },
    } as unknown as import('./journal.js').WorkflowJournal;
    const orchestrator = new WorkflowOrchestrator(
      async (prompt) => `r:${prompt}`,
    );
    await expect(
      orchestrator.run({
        script: `return await agent(42);`,
        args: undefined,
        journal,
      }),
    ).rejects.toThrow(/non-empty string prompt/);
    // The mis-call consumes nothing: no started marker, no result line.
    expect(entries).toHaveLength(0);
  });

  // ── Agent-level failures settle to null ───────────────────────────────
  //
  // A sequential `await agent()` used to throw for the same outcome a
  // `parallel()` slot turned into `null`, so one broken agent ended a
  // sequential script and merely dented a fan-out. These pin the two shapes
  // to the same contract, and pin what the journal records either way.

  function memoryJournal(): {
    journal: import('./journal.js').WorkflowJournal;
    entries: Array<import('./journal.js').JournalEntry>;
  } {
    const entries: Array<import('./journal.js').JournalEntry> = [];
    const journal = {
      path: 'mem',
      retainReplayPrefix: async (keys: ReadonlySet<string>) => {
        const kept = entries.filter(
          (entry) => entry.type !== 'result' || keys.has(entry.key),
        );
        entries.splice(0, entries.length, ...kept);
      },
      append: async (e: import('./journal.js').JournalEntry) => {
        entries.push(e);
      },
      drain: () => Promise.resolve(),
    } as unknown as import('./journal.js').WorkflowJournal;
    return { journal, entries };
  }

  // The sandbox normalizes `disallowedTools` / `tools` before the resume key is
  // derived, so spelling the same request differently must replay, and a
  // genuinely different request must not. Display text and watchdog tuning are
  // deliberately outside the key: renaming a step or changing `stallMs` must
  // not re-bill a dispatch that does exactly the same work.
  it('derives one resume key per distinct dispatch, not per spelling', async () => {
    const keyFor = async (opts: string): Promise<string> => {
      const { journal, entries } = memoryJournal();
      await new WorkflowOrchestrator(async () => 'ok').run({
        script: `return await agent('scan', ${opts});`,
        args: undefined,
        journal,
      });
      const started = entries.find((e) => e.type === 'started');
      return (started as { key: string }).key;
    };

    const base = await keyFor(`{ disallowedTools: ['write_file', 'edit'] }`);

    // Order and duplicates are not part of what the list means.
    expect(
      await keyFor(`{ disallowedTools: ['edit', 'write_file', 'edit'] }`),
    ).toBe(base);
    // A label, a phase and a stall timeout change nothing about the work.
    expect(
      await keyFor(
        `{ label: 'scanner', disallowedTools: ['edit', 'write_file'] }`,
      ),
    ).toBe(base);
    expect(
      await keyFor(
        `{ phase: 'plan', stallMs: 5000, disallowedTools: ['edit', 'write_file'] }`,
      ),
    ).toBe(base);
    // Property order in the object literal is not part of it either.
    expect(
      await keyFor(
        `{ disallowedTools: ['edit', 'write_file'], label: 'other' }`,
      ),
    ).toBe(base);
    // A different tool set is a different dispatch, and so is a different prompt.
    expect(await keyFor(`{ disallowedTools: ['edit'] }`)).not.toBe(base);
    const otherPrompt = await (async () => {
      const { journal, entries } = memoryJournal();
      await new WorkflowOrchestrator(async () => 'ok').run({
        script: `return await agent('other', { disallowedTools: ['edit', 'write_file'] });`,
        args: undefined,
        journal,
      });
      return (entries.find((e) => e.type === 'started') as { key: string }).key;
    })();
    expect(otherPrompt).not.toBe(base);
  });

  it('settles a sequential agent() to null when the agent itself failed', async () => {
    const { journal, entries } = memoryJournal();
    const orchestrator = new WorkflowOrchestrator(async () => {
      throw new WorkflowAgentFailedError(
        'did not complete (terminate mode: MAX_TURNS).',
        'max_turns',
        'MAX_TURNS',
      );
    });

    const outcome = await orchestrator.run({
      script: `const a = await agent('x'); return a === null ? 'saw null' : 'saw ' + a;`,
      args: undefined,
      journal,
    });

    expect(outcome.result).toBe('saw null');
    // started, then failed — never a result.
    expect(entries.map((e) => e.type)).toEqual(['started', 'failed']);
    const started = entries[0] as { key: string; agentId: string };
    const failed = entries[1] as { key: string; agentId: string };
    expect(failed.key).toBe(started.key);
    expect(failed.agentId).toBe(started.agentId);
  });

  it('gives a parallel() slot the same null, and journals it the same way', async () => {
    const { journal, entries } = memoryJournal();
    const orchestrator = new WorkflowOrchestrator(async (prompt) => {
      if (prompt === 'bad') {
        throw new Error('model errored before classification');
      }
      return `r:${prompt}`;
    });

    const outcome = await orchestrator.run({
      script: `return await parallel([() => agent('good'), () => agent('bad')]);`,
      args: undefined,
      journal,
    });

    expect(outcome.result).toEqual(['r:good', null]);
    expect(entries.filter((e) => e.type === 'failed')).toHaveLength(1);
    expect(entries.filter((e) => e.type === 'result')).toHaveLength(1);
  });

  // A run-level failure is still a run failure: the script does not get to
  // carry on past a budget or cap exhaustion, and the journal must not call
  // the admitted agent itself failed.
  it('propagates a run-level dispatch failure without a failed record', async () => {
    const { journal, entries } = memoryJournal();
    const orchestrator = new WorkflowOrchestrator(async () => {
      throw new WorkflowAgentCapExceededError(1000);
    });

    await expect(
      orchestrator.run({
        script: `return await agent('x');`,
        args: undefined,
        journal,
      }),
    ).rejects.toThrow(/maximum of 1000 agent\(\) calls/);

    expect(entries.map((e) => e.type)).toEqual(['started']);
  });

  // The one outcome that is NOT the dispatch's own. Every key open when the
  // user cancels was merely interrupted, and marking those failed would tell
  // the next resume the agents are broken when nothing about them is.
  it('writes no failed record when the run itself was aborted', async () => {
    const { journal, entries } = memoryJournal();
    const controller = new AbortController();
    const orchestrator = new WorkflowOrchestrator(async () => {
      controller.abort();
      throw new Error(
        'Workflow subagent did not complete (terminate mode: CANCELLED).',
      );
    });

    await expect(
      orchestrator.run({
        script: `return await agent('x');`,
        args: undefined,
        journal,
        abortOnTimeout: controller,
      }),
    ).rejects.toThrow();

    expect(entries.filter((e) => e.type === 'failed')).toHaveLength(0);
    expect(entries.filter((e) => e.type === 'started')).toHaveLength(1);
  });

  // ── Resume says why a call is running live again ──────────────────────

  it.each([
    [true, 'failed in the previous run'],
    [false, 'was interrupted'],
  ])('reports a respawn with wasFailed=%s', async (wasFailed, _description) => {
    const { buildReplay } = await import('./journal.js');
    const key = (await import('./journal.js')).deriveAgentKey(
      (await import('./journal.js')).deriveArgsSeed(undefined),
      'x',
      {},
    );
    const priorEntries: Array<import('./journal.js').JournalEntry> = [
      { type: 'started', key, agentId: '1' },
      ...(wasFailed
        ? ([{ type: 'failed', key, agentId: '1' }] as Array<
            import('./journal.js').JournalEntry
          >)
        : []),
    ];
    const journal = {
      path: 'mem',
      retainReplayPrefix: async () => {},
      append: async () => {},
      drain: () => Promise.resolve(),
    } as unknown as import('./journal.js').WorkflowJournal;

    const respawns: string[] = [];
    const orchestrator = new WorkflowOrchestrator(async () => 'live');
    const outcome = await orchestrator.run({
      script: `return await agent('x');`,
      args: undefined,
      journal,
      resumeReplay: buildReplay(priorEntries),
      emitter: {
        resumeRespawn: (line) => respawns.push(line),
      },
    });

    const expected = wasFailed
      ? '[resume] re-running an agent: it failed in the previous run'
      : '[resume] respawning an agent: interrupted in a previous run (1 prior attempt)';
    expect(respawns).toEqual([expected]);
    expect(outcome.logs).toContain(expected);
  });

  // The ordinary interrupted fan-out: one agent was still in flight when the
  // run stopped, its sibling had already finished. On resume the unfinished
  // one is a respawn; the finished one re-runs only because the prefix
  // invariant sends everything after a miss live, which is a fact about the
  // run, not about that agent.
  it('does not report a respawn for a completed call dragged live by the invariant', async () => {
    const { buildReplay, deriveAgentKey, deriveArgsSeed } = await import(
      './journal.js'
    );
    const keyA = deriveAgentKey(deriveArgsSeed(undefined), 'a', {});
    const keyB = deriveAgentKey(keyA, 'b', {});
    const journal = {
      path: 'mem',
      retainReplayPrefix: async () => {},
      append: async () => {},
      drain: () => Promise.resolve(),
    } as unknown as import('./journal.js').WorkflowJournal;

    const respawns: string[] = [];
    const dispatched: string[] = [];
    const orchestrator = new WorkflowOrchestrator(async (prompt) => {
      dispatched.push(prompt);
      return `live:${prompt}`;
    });

    const outcome = await orchestrator.run({
      script: `await agent('a', { label: 'inflight' }); return await agent('b', { label: 'finished' });`,
      args: undefined,
      journal,
      resumeReplay: buildReplay([
        // 'a' was in flight when the run stopped: started, never resulted.
        { type: 'started', key: keyA, agentId: '1' },
        // 'b' had already come back.
        { type: 'started', key: keyB, agentId: '2' },
        { type: 'result', key: keyB, agentId: '2', result: 'from the journal' },
      ]),
      emitter: {
        resumeRespawn: (line) => respawns.push(line),
      },
    });

    // Both run live — that part is the existing invariant and is unchanged.
    expect(dispatched).toEqual(['a', 'b']);
    expect(outcome.result).toBe('live:b');
    // Only the one that never finished is a respawn.
    expect(respawns).toEqual([
      '[resume] respawning "inflight": interrupted in a previous run (1 prior attempt)',
    ]);
  });

  it('reports no respawn when the journal had a result to replay', async () => {
    const { buildReplay, deriveAgentKey, deriveArgsSeed } = await import(
      './journal.js'
    );
    const key = deriveAgentKey(deriveArgsSeed(undefined), 'x', {});
    const journal = {
      path: 'mem',
      retainReplayPrefix: async () => {},
      append: async () => {},
      drain: () => Promise.resolve(),
    } as unknown as import('./journal.js').WorkflowJournal;
    const respawns: unknown[] = [];
    let dispatched = 0;

    const orchestrator = new WorkflowOrchestrator(async () => {
      dispatched += 1;
      return 'live';
    });
    const outcome = await orchestrator.run({
      script: `return await agent('x');`,
      args: undefined,
      journal,
      resumeReplay: buildReplay([
        { type: 'started', key, agentId: '1' },
        { type: 'result', key, agentId: '1', result: 'cached' },
      ]),
      emitter: {
        resumeRespawn: (...args: unknown[]) => respawns.push(args),
      },
    });

    expect(outcome.result).toBe('cached');
    expect(dispatched).toBe(0);
    expect(respawns).toHaveLength(0);
  });

  it('does not journal or report a respawn when the budget gate refuses it', async () => {
    const { WorkflowBudgetImpl } = await import('./budget.js');
    const { buildReplay, deriveAgentKey, deriveArgsSeed } = await import(
      './journal.js'
    );
    const budget = new WorkflowBudgetImpl(1);
    budget.recordSpent(1);
    const key = deriveAgentKey(deriveArgsSeed(undefined), 'x', {});
    const { journal, entries } = memoryJournal();
    const respawns: string[] = [];
    const dispatch = vi.fn(async () => 'unused');

    await new WorkflowOrchestrator(dispatch).run({
      script: `try { await agent('x'); } catch (error) { return error.message; }`,
      args: undefined,
      budget,
      journal,
      resumeReplay: buildReplay([{ type: 'started', key, agentId: 'prior' }]),
      emitter: { resumeRespawn: (line) => respawns.push(line) },
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(entries).toEqual([]);
    expect(respawns).toEqual([]);
  });

  it('does not journal or report a respawn when the agent cap refuses it', async () => {
    const previous = process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'];
    process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'] = '1';
    try {
      const { buildReplay, deriveAgentKey, deriveArgsSeed } = await import(
        './journal.js'
      );
      const keyA = deriveAgentKey(deriveArgsSeed(undefined), 'a', {});
      const keyB = deriveAgentKey(keyA, 'b', {});
      const { journal, entries } = memoryJournal();
      const respawns: string[] = [];
      const dispatch = vi.fn(async (prompt: string) => prompt);

      await new WorkflowOrchestrator(dispatch).run({
        script: `await agent('a'); try { await agent('b'); } catch (error) { return error.message; }`,
        args: undefined,
        journal,
        resumeReplay: buildReplay([
          { type: 'started', key: keyB, agentId: 'prior' },
        ]),
        emitter: { resumeRespawn: (line) => respawns.push(line) },
      });

      expect(dispatch).toHaveBeenCalledOnce();
      expect(entries.map((entry) => entry.type)).toEqual(['started', 'result']);
      expect(
        entries.some((entry) => 'key' in entry && entry.key === keyB),
      ).toBe(false);
      expect(respawns).toEqual([]);
    } finally {
      if (previous === undefined) {
        delete process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'];
      } else {
        process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'] = previous;
      }
    }
  });

  it('preserves call-order journal ids without recording paused calls as started', async () => {
    const entries: Array<import('./journal.js').JournalEntry> = [];
    const journal = {
      append: (entry: import('./journal.js').JournalEntry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    } as unknown as import('./journal.js').WorkflowJournal;
    const scheduler = new WorkflowDispatchScheduler(1);
    scheduler.pause();
    let dispatchCalls = 0;
    let queued = 0;
    const orchestrator = new WorkflowOrchestrator(async (prompt) => {
      dispatchCalls++;
      return prompt;
    });

    const run = orchestrator.run({
      script: `return await parallel([
        () => agent('a'),
        () => agent('b'),
        () => agent('c'),
      ]);`,
      args: undefined,
      journal,
      scheduler,
      emitter: { dispatchQueued: () => queued++ },
    });
    await vi.waitFor(() => expect(queued).toBe(3));
    expect(entries).toEqual([]);
    expect(dispatchCalls).toBe(0);

    scheduler.resume();
    await expect(run).resolves.toMatchObject({ result: ['a', 'b', 'c'] });
    const started = entries.filter((entry) => entry.type === 'started');
    expect(started.map((entry) => entry.agentId)).toEqual(['1', '2', '3']);
    expect(new Set(started.map((entry) => entry.key)).size).toBe(3);
    const results = entries.filter((entry) => entry.type === 'result');
    expect(results).toEqual(
      started.map((entry, i) => ({
        ...entry,
        type: 'result',
        result: ['a', 'b', 'c'][i],
      })),
    );
  });

  it('appends an in-flight result before the paused result gate opens', async () => {
    const entries: Array<import('./journal.js').JournalEntry> = [];
    const journal = {
      append: (entry: import('./journal.js').JournalEntry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    } as unknown as import('./journal.js').WorkflowJournal;
    const scheduler = new WorkflowDispatchScheduler(1);
    let finish: ((value: string) => void) | undefined;
    const orchestrator = new WorkflowOrchestrator(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );

    const run = orchestrator.run({
      script: `return await agent('a');`,
      args: undefined,
      journal,
      scheduler,
    });
    await vi.waitFor(() => expect(finish).toBeDefined());
    scheduler.pause();
    finish?.('done');
    await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));
    expect(entries.filter((entry) => entry.type === 'result')).toHaveLength(1);
    let settled = false;
    // Two arms: under a rejection-shaped gate regression the promise
    // rejects, and a fulfillment-only attach would escape as an
    // unhandledRejection instead of failing the intended assertion.
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // Flush all microtasks + a timer tick so the negative check
    // distinguishes the pause gate from a gate-less resolve
    // (which settles in a few microtasks without one).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    scheduler.resume();
    await expect(run).resolves.toMatchObject({ result: 'done' });
  });

  it('preserves a dispatch error when cancellation aborts its pause gate', async () => {
    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    let rejectDispatch: ((error: Error) => void) | undefined;
    const orchestrator = new WorkflowOrchestrator(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectDispatch = reject;
        }),
    );

    const run = orchestrator.run({
      script: `return await agent('a');`,
      args: undefined,
      scheduler,
    });
    await vi.waitFor(() => expect(rejectDispatch).toBeDefined());
    scheduler.pause();
    rejectDispatch?.(new Error('dispatch-boom'));
    await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));

    controller.abort();

    await expect(run).resolves.toMatchObject({ result: null });
  });

  it('delivers a successful dispatch result when cancellation aborts its pause gate', async () => {
    // A dispatch that succeeded before the run was cancelled must resolve
    // with its result even though abort rejects the pause-gate waiter:
    // the success arm resolves held results on abort, so this AWAITING
    // script (two-arm .then + `await p`) observes the completed work
    // instead of an AbortError. The unhandledRejection rationale for the
    // resolve-on-abort arm belongs to the next test, whose fixture is
    // genuinely fire-and-forget.
    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    let finishDispatch: ((value: string) => void) | undefined;
    const orchestrator = new WorkflowOrchestrator(
      () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    );

    const run = orchestrator.run({
      script: `
        let saw = 'none';
        const p = agent('a').then(
          (v) => { saw = 'resolved:' + v; },
          (e) => { saw = 'rejected:' + e.message; }
        );
        try { await agent('keep'); } catch (e) {}
        await p;
        return saw;
      `,
      args: undefined,
      scheduler,
    });
    await vi.waitFor(() => expect(finishDispatch).toBeDefined());
    scheduler.pause();
    finishDispatch?.('A');
    await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));

    controller.abort();

    await expect(run).resolves.toMatchObject({ result: 'resolved:A' });
  });

  it('raises no unhandledRejection for an un-awaited successful dispatch on cancel', async () => {
    // The reviewer-reported alarm: a fire-and-forget agent() call whose
    // dispatch succeeded before the cancel must not surface a
    // process-level unhandledRejection ("CRITICAL: Unhandled Promise
    // Rejection") for a correctly-cancelled run.
    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    let finishDispatch: ((value: string) => void) | undefined;
    const orchestrator = new WorkflowOrchestrator(
      () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    );

    let unhandled = 0;
    const onUnhandled = () => {
      unhandled += 1;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const run = orchestrator.run({
        script: `
          agent('notify');
          try { await agent('keep'); } catch (e) {}
          return 'done';
        `,
        args: undefined,
        scheduler,
      });
      await vi.waitFor(() => expect(finishDispatch).toBeDefined());
      scheduler.pause();
      finishDispatch?.('A');
      await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));

      controller.abort();

      await expect(run).resolves.toMatchObject({ result: 'done' });
      // Let any pending unhandledRejection events fire before asserting.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('raises no unhandledRejection for an un-awaited queued dispatch on cancel', async () => {
    // Error-arm counterpart of the success-path test above: a
    // fire-and-forget dispatch still QUEUED when the run is cancelled is
    // rejected with AbortError by abortPending(). The rethrow must still
    // reach awaiting callers, but the unobserved rejection must not
    // surface as a process-level unhandledRejection alarm on a
    // correctly-cancelled run.
    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    let finishDispatch: ((value: string) => void) | undefined;
    const orchestrator = new WorkflowOrchestrator(
      () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    );

    let unhandled = 0;
    const onUnhandled = () => {
      unhandled += 1;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const run = orchestrator.run({
        script: `
          agent('inflight');
          agent('notify');
          try { await agent('keep'); } catch (e) {}
          return 'done';
        `,
        args: undefined,
        scheduler,
      });
      await vi.waitFor(() => expect(finishDispatch).toBeDefined());
      scheduler.pause();
      finishDispatch?.('A');
      await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));

      controller.abort();

      await expect(run).resolves.toMatchObject({ result: 'done' });
      // Let any pending unhandledRejection events fire before asserting.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('delivers a cached dispatch result when cancellation aborts its pause gate', async () => {
    const { buildReplay } = await import('./journal.js');
    const entries: Array<import('./journal.js').JournalEntry> = [];
    const journal1 = {
      append: (e: import('./journal.js').JournalEntry) => {
        entries.push(e);
        return Promise.resolve();
      },
    } as unknown as import('./journal.js').WorkflowJournal;
    const orch1 = new WorkflowOrchestrator(async (prompt) => `r:${prompt}`);
    await orch1.run({
      script: `await agent('a'); await agent('keep'); return 'done';`,
      args: undefined,
      journal: journal1,
    });

    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    scheduler.pause();
    let completed = 0;
    const emitter = {
      agentCompleted: () => {
        completed += 1;
      },
    };
    const orch2 = new WorkflowOrchestrator(async () => 'LIVE');
    const run = orch2.run({
      script: `
        let saw = 'none';
        const p = agent('a').then(
          (v) => { saw = 'resolved:' + v; },
          (e) => { saw = 'rejected:' + e.message; }
        );
        try { await agent('keep'); } catch (e) {}
        await p;
        return saw;
      `,
      args: undefined,
      journal: {
        retainReplayPrefix: async () => {},
        append: () => Promise.resolve(),
      } as never,
      resumeReplay: buildReplay(entries),
      scheduler,
      emitter,
    });
    // Both dispatches are cached; their results park behind the gate.
    await vi.waitFor(() => expect(completed).toBe(2));

    controller.abort();

    await expect(run).resolves.toMatchObject({ result: 'resolved:r:a' });
  });

  it('keeps a paused run alive past the wall-clock budget and completes it after resume', async () => {
    // The wall clock is a hang backstop armed at sandbox.run start; a
    // run paused mid-flight executes nothing, so the watchdog must
    // suspend on pause and re-arm on resume instead of killing the run
    // mid-pause (after which resume is impossible).
    const prev = process.env['MIN_AGENT_MAX_WORKFLOW_SECONDS'];
    process.env['MIN_AGENT_MAX_WORKFLOW_SECONDS'] = '0.4';
    try {
      const scheduler = new WorkflowDispatchScheduler(1);
      let finishDispatch: ((value: string) => void) | undefined;
      const orchestrator = new WorkflowOrchestrator(
        () =>
          new Promise<string>((resolve) => {
            finishDispatch = resolve;
          }),
      );
      const run = orchestrator.run({
        script: `return await agent('a');`,
        args: undefined,
        scheduler,
      });
      await vi.waitFor(() => expect(finishDispatch).toBeDefined());
      scheduler.pause();
      finishDispatch?.('done');
      await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));
      // Sleep past the 400 ms budget while paused.
      await new Promise((resolve) => setTimeout(resolve, 500));
      let settled = false;
      void run.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);

      scheduler.resume();
      await expect(run).resolves.toMatchObject({ result: 'done' });
    } finally {
      if (prev === undefined)
        delete process.env['MIN_AGENT_MAX_WORKFLOW_SECONDS'];
      else process.env['MIN_AGENT_MAX_WORKFLOW_SECONDS'] = prev;
    }
  });

  it('P6: resume serves the cached prefix without re-dispatching', async () => {
    const { buildReplay } = await import('./journal.js');
    // Run 1: record the journal.
    const entries: Array<import('./journal.js').JournalEntry> = [];
    const journal1 = {
      append: (e: import('./journal.js').JournalEntry) => {
        entries.push(e);
        return Promise.resolve();
      },
    } as unknown as import('./journal.js').WorkflowJournal;
    const orch1 = new WorkflowOrchestrator(async (prompt) => `r:${prompt}`);
    await orch1.run({
      script: `await agent('a'); await agent('b'); return 'done';`,
      args: undefined,
      journal: journal1,
    });

    // Run 2 (resume): same script. The dispatch counter must stay 0 because
    // both agents are cached.
    let dispatchCalls = 0;
    const orch2 = new WorkflowOrchestrator(async (prompt) => {
      dispatchCalls += 1;
      return `LIVE:${prompt}`;
    });
    const journal2 = {
      retainReplayPrefix: async () => {},
      append: () => Promise.resolve(),
    } as unknown as import('./journal.js').WorkflowJournal;
    const scheduler = new WorkflowDispatchScheduler(1);
    scheduler.pause();
    const run = orch2.run({
      script: `const a = await agent('a'); const b = await agent('b'); return a + '|' + b;`,
      args: undefined,
      journal: journal2,
      resumeReplay: buildReplay(entries),
      scheduler,
    });
    let settled = false;
    // Two arms: under a rejection-shaped gate regression the promise
    // rejects, and a fulfillment-only attach would escape as an
    // unhandledRejection instead of failing the intended assertion.
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // Flush all microtasks + a timer tick so the negative check
    // distinguishes the pause gate from a gate-less cached resolve
    // (which settles in ~4 microtasks without one).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(dispatchCalls).toBe(0);
    scheduler.resume();
    const outcome = await run;
    expect(dispatchCalls).toBe(0); // fully cached
    expect(outcome.result).toBe('r:a|r:b'); // cached values, not LIVE
  });

  it('P6: first miss runs live and the suffix goes live (first-miss invalidates suffix)', async () => {
    const { buildReplay } = await import('./journal.js');
    // Run 1 journaled agents a, b, c.
    const entries: Array<import('./journal.js').JournalEntry> = [];
    const journal1 = {
      append: (e: import('./journal.js').JournalEntry) => {
        entries.push(e);
        return Promise.resolve();
      },
    } as unknown as import('./journal.js').WorkflowJournal;
    const orch1 = new WorkflowOrchestrator(async (prompt) => `r:${prompt}`);
    await orch1.run({
      script: `await agent('a'); await agent('b'); await agent('c'); return 1;`,
      args: undefined,
      journal: journal1,
    });

    // Run 2: change agent #2's prompt ('b' → 'B'). #1 ('a') is cached; #2
    // ('B') misses → live; #3 ('c') must ALSO run live even though 'c' was
    // journaled (first-miss invalidates suffix + the prefix-hash chain from
    // #2's new prompt changes #3's key anyway).
    const dispatched: string[] = [];
    const orch2 = new WorkflowOrchestrator(async (prompt) => {
      dispatched.push(prompt);
      return `LIVE:${prompt}`;
    });
    const outcome = await orch2.run({
      script: `const a = await agent('a');
               const b = await agent('B');
               const c = await agent('c');
               return [a, b, c].join('|');`,
      args: undefined,
      journal: {
        retainReplayPrefix: async () => {},
        append: () => Promise.resolve(),
      } as never,
      resumeReplay: buildReplay(entries),
    });
    // 'a' cached; 'B' and 'c' live.
    expect(dispatched).toEqual(['B', 'c']);
    expect(outcome.result).toBe('r:a|LIVE:B|LIVE:c');
  });

  it('P6: cache hit advances the registry counters (agentDispatched + agentCompleted)', async () => {
    const { buildReplay } = await import('./journal.js');
    const entries: Array<import('./journal.js').JournalEntry> = [];
    const journal1 = {
      append: (e: import('./journal.js').JournalEntry) => {
        entries.push(e);
        return Promise.resolve();
      },
    } as unknown as import('./journal.js').WorkflowJournal;
    const orch1 = new WorkflowOrchestrator(async () => 'cached');
    await orch1.run({
      script: `await agent('a'); return 1;`,
      args: undefined,
      journal: journal1,
    });

    const events: string[] = [];
    const orch2 = new WorkflowOrchestrator(async () => 'LIVE');
    await orch2.run({
      script: `await agent('a'); return 1;`,
      args: undefined,
      journal: {
        retainReplayPrefix: async () => {},
        append: () => Promise.resolve(),
      } as never,
      resumeReplay: buildReplay(entries),
      emitter: {
        agentDispatched: () => events.push('dispatched'),
        agentCompleted: () => events.push('completed'),
      },
    });
    expect(events).toEqual(['dispatched', 'completed']);
  });

  it('P6: cached dispatches do NOT consume the agent-count cap', async () => {
    const prev = process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'];
    process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'] = '2';
    try {
      const { buildReplay } = await import('./journal.js');
      const entries: Array<import('./journal.js').JournalEntry> = [];
      const journal1 = {
        append: (e: import('./journal.js').JournalEntry) => {
          entries.push(e);
          return Promise.resolve();
        },
      } as unknown as import('./journal.js').WorkflowJournal;
      // Run 1 with a larger cap to record 3 agents.
      process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'] = '10';
      const orch1 = new WorkflowOrchestrator(async (p) => `r:${p}`);
      await orch1.run({
        script: `await agent('a'); await agent('b'); await agent('c'); return 1;`,
        args: undefined,
        journal: journal1,
      });
      // Run 2 (resume) with cap=2: all 3 are cached, so the cap (which
      // counts only LIVE dispatches) is never hit.
      process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'] = '2';
      const orch2 = new WorkflowOrchestrator(async () => 'LIVE');
      const outcome = await orch2.run({
        script: `await agent('a'); await agent('b'); await agent('c'); return 'ok';`,
        args: undefined,
        journal: {
          retainReplayPrefix: async () => {},
          append: () => Promise.resolve(),
        } as never,
        resumeReplay: buildReplay(entries),
      });
      expect(outcome.result).toBe('ok'); // no cap error despite 3 > 2
    } finally {
      if (prev === undefined)
        delete process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'];
      else process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'] = prev;
    }
  });
});
describe('WorkflowOrchestrator failure-context preservation', () => {
  // T19 (PR #4732 R1): phases / logs accumulated before a script failure
  // must be preserved on the thrown error so the tool layer can display
  // them. Previously the sandbox instance was discarded with the error.
  it('throws WorkflowExecutionError carrying phases and logs on script failure', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'ok');
    let caught: unknown;
    try {
      await orchestrator.run({
        script: `
          phase("plan");
          log("starting");
          phase("execute");
          log("about to fail");
          throw new Error("scripted failure");
        `,
        args: undefined,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkflowExecutionError);
    const wfErr = caught as WorkflowExecutionError;
    expect(wfErr.message).toContain('scripted failure');
    expect(wfErr.phases).toEqual(['plan', 'execute']);
    expect(wfErr.logs).toEqual(['starting', 'about to fail']);
  });
});

describe('WorkflowOrchestrator schema preflight', () => {
  const bad = `{ type: 42 }`;
  const good = `{ type: 'object', required: ['ok'] }`;

  function run(script: string, emitter?: WorkflowOrchestratorEmitter) {
    const dispatch = vi.fn(async (prompt: string) => ({ ok: prompt }));
    const outcome = new WorkflowOrchestrator(dispatch).run({
      script,
      args: undefined,
      resolveSavedWorkflow: async () => ({
        script: `return [await agent('nested-bad', { schema: ${bad} }), await agent('nested-good', { schema: ${good} })];`,
      }),
      ...(emitter ? { emitter } : {}),
    });
    return { dispatch, outcome };
  }

  it.each([
    [
      'sequential',
      `return [await agent('bad', { schema: ${bad} }), await agent('good', { schema: ${good} })];`,
      [null, { ok: 'good' }],
      ['good'],
    ],
    [
      'parallel',
      `return await parallel([() => agent('bad', { schema: ${bad} }), () => agent('good', { schema: ${good} })]);`,
      [null, { ok: 'good' }],
      ['good'],
    ],
    [
      'pipeline',
      `return await pipeline(['bad', 'good'], (_prev, item) => agent(item, { schema: item === 'bad' ? ${bad} : ${good} }), (prev) => agent('after ' + JSON.stringify(prev)));`,
      [null, { ok: 'after {"ok":"good"}' }],
      ['good', 'after {"ok":"good"}'],
    ],
    [
      'nested',
      `return await workflow('child');`,
      [null, { ok: 'nested-good' }],
      ['nested-good'],
    ],
  ])(
    'settles a refused schema to null without dispatching it (%s)',
    async (_shape, script, result, dispatched) => {
      const { dispatch, outcome } = run(script);
      await expect(outcome).resolves.toMatchObject({ result });
      expect(dispatch.mock.calls.map((call) => call[0])).toEqual(dispatched);
    },
  );

  it('records why the refused agent failed', async () => {
    const completed: Array<[string | undefined, string | undefined]> = [];
    const { outcome } = run(
      `return await agent('bad', { label: 'bad', schema: ${bad} });`,
      { agentCompleted: (label, error) => completed.push([label, error]) },
    );
    await expect(outcome).resolves.toMatchObject({ result: null });
    expect(completed).toEqual([
      [
        'bad',
        expect.stringMatching(
          /^agent\(\{schema\}\): is not a valid JSON Schema: /,
        ),
      ],
    ]);
  });

  it.each([
    [
      `try { return await agent('bad', { schema: ${bad} }); } catch (e) { return 'threw'; }`,
      null,
    ],
    [
      `const settled = await Promise.allSettled([agent('bad', { schema: ${bad} })]); return settled.map((s) => s.status + ':' + JSON.stringify(s.value));`,
      ['fulfilled:null'],
    ],
    [`agent('bad', { schema: ${bad} }); return 'unawaited';`, 'unawaited'],
  ])(
    'keeps the refusal inside the script contract without an unhandled rejection: %s',
    async (script, result) => {
      let unhandled = 0;
      const onUnhandled = () => {
        unhandled += 1;
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        const { dispatch, outcome } = run(script);
        await expect(outcome).resolves.toMatchObject({ result });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
      expect(unhandled).toBe(0);
    },
  );

  it('still lets run-level limits win over a refused schema', async () => {
    vi.stubEnv('MIN_AGENT_MAX_WORKFLOW_AGENTS', '1');
    try {
      const { dispatch, outcome } = run(
        `await agent('good', { schema: ${good} }); return await agent('bad', { schema: ${bad} });`,
      );
      await expect(outcome).rejects.toThrow('maximum of 1 agent() calls');
      expect(dispatch.mock.calls.map((call) => call[0])).toEqual(['good']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('WorkflowOrchestrator P2 — parallel() / pipeline() / caps', () => {
  describe('parallel()', () => {
    it('resolves all thunks to a position-aligned array', async () => {
      const orchestrator = new WorkflowOrchestrator(
        async (prompt) => `r:${prompt}`,
      );
      const outcome = await orchestrator.run({
        script: `return await parallel([
          () => agent("a"),
          () => agent("b"),
          () => agent("c"),
        ]);`,
        args: undefined,
      });
      expect(outcome.result).toEqual(['r:a', 'r:b', 'r:c']);
    });

    it('errors-as-data: a thunk that throws becomes null at its index, others unaffected', async () => {
      const orchestrator = new WorkflowOrchestrator(
        async (prompt) => `r:${prompt}`,
      );
      const outcome = await orchestrator.run({
        script: `return await parallel([
          () => agent("a"),
          () => { throw new Error("boom"); },
          () => agent("c"),
        ]);`,
        args: undefined,
      });
      expect(outcome.result).toEqual(['r:a', null, 'r:c']);
    });

    it('rejects on a non-function element (eager promise instead of thunk)', async () => {
      const orchestrator = new WorkflowOrchestrator(async () => 'unused');
      await expect(
        orchestrator.run({
          script: `return await parallel([agent("a")]);`,
          args: undefined,
        }),
      ).rejects.toThrow(/array of functions/);
    });

    // EAD-1 (P2 self-review): a thunk that resolves to a non-JSON-serializable
    // value (BigInt / circular) must become null at its index — NOT crash the
    // whole batch. The in-realm revival is per-element, so one bad slot cannot
    // destroy its siblings (errors-as-data holds for return values too).
    it('a thunk returning a non-serializable value becomes null without crashing siblings', async () => {
      const orchestrator = new WorkflowOrchestrator(async () => 'unused');
      const outcome = await orchestrator.run({
        script: `return await parallel([
          () => "a",
          () => 1n,
          () => "c",
          () => { const o = {}; o.self = o; return o; },
        ]);`,
        args: undefined,
      });
      expect(outcome.result).toEqual(['a', null, 'c', null]);
    });

    it('caps concurrent agents within a fan-out to the shared per-run window', async () => {
      let inFlight = 0;
      let peak = 0;
      const orchestrator = new WorkflowOrchestrator(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return 'ok';
      });
      await orchestrator.run({
        script: `return await parallel(
          Array.from({ length: 50 }, () => () => agent("x"))
        );`,
        args: undefined,
      });
      // 50 thunks >> window, so the window fully fills: peak === cap.
      const cap = Math.max(2, Math.min(16, os.availableParallelism() - 2));
      expect(peak).toBe(cap);
    });

    it('propagates run-level failures wrapped by Promise.any', async () => {
      const { WorkflowBudgetImpl } = await import('./budget.js');
      const budget = new WorkflowBudgetImpl(1);
      budget.recordSpent(1);
      const budgetOrchestrator = new WorkflowOrchestrator(async () => 'unused');
      await expect(
        budgetOrchestrator.run({
          script: `return await parallel([() => Promise.any([Promise.any([agent('x')])])]);`,
          args: undefined,
          budget,
        }),
      ).rejects.toThrow(/token budget exceeded/);

      const capOrchestrator = new WorkflowOrchestrator(async () => {
        throw new WorkflowAgentCapExceededError(1000);
      });
      await expect(
        capOrchestrator.run({
          script: `return await parallel([() => Promise.any([agent('x')])]);`,
          args: undefined,
        }),
      ).rejects.toThrow(/maximum of 1000 agent\(\) calls/);
    });
  });

  describe('pipeline()', () => {
    it('runs each item through the stages; first stage receives (item, item, idx)', async () => {
      const orchestrator = new WorkflowOrchestrator(async () => 'unused');
      const outcome = await orchestrator.run({
        script: `return await pipeline([10, 20],
          (prev, item, idx) => prev + "|" + item + "|" + idx,
          (prev) => "S2(" + prev + ")",
        );`,
        args: undefined,
      });
      expect(outcome.result).toEqual(['S2(10|10|0)', 'S2(20|20|1)']);
    });

    it('a stage returning null drops that item to null and skips remaining stages', async () => {
      const orchestrator = new WorkflowOrchestrator(async () => 'unused');
      const outcome = await orchestrator.run({
        script: `return await pipeline([1, 2, 3],
          (x) => (x === 2 ? null : x),
          (x) => x * 100,
        );`,
        args: undefined,
      });
      expect(outcome.result).toEqual([100, null, 300]);
    });

    it('a stage that throws drops that item to null (errors-as-data), others unaffected', async () => {
      const orchestrator = new WorkflowOrchestrator(async () => 'unused');
      const outcome = await orchestrator.run({
        script: `return await pipeline([1, 2, 3],
          (x) => { if (x === 2) throw new Error("bad"); return x; },
          (x) => x * 100,
        );`,
        args: undefined,
      });
      expect(outcome.result).toEqual([100, null, 300]);
    });

    it('rejects when a stage is not a function', async () => {
      const orchestrator = new WorkflowOrchestrator(async () => 'unused');
      await expect(
        orchestrator.run({
          script: `return await pipeline([1, 2], "not a function");`,
          args: undefined,
        }),
      ).rejects.toThrow(/stages must be functions/);
    });

    // TST-1 (P2 self-review): pipeline must share the SAME per-run window as
    // parallel — a pipeline impl that gave itself a separate (or no) limiter
    // would let concurrency exceed the cap. Drive 50 item-chains, each calling
    // one agent per stage, and assert peak in-flight === cap.
    it('caps concurrent agents across a pipeline fan-out (shares the run window)', async () => {
      let inFlight = 0;
      let peak = 0;
      const orchestrator = new WorkflowOrchestrator(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return 'ok';
      });
      await orchestrator.run({
        script: `return await pipeline(
          Array.from({ length: 50 }, (_, i) => i),
          (x) => agent("s1-" + x),
        );`,
        args: undefined,
      });
      const cap = Math.max(2, Math.min(16, os.availableParallelism() - 2));
      expect(peak).toBe(cap);
    });

    // TST-2 (P2 self-review): pipeline is parallel-of-chains — STAGGERED, with
    // NO inter-stage barrier. Item 0's stage-2 dispatch must be able to fire
    // WHILE item 1's stage-1 dispatch is still pending. We assert this
    // deterministically via a release gate: item 1's stage 1 blocks until
    // item 0 reaches stage 2 and releases the gate. A barrier impl
    // (all items must clear stage N before any enters stage N+1) cannot
    // satisfy this — it would wait for item 1's stage 1 to finish first,
    // creating a circular wait that the vitest timeout would catch.
    //
    // PR #4947 R2 T6 (DragonnZhang): the previous version of this test used
    // an elapsed-time threshold (50ms vs 120ms) which fails deterministically
    // on a 3-core macOS-14 CI runner because the cpu-derived concurrency
    // limit becomes 1 — FIFO then forces all stage-1 dispatches to settle
    // before any stage-2 starts, breaking the timing assumption. Force the
    // limit to 2 AND use a release gate so the assertion is timing-free.
    it('is staggered with no inter-stage barrier (item A reaches stage 2 while item B is still in stage 1)', async () => {
      const envPrev = process.env['MIN_AGENT_MAX_WORKFLOW_CONCURRENCY'];
      process.env['MIN_AGENT_MAX_WORKFLOW_CONCURRENCY'] = '2';
      try {
        let releaseItem1Stage1: () => void = () => {};
        const item1Stage1Gate = new Promise<void>((resolve) => {
          releaseItem1Stage1 = resolve;
        });
        let item0ReachedStage2 = false;

        const orchestrator = new WorkflowOrchestrator(async (prompt) => {
          if (prompt === 's1-0') return 'ok'; // item 0's stage 1: fast
          if (prompt === 's1-1') {
            // item 1's stage 1: BLOCKS until item 0 reaches stage 2.
            // A staggered impl lets item 0 advance to stage 2 while this is
            // still in flight. A barrier impl would hang here waiting for
            // item 0's stage 2 — but item 0's stage 2 cannot start because
            // the barrier is waiting for THIS to finish. Mutual wait =
            // vitest timeout = test fails for a barrier impl.
            await item1Stage1Gate;
            return 'ok';
          }
          if (prompt === 's2-0') {
            item0ReachedStage2 = true;
            releaseItem1Stage1();
            return 'ok';
          }
          if (prompt === 's2-1') return 'ok';
          throw new Error(`unexpected prompt ${prompt}`);
        });

        await orchestrator.run({
          script: `return await pipeline([0, 1],
            (prev, item) => agent("s1-" + item),
            (prev, item) => agent("s2-" + item),
          );`,
          args: undefined,
        });

        expect(item0ReachedStage2).toBe(true);
      } finally {
        if (envPrev === undefined)
          delete process.env['MIN_AGENT_MAX_WORKFLOW_CONCURRENCY'];
        else process.env['MIN_AGENT_MAX_WORKFLOW_CONCURRENCY'] = envPrev;
      }
    }, 10_000);
  });

  describe('1000-agent cap', () => {
    it('the 1001st sequential agent() call throws the cap error', async () => {
      const orchestrator = new WorkflowOrchestrator(async () => 'ok');
      await expect(
        orchestrator.run({
          script: `for (let i = 0; i < ${DEFAULT_MAX_AGENTS_PER_RUN + 1}; i++) {
            await agent("x");
          }
          return "done";`,
          args: undefined,
        }),
      ).rejects.toThrow(
        new RegExp(`${DEFAULT_MAX_AGENTS_PER_RUN} agent\\(\\) calls per run`),
      );
    });

    it('the cap counts agents launched via parallel() — a fan-out cannot bypass it', async () => {
      const orchestrator = new WorkflowOrchestrator(async () => 'ok');
      await expect(
        orchestrator.run({
          script: `return await parallel(
            Array.from({ length: ${DEFAULT_MAX_AGENTS_PER_RUN + 1} }, () => () => agent("x"))
          );`,
          args: undefined,
        }),
      ).rejects.toThrow(
        new RegExp(`${DEFAULT_MAX_AGENTS_PER_RUN} agent\\(\\) calls per run`),
      );
    });

    it('rejects a pipeline when an agent hits the run-level cap', async () => {
      const previous = process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'];
      process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'] = '1';
      try {
        const orchestrator = new WorkflowOrchestrator(async () => 'ok');
        await expect(
          orchestrator.run({
            script: `return await pipeline(['a', 'b'], (_prev, item) => agent(item));`,
            args: undefined,
          }),
        ).rejects.toThrow(/maximum of 1 agent\(\) call/);
      } finally {
        if (previous === undefined) {
          delete process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'];
        } else {
          process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'] = previous;
        }
      }
    });

    it('preserves a run-level cap rejection through nested fan-out', async () => {
      const previous = process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'];
      process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'] = '1';
      try {
        const orchestrator = new WorkflowOrchestrator(async () => 'ok');
        await expect(
          orchestrator.run({
            script: `return await parallel([
              () => parallel([() => agent('a'), () => agent('b')])
            ]);`,
            args: undefined,
          }),
        ).rejects.toThrow(/maximum of 1 agent\(\) call/);
      } finally {
        if (previous === undefined) {
          delete process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'];
        } else {
          process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'] = previous;
        }
      }
    });
  });

  describe('abort', () => {
    it('parallel() rejects (not silent nulls) when the run is aborted', async () => {
      const ac = new AbortController();
      ac.abort();
      const orchestrator = new WorkflowOrchestrator(async () => 'ok');
      await expect(
        orchestrator.run({
          script: `return await parallel([() => agent("a"), () => agent("b")]);`,
          args: undefined,
          abortOnTimeout: ac,
        }),
      ).rejects.toThrow(/abort/i);
    });

    // TST-3 (P2 self-review): the pre-aborted case above only exercises the
    // fast-path. Abort MID-FLIGHT — after dispatches have already started —
    // and confirm parallel() rejects rather than resolving with a silent array
    // of nulls (which would let an aborted/timed-out workflow continue).
    it('parallel() rejects when aborted MID-FLIGHT (after dispatches started)', async () => {
      const ac = new AbortController();
      let dispatched = 0;
      const orchestrator = new WorkflowOrchestrator(async () => {
        dispatched++;
        await new Promise((r) => setTimeout(r, 40));
        return 'ok';
      });
      const p = orchestrator.run({
        script: `return await parallel(
          Array.from({ length: 6 }, () => () => agent("x"))
        );`,
        args: undefined,
        abortOnTimeout: ac,
      });
      // Abort once at least one dispatch is in flight.
      setTimeout(() => ac.abort(), 10);
      await expect(p).rejects.toThrow(/abort/i);
      expect(dispatched).toBeGreaterThan(0);
    }, 10_000);
  });

  describe('nested fan-out (shared-window re-entrancy)', () => {
    // F1 (P2 review round 1): the concurrency limiter throttles AGENT
    // DISPATCHES, not orchestration thunks. `pipeline([items], item =>
    // parallel([...]))` is a canonical pattern (it's in the upstream
    // /deep-research workflow). If the limiter sat at the thunk level, the
    // outer pipeline chains would each hold a slot while awaiting an inner
    // parallel(), and on a low concurrency limit every slot is held by a
    // stalled outer thunk → the inner agent() calls can never acquire a slot
    // → unrecoverable deadlock (silent hang until the 30-min wall clock).
    // Forcing the window to 1 makes the worst case deterministic.
    it('a parallel() inside a pipeline() stage does not deadlock at concurrency=1', async () => {
      const prev = process.env['MIN_AGENT_MAX_WORKFLOW_CONCURRENCY'];
      process.env['MIN_AGENT_MAX_WORKFLOW_CONCURRENCY'] = '1';
      try {
        const orchestrator = new WorkflowOrchestrator(async (p) => `r:${p}`);
        const outcome = await orchestrator.run({
          script: `return await pipeline([0, 1, 2],
            (prev, item) => parallel([() => agent("a" + item)]),
          );`,
          args: undefined,
        });
        expect(outcome.result).toEqual([['r:a0'], ['r:a1'], ['r:a2']]);
      } finally {
        if (prev === undefined)
          delete process.env['MIN_AGENT_MAX_WORKFLOW_CONCURRENCY'];
        else process.env['MIN_AGENT_MAX_WORKFLOW_CONCURRENCY'] = prev;
      }
    }, 15_000);

    it('parallel() of parallel() does not deadlock at concurrency=1', async () => {
      const prev = process.env['MIN_AGENT_MAX_WORKFLOW_CONCURRENCY'];
      process.env['MIN_AGENT_MAX_WORKFLOW_CONCURRENCY'] = '1';
      try {
        const orchestrator = new WorkflowOrchestrator(async (p) => `r:${p}`);
        const outcome = await orchestrator.run({
          script: `return await parallel([
            () => parallel([() => agent("x")]),
            () => parallel([() => agent("y")]),
          ]);`,
          args: undefined,
        });
        expect(outcome.result).toEqual([['r:x'], ['r:y']]);
      } finally {
        if (prev === undefined)
          delete process.env['MIN_AGENT_MAX_WORKFLOW_CONCURRENCY'];
        else process.env['MIN_AGENT_MAX_WORKFLOW_CONCURRENCY'] = prev;
      }
    }, 15_000);
  });

  describe('env-overridable caps', () => {
    it('resolveMaxAgentsPerRun defaults to 1000 and honors a valid override', () => {
      expect(resolveMaxAgentsPerRun({})).toBe(DEFAULT_MAX_AGENTS_PER_RUN);
      expect(
        resolveMaxAgentsPerRun({ MIN_AGENT_MAX_WORKFLOW_AGENTS: '50' }),
      ).toBe(50);
    });

    it('resolveMaxAgentsPerRun rejects a non-integer / <1 override and falls back', () => {
      expect(
        resolveMaxAgentsPerRun({ MIN_AGENT_MAX_WORKFLOW_AGENTS: '0' }),
      ).toBe(DEFAULT_MAX_AGENTS_PER_RUN);
      expect(
        resolveMaxAgentsPerRun({ MIN_AGENT_MAX_WORKFLOW_AGENTS: 'abc' }),
      ).toBe(DEFAULT_MAX_AGENTS_PER_RUN);
      expect(
        resolveMaxAgentsPerRun({ MIN_AGENT_MAX_WORKFLOW_AGENTS: '2.5' }),
      ).toBe(DEFAULT_MAX_AGENTS_PER_RUN);
    });

    it('resolveMaxAgentsPerRun rejects hex / scientific / non-decimal-integer overrides', () => {
      // Number('0x10')=16, Number('1e3')=1000, Number('1.0')=1 pass
      // Number.isInteger; only plain decimal integers should override the cap.
      for (const raw of ['0x10', '1e3', '1.0']) {
        expect(
          resolveMaxAgentsPerRun({ MIN_AGENT_MAX_WORKFLOW_AGENTS: raw }),
        ).toBe(DEFAULT_MAX_AGENTS_PER_RUN);
      }
    });

    it('resolveConcurrencyLimit treats hex / scientific overrides as invalid (cpu default)', () => {
      // An invalid override falls back to the cpu-derived default in [1,16];
      // 0x10/1e2 must be rejected too, not parsed as 16/100.
      const cpuDefault = resolveConcurrencyLimit({
        MIN_AGENT_MAX_WORKFLOW_CONCURRENCY: '-1',
      });
      for (const raw of ['0x10', '1e2']) {
        expect(
          resolveConcurrencyLimit({ MIN_AGENT_MAX_WORKFLOW_CONCURRENCY: raw }),
        ).toBe(cpuDefault);
      }
    });

    // PR #4947 R1 T4 (wenshao): an env override above the hard ceiling must
    // be clamped, not honored — protects operators from a fat-finger
    // MIN_AGENT_MAX_WORKFLOW_AGENTS=999999999 silently uncapping the run.
    it('resolveMaxAgentsPerRun clamps an over-ceiling override to the hard maximum', () => {
      expect(
        resolveMaxAgentsPerRun({
          MIN_AGENT_MAX_WORKFLOW_AGENTS: '999999999',
        }),
      ).toBe(10_000);
      // Just under the ceiling is preserved.
      expect(
        resolveMaxAgentsPerRun({ MIN_AGENT_MAX_WORKFLOW_AGENTS: '9999' }),
      ).toBe(9999);
    });

    // A build-and-test agent, or an analysis of a 2 000-line file, exceeds
    // 50 turns / 10 minutes routinely — and under GOAL-terminal semantics
    // being cut off shows up as a `null` element, i.e. an agent that
    // silently went missing. Both bounds are operator-tunable, on the same
    // contract as the agent cap.
    it('per-subagent bounds default, honor an override, and clamp', () => {
      expect(resolveSubagentMaxTurns({})).toBe(
        DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS,
      );
      expect(resolveSubagentMaxTimeMinutes({})).toBe(
        DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES,
      );
      expect(
        resolveSubagentMaxTurns({ MIN_AGENT_WORKFLOW_AGENT_MAX_TURNS: '120' }),
      ).toBe(120);
      expect(
        resolveSubagentMaxTimeMinutes({
          MIN_AGENT_WORKFLOW_AGENT_MAX_MINUTES: '45',
        }),
      ).toBe(45);
      // Literal anchors for the hard ceilings — comparing against the
      // HARD_* constants would assert them against themselves.
      expect(
        resolveSubagentMaxTurns({
          MIN_AGENT_WORKFLOW_AGENT_MAX_TURNS: '999999',
        }),
      ).toBe(500);
      expect(
        resolveSubagentMaxTimeMinutes({
          MIN_AGENT_WORKFLOW_AGENT_MAX_MINUTES: '999999',
        }),
      ).toBe(100);
    });

    it('per-subagent bounds reject non-decimal-integer overrides', () => {
      for (const raw of ['0', 'abc', '2.5', '0x10', '1e3']) {
        expect(
          resolveSubagentMaxTurns({ MIN_AGENT_WORKFLOW_AGENT_MAX_TURNS: raw }),
        ).toBe(DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS);
        expect(
          resolveSubagentMaxTimeMinutes({
            MIN_AGENT_WORKFLOW_AGENT_MAX_MINUTES: raw,
          }),
        ).toBe(DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES);
      }
    });

    it('resolveConcurrencyLimit honors a valid override and clamps the cpu default to [2,16]', () => {
      expect(
        resolveConcurrencyLimit({ MIN_AGENT_MAX_WORKFLOW_CONCURRENCY: '4' }),
      ).toBe(4);
      // invalid → cpu-derived default, always within [2, 16]
      const fallback = resolveConcurrencyLimit({
        MIN_AGENT_MAX_WORKFLOW_CONCURRENCY: '-1',
      });
      expect(fallback).toBeGreaterThanOrEqual(2);
      expect(fallback).toBeLessThanOrEqual(16);
    });

    // The default reads `availableParallelism()`, which honours the CPU
    // affinity mask and container limits, where `os.cpus()` reports the
    // host and can return an empty array. The floor is 2, not 1: a window
    // of 1 turns every `parallel()` into a sequence on a small machine.
    it('resolveConcurrencyLimit derives the default from availableParallelism, floored at 2', () => {
      const at = (parallelism: number) =>
        resolveConcurrencyLimit({}, () => parallelism);
      expect(at(0)).toBe(2);
      expect(at(1)).toBe(2);
      expect(at(3)).toBe(2);
      expect(at(6)).toBe(4);
      expect(at(18)).toBe(16);
      expect(at(64)).toBe(16);
    });

    // PR #4947 R1 T4 (wenshao): an env override above the hard ceiling must
    // be clamped, not honored — a single Node process running 999999
    // concurrent LLM calls would OOM long before saturating the model.
    it('resolveConcurrencyLimit clamps an over-ceiling override to the hard maximum', () => {
      expect(
        resolveConcurrencyLimit({
          MIN_AGENT_MAX_WORKFLOW_CONCURRENCY: '999999',
        }),
      ).toBe(64);
      // Just under the ceiling is preserved.
      expect(
        resolveConcurrencyLimit({ MIN_AGENT_MAX_WORKFLOW_CONCURRENCY: '63' }),
      ).toBe(63);
    });

    it('MIN_AGENT_MAX_WORKFLOW_AGENTS actually lowers the cap at run time', async () => {
      const prev = process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'];
      process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'] = '3';
      try {
        const orchestrator = new WorkflowOrchestrator(async () => 'ok');
        await expect(
          orchestrator.run({
            script: `return await parallel(
              Array.from({ length: 4 }, () => () => agent("x"))
            );`,
            args: undefined,
          }),
        ).rejects.toThrow(/maximum of 3 agent\(\) calls per run/);
      } finally {
        if (prev === undefined)
          delete process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'];
        else process.env['MIN_AGENT_MAX_WORKFLOW_AGENTS'] = prev;
      }
    });
  });
});
