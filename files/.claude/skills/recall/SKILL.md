---
name: recall
description: "Rebuild context from the owner's past agent sessions (Claude Code transcripts, Claude CLI prompt history, Codex sessions, T3 threads) and return a short brief. Use before resuming a topic from an earlier session, when the owner says 'we already did X' or 'I already told you', when a successor thread takes over a lane, or for /recall."
---

# Recall

Adapted from pstack's `recall` (cursor/plugins, MIT, Lauren Tan) for Claude Code, Codex and T3 Code.
Past transcripts are the richest context there is.
Mine them instead of asking the owner to repeat himself.

One specific predecessor thread to resume is the `session-pickup` skill, not this one.
If the brief already carries a full resume note, skip the mining.

## Sources

| Source | Where | Notes |
| --- | --- | --- |
| Claude Code transcripts | `~/.claude/projects/<cwd-slug>/<session>.jsonl` | Includes T3 Code threads on Claude. Deleted after `cleanupPeriodDays` (365 once the managed settings apply, 30 before). |
| Claude CLI prompt history | `~/.claude/history.jsonl` | Typed prompts only, back to 5 Jul 2026. |
| Codex sessions | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Includes T3 Code threads on Codex and `codex exec` runs. |
| T3 threads | `t3_thread_search`, `t3_thread_list`, `t3_thread_read` | Titles, status and messages across providers. Read in small pages. |
| Lane files | `~/orchestrator/lanes/<lane>/` | Standing orders, authorizations and resume notes. Read these first for orchestrated work. |
| Shared record | `git log`, `gh pr list`, `gh issue view` in the repo | What actually landed. |

The helper reads the first three without loading raw JSONL into context:

```sh
R="python3 -I ~/.claude/skills/recall/scripts/recall.py"
$R sessions --since 7d --cwd job-tracker --grep "resume upload"   # newest first
$R messages <path> --max-chars 800                                  # typed and relayed messages only
$R grep "convex variable" --since 14d                               # one hit per message, with context
$R history --since 30d --grep lavish
$R self                                                             # this session's transcript path
```

Every command takes `--json`.
Times print in local time (SGT).

## Steps

1. **Pin the scope.**
   Default window is the last 7 days, the topic if named, and the active repo.
   Say the scope back in one line.
   Never quietly shrink "all" to "recent".
2. **Find candidates.**
   Run `sessions` with `--grep` on the topic first, newest first.
   Skip this session, no-mistakes review runs and subagent chats unless the topic is about them.
3. **Read in slices.**
   For one or two sessions, read them yourself with `messages`.
   For more, spawn low-effort subagents, one slice each, and have each return topic, the owner's goal, decisions, open threads, corrections he gave, and artifacts, each cited by transcript path and time.
   Raw transcripts never enter your own context.
4. **Sweep the shared record** whenever the topic names a feature, file, PR or bug: `git log`, open PRs, issue comments.
5. **Verify against live state.**
   A transcript that says "merged" or "done" is a claim.
   Check it with `git` and `gh` before repeating it.

## Output

- **Capsule**, at most 5 bullets: what the work is and where it stands.
- **Threads**, one line each, tagged with exactly one of `[merged #N]`, `[open PR #N]`, `[in flight <branch>]`, `[verified, uncommitted]`, `[reverted #N]`, `[planned, not started]`, `[the owner confirmed done]`.
- **Problems**, at most 5.
- **Next move**: the single most useful next action.

Cite by transcript path or PR.
Cut detail before cutting threads.
Never copy secrets, user identifiers or personal data out of transcripts.
