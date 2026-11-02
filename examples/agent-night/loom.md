# 🧵 agent-night — weaving coding-agent tasks

A dagloom workflow whose tasks are prompts for a coding-agent CLI. No
`cmd:` — each task runs `claude`, `codex` or `gemini` (whichever is on your
PATH) with the prompt as its final argument. Set `agent_cmd` in the loom
section to force a specific CLI, e.g. `agent_cmd: claude --model sonnet`.

Agents work best one at a time (they edit the same working tree), so this
workflow sets concurrency: 1 and uses long timeouts.

Overnight usage — let argus-night wrap the whole thing:

    argus-night run --until 07:00 --wrap-up "dagloom run"

## loom

concurrency: 1
task_timeout: 3600

## research

Survey the repository and write RESEARCH.md: modules, entry points, how
tests are organized. Do not modify any code.

agent: Survey this repository and write RESEARCH.md summarizing the modules, entry points, and how tests are organized. Read-only: do not modify code.

## implement

Implement the feature described in FEATURE.md. Run the test suite until it
passes. Commit with a conventional-commit message.

agent: Implement the feature described in FEATURE.md. Run the test suite and iterate until it is green, then commit with a conventional-commit message.
depends: research
retry: 1

## review

Review the latest commit for correctness and style. Write REVIEW.md with
findings ranked by severity. Do not modify code.

agent: Review the latest commit (git log -1) for correctness and style. Write REVIEW.md with findings ranked by severity. Do not modify code.
depends: implement

## changelog

Append a user-facing entry to CHANGELOG.md based on the latest commit and
REVIEW.md.

agent: Append a user-facing entry to CHANGELOG.md describing the latest commit. Base it on the diff and REVIEW.md.
depends: review
allow_fail: true
