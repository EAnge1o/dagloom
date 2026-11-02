/**
 * Terminal rendering: colored event lines, the ASCII DAG, run reports.
 * All functions are pure string builders — the CLI decides where they go.
 */

import { buildDependents } from './dag.js';
import type { RunState, TaskState, Workflow } from './types.js';
import { formatDuration, localTime } from './util.js';

const useColor =
  process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const wrap =
  (code: string) =>
  (s: string): string =>
    useColor ? `\x1b[${code}m${s}\x1b[0m` : s;

export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  green: wrap('32'),
  yellow: wrap('33'),
  red: wrap('31'),
  cyan: wrap('36'),
};

export const glyph = {
  pending: '·',
  running: '▶',
  done: '✓',
  failed: '✗',
  skipped: '⊘',
  cancelled: '⏸',
  warned: '⚠',
};

export function statusGlyph(ts: TaskState): string {
  if (ts.status === 'failed' && ts.ok === true) return glyph.warned;
  return glyph[ts.status] ?? glyph.pending;
}

export function statusColor(ts: TaskState, s: string): string {
  if (ts.status === 'done') return c.green(s);
  if (ts.status === 'failed' && ts.ok === true) return c.yellow(s);
  if (ts.status === 'failed') return c.red(s);
  return c.dim(s);
}

/**
 * ASCII DAG, drawn as a forest from the roots (tasks with no dependencies).
 * Tasks reachable by several paths are drawn once and referenced after that.
 */
export function renderGraph(wf: Workflow, tasks?: Record<string, TaskState>): string {
  const dependents = buildDependents(wf);
  const drawn = new Set<string>();
  const out: string[] = [];

  const walk = (id: string, prefix: string, connector: string, isRoot: boolean): void => {
    const def = wf.tasks.get(id)!;
    const ts = tasks?.[id];
    let line = prefix + connector + def.id;
    if (ts) line += ' ' + statusColor(ts, statusGlyph(ts));
    if (drawn.has(id)) {
      out.push(c.dim(`${line}  (already drawn above)`));
      return;
    }
    drawn.add(id);
    out.push(line);
    const kids = dependents.get(id) ?? [];
    kids.forEach((kid, i) => {
      const last = i === kids.length - 1;
      const kidPrefix = isRoot ? '' : prefix + (connector.startsWith('└') ? '    ' : '│   ');
      walk(kid, kidPrefix, last ? '└─▶ ' : '├─▶ ', false);
    });
  };

  for (const id of wf.order) {
    if (wf.tasks.get(id)!.depends.length === 0) walk(id, '', '', true);
  }
  // Tasks inside cycles never appear from a root — draw them flat so `graph`
  // still shows every task (validate will refuse to run them anyway).
  for (const id of wf.order) {
    if (!drawn.has(id)) walk(id, '', '', true);
  }
  return out.join('\n');
}

export interface ReportLine {
  glyph: string;
  id: string;
  duration?: string;
  attempts?: number;
  note?: string;
}

/** Compact report used by `run` (at the end) and `show`. */
export function renderReport(wf: Workflow, st: RunState): string {
  const lines: ReportLine[] = [];
  for (const id of wf.order) {
    const ts = st.tasks[id];
    if (!ts) continue;
    const note: string[] = [];
    if (ts.error && ts.status !== 'done') note.push(ts.error);
    if (ts.status === 'skipped') {
      // reason was folded into error by the runner; keep it readable
      if (!ts.error) note.push('skipped');
    }
    if (ts.status === 'done') note.push('ok');
    if (ts.status === 'failed' && ts.ok === true) note.push('allow_fail — dependents continued');
    lines.push({
      glyph: statusGlyph(ts),
      id,
      duration: ts.durationMs > 0 || ts.status === 'running' ? formatDuration(ts.durationMs) : undefined,
      attempts: ts.attempts > 1 ? ts.attempts : undefined,
      note: note.join(' · ') || undefined,
    });
  }
  for (const id of st.removed) {
    lines.push({ glyph: glyph.cancelled, id, note: 'no longer in workflow' });
  }

  const width = Math.max(8, ...lines.map((l) => l.id.length));
  const body = lines.map((l) => {
    const cols = [`  ${l.glyph} ${l.id.padEnd(width)}`];
    cols.push((l.duration ?? '').padStart(8));
    const flags: string[] = [];
    if (l.attempts) flags.push(`×${l.attempts}`);
    if (l.note) flags.push(l.note);
    cols.push(flags.length > 0 ? `  ${flags.join(' · ')}` : '');
    return cols.join('');
  });

  const counts = countStatuses(wf, st);
  const parts: string[] = [];
  const push = (n: number, label: string) => {
    if (n > 0) parts.push(`${n} ${label}`);
  };
  push(counts.done, 'done');
  push(counts.failed, 'failed');
  push(counts.warned, 'warned');
  push(counts.running, 'running');
  push(counts.skipped, 'skipped');
  push(counts.cancelled, 'cancelled');
  push(counts.pending, 'pending');

  const total = Object.values(st.tasks).reduce((acc, t) => acc + t.durationMs, 0);
  const head = c.bold(`🧵 dagloom · run ${st.runId}`);
  let summary = `${wf.order.length} tasks · ${parts.join(' · ')}`;
  if (total > 0) summary += ` · task time ${formatDuration(total)}`;
  const out = [head, ...body, '', summary];
  const unfinished = counts.pending + counts.running + counts.cancelled;
  if (unfinished > 0 && !st.finishedAt) {
    out.push(c.dim(`resume with: dagloom run`));
  }
  return out.join('\n');
}

