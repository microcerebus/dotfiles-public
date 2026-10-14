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
- Workflows cannot call GPT directly: have a Sonnet-on-low stage spawn `codex exec` and report results back.
  Prefix any subagent/workflow label that runs a non-Claude model with the model name (e.g. `[gpt] parse logs`).
  Use `schema` on the wrapper stage so the codex report comes back structured instead of as free text.
  Parallel codex implementation wrappers need `isolation: 'worktree'` so their edits don't collide in a shared checkout.
  Workflow token budgets count Claude tokens only - codex work is invisible to `budget.spent()`.
  Codex calls can time out - treat a timeout as retryable once, then report it.

## T3 Code fallback routing

New T3 Code chats default to Claude Opus 5.5 at xhigh effort with Fast off.
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

## Reader trial (Thu 15 Oct to Thu 22 Oct 2026, 16:00 SGT)

the owner's yes, 14 Oct 18:14: try Haiku 5.5 and Sonnet 5.5 as low-effort readers, lifting the Haiku ban for this trial only.
Plan and measurement: `~/orchestrator/references/usage/reader-trial-2026-10-15.md`.

- For read-only lookups and collection (where something lives, facts out of files, logs or long docs), spawn the `reader` subagent: Haiku 5.5 at low effort, at most 300 words back.
- When the read spans many files and needs a summary, spawn `reader` with `model: sonnet`.
- Judgment stays in the calling thread: reviews, design, debugging and decisions never go to a reader.
- If a reader's report missed or misstated something you relied on, redo the read on Opus and append one line to `~/orchestrator/references/usage/reader-trial-misses.tsv`: date, thread, model, what it missed.
- After Thu 22 Oct 16:00 SGT, stop using `reader` until the orchestrator reports the result and the owner decides; the Haiku row goes back to "do not use" unless he keeps it.

