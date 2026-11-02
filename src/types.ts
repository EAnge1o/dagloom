/** Core data model for dagloom: workflows, tasks, and persisted run state. */

export type TaskKind = 'cmd' | 'agent';

/** A single task parsed from a `## task` section of the workflow file. */
export interface TaskDef {
  /** Slug identifier used in `depends:` references. */
  id: string;
  /** Raw heading text, e.g. "1. Install deps". */
  title: string;
  kind: TaskKind;
  /** Shell command (kind === 'cmd'). May be multi-line from a fenced block. */
  cmd?: string;
  /** Prompt passed to the coding-agent CLI (kind === 'agent'). */
  agentPrompt?: string;
  /** Override binary + fixed args, space-separated; the prompt is appended last. */
  agentCmd?: string;
  /** Resolved dependency ids (slugs). Populated by the DAG module. */
  depends: string[];
  /** Dependency references as written, before resolution (for diagnostics). */
  dependsRaw: string[];
  /** Extra attempts after the first one. */
  retry: number;
  /** Base delay in seconds; attempt n waits backoff * 2^(n-1). */
  backoff: number;
  /** Kill the task after this many seconds. */
  timeout?: number;
  /** Failure is recorded but dependents still run. */
  allowFail: boolean;
  /** Files (relative to the task cwd) that must exist after a successful run. */
  outputs: string[];
  env: Record<string, string>;
  /** Working directory relative to the workflow file's directory. */
  cwd?: string;
  /** Free-text prose under the heading. */
  description: string;
  /** Line number of the heading (1-based) for diagnostics. */
  line: number;
  /** Hash of the semantic fields — used to detect edits between runs. */
  hash: string;
}

/** Global settings from the reserved `## loom` section. */
export interface LoomSettings {
  concurrency: number;
  failFast: boolean;
  agentCmd?: string;
  env: Record<string, string>;
  /** Default timeout (seconds) applied to tasks without their own. */
  taskTimeout?: number;
}

export interface Workflow {
  /** Absolute path of the workflow file. */
  file: string;
  /** Absolute path of the directory containing the workflow file. */
  dir: string;
  settings: LoomSettings;
  /** id → def, in declaration order. */
  tasks: Map<string, TaskDef>;
  /** Declaration order of ids. */
  order: string[];
  /** Lowercased heading text → id, so `depends:` accepts raw titles too. */
  titleIndex: Map<string, string>;
}

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'cancelled';

/** Persisted status of one task within a run. */
export interface TaskState {
  status: TaskStatus;
  attempts: number;
  exitCode: number | null;
  startedAt?: string;
  endedAt?: string;
  /** Accumulated active run time in ms across attempts (excluding backoff). */
  durationMs: number;
  /** Hash of the task def at the time it last ran. */
  hash?: string;
  /** Short failure reason, e.g. "exit 1" or "timeout after 30s". */
  error?: string;
  /**
   * Effective success: done, or failed with allow_fail. Dependents only run
   * when every dependency has ok === true.
   */
  ok?: boolean;
  /**
   * Why a task was skipped: 'user' (--skip flag, sticky) or 'cascade'
   * (a dependency failed — recoverable once deps succeed).
   */
  skipBy?: 'user' | 'cascade';
}

/** The whole persisted run, stored at `.loom/state.json`. */
export interface RunState {
  version: 1;
  runId: string;
  /** Absolute path of the workflow file this run belongs to. */
  workflowFile: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  settings: LoomSettings;
  tasks: Record<string, TaskState>;
  /** Task ids that existed in a previous run but no longer in the workflow. */
  removed: string[];
}
