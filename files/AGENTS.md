# Agent instructions

These are common instructions for my agents across all scenarios.

## General Guidelines

- Never use the em dash "—". Use plain dash "-" instead
- When writing commit messages, NEVER auto-add your agent name as co-author
- Never manually modify CHANGELOG.md files or any files that are marked as auto-generated
- When writing or substantially editing long Markdown files, put each full sentence on its own line.
  Preserve normal Markdown structure, but avoid wrapping multiple sentences onto one physical line.
- When making technical decisions, do not give much weight to development cost.
  Instead, prefer quality, simplicity, robustness, scalability, and long term maintainability.
- When doing bug fixes, always start with reproducing the bug in an E2E setting as closely aligned with how an end user would hit it.
  This makes sure you find the real problem so your fix will actually solve it.
- When end-to-end testing a product, be picky about the UI you see and be obsessed with pixel perfection.
  If something clearly looks off, even if it is not directly related to what you are doing, try to get it fixed along the way.
- Apply that same high standard to engineering excellence: lint, test failures, and test flakiness.
  If you see one, even if it is not caused by what you are working on right now, still get it fixed.
- For anything browser-related - opening URLs, OAuth/login flows, browser automation, testing web pages - always use Google Chrome.
  Never launch or automate Brave; it is my personal browser and off limits to agents.
- Browser driving (navigating, clicking through flows, filling forms, and similar mechanical browser work) is codex's job.
  Agents other than codex shell out to it (e.g. via the codex-computer-use skill) and keep the judgment work themselves: what to write, which fields, and verifying the result.
  This overrides skill descriptions that prefer chrome-devtools-axi for browser-only work.
- TypeScript: never use `any` unless it is truly necessary or you are specifically instructed to.
- Do not run dev-server commands (assume one is already running) and do not run build commands unless asked.
  Verify with check commands instead: typecheck, lint, focused tests.
- If asked to do too much work at once, stop and say so clearly instead of attempting it all.

## Model routing

Glossary: "intelligence" = how hard a problem the model can handle unsupervised.
"Taste" = UI/UX, code quality, API design, copy.

| Model                 | Cost               | Intelligence | Taste |
|-----------------------|--------------------|--------------|-------|
| Fable 5               | high               | 10           | 10    |
| Opus 4.8              | mid                | 8            | 8     |
| Sonnet 5              | mid (token-hungry) | 6            | 7     |
| GPT-5.5 via codex CLI | ~free (sub quota)  | 9            | 4     |
| Haiku                 | -                  | do not use   | -     |

- These are defaults, not limits.
  Standing permission to escalate: if a cheaper model's output misses the bar, redo the work with a smarter model without asking.
  Judge the output, not the price tag.
- Cost is a tie-breaker only; when the axes conflict for anything that ships, intelligence > taste > cost.
- Use cheap models to gather information and try things; move the real work to the right model.
- Bulk mechanical work (clear-spec implementation, log digging, giant docs/PDFs): shell out to GPT-5.5 via `codex exec`.
  Anything user-facing needs taste >= 7.
- Reviews of plans and implementations: Fable 5 or Opus 4.8, optionally GPT-5.5 as an extra independent perspective.
- Workflows cannot call GPT-5.5 directly: have a Sonnet-on-low stage spawn `codex exec` and report results back.
  Prefix any subagent/workflow label that runs a non-Claude model with the model name (e.g. `[5.5] parse logs`).
  Use `schema` on the wrapper stage so the codex report comes back structured instead of as free text.
  Parallel codex implementation wrappers need `isolation: 'worktree'` so their edits don't collide in a shared checkout.
  Workflow token budgets count Claude tokens only - codex work is invisible to `budget.spent()`.
  Codex calls can time out - treat a timeout as retryable once, then report it.

## Reasoning effort

- Hard cap at effort high; xhigh and max are banned.
  They think more per step, not more steps, and routinely produce overdone code at a multiple of the cost.
  Do not reach for ultracode casually either.
- Effort applies per tool call, not per run: a long task needs more steps, not higher effort.
- When spawning subagents or workflow stages, set effort low for mechanical stages (scanning, formatting, collection) and high for judgment stages (verify, judge, review).

## Writing

- Apply the `unslop` skill to everything user-facing by default: chat replies, documents, artifacts, commit messages, anything the owner or another person will read.
  Do not wait to be asked.
- Read ~/VOICE.md before writing anything as the owner or for the owner to send, and ~/OPINIONS.md before design or tooling decisions.
- Both files are living documents.
  When a decision or correction in a session contradicts them, propose the update in that session.
  Each file carries a `Last reviewed:` date; if it is more than 7 days old, review the file against recent sessions and refresh it before ending the session.
