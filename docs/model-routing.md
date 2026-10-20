# Model routing

Moved out of `files/AGENTS.md` on 2026-10-14 so it is read on demand instead of loaded into every thread.
`~/AGENTS.md` keeps the defaults and points here; read this before choosing a model for a subagent, workflow stage, review or design work, or when Claude or Codex reports a usage limit.

## Models

Glossary: "intelligence" = how hard a problem the model can handle unsupervised.
"Taste" = UI/UX, code quality, API design, copy.

| Model                 | Cost               | Intelligence | Taste |
|-----------------------|--------------------|--------------|-------|
| Fable 5.1             | high               | 10           | 10    |
| Opus 5.5              | mid                | 8            | 8     |
| Sonnet 5.5            | mid (token-hungry) | 6            | 7     |
| GPT via codex CLI     | ~free (sub quota)  | 9            | 4     |
| Haiku 5.5             | low                | reader trial | -     |

- Haiku is for the reader trial below and nothing else: never judgment, reviews or anything user-facing.
- These are defaults, not limits.
  Standing permission to escalate: if a cheaper model's output misses the bar, redo the work with a smarter model without asking.
  Judge the output, not the price tag.
- Cost is a tie-breaker only; when the axes conflict for anything that ships, intelligence > taste > cost.
- Use cheap models to gather information and try things; move the real work to the right model.
- Bulk mechanical work (clear-spec implementation, log digging, giant docs/PDFs): shell out to GPT via `codex exec` (model: ~/.codex/config.toml).
  Anything user-facing needs taste >= 7.
- Reviews of plans and implementations: Fable 5.1 or Opus 5.5, optionally GPT via codex as an extra independent perspective.
- Design work (UI/UX and visual design, design reviews, screen design docs, new UI components): Fable 5.1 with the Impeccable skills, by default.
- Writing (rewrites, docs, prep pages, briefs, chat replies, anything a person reads): Opus 5.5, not Fable 5.1.
  the owner, 18 Oct 2026: "Use opus 5.5 to rewrite, not fable please" and "opus 5.5 should handle all writing in general - maybe at a lower effort level if that's more optimal".
  Start at a lower effort (medium or high) and escalate only if the result misses the bar.
  Design work keeps Fable for layout and visuals; the words in it go to Opus.
- Workflows cannot call GPT directly: have a Sonnet-on-low stage spawn `codex exec` and report results back.
  Prefix any subagent/workflow label that runs a non-Claude model with the model name (e.g. `[gpt] parse logs`).
  Use `schema` on the wrapper stage so the codex report comes back structured instead of as free text.
  Parallel codex implementation wrappers need `isolation: 'worktree'` so their edits don't collide in a shared checkout.
  Workflow token budgets count Claude tokens only - codex work is invisible to `budget.spent()`.
  Codex calls can time out - treat a timeout as retryable once, then report it.

## Opus 5.5 reasoning effort

Use **High** for routine coordination and clearly scoped implementation with explicit acceptance checks.
Use **Extra High** (`xhigh`) for open-ended architecture, difficult root-cause debugging, and work with material unresolved uncertainty.
Opus review, verification and judge stages use Extra High.
For non-Opus judgment stages, retain the model-specific setting; use High when no more specific rule applies.
A skill's explicit per-stage effort setting takes precedence over these general Opus role defaults; changing that stage requires a separate deliberate update.
Escalate a High task when its output misses the acceptance bar or exposes harder judgment; a long task alone is not a reason to increase effort.
Keep mechanical collection at Low on its assigned reader or Codex model, and keep Fast off unless requested.
The model-selection rules above still decide which provider/model performs reviews and design.
Independent review, reproduction, evidence and merge gates stay required at either effort.

This guideline follows the [17 October matched replay](claude-process/opus-effort-replay-2026-10-17.md), which found equal aggregate blind scores with less elapsed time and fewer provider output tokens at High.
It is a small-sample operating guideline, not proof that the two efforts are equivalent for long implementation, real tool use or UI design.
Track review findings and fix rounds in actual use, and revise this guideline when they show a quality difference.
Do not interrupt uncommitted work or change existing threads merely to match a new guideline; apply it at a safe task boundary.

## T3 Code fallback routing

New T3 Code chats default to Claude Opus 5.5 at xhigh effort with Fast off.
Set High when launching or delegating a routine role, or at an explicit committed task boundary.
The guideline does not make the app default role-dependent or authorize mid-task reconfiguration.
Codex is the fallback only while Claude is usage-limited.
When Claude reports a usage or quota limit, use the Codex fallback below without asking for permission.
This fallback overrides the Claude-only review and workflow-wrapper rules above while Claude is unavailable, including for user-facing work.
Keep the same quality standards.

| Work | Codex model | Reasoning | Speed |
|------|-------------|-----------|-------|
| Default replacement for Opus; architecture, debugging, reviews, substantial changes | `gpt-6-astra` | High | Standard |
| Straightforward edits and routine implementation | `gpt-6.1-sol` | High | Standard |
| Mechanical scanning, formatting, and collection | `gpt-6.1-sol` | Low | Standard |

- Use T3's live `orchestrator_capabilities` catalog to confirm availability.
  For the current thread, use `t3_thread_configure` with the Codex instance, the table's model, `reasoningEffort`, and `serviceTier: default` through the tool's option format.
  For delegated work, use T3's Codex delegation directly without a Claude wrapper.
- Keep Fast off by default because it increases usage.
  Use Fast only when the owner explicitly requests it for time-sensitive work.
  Keep reasoning at High or below.
- On a confirmed Claude quota limit, do not cycle through other Claude models sharing the exhausted allowance.
  Preserve the task, workspace, and completed work when switching.
  Inspect partial results before retrying an interrupted action.
- If Astra is unavailable specifically, try Sol at High for demanding work.
  If the Codex allowance is also exhausted, report the limit instead of retrying in a loop or enabling paid API access.
- Keep the fallback for the affected task unless the owner requests a switch back.
  This table authorizes agent routing; it is not an app-level error handler.
  If a provider limit prevents the agent from running at all, T3 or the owner must switch the thread before the agent can continue.

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

## Reader trial (Thu 15 Oct to Thu 22 Oct 2026, 16:00 SGT)

the owner's yes, 14 Oct 18:14: try Haiku 5.5 and Sonnet 5.5 as low-effort readers, lifting the Haiku ban for this trial only.
Plan and measurement: `~/orchestrator/references/usage/reader-trial-2026-10-15.md`.

- For read-only lookups and collection (where something lives, facts out of files, logs or long docs), spawn the `reader` subagent: Haiku 5.5 at low effort, at most 300 words back.
- When the read spans many files and needs a summary, spawn `reader` with `model: sonnet`.
- Judgment stays in the calling thread: reviews, design, debugging and decisions never go to a reader.
- If a reader's report missed or misstated something you relied on, redo the read on Opus and append one line to `~/orchestrator/references/usage/reader-trial-misses.tsv`: date, thread, model, what it missed.
- After Thu 22 Oct 16:00 SGT, stop using `reader` until the orchestrator reports the result and the owner decides; the Haiku row goes back to "do not use" unless he keeps it.

