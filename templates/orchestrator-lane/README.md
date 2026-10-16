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
    units.tsv                   one row per unit; see "units.tsv and the project map" (coordinator writes)
    ledger.tsv                  verdict per head SHA (verifiers append)
    decisions.tsv               show-me-your-work log (coordinator and workers append)
    status.md                   derived by `orch status`; never hand-edited
    briefs/<unit>.md            one brief per unit, written from ~/dotfiles/templates/orchestrator-lane/briefs/TEMPLATE.md, linted before sending
    resume/                     pointers to resume notes in worktrees
```

Every file has one writer.
Append-only files are never rewritten.

## units.tsv and the project map

The agent board's `/map` page reads `lane.json`, `units.tsv` and `ledger.tsv` on every request.
It never writes.

Columns are matched by header name, so order and extra columns do not matter.
A file without a `unit` or `state` header is rejected whole.

| Column | Holds |
| --- | --- |
| `unit` | `[a-z0-9][a-z0-9-]*`, unique in the file. A leading `#` is accepted and dropped. |
| `state` | Exactly one of `queued`, `in-flight`, `review`, `needs-myuser`, `blocked`, `paused`, `done`. Any other value skips the row, and the map's footer says which line and why. |
| `owner` | The owning T3 thread id as stored (`mcp:...`, `thread:...` or a bare uuid), or empty for unassigned. Other text shows as written, with no live state. |
| `branch` | The git branch. |
| `pr` | A PR number, or a short word for things that are not PRs (`rebuild`, `docs`). Numbers get the ledger's newest verdict and a link to GitHub. |
| `milestone` (optional) | A milestone id. Titles come from `lane.json` `milestones`. Milestones appear in the order of their first unit in the file. |
| `after` (optional) | Comma-separated unit ids this unit waits for. Use `lane/unit` for a unit in another lane. |
| `since` (optional) | When the unit entered its state: `HH:MM` (today, SGT) or an ISO timestamp. In-flight, review and blocked units past 8 hours read "stalled". |
| `note` (optional) | One short line on what is happening. For `needs-myuser`, what the owner has to do. |

Every row has exactly as many fields as the header.
Leave optional cells empty rather than dropping trailing tabs.

A `needs-myuser` unit reaches the board's Needs you list once every unit in its `after` is `done`.
Until then its lane shows it as "then you".

The coordinator writes `after`, `milestone` and `needs-myuser`.
The map shows exactly what was written.
It infers nothing from prose, reviews or GitHub.

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
