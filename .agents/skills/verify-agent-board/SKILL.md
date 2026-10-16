---
name: verify-agent-board
description: "Launch, drive and verify the dotfiles agent board (files/bin/agent-board.mjs) on a throwaway instance from this checkout, and capture proof. Surfaces: the thread list at /, the /map project map with its stale-row flags, the auto-update alarms, the phone layout. Use when a change touches the board or what it reads (T3 state, lane units.tsv, lane.json or ledger.tsv, dotfiles-autoupdate status), when asked to check that the board or the map still shows something, or before calling a board change done. Never drives the live board on port 4790."
---

# Verify the agent board

This is the canonical skill body.
Codex discovers this repo-local skill through the relative symlink at `.agents/skills/verify-agent-board`.
The [Codex discovery proof](references/codex-discovery-proof.md) records a fresh session's implicit selection; Claude implicit selection remains unverified.

The agent board (`files/bin/agent-board.mjs`) is a read-only web page for the owner's phone: the open T3 threads at `/` and the orchestrator lanes at `/map`.
The live board is the launchd agent `com.myuser.agent-board` on port 4790, run from the main checkout and shared by every agent and the owner.
**Never drive, restart, stop or reload the live board.**
Verify on a run of your own: `scripts/board.mjs` starts this checkout's board on a spare port, checks that the instance is yours, and stops it while keeping the evidence.

Read [the feature map](features/README.md) before driving anything, then follow the matching feature file.

## What you can verify

| Feature | File | Best data |
| --- | --- | --- |
| Thread list: needs you, running, idle, context bars, quiet runs | [threads](features/threads.md) | fixture |
| Auto-update alarms above the threads, the quiet healthy card | [auto-update](features/auto-update.md) | fixture |
| Project map: lanes, milestones, unit rows, dependencies, footer | [project-map](features/project-map.md) | fixture |
| Stale needs-myuser rows whose branch already landed | [stale-rows](features/stale-rows.md) | fixture |
| Phone layout, tailnet access, the read-only and Host guards | [phone-and-access](features/phone-and-access.md) | fixture or live |

Not covered here: the launchd agent itself (plist, KeepAlive, `~/Library/Logs/agent-board.log`), which only `rebuild` changes and only the owner runs.
Parsing and rendering logic has unit tests: `node --test tests/agent_board_test.mjs`.

## Launch

The helper lives at `.claude/skills/verify-agent-board/scripts/board.mjs` in the checkout you are verifying, and it runs that checkout's `files/bin/agent-board.mjs`.
Commands below are relative to the skill directory; from the checkout root, prefix `.claude/skills/verify-agent-board/`.

| Data | Command | What the board reads |
| --- | --- | --- |
| fixture | `scripts/board.mjs launch --fixture` | Seeded T3 database, Claude logs, three lanes with a git checkout, and updater state with one alarm, all in the run's scratch dir. Every journey in the feature map starts here. |
| live | `scripts/board.mjs launch` | The real T3 database, Claude logs, `~/orchestrator/lanes` and updater state, read-only. Use it to check a change against T3's real schema and today's lanes. |
| lanes copy | `scripts/board.mjs launch --lanes-copy` | Live T3 data, with `~/orchestrator/lanes` copied into the scratch dir so you can edit a row without touching the real file. |

- Ready means launch printed `launched <run-id>` with the URLs and exited 0.
  It has already waited for the board's `listening on 127.0.0.1:<port>` line and for both pages to render (not the T3 error page), and in fixture mode for the seeded data to show.
  Otherwise it exits 1 with the end of `board.log`, and stops what it started.
