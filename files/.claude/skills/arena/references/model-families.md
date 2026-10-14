# Two model families

Arena, architect, interrogate, and swarm get their signal from model diversity.
Here the two families are Claude, spawned with the Agent tool, and GPT, run through the `codex` CLI (the model is set in `~/.codex/config.toml`).
Start the label of any seat that runs GPT with `[gpt]`.

## Pick the mode

1. **Two families.** This is the default while Codex has quota.
   Claude seats run on Opus 5.5 (`model: "opus"`), and GPT seats run through `codex exec`.
   A judge comes from the family the parent is not in: from a Claude parent that is a GPT judge, and from a Codex parent it is Fable 5.1.
2. **Claude only.** Use it when Codex is out of quota or the `codex` CLI is missing.
   Every runner, worker, or reviewer seat runs on Opus 5.5, and a judge runs on Fable 5.1 (`model: "fable"`).
   Write "Claude only: every seat shared a model family" in the output, because agreement between same-family seats is weaker evidence than agreement across families.

Codex is out when the thread or the lane's standing orders say so, or when a `codex exec` call fails with a usage or rate limit message.
Don't spend a probe call when the thread already says Codex is out.
Codex calls can time out: retry a timeout once, then treat that seat as a dropout.
Never switch Codex to a paid API key to get around a limit.

## Run a GPT seat

Write the seat's full brief to a file first.
The command line stays short, and the brief stays on disk for the synthesis note.

A writing seat (an arena or architect runner, a swarm worker) gets its own worktree:

```bash
git worktree add -b arena/<slug>-gpt /tmp/arena-<slug>/gpt <base>
codex exec -s workspace-write -C /tmp/arena-<slug>/gpt \
  -o /tmp/arena-<slug>/gpt.last.md - < /tmp/arena-<slug>/brief-gpt.md
```

Tell it to leave its changes uncommitted, then read them with `git -C <worktree> status` and `git -C <worktree> diff`.
The sandbox can write only inside the worktree, and a commit also writes to the main repository's `.git` directory.

A read-only seat (a judge or a reviewer) runs against the repository without a worktree:

```bash
codex exec -s read-only -C <repo> -o <out>.md - < <brief>.md
```

Run each command with the Bash tool's `run_in_background: true`, so it runs alongside the Agent seats.
The harness wakes you when it exits.
The `-o` file holds Codex's last message, which is a self-report: judge the artifact in the worktree, not the summary.

Prompt Codex short, plain, and self-contained.
State the task, the paths to read, where to write, and what to report.
Don't prompt it like a Claude agent, and don't paste this skill's instructions into the brief.

## Run a Claude seat

Use the Agent tool with `subagent_type: "general-purpose"`.
Runners, workers, and reviewers use `model: "opus"`, and a Claude-only judge uses `model: "fable"`.
Give a writing seat `isolation: "worktree"`, and tell a read-only seat to change nothing.
Spawn every Claude seat in one message with `run_in_background: true`.

Set effort per `~/.claude/CLAUDE.md`: high for runners, reviewers, and judges, which are judgment stages, and low for mechanical swarm slices.
Never use Haiku, and keep Fast off.
