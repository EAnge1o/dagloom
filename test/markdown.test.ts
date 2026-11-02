import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseWorkflowSource } from '../src/markdown.js';

const parse = (src: string) => parseWorkflowSource(src, '/tmp/loom.md');
const errors = (r: ReturnType<typeof parse>) => r.issues.filter((i) => i.severity === 'error');
const warnings = (r: ReturnType<typeof parse>) => r.issues.filter((i) => i.severity === 'warning');

describe('markdown parser: tasks and fields', () => {
  it('parses all task fields', () => {
    const { workflow, issues } = parse(`
## deploy

Ship it to production.

cmd: ./deploy.sh
depends: build, test
retry: 3
backoff: 5
timeout: 120
allow_fail: true
outputs: dist/app.js, manifest.json
env: K1=v1, K2=v2
cwd: packages/app
`);
    assert.equal(issues.length, 0);
    const t = workflow.tasks.get('deploy')!;
    assert.equal(t.kind, 'cmd');
    assert.equal(t.cmd, './deploy.sh');
    assert.deepEqual(t.dependsRaw, ['build', 'test']);
    assert.equal(t.retry, 3);
    assert.equal(t.backoff, 5);
    assert.equal(t.timeout, 120);
    assert.equal(t.allowFail, true);
    assert.deepEqual(t.outputs, ['dist/app.js', 'manifest.json']);
    assert.deepEqual(t.env, { K1: 'v1', K2: 'v2' });
    assert.equal(t.cwd, 'packages/app');
    assert.equal(t.description, 'Ship it to production.');
  });

  it('supports field aliases', () => {
    const { workflow, issues } = parse(`
## b
needs: a
retries: 2
cmd: echo b
## a
cmd: echo a
`);
    assert.equal(issues.length, 0);
    assert.deepEqual(workflow.tasks.get('b')!.dependsRaw, ['a']);
    assert.equal(workflow.tasks.get('b')!.retry, 2);
  });

  it('parses a sh fenced block as a multi-line script', () => {
    const { workflow, issues } = parse(`
## build
depends: install

\`\`\`sh
set -e
echo one
echo two
\`\`\`
`);
    assert.equal(issues.length, 0);
    const t = workflow.tasks.get('build')!;
    assert.equal(t.cmd, 'set -e\necho one\necho two');
  });

  it('warns on non-shell fenced blocks and ignores them', () => {
    const { workflow, issues } = parse(`
## t
\`\`\`js
console.log(1)
\`\`\`
cmd: echo ok
`);
    const t = workflow.tasks.get('t')!;
    assert.equal(t.cmd, 'echo ok');
    assert.equal(issues.filter((i) => i.severity === 'warning').length, 1);
  });

  it('rejects agent + cmd together', () => {
    const { workflow } = parse(`
## t
agent: do things
cmd: echo hi
`);
    assert.equal(errors(parse(`
## t
agent: do things
cmd: echo hi
`)).length, 1);
    assert.equal(workflow.tasks.size, 0);
  });

  it('rejects a task with no command', () => {
    const r = parse(`
## t
just some prose
`);
    assert.equal(errors(r).length, 1);
    assert.match(errors(r)[0]!.message, /no command/);
  });

  it('rejects an empty command', () => {
    const r = parse(`
## t
cmd:
`);
    assert.equal(errors(r).length, 1);
  });

  it('slugs headings and honours id overrides', () => {
    const { workflow } = parse(`
## 1. Install deps
cmd: echo i
## Deploy! <overrides>
id: ship
cmd: echo d
`);
    assert.ok(workflow.tasks.has('install-deps'));
    assert.ok(workflow.tasks.has('ship'));
    assert.equal(workflow.tasks.get('ship')!.title, 'Deploy! <overrides>');
  });

  it('rejects duplicate ids and duplicate fields', () => {
    const r = parse(`
## same name
cmd: echo 1
## same name
cmd: echo 2
`);
    assert.equal(errors(r).length, 1);
    assert.match(errors(r)[0]!.message, /duplicate task id/);

    const r2 = parse(`
## t
cmd: echo 1
cmd: echo 2
`);
    assert.equal(errors(r2).filter((e) => /duplicate field/.test(e.message)).length, 1);
  });

  it('validates numeric and boolean fields', () => {
    const r = parse(`
## t
retry: nope
cmd: echo x
`);
    assert.match(errors(r)[0]!.message, /retry/);

    const r2 = parse(`
## t
allow_fail: maybe
cmd: echo x
`);
    assert.match(errors(r2)[0]!.message, /allow_fail/);
  });

  it('warns on unknown fields', () => {
    const r = parse(`
## t
coomand: echo x
`);
    assert.equal(warnings(r).length, 1);
    assert.match(warnings(r)[0]!.message, /unknown field/);
  });
});

describe('markdown parser: settings and structure', () => {
  it('parses the reserved loom section', () => {
    const { workflow, issues } = parse(`
## loom
concurrency: 8
fail_fast: true
agent_cmd: myagent --fast
env: G=1, H=2
task_timeout: 60

## t
cmd: echo x
`);
    assert.equal(issues.length, 0);
    assert.equal(workflow.settings.concurrency, 8);
    assert.equal(workflow.settings.failFast, true);
    assert.equal(workflow.settings.agentCmd, 'myagent --fast');
    assert.equal(workflow.settings.taskTimeout, 60);
    assert.deepEqual(workflow.settings.env, { G: '1', H: '2' });
  });

  it('warns on unknown settings', () => {
    const r = parse(`
## loom
whatever: 1
## t
cmd: echo x
`);
    assert.equal(warnings(r).length, 1);
  });

  it('rejects YAML front matter with a helpful message', () => {
    const r = parse(`---
concurrency: 2
---
## t
cmd: echo x
`);
    assert.equal(errors(r).length, 1);
    assert.match(errors(r)[0]!.message, /## loom/);
    assert.equal(r.workflow.tasks.size, 1);
  });

  it('ignores h1 titles and sub-headings as prose', () => {
    const { workflow, issues } = parse(`
# My project

Some intro text.

## build
cmd: echo b

### notes
sub-heading prose is fine
`);
    assert.equal(issues.length, 0);
    assert.equal(workflow.tasks.size, 1);
  });

  it('handles CRLF line endings', () => {
    const { workflow, issues } = parse('# t\r\n\r\n## a\r\ncmd: echo a\r\n');
    assert.equal(issues.length, 0);
    assert.equal(workflow.tasks.get('a')!.cmd, 'echo a');
  });

  it('errors when the file has no sections', () => {
    const r = parse('# just a title\nnothing here\n');
    assert.equal(errors(r).length, 1);
  });

  it('computes a stable semantic hash (ignores description changes)', () => {
    const a = parse(`
## t
cmd: echo 1
retry: 2
`).workflow.tasks.get('t')!;
    const b = parse(`
## t
cmd: echo 1
retry: 2
totally different description here
`).workflow.tasks.get('t')!;
    const c = parse(`
## t
cmd: echo 2
retry: 2
`).workflow.tasks.get('t')!;
    assert.equal(a.hash, b.hash);
    assert.notEqual(a.hash, c.hash);
  });
});
