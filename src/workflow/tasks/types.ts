/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Adapted for min-agent from QwenLM/qwen-code packages/core/src/agents/tasks/types.ts
// — see ../PROVENANCE.md. The envelope and the lifecycle vocabulary are kept as
// they are upstream, because they are what lets one UI surface show several
// kinds of background work. `TaskKind` is narrowed to the kinds this project
// actually has (shell and workflow): 'agent' and 'monitor' would be entries no
// registry could ever create.

/** Discriminator selecting the per-kind shape. */
export type TaskKind = 'shell' | 'workflow';

/**
 * Lifecycle states a task can occupy. `paused` is used by resumable workflow
 * runs; shells never pause.
 */
export type TaskStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** True for the states a run can still leave. */
export function isActiveTaskStatus(status: TaskStatus | string): boolean {
  return status === 'running' || status === 'pausing' || status === 'paused';
}

/**
 * Common envelope every task carries regardless of kind. Per-kind modules
 * extend this via intersection.
 */
export interface TaskBase<Status extends string = TaskStatus> {
  /** Stable id used as the registry key. */
  id: string;
  /** Discriminator selecting the per-kind shape. */
  kind: TaskKind;
  /** Human label rendered in the pill/panel/dialog. */
  description: string;
  status: Status;
  /** ms epoch when the task was registered. */
  startTime: number;
  /** ms epoch when the task transitioned out of running. */
  endTime?: number;
  /**
   * Absolute path of the per-task primary stream. Reserved at register time
   * even when no writer is attached yet; each kind materializes it on its
   * first append, so a task that never produced output has a path and no file.
   */
  outputFile: string;
  /**
   * Byte offset into `outputFile` for incremental reads. Initialized to 0 and
   * advanced by readers.
   */
  outputOffset: number;
  /** True once the kind's terminal notification has fired. */
  notified: boolean;
  /** Unified cancellation handle. */
  abortController: AbortController;
}

/**
 * Shape callers pass to a registry's `register()`. The fields the registry
 * derives — `id`, `kind`, `outputOffset`, `notified` — are omitted; everything
 * else, including `outputFile`, is the caller's responsibility unless the
 * per-kind registration narrows it further.
 */
export type TaskRegistration<T extends TaskBase<string>> = Omit<
  T,
  'id' | 'kind' | 'outputOffset' | 'notified'
>;

/**
 * One background `run_bash` process. Declared here rather than in its owning
 * module because the union below needs it, and the registry that produces it is
 * still to come: `tools.ts` currently returns a task id and a temp path and
 * then forgets the process exists, which is the gap this envelope closes.
 */
export interface ShellTask extends TaskBase {
  kind: 'shell';
  /** The user-supplied command, after any pre-processing the tool applies. */
  command: string;
  /** Working directory the process was spawned in. */
  cwd: string;
  /** OS pid once spawned; absent if registration happens before spawn. */
  pid?: number;
  /** Exit code on `completed`. */
  exitCode?: number;
  /** Error message on `failed`. */
  error?: string;
}

import type { WorkflowTask } from '../run-registry.js';

/** Discriminated union over every tracked task kind. */
export type TaskState = ShellTask | WorkflowTask;

export type { WorkflowTask };
