# Model routing

Moved out of `files/AGENTS.md` on 2026-10-14 so it is read on demand instead of loaded into every thread.
`~/AGENTS.md` keeps the defaults and points here; read this before choosing a model for a subagent, workflow stage, review or design work, or when Claude or Codex reports a usage limit.

## Default routing

New threads, conversations, workers, reviewers, coordinators and orchestrators use Codex by default.
This follows the 20 October authorization to use Codex usage as much as possible.
Running threads keep their model; these defaults do not authorize changing an active thread mid-task.

| Work | Provider and model | Reasoning | Fast |
|------|--------------------|-----------|------|
| Judgment, coordination, orchestration, architecture, debugging, reviews and substantial changes | Codex `gpt-6-astra` | High | Off |
| Routine implementation with explicit acceptance checks | Codex `gpt-6.1-sol` | High | Off |
| Mechanical scanning, formatting and collection | Codex `gpt-6.1-sol` | Low | Off |

Use T3's live `orchestrator_capabilities` catalog to confirm model availability.
Delegate directly to the Codex provider; a Claude wrapper is not required.
Use separate worktrees for concurrent implementation and fresh contexts for independent reviews.
Keep reasoning at High or below on Codex and Fast off unless explicitly requested.
A longer task needs more steps, not a higher effort setting.
If routine work exposes harder judgment or misses acceptance checks, move the next committed unit to Astra High.
If Astra alone is unavailable, try Sol High before falling back to Claude.
A timeout gets one retry after inspecting partial results; it is not evidence of a quota limit.
Never enable paid API access to bypass an exhausted allowance.

Claude is the fallback when Codex is usage-limited or cannot do the job.
Record the concrete capability gap when using Claude without a quota limit.
Keep the same acceptance checks, independent review and evidence requirements on either provider.
Do not change app settings, scheduled tasks or live threads merely to make their stored selections match this document.

## Approved specialist routing

The eight audit recommendations were accepted on 20 October.
They replace the older provider-specific defaults for new work.

- User-facing work is judged by the artifact and its acceptance checks, not a provider taste score.
- Design and design reviews use Astra High with the same design tools and visual checks; Fable is a capability fallback.
- Writing uses Codex and unslop; Opus is a fallback when Codex cannot meet the writing bar.
- The reader trial takes no new assignments; retain its measurements for the planned review.
- Skill roles use Sol Low for mechanical collection, Sol High for routine implementation and Astra High for judgment.
  Delegate directly without a Claude wrapper and respect lane concurrency limits.
- Reviews use fresh Codex contexts by default.
  Use Claude for an explicit task-level exception, demonstrated capability gap or confirmed Codex quota limit.
  Independent contexts do not constitute cross-family evidence.
- The exact OPINIONS provider paragraph in `pstack-audit/preference-wording-draft.md` was finalized and applied in this worktree.
  VOICE and the adjacent tried-and-dropped list are unchanged.
  Do not edit either live preference file as part of this routing unit.
- The fallback watcher stays disabled until restoration and queued-message recovery have been redesigned and verified.
  No automatic provider switching is enabled by these instructions.

The shared skill adapter is `files/.claude/skills/arena/references/model-families.md`.
It maps the roles to available native, T3 or CLI delegation without assuming a Claude parent.

## Claude fallback reasoning effort

Use **High** for routine coordination and clearly scoped implementation with explicit acceptance checks.
Use **Extra High** (`xhigh`) for open-ended architecture, difficult root-cause debugging, and work with material unresolved uncertainty.
Opus review, verification and judge stages use Extra High.
For non-Opus judgment stages, retain the model-specific setting; use High when no more specific rule applies.
A skill's explicit per-stage effort applies only after the approved routing selects that provider; it does not create a Claude exception.
Escalate a High task when its output misses the acceptance bar or exposes harder judgment; a long task alone is not a reason to increase effort.
Keep mechanical collection at Low on its assigned reader or Codex model, and keep Fast off unless requested.
These effort rules apply only after the default routing selects a Claude fallback.
Independent review, reproduction, evidence and merge gates stay required at either effort.

