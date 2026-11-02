/**
 * DAG operations: dependency resolution, cycle detection, topological layers,
 * and ancestor closure. Pure functions over a parsed Workflow.
 */

import type { ParseIssue } from './markdown.js';
import type { TaskDef, Workflow } from './types.js';
import { slugify } from './util.js';

/**
 * Resolve every task's `dependsRaw` references into ids, mutating
 * `task.depends`. References may be ids, ids with different casing, or raw
 * heading text ("1. Install deps"). Unresolvable or self references become
 * errors; a task with error issues keeps depends = [].
 */
export function resolveDeps(wf: Workflow): ParseIssue[] {
  const issues: ParseIssue[] = [];
  for (const def of wf.tasks.values()) {
    const resolved: string[] = [];
    for (const ref of def.dependsRaw) {
      const target = resolveRef(wf, ref);
      if (!target) {
        issues.push({
          severity: 'error',
          line: def.line,
          message: `task "${def.id}" depends on unknown task "${ref}"`,
        });
        continue;
      }
      if (target === def.id) {
        issues.push({
          severity: 'error',
          line: def.line,
          message: `task "${def.id}" depends on itself`,
        });
        continue;
      }
      if (!resolved.includes(target)) resolved.push(target);
    }
    def.depends = resolved;
  }
  return issues;
}

function resolveRef(wf: Workflow, ref: string): string | null {
  const byId = wf.tasks.get(ref);
  if (byId) return byId.id;
  const bySlug = wf.tasks.get(slugify(ref));
  if (bySlug) return bySlug.id;
  const byTitle = wf.titleIndex.get(ref.toLowerCase());
  if (byTitle) return byTitle;
  return null;
}

/** First cycle found, as a list of ids (["a","b","a"]), or null. */
export function detectCycle(wf: Workflow): string[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of wf.tasks.keys()) color.set(id, WHITE);
  const parent = new Map<string, string | null>();

  for (const start of wf.tasks.keys()) {
    if (color.get(start) !== WHITE) continue;
    const stack: string[] = [start];
    parent.set(start, null);
    while (stack.length > 0) {
      const node = stack[stack.length - 1]!;
      if (color.get(node) === WHITE) color.set(node, GRAY);
      const def = wf.tasks.get(node)!;
      const next = def.depends.find((d) => color.get(d) === WHITE || color.get(d) === GRAY);
      if (!next) {
        color.set(node, BLACK);
        stack.pop();
        continue;
      }
      if (color.get(next) === GRAY) {
        // Found a back edge: walk parents from node back to next.
        const cycle: string[] = [next];
        let cur: string | null = node;
        while (cur && cur !== next) {
          cycle.push(cur);
          cur = parent.get(cur) ?? null;
        }
        cycle.push(next);
        cycle.reverse();
        return cycle;
      }
      parent.set(next, node);
      stack.push(next);
    }
  }
  return null;
}

/**
 * Kahn topological layers: level 0 has no dependencies, level n has all its
 * deps in earlier levels. Tasks within a layer can run in parallel.
 * Returns null if the graph has a cycle (run detectCycle for details).
 */
export function topoLevels(wf: Workflow): string[][] | null {
  const indeg = new Map<string, number>();
  const dependents = buildDependents(wf);
  for (const id of wf.order) indeg.set(id, wf.tasks.get(id)!.depends.length);
  const levels: string[][] = [];
  let frontier = wf.order.filter((id) => indeg.get(id) === 0);
  let seen = frontier.length;
  while (frontier.length > 0) {
    levels.push(frontier);
    const next: string[] = [];
    for (const id of frontier) {
      for (const dep of dependents.get(id) ?? []) {
        const d = (indeg.get(dep) ?? 0) - 1;
        indeg.set(dep, d);
        if (d === 0) next.push(dep);
      }
    }
    seen += next.length;
    frontier = next;
  }
  if (seen !== wf.order.length) return null;
  return levels;
}

/** id → ids that depend on it (declaration order). */
export function buildDependents(wf: Workflow): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const id of wf.order) {
    for (const dep of wf.tasks.get(id)!.depends) {
      const list = m.get(dep);
      if (list) {
        if (!list.includes(id)) list.push(id);
      } else {
        m.set(dep, [id]);
      }
    }
  }
  return m;
}

/**
 * The targets plus every transitive dependency — the set of tasks that must
 * run for `--only a,b` to satisfy those targets.
 */
export function ancestorClosure(wf: Workflow, targets: string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...targets];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    const def = wf.tasks.get(id);
    if (!def) continue;
    for (const dep of def.depends) stack.push(dep);
  }
  return out;
}

/** Order the closure in a runnable topological order (deps before targets). */
export function topoOrder(wf: Workflow, subset?: Set<string>): string[] {
  const ids = subset ? wf.order.filter((id) => subset.has(id)) : [...wf.order];
  const out: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id) || visiting.has(id)) return;
    visiting.add(id);
    for (const dep of wf.tasks.get(id)!.depends) {
      if (!subset || subset.has(dep)) visit(dep);
    }
    visiting.delete(id);
    done.add(id);
    out.push(id);
  };
  for (const id of ids) visit(id);
  return out;
}

/** Full static validation: deps resolve, no cycles, ids unique. */
export function validateGraph(wf: Workflow): ParseIssue[] {
  const issues = resolveDeps(wf);
  if (issues.some((i) => i.severity === 'error')) return issues;
  const cycle = detectCycle(wf);
  if (cycle) {
    const shown = cycle.length > 6 ? [...cycle.slice(0, 6), '...'] : cycle;
    issues.push({
      severity: 'error',
      message: `dependency cycle detected: ${shown.join(' → ')}`,
    });
  }
  return issues;
}

export function taskDef(wf: Workflow, id: string): TaskDef {
  const def = wf.tasks.get(id);
  if (!def) throw new Error(`unknown task id: ${id}`);
  return def;
}
