#!/usr/bin/env node
/**
 * dagloom CLI — the workflow loom for coding agents.
 *
 * Commands: init · validate · list · graph · run · status · show · clean
 */

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateGraph } from './dag.js';
import { parseWorkflowFile, WORKFLOW_FILE, type ParseIssue } from './markdown.js';
import { Runner, UsageError, type RunEvent } from './runner.js';
import { cleanState, loadRunState, stateExists } from './state.js';
import { c, eventLine, renderGraph, renderList, renderReport } from './ui.js';
import { fileExists } from './util.js';

const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return pkg.version as string;
  } catch {
    return '0.0.0-dev';
  }
})();

const INIT_TEMPLATE = `# 🧵 My workflow

This file is a dagloom workflow. Every \`## Heading\` is a task; tasks run as a
DAG in dependency order, in parallel where possible. Lines like "cmd: ..." are
fields; ordinary prose is the task description. Edit the commands below, then:

    dagloom validate   # check the DAG
    dagloom graph      # see it
    dagloom run        # weave it

## loom

concurrency: 4
fail_fast: false

## install

Pretend to install dependencies. Replace with a real command.

cmd: node -e "console.log('install: done')"

## build

Pretend to build, after install.

depends: install
cmd: node -e "console.log('build: done')"

## lint

Runs in parallel with build — both only need install.

depends: install
cmd: node -e "console.log('lint: clean')"

## test

Retries twice when it fails; depends on build and lint.

depends: build, lint
retry: 2
cmd: node -e "console.log('test: green')"

## report

Writes a file, and dagloom checks it exists (outputs gate).

depends: test
cmd: node -e "require('fs').mkdirSync('.loom', {recursive: true}); require('fs').writeFileSync('.loom/report.txt', 'ok')"
outputs: .loom/report.txt
`;

interface ParsedArgs {
  command: string;
  file?: string;
  fresh: boolean;
  force: boolean;
  failFast: boolean | undefined;
  dryRun: boolean;
  quiet: boolean;
  verbose: boolean;
  json: boolean;
  yes: boolean;
  concurrency?: number;
  only: string[];
  skip: string[];
  env: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: 'help',
    fresh: false,
    force: false,
    failFast: undefined,
    dryRun: false,
    quiet: false,
    verbose: false,
    json: false,
    yes: false,
    only: [],
    skip: [],
    env: [],
  };
  const valued = new Set(['concurrency', 'only', 'skip', 'env']);
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i]!;
    if (!a.startsWith('-')) {
      positional.push(a);
      continue;
    }
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    let value: string | undefined;
    const eq = a.indexOf('=');
    if (eq > 0) {
      value = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    const key = a.replace(/^--?/, '').toLowerCase();
    const needValue = () => {
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) throw new UsageError(`flag ${a} needs a value`);
      }
      return value;
    };
    switch (key) {
      case 'h':
      case 'help':
        args.command = 'help';
        return args;
      case 'v':
      case 'version':
        args.command = 'version';
        return args;
      case 'fresh':
        args.fresh = true;
        break;
      case 'force':
        args.force = true;
        break;
      case 'fail-fast':
        args.failFast = true;
        break;
      case 'no-fail-fast':
        args.failFast = false;
        break;
      case 'dry-run':
        args.dryRun = true;
        break;
      case 'q':
      case 'quiet':
        args.quiet = true;
        break;
      case 'verbose':
        args.verbose = true;
        break;
      case 'json':
        args.json = true;
        break;
      case 'y':
      case 'yes':
        args.yes = true;
        break;
      case 'concurrency':
      case 'c': {
        const n = Number(needValue());
        if (!Number.isInteger(n) || n < 1 || n > 64) {
          throw new UsageError('--concurrency must be an integer between 1 and 64');
        }
        args.concurrency = n;
        break;
      }
      case 'only':
        args.only.push(...needValue().split(',').map((s) => s.trim()).filter(Boolean));
        break;
      case 'skip':
        args.skip.push(...needValue().split(',').map((s) => s.trim()).filter(Boolean));
        break;
      case 'env':
        args.env.push(...needValue().split(',').map((s) => s.trim()).filter(Boolean));
        break;
      default:
        throw new UsageError(`unknown flag: ${a} (see: dagloom --help)`);
    }
  }
  const commands = new Set(['init', 'validate', 'lint', 'list', 'graph', 'run', 'status', 'show', 'clean', 'version', 'help']);
  if (positional.length > 0 && commands.has(positional[0]!)) {
    args.command = positional.shift()!;
  } else if (positional.length > 0) {
    throw new UsageError(`unknown command: ${positional[0]} (see: dagloom --help)`);
  }
  if (positional.length > 0) args.file = positional.shift();
  if (positional.length > 0) throw new UsageError(`unexpected argument: ${positional[0]}`);
  return args;
}

