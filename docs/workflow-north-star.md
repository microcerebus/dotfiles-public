# Workflow north star

Source: "L8 Principal's Agentic Engineering Workflow" - Kun Chen,
https://www.youtube.com/watch?v=iQyg-KypKAA (digested from full transcript,
2026-07-05). The workflow here is built toward this model, on top of the
existing foundation in this repo.

## The operating model

- Captain/crew: the human is a director, not a diff reviewer. Human time goes
  to the two ends of a task - richer planning up front, quality judgment at
  the end. Agents own the middle, which is what frees you to parallelize.
- Everything terminal-centric, keyboard-only, same workflow on every device.
- Agent-agnostic: no workflow may depend on one harness (Claude Code, codex,
  pi, opencode all interchangeable).
- Memory files ramp up agents: minimal global file (~/AGENTS.md, symlinked to
  ~/.claude/CLAUDE.md), verbose per-project file grown by "remember this
  mistake" corrections, ~/OPINIONS.md + ~/VOICE.md loaded lazily.
- Skills for conditional knowledge (progressive disclosure) instead of
  bloating memory files. Never install unevaluated third-party skills -
  popularity is not evidence (he benchmarked a 177k-star skill: 5% more
  tokens, worse results).
- Agent ergonomics matter: CLIs beat MCP servers (his GitHub benchmark: MCP =
  3x token cost, 2x latency vs gh-style CLI). Prefer token-efficient tools.

## Mapping to our stack

