import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveDeps } from '../src/dag.js';
import { parseWorkflowSource } from '../src/markdown.js';
import { freshRunState, isOk, isRunnable, reconcile } from '../src/state.js';
import type { RunState, TaskState } from '../src/types.js';

function make(src: string) {
  const { workflow } = parseWorkflowSource(src, '/tmp/loom.md');
  resolveDeps(workflow);
  return workflow;
}

const task = (over: Partial<TaskState> = {}): TaskState => ({
  status: 'pending',
  attempts: 0,
  exitCode: null,
  durationMs: 0,
  ...over,
});

describe('state: status predicates', () => {
  it('isOk treats allow_fail failures as success', () => {
    assert.equal(isOk(task({ status: 'done', ok: true })), true);
    assert.equal(isOk(task({ status: 'failed', ok: true })), true);
    assert.equal(isOk(task({ status: 'failed' })), false);
    assert.equal(isOk(task({ status: 'pending' })), false);
  });

  it('isRunnable covers pending, hard-failed and cancelled', () => {
    assert.equal(isRunnable(task()), true);
    assert.equal(isRunnable(task({ status: 'failed' })), true);
    assert.equal(isRunnable(task({ status: 'cancelled' })), true);
    assert.equal(isRunnable(task({ status: 'done' })), false);
    assert.equal(isRunnable(task({ status: 'failed', ok: true })), false);
    assert.equal(isRunnable(task({ status: 'skipped' })), false);
    assert.equal(isRunnable(task({ status: 'running' })), false);
  });
});

describe('state: reconcile on resume', () => {
  const src = `
## a
cmd: echo a
## b
cmd: echo b
depends: a
## c
cmd: echo c
depends: b
`;
  it('keeps finished work, resets mid-flight tasks', () => {
    const wf = make(src);
    const saved: RunState = {
      version: 1,
      runId: 'x',
      workflowFile: wf.file,
      startedAt: 't0',
      updatedAt: 't1',
      settings: wf.settings,
      removed: [],
      tasks: {
        a: task({ status: 'done', ok: true }),
        b: task({ status: 'running' }),
        c: task({ status: 'pending' }),
      },
    };
    const rec = reconcile(wf, saved);
    assert.equal(rec.state.tasks.a!.status, 'done');
    assert.equal(rec.state.tasks.b!.status, 'pending');
    assert.deepEqual(rec.edited, []);
    assert.deepEqual(rec.added, []);
    assert.deepEqual(rec.removed, []);
    assert.equal(rec.foreign, false);
  });

  it('resets tasks whose definition was edited', () => {
    const wf = make(src);
    const saved = freshRunState(wf);
    saved.tasks.a = task({ status: 'done', ok: true, hash: 'stale' });
    const rec = reconcile(wf, saved);
    assert.deepEqual(rec.edited, ['a']);
    assert.equal(rec.state.tasks.a!.status, 'pending');
    // untouched task keeps its result
    assert.equal(rec.state.tasks.b!.status, 'pending');
  });

  it('tracks added and removed tasks', () => {
    const wf = make(src + '\n## d\ncmd: echo d\n');
    const saved = freshRunState(wf);
    delete (saved.tasks as Record<string, TaskState>).d;
    saved.tasks.gone = task();
    const rec = reconcile(wf, saved);
    assert.deepEqual(rec.added, ['d']);
    assert.deepEqual(rec.removed, ['gone']);
  });

  it('flags a foreign state file', () => {
    const wf = make(src);
    const saved = freshRunState(wf);
    saved.workflowFile = '/somewhere/else/loom.md';
    assert.equal(reconcile(wf, saved).foreign, true);
  });

  it('revives cascade-skipped tasks once their deps succeeded', () => {
    const wf = make(src);
    const saved = freshRunState(wf);
    saved.tasks.a = task({ status: 'done', ok: true });
    saved.tasks.b = task({ status: 'done', ok: true });
    saved.tasks.c = task({ status: 'skipped' });
    const rec = reconcile(wf, saved);
    assert.equal(rec.state.tasks.c!.status, 'pending');
  });

  it('keeps skipped tasks whose deps are still broken', () => {
    const wf = make(src);
    const saved = freshRunState(wf);
    saved.tasks.b = task({ status: 'failed' });
    saved.tasks.c = task({ status: 'skipped' });
    const rec = reconcile(wf, saved);
    assert.equal(rec.state.tasks.c!.status, 'skipped');
  });

  it('user skips (--skip) stay sticky even when deps succeeded', () => {
    const wf = make(src);
    const saved = freshRunState(wf);
    saved.tasks.a = task({ status: 'done', ok: true });
    saved.tasks.b = task({ status: 'done', ok: true });
    saved.tasks.c = task({ status: 'skipped', skipBy: 'user' });
    const rec = reconcile(wf, saved);
    assert.equal(rec.state.tasks.c!.status, 'skipped');
  });
});
