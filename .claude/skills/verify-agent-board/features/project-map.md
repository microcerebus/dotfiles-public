# Project map

The map at `/map` shows each orchestrator lane from its files under the lanes directory: lanes in priority order, each with its coordinator's live state, milestones with a done count and a progress bar, and one row per unit with its state, PR verdict, owner and dependencies.
Units that are the owner's turn are listed first under Needs you, and rows the board could not read are counted in the footer instead of guessed at.

## Sub-features

- `map-lanes` orders lanes by `priority`, with a lane whose `lane.json` is missing or broken last, and shows the coordinator or orchestrator thread live.
- `map-lane-stale` marks a lane `stale, updated N ago` in yellow when its coordinator runs but its files have not changed for two hours.
- `map-notes` prints a lane's file problems as notes, such as `lane.json: missing` and the legacy `state/units.tsv` layout.
- `map-milestones` groups units by milestone in file order, with `N of M done` and a bar coloured by state.
- `map-rows` shows each unit's state word, id, PR chip (`#14 approve r1` linked to GitHub, `no PR`, or a word such as `push`), owner and its live state, note, branch and `since`.
- `map-stalled` turns `since` into a yellow `stalled since` after eight hours in flight.
- `map-nesting` nests a unit under the first unit it waits for in the same lane and milestone, and writes other dependencies out as `after ...`.
- `map-then-you` shows a `needs-myuser` unit as `then you` until everything it waits for is done, then as `you` in Needs you.
- `map-unresolved` draws an unknown or cyclic dependency in yellow, such as `after ? nope`.
- `map-footer` counts skipped rows and unresolved dependencies per lane, with the first few line numbers and reasons.
- `map-nav` links `threads` and `map` in the header of both pages.

## How to get to it (user POV)

- Open `/map` on the board.
- Choose `map` in the header of the thread page.

## Driving it with chrome-devtools-axi

Preconditions:

- A fixture run: doctor reports `pages: / and /map render the fixture data`.
- Lanes `fixture-board` (priority 1, coordinator running), `fixture-docs` (priority 2, its orchestrator thread closed) and `fixture-legacy` (no `lane.json`).

- **Open from the header.** Open `/` and choose `map`. Run `chrome-devtools-axi open "$BOARD_URL/"`, `chrome-devtools-axi emulate --viewport "1280x900x1"`, then `chrome-devtools-axi snapshot` and `chrome-devtools-axi click @<uid of the link named map>`. The title becomes `(6) project map`, and `map` in the header is underlined, not a link.
- **Lanes and notes.** Run `chrome-devtools-axi eval "[...document.querySelectorAll('.lane')].map((l) => l.querySelector('b').textContent + ' | ' + l.querySelector('small').textContent).concat([...document.querySelectorAll('.note')].map((n) => 'note | ' + n.textContent)).join('\n')"`. `fixture-board | priority 1 · Coordinator 3 (fixture) running · updated 5 min ago` (the minutes count up from launch), `fixture-docs | priority 2 · no orchestrator thread · ...`, `fixture-legacy | no coordinator`, then `note | lane.json: missing` and `note | legacy layout: state/units.tsv converts in phase 2`.
- **Milestones.** Run `chrome-devtools-axi eval "[...document.querySelectorAll('.ms')].map((m) => m.innerText.replace('\n', ' | ')).join('\n')"`. `M1 Project map | 1 of 5 done` and `M2 Phone polish | 0 of 4 done`.
- **Rows.** Run `chrome-devtools-axi eval "[...document.querySelectorAll('section .u')].map((u) => [u.querySelector('.state').textContent, u.querySelector('.id').lastChild.textContent, u.querySelector('.pr').textContent, u.parentElement.classList.contains('kids') ? 'nested' : 'top', u.querySelector('.after') ? u.querySelector('.after').textContent : ''].join(' | ')).join('\n')"`. Among the lines: `done | shipped | #11 merged`, `in-flight | map-polish | #14 approve r1 | top`, `then you | phone-check | no PR | nested`, `queued | ghost | no PR | top | after ? nope`, `review | docs-pass | no PR | top` and `queued | research | no PR | nested`.
- **Owner, stall and PR link.** Run `chrome-devtools-axi eval "document.querySelector('a[href$=\"/pull/14\"]').href + '\n' + [...document.querySelectorAll('section .u .sub .yellow, section .u .sub .red')].map((s) => s.className + ' | ' + s.textContent).join('\n')"`. `https://github.com/example/board/pull/14`, then `yellow | stalled since <time>` for `old-stall` and `red | no activity 14 min` for the owner of `docs-pass`.
- **Footer.** Run `chrome-devtools-axi eval "document.querySelector('footer').textContent"`. It ends `fixture-board: 2 rows skipped, 1 dependency unresolved (bad unit id "Bad Row", line 11; 2 fields, header has 9, line 12; after ? nope, line 10).`
- **Capture.** Run `chrome-devtools-axi screenshot "$BOARD_EVIDENCE/project-map-fixture-desktop.png" --full-page` and `curl -s "$BOARD_URL/map" -o "$BOARD_EVIDENCE/project-map-fixture.html"`. Two columns, `fixture-board` on the left.
- **Dependency done.** Mark `map-polish` done in the scratch lane file. Run `perl -pi -e 's/^map-polish\tin-flight/map-polish\tdone/' "$BOARD_SCRATCH/lanes/fixture-board/units.tsv"`, `chrome-devtools-axi wait 16000`, then `chrome-devtools-axi eval "document.title + ' | ' + [...document.querySelectorAll('.u.needs .id')].map((i) => i.lastChild.textContent).join(', ')"`. `(7) project map`, and `phone-check` is now in Needs you and shows `you` in its lane. Save a screenshot as `project-map-dependency-done-desktop.png`.
- **Lane goes stale.** Age the lane files by three hours. Run `touch -A -030000 "$BOARD_SCRATCH"/lanes/fixture-board/*`, `chrome-devtools-axi wait 16000`, then the Lanes and notes eval. `fixture-board` reads `stale, updated 3 h ago` in yellow.
- **Back to threads.** Snapshot, then click the link named `threads`. The title is `(N) agent board` again.
- **Undo.** Relaunch, or run `perl -pi -e 's/^map-polish\tdone/map-polish\tin-flight/' "$BOARD_SCRATCH/lanes/fixture-board/units.tsv"`.

## Gotchas

- The board rereads the lane files on every request, so edits show on the next reload; editing the real `~/orchestrator/lanes` is never part of a journey (the orchestrator is its only writer), so use `--fixture` or `--lanes-copy`.
- Columns are matched by header name; a row with the wrong number of fields is skipped, not repaired, which is why `short` never renders.
- Milestone order is the order of each milestone's first unit in the file, not `lane.json`'s list.
- `since` accepts `HH:MM` (today in Singapore time) or an ISO timestamp; anything else is counted in the footer as `since unreadable`.
- The two-column layout starts at 900 pixels wide; below that the map is one column, as [phone and access](./phone-and-access.md) checks.