async function loadWorkflow(file: string | undefined) {
  const wfFile = path.resolve(file ?? WORKFLOW_FILE);
  if (!(await fileExists(wfFile))) {
    throw new UsageError(
      `no workflow file at ${wfFile} — create one with "dagloom init" or pass a path`,
    );
  }
  const { workflow, issues } = await parseWorkflowFile(wfFile);
  return { workflow, issues };
}

function printIssues(issues: ParseIssue[], quiet: boolean): boolean {
  let hasErrors = false;
  for (const issue of issues) {
    if (issue.severity === 'error') {
      hasErrors = true;
      console.error(`${c.red('error')}${issue.line !== undefined ? ` (line ${issue.line})` : ''}: ${issue.message}`);
    } else if (!quiet) {
      console.error(`${c.yellow('warn')}${issue.line !== undefined ? ` (line ${issue.line})` : ''}: ${issue.message}`);
    }
  }
  return hasErrors;
}

async function cmdInit(args: ParsedArgs): Promise<number> {
  const file = path.resolve(args.file ?? WORKFLOW_FILE);
  if ((await fileExists(file)) && !args.force) {
    console.error(`${c.red('error')}: ${file} already exists — use --force to overwrite`);
    return 2;
  }
  await writeFile(file, INIT_TEMPLATE, 'utf8');
  console.log(`${c.green('✓')} wrote ${file}`);
  console.log('next:');
  console.log(`  ${c.cyan('dagloom validate')}   # check the DAG`);
  console.log(`  ${c.cyan('dagloom graph')}      # see the plan`);
  console.log(`  ${c.cyan('dagloom run')}        # weave it`);
  return 0;
}

async function cmdValidate(args: ParsedArgs): Promise<number> {
  const { workflow, issues } = await loadWorkflow(args.file);
  const all = [...issues, ...validateGraph(workflow)];
  const hasErrors = printIssues(all, args.quiet);
  if (hasErrors) {
    console.error(`${c.red('✗')} ${workflow.file} — not a valid workflow`);
    return 2;
  }
  console.log(
    `${c.green('✓')} ${workflow.file} — ${workflow.order.length} tasks, deps resolve, no cycles`,
  );
  return 0;
}

async function cmdList(args: ParsedArgs): Promise<number> {
  const { workflow, issues } = await loadWorkflow(args.file);
  if (printIssues(issues, args.quiet)) return 2;
  console.log(renderList(workflow));
  return 0;
}

async function cmdGraph(args: ParsedArgs): Promise<number> {
  const { workflow, issues } = await loadWorkflow(args.file);
  if (printIssues(issues, args.quiet)) return 2;
  if (printIssues(validateGraph(workflow), args.quiet)) return 2;
  const st = (await stateExists(workflow)) ? (await loadRunState(workflow))?.tasks : undefined;
  console.log(renderGraph(workflow, st));
  return 0;
}

