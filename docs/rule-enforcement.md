# Rule enforcement

Pairs each rule in the "Agent operations" section of `files/AGENTS.md` (`~/AGENTS.md`) with what enforces it.
Moved out of `files/AGENTS.md` on 2026-10-14 so it is read on demand instead of loaded into every thread.
The `correct` skill keeps it current: when the owner corrects something a rule already covers, fix it at the highest level that works and update this table.

| Rule | Enforced by |
| --- | --- |
| No em dashes | `write_guard.py` (prose files), `bash_guard.py` (commit messages), `unslop` |
| Real time, context size | `turn_context.py` prints both every turn |
| No containers or VMs | `bash_guard.py` blocks them unless the owner wrote an unexpired `~/.claude/containers-approved-until` |
| Context limits | `turn_context.py`: a nudge on each prompt past 200k; past the 250k hard stop, the stop on each prompt and after main-thread tool calls, repeated once per 5k tokens of growth (never a block); `pre_compact.py` backstop; `pause-safely` skill |
| Handoffs list native workers, never "still hosts" | `write_guard.py` and `bash_guard.py` flag the wording in resume notes and `~/orchestrator`; `pause-safely` and `session-pickup` skills |
| Nothing personal in the public dotfiles mirror | `scripts/public-sync` leak gate, run with the pushed commit's own rules by `.githooks/pre-push` on every push that updates `main` on the dotfiles repo, from any checkout or worktree; only `public-sync --from-origin` publishes, from `origin/main` (`tests/pre_push_test.sh`) |
| Chrome, never Brave | `lavish-axi` and `chrome-devtools-axi` wrappers in `scripts/`; rule only elsewhere |
| Agent Chrome, not the owner's own | `chrome-devtools-axi` wrapper refuses autoConnect and port 9222 unless `CHROME_DEVTOOLS_AXI_MAIN_CHROME=1` |
| Agent Chrome tabs stay behind the owner's windows and are sized per tab | `chrome-devtools-axi` wrapper opens tabs in the background and refuses `resize` |
| Lavish tables never split words | `write_guard.py` flags `overflow-wrap: anywhere` and `word-break: break-all` on body or table cells in HTML |
| Agent Chrome has no extensions or sync | launchd flags `--disable-extensions --disable-sync` (`nix/user.nix`); the `chrome-devtools-axi` wrapper refuses an agent Chrome running without them |
| PR bodies explain the change, describe user flows, omit routine CI results and show before/after media for visual changes | `scripts/check-pr-description.mjs` checks body structure and common CI-result patterns; nothing runs it automatically, so the no-mistakes skill instructs agents to run it on the body GitHub holds; `tests/check_pr_description_test.mjs` covers rejected PR #90 inventory/media patterns and command-only flows. Reviewers verify preview identity, observable outcomes, media access and visual fidelity. Product metadata-workflow integration is coordinator-owned. |
| Finished threads are settled regularly | `~/orchestrator/bin/settle-done.mjs` (lifecycle checks before settling) plus `t3_thread_organize`, run on every orchestrator wake, with a native 30-minute maintenance backstop that moves to the successor on handoff |
| Everything else in "Agent operations" | Rule only, until it repeats |
