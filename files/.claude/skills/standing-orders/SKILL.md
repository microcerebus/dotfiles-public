---
name: standing-orders
description: "Keep a lane's standing orders and the owner's authorizations in durable files and carry them verbatim into every brief, spawn and resume. Use when coordinating multi-thread work (orchestrator, coordinator), when the owner gives a rule or approval that must outlive the current thread, or when writing a worker brief."
---

# Standing orders

Built on pstack's orchestrate playbook (cursor/plugins, MIT, Lauren Tan): "Every spawn and every resume carries the standing orders verbatim. Directives decay across resumes."

## Files

One directory per body of work: `~/orchestrator/lanes/<lane>/`.
Each file has exactly one writer, the orchestrator, unless the file says otherwise.

| File | Holds | Rule |
| --- | --- | --- |
| `standing-orders.md` | Numbered rules from the owner's own words, one constraint per line, with who said it and when | Edit a line before acting on a new or changed rule. Never paraphrase him into something looser. |
| `authorizations.md` | Append-only: `<YYYY-MM-DD HH:MM SGT> <what the owner approved, confirmed done, or ruled out>` | Read before asking the owner anything. If it is here, do not ask again. |
| `owners.md` | Which thread owns which unit right now (title and t3-thread link) | Update on every handoff so peers stop sending to dead threads. |
| `decisions.tsv` | The show-me-your-work decision log for the lane | Append-only. |

## Rules

- Paste `standing-orders.md` verbatim into every new coordinator thread, every worker brief and every resume.
  Link the file too, but the paste is what survives.
- When the owner says something that changes a rule, update the numbered line first, then act, then tell affected threads.
- When he approves or confirms something, append it to `authorizations.md` in the same turn.
- Get timestamps from `TZ=Asia/Singapore date`, never from memory.
- Never copy secrets, user identifiers or personal data into these files.

## Worker brief template

Every field is required.
A brief with a missing field is not sent.

```text
GOAL: <outcome and finish condition, countable>
SCOPE: <repo, worktree, branch, files or packages in bounds>
CONTEXT: <links: issue, PR, resume note, feature map entry>
ACCEPTANCE: <what must be true, observable>
VERIFY: <the proof: verification skill command, screenshots, test names>
TIMEBOX: <hours or context budget; pause-safely at 300k tokens>
FORBIDDEN: <actions needing the owner: deploys, provider settings, containers, merges outside the gates>
REPORT: <who to tell, in what format: plain language, at most 5 lines, no raw IDs>
STANDING: <standing-orders.md pasted verbatim>
```

## Status relays to the owner

Plain language, at most 5 lines per unit: what changed, what is blocked and on whom, what is needed from the owner (or "nothing").
No raw SHAs, tree hashes or user IDs unless he asks.
Put every item that needs the owner in one "Needs the owner" list at the top.
