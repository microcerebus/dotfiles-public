---
name: verify-agent-board
description: "Launch, drive and verify the dotfiles agent board (files/bin/agent-board.mjs) on a throwaway instance from this checkout, and capture proof. Surfaces: the thread list at /, the /map project map with its Stuck list and stale-row flags, the auto-update alarms, the phone layout. Use when a change touches the board or what it reads (T3 state, lane units.tsv, lane.json or ledger.tsv, dotfiles-autoupdate status), when asked to check that the board or the map still shows something, or before calling a board change done. Never drives the live board on port 4790."
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
| Project map: Needs you, Stuck, lanes, milestones, unit rows, dependencies, footer | [project-map](features/project-map.md) | fixture |
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
| T3 copy | `scripts/board.mjs launch --t3-db <copy>` | Live data, with T3's database read from a copy, such as one made with `sqlite3 "file:$HOME/.t3/userdata/statev2.sqlite?mode=ro" "VACUUM INTO '<scratch>/statev2.sqlite'"`. Use it to check a T3 query change against T3's real schema; `.backup` of the live database restarts on every T3 write and may never finish. Combines with `--lanes-copy`. |

- Ready means launch printed `launched <run-id>` with the URLs and exited 0.
  It has already waited for the board's `listening on 127.0.0.1:<port>` line and for both pages to render (not the board error page), and in fixture mode for the seeded data to show.
  Otherwise it exits 1 with the end of `board.log`, and stops what it started.
