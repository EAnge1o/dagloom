# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-03

### Added

- `loom.md` markdown workflow format: tasks as `##` sections, `key: value`
  fields, `sh` fenced blocks for multi-line scripts, a reserved `## loom`
  section for global settings.
- DAG engine: dependency resolution, cycle detection, layered parallel
  scheduling with a concurrency limit.
- Task fields: `cmd`, `agent`, `agent_cmd`, `depends`, `retry`, `backoff`,
  `timeout`, `allow_fail`, `outputs`, `env`, `cwd`, `id`.
- Coding-agent tasks with auto-detection of `claude` / `codex` / `gemini` CLIs,
  or any custom CLI via `agent_cmd`.
- Resumable runs persisted to `.loom/state.json` with atomic writes,
  per-task edit detection (hash reset), and retry of failed tasks.
- Exponential backoff between retries; per-task timeout with process-tree kill.
- `--fail-fast` cancellation, graceful SIGINT handling (state stays resumable).
- `allow_fail` tasks: failure recorded, dependents still run.
- `outputs` gate: task fails if declared files are missing after success.
- Commands: `init`, `validate`, `graph`, `run`, `status`, `show`, `list`,
  `clean`.
- Flags: `--fresh`, `--only`, `--skip`, `--concurrency`, `--fail-fast`,
  `--dry-run`, `--quiet`, `--verbose`, `--json`, `--env`.
- ASCII DAG rendering (`graph`) with live run-status glyphs.
- Machine-readable output via `--json`.
- Full unit + e2e test suite (node:test), CI on Linux/macOS/Windows × Node
  20/22/24.
