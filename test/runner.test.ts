import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { cleanup, failUntil, makeRunner, tempDir } from './helpers.js';

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const d = await tempDir();
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length > 0) await cleanup(dirs.pop()!);
});

describe('runner: happy paths', () => {
  it('runs a chain in dependency order and persists state', async () => {
    const dir = await scratch();
    const { runner, events } = await makeRunner(dir, `
## a
cmd: node -e "require('fs').writeFileSync('a.txt','1')"
## b
depends: a
cmd: node -e "require('fs').writeFileSync('b.txt', require('fs').readFileSync('a.txt','utf8'))"
## c
depends: b
cmd: node -e "console.log('done')"
`);
    const result = await runner.run();
    assert.equal(result.ok, true);
    assert.equal(result.state.tasks.a!.status, 'done');
    assert.equal(result.state.tasks.b!.status, 'done');
    assert.equal(result.state.tasks.c!.status, 'done');
    const starts = events.filter((e) => e.type === 'task_start').map((e) => e.id);
    assert.ok(starts.indexOf('a') < starts.indexOf('b'));
    assert.ok(starts.indexOf('b') < starts.indexOf('c'));
  });

  it('respects the concurrency limit across a parallel layer', async () => {
    const dir = await scratch();
    const { runner, events } = await makeRunner(
      dir,
      `
## p1
cmd: node -e "setTimeout(()=>{},400)"
## p2
cmd: node -e "setTimeout(()=>{},400)"
## p3
cmd: node -e "setTimeout(()=>{},400)"
## p4
cmd: node -e "setTimeout(()=>{},400)"
`,
      { concurrency: 2 },
    );
    const result = await runner.run();
    assert.equal(result.ok, true);
    let running = 0;
    let max = 0;
    for (const e of events) {
      if (e.type === 'task_start') running++;
      if (e.type === 'task_done' || e.type === 'task_failed') running--;
      max = Math.max(max, running);
    }
    assert.equal(max, 2, `expected max concurrency 2, saw ${max}`);
  });

  it('passes env and identifies the task to the command', async () => {
    const dir = await scratch();
    const { runner } = await makeRunner(dir, `
## e
env: GREETING=hello
cmd: node -e "require('fs').writeFileSync('env.txt', process.env.GREETING + '|' + process.env.DAGLOOM_TASK + '|' + process.env.DAGLOOM)"
`);
    const result = await runner.run();
    assert.equal(result.ok, true);
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(`${dir}/env.txt`, 'utf8');
    assert.equal(content, 'hello|e|1');
  });
});

describe('runner: failure, retries and gates', () => {
  it('retries with backoff until success', async () => {
    const dir = await scratch();
    const { runner, events } = await makeRunner(dir, `
## flaky
retry: 3
backoff: 1
cmd: ${failUntil(2)}
`);
    const result = await runner.run();
    assert.equal(result.ok, true);
    const attempts = result.state.tasks.flaky!.attempts;
    assert.equal(attempts, 3);
    const retries = events.filter((e) => e.type === 'task_retry');
    assert.equal(retries.length, 2);
    assert.equal((retries[0] as { delayMs: number }).delayMs, 1000);
    assert.equal((retries[1] as { delayMs: number }).delayMs, 2000);
  });

  it('marks a task failed after the retry budget is exhausted and skips dependents', async () => {
    const dir = await scratch();
    const { runner, events } = await makeRunner(dir, `
## bad
retry: 1
cmd: node -e "process.exit(7)"
## never
depends: bad
cmd: node -e "console.log('nope')"
`);
    const result = await runner.run();
    assert.equal(result.ok, false);
    assert.equal(result.state.tasks.bad!.status, 'failed');
    assert.equal(result.state.tasks.bad!.exitCode, 7);
    assert.equal(result.state.tasks.never!.status, 'skipped');
    assert.ok(events.some((e) => e.type === 'task_skipped' && e.id === 'never'));
  });

  it('honours allow_fail: dependents continue', async () => {
    const dir = await scratch();
    const { runner } = await makeRunner(dir, `
## warn
allow_fail: true
cmd: node -e "process.exit(3)"
## after
depends: warn
cmd: node -e "console.log('still here')"
`);
    const result = await runner.run();
    assert.equal(result.ok, true);
    assert.equal(result.state.tasks.warn!.status, 'failed');
    assert.equal(result.state.tasks.warn!.ok, true);
    assert.equal(result.state.tasks.after!.status, 'done');
  });

  it('fails a task when declared outputs are missing', async () => {
    const dir = await scratch();
    const { runner } = await makeRunner(dir, `
## makes
cmd: node -e "require('fs').writeFileSync('artifact.txt','x')"
outputs: artifact.txt
## claims
cmd: node -e "console.log('nothing')"
outputs: missing.txt
`);
    const result = await runner.run();
    assert.equal(result.state.tasks.makes!.status, 'done');
    assert.equal(result.state.tasks.claims!.status, 'failed');
    assert.match(result.state.tasks.claims!.error!, /missing output: missing\.txt/);
  });

  it('kills a task on timeout', async () => {
    const dir = await scratch();
    const { runner } = await makeRunner(dir, `
## slow
timeout: 1
cmd: node -e "setTimeout(()=>{},30000)"
`);
    const result = await runner.run();
    assert.equal(result.ok, false);
    assert.equal(result.state.tasks.slow!.status, 'failed');
    assert.match(result.state.tasks.slow!.error!, /timeout after 1s/);
  });

  it('fails cleanly when agent_cmd points nowhere', async () => {
    const dir = await scratch();
    const { runner } = await makeRunner(dir, `
## agentic
agent_cmd: definitely-not-a-real-cli-42
agent: do something
`);
    const result = await runner.run();
    assert.equal(result.ok, false);
    assert.equal(result.state.tasks.agentic!.status, 'failed');
    assert.match(result.state.tasks.agentic!.error!, /agent_cmd binary not found/);
  });

  it('stop-on-first-failure with --fail-fast cancels running siblings', async () => {
    const dir = await scratch();
    const { runner } = await makeRunner(
      dir,
      `
## quick-fail
cmd: node -e "setTimeout(()=>process.exit(1),200)"
## slow
cmd: node -e "setTimeout(()=>{},8000)"
## dependent
depends: quick-fail
cmd: node -e "console.log('x')"
`,
      { failFast: true, concurrency: 3 },
    );
    const result = await runner.run();
    assert.equal(result.ok, false);
    assert.equal(result.failFast, true);
    assert.equal(result.state.tasks['quick-fail']!.status, 'failed');
    assert.equal(result.state.tasks.slow!.status, 'cancelled');
    assert.equal(result.state.tasks.dependent!.status, 'pending');
  });
});

