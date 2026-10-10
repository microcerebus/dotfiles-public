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
  Agents drive the agent Chrome: Google Chrome Beta with its own signed-in profile on 127.0.0.1:9333, which `chrome-devtools-axi` uses by default (see its skill).
  It runs with no extensions and no Chrome sync; never add either to it.
  Never attach to the owner's own Chrome (autoConnect, or its port 9222) unless he asks in the thread, because it makes him click "Allow" for every session.
  Lavish's upstream browser opener ignores BROWSER on macOS.
  Use the Chrome-only `lavish-axi` wrapper in `~/dotfiles/scripts`, or pass `--no-open` and open the view explicitly in Chrome.
  Never call the upstream Lavish executable without `--no-open` or `LAVISH_AXI_NO_OPEN=1`.
  Confirm browser identity from the actual Google Chrome application, not a generic Chromium label or debug port.
  This includes sessions running inside T3 Code: default to Chrome, not T3 Code's built-in preview browser (the t3-code `preview_*` tools), unless the owner asks for the in-app preview.
- Browser driving (navigating, clicking through flows, filling forms, and similar mechanical browser work) is codex's job.
  Agents other than codex shell out to it (e.g. via the codex-computer-use skill) and keep the judgment work themselves: what to write, which fields, and verifying the result.
  This overrides skill descriptions that prefer chrome-devtools-axi for browser-only work.
  Exception: while Codex is out of quota, Claude agents drive Chrome themselves (see "Agent operations").
- Always present Lavish pages with this machine's Tailscale MagicDNS hostname, including links and previews in T3 Code.
  Use `~/dotfiles/scripts/lavish-axi <file> --no-open` to obtain the current URL, and use that exact URL when displaying or linking the page.
  Never hand out `localhost`, `127.0.0.1`, or a local file path as the review link, and do not reuse stale localhost URLs from the session list.
  Lavish detects Tailscale automatically; leave `LAVISH_AXI_HOST` unset so it can bind the tailnet address.
  If MagicDNS access is unavailable, report and fix it before claiming the page is ready for phone review.
- TypeScript: never use `any` unless it is truly necessary or you are specifically instructed to.
- Do not run dev-server commands (assume one is already running) and do not run build commands unless asked.
  Verify with check commands instead: typecheck, lint, focused tests.
- If asked to do too much work at once, stop and say so clearly instead of attempting it all.
- In practice or tutoring sessions (interview drills, timed problems), keep going to the next step without asking.
  If I keep asking for small hints on a solo problem, say so before it turns into guided practice.

## Model routing

Glossary: "intelligence" = how hard a problem the model can handle unsupervised.
"Taste" = UI/UX, code quality, API design, copy.

| Model                 | Cost               | Intelligence | Taste |
|-----------------------|--------------------|--------------|-------|
| Fable 5.1             | high               | 10           | 10    |
| Opus 5.5              | mid                | 8            | 8     |
| Sonnet 5.5            | mid (token-hungry) | 6            | 7     |
| GPT via codex CLI     | ~free (sub quota)  | 9            | 4     |
| Haiku                 | -                  | do not use   | -     |

- These are defaults, not limits.
  Standing permission to escalate: if a cheaper model's output misses the bar, redo the work with a smarter model without asking.
  Judge the output, not the price tag.
- Cost is a tie-breaker only; when the axes conflict for anything that ships, intelligence > taste > cost.
- Use cheap models to gather information and try things; move the real work to the right model.
- Bulk mechanical work (clear-spec implementation, log digging, giant docs/PDFs): shell out to GPT via `codex exec` (model: ~/.codex/config.toml).
  Anything user-facing needs taste >= 7.