This guideline follows the [17 October matched replay](claude-process/opus-effort-replay-2026-10-17.md), which found equal aggregate blind scores with less elapsed time and fewer provider output tokens at High.
It is a small-sample operating guideline, not proof that the two efforts are equivalent for long implementation, real tool use or UI design.
Track review findings and fix rounds in actual use, and revise this guideline when they show a quality difference.
The first real-use check, a job-tracker trial from 15 to 17 Oct (8 merged PRs at High against 16 at Extra High the week before), showed no saving per merged PR: output cost rose 23%, and more PRs needed a second-round review (5 of 8 against 7 of 16).
With so few PRs and a different PR mix, that is noise-prone, so the guideline stands; the numbers are in `~/orchestrator/references/usage/effort-trial-2026-10-15.md` under "Result".
Do not interrupt uncommitted work or change existing threads merely to match a new guideline; apply it at a safe task boundary.

## T3 Code fallback routing

Commit work in progress before a provider or model switch, and never delete a dirty worktree.
On a confirmed Codex usage limit, continue on Claude Opus 5.5 without asking, using the role-specific fallback effort above.
If Codex cannot perform the task, explain the capability gap and use Claude for that task.
Preserve the workspace, task and completed work, and inspect partial results before retrying an interrupted action.
Use T3's catalog and `t3_thread_configure` with the intended provider, model, reasoning effort and standard service tier when a switch is needed.
If a provider limit prevents the agent from running at all, T3 or the human must switch the thread before it can continue.

On a Claude usage limit, return to an available Codex model from the default table without asking.
Do not cycle through models sharing an exhausted provider allowance.
If both providers are limited, report the limit instead of retrying in a loop or enabling paid API access.
New tasks use Codex once it is available; do not interrupt an active fallback task merely to switch providers.
Clear the browser fallback state as soon as Codex is available, independently of which provider finishes an active task.

### Codex quota fallback for browser work

When Codex reports a usage limit, commit work in progress and continue on Claude Opus 5.5 at the role's effort.
For browser work, `codex-browser-fallback set <future Unix seconds>` records the reset time reported by Codex.
Do not enable it merely because a browser tool failed or because axi is more convenient.
If the limit has no reset time, leave the fallback disabled and report the missing reset time.
`codex-browser-fallback status` exits 0 only while the fallback is active.
Run `codex-browser-fallback clear` as soon as Codex is available again.

The single state file is `~/.local/state/codex-browser-fallback/until`, containing two Unix timestamps in seconds: when it was set, then the reset time.
The helper writes it atomically with mode 0600.
Missing, unreadable, malformed or expired state disables the fallback, and so does the older one-number format.
A reset time more than 7 days ahead is refused by `set`, because Codex limits reset within a week and a later time can only be a typo or a way around the gate.
The state reads as inactive when its set time is in the future or its reset time is more than 7 days after its set time, so a far-off reset time never turns active as the clock approaches it.
The wrapper and session-start hook read this file on each invocation; do not maintain a second reset time in another script.

`scripts/chrome-devtools-axi` refuses every call from Claude or Codex unless that state is active, before probing or starting Chrome.
It detects `CLAUDECODE=1`, `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID` or `CODEX_CI=1`.
The live Claude Agent SDK shell confirmed `CLAUDECODE=1`; the live Codex shell confirmed its thread, session and CI signals without printing identifiers.
During a fallback the wrapper prints its expiry and retains its Chrome identity, extension, sync and window guards.
Outside the fallback, use written Playwright scripts attached to the agent Chrome in background tabs for screen-free work, including reading pages, screenshots and WhatsApp Web.
Run these through `scripts/agent-chrome-playwright --minutes N --what "..."`, or any other command through `scripts/agent-chrome-session`; both notify the owner before and after, and `scripts/agent-chrome-gate` refuses everything else.
Interactive checks go through `codex-computer-use`; Codex itself uses built-in computer use, not axi.
Do not unset the harness signals or call the pnpm binary directly to bypass the wrapper.
Non-agent scripted maintenance callers remain supported; repeatable browser verification stays in written Playwright flows.

Run `node --test tests/chrome_devtools_axi_test.cjs tests/codex_browser_fallback_test.cjs tests/axi_session_start_test.cjs tests/agent_chrome_session_test.cjs tests/agent_chrome_gate_test.cjs tests/agent_chrome_replay_test.cjs tests/agent_chrome_playwright_test.cjs`.
The replay test drives a throwaway headless Chromium on a spare port, never the agent Chrome.
These checks stub the upstream executable and never drive a browser.
After bumping chrome-devtools-axi or chrome-devtools-mcp, also check that the axi bridge reconnects after the gate closes an expired lease.
That live check requires an active confirmed Codex quota fallback; otherwise leave it pending.