describe('runner: resume semantics', () => {
  it('resumes: keeps done tasks, retries failed ones, re-runs edited ones', async () => {
    const dir = await scratch();
    const good = `
## a
cmd: node -e "require('fs').writeFileSync('a.txt','1')"
## b
depends: a
cmd: node -e "process.exit(1)"
`;
    const first = await makeRunner(dir, good);
    const r1 = await first.runner.run();
    assert.equal(r1.ok, false);
    assert.equal(r1.state.tasks.a!.status, 'done');
    assert.equal(r1.state.tasks.b!.status, 'failed');

    // Same workflow again: a is not re-run, b is retried (and fails again).
    const second = await makeRunner(dir, good);
    const r2 = await second.runner.run();
    assert.equal(r2.ok, false);
    const aStarts = second.events.filter((e) => e.type === 'task_start' && e.id === 'a');
    assert.equal(aStarts.length, 0, 'done tasks must not re-run on resume');
    assert.equal(r2.state.tasks.b!.status, 'failed');

    // Fix b: hash changes, only b re-runs, run goes green.
    const fixed = `
## a
cmd: node -e "require('fs').writeFileSync('a.txt','1')"
## b
depends: a
cmd: node -e "require('fs').writeFileSync('b.txt','2')"
`;
    const third = await makeRunner(dir, fixed);
    const r3 = await third.runner.run();
    assert.equal(r3.ok, true);
    const bStarts = third.events.filter((e) => e.type === 'task_start' && e.id === 'b');
    assert.equal(bStarts.length, 1);
    const aStarts3 = third.events.filter((e) => e.type === 'task_start' && e.id === 'a');
    assert.equal(aStarts3.length, 0);
  });

  it('a skipped task whose deps recover runs on the next pass', async () => {
    const dir = await scratch();
    const broken = `
## a
cmd: node -e "process.exit(1)"
## b
depends: a
cmd: node -e "console.log('b')"
`;
    const first = await makeRunner(dir, broken);
    const r1 = await first.runner.run();
    assert.equal(r1.state.tasks.b!.status, 'skipped');

    const fixed = `
## a
cmd: node -e "console.log('a')"
## b
depends: a
cmd: node -e "console.log('b')"
`;
    const second = await makeRunner(dir, fixed);
    const r2 = await second.runner.run();
    assert.equal(r2.ok, true);
    assert.equal(r2.state.tasks.b!.status, 'done');
  });
});

describe('runner: selection and planning', () => {
  const graph = `
## a
cmd: node -e "require('fs').writeFileSync('a.txt','a')"
## b
depends: a
cmd: node -e "require('fs').writeFileSync('b.txt','b')"
## c
depends: a
cmd: node -e "require('fs').writeFileSync('c.txt','c')"
## d
depends: b, c
cmd: node -e "console.log('d')"
`;

  it('--only runs the target plus its ancestors, nothing else', async () => {
    const dir = await scratch();
    const { runner } = await makeRunner(dir, graph, { only: ['c'] });
    const result = await runner.run();
    assert.equal(result.ok, true);
    assert.equal(result.state.tasks.a!.status, 'done');
    assert.equal(result.state.tasks.b!.status, 'pending');
    assert.equal(result.state.tasks.c!.status, 'done');
    assert.equal(result.state.tasks.d!.status, 'pending');
  });

  it('--skip cascades to dependents', async () => {
    const dir = await scratch();
    const { runner } = await makeRunner(dir, graph, { skip: ['c'] });
    const result = await runner.run();
    assert.equal(result.ok, true);
    assert.equal(result.state.tasks.c!.status, 'skipped');
    assert.equal(result.state.tasks.d!.status, 'skipped');
    assert.equal(result.state.tasks.b!.status, 'done');
  });

  it('--dry-run returns waves without running anything', async () => {
    const dir = await scratch();
    const { runner: dry } = await makeRunner(dir, graph, { dryRun: true });
    const plan = await dry.run();
    assert.deepEqual(plan.plan, [['a'], ['b', 'c'], ['d']]);
    const { readFile } = await import('node:fs/promises');
    await assert.rejects(readFile(`${dir}/a.txt`), /ENOENT/);
  });
});
