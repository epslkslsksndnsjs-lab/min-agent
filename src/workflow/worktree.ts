// The git worktree helpers behind `agent({ isolation: 'worktree' })` and
// `agent({ workingDir })`.
//
// Why this exists: a fan-out of agents that each edit files will clobber one
// another in a single checkout. A worktree gives each agent its own directory
// sharing one object store, so writes are independent and the result says which
// branch to look at.
//
// Worktrees are created under the global per-project root
// (~/.min-agent/projects/<slug>/worktrees/), never inside the user's checkout:
// a worktree directory inside the tree shows up as untracked content and gets
// committed by accident. `git worktree add` accepts any path.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createDebugLogger } from './support.js';

const run = promisify(execFile);
const debugLogger = createDebugLogger('WORKFLOW_WORKTREE');

export interface GitWorktreeInfo {
  /** Absolute path of the worktree directory. */
  path: string;
  /** Branch checked out there. */
  branch: string;
  /** Commit the branch starts from. */
  head: string;
  /** Top level of the repository it belongs to. */
  repoRoot: string;
}

/** Run git, returning stdout, or null when the command fails. */
async function git(
  cwd: string,
  args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; stderr: string }> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, stdout };
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    return { ok: false, stderr: (e.stderr ?? e.message ?? 'git failed').trim() };
  }
}

/** The repository root for a directory, or null when it is not inside one. */
export async function repoTopLevel(cwd: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', '--show-toplevel']);
  return result.ok ? result.stdout.trim() || null : null;
}

/**
 * Whether the working tree has uncommitted changes. `isolation: 'worktree'`
 * refuses on a dirty tree: a new worktree branches from HEAD, so an agent given
 * a dirty checkout would silently work against a state the human can see but
 * the agent cannot.
 */
export async function isDirty(cwd: string): Promise<boolean> {
  const result = await git(cwd, ['status', '--porcelain']);
  if (!result.ok) return true; // unknown state is treated as unsafe
  return result.stdout.trim().length > 0;
}

/**
 * Is `cwd` itself a *linked* worktree rather than the main checkout? Then a
 * nested `isolation: 'worktree'` dispatch must be refused: git does not
 * register worktrees of worktrees cleanly, and a fan-out that quietly created
 * one directory per attempt off a directory the user cannot see is worse than
 * an outright refusal. `--git-dir` differs from `--git-common-dir` exactly when
 * the current tree is a linked one.
 */
export async function isLinkedWorktree(cwd: string): Promise<boolean> {
  const dir = await git(cwd, ['rev-parse', '--absolute-git-dir']);
  const common = await git(cwd, ['rev-parse', '--git-common-dir']);
  if (!dir.ok || !common.ok) return false;
  const realDir = await fs.realpath(dir.stdout.trim()).catch(() => dir.stdout.trim());
  const realCommon = await fs.realpath(common.stdout.trim()).catch(() => common.stdout.trim());
  return realDir !== realCommon;
}

/** A short, path-safe slug for a worktree directory and branch. */
export function newWorktreeSlug(): string {
  return `agent-${randomBytes(4).toString('hex')}`;
}

export interface CreateWorktreeOptions {
  /** Where worktree directories live (the per-project root). */
  worktreesRoot: string;
  /** Ref to branch from; defaults to the current HEAD. */
  base?: string;
}

/**
 * Create a fresh worktree with its own branch. Throws with git's own message
 * when it cannot, because the caller reports the reason to the script — the
 * agent must not run in a directory it was promised and did not get.
 */
export async function createWorktree(
  cwd: string,
  slug: string = newWorktreeSlug(),
  options: CreateWorktreeOptions,
): Promise<GitWorktreeInfo> {
  const repoRoot = await repoTopLevel(cwd);
  if (repoRoot === null) {
    throw new Error(`agent({isolation:'worktree'}): ${cwd} is not inside a git repository.`);
  }
  const headResult = await git(repoRoot, ['rev-parse', 'HEAD']);
  if (!headResult.ok) {
    throw new Error(`agent({isolation:'worktree'}): cannot resolve HEAD: ${headResult.stderr}`);
  }
  const head = headResult.stdout.trim();
  const base = options.base ?? head;
  const dir = path.join(options.worktreesRoot, slug);
  const branch = `min-agent/${slug}`;
  await fs.mkdir(options.worktreesRoot, { recursive: true, mode: 0o700 });

  const added = await git(repoRoot, ['worktree', 'add', '-b', branch, dir, base]);
  if (!added.ok) {
    throw new Error(`agent({isolation:'worktree'}): git worktree add failed: ${added.stderr}`);
  }
  return { path: dir, branch, head, repoRoot };
}

/**
 * Is `dir` a registered *linked* worktree of this repository? Backs
 * `agent({ workingDir })`, which pins an agent to a directory that already
 * exists — a review worktree, or one a previous step provisioned — whose
 * uncommitted state is the point. The main checkout is not eligible: pinning to
 * it would put the agent back where the isolation rule forbids.
 */
export async function resolveRegisteredWorktree(
  cwd: string,
  dir: string,
): Promise<GitWorktreeInfo | null> {
  const repoRoot = await repoTopLevel(cwd);
  if (repoRoot === null) return null;
  const listed = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return null;

  const target = await fs.realpath(path.resolve(dir)).catch(() => path.resolve(dir));
  const mainPath = await fs.realpath(repoRoot).catch(() => repoRoot);

  let current: { path?: string; branch?: string; head?: string } = {};
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('branch ') && current.path) {
      current.branch = line.slice('branch '.length).trim();
    } else if (line.startsWith('HEAD ') && current.path) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (line === '' && current.path) {
      const real = await fs.realpath(current.path).catch(() => current.path);
      if (real === target && real !== mainPath) {
        const headResult = await git(current.path, ['rev-parse', 'HEAD']);
        return {
          path: current.path,
          branch: current.branch ?? '',
          head: headResult.ok ? headResult.stdout.trim() : (current.head ?? ''),
          repoRoot,
        };
      }
      current = {};
    }
  }
  return null;
}

/** Whether the worktree has anything worth keeping. */
export async function worktreeHasChanges(info: GitWorktreeInfo): Promise<boolean> {
  return isDirty(info.path);
}

/**
 * Drop a worktree created for one dispatch. Called only when it is clean, so
 * `--force` here cannot discard work: an agent that changed something keeps its
 * worktree and reports the path and branch instead.
 */
export async function removeWorktree(info: GitWorktreeInfo): Promise<boolean> {
  const removed = await git(info.repoRoot, ['worktree', 'remove', '--force', info.path]);
  if (!removed.ok) {
    debugLogger.warn(`git worktree remove failed for ${info.path}: ${removed.stderr}`);
    return false;
  }
  return true;
}
