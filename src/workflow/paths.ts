// Where a workflow run lives on disk.
//
// min-agent persists nothing today (`src/cli.ts:2-3`: "conversations are
// ephemeral"), so this module is the first on-disk state in the project. It is
// deliberately global-rooted and project-partitioned: a run belongs to the
// directory it was started in, but its journal, snapshot and generated script
// must not be dropped into that directory's working tree, where they would show
// up in `git status` and get committed by accident.
//
//   ~/.min-agent/                                     MIN_AGENT_HOME override
//     projects/<slug>/                                one per cwd
//       runs/<runId>.json                             terminal snapshot
//       runs/<runId>/journal.jsonl                    agent() resume cache
//       runs/<runId>/checkpoint.json                  present => interrupted
//       generated/<runId>.js                          a `scriptPath` run's file
//       generated/inline/<runId>.js                   an inline script, persisted
//       subagents/<runId>/agent-<id>.jsonl            subagent transcripts
//     workflows/<name>.js                             saved workflow, user scope
//     grants.json                                     approved name+sha256 pairs
//   <cwd>/.min-agent/workflows/<name>.js              saved workflow, project scope
//
// Every file is written 0600 and no path is followed through a symlink; the
// checks that enforce that live in atomic-file-write.ts and saved.ts.

import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

/** Characters allowed in a run id; a caller-supplied id is validated against this. */
const RUN_ID_RE = /^wf_[a-z0-9_-]{1,64}$/;

export function minAgentHome(): string {
  const configured = process.env['MIN_AGENT_HOME'];
  if (configured && configured.trim() !== '') return path.resolve(configured);
  return path.join(homedir(), '.min-agent');
}

/**
 * The partition for a working directory. The digest of the resolved path is the
 * identity, not the basename: two checkouts of one repo under different parents
 * are different projects to a workflow, because the agents edit different files.
 * The basename is kept in front of the digest so the directory stays readable
 * when a human goes looking for a run.
 */
export function projectSlug(cwd: string): string {
  const resolved = path.resolve(cwd);
  const digest = createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  const base = path
    .basename(resolved)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 40);
  return `${base || 'root'}-${digest}`;
}

export interface WorkflowPaths {
  /** Root of everything for one project. */
  readonly projectRoot: string;
  /** `.../runs` — snapshots and per-run journals. */
  readonly runsDir: string;
  /** `.../generated` — scripts the engine wrote for a run. */
  readonly generatedDir: string;
  /** `.../generated/inline` — an inline `script` is persisted here. */
  readonly inlineDir: string;
  /** `.../subagents` — per-run subagent transcripts. */
  readonly subagentsDir: string;
  /** Saved-workflow roots, most specific first. */
  readonly workflowScriptRoots: readonly string[];
  /** `~/.min-agent/grants.json` — approvals the user chose "always" on. */
  readonly grantsFile: string;

  snapshotPath(runId: string): string;
  runDir(runId: string): string;
  journalPath(runId: string): string;
  checkpointPath(runId: string): string;
  generatedScriptPath(runId: string): string;
  inlineScriptPath(runId: string): string;
  transcriptPath(runId: string, agentId: string): string;
}

/** A run id is spliced into paths, so it is checked before anything is built. */
export function assertRunId(runId: string): string {
  if (!RUN_ID_RE.test(runId)) {
    throw new Error(
      `Workflow run id must match ${RUN_ID_RE}, got ${JSON.stringify(runId)}.`,
    );
  }
  return runId;
}

export function createWorkflowPaths(cwd: string): WorkflowPaths {
  const projectRoot = path.join(minAgentHome(), 'projects', projectSlug(cwd));
  const runsDir = path.join(projectRoot, 'runs');
  const generatedDir = path.join(projectRoot, 'generated');
  const inlineDir = path.join(generatedDir, 'inline');
  const subagentsDir = path.join(projectRoot, 'subagents');

  const runDir = (runId: string): string =>
    path.join(runsDir, assertRunId(runId));

  return {
    projectRoot,
    runsDir,
    generatedDir,
    inlineDir,
    subagentsDir,
    // Project scope first: a team's checked-in workflow wins over a personal one
    // of the same name, and the resolution order is the documented rule.
    workflowScriptRoots: [
      path.join(path.resolve(cwd), '.min-agent', 'workflows'),
      path.join(minAgentHome(), 'workflows'),
    ],
    grantsFile: path.join(minAgentHome(), 'grants.json'),
    snapshotPath: (runId) => path.join(runsDir, `${assertRunId(runId)}.json`),
    runDir,
    journalPath: (runId) => path.join(runDir(runId), 'journal.jsonl'),
    checkpointPath: (runId) => path.join(runDir(runId), 'checkpoint.json'),
    generatedScriptPath: (runId) =>
      path.join(generatedDir, `${assertRunId(runId)}.js`),
    inlineScriptPath: (runId) => path.join(inlineDir, `${assertRunId(runId)}.js`),
    transcriptPath: (runId, agentId) =>
      path.join(
        subagentsDir,
        assertRunId(runId),
        `agent-${agentId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`,
      ),
  };
}

/**
 * The fallback root when the global home cannot be written (read-only home,
 * sandboxed CI). The engine still runs; journals simply do not survive it, and
 * `resume` then has nothing to read, which is reported rather than faked.
 */
export function temporaryWorkflowHome(): string {
  return path.join(tmpdir(), 'min-agent-workflow');
}
