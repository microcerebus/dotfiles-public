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
| Lavish (HTML-artifact planning) | skill vendored at files/.claude/skills/lavish, runs via `pnpm dlx lavish-axi`. CAUTION: its `share` cmd publishes to public ht-ml.app - never without explicit ask | have (rebuild) |
| No Mistakes (worktree gate pipeline -> PR w/ evidence) | flake-built from pinned v1.31.2 (telemetry off - upstream bakes Umami ids into release builds); skill vendored; per-repo `no-mistakes init` needed | have (rebuild) |
| Treehouse (worktree pool) | flake-built from pinned v2.0.0 (vendorHash in user.nix); firstmate crewmate dependency | have (rebuild) |
| Good Night Have Fun (long loops w/ token+iteration+condition caps) | npm CLI `gnhf` (or pnpm dlx on demand), drives claude/codex; 2.9k stars, MIT | partial (/loop today) |
| First Mate (orchestrator) | Opted in 2026-07-05 despite youth (849 stars, 63 open issues). Not a binary - a cloned directory you launch a harness inside; ships a herdr backend (`bin/backends/herdr.sh`) so it drives herdr rather than competing with it. Plain clone outside nix store (like nvim config); needs treehouse | adopt (human clones + first launch) |
| Wheelhouse (IssueOps command center) | GitHub-Actions template repo, nothing local. BLOCKED: no license (8 stars, 84 open issues) - fails dependency criteria; ask upstream for MIT like his other repos | blocked (no license) |
| Axi CLIs | gh covers GitHub; chrome-devtools-axi skill vendored, runs via pnpm dlx. Launches Google Chrome by channel; the google-chrome cask is declared in nix/host.nix, so no Brave workaround needed - Chrome is the browser for all agent/browser tooling (Brave stays installed for personal use) | have (rebuild) |

## Adoption principles already locked in

- files/AGENTS.md carries the general guidelines verbatim (no em dash, no
  co-author, sentence-per-line markdown, ignore development cost in technical
  decisions, e2e-first bug repro, pixel-perfection, fix lint/test rot on
  sight).
- Kun's tools are all FOSS (his GitHub); evaluate before adopting, one at a
  time, and check overlap with herdr before adding any orchestrator.

## Skill update procedure

Vendored skills live in files/.claude/skills/<name>/SKILL.md, fetched from the
upstream repos (lavish-axi, no-mistakes at its pinned tag, chrome-devtools-axi).
To update: re-fetch the raw SKILL.md, diff it, security-read it (they instruct
agents), commit. Bump no-mistakes by changing the flake input tag + vendorHash.
pstack skills (correct, show-me-your-work, create-verification-skill,
maintain-verification-skill, tdd, blast-radius) are pinned to cursor/plugins
df581122 (2026-10-05). To update: sparse-clone cursor/plugins, diff
`pstack/skills/<name>` against files/.claude/skills/<name>, re-apply the
Claude Code edits listed in nix/user.nix, keep each dir's MIT LICENSE, and
record the new commit there. Install only skills whose failure mode has shown
up twice in real sessions (pstack guide 09).
unslop is an older pstack copy with local additions; keep it as a fork.
gnhf was evaluated and skipped for now (/loop covers most of it).
Treehouse and firstmate came off hold 2026-07-05 (owner's call; firstmate's herdr backend resolves the overlap concern).
Wheelhouse is blocked until upstream adds a license.
The kun skill (kunchenguid/kun, installed 2026-10-07 with the skills CLI into ~/.agents/skills, outside this repo) was removed 2026-10-10 on the owner's call.
Every use downloaded and ran an unpinned script from kun@main, and it was never used.
Don't reinstall it.

## Context discipline (2026-07-05, revised 2026-07-08)

Auto-compact is disabled (`autoCompactEnabled: false` in
~/.claude/settings.json, not repo-managed - Claude Code mutates that file at
runtime) and there is no artificial context hard limit; compaction is a
manual, deliberate act.
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
300k/500k thresholds instead of guessing. mattpocock's `/handoff` was
replaced by these on 2026-10-10.
