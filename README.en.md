<div align="center">

[![CI](https://github.com/EAnge1o/dagloom/actions/workflows/ci.yml/badge.svg)](https://github.com/EAnge1o/dagloom/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dagloom)](https://www.npmjs.com/package/dagloom)
[![Node](https://img.shields.io/node/v/dagloom)](package.json)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![zero dependencies](https://img.shields.io/badge/runtime%20deps-0-orange)](package.json)

# 🧵 dagloom — the workflow loom for coding agents

**Weave shell commands and agent tasks into a DAG: parallel where possible, exponential-backoff retries, resumable from any crash, report at the end.**

*Zero runtime dependencies · Node ≥ 20 · Windows / macOS / Linux*

English | [中文](README.md)

</div>

---

## Why

When agents or scripts do real work, the bottleneck is never a single command — it's the **orchestration between them**:

- `&&` chains run serially; fast tasks wait on slow ones forever;
- Make handles dependencies fine, but mixing in agent prompts gets awkward, and there's no resume, no retries, no concurrency limit;
- cron / bash loops don't know which step already succeeded — crash at 2am and morning-you restarts from zero;
- Real orchestrators (Temporal / Airflow / n8n) are powerful but want a service, YAML files, and a pile of dependencies — overkill for a local pipeline.

**dagloom is the minimal patch on that spectrum**: one markdown file declares tasks and dependencies, one command weaves them, state lives in a local `.loom/` directory, and Ctrl+C mid-run still leaves a resumable checkpoint. It's the evolution of [argus-night](https://github.com/EAnge1o/argus-night) (the night watchman: one agent through a linear checklist) — **argus drives one worker overnight, dagloom coordinates the whole crew**, and they stack:

```bash
argus-night run --until 07:00 --wrap-up "dagloom run"
```

## 30-second start

```bash
npx dagloom init        # scaffold loom.md
# …replace the placeholder commands
npx dagloom validate    # syntax, deps, cycles — all at once
npx dagloom graph       # eyeball the DAG first
npx dagloom run         # weave!
```

What a run looks like:

```
02:01:32 ▶ install
02:01:33 ✓ install 190ms
02:01:33 ▶ build
02:01:33 ▶ lint
02:01:34 ✓ lint 817ms
02:01:34 ✓ build 1.2s
02:01:34 ▶ test
✗ test exit 1 — retrying in 1s
02:01:36 ▶ test (attempt 2)
02:01:36 ✓ test 390ms

🧵 dagloom · run 0fb8c96d
  ✓ install     1.7s  ok
  ✓ build       1.2s  ok
  ✓ lint       817ms  ok
  ✓ test       390ms  ×2 · ok
  ✓ report     198ms  ok

5 tasks · 5 done · task time 4.3s
```

## The workflow format: one markdown file

`loom.md` is plain markdown — readable by humans and **directly writable by LLMs** (the core reason markdown beats YAML here: agents natively write markdown, no schema to learn).

````markdown
## loom

concurrency: 4
fail_fast: false

## install

Install dependencies. This prose is the task description, kept in reports.

cmd: npm ci

## build

depends: install
retry: 2
timeout: 300
cmd: npm run build

## smoke-test

A ```sh fenced block is a multi-line script:

depends: build
```sh
set -e
node scripts/smoke.js
node scripts/probe.js
```

## refactor-utils

A task can also be an agent prompt (claude / codex / gemini auto-detected):

depends: build
timeout: 1800
agent: split src/utils.ts into three modules, get tests green, commit
````

### Task fields (all optional except the command itself)

| Field | Default | Meaning |
|---|---|---|
| `cmd:` | — | shell command; a ```` ```sh ```` fenced block is a multi-line `cmd` |
| `agent:` | — | agent prompt, always passed as the final CLI argument |
| `agent_cmd:` | auto-detect | override the agent CLI and its args (e.g. `claude --model sonnet`) |
| `depends:` | none | dependencies (ids or raw heading text), comma-separated |
| `retry:` | 0 | extra attempts after the first |
| `backoff:` | 2 | backoff base in seconds; after failure n wait `backoff × 2^(n-1)`, capped at 10 min |
| `timeout:` | none | seconds before the process tree is killed |
| `allow_fail:` | false | record the failure but let dependents run (shown as ⚠) |
| `outputs:` | none | files that must exist after success, else the task fails (outputs gate) |
| `env:` | — | task environment, `K=V, K2=V2` |
| `cwd:` | workflow dir | task working directory (relative) |
| `id:` | heading slug | override the task id |

The reserved `## loom` section holds global settings: `concurrency` (default 4), `fail_fast`, `agent_cmd`, `env`, `task_timeout`.

### Commands

| Command | What it does |
|---|---|
| `init [file]` | scaffold the template (`--force` to overwrite) |
| `validate [file]` | syntax + dependencies + cycle check, line-numbered errors (alias `lint`) |
| `list [file]` | task list with deps and retry/timeout/allow_fail flags |
| `graph [file]` | ASCII DAG, with status dots when a run exists |
| `run [file]` | execute; **resumes the previous run by default**, `--fresh` to start over |
| `status [file]` | current/last run state (`--json` for machines) |
| `clean [file]` | delete `.loom/` state and logs |

### run flags

```bash
dagloom run --fresh                  # ignore history, run everything
dagloom run --only deploy            # deploy plus its dependencies only
dagloom run --skip lint              # skip lint this run (dependents cascade-skip)
dagloom run --concurrency 8          # parallelism cap
dagloom run --fail-fast              # cancel everything on first hard failure
dagloom run --dry-run                # print the wave plan, run nothing
dagloom run --env CI=1 --quiet       # inject env / quiet mode
dagloom run --json                   # machine-readable results
dagloom run --verbose                # stream task output live
```

## How resuming works

State lives in `.loom/state/<workflow-name>.json` (written atomically on every task transition) plus `.loom/logs/<workflow-name>/<task>.log` (full output of every attempt):

- **done tasks don't re-run** — resume only fills the gaps;
- **failed tasks retry** — with a fresh attempt budget;
- **you edited a task's command** — detected by content hash, only the edited task re-runs, other results survive;
- **tasks added / removed** — noted in the report as added / removed;
- **cascade-skipped tasks** — revive automatically once their dependencies succeed; user `--skip` choices stay sticky;
- **Ctrl+C / power loss / closed terminal** — running tasks are marked cancelled; the next `run` continues from the checkpoint.

## How it fits with argus-night and the tape trio

Together these tools form a complete flight recorder + cockpit:

| Project | Domain |
|---|---|
| [argus-night](https://github.com/EAnge1o/argus-night) | single-agent overnight watch: quota resume, heartbeat watchdog, morning report |
| **dagloom** (this project) | multi-task DAG orchestration: parallelism, retries, resume, report |
| [tapedeck](https://github.com/EAnge1o/tapedeck) | record/replay and regression-diff for LLM agents |
| [mcptape](https://github.com/EAnge1o/mcptape) | record/replay for MCP servers |
| [mocktape](https://github.com/EAnge1o/mocktape) | record/replay for HTTP APIs |

dagloom's agent tasks call real CLIs, so what tapedeck records and what argus-night's quota strategy handles plug straight into a dagloom workflow.

## Design principles

1. **Zero runtime dependencies** — `node_modules` holds nothing but the TypeScript compiler at build time; the npm package works as installed, minimal supply-chain surface.
2. **Files first** — workflows are markdown, state is JSON, logs are plain text. No database, no daemon; `rm -rf .loom` is a complete reset.
3. **Agent native** — LLMs write markdown, so agents can maintain their own workflows; prompts are always the final argument, so any CLI plugs in.
4. **Boring tech** — `child_process.spawn`, `fs.rename`, `node:test`. No clever abstractions, just code that works at 3am.

## FAQ

**Q: Why not YAML?**
YAML needs a parser (under the zero-dependency rule I'd have to write one, and YAML's edge cases are a book of their own), and agents write YAML less reliably than markdown. dagloom's grammar is three rules: `## heading` is a task, `key: value` is a field, fenced blocks are scripts.

**Q: How is this different from make?**
make tracks file timestamps; dagloom tracks task outcomes and checkpoints. make doesn't retry, cap concurrency, keep logs, take agent prompts, or offer `--fresh`/`--only`/`--skip`, and it can't tell you which step failed last night.

**Q: Should I commit the state directory?**
No. Add `.loom/` to `.gitignore` after `init`.

**Q: Multiple workflows in one directory?**
Yes. State and logs are namespaced per workflow file: `loom.md` and `release.md` don't touch each other.

**Q: Quotes or newlines in agent prompts?**
On POSIX the prompt goes through argv verbatim (no shell). Windows `.cmd` shims must pass through cmd.exe, where prompts are flattened to one line with quotes doubled — for complex prompts, write the details to a file and tell the agent to read it.

**Q: Does it work in CI?**
Yes — `--json` plus exit codes: 0 all green, 1 hard failure, 2 usage/validation error.

## Roadmap

- [ ] `dagloom watch` — re-run affected tasks on file changes
- [ ] single-file HTML run report
- [ ] per-task attempt history across runs
- [ ] remote agents (HTTP instead of local CLI)

## Development

```bash
npm install
npm test        # tsc + node --test, 64 test cases
```

CI covers Linux / macOS / Windows × Node 20 / 22 / 24.

## License

[MIT](LICENSE) © EAnge1o
