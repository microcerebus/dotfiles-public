---
name: poteto-mode
description: "pstack's way of working. Load it before starting any investigation, bug fix, plan, design, prototype, feature, refactor, perf work, review, doc or code explanation. It picks one playbook for the task type and the pstack skills that playbook needs."
---

# Poteto mode

Lauren Tan's pstack way of working, adapted for Claude Code from cursor/plugins `pstack/skills/poteto-mode` (MIT, see LICENSE).
Pick one playbook, read it, and follow it.
Load nothing else up front: each playbook names the sub-skills its steps need.

## Pick one playbook

Read only the matched file, from the `references/` directory next to this file.
If two rows fit, take the earlier one.
"Investigate why X, don't fix it" is Investigate, not Bug fix.
If no row fits, or the work is large and cross-cutting (a migration, a multi-part change), read `figure-it-out/SKILL.md` instead: it designs a playbook for the task.
Unattended work whose done you can state as one checkable predicate takes the autonomous-run row; that row wins over figure-it-out.
Unattended work without such a predicate goes to figure-it-out, whose first phase frames one.

| Task | Playbook |
| --- | --- |
| A reported bug to reproduce and fix | `references/bug-fix.md` |
| An unclear failure, or research toward a decision: a cause, a risk, a choice between options | `references/investigate.md` |
| Explain code, a change or a design so a person understands it ("how does X work", "why is it like this") | `references/explain.md` |
| Review a diff, a PR, a plan or a design | `references/review.md` |
| Settle a design or behavior fork by building options ("prototype", "try a few") | `references/prototype.md` |
| A design that crosses a function or module boundary, or a new interface | `references/architect.md` |
| Turn a settled design into a multi-PR plan | `references/plan.md` |
| New or changed behavior | `references/feature.md` |
| Same behavior, new structure | `references/refactor.md` |
| Slowness, or a metric to push down (time, size, tokens) | `references/perf.md` |
| Docs, READMEs, tutorials, design docs | `references/write-docs.md` |
| Write or change a skill, prompt or rule, and test the change | `references/skill-change.md` |
| A long run toward a checkable goal ("run until done", "loop until X") | `references/autonomous-run.md` |

## Sub-skills

The pstack skills the playbooks name are slash-only (`disable-model-invocation: true`), so the Skill tool refuses them.
Run one by reading `<name>/SKILL.md` from the skills directory this skill was loaded from (the parent of this skill's base directory, normally `~/.claude/skills/`) in full, then follow it as written.
Read a sub-skill only when the step that needs it comes up.
Skills without that flag (unslop, recall, show-me-your-work, chrome-devtools-axi, agent-device) load through the Skill tool as usual.

## Rules for every playbook

- Start a todo list whose first items are the playbook's steps. A step you skip stays in the list as `skip: <reason>`.
- Pick each subagent's model from `~/dotfiles/docs/model-routing.md`. Read-only lookups go to the `reader` subagent while its trial runs, explorers to Sonnet, judgment and reviews to Opus 5.5 or Fable 5.1, and clear-spec mechanical edits to `codex exec`. A worker that writes code gets its own worktree (Agent with `isolation: "worktree"`, T3 `delegate_task`, or `codex exec -C <worktree>`). You own each subagent's output: read it and write your own summary.
- Before you ask the owner a "which approach" question, check whether running something would answer it (behavior, timing, layout, output). If it would, prototype it (`references/prototype.md`) and let the result decide. Ask only about product or taste calls no experiment can settle.
- Name the principle behind each real decision, from the "Engineering principles (pstack)" section of `~/OPINIONS.md`.
- Every claim carries its evidence or a label in the same sentence: measured, read in code, inferred, or guess.
- Long, unattended or multi-phase work keeps a decision trail with show-me-your-work.
- Say no when an idea does not earn its place.
- Write the reply with unslop. Each playbook ends with the reply it owes.
