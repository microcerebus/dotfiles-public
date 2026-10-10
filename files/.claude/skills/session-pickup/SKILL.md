---
name: session-pickup
description: "Resume or take over a predecessor thread's work from its resume note, transcript and repo state without redoing it. Use when a brief says 'you are taking over', 'resume from', or points at a resume note or a dead or paused thread."
---

# Session pickup

Adapted from pstack's session-pickup playbook (cursor/plugins, MIT, Lauren Tan) for Claude Code in T3 Code.
You own the resume point.
Read the prior trail and do not redo it.

## Steps

1. **Load the standing orders first** if the lane has them (`~/orchestrator/lanes/<lane>/standing-orders.md`).
   They override anything older in the trail.
2. **Locate the trail.**
   In order: the resume note named in the brief (`<worktree>/.resume/`), the lane's authorizations log, the predecessor's T3 thread (`t3_thread_read` in small pages, last messages first), and its transcript.
   Find transcripts with `python3 -I ~/.claude/skills/recall/scripts/recall.py sessions --cwd <worktree>`.
   Parse a long transcript in a subagent and keep only its summary.
3. **Respawn the note's native workers first.**
   Native subagents and workflow stages died with the predecessor; nothing else will notice.
   Respawn each one from its brief path, and include what it had already passed so it does not redo it.
   T3 delegated tasks and threads survive: check each ID is still running or read its result with `t3_thread_read`.
   If the note says the old thread "still hosts" or is "still running" a worker, treat that worker as dead and respawn it.
4. **Reconstruct state.**
   Branch, worktree, what landed (`git log`, `git diff <base>...`), open PRs (`gh pr list`), open todos and decisions.
   The trail is authoritative input.
   Resist re-deriving it.
5. **Diff done against pending.**
   Do not rerun the prior repro or redo finished work.
   A "verify everything from scratch" pass treats an authoritative trail as untrustworthy and burns the context you just freed.
6. **Never re-ask the owner** for anything the trail records as done, approved or ruled out.
   Messages may have been sent to the dead thread after it stopped, so read the predecessor's last messages too.
7. **Re-establish what died with the thread**: PR watches (`watch_pull_request`), linked PRs (`link_pull_request`), scheduled tasks and background commands listed in the note.
8. **Verify inherited claims against the goal on the real artifact** before building on them.
   A passing self-report from the predecessor is not proof.
9. **Pick the verdict**: continue the execution, ship a finished recommendation, ratify or override a prior conclusion, or write a postmortem of a failed run.

## Reply

One short message: where the predecessor stopped, which workers you respawned, what you inherited versus redid (ideally nothing), the resume point, and the next action.
Tell the orchestrator you have taken over, with your thread title.