- Reviews of plans and implementations: Fable 5.1 or Opus 5.5, optionally GPT via codex as an extra independent perspective.
- Workflows cannot call GPT directly: have a Sonnet-on-low stage spawn `codex exec` and report results back.
  Prefix any subagent/workflow label that runs a non-Claude model with the model name (e.g. `[gpt] parse logs`).
  Use `schema` on the wrapper stage so the codex report comes back structured instead of as free text.
  Parallel codex implementation wrappers need `isolation: 'worktree'` so their edits don't collide in a shared checkout.
  Workflow token budgets count Claude tokens only - codex work is invisible to `budget.spent()`.
  Codex calls can time out - treat a timeout as retryable once, then report it.

### T3 Code fallback routing

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

## Reasoning effort

- Default main chats to Opus 5.5 at xhigh, including routine implementation.
  Codex fallbacks stay at High.
  Use lower effort only when the owner requests it or for the mechanical subagent/workflow stages below.
- Hard cap at xhigh; max is banned.
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

## Agent operations

Added 2026-10-10 from a review of Jul-Oct sessions.
Each rule below is a correction the owner had to give more than once, or a failure that cost a night's work.

- Get the time from `TZ=Asia/Singapore date` before writing any time or date.
  Never estimate it.
- Never start OrbStack, Docker or a VM without the owner's explicit OK in the current session.
  Reproduce Linux-only failures on a GitHub Actions run.
- Auto-compact is off.
  Past about 300k tokens at a phase boundary, and always before 500k, use the `pause-safely` skill.
  A fresh thread resumes with `session-pickup`.
- Coordinators coordinate: they write briefs, read results and decide.
  Code, restacks and conflicted merges go to workers in their own worktrees.
- When Codex is out of quota, continue on Claude Opus 5.5 at xhigh without asking.
  While Codex is out of quota, Claude agents also drive the agent Chrome themselves with chrome-devtools-axi, never Brave.
  Native macOS apps and iOS Simulators go through the agent-device skill the same way; codex-computer-use is the route again once Codex is back.
  Before any provider or model switch, or when a usage-limit warning appears, commit work in progress.
  Never delete a worktree that has uncommitted edits.
- Collect everything that needs the owner into one "Needs the owner" list at the top of the reply or page.
  Before asking him anything, check the lane's `authorizations.md` and the thread history, and never re-ask something he has already approved or finished.
- Never put personal data, user identifiers, tokens, booking references or seat numbers into chat, relays, commits, test fixtures or published pages unless he asks.
- Status relays are plain language, at most 5 lines per unit: what changed, what is blocked and on whom, what the owner needs to do.
  No raw SHAs or IDs unless he asks.
- Done means checked on the real artifact, with evidence: a screenshot, a command and its output, or a named test.
  A green build alone is not proof.
  In a repo with a `verify-<app>` or `control-<app>` skill, use it.
- Edit ~/dotfiles only in a worktree, and commit the same day.
  Files in the main checkout are live the moment they are saved, because skills and rules link to it out-of-store.
- When the owner corrects something a rule here already covers, run the `correct` skill: fix it at the highest level that works (architecture, then a check, then a test, then a rule) and update the table below.

| Rule | Enforced by |
| --- | --- |
| No em dashes | `write_guard.py` (prose files), `bash_guard.py` (commit messages), `unslop` |
| Real time, context size | `turn_context.py` prints both every turn |
| No containers or VMs | `bash_guard.py` blocks them unless the owner wrote an unexpired `~/.claude/containers-approved-until` |
| Context limits | `turn_context.py` nudge, `pause-safely` skill |
| Nothing personal in the public dotfiles mirror | `scripts/public-sync` leak gate |
| Chrome, never Brave | `lavish-axi` and `chrome-devtools-axi` wrappers in `scripts/`; rule only elsewhere |
| Agent Chrome, not the owner's own | `chrome-devtools-axi` wrapper refuses autoConnect and port 9222 unless `CHROME_DEVTOOLS_AXI_MAIN_CHROME=1` |
| Agent Chrome has no extensions or sync | launchd flags `--disable-extensions --disable-sync` (`nix/user.nix`); the `chrome-devtools-axi` wrapper refuses an agent Chrome running without them |
| Everything else in this section | Rule only, until it repeats |
