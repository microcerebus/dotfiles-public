---
name: pause-safely
description: "Stop at a safe boundary, make the work durable, and leave a resume note a fresh thread can pick up. Use when told to pause or stop, before going offline or a restart, when context passes about 300k tokens at a phase boundary (always before 500k), or when a provider usage limit is about to cut the session off. Never on 'keep going'."
---

# Pause safely

Adapted from pstack's pause-safely playbook (cursor/plugins, MIT, Lauren Tan) for Claude Code in T3 Code.
Auto-compact is off on purpose.
A thread that fills its context dies mid-command and loses whatever lived only in it, so leave before that happens.

## When

- the owner or the orchestrator says pause, stop or wrap up.
- Context is past about 300k tokens and you are at a phase boundary, or near 500k at any point.
  The per-turn hook prints the count; otherwise run `python3 -I ~/.claude/skills/recall/scripts/recall.py context`.
- A usage-limit warning, or a provider or model switch, is coming.
- Not on "keep going", "going to bed, keep going" or "don't stop".

## Steps

1. **Stop at a safe boundary.**
   Finish the current atomic step or back out of it.
   Start nothing new.
   Let running native subagents and workflow stages finish, or stop them and list them in the note.
   They die with this session, and nothing reports the death: they have no T3 run rows.
2. **Take no irreversible action to pause.**
   No merge, no new PR, no push unless the branch is already pushed.
3. **Make the work durable.**
   Commit uncommitted edits as one `wip: <what>` commit on the current work branch, never on `main`.
   If the tree is broken, say so in one line of the commit body.
   Never delete a worktree, reset or stash to pause.
4. **Write the resume note to a file**, not only to chat: `<worktree>/.resume/<YYYY-MM-DD-HHMM>-<slug>.md`, using the template below.
   `.resume/` is in the global gitignore, so the note never rides along in a commit; check with `git check-ignore .resume`.
   Get the time from `TZ=Asia/Singapore date`.
   If a show-me-your-work decision log exists, point at it instead of repeating it.
   List every worker this thread started that has not reported, under "Workers".
   A native worker's brief must be on disk: if it lived only in the spawn prompt, save it to `.resume/briefs/<name>.md`.
   Never write that this thread "still hosts" or has work "still running in" it; after the pause nothing runs there.
   `write_guard.py` and `bash_guard.py` flag that wording in resume notes and `~/orchestrator`.
5. **Hand over.**
   In an orchestrated lane, send the orchestrator one message with `t3_thread_send`: thread title, resume note path, wip commit SHA, and the first action on resume.
   The orchestrator owns the lane files and records the pointer there.
6. **Stop.**
   Reply with where you are, what is on disk versus only in your head, the commits and whether the tree is clean, and the first action on resume.
   This is a pause, not a final report.

## Resume note template

```markdown
# Resume: <task> (<YYYY-MM-DD HH:MM SGT>)

Thread: <title> (t3-thread://v1/<id>) - model <model/effort>
Worktree: <path>  Branch: <branch>  HEAD: <sha>  Tree: clean | wip commit <sha>
Standing orders: <path, if any>
Decision log: <path, if any>
Transcript: <path from `recall.py self`>

## Goal
<the brief's goal and finish condition, verbatim>

## Done and verified
- <item> - evidence: <PR, SHA, artifact path, command and result>

## In flight, not verified
- <item> - what is left to prove

## Workers
- native | <task> | brief: <path on disk> | passed so far: <checks, commits, artifacts> - dies with this thread; the successor respawns it first
- T3 task <taskId> (thread <childThreadId>) | <task> | brief: <path> | passed so far: <...> - survives; read its result with `t3_thread_read` on the child thread
- none

## the owner's decisions and confirmations
- <HH:MM SGT> <what he approved, said is done, or ruled out> (so the successor never re-asks)

## Next steps
1. <first action on resume, concrete>
2. ...

## Things to re-establish
- PR watches, linked PRs, scheduled tasks, background commands, open Lavish pages

## Gotchas
- <traps, flaky checks, things that looked true and were not>
```
