# Agent board verification map

This directory is the maintained source for verifying what the owner sees on the agent board.
Read this index before driving the board, then use the matching feature file as the recipe.

## Baseline preconditions

- A run of your own, never the live board on port 4790: `scripts/board.mjs launch --fixture` (paths relative to the skill directory).
- `scripts/board.mjs doctor` exits 0 and reports `pages: / and /map render the fixture data`.
- `eval "$(scripts/board.mjs env)"` at the start of every shell call, for `$BOARD_URL`, `$BOARD_SCRATCH` and `$BOARD_EVIDENCE`.
- The fixture as seeded, unless a recipe's preconditions say otherwise.
  A journey that edits scratch data says how to undo it; relaunching also restores the seed.

## Driving conventions

- Run the feature's Playwright written flow when it has one (`scripts/flows/`, see the skill's Drive section).
- Otherwise Codex drives the agent Chrome through built-in computer use, using the feature's actions and expected results.
  Do not give Codex the axi commands as its driver.
- `chrome-devtools-axi` requires a confirmed Codex usage limit and active `codex-browser-fallback status`; its evidence names the fallback and why.
- The rest of this list is for that active quota fallback only.
- Open each page with `chrome-devtools-axi open <url>`; it opens a background tab.
- Size each tab with `chrome-devtools-axi emulate --viewport`, never `resize`.
- Read values with `chrome-devtools-axi eval` over the selectors each recipe names, not from screenshot pixels.
- The page reloads every 15 seconds.
  After a data change, run `chrome-devtools-axi wait 16000` before reading, and take a fresh snapshot before any click.
- Treat every command as literal: keep quoted names, selectors and flags unchanged.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof is a screenshot plus the `eval` output that names the same rows, saved as `<feature>-<state>-<viewport>.png` and `.txt` in `$BOARD_EVIDENCE`, with the viewport names from `scripts/flows/viewports.mjs`.
- A layout change is shot at all five viewports, the first screen and the full page at each: `node scripts/flows/look.mjs <url> "$BOARD_EVIDENCE" <name>`.
  The journeys below run at `desktop-1920` (`"1920x1440x1"`) unless they name a phone.
- For a data change, capture before and after, and save the changed scratch file or the git command you ran.
- Record the feature file and sub-feature ID with every artifact.
- Report an unreachable path with the command you ran and the precondition that was missing.
- Do not report a sub-feature as verified through a different entry point, and do not report fixture evidence as a live check.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior.
It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with chrome-devtools-axi` names the feature's written flow first when it has one, then starts the agent Chrome recipe with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map.
Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Thread list](./threads.md) covers the needs-you, running and idle sections, context bars and quiet runs on `/`.
- [Auto-update alarms](./auto-update.md) covers the alarm card above the threads and the quiet healthy card below them.
- [Project map](./project-map.md) covers lanes, milestones, unit rows, dependencies and the skipped-row footer on `/map`.
- [Stale rows](./stale-rows.md) covers the yellow flag on a needs-myuser row whose branch already landed.
- [Phone and access](./phone-and-access.md) covers the phone layout, the tailnet URL, and the read-only and Host guards.