- Launch prints the local URL, the phone URL (this Mac's MagicDNS name on the same port, when Tailscale is up), the evidence directory, and the seeded files you may edit.
- One run per checkout: launch refuses while this checkout has a run up.
- A run stops itself after `--ttl <minutes>` (default 60).
- Editing `files/bin/agent-board.mjs` during a run is fine: the board exits on the change and the run's keeper restarts it on the new code within about two seconds, on the same port and data, as launchd does for the live board.
  A change that crashes the board stops the run; `doctor` then shows the log tail.

## Doctor

`scripts/board.mjs doctor` answers "is this instance mine and worth driving?" and changes nothing.
Run it after launch, and again whenever anything looks off.

- `ok` lines: the keeper and board processes are this run's (checked by recorded pid and command line), this run's board holds the `127.0.0.1` listener, `/` and `/map` render (in fixture mode, with the seeded data), the code revision and any uncommitted board edits, the data paths, the TTL left, and the agent Chrome answering on 127.0.0.1:9333.
- Exit 0 means ready, exit 1 means `FAIL` lines (fix them, or stop and relaunch), exit 2 means refused.
- It refuses (exit 2) port 4790, a `--port` that no run from this checkout launched, a run started from another checkout, and a port another process has taken over.
  `scripts/board.mjs doctor --port 4790` is the quick way to see the refusal.

## Drive

The pages are server-rendered HTML with no buttons or forms: a journey opens a page, reads it, changes the data the board reads, and reads it again.

- Browser: the agent Chrome (Google Chrome Beta on 127.0.0.1:9333) through `chrome-devtools-axi`.
  Never Brave, never the owner's own Chrome.
- Who drives: Codex, through the `codex-computer-use` skill (its binary and `-s danger-full-access`).
  You keep the judgment: pick the feature file, hand Codex its Driving bullets with literal values, then check what it saved.
  Drive with chrome-devtools-axi yourself only while Codex is out of quota, or when you are Codex.
- Values: `eval "$(scripts/board.mjs env)"` exports `BOARD_URL`, `BOARD_PHONE_URL`, `BOARD_EVIDENCE`, `BOARD_SCRATCH`, `BOARD_RUN` and `BOARD_MODE` for this checkout's latest run.
  Every tool call is a new shell, so run it at the start of each call; a Codex prompt needs the literal values, not the variable names.
- Tabs open in the background (the wrapper does that).
  Set the size per tab with `chrome-devtools-axi emulate --viewport "1280x900x1"` for desktop and `"390x844x3,mobile,touch"` for a phone.
  Never `resize`: it reshapes the one window every agent shares.
- Stable handles: headings (`Needs you · N`, `Running · N`, `Idle · N`, `Auto-update`), the header links `threads` and `map`, thread cards `.t`, map rows `.u`, the state word `.state`, the stale line `.stale`, the page title with its count, `(N) agent board` or `(N) project map`.
  Read exact values with `chrome-devtools-axi eval` over these selectors; the feature files give the expressions.
- The page reloads itself every 15 seconds.
  A ref from a snapshot goes stale at the reload (`STALE_REF`), so snapshot again right before a click.
  After changing data, wait for the reload with `chrome-devtools-axi wait 16000`, or open the URL again.
- Second view: `curl -s "$BOARD_URL/map" -o "$BOARD_EVIDENCE/<name>.html"` saves the same HTML the browser got.

A Codex prompt, filled in from a feature file:

```sh
eval "$(.claude/skills/verify-agent-board/scripts/board.mjs env)"
"$CODEX" exec -s danger-full-access "Use chrome-devtools-axi, which drives the agent Chrome; never use Brave and never run resize. \
Verify <feature> on the agent board at $BOARD_URL. Steps: <the feature file's Driving bullets, with $BOARD_URL, \
$BOARD_SCRATCH and $BOARD_EVIDENCE written out>. Save every screenshot and eval output into $BOARD_EVIDENCE. \
Close the tabs you opened. Finish with PASS or FAIL and one line per step saying what you saw."
```

## Evidence

- Where: `~/.local/state/verify-agent-board/<run-id>/evidence/` (`$BOARD_EVIDENCE`), next to `run.json` (instance, data paths, code revision) and `board.log`.
  It survives `stop`, a reboot and the worktree's removal; report that path.
- Name files `<feature>-<state>-<desktop|phone>.png`, with the matching `.txt` eval output and `.html` curl beside them.
- Proof standards:
  - Exercise the user path: open the page by URL and the header links, as the owner does on his phone; `render()` in a test is not a drive.
  - Capture the action and the result: for a journey that changes data, capture before, make the change in the scratch data, and capture after the reload.
  - Pair every screenshot with a second view (an `eval` read or the curled HTML) that names the same rows and values.
  - The board must write nothing: `shasum` the scratch lane files before and after a journey when a feature claims read-only.
  - Say "fixture-verified" for fixture runs.
    The fixture proves rendering and the lane and git logic; only a live run proves the board against T3's real schema, so a change to the T3 query or the columns it reads needs a live run too.
  - Look at every screenshot before reporting: clipped or overlapping text, wrapping, horizontal scroll, and the theme (Catppuccin Mocha, JetBrains Mono).
- Live-mode evidence shows real thread titles and branches: keep it in the evidence dir, never commit it (every push of this repo republishes a public mirror), and share it only with the owner or the coordinator.

## Cleanup

- `scripts/board.mjs stop` stops this checkout's runs.
  It signals only the keeper it recorded, after confirming that process's command line; the keeper stops the board, deletes `scratch/` and records why.
  If the keeper died, `stop` confirms the board's command and listener before sending TERM, waits for exit, and confirms ownership again before escalating to KILL.
  It removes scratch only after the board exits; a stop failure retains the PID and scratch so the run can be inspected and stopped safely.
  `evidence/`, `board.log` and `run.json` stay.
- Close your tabs: `chrome-devtools-axi pages`, then `chrome-devtools-axi closepage <id>` for each tab on your port.
- Never `pkill node`, never kill by port or name, never `launchctl` anything.
- Run `stop` after every failed attempt too, so broken runs do not hold ports.
- `scripts/board.mjs runs` lists this checkout's runs and their evidence.
  Delete an old run directory by hand once nobody needs its evidence.

## Helpers

- `scripts/board.mjs`: Node 22, no packages.
  `launch [--fixture | --lanes-copy] [--ttl <minutes>]`, `doctor [<run-id> | --port <n>]`, `env [<run-id>]`, `stop [<run-id>]`, `runs`.
  `VERIFY_AGENT_BOARD_STATE` moves the state directory (the tests use it).
- `scripts/fixture.mjs`: the seeded data.
  Its comments say what each seeded thread, row and branch is for; extend it when a feature needs a state it lacks, and say so in that feature's Gotchas.
- `scripts/git-env.mjs`: removes inherited `GIT_*` variables before fixture Git commands, revision checks, board children and the feature recipes' Git mutations, so the caller cannot redirect them to another repository or index.
- Tests for the helper: `node --test tests/verify_agent_board_test.mjs`.
