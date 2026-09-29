/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Modified for min-agent — see src/workflow/PROVENANCE.md: jobs carry a
// caller-chosen id and an admission ordinal, and the scheduler emits dispatch
// lifecycle events, which is what the stall watchdog needs in order to tell
// "queued, never started" apart from "started and made no progress".
// Upstream: packages/core/src/agents/runtime/workflow-dispatch-scheduler.ts

import { randomUUID } from 'node:crypto';

export type WorkflowDispatchState = 'running' | 'pausing' | 'paused';

export interface WorkflowDispatchSnapshot {
  state: WorkflowDispatchState;
  queued: number;
  inFlight: number;
}

type Job = {
  /** Stable id chosen by the caller, so its own bookkeeping lines up. */
  id: string;
  /** 0-based admission order — the ordinal the stall watchdog keys on. */
  ordinal: number;
  thunk: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

/**
 * Dispatch lifecycle, emitted by the scheduler because it is the one place that
 * knows when a dispatch was created, when the window admitted it, and when it
 * settled — the three moments the stall watchdog must be able to tell apart.
 * A dispatch that is queued but never started is a real class of stall, and it
 * is invisible from inside the thunk.
 */
export type WorkflowDispatchEvent =
  | { type: 'queued'; id: string; ordinal: number; queued: number }
  | { type: 'started'; id: string; ordinal: number; inFlight: number }
  | { type: 'settled'; id: string; ok: boolean };

type GateWaiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

function abortError(): Error {
  return new DOMException('Workflow dispatch scheduler aborted.', 'AbortError');
}

export class WorkflowDispatchScheduler {
  private state: WorkflowDispatchState = 'running';
  private inFlight = 0;
  private readonly queue: Job[] = [];
  private readonly gateWaiters: GateWaiter[] = [];
  private readonly stateListeners = new Set<
    (snapshot: WorkflowDispatchSnapshot) => void
  >();
  private readonly dispatchListeners = new Set<
    (event: WorkflowDispatchEvent) => void
  >();
  private admitted = 0;

  constructor(
    private readonly limit: number,
    private readonly signal?: AbortSignal,
    onStateChange?: (snapshot: WorkflowDispatchSnapshot) => void,
    onDispatchEvent?: (event: WorkflowDispatchEvent) => void,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        `Workflow dispatch limit must be a positive integer, got ${String(limit)}.`,
      );
    }
    if (onStateChange) this.stateListeners.add(onStateChange);
    if (onDispatchEvent) this.dispatchListeners.add(onDispatchEvent);
    if (signal && !signal.aborted) {
      signal.addEventListener('abort', () => this.abortPending(), {
        once: true,
      });
    }
  }

  /**
   * Subscribe to dispatch lifecycle events. Returns an unsubscribe function.
   * Listeners run before the job's promise settles, so a ledger updated here
   * is already current by the time the awaiting script resumes.
   */
  onDispatchEvent(
    listener: (event: WorkflowDispatchEvent) => void,
  ): () => void {
    this.dispatchListeners.add(listener);
    return () => {
      this.dispatchListeners.delete(listener);
    };
  }

  private emitDispatch(event: WorkflowDispatchEvent): void {
    for (const listener of [...this.dispatchListeners]) listener(event);
  }

  run<T>(thunk: () => Promise<T>, id?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.signal?.aborted) {
        reject(abortError());
        return;
      }
      const job: Job = {
        id: id ?? `wfdisp_${randomUUID()}`,
        ordinal: this.admitted++,
        thunk: thunk as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      this.queue.push(job);
      this.emitDispatch({
        type: 'queued',
        id: job.id,
        ordinal: job.ordinal,
        queued: this.queue.length,
      });
      this.pump();
    });
  }

  /**
   * Subscribe to state transitions. Returns an unsubscribe function.
   * The constructor callback (when given) is registered as the first
   * listener; this method lets additional observers — e.g. the sandbox's
   * pause-aware wall-clock watchdog — hook the same transitions.
   */
  onStateChange(
    listener: (snapshot: WorkflowDispatchSnapshot) => void,
  ): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  pause(): boolean {
    if (this.state !== 'running' || this.signal?.aborted) return false;
    this.setState('pausing');
    if (this.inFlight === 0) this.setState('paused');
    return true;
  }

  resume(): boolean {
    if (this.state !== 'paused' || this.signal?.aborted) return false;
    this.setState('running');
    while (this.gateWaiters.length > 0) {
      this.gateWaiters.shift()!.resolve();
    }
    this.pump();
    return true;
  }

  waitUntilRunning(): Promise<void> {
    if (this.signal?.aborted) return Promise.reject(abortError());
    if (this.state === 'running') return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.gateWaiters.push({ resolve, reject });
    });
  }

  snapshot(): WorkflowDispatchSnapshot {
    return {
      state: this.state,
      queued: this.queue.length,
      inFlight: this.inFlight,
    };
  }

  private pump(): void {
    while (
      this.state === 'running' &&
      this.inFlight < this.limit &&
      this.queue.length > 0
    ) {
      const job = this.queue.shift()!;
      if (this.signal?.aborted) {
        job.reject(abortError());
        continue;
      }
      this.inFlight++;
      this.emitDispatch({
        type: 'started',
        id: job.id,
        ordinal: job.ordinal,
        inFlight: this.inFlight,
      });
      Promise.resolve()
        .then(job.thunk)
        .then(
          (value) => {
            this.emitDispatch({ type: 'settled', id: job.id, ok: true });
            job.resolve(value);
          },
          (error: unknown) => {
            this.emitDispatch({ type: 'settled', id: job.id, ok: false });
            job.reject(error);
          },
        )
        .finally(() => {
          this.inFlight--;
          if (this.state === 'pausing' && this.inFlight === 0) {
            this.setState('paused');
          }
          this.pump();
        });
    }
  }

  private setState(state: WorkflowDispatchState): void {
    if (this.state === state) return;
    this.state = state;
    const snapshot = this.snapshot();
    for (const listener of [...this.stateListeners]) listener(snapshot);
  }

  private abortPending(): void {
    const error = abortError();
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      // Queued jobs never started, so they never got a `started` event — but the
      // ledger still has to be told they are gone or their entries leak.
      this.emitDispatch({ type: 'settled', id: job.id, ok: false });
      job.reject(error);
    }
    while (this.gateWaiters.length > 0) {
      this.gateWaiters.shift()!.reject(error);
    }
  }
}
