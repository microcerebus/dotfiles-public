---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Before fanning out, find this conversation's transcript with the `recall` skill's script:

```bash
python3 -I ~/.claude/skills/recall/scripts/recall.py self
```

It prints this session's path under `~/.claude/projects/<cwd-slug>/`, or the Codex rollout path when running in Codex. Do not glob across every project directory. That crosses workspace boundaries and reads private chats from unrelated projects. If the script finds nothing, pass a tight digest of the session instead.

## 2. Spawn three reviewers in parallel

One message, three Agent tool calls, `subagent_type: "general-purpose"`, so reviewers can run `git` and `gh` to look up the PRs, commits, and lane records the transcript references. Never use Haiku, and keep Fast off. Each reviewer is a judgment stage, so give it high effort.

| Lens | `model` | Prompt template |
|---|---|---|
| Judgment | `opus` | `references/judgment-reviewer.md` |
| Tooling | `sonnet` | `references/tooling-reviewer.md` |
| Divergent | `opus` | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in the Agent response body.

## 3. Synthesize

One Agent tool call, `subagent_type: "general-purpose"`, `model: "opus"`, high effort. It spot-verifies citations with `git`, `gh`, and the files the reviewers cite. Pass `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the encode-lessons-in-structure principle in `~/OPINIONS.md`, and the `correct` skill, which turns a repeated mistake into a check.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent on this machine. Do not auto-apply.

File each Backlog item with `tasks-axi add <id> "<title>"` in the repo the item belongs to, without waiting. Only the Accepted list waits for approval.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): draft it in the skill's existing shape, then test it: run one fresh subagent on a task where the skill should fire and check that it now does the right thing.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): rewrite the `description` to front-load the trigger words from the missed moment. Remember that a skill with `disable-model-invocation: true` never triggers on its own, so a missed trigger there means removing that line, which is the owner's call.
- `new skill via create-skill: <kebab-name>`: write `SKILL.md` with `name` and `description` frontmatter, shaped like the nearest existing skill. Do not invent the shape ad hoc.

Skills that live in `~/dotfiles` are edited in a worktree of that repo and wired in `nix/user.nix`, never in the main checkout. Before declaring done, check every touched skill's frontmatter parses and its relative links resolve.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed with `tasks-axi`: `<task title>`. One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