export function countStatuses(
  wf: Workflow,
  st: RunState,
): Record<'done' | 'failed' | 'warned' | 'running' | 'skipped' | 'cancelled' | 'pending', number> {
  const counts = { done: 0, failed: 0, warned: 0, running: 0, skipped: 0, cancelled: 0, pending: 0 };
  for (const id of wf.order) {
    const ts = st.tasks[id];
    if (!ts) continue;
    if (ts.status === 'failed' && ts.ok === true) counts.warned++;
    else if (ts.status === 'failed') counts.failed++;
    else if (ts.status in counts) counts[ts.status as keyof typeof counts]++;
  }
  return counts;
}

/** One-line-per-task listing for `list`. */
export function renderList(wf: Workflow): string {
  const out: string[] = [];
  for (const id of wf.order) {
    const def = wf.tasks.get(id)!;
    const icon = def.kind === 'agent' ? '🤖' : '$';
    const flags: string[] = [];
    if (def.retry > 0) flags.push(`retry=${def.retry}`);
    if (def.timeout) flags.push(`timeout=${def.timeout}s`);
    if (def.allowFail) flags.push('allow_fail');
    if (def.outputs.length > 0) flags.push(`outputs=${def.outputs.join('|')}`);
    const desc = def.description ? ` — ${truncate(def.description, 70)}` : '';
    const deps = def.dependsRaw.length > 0 ? ` ← ${def.dependsRaw.join(', ')}` : '';
    out.push(`${icon} ${c.bold(def.id)}${deps}${flags.length > 0 ? c.dim(`  [${flags.join(' ')}]`) : ''}${c.dim(desc)}`);
  }
  return out.join('\n');
}

export function eventLine(e: { type: string; [k: string]: unknown }): string | null {
  switch (e.type) {
    case 'note':
      return c.dim(`· ${e.message as string}`);
    case 'task_start': {
      const attempt = (e.attempt as number) > 1 ? c.dim(` (attempt ${e.attempt as number})`) : '';
      return `${c.dim(localTime())} ${c.cyan(glyph.running)} ${c.bold(e.id as string)}${attempt}`;
    }
    case 'task_retry':
      return `${c.yellow(glyph.failed)} ${c.bold(e.id as string)} ${c.dim(
        `${e.reason as string} — retrying in ${Math.round((e.delayMs as number) / 100) / 10}s`,
      )}`;
    case 'task_done': {
      const st = e.state as TaskState;
      return `${c.dim(localTime())} ${c.green(glyph.done)} ${c.bold(e.id as string)} ${c.dim(
        formatDuration(st.durationMs),
      )}`;
    }
    case 'task_failed': {
      const st = e.state as TaskState;
      if (e.allowed === true) {
        return `${c.yellow(glyph.warned)} ${c.bold(e.id as string)} ${c.yellow(
          `failed (${st.error}) — allow_fail, dependents continue`,
        )}`;
      }
      return `${c.red(glyph.failed)} ${c.bold(e.id as string)} ${c.red(
        st.error ?? 'failed',
      )} ${c.dim(`log: .loom/logs/…/${e.id as string}.log`)}`;
    }
    case 'task_skipped':
      return `${c.dim(glyph.skipped)} ${c.dim(e.id as string)} ${c.dim(`(${e.reason as string})`)}`;
    case 'task_cancelled':
      return `${c.red(glyph.cancelled)} ${c.bold(e.id as string)} ${c.red('cancelled')}`;
    default:
      return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