async function cmdRun(args: ParsedArgs): Promise<number> {
  const { workflow, issues } = await loadWorkflow(args.file);
  if (printIssues(issues, args.quiet)) return 2;
  if (printIssues(validateGraph(workflow), args.quiet)) return 2;

  const env: Record<string, string> = {};
  for (const kv of args.env) {
    const eq = kv.indexOf('=');
    if (eq <= 0) throw new UsageError(`--env expects KEY=VALUE, got "${kv}"`);
    env[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
  }

  if (args.verbose) process.env.DAGLOOM_VERBOSE = '1';

  const runner = new Runner(workflow, {
    fresh: args.fresh,
    only: args.only.length > 0 ? args.only : undefined,
    skip: args.skip.length > 0 ? args.skip : undefined,
    concurrency: args.concurrency,
    failFast: args.failFast,
    dryRun: args.dryRun,
    quiet: args.quiet,
    env,
    onEvent: (e: RunEvent) => {
      if (args.json) return;
      if (args.quiet && !['task_failed', 'task_retry', 'task_cancelled', 'note'].includes(e.type)) return;
      const line = eventLine(e);
      if (line) console.log(line);
    },
  });

  if (args.dryRun) {
    const { plan: waves } = await runner.run();
    const plan = waves ?? [];
    if (args.json) {
      console.log(JSON.stringify({ plan }, null, 2));
      return 0;
    }
    console.log(c.bold(`dry run — ${plan.length} wave(s), ▶ would run in this order:`));
    plan.forEach((wave, i) => {
      console.log(`  wave ${i + 1} (${wave.length} parallel): ${wave.join(', ')}`);
    });
    return 0;
  }

  const result = await runner.run();
  if (args.json) {
    const { state } = result;
    console.log(
      JSON.stringify(
        {
          ok: result.ok,
          cancelled: result.cancelled,
          runId: state.runId,
          workflow: workflow.file,
          startedAt: state.startedAt,
          finishedAt: state.finishedAt ?? null,
          tasks: state.tasks,
        },
        null,
        2,
      ),
    );
  } else if (!args.quiet) {
    console.log();
    console.log(renderReport(workflow, result.state));
  }
  return result.ok ? 0 : 1;
}

async function cmdStatus(args: ParsedArgs): Promise<number> {
  const { workflow } = await loadWorkflow(args.file);
  const st = await loadRunState(workflow);
  if (!st) {
    console.log('no run state yet — start one with "dagloom run"');
    return 0;
  }
  if (args.json) {
    console.log(JSON.stringify(st, null, 2));
    return 0;
  }
  console.log(renderReport(workflow, st));
  return 0;
}

async function cmdShow(args: ParsedArgs): Promise<number> {
  return cmdStatus(args);
}

async function cmdClean(args: ParsedArgs): Promise<number> {
  const { workflow } = await loadWorkflow(args.file);
  await cleanState(workflow);
  console.log(`${c.green('✓')} removed ${path.join(workflow.dir, '.loom')}`);
  return 0;
}

const HELP = `
🧵 dagloom v${VERSION} — the workflow loom for coding agents

Weave shell commands and coding-agent tasks into a DAG. Parallel where
possible, resumable always, zero dependencies.

USAGE
  dagloom <command> [file] [flags]

COMMANDS
  init [file]        scaffold a ${WORKFLOW_FILE} template
  validate [file]    check syntax, dependencies and cycles (alias: lint)
  list [file]        show tasks with their deps and flags
  graph [file]       draw the DAG (with live status when a run exists)
  run [file]         run the workflow (resumes a previous run by default)
  status [file]      show the current/last run state (alias of show)
  clean [file]       delete .loom state and logs
  help               this text
  version            print version

RUN FLAGS
  --fresh            ignore saved state and start over
  --only a,b         run targets a,b plus their dependencies
  --skip a,b         mark tasks as skipped for this run
  --concurrency N    max tasks in parallel (default: loom section, else 4)
  --fail-fast        stop everything on the first hard failure
  --dry-run          print the execution plan (waves) without running
  --env K=V,K2=V2    extra environment for every task
  --quiet            only failures and the summary
  --verbose          stream task output live (also: DAGLOOM_VERBOSE=1)
  --json             machine-readable output
  --force            (init) overwrite an existing workflow file

FORMAT — loom.md
  ## <task name>                 every "## " heading is a task
  cmd: <shell command>           run a shell command
  agent: <prompt>                run a coding-agent CLI (claude/codex/gemini)
  depends: a, b                  dependencies (ids or heading text)
  retry: 2 · backoff: 2          retries with exponential backoff (seconds)
  timeout: 300                   kill the task after N seconds
  allow_fail: true               failure is recorded, dependents still run
  outputs: dist/app.js           task fails if these files don't exist after
  env: K=V, K2=V2                task environment
  cwd: packages/app              working directory for the task
  ## loom                        reserved section: concurrency, fail_fast,
                                 agent_cmd, env, task_timeout

A \`\`\`sh fenced block inside a task is a multi-line script.

EXAMPLES
  dagloom init && dagloom run
  dagloom run --only deploy
  dagloom run --fresh --fail-fast --concurrency 8
  dagloom graph > plan.txt

State lives in .loom/ — add it to .gitignore. Docs: github.com/EAnge1o/dagloom
`.trimEnd();

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'init':
      return cmdInit(args);
    case 'validate':
    case 'lint':
      return cmdValidate(args);
    case 'list':
      return cmdList(args);
    case 'graph':
      return cmdGraph(args);
    case 'run':
      return cmdRun(args);
    case 'status':
    case 'show':
      return cmdStatus(args);
    case 'clean':
      return cmdClean(args);
    case 'version':
      console.log(VERSION);
      return 0;
    default:
      console.log(HELP);
      return 0;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${c.red('error')}: ${msg}`);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  });
