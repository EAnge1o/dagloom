/** Shared test helpers: temp dirs, workflow files, runner factory. */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseWorkflowSource } from '../src/markdown.js';
import { resolveDeps } from '../src/dag.js';
import { Runner, type RunEvent } from '../src/runner.js';
import type { Workflow } from '../src/types.js';

const execFileP = promisify(execFile);

export async function tempDir(prefix = 'dagloom-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
}

export async function writeWorkflow(
  dir: string,
  source: string,
  name = 'loom.md',
): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, source.replace(/\r\n/g, '\n'), 'utf8');
  return file;
}

/** Write the workflow file, parse it, and hand back a Runner with an event log. */
export async function makeRunner(
  dir: string,
  source: string,
  opts: ConstructorParameters<typeof Runner>[1] = {},
  name = 'loom.md',
): Promise<{ runner: Runner; wf: Workflow; events: RunEvent[]; file: string }> {
  const file = await writeWorkflow(dir, source, name);
  const { workflow } = parseWorkflowSource(source.replace(/\r\n/g, '\n'), file);
  resolveDeps(workflow);
  const events: RunEvent[] = [];
  const runner = new Runner(workflow, {
    ...opts,
    onEvent: (e) => {
      events.push(e);
      opts.onEvent?.(e);
    },
  });
  return { runner, wf: workflow, events, file };
}

/** Status of a task after a run, from the events or via the returned state. */
export function statusOf(
  events: RunEvent[],
  map: Record<string, { status: string }>,
  id: string,
): string {
  return map[id]?.status ?? 'missing';
}

export const CLI = path.resolve(
  path.dirname(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')),
  '../src/cli.js',
);

export function runCli(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return execFileP(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' }).then(
    (r) => ({ stdout: r.stdout, stderr: r.stderr, code: 0 }),
    (err: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }) => ({
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      code: typeof err.code === 'number' ? err.code : 1,
    }),
  );
}

/**
 * Cross-platform "fail the first N attempts" command. Writes a counter file
 * in the task cwd, exits 1 until the counter passes N.
 */
export function failUntil(n: number, counterFile = '.attempts'): string {
  return `node -e "const fs=require('fs');let k=0;try{k=JSON.parse(fs.readFileSync('${counterFile}','utf8')).k}catch{};k++;fs.writeFileSync('${counterFile}',JSON.stringify({k}));console.log('attempt',k);if(k<=${n})process.exit(1)"`;
}
