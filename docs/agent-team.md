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
| the owner | Product owner | Phone, T3 | Goals, irreversible calls, taste | Babysitting runs | - |
| Orchestrator | Engineering manager | One T3 thread, replaced at each handoff, not daily | `board.md`, routing between lanes, the morning brief (not running; all 3 tasks are disabled) | Lane work, code | Claude Opus 5.5 High |
| Heartbeat | On-call | Not running; both hourly T3 heartbeat tasks are disabled | Context and stall checks, `log.md` | Long work, messages without a reason | Claude Opus 5.5 Low for collection; High for judgment |
| Lane coordinator | Tech lead | One T3 thread per lane, rotated at 200k tokens | Briefs, the lane's units, ledger and decisions | Writing code | Claude Opus 5.5 High |
| Worker | Engineer | One thread and one worktree per unit | One PR, proven with the verification skill | Merging its own PR, touching other units | Claude Opus 5.5 High for routine implementation; Extra High for open-ended or uncertain changes |
| Verifier | Reviewer and QA | A fresh thread per review round, read-only | One verdict row in the ledger | Fixing what it reviews | Claude Opus 5.5 Extra High in a fresh context |
| Retro | Staff engineer | Not running; no enabled task | Proposals that turn repeated mistakes into rules, checks or skills | Applying them live | Claude Opus 5.5 High |

Subagents inside any role do mechanical reading (logs, CI output, transcripts) at low effort and return summaries.

Use the role and uncertainty rules in [model routing](model-routing.md#default-routing) when selecting effort.
New work follows the Opus defaults in `model-routing.md`, with Fast off.
Running threads keep their model; the Codex fallback on a Claude limit and approved specialist routing are described in that guide.
The automation table below records defaults for new launches.
Apply role-specific effort at launch or a committed task boundary; this documentation does not reconfigure existing schedules or running threads.

## Standards

- **Global rules**: `~/AGENTS.md`, including the rule-to-enforcer table in "Agent operations".
- **Lane rules**: `standing-orders.md`, numbered, in the owner's words, pasted verbatim into every brief and resume.
- **Briefs**: GOAL, SCOPE, CONTEXT, ACCEPTANCE, VERIFY, TIMEBOX, FORBIDDEN, REPORT, PRACTICES, STANDING, from `templates/orchestrator-lane/briefs/TEMPLATE.md`. A missing field means the brief is not sent (`standing-orders` skill).
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
- **Review scales with risk**: Opus Extra High reviews in a fresh context.
  Risk determines review scope and verification depth; provider exceptions follow `model-routing.md`.
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

- **On request**: poteto-mode routes "catch me up" to ketchup, a check of the agent's understanding to in-your-own-words, requested questioning or interview drills to grilling, and session retrospectives to retro (pinned mattpocock/skills, 2026-10-28).
  Catch-up stays read-only, goal restatement does not start implementation, grilling waits for answers between rounds, and retro only proposes.
  Ordinary plan reviews keep the review route.
  Batch 2's routes are pushed and applied; see docs/pstack-audit/audit.md#rollout-status.
- **Decision log**: every lane appends to `decisions.tsv` (show-me-your-work); the coordinator reads it instead of transcripts.
- **Retro**: not running; no enabled task or launchd job runs it.
  The design is a fresh scheduled thread each day that runs `recall` over the last day, then `correct` (repeated mistakes into checks) and pstack `reflect` (skill improvements).
  It would write proposals to a dotfiles worktree branch and a short list on the board; the owner approves before anything goes live.
- **Verification upkeep**: not running; no enabled task or launchd job runs it.
  The design is a daily `maintain-verification-skill` run per product repo.
- **Morning brief**: not running; all 3 morning brief tasks are disabled, and the last one ran on 12 October 2026.
  The design is what landed, what is blocked, everything that needs the owner in one list.
- **Weekly**: the VOICE and OPINIONS review and a skill audit (zero-use skills get deleted).

## Onboarding and handoff

- Threads never compact.
  Past about 200k tokens at a phase boundary (never past 250k), they `pause-safely`: a `wip:` commit, a resume note, a message to the orchestrator.
- A fresh thread starts with `session-pickup`, reads the standing orders, `authorizations.md` and the resume note, and re-establishes PR watches.
- The resume note lists every in-flight worker: task, brief path, and what it passed so far.
  Native subagents die with their thread and have no T3 run rows, so the successor respawns them first; only T3 delegated tasks and threads outlive their parent.
  "The old thread still hosts X" is never true after a pause, and the write and Bash guards flag that wording (10 Oct: #36 lost about an hour to it).
- `owners.md` says which thread owns what, so nobody messages a dead thread.
- `authorizations.md` records what the owner approved or finished, so nobody asks twice.

## Observability

- Per thread: `turn_context.py` shows the agent its own time and context size every turn; the statusline shows the owner the same.
- Per lane: `orch status` writes `status.md` with each thread's state, context size, last activity and PR verdicts.
- For the owner's phone: the agent board (`files/bin/agent-board.mjs`, port 4790 on the Mac's MagicDNS name) lists every open T3 thread.
  It puts the threads waiting on him first, then running threads with their context use, flagging any run with no log write for 10 minutes.
  It is read-only and has no hooks; it was chosen over agenttrail on 2026-10-11 (`docs/agent-observability/proposal.html`).
  Agents prove a change to it with the repo-local `verify-agent-board` skill, which runs a second board from their worktree on a spare port and never touches the live one.
- System: no enabled heartbeat checks the usage windows or pauses lanes at a usage threshold.
  The T3 scheduled task "Claude-limit watchdog tick" runs every 5 minutes on Codex `gpt-6-astra`.
  Each tick lists threads whose latest run failed on a Claude usage limit: the orchestrators and coordinators named in `lane.json`, and any other thread that failed in the last 12 hours.
  The watchdog moves each listed thread to the Codex model for its role in [model routing](model-routing.md#codex-on-a-claude-limit), with Fast off, and sends it one continue message.
  This carries out the owner's order of 29 October 2026, 02:37 SGT (dotfiles standing order 9): on a confirmed Claude usage limit, lane threads move to Codex without asking.
  The T3 scheduled task "Codex-limit watchdog tick" runs every 30 minutes on Claude Opus 5.5, lists the same kinds of threads when their latest run failed on a Codex usage limit, moves them to Claude Opus 5.5 with Fast off, and sends each one continue message.
  Both watchdogs' briefs and their detector script live in the orchestrator's scratch folder, not in this repo.

## Automation

Recurring work runs as T3 scheduled tasks that open a fresh thread, so the orchestrator's context stays small.
The exceptions are the orchestrator's 30-minute maintenance task, the two watchdogs and the monthly Mac security audit, which are bound to their own threads.

| Job | When | Model |
| --- | --- | --- |
| Heartbeat | Not running; both hourly T3 heartbeat tasks are disabled | Claude Opus 5.5 Low for collection; High for judgment |
| Morning brief | Not running; all 3 tasks are disabled | Claude Opus 5.5 High |
| Retro | Not running; no enabled task | Claude Opus 5.5 High |
| Verification upkeep | Not running; no enabled task | Claude Opus 5.5 Extra High |
| Orchestrator rotation | Not running; no enabled task. A new orchestrator thread takes over at each handoff, and only its own 30-minute maintenance task stays enabled | Claude Opus 5.5 High |

## Lane layout

Each body of work gets a lane directory created from `templates/orchestrator-lane/` (see its README for the full `~/orchestrator` layout).
Every file has one writer.
