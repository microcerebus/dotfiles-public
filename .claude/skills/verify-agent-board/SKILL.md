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
| fixture | `scripts/board.mjs launch --fixture` | Seeded T3 database, Claude logs, four lanes with a git checkout, a stub `gh` answering from editable JSON, and updater state with one alarm, all in the run's scratch dir. Every journey in the feature map starts here. |
| live | `scripts/board.mjs launch` | The real T3 database, Claude logs, `~/orchestrator/lanes` and updater state, read-only. Use it to check a change against T3's real schema and today's lanes. |
| lanes copy | `scripts/board.mjs launch --lanes-copy` | Live T3 data, with `~/orchestrator/lanes` copied into the scratch dir so you can edit a row without touching the real file; symlinked lane files are copied as real files. |

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

Drivers, in this order:

1. **Playwright written flows** for repeatable journeys: scripts in `scripts/flows/`, run with `node`.
   Each one writes its user flow down in its header, prints PASS or FAIL per step and saves the evidence.
   They drive a headless Google Chrome with a throwaway profile (`playwright-core`, a pinned pnpm global), so they never touch the shared agent Chrome window.
   - `flows/map-refresh.mjs`: on a fixture run, `/map` updates by itself after a `units.tsv` change ([project map](features/project-map.md)).
   - `flows/map-pr-live.mjs`: on a fixture run, a PR's checks on `/map` update by themselves when the stub gh's answer changes, at 1440 and 390 ([project map](features/project-map.md)).
   - `flows/look.mjs <url> <dir> <name> [<width>]`: loads one page of your run at 1440x900, or at the width given (390 is a phone, 844 tall at 3x with touch), saves a full-page screenshot and its text with the horizontal overflow measured, and fails unless the page answered 2xx.
     Like every flow, it refuses the live board on port 4790.
   A journey you would run twice belongs in a flow.
   For screen-free checks against the signed-in agent Chrome, run a written flow through `agent-chrome-playwright --minutes N --what "..."` in its own background tab (it notifies the owner before and after); see the codex-computer-use skill.
2. **Codex computer use** for interactive checks no flow covers yet, through the `codex-computer-use` skill and its screen-warning launcher, in the agent Chrome.
   You keep the judgment: pick the feature file, hand Codex its Driving bullets with literal values, then check what it saved.
3. **chrome-devtools-axi, fallback only**: when no flow fits, Codex is out of quota, and `codex-browser-fallback status` exits 0.
   Codex itself uses built-in computer use; being Codex never permits axi.
   The evidence must name the fallback and why, as a `driver:` line in the run's `.txt`, such as `driver: chrome-devtools-axi (Codex out of quota, no flow for stale-rows)`.

- Browser: Google Chrome only, never Brave and never the owner's own Chrome.
  Flows launch their own headless Chrome; Codex and the fallback use the agent Chrome (Google Chrome Beta on 127.0.0.1:9333).
- Codex follows the brief's sentences in the prompt below and never sizes the window, so the phone layout is checked through a Playwright flow (`flows/look.mjs <url> <dir> <name> 390`), not through Codex.
  The bullets below are for the chrome-devtools-axi fallback only.
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

A Codex prompt, filled in from a feature file.
Run every interactive check through the `codex-computer-use` launcher.
It runs `agent-chrome-ready`, shows the screen warning and waits for "Start now" or a timed-out dialog with at least two minutes of idle time.
It never starts Codex after failed readiness or an unanswered warning while the Mac is busy.
The prompt opens with that skill's three browser sentences, as written:

```sh
eval "$(.claude/skills/verify-agent-board/scripts/board.mjs env)"
codex-computer-use --minutes 5 -- "Drive the agent Chrome (Google Chrome Beta, its own profile on 127.0.0.1:9333) through computer use: \
click, type and screenshot in its window. Do not use chrome-devtools-axi, Playwright or any other browser tool, and never Brave or \
the owner's own Chrome. First bring Google Chrome Beta to the front with \
\`osascript -e 'tell application \"System Events\" to set frontmost of process \"Google Chrome Beta\" to true'\`, which cannot start it: \
its launchd agent is the only way Chrome Beta is ever started, so if it is not running, stop and report instead of starting it. \
Every agent shares this one window: open your own new tab and close it when done, never resize or move the window, and never touch \
other tabs. Verify <feature> on the agent board at $BOARD_URL. Steps: <the feature file's Driving bullets as user actions and \
expected results, with $BOARD_URL, $BOARD_SCRATCH and $BOARD_EVIDENCE written out>. Save every screenshot into $BOARD_EVIDENCE. \
Finish with PASS or FAIL and one line per step saying what you saw."
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
    `look.mjs` and `map-pr-live.mjs` record the horizontal overflow in pixels; anything but 0 is text cut off.
- Live-mode evidence shows real thread titles and branches: keep it in the evidence dir, never commit it (every push of this repo republishes a public mirror), and share it only with the owner or the coordinator.

## Cleanup

- `scripts/board.mjs stop` stops this checkout's runs.
  It signals only the keeper it recorded, after confirming that process's command line; the keeper stops the board, deletes `scratch/` and records why.
  If the keeper died, `stop` confirms the board's command and listener before sending TERM, waits for exit, and confirms ownership again before escalating to KILL.
  It removes scratch only after the board exits; a stop failure retains the PID and scratch so the run can be inspected and stopped safely.
  `evidence/`, `board.log` and `run.json` stay.
- Close the tabs you opened through the driver that opened them.
  Only during the active quota fallback, use `chrome-devtools-axi pages` and `chrome-devtools-axi closepage <id>` for each tab on your port.
- Never `pkill node`, never kill by port or name, never `launchctl` anything.
- Run `stop` after every failed attempt too, so broken runs do not hold ports.
- `scripts/board.mjs runs` lists this checkout's runs and their evidence.
  Delete an old run directory by hand once nobody needs its evidence.

## Helpers

- `scripts/board.mjs`: Node 22, no packages.
  `launch [--fixture | --lanes-copy] [--ttl <minutes>]`, `doctor [<run-id> | --port <n>]`, `env [<run-id>]`, `stop [<run-id>]`, `runs`.
  `VERIFY_AGENT_BOARD_STATE` moves the state directory (the tests use it).
- `scripts/flows/`: the Playwright written flows (see Drive) and `playwright.mjs`, which finds the pinned `playwright-core` and launches headless Google Chrome.
- `scripts/fixture.mjs`: the seeded data.
  Its comments say what each seeded thread, row and branch is for; extend it when a feature needs a state it lacks, and say so in that feature's Gotchas.
- `scripts/git-env.mjs`: removes inherited `GIT_*` variables before fixture Git commands, revision checks, board children and the feature recipes' Git mutations, so the caller cannot redirect them to another repository or index.
- Tests for the helper: `node --test tests/verify_agent_board_test.mjs`.
