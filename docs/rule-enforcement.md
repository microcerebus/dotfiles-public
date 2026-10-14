# Rule enforcement

Pairs each rule in the "Agent operations" section of `files/AGENTS.md` (`~/AGENTS.md`) with what enforces it.
Moved out of `files/AGENTS.md` on 2026-10-14 so it is read on demand instead of loaded into every thread.
The `correct` skill keeps it current: when the owner corrects something a rule already covers, fix it at the highest level that works and update this table.

| Rule | Enforced by |
| --- | --- |
| No em dashes | `write_guard.py` (prose files), `bash_guard.py` (commit messages), `unslop` |
| Real time, context size | `turn_context.py` prints both every turn |
| No containers or VMs | `bash_guard.py` blocks them unless the owner wrote an unexpired `~/.claude/containers-approved-until` |
| Context limits | `turn_context.py` nudge, `pause-safely` skill |
| Handoffs list native workers, never "still hosts" | `write_guard.py` and `bash_guard.py` flag the wording in resume notes and `~/orchestrator`; `pause-safely` and `session-pickup` skills |
| Nothing personal in the public dotfiles mirror | `scripts/public-sync` leak gate |
| Chrome, never Brave | `lavish-axi` and `chrome-devtools-axi` wrappers in `scripts/`; rule only elsewhere |
| Agent Chrome, not the owner's own | `chrome-devtools-axi` wrapper refuses autoConnect and port 9222 unless `CHROME_DEVTOOLS_AXI_MAIN_CHROME=1` |
| Agent Chrome tabs stay behind the owner's windows and are sized per tab | `chrome-devtools-axi` wrapper opens tabs in the background and refuses `resize` |
| Lavish tables never split words | `write_guard.py` flags `overflow-wrap: anywhere` and `word-break: break-all` on body or table cells in HTML |
| Agent Chrome has no extensions or sync | launchd flags `--disable-extensions --disable-sync` (`nix/user.nix`); the `chrome-devtools-axi` wrapper refuses an agent Chrome running without them |
| Everything else in "Agent operations" | Rule only, until it repeats |
