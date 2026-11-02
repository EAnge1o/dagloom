/**
 * The execution engine: picks ready tasks, runs them with a concurrency
 * limit, retries failures with exponential backoff, kills on timeout,
 * persists state after every transition, and stays resumable across runs.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { ancestorClosure } from './dag.js';
import {
  cleanState,
  freshRunState,
  isOk,
  isRunnable,
  loadRunState,
  logFile,
  logsDir,
  reconcile,
  saveRunState,
} from './state.js';
import type { RunState, TaskDef, TaskState, Workflow } from './types.js';
import {
  ensureDir,
  fileExists,
  killTree,
  nowIso,
  shortId,
  sleep,
  slugify,
  which,
} from './util.js';

export class UsageError extends Error {}

export type RunEvent =
  | { type: 'note'; message: string }
  | { type: 'task_start'; id: string; attempt: number }
  | { type: 'task_retry'; id: string; attempt: number; delayMs: number; reason: string }
  | { type: 'task_done'; id: string; state: TaskState }
  | { type: 'task_failed'; id: string; state: TaskState; allowed: boolean }
  | { type: 'task_skipped'; id: string; reason: string }
  | { type: 'task_cancelled'; id: string }
  | { type: 'run_end'; ok: boolean; cancelled: boolean };

export interface RunOptions {
  /** Ignore the saved state and start over. */
  fresh?: boolean;
  /** Run only these targets plus their transitive dependencies. */
  only?: string[];
  /** Mark these tasks as skipped for this run (persisted). */
  skip?: string[];
  concurrency?: number;
  failFast?: boolean;
  dryRun?: boolean;
  quiet?: boolean;
  env?: Record<string, string>;
  onEvent?: (e: RunEvent) => void;
}

export interface RunResult {
  ok: boolean;
  cancelled: boolean;
  failFast: boolean;
  state: RunState;
  /** Topological layers — set for --dry-run. */
  plan?: string[][];
}

const MAX_BACKOFF_MS = 10 * 60 * 1000;

export class Runner {
  private wf: Workflow;
  private opts: RunOptions;
  private emit: (e: RunEvent) => void;
  private concurrency: number;
  private failFastEnabled: boolean;

  private st!: RunState;
  private children = new Map<string, ChildProcess>();
  private inflight = new Map<string, Promise<void>>();
  /** Tasks launched but not yet finished — maintained synchronously in launch(). */
  private active = new Set<string>();
  /**
   * Tasks already given a full attempt budget in THIS run() invocation.
   * Keeps a hard-failed task from being relaunched forever within one run;
   * the next `dagloom run` (resume) starts a fresh set and retries it.
   */
  private attempted = new Set<string>();
  private persistChain: Promise<void> = Promise.resolve();
  private cancelled = false;
  private failFastHit = false;
  private wake: (() => void) | undefined;