| Video piece | Ours | Status |
|---|---|---|
| WezTerm | Ghostty (AGENTS.md: fixed choice) | have |
| tmux | tmux (training env) | have |
| Neovim | NvChad (custom config) | have |
| Claude Code + codex | both installed | have |
| ~/AGENTS.md -> ~/.claude/CLAUDE.md | files/AGENTS.md via home-manager | have (rebuild) |
| OPINIONS.md / VOICE.md | files/OPINIONS.md, files/VOICE.md | have (rebuild) |
| Project memory file | AGENTS.md pattern in each repo | have |
| Voice input | Hex (already in use) | have |
| Fig-style dropdown | inshellisense OPT-IN only (run `is`) - auto-wrap corrupts TUIs (upstream #411); fzf-tab is the always-on layer | have |
| No Mistakes (worktree gate pipeline -> PR w/ evidence) | flake-built from pinned v1.31.2 (telemetry off - upstream bakes Umami ids into release builds); skill vendored; per-repo `no-mistakes init` needed | have (rebuild) |
| Treehouse (worktree pool) | flake-built from pinned v2.0.0 (vendorHash in user.nix); firstmate crewmate dependency | have (rebuild) |
| Good Night Have Fun (long loops w/ token+iteration+condition caps) | npm CLI `gnhf` (or pnpm dlx on demand), drives claude/codex; 2.9k stars, MIT | partial (/loop today) |
| First Mate (orchestrator) | Opted in 2026-07-05 despite youth (849 stars, 63 open issues). Not a binary - a cloned directory you launch a harness inside; ships a herdr backend (`bin/backends/herdr.sh`) so it drives herdr rather than competing with it. Plain clone outside nix store (like nvim config); needs treehouse | adopt (human clones + first launch) |
| Wheelhouse (IssueOps command center) | GitHub-Actions template repo, nothing local. BLOCKED: no license (8 stars, 84 open issues) - fails dependency criteria; ask upstream for MIT like his other repos | blocked (no license) |
| Axi CLIs | gh covers GitHub; screen-free browser work uses written Playwright scripts in background agent Chrome tabs and interactive checks use codex-computer-use; the fallback-only chrome-devtools-axi skill runs as the pnpm global behind `scripts/chrome-devtools-axi`, which points it at the agent Chrome (launchd agent, 127.0.0.1:9333) and refuses the owner's own Chrome without an opt-in. Its server, chrome-devtools-mcp, is pinned in nix/user.nix instead of `npx ...@latest`. Brave stays installed for personal use only | have (rebuild) |

## Adoption principles already locked in

- files/AGENTS.md carries the general guidelines verbatim (no em dash, no
  co-author, sentence-per-line markdown, ignore development cost in technical
  decisions, e2e-first bug repro, pixel-perfection, fix lint/test rot on
  sight).
- Kun's tools are all FOSS (his GitHub); evaluate before adopting, one at a
  time, and check overlap with herdr before adding any orchestrator.

## Skill update procedure

The [pstack adoption audit](pstack-audit/audit.md) records the installed, adapted, skipped and pending items, including changes beyond the pin.
Use it instead of the historical install list when choosing the next adoption.

Vendored skills live in files/.claude/skills/<name>/SKILL.md, fetched from the
upstream repos (no-mistakes at its pinned tag, chrome-devtools-axi).
To update: re-fetch the raw SKILL.md, diff it, security-read it (they instruct
agents), commit. Local edits to keep: chrome-devtools-axi calls the
bare command (the scripts/ wrappers), never `pnpm dlx`, and chrome-devtools-axi
keeps its "Which browser" and "Sharing the agent Chrome" sections. Bump no-mistakes by changing the flake input tag + vendorHash.
When you refresh the no-mistakes SKILL.md from a new tag, keep its "PR descriptions (dotfiles addition)" section and its own `references/pr-description.md`.
pstack skills are pinned to cursor/plugins 1e5c90a4 (pstack 0.15.24, 2026-10-14); nix/user.nix lists them, the skipped ones, and every local edit.
poteto-mode is the entry point (2026-10-16).
The only other model-invocable pstack skills are unslop, correct and show-me-your-work, which are vendored from pstack and opened up here as a local edit (listed in nix/user.nix).
Its body routes the task to one playbook in `poteto-mode/references/`, and each playbook runs the slash-only skills it needs (how, why, teach, architect, arena, figure-it-out, technical-writing, tdd, blast-radius, codex-review, interrogate) by reading their SKILL.md.
in-your-own-words, ketchup and grilling are held unrouted until the owner OKs a route for them.
Keep it that way: a new pstack skill stays slash-only and gets a route from a playbook, so the always-loaded skill list does not grow.
`python3 -I scripts/check-skills` checks every skill's frontmatter (as YAML), LICENSE, links and `home.file` line.
`.githooks/pre-push` runs the pushed commit's checker against an exported copy of that commit before the public mirror leak gate on pushes to `main`.
Skill validation fails closed, including when the checker or PyYAML is missing; `PUBLIC_SYNC_SKIP=1` skips only the leak gate.
`bash tests/pre_push_test.sh` covers committed and dirty skill failures, a different checked-out branch, gate order and missing checker dependencies.
`python3 -I tests/check_skills_test.py` and `python3 -I tests/check_plan_test.py` test it and poteto-mode's `scripts/check-plan.py`.
the owner asked on 2026-10-14 for the rest of the pstack set, which overrides the earlier "install only after a failure mode shows up twice" rule for pstack.
To update: clone cursor/plugins, check out the old pin's `pstack/skills` next to the new one, and save `diff -ru old/<name> files/.claude/skills/<name>` as the local patch.
Copy the new upstream dir over, re-apply the patch, and fix rejected hunks by hand.
Security-read every changed upstream file (they instruct agents; flag any script, network call, or hook), keep each dir's MIT LICENSE, and record the new commit and date in nix/user.nix.
Rewrite any new Cursor-only line the same way: `Task` becomes Agent tool roles from CLAUDE.md, `pstack-models.mdc` and poteto-mode "Subagents" become CLAUDE.md model routing, a second model family goes through arena/references/model-families.md, `/visualize` becomes html_render, and principle skills point at ~/OPINIONS.md.
unslop follows upstream since 0.15.24 but keeps its model-invocable "Must always apply." frontmatter.
gnhf was evaluated and skipped for now (/loop covers most of it).
Treehouse and firstmate came off hold 2026-07-05 (owner's call; firstmate's herdr backend resolves the overlap concern).
Wheelhouse is blocked until upstream adds a license.
The kun skill (kunchenguid/kun, installed 2026-10-07 with the skills CLI into ~/.agents/skills, outside this repo) was removed 2026-10-10 on the owner's call.
Every use downloaded and ran an unpinned script from kun@main, and it was never used.
Don't reinstall it.

## Context discipline (2026-07-05, revised 2026-07-08)

Since 2026-10-14 auto-compact is back on, but only as a backstop:
`autoCompactWindow: 300000` (files/.claude/settings.managed.json) makes it
fire near 270k, past the 250k handoff hard stop, and an `auto` PreCompact
hook shapes the summary as a handoff. Idle compaction comes with it. From
2026-07-05 to 2026-10-14 it was off and compaction was manual only.
The 100k `autoCompactWindow` limit and its `claude-heavy` 1M escape-hatch
alias were removed 2026-07-08.
The statusline instead shows real usage against the model's actual context
window (tokens used / window size / %), with the window taken from the
harness when reported and inferred from the model id otherwise
(files/.claude/statusline.sh).
Its colour goes by absolute fill, not percent (2026-10-07): yellow at 200k
(plan a handoff), red at 350k (hand off or `/compact <hint>` now), because
Anthropic's session-management guidance puts quality decay well before a 1M
window fills. Habits: `/clear` at task boundaries, `Esc Esc` rewind instead of
"that failed, try X", noisy work in subagents.
A PreCompact hook in ~/.claude/settings.json (matcher `manual`) shapes each
/compact into a handoff document.
Since 2026-10-10 handoffs follow pstack: the `pause-safely` skill commits a
`wip:` checkpoint and writes a resume note to `<worktree>/.resume/`, and a
fresh thread resumes through `session-pickup`. A UserPromptSubmit hook prints
the SGT time and the thread's context size every turn, so agents see the
200k/250k thresholds instead of guessing (300k/500k until 2026-10-14). mattpocock's `/handoff` was
replaced by these on 2026-10-10.
