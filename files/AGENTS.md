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
- Keep tool output small: every line you read is reread on each later reply.
  Use quiet flags, pipe long output through `tail` or `grep`, and write full logs to a file and read only the part you need.
  Bash output past 15,000 characters goes to a file and you see a preview: read that file in parts instead of rerunning the command.
- If asked to do too much work at once, stop and say so clearly instead of attempting it all.
- In practice or tutoring sessions (interview drills, timed problems), keep going to the next step without asking.
  If I keep asking for small hints on a solo problem, say so before it turns into guided practice.

## Model routing

- Read `~/dotfiles/docs/model-routing.md` before choosing a model for a subagent, workflow stage, review or design work, and when Claude or Codex reports a usage limit.
  It holds the model table, the routing rules and the T3 Code fallback table.
- Defaults: main chats on Opus 5.5; reviews on Fable 5.1 or Opus 5.5; design on Fable 5.1 with the Impeccable skills; bulk mechanical work to GPT via Codex.
  Anything user-facing needs taste >= 7 (Fable, Opus or Sonnet).
- Until Thu 22 Oct 2026, send read-only lookups to the `reader` subagent (Haiku 5.5, low effort); the trial rules are in that doc.
- If a cheaper model's output misses the bar, redo the work with a smarter model without asking.
- When Claude reports a usage or quota limit, switch to the Codex fallback in that doc without asking.

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
- Auto-compact is only a backstop: it fires near 270k, just past the hard stop below, for a thread that missed its handoff.
  Past about 200k tokens at a phase boundary, and always before 250k, use the `pause-safely` skill.
  Size each unit of work to finish under about 150k.
  A fresh thread resumes with `session-pickup`.
  The resume note lists every in-flight native worker with its brief path; they die with the thread, so the successor respawns them first.
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
- When the owner corrects something a rule here already covers, run the `correct` skill: fix it at the highest level that works (architecture, then a check, then a test, then a rule) and update the enforcement table in `~/dotfiles/docs/rule-enforcement.md`.