  constructor(wf: Workflow, opts: RunOptions = {}) {
    this.wf = wf;
    this.opts = opts;
    this.emit = opts.onEvent ?? (() => {});
    this.concurrency = opts.concurrency ?? wf.settings.concurrency;
    this.failFastEnabled = opts.failFast ?? wf.settings.failFast;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 64) {
      throw new UsageError('--concurrency must be an integer between 1 and 64');
    }
  }

  /** Load/reconcile persisted state and apply --skip / --only selection. */
  private async prepare(): Promise<void> {
    if (this.opts.fresh) await cleanState(this.wf);
    const saved = this.opts.fresh ? null : await loadRunState(this.wf);
    if (!saved) {
      this.st = freshRunState(this.wf);
    } else {
      const rec = reconcile(this.wf, saved);
      this.st = rec.state;
      if (rec.foreign) {
        this.emit({ type: 'note', message: 'state file belongs to a different workflow — starting fresh' });
        this.st = freshRunState(this.wf);
      } else {
        if (rec.edited.length > 0) {
          this.emit({ type: 'note', message: `edited since last run, will re-run: ${rec.edited.join(', ')}` });
        }
        if (rec.added.length > 0) {
          this.emit({ type: 'note', message: `new tasks: ${rec.added.join(', ')}` });
        }
        if (rec.removed.length > 0) {
          this.emit({ type: 'note', message: `removed from workflow: ${rec.removed.join(', ')}` });
        }
      }
    }

    for (const raw of this.opts.skip ?? []) {
      for (const id of this.resolveTargets([raw])) {
        const ts = this.st.tasks[id];
        if (ts && isRunnable(ts)) {
          ts.status = 'skipped';
          ts.skipBy = 'user';
          this.emit({ type: 'task_skipped', id, reason: '--skip flag' });
        }
      }
    }
  }

  /** Resolve raw names (ids, slugs, headings) to existing task ids. */
  private resolveTargets(refs: string[]): string[] {
    const out: string[] = [];
    for (const ref of refs) {
      const id =
        this.wf.tasks.get(ref)?.id ??
        this.wf.tasks.get(slugify(ref))?.id ??
        this.wf.titleIndex.get(ref.toLowerCase());
      if (!id) throw new UsageError(`unknown task "${ref}" (see: dagloom list)`);
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  /** Tasks whose deps are all effectively done and that still need to run. */
  private pickReady(subset?: Set<string>): string[] {
    const ready: string[] = [];
    for (const id of this.wf.order) {
      if (subset && !subset.has(id)) continue;
      if (this.attempted.has(id)) continue;
      const ts = this.st.tasks[id];
      if (!ts || !isRunnable(ts)) continue;
      const def = this.wf.tasks.get(id)!;
      if (def.depends.every((d) => isOk(this.st.tasks[d]!))) ready.push(id);
    }
    return ready;
  }

  /** Mark tasks as skipped when any dependency hard-failed or was skipped. */
  private settleSkips(subset?: Set<string>): void {
    // Cascade-skipped tasks get un-skipped when their dependencies recover.
    for (const id of this.wf.order) {
      if (subset && !subset.has(id)) continue;
      const ts = this.st.tasks[id]!;
      if (ts.status !== 'skipped' || ts.skipBy === 'user') continue;
      const def = this.wf.tasks.get(id)!;
      const depsOk =
        def.depends.length > 0 && def.depends.every((d) => isOk(this.st.tasks[d]!));
      if (depsOk) {
        this.st.tasks[id] = { status: 'pending', attempts: 0, exitCode: null, durationMs: 0 };
        this.emit({ type: 'note', message: `task "${id}" un-skipped — dependencies recovered` });
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of this.wf.order) {
        if (subset && !subset.has(id)) continue;
        const ts = this.st.tasks[id]!;
        if (ts.status !== 'pending') continue;
        const def = this.wf.tasks.get(id)!;
        const bad = def.depends.find((d) => {
          const ds = this.st.tasks[d]!;
          return ds.status === 'skipped' || (ds.status === 'failed' && !isOk(ds));
        });
        if (bad) {
          ts.status = 'skipped';
          ts.skipBy = 'cascade';
          this.emit({ type: 'task_skipped', id, reason: `dependency "${bad}" did not succeed` });
          changed = true;
        }
      }
    }
  }

  async run(): Promise<RunResult> {
    await this.prepare();

    let subset: Set<string> | undefined;
    if (this.opts.only && this.opts.only.length > 0) {
      subset = ancestorClosure(this.wf, this.resolveTargets(this.opts.only));
    }

    if (this.opts.dryRun) {
      const plan = this.plan(subset);
      return { ok: true, cancelled: false, failFast: false, state: this.st, plan };
    }

    const onSignal = (): void => {
      if (this.cancelled) return;
      this.cancelled = true;
      for (const child of this.children.values()) {
        if (child.pid) killTree(child.pid);
      }
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    try {
      await ensureDir(logsDir(this.wf));
      while (!this.cancelled && !this.failFastHit) {
        this.settleSkips(subset);
        for (const id of this.pickReady(subset)) {
          if (this.runningCount() >= this.concurrency) break;
          this.launch(id);
        }
        if (this.runningCount() === 0) {
          this.settleSkips(subset);
          if (this.pickReady(subset).length === 0) break;
          continue;
        }
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = undefined;
      }
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      // Wait for killed children to finish dying, then flush state once more.
      await Promise.all([...this.inflight.values()]);
      await this.persist();
    }

    const failed = this.wf.order.filter((id) => {
      const ts = this.st.tasks[id]!;
      return ts.status === 'failed' && !isOk(ts);
    });
    const ok = failed.length === 0 && !this.cancelled && !this.failFastHit;
    this.st.finishedAt = nowIso();
    this.emit({ type: 'run_end', ok, cancelled: this.cancelled });
    return { ok, cancelled: this.cancelled, failFast: this.failFastHit, state: this.st };
  }

  private runningCount(): number {
    return this.active.size;
  }

  /** Topological plan honouring --only/--skip, for --dry-run. */
  private plan(subset?: Set<string>): string[][] {
    // Simple Kahn layering on the (possibly filtered) subgraph.
    const ids = this.wf.order.filter((id) => !subset || subset.has(id));
    const skipped = new Set(
      ids.filter((id) => this.st.tasks[id]?.status === 'skipped'),
    );
    const indeg = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const id of ids) {
      const deps = this.wf.tasks
        .get(id)!
        .depends.filter((d) => ids.includes(d) && !skipped.has(d));
      indeg.set(id, deps.length);
      for (const d of deps) {
        const list = dependents.get(d) ?? [];
        list.push(id);
        dependents.set(d, list);
      }
    }
    const levels: string[][] = [];
    let frontier = ids.filter((id) => (indeg.get(id) ?? 0) === 0 && !skipped.has(id));
    let seen = frontier.length;
    while (frontier.length > 0) {
      levels.push(frontier);
      const next: string[] = [];
      for (const id of frontier) {
        for (const dep of dependents.get(id) ?? []) {
          const d = (indeg.get(dep) ?? 1) - 1;
          indeg.set(dep, d);
          if (d === 0) next.push(dep);
        }
      }
      seen += next.length;
      frontier = next;
    }
    return levels;
  }

  private launch(id: string): void {
    const def = this.wf.tasks.get(id)!;
    const ts = this.st.tasks[id]!;
    ts.status = 'running';
    ts.startedAt = ts.startedAt ?? nowIso();
    this.active.add(id);
    this.attempted.add(id);
    void this.persist();
    const p = this.execute(def).finally(() => {
      this.active.delete(id);
      this.inflight.delete(id);
      this.children.delete(id);
      void this.persist();
      this.wake?.();
    });
    this.inflight.set(id, p);
  }

  /** Run one task to its final state (including retries/backoff). */
  private async execute(def: TaskDef): Promise<void> {
    const ts = this.st.tasks[def.id]!;
    const maxAttempts = Math.max(0, def.retry) + 1;
    await ensureDir(logsDir(this.wf));
    const cwd = path.resolve(this.wf.dir, def.cwd ?? '.');
    if (!(await fileExists(cwd))) {
      this.finishFailure(def, ts, `cwd not found: ${def.cwd ?? '.'}`, 0, false);
      return;
    }

    let agent: { bin: string; args: string[] } | null = null;
    if (def.kind === 'agent') {
      const resolved = await this.resolveAgent(def);
      if ('error' in resolved) {
        this.finishFailure(def, ts, resolved.error, 0, false);
        return;
      }
      agent = resolved;
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      ts.attempts = attempt;
      ts.hash = def.hash;
      this.emit({ type: 'task_start', id: def.id, attempt });

      const t0 = Date.now();
      const log = await open(logFile(this.wf, def.id), 'a');
      let timedOut = false;
      let child: ChildProcess | null = null;
      try {
        await log.write(`\n=== attempt ${attempt} · ${nowIso()} ===\n`);
        child = this.spawnTask(def, agent, cwd, (chunk) => {
          void log.write(chunk);
          if (process.env.DAGLOOM_VERBOSE === '1') process.stdout.write(chunk);
        });
        this.children.set(def.id, child);
        const timer =
          this.timeoutFor(def) > 0
            ? setTimeout(() => {
                timedOut = true;
                if (child?.pid) killTree(child.pid);
              }, this.timeoutFor(def) * 1000)
            : null;

        const code: number | null = await new Promise((resolve) => {
          child!.once('error', () => resolve(-1));
          child!.once('close', (c) => resolve(typeof c === 'number' ? c : null));
        });
        if (timer) clearTimeout(timer);
        ts.exitCode = code;
        ts.durationMs += Date.now() - t0;

        if (this.cancelled || this.failFastHit) {
          // Killed by SIGINT or by fail-fast — record as cancelled, stay resumable.
          ts.status = 'cancelled';
          ts.error = 'cancelled';
          this.emit({ type: 'task_cancelled', id: def.id });
          return;
        }

        let reason: string | null = null;
        if (timedOut) reason = `timeout after ${this.timeoutFor(def)}s`;
        else if (code === null || code === -1) reason = 'spawn failed (is the command available?)';
        else if (code !== 0) reason = `exit ${code}`;
        else if (def.outputs.length > 0) {
          for (const out of def.outputs) {
            if (!(await fileExists(path.resolve(cwd, out)))) {
              reason = `missing output: ${out}`;
              break;
            }
          }
        }

        if (!reason) {
          ts.status = 'done';
          ts.ok = true;
          ts.error = undefined;
          ts.endedAt = nowIso();
          this.emit({ type: 'task_done', id: def.id, state: { ...ts } });
          return;
        }

        if (attempt < maxAttempts) {
          const delayMs = Math.min((def.backoff * 2 ** (attempt - 1)) * 1000, MAX_BACKOFF_MS);
          this.emit({ type: 'task_retry', id: def.id, attempt, delayMs, reason });
          await this.cancellableSleep(delayMs);
          if (this.cancelled) {
            ts.status = 'cancelled';
            ts.error = 'cancelled';
            this.emit({ type: 'task_cancelled', id: def.id });
            return;
          }
          continue;
        }
        this.finishFailure(def, ts, reason, code, def.allowFail);
        return;
      } finally {
        await log.close();
      }
    }
  }

  private finishFailure(
    def: TaskDef,
    ts: TaskState,
    reason: string,
    code: number | null,
    allowed: boolean,
  ): void {
    ts.status = 'failed';
    ts.error = reason;
    ts.exitCode = code;
    ts.endedAt = nowIso();
    if (allowed) {
      // Failure is recorded, but dependents proceed.
      ts.ok = true;
    } else if (this.failFastEnabled) {
      this.failFastHit = true;
      for (const child of this.children.values()) {
        if (child.pid && child.pid !== undefined) killTree(child.pid);
      }
    }
    this.emit({ type: 'task_failed', id: def.id, state: { ...ts }, allowed });
  }

  private timeoutFor(def: TaskDef): number {
    return def.timeout ?? this.wf.settings.taskTimeout ?? 0;
  }

  private spawnTask(
    def: TaskDef,
    agent: { bin: string; args: string[] } | null,
    cwd: string,
    onData: (chunk: string) => void,
  ): ChildProcess {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.wf.settings.env,
      ...def.env,
      ...this.opts.env,
      DAGLOOM: '1',
      DAGLOOM_TASK: def.id,
    };
    const stdio: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe'];

    let child: ChildProcess;
    if (agent) {
      // The prompt is always the last argument. On POSIX we pass argv
      // directly (any characters are safe). Windows .cmd/.bat shims must go
      // through cmd.exe, where we quote conservatively.
      const isWinShim =
        process.platform === 'win32' && /\.(cmd|bat)$/i.test(agent.bin);
      if (isWinShim) {
        const cmdline = [agent.bin, ...agent.args, def.agentPrompt ?? '']
          .map((a) => `"${String(a).replace(/\r?\n/g, ' ').replace(/"/g, '""')}"`)
          .join(' ');
        child = spawn(cmdline, { cwd, env, stdio, shell: true, windowsHide: true });
      } else {
        child = spawn(agent.bin, [...agent.args, def.agentPrompt ?? ''], {
          cwd,
          env,
          stdio,
          detached: process.platform !== 'win32',
          windowsHide: true,
        });
      }
    } else {
      child = spawn(def.cmd!, {
        cwd,
        env,
        stdio,
        shell: true,
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    return child;
  }

  /** claude / codex / gemini auto-detection, or an explicit agent_cmd override. */
  private async resolveAgent(
    def: TaskDef,
  ): Promise<{ bin: string; args: string[] } | { error: string }> {
    const spec = def.agentCmd ?? this.wf.settings.agentCmd;
    if (spec) {
      const tokens = spec.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return { error: 'agent_cmd is empty' };
      const bin = await which(tokens[0]!);
      if (!bin) return { error: `agent_cmd binary not found: ${tokens[0]}` };
      return { bin, args: tokens.slice(1) };
    }
    const known: Array<[string, string[]]> = [
      ['claude', ['-p']],
      ['codex', ['exec']],
      ['gemini', ['-p']],
    ];
    for (const [cli, args] of known) {
      const bin = await which(cli);
      if (bin) return { bin, args };
    }
    return {
      error:
        'no coding-agent CLI found (tried: claude, codex, gemini) — install one or set agent_cmd',
    };
  }

  private async cancellableSleep(ms: number): Promise<void> {
    const step = 100;
    let waited = 0;
    while (waited < ms && !this.cancelled) {
      await sleep(Math.min(step, ms - waited));
      waited += step;
    }
  }

  /** Serialize state writes so concurrent task completions can't interleave. */
  private async persist(): Promise<void> {
    this.persistChain = this.persistChain.then(() => saveRunState(this.wf, this.st));
    await this.persistChain.catch(() => {});
  }
}
