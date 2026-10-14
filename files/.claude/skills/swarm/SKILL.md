---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

Fan out N parallel workers, each in its own worktree. They may cover separate slices, race the same brief, or mix both. The parent waits, aggregates, and returns one report.

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Set N from the user or derive it from the shape. N is total workers, not a concurrency limit.
4. Pick the worker model per [`../arena/references/model-families.md`](../arena/references/model-families.md). Use Sonnet 5.5 (`model: "sonnet"`) for bounded slices, Opus 5.5 for slices that need judgment, and GPT through `codex exec` for bulk mechanical slices while Codex has quota. For a model race, name each arm's model up front. In Claude-only mode a race across families becomes Opus 5.5 against Sonnet 5.5, and the report says so. Set each subagent's model and effort per the Model routing and Reasoning effort sections of `~/.claude/CLAUDE.md`: low effort for mechanical stages, high for judgment stages, never Haiku, Fast off.
5. Give each worker its own writable output when it writes. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

## Phase B: Fan out

Spawn all N workers at once. Claude workers are Agent tool calls in one message with `subagent_type: "general-purpose"`, `isolation: "worktree"`, `run_in_background: true`, and the step 4 model. GPT workers run as background `codex exec` commands, each in its own worktree. A long-running worker, or one on another T3 provider, goes through T3's `delegate_task` with `isolation: "worktree"`. Track it by its `taskId` with `task_status`.

When a worker must start from a branch other than the current one, make its worktree from that branch (`git worktree add <path> <branch>`) and give it the path.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
