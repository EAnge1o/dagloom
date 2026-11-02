/**
 * Run-state persistence: `.loom/state.json` inside the workflow directory.
 * Written atomically after every task transition so a crash (or a killed
 * terminal) always leaves a resumable state behind.
 */

import { readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { RunState, TaskState, Workflow } from './types.js';
import { atomicWriteFile, ensureDir, fileExists, nowIso, shortId, slugify } from './util.js';

export function loomDir(wf: Workflow): string {
  return path.join(wf.dir, '.loom');
}

/** Namespace key so two workflows in one directory never share state. */
function wfKey(wf: Workflow): string {
  return slugify(path.basename(wf.file, path.extname(wf.file)) || 'workflow');
}

export function statePath(wf: Workflow): string {
  return path.join(loomDir(wf), 'state', `${wfKey(wf)}.json`);
}

export function logsDir(wf: Workflow): string {
  return path.join(loomDir(wf), 'logs', wfKey(wf));
}

export function logFile(wf: Workflow, taskId: string): string {
  return path.join(logsDir(wf), `${taskId}.log`);
}

export async function stateExists(wf: Workflow): Promise<boolean> {
  return fileExists(statePath(wf));
}

/** Load the persisted state, or null when absent. Corrupt files are moved aside. */
export async function loadRunState(wf: Workflow): Promise<RunState | null> {
  const p = statePath(wf);
  if (!(await fileExists(p))) return null;
  let raw: string;
  try {
    raw = await readFile(p, 'utf8');
  } catch {
    return null;
  }
  try {
    const st = JSON.parse(raw) as RunState;
    if (!st || st.version !== 1 || typeof st.tasks !== 'object') throw new Error('bad shape');
    return st;
  } catch {
    try {
      await rename(p, `${p}.corrupt`);
    } catch {
      // best effort
    }
    return null;
  }
}

export async function saveRunState(wf: Workflow, st: RunState): Promise<void> {
  st.updatedAt = nowIso();
  await ensureDir(path.dirname(statePath(wf)));
  await atomicWriteFile(statePath(wf), JSON.stringify(st, null, 2) + '\n');
}

export function freshRunState(wf: Workflow): RunState {
  const tasks: Record<string, TaskState> = {};
  for (const id of wf.order) tasks[id] = freshTaskState();
  return {
    version: 1,
    runId: shortId(),
    workflowFile: wf.file,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    settings: wf.settings,
    tasks,
    removed: [],
  };
}

function freshTaskState(): TaskState {
  return { status: 'pending', attempts: 0, exitCode: null, durationMs: 0 };
}

export interface ReconcileResult {
  state: RunState;
  /** Tasks whose definition changed since the saved run — reset to pending. */
  edited: string[];
  /** Tasks added to the workflow since the saved run. */
  added: string[];
  /** Tasks removed from the workflow since the saved run. */
  removed: string[];
  /** True when the saved state belongs to a different workflow file. */
  foreign: boolean;
}

/**
 * Merge a saved run with the current workflow definition:
 *  - done/failed/skipped results are kept, running/cancelled become pending;
 *  - a task whose semantic fields changed (hash mismatch) is reset to pending;
 *  - new tasks start pending, removed tasks are recorded and dropped.
 */
export function reconcile(wf: Workflow, saved: RunState): ReconcileResult {
  const state: RunState = {
    ...saved,
    workflowFile: wf.file,
    settings: wf.settings,
    removed: [],
  };
  const edited: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const id of Object.keys(saved.tasks)) {
    if (!wf.tasks.has(id)) removed.push(id);
  }
  for (const id of wf.order) {
    const def = wf.tasks.get(id)!;
    const prev = saved.tasks[id];
    if (!prev) {
      state.tasks[id] = freshTaskState();
      added.push(id);
      continue;
    }
    // Anything that was mid-flight when the last run ended must run again.
    if (prev.status === 'running' || prev.status === 'cancelled') {
      state.tasks[id] = { ...prev, status: 'pending', exitCode: null, error: undefined };
    } else {
      state.tasks[id] = { ...prev };
    }
    if (prev.hash !== undefined && prev.hash !== def.hash) {
      state.tasks[id] = { ...freshTaskState(), attempts: 0 };
      edited.push(id);
    }
  }
  // A task skipped only because a dependency had failed gets a second chance
  // once that dependency has succeeded. User skips (--skip, skipBy === 'user')
  // stay sticky — the runner re-applies them on every run.
  for (const id of wf.order) {
    const ts = state.tasks[id];
    const def = wf.tasks.get(id);
    if (!ts || ts.status !== 'skipped' || ts.skipBy === 'user' || !def || def.depends.length === 0)
      continue;
    const depsOk = def.depends.every((d) => {
      const ds = state.tasks[d];
      return ds !== undefined && isOk(ds);
    });
    if (depsOk) state.tasks[id] = freshTaskState();
  }
  state.removed = removed;
  return { state, edited, added, removed, foreign: saved.workflowFile !== wf.file };
}

/** Effective success: done, or failed with allow_fail. */
export function isOk(ts: TaskState): boolean {
  return ts.status === 'done' || (ts.status === 'failed' && ts.ok === true);
}

/** Tasks eligible to run on a resume: pending, failed (non-ok), cancelled. */
export function isRunnable(ts: TaskState): boolean {
  return (
    ts.status === 'pending' ||
    (ts.status === 'failed' && ts.ok !== true) ||
    ts.status === 'cancelled'
  );
}

export async function cleanState(wf: Workflow): Promise<void> {
  await rm(loomDir(wf), { recursive: true, force: true });
}
