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
    lane.json                   repo, local checkout, base branch, verification skill, orchestrator thread id
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
| `state` | Exactly one of `queued`, `in-flight`, `recurring`, `needs-myuser`, `paused`, `done` (the unit-states standing order in every lane's standing orders). `recurring` is standing work that runs again and again, such as a nightly sweep: the map shows its since stamp but never calls it stalled or counts it as in flight, and still lists it under Stuck when it has no owner, a closed owner thread or a blocked PR. Any other value shows as an unreadable row beside the lane and in the map's footer, with the line and why. A unit under review is `in-flight`; one that cannot move is `paused` with the note saying why. |
| `owner` | The owning T3 thread id as stored (`mcp:...`, `thread:...` or a bare uuid), or empty for unassigned. Text may follow the id (`mcp:6fac3fc8-... (c25 queue prep)`), and the id may be cut to its first 8 or more hex characters (`mcp:6fac3fc8`) while only one open thread starts that way; a bare short id needs a hex letter or a dash (`6fac3fc8`, not `20261028`). A reference that matches no open thread reads `no owner thread`, keeps the text after the id, and lists the unit under Stuck on the map; so does an empty owner on an `in-flight` or `recurring` unit. Other text shows as written, with no live state. |
| `branch` | The git branch. |
| `pr` | A PR number, or a short word for things that are not PRs (`push`, `rebuild`, `docs`). Numbers get the ledger's newest verdict and a link to GitHub. For a `needs-myuser` unit that waits on a rebuild after its branch lands, write `rebuild`; write `push` when the owner's turn is the push. |
| `milestone` (optional) | A milestone id. Titles come from `lane.json` `milestones`. Milestones appear in the order of their first unit in the file. |
| `after` (optional) | Comma-separated unit ids this unit waits for. Use `lane/unit` for a unit in another lane. |
| `since` (optional) | When the unit entered its state: `HH:MM` (today, SGT) or an ISO timestamp. An in-flight unit past 8 hours turns yellow and says how long: "in flight 2 d, since 21 Oct 16:31". |
| `note` (optional) | One short line on what is happening. For `needs-myuser`, what the owner has to do. |

Every row has exactly as many fields as the header.
Leave optional cells empty rather than dropping trailing tabs.

A `needs-myuser` unit reaches the board's Needs you list once every unit in its `after` is `done`.
Until then its lane shows it as "then you".

The coordinator writes `after`, `milestone` and `needs-myuser`.
The map shows exactly what was written.
It infers nothing from prose, reviews or GitHub.

One check reads local git: a `needs-myuser` row whose work has already landed gets a yellow "looks stale" line saying why.
The row and its state stay as written; the coordinator fixes the file.
The board runs git in `lane.json`'s `checkout` against `origin/<base>` (`base` defaults to `main`), and never fetches.
So a branch that lands on GitHub shows as stale only after that checkout's next fetch.
A row looks stale when its PR number ends a commit subject on the base (GitHub's `(#12)` squash and merge commits), when its branch is an ancestor of the base, or when `git cherry` finds every commit of the branch on the base (a rebase).
A row whose `pr` is a word other than `push` (`rebuild`, `docs`) is never flagged, because that word names something still the owner's to do after the branch lands.
Neither is a branch still at the commit it was created from, nor a branch that exists only on origin and whose tip is on the base, since without a local reflog that looks the same as an empty branch.
A lane without a `checkout`, or a branch git cannot find, is skipped, and the board's log says why.

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
