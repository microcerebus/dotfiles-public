---
name: poteto-mode
description: "Always load when asked to catch up, say what you think the user wants, confirm your understanding of their goals, or challenge their thinking through questions. Also routes retrospectives, investigations, fixes, plans, designs, prototypes, features, refactors, perf work, reviews, docs, formal verification and code explanations to pstack playbooks."
---

# Poteto mode

Lauren Tan's pstack way of working, adapted for Codex and Claude from cursor/plugins `pstack/skills/poteto-mode` (MIT, see LICENSE).
Pick one playbook, read it, and follow it.
Load nothing else up front: each playbook names the sub-skills its steps need.

## Pick one playbook

Read only the matched file, from the `references/` directory next to this file.
If two rows fit, take the earlier one.
"Investigate why X, don't fix it" is Investigate, not Bug fix.
A retrospective or post-mortem on a session or failed unit, asking what to change, is Retro; "why did X fail" alone is Investigate.
If no row fits, or the work is large and cross-cutting (a migration, a multi-part change), read `figure-it-out/SKILL.md` instead: it designs a playbook for the task.
Unattended work whose done you can state as one checkable predicate takes the autonomous-run row; that row wins over figure-it-out.
Unattended work without such a predicate goes to figure-it-out, whose first phase frames one.

| Task | Playbook |
| --- | --- |
| Catch me up on this work or what changed while I was away | `references/catch-up.md` |
| Say what you think I want to achieve, restate my goals, or check your understanding before proceeding | `references/understand-goals.md` |
| Challenge my thinking through questions, grill me on an idea, or run an interview drill | `references/grill.md` |
| Explicitly model-check a race, prove an invariant, or create a formal verification skill | `references/formal-verification.md` |
| Run a retrospective on a session: what in the agents' environment should change | `references/retro.md` |
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
- Pick each subagent's model from `~/dotfiles/docs/model-routing.md`: Astra High for judgment, Sol High for routine implementation and Sol Low for mechanical collection, with Fast off.
  Follow `../arena/references/model-families.md` for delegation and fallback.
  A worker that writes code gets its own worktree; respect lane concurrency limits.
  Read each result and inspect the artifact before accepting it.
- Before you ask the owner a "which approach" question, check whether running something would answer it (behavior, timing, layout, output). If it would, prototype it (`references/prototype.md`) and let the result decide. Ask only about product or taste calls no experiment can settle.
- Name the principle behind each real decision, from the "Engineering principles (pstack)" section of `~/OPINIONS.md`.
- Every claim carries its evidence or a label in the same sentence: measured, read in code, inferred, or guess.
- Long, unattended or multi-phase work keeps a decision trail with show-me-your-work.
- Say no when an idea does not earn its place.
- Write the reply with unslop. Each playbook ends with the reply it owes.
