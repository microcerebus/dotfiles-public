# Orchestrator lane template

Scaffolding for one body of agent work, following `docs/agent-team.md`.
Copy this directory to `~/orchestrator/lanes/<lane>/` and fill in the placeholders.

## Proposed `~/orchestrator` layout

```text
~/orchestrator/                 private git repo; the heartbeat is the only committer
  board.md                      what the owner reads: Needs the owner, lanes, PRs, links (was todo.md)
  overnight.md                  the current run's contract: limits, risks, heartbeat checklist
  log.md                        append-only heartbeat and orchestrator log
  bin/orch                      CLI: status, lane new, brief lint (grows from status.mjs)
  references/                   poteto articles and other shared reading
  lanes/<lane>/
    lane.json                   repo, base branch, verification skill, orchestrator thread id
    standing-orders.md          numbered rules in the owner's words (orchestrator writes)
    authorizations.md           append-only approvals and "done" confirmations (orchestrator writes)
    owners.md                   unit -> owning thread (coordinator writes)
    units.tsv                   unit, branch, PR, owner, state (coordinator writes)
    ledger.tsv                  verdict per head SHA (verifiers append)
    decisions.tsv               show-me-your-work log (coordinator and workers append)
    status.md                   derived by `orch status`; never hand-edited
    briefs/<unit>.md            one brief per unit, linted before sending
    resume/                     pointers to resume notes in worktrees
```

Every file has one writer.
Append-only files are never rewritten.

## Keep from the 10 Oct improvised version

- `status.mjs`, the read-only snapshot, becomes `orch status` and loops over `lanes/*/lane.json` instead of one hardcoded repo.
- `overnight.md` stays as the per-run contract with its risk table and heartbeat checklist.
- Fresh-thread heartbeats and the 09:45 morning brief stay.

## Fix

- The orchestrator thread reached about 380k tokens on night two.
  Rotate it daily through `session-pickup` from `board.md` and the lane files.
- Approvals lived in chat and died with threads.
  They go to `authorizations.md` in the same turn.
- Threads were addressed by id from memory.
  `owners.md` is the address book.
