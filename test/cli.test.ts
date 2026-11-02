import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { cleanup, runCli, tempDir, writeWorkflow } from './helpers.js';

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const d = await tempDir();
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length > 0) await cleanup(dirs.pop()!);
});

describe('cli: basics', () => {
  it('prints a version and help', async () => {
    const v = await runCli(['version']);
    assert.match(v.stdout, /^\d+\.\d+\.\d+/);
    const h = await runCli(['--help']);
    assert.match(h.stdout, /dagloom/);
    assert.match(h.stdout, /COMMANDS/);
  });

  it('errors on unknown commands and flags', async () => {
    const bad = await runCli(['nope']);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /unknown command/);
    const flag = await runCli(['run', '--nope']);
    assert.equal(flag.code, 2);
  });

  it('complains when no workflow file exists', async () => {
    const dir = await scratch();
    const r = await runCli(['validate'], dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /no workflow file/);
  });
});

describe('cli: init → validate → graph → run → status → clean', () => {
  it('walks the whole happy path', async () => {
    const dir = await scratch();
    const init = await runCli(['init'], dir);
    assert.equal(init.code, 0);
    assert.ok(await import('node:fs/promises').then((fs) => fs.stat(`${dir}/loom.md`)));

    const validate = await runCli(['validate'], dir);
    assert.equal(validate.code, 0);
    assert.match(validate.stdout, /5 tasks/);

    const graph = await runCli(['graph'], dir);
    assert.equal(graph.code, 0);
    assert.match(graph.stdout, /install/);
    assert.match(graph.stdout, /└─▶|├─▶/);

    const dry = await runCli(['run', '--dry-run'], dir);
    assert.equal(dry.code, 0);
    assert.match(dry.stdout, /wave 2 \(2 parallel\): build, lint/);

    const run = await runCli(['run', '--fresh'], dir);
    assert.equal(run.code, 0);
    assert.match(run.stdout, /5 tasks · 5 done/);

    const status = await runCli(['status'], dir);
    assert.equal(status.code, 0);
    assert.match(status.stdout, /done/);

    const json = await runCli(['status', '--json'], dir);
    assert.equal(json.code, 0);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.tasks.report.status, 'done');

    const clean = await runCli(['clean'], dir);
    assert.equal(clean.code, 0);
    const after = await runCli(['status'], dir);
    assert.match(after.stdout, /no run state yet/);
  });

  it('init refuses to overwrite without --force', async () => {
    const dir = await scratch();
    await runCli(['init'], dir);
    const again = await runCli(['init'], dir);
    assert.equal(again.code, 2);
    assert.match(again.stderr, /already exists/);
    const forced = await runCli(['init', '--force'], dir);
    assert.equal(forced.code, 0);
  });
});

describe('cli: validation and failures', () => {
  it('validate exits 2 with a readable error on unknown deps', async () => {
    const dir = await scratch();
    await writeWorkflow(dir, `
## a
cmd: echo a
depends: ghost
`);
    const r = await runCli(['validate'], dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown task "ghost"/);
    assert.match(r.stderr, /line \d+/);
  });

  it('validate exits 2 on cycles', async () => {
    const dir = await scratch();
    await writeWorkflow(dir, `
## a
cmd: echo a
depends: b
## b
cmd: echo b
depends: a
`);
    const r = await runCli(['validate'], dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /cycle detected/);
  });

  it('run exits 1 and writes a report when a task fails', async () => {
    const dir = await scratch();
    await writeWorkflow(dir, `
## boom
cmd: node -e "console.error('kaboom'); process.exit(9)"
`);
    const r = await runCli(['run'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /exit 9/);
    assert.match(r.stdout, /1 failed/);
    // the failure is logged
    const log = await import('node:fs/promises').then((fs) =>
      fs.readFile(`${dir}/.loom/logs/loom/boom.log`, 'utf8'),
    );
    assert.match(log, /kaboom/);
  });

  it('--json emits machine-readable results', async () => {
    const dir = await scratch();
    await writeWorkflow(dir, `
## a
cmd: node -e "console.log(1)"
`);
    const r = await runCli(['run', '--json'], dir);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.tasks.a.status, 'done');
    assert.ok(parsed.runId);
  });

  it('list shows tasks, deps and flags', async () => {
    const dir = await scratch();
    await writeWorkflow(dir, `
## a
cmd: echo a
## b
depends: a
retry: 2
agent: fix the bug
`);
    const r = await runCli(['list'], dir);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /a/);
    assert.match(r.stdout, /← a/);
    assert.match(r.stdout, /retry=2/);
    assert.match(r.stdout, /🤖 b/);
  });

  it('run --only limits execution', async () => {
    const dir = await scratch();
    await writeWorkflow(dir, `
## a
cmd: node -e "console.log('a')"
## b
depends: a
cmd: node -e "console.log('b')"
## c
depends: a
cmd: node -e "console.log('c')"
## d
depends: b, c
cmd: node -e "console.log('d')"
`);
    const r = await runCli(['run', '--only', 'c'], dir);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /4 tasks · 2 done · 2 pending/);
  });
});
