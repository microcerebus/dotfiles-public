# Running agents like an engineering team

The operating model for every body of agent work on this machine, adopted 2026-10-10.
It is built on Lauren Tan's pstack (cursor/plugins, MIT) and adapted to Claude Code in T3 Code.
Goal: more finished, verified work per day, with the owner's attention spent only on decisions.

## The limiting step

Verification is the long pole (pstack, "Loops You Can Trust").
Every other part of this model exists so that agents can prove their own work and keep going without waiting on the owner.
So each product repo gets a verification skill and a Feature Map before it gets more parallel workers.

## Roles

| Role | Team analogy | Lives in | Owns | Never does | Model |
| --- | --- | --- | --- | --- | --- |
| the owner | Product owner | Phone, T3, Lavish | Goals, irreversible calls, taste | Babysitting runs | - |
| Orchestrator | Engineering manager | One pinned T3 thread, fresh each day | `board.md`, routing between lanes, the morning brief | Lane work, code | Opus 5.5 xhigh |
| Heartbeat | On-call | A fresh scheduled thread every hour | Usage, context and stall checks, `log.md` | Long work, messages without a reason | Opus 5.5 xhigh (low effort is proposed, pending the owner's OK) |
| Lane coordinator | Tech lead | One T3 thread per lane, rotated at 300k tokens | Briefs, the lane's units, ledger and decisions | Writing code | Opus 5.5 xhigh |
| Worker | Engineer | One thread and one worktree per unit | One PR, proven with the verification skill | Merging its own PR, touching other units | Opus 5.5 xhigh; Codex `gpt-6.1-sol` for clear-spec bulk work |
| Verifier | Reviewer and QA | A fresh thread per review round, read-only | One verdict row in the ledger | Fixing what it reviews | Fable 5.1 for risky PRs, Opus 5.5 xhigh in a fresh context for the rest |
| Retro | Staff engineer | A fresh scheduled thread each day | Proposals that turn repeated mistakes into rules, checks or skills | Applying them live | Opus 5.5 xhigh |

Subagents inside any role do mechanical reading (logs, CI output, transcripts) at low effort and return summaries.

## Standards

- **Global rules**: `~/AGENTS.md`, including the rule-to-enforcer table in "Agent operations".
- **Lane rules**: `standing-orders.md`, numbered, in the owner's words, pasted verbatim into every brief and resume.
- **Briefs**: GOAL, SCOPE, CONTEXT, ACCEPTANCE, VERIFY, TIMEBOX, FORBIDDEN, REPORT, STANDING. A missing field means the brief is not sent (`standing-orders` skill).
- **Definition of done**, recorded per unit in `ledger.tsv` (pstack orchestrate):

  | Verdict | Means |
  | --- | --- |
  | `live-ui-verified` | Driven through the real app with the verification skill, evidence attached |
  | `unit-test-verified` | Behavior pinned by a test that fails without the change |
  | `type-check-only` | Compiles and lints; not done for anything user-facing |
  | `verifier-blocked` / `verifier-failed` | Not done |

  CI green is an input to a verdict, not a verdict.
  A new head SHA voids the row, except after a clean update to main: the verdict carries over when `git range-diff` shows the PR's own commits unchanged and CI passes on the new head.
  After a conflicted update, only the conflict resolution gets a quick fresh review.
- **Review scales with risk**: Fable 5.1 reviews risky PRs (sign-in, deploy wiring, screens the owner uses) and acts as the verifier.
  Opus 5.5 at xhigh, in a fresh context, reviews the rest (docs, tooling, pure logic).
  At most two review rounds per PR, then the coordinator decides.
  A PR open for 8 hours of active work goes on the board as a stall.
- **Small units**: a PR a reviewer can read in one sitting.
  Split anything larger before review, not after.

## Tooling that saves tokens and time

| Lever | What it replaces |
| --- | --- |
| Per-repo verification skill and CLI (`control-<app>`, Feature Map) | Agents writing throwaway scripts to click through the app, and the owner checking by hand |
| `recall` skill and `recall.py` | Re-explaining past decisions; reading raw transcripts |
| `turn_context.py` hook | Guessed times; threads dying at full context |
| `status.mjs` (generalized as `orch status`) | Reading every thread to learn the state of the system |
| `bash_guard.py`, `write_guard.py` | Repeating the same corrections in chat |
| `show-me-your-work` decision log | Reading a whole transcript to audit a night's work |

Rule of thumb from pstack: when an agent does the same thing by hand twice, have it write the tool it wishes it had.

## Rituals

- **Decision log**: every lane appends to `decisions.tsv` (show-me-your-work); the coordinator reads it instead of transcripts.
- **Daily retro**: a scheduled fresh thread runs `recall` over the last day, then `correct` (repeated mistakes into checks) and pstack `reflect` (skill improvements).
  It writes proposals to a dotfiles worktree branch and a short list on the board; the owner approves before anything goes live.
- **Daily verification upkeep**: `maintain-verification-skill` per product repo.
- **Morning brief**: what landed, what is blocked, everything that needs the owner in one list.
- **Weekly**: the VOICE and OPINIONS review and a skill audit (zero-use skills get deleted).

## Onboarding and handoff

- Threads never compact.
  Past about 300k tokens at a phase boundary, they `pause-safely`: a `wip:` commit, a resume note, a message to the orchestrator.
- A fresh thread starts with `session-pickup`, reads the standing orders, `authorizations.md` and the resume note, and re-establishes PR watches.
- `owners.md` says which thread owns what, so nobody messages a dead thread.
- `authorizations.md` records what the owner approved or finished, so nobody asks twice.

## Observability

- Per thread: `turn_context.py` shows the agent its own time and context size every turn; the statusline shows the owner the same.
- Per lane: `orch status` writes `status.md` with each thread's state, context size, last activity and PR verdicts.
- System: the heartbeat checks the 5-hour and weekly usage windows and pauses lanes at 85% of the window or 40% of the week.

## Automation

All recurring work runs as T3 scheduled tasks that open a fresh thread, so the orchestrator's context stays small.

| Job | When | Model |
| --- | --- | --- |
| Heartbeat | Hourly | Opus 5.5 xhigh (low pending the owner's OK) |
| Morning brief | 09:45 SGT | Opus 5.5 xhigh |
| Retro | Daily, early morning | Opus 5.5 xhigh |
| Verification upkeep | Daily per product repo | Opus 5.5 xhigh |
| Orchestrator rotation | Daily, before the morning brief | Opus 5.5 xhigh |

## Lane layout

Each body of work gets a lane directory created from `templates/orchestrator-lane/` (see its README for the full `~/orchestrator` layout).
Every file has one writer.
