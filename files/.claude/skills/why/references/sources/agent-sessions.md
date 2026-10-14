# Past agent sessions (recall)

## What this source contains

- Claude Code transcripts (`~/.claude/projects/<cwd-slug>/<session-id>.jsonl`)
- Codex sessions (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`)
- Claude CLI prompt history
- T3 Code threads

the owner's typed messages are Direct evidence of what he asked for and why.
An agent's own claims inside a transcript ("merged", "fixed", "the owner approved") are leads, not evidence; confirm them in git, `gh`, or the lane records, or report them as unconfirmed.

## How to search it

Use the `recall` skill's script.
It never loads raw JSONL into context.

```bash
R="python3 -I ~/.claude/skills/recall/scripts/recall.py"
$R sessions --since 30d --cwd <repo> --grep '<topic>'   # candidate sessions, newest first
$R grep '<symbol or phrase>' --since 60d                # one hit per message, with context
$R messages <path> --max-chars 800                      # typed and relayed messages only
$R history --since 60d --grep '<topic>'                 # Claude CLI prompt history
```

Widen `--since` until the window covers the date the target code was added (take it from the code anchor's commits).
For T3 threads, `t3_thread_search` finds a thread and `t3_thread_read` reads it.
Skip the current session and no-mistakes review runs.
Cite each finding by transcript path and local time (SGT).