- Launch prints the local URL, the phone URL, the evidence directory, and the seeded files you may edit.
  A run listens on 127.0.0.1 only, like the live board.
  The phone URL (this Mac's MagicDNS name on the same port) exists only with `--publish`, which has the board publish itself with `tailscale serve --http=<port>`, as the live board does on 4790.
  `tailscale serve` config is shared by the whole Mac: the run removes its handler when it stops, and `--publish` is for the phone checks only.
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
   - `flows/map-pr-live.mjs`: on a fixture run, a PR's checks on `/map` update by themselves when the stub gh's answer changes, at all five viewports ([project map](features/project-map.md)).
   - `flows/map-stuck.mjs`, run through `scripts/board.mjs verify-stuck [--json] [--dry-run]`: on a fixture run, the Stuck list for each scenario in `STUCK_SCENARIOS`, at all five viewports and at 900 px, the narrowest two-column map, and at every width from 320 to 1920 for a line starting with `·`, then the seeded map with every check list open ([project map](features/project-map.md)).
   - `flows/look.mjs <url> <dir> <name> [<viewport>|<width>] [--open]`: loads one page of your run at each of the five viewports, or at the one named by name or width (any other width gets a custom size: under 600 a phone, 844 tall at 3x with touch, otherwise 900 tall at 1x), saves the first screen and the full page with the page text, the horizontal overflow and every rendered line that breaks a line rule (it starts with `·`, splits a parenthetical of up to 24 characters, or ends in a count whose word wraps to the next line), and fails unless every load answered 2xx with zero overflow and no such line.
     `--open` opens every folded list, such as a PR's check list, on each load, as a tap would.
     Like every flow, it refuses the live board on port 4790.
   - `flows/line-sweep.mjs <url> [<from>-<to>] [<step>] [--json] [--open]`: the same layout checks, no overflow and none of the three line faults, at every width from 320 to 1920 by default, on one page resized per width, with no screenshots (9 to 16 seconds a page). Run it on `/` and `/map` after any layout change.
     `flows/line-starts.mjs` is the check both use: it reads the lines Chrome rendered, not the markup, because Chrome breaks after an inline-block even before a no-break space.
   - `flows/viewports.mjs` holds the five viewports every visual check uses by default, the screens the owner reads the board on: `desktop-1920` (1920x1440, half his ultrawide), `small-desktop-1080` (1080x1800, a portrait monitor), `ipad-portrait-744` (744x1133 at 2x, touch), `ipad-landscape-1133` (1133x744 at 2x, touch) and `phone-390` (390x844 at 3x, mobile, touch).
     Flows open every page with its `pageOptions()` rather than writing sizes of their own; only `look.mjs` builds a custom size, for a width you name outside the five, and only `line-sweep.mjs` resizes a page.
   A journey you would run twice belongs in a flow.
   For screen-free checks against the signed-in agent Chrome, run a written flow through `agent-chrome-playwright --minutes N --what "..."` in its own background tab (it notifies the owner before and after); see the codex-computer-use skill.
2. **Codex computer use** for interactive checks no flow covers yet, through the `codex-computer-use` skill and its screen-warning launcher, in the agent Chrome.
   You keep the judgment: pick the feature file, hand Codex its Driving bullets with literal values, then check what it saved.
3. **chrome-devtools-axi, fallback only**: when no flow fits, Codex is out of quota, and `codex-browser-fallback status` exits 0.
   Codex itself uses built-in computer use; being Codex never permits axi.
   The evidence must name the fallback and why, as a `driver:` line in the run's `.txt`, such as `driver: chrome-devtools-axi (Codex out of quota, no flow for stale-rows)`.

- Browser: Google Chrome only, never Brave and never the owner's own Chrome.
  Flows launch their own headless Chrome; Codex and the fallback use the agent Chrome (Google Chrome Beta on 127.0.0.1:9333).
- Codex follows the brief's sentences in the prompt below and never sizes the window, so layouts are checked through a Playwright flow (`flows/look.mjs <url> <dir> <name>` for all five viewports), not through Codex.
  The bullets below are for the chrome-devtools-axi fallback only.
- Values: `eval "$(scripts/board.mjs env)"` exports `BOARD_URL`, `BOARD_PHONE_URL`, `BOARD_EVIDENCE`, `BOARD_SCRATCH`, `BOARD_RUN` and `BOARD_MODE` for this checkout's latest run.
  Every tool call is a new shell, so run it at the start of each call; a Codex prompt needs the literal values, not the variable names.
- Tabs open in the background (the wrapper does that).
  Set the size per tab with `chrome-devtools-axi emulate --viewport`, one of the five: `"1920x1440x1"`, `"1080x1800x1"`, `"744x1133x2,touch"`, `"1133x744x2,touch"` and `"390x844x3,mobile,touch"`.
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
- Under [`scripts/test-sandbox`](../../../scripts/test-sandbox), give the run a short scratch path: `mktemp -d /tmp/<name>.XXXX`.
  The default `mktemp -d` path under /var/folders makes Chrome's singleton socket path too long, and every flow exits 21.
- Name files `<feature>-<state>-<viewport>.png` with the viewport names from `scripts/flows/viewports.mjs`, with the matching `.txt` eval output and `.html` curl beside them.
- Proof standards:
  - Exercise the user path: open the page by URL and the header links, as the owner does on his phone; `render()` in a test is not a drive.
  - Capture the action and the result: for a journey that changes data, capture before, make the change in the scratch data, and capture after the reload.
  - Pair every screenshot with a second view (an `eval` read or the curled HTML) that names the same rows and values.
  - The board must write nothing: `shasum` the scratch lane files before and after a journey when a feature claims read-only.
  - Say "fixture-verified" for fixture runs.
    The fixture proves rendering and the lane and git logic; only a live run proves the board against T3's real schema, so a change to the T3 query or the columns it reads needs a live run too.
  - Visual evidence covers the five viewports by default, the first screen and the full page at each (`map-pr-live.mjs` saves full pages only, because it compares one row across a refresh); a check may narrow to one viewport only when the change cannot affect the others, and says so.
  - Look at every screenshot before reporting: clipped or overlapping text, wrapping, horizontal scroll, and the theme (Catppuccin Mocha, JetBrains Mono).
    `look.mjs` and `map-pr-live.mjs` record the horizontal overflow in pixels; anything but 0 is text cut off. `look.mjs` also lists each line that starts with `·`, splits a short parenthetical or leaves a count without its word; any is a defect.
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
  `launch [--fixture | --lanes-copy] [--t3-db <copy>] [--publish] [--ttl <minutes>]`, `doctor [<run-id> | --port <n>]`, `env [<run-id>]`, `stop [<run-id>]`, `runs`, `verify-stuck [--json] [--dry-run]`.
  `VERIFY_AGENT_BOARD_STATE` moves the state directory (the tests use it).
- `scripts/flows/`: the Playwright written flows (see Drive), `viewports.mjs` with the five default viewports, and `playwright.mjs`, which finds the pinned `playwright-core` and launches headless Google Chrome.
- `scripts/fixture.mjs`: the seeded data.
  Its comments say what each seeded thread, row and branch is for; extend it when a feature needs a state it lacks, and say so in that feature's Gotchas.
- `scripts/git-env.mjs`: removes inherited `GIT_*` variables before fixture Git commands, revision checks, board children and the feature recipes' Git mutations, so the caller cannot redirect them to another repository or index.
- Tests for the helper: `node --test tests/verify_agent_board_test.mjs`.