### Fallback watcher trial

`scripts/claude-fallback --dry-run` runs one manual decision tick against T3's local database, opened read-only.
It prints decision counts and appends the details to `~/Library/Logs/claude-fallback.tsv`.
The script has `LIVE = False`; production `--live` is rejected.
No launchd job or recurring task runs it, and the manual routing rule above still applies.

The trial considers only a thread whose latest executed run failed on a Claude usage limit, whose reset is still ahead, and whose T3 recovery is armed for that run.
It skips settled or archived threads, recent human activity, pending requests, changed selections, and held messages with attachments or missing text.
A Claude meter below 95% in the affected window makes the limit look transient, so the tick skips it.
An available Codex limit signal also blocks the plan.
Missing meter data means headroom is unknown.

The proposed switch uses Astra High Standard, or Sol Low Standard for a low-effort thread.
The live transport can check the catalog and substitute Sol High if Astra is absent; dry-run does not acquire a token for that check.
Held text messages would be cancelled, then replayed in order after configuring Codex and sending the continuation.
After Claude's reset, an idle thread would return to its original selection once the meter is below 100%, or after a ten-minute grace period if the meter is unavailable.
If Codex also stopped on a limit, restoration would send a continuation.
Any later selection event, including reselecting the same model, prevents restoration.
Fixtures cover these writes; a real switch-and-restore integration proof is still required before a future live activation.
One live recovery case remains unfinished: if Codex hits a limit with follow-ups still queued, the current busy check defers restoration.
Before activation, restoration must preserve those messages and rebind them to Claude; simply ignoring queued runs would let their stored Codex selections switch the thread back.

The private state directory is `~/.local/state/claude-fallback/`, with separate dry-run and live ledgers and a single tick lock.
The ledger includes held message text so an interrupted cancellation can be recovered manually; do not publish it or the audit log.
Pre-write failures can retry on later ticks, up to three attempts.
Before retrying an unfinished switch, the watcher checks Codex headroom again and retains any already-cancelled follow-up text while it waits.
An interrupted or failed mutation with an unknown outcome stops the episode for manual reconciliation, because a fresh OAuth session has a different request-id namespace.
Stopped episodes do not expire automatically; they may contain the only recoverable copy of cancelled follow-ups.
Do not delete that ledger to force a retry: inspect T3's selection, runs, and held queue first, then recover any cancelled text deliberately.

Every tick, even a dry run with no eligible threads, sweeps only MCP sessions and pairing codes bearing the watcher's exact `claude-fallback` label.
Sessions must also have the `mcp-client` subject; unrelated devices and sessions are preserved.
The reserved label must not be used by another client.
Dry-run mints no token and sends no messages or alerts.
The future live path holds its token only in memory, revokes by ID on normal exit, constructor failure, or SIGTERM, and relies on the next tick's label sweep after SIGKILL.
T3 fixes these tokens at 30 days, so a killed manual tick requires another manual dry run for prompt cleanup.
A failed cleanup exits nonzero and must be resolved before another live attempt.

Run `bash tests/claude_fallback_test.sh` for the SQLite decision fixtures, ordered mutation and retry cases, and token lifecycle tests.
All mutation and token tests use local fixtures; none acquire real credentials or change a T3 thread.

## Reader trial record (Thu 15 Oct to Thu 22 Oct 2026, 16:00 SGT)

The trial is closed to new assignments under the approved Sol Low default.
Retain the measurements for its planned review.
The following records the earlier trial instructions; do not launch readers from it.

the owner's yes, 14 Oct 18:14: try Haiku 5.5 and Sonnet 5.5 as low-effort readers, lifting the Haiku ban for this trial only.
Plan and measurement: `~/orchestrator/references/usage/reader-trial-2026-10-15.md`.

- For read-only lookups and collection (where something lives, facts out of files, logs or long docs), spawn the `reader` subagent: Haiku 5.5 at low effort, at most 300 words back.
- When the read spans many files and needs a summary, spawn `reader` with `model: sonnet`.
- Judgment stays in the calling thread: reviews, design, debugging and decisions never go to a reader.
- If a reader's report missed or misstated something you relied on, redo the read on Opus and append one line to `~/orchestrator/references/usage/reader-trial-misses.tsv`: date, thread, model, what it missed.
- After Thu 22 Oct 16:00 SGT, stop using `reader` until the orchestrator reports the result and the owner decides; the Haiku row goes back to "do not use" unless he keeps it.

