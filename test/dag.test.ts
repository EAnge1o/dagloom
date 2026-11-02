import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ancestorClosure, buildDependents, detectCycle, resolveDeps, topoLevels, topoOrder, validateGraph } from '../src/dag.js';
import { parseWorkflowSource } from '../src/markdown.js';

const wf = (src: string) => {
  const { workflow } = parseWorkflowSource(src, '/tmp/loom.md');
  return workflow;
};

describe('dag: dependency resolution', () => {
  it('resolves by id, by heading text and by slug', () => {
    const w = wf(`
## 1. Install deps
cmd: echo i
## Run tests
cmd: echo t
depends: install-deps, 1. Install deps
`);
    assert.deepEqual(resolveDeps(w), []);
    const t = w.tasks.get('run-tests')!;
    assert.deepEqual(t.depends, ['install-deps']);
  });

  it('reports unknown and self references', () => {
    const w = wf(`
## a
cmd: echo a
depends: ghost
## b
cmd: echo b
depends: b
`);
    const issues = resolveDeps(w);
    assert.equal(issues.length, 2);
    assert.match(issues[0]!.message, /unknown task "ghost"/);
    assert.match(issues[1]!.message, /depends on itself/);
  });

  it('deduplicates repeated references', () => {
    const w = wf(`
## a
cmd: echo a
## b
cmd: echo b
depends: a, a
`);
    resolveDeps(w);
    assert.deepEqual(w.tasks.get('b')!.depends, ['a']);
  });
});

describe('dag: cycles and layers', () => {
  it('detects a cycle and names it', () => {
    const w = wf(`
## a
cmd: echo a
depends: c
## b
cmd: echo b
depends: a
## c
cmd: echo c
depends: b
`);
    resolveDeps(w);
    const cycle = detectCycle(w);
    assert.ok(cycle);
    assert.equal(cycle[0], cycle[cycle.length - 1]);
  });

  it('detectCycle returns null for a DAG', () => {
    const w = wf(`
## a
cmd: echo a
## b
cmd: echo b
depends: a
`);
    resolveDeps(w);
    assert.equal(detectCycle(w), null);
  });

  it('layers tasks into topological waves', () => {
    const w = wf(`
## install
cmd: echo i
## build
cmd: echo b
depends: install
## lint
cmd: echo l
depends: install
## test
cmd: echo t
depends: build, lint
`);
    resolveDeps(w);
    assert.deepEqual(topoLevels(w), [['install'], ['build', 'lint'], ['test']]);
  });

  it('topoLevels returns null on cycles', () => {
    const w = wf(`
## a
cmd: echo a
depends: b
## b
cmd: echo b
depends: a
`);
    resolveDeps(w);
    assert.equal(topoLevels(w), null);
  });

  it('validateGraph collects everything in one pass', () => {
    const good = wf(`
## a
cmd: echo a
## b
cmd: echo b
depends: a
`);
    assert.deepEqual(validateGraph(good), []);
    const bad = wf(`
## a
cmd: echo a
depends: nope
`);
    const issues = validateGraph(bad);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.severity, 'error');
  });
});

describe('dag: selection helpers', () => {
  const w = wf(`
## a
cmd: echo a
## b
cmd: echo b
depends: a
## c
cmd: echo c
depends: a
## d
cmd: echo d
depends: b, c
`);
  resolveDeps(w);

  it('ancestorClosure includes targets and transitive deps', () => {
    assert.deepEqual([...ancestorClosure(w, ['d'])].sort(), ['a', 'b', 'c', 'd']);
    assert.deepEqual([...ancestorClosure(w, ['c'])].sort(), ['a', 'c']);
  });

  it('topoOrder puts deps before dependents', () => {
    const order = topoOrder(w);
    assert.ok(order.indexOf('a') < order.indexOf('b'));
    assert.ok(order.indexOf('a') < order.indexOf('c'));
    assert.ok(order.indexOf('b') < order.indexOf('d'));
    assert.ok(order.indexOf('c') < order.indexOf('d'));
  });

  it('buildDependents maps edges in declaration order', () => {
    assert.deepEqual(buildDependents(w).get('a'), ['b', 'c']);
    assert.deepEqual(buildDependents(w).get('b'), ['d']);
  });
});
