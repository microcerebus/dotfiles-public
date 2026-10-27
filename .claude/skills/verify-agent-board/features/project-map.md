# Project map

The map at `/map` shows each orchestrator lane from its files under the lanes directory: lanes in priority order, each with its coordinator's live state, milestones with a done count and a progress bar, and one row per unit with its state, owner, dependencies and its PR as GitHub sees it: state, blockers, head, preview, checks and a one-line summary.
Units that are the owner's turn, and review-ledger blockers whose action is his, are listed first under Needs you as one line each: the ask, the wait, and links to the PR and its preview.
A `needs-myuser` row whose branch already landed reads `stale` and is not in the list ([stale rows](./stale-rows.md)).
Rows the board could not read are warnings beside their lane and counted in the footer, never guessed at.
Nothing on the page is clipped: every line wraps, on a phone and on a desktop.

## Sub-features

- `map-lanes` orders lanes by `priority`, with a lane whose `lane.json` is missing or broken last, and shows the coordinator or orchestrator thread live.
- `map-lane-stale` marks a lane `no update for N h` in yellow when its coordinator runs but its files have not changed for two hours.
- `map-notes` prints a lane's file problems as notes, such as `lane.json: missing` and the legacy `state/units.tsv` layout.
- `map-milestones` groups units by milestone id, with `N of M done` and a bar filled by done only; hovering the bar lists the rest by state (`1 in-flight, 2 needs-myuser, 1 done`).
  `No milestone` comes last and has no bar.
- `map-live-first` shows needs-myuser, in-flight, paused and queued groups in that order within each milestone, keeping dependency nesting within a group.
  The first queued row whose dependencies are all done says `next up`.
  Done rows with a timestamp in the last 24 hours stay visible with a `landed` stamp; older rows fold under an `N done` link.
  Opening that link adds `?done=<lane>/<milestone>` to the URL, so it stays open through the 15-second refresh; choosing `N done · hide` closes it.
- `map-status` puts `nothing needs you` or `N need you`, plus in-flight, stalled, paused and queued counts under the header, then lane links.
  Each nonzero count links to its first row and highlights the target.
  Missing T3 state, missing lane directories and unreadable or partially skipped units files are named in the strip; an incomplete read never says `nothing needs you`.
- `map-rows` shows each unit's state word, id, PR chip (`#14 blocked` from GitHub, else the ledger's `#20 approve r2`, `no PR`, or a word such as `push`; a done unit's PR is `#11 merged` or the bare `#11`), the PR's title as the headline with one sentence from its Solution section, owner and its live state, branch, `since`, and the note in full.
- `map-pr-state` reads each open unit's PR from GitHub through `gh` (one GraphQL call per repo, refreshed in the background): `draft`, `open`, `ready`, `blocked` with what blocks it (`blocked on: 1 check failing: lint`), `merged` or `closed`.
- `map-pr-checks` folds the checks on the PR's head under a `2/3 checks` summary (tap to open: dots, green passed, red failed, yellow running, each linked to its run); failing checks are named on the status line (`blocked on: 1 check failing: lint`) and running ones counted (`1 check running`).
- `map-pr-live` keeps the checks current without a reload: the page's own refresh picks up GitHub's new answer once the cache is older than `AGENT_BOARD_PR_TTL_MS` (45 s live, 3 s in the fixture).
- `map-pr-preview` links the Vercel preview on the exact head (`preview ↗`, with `head eee1111` beside it), or says `no preview`.
- `map-pr-verdict` pairs the ledger's newest verdict with the PR head: `verdict approve r1 on this head` or `on an older head bbb2222`; the ledger is read from `ledger.tsv` or `state/ledger.tsv`, and `review-scope-ledger.json` adds `review ledger: <blockers>`, `approved at this head` and the review rounds.
- `map-needs-pr` lists a review-ledger blocker whose subject is the owner under Needs you, once per PR, as `apply · the owner picks the job batch (order 56) · since ... · #8 draft`; a blocker that only mentions him (`rebase after the owner's PR lands`) and a done unit's blocker are not listed.
- `map-needs-links` gives every Needs you unit row a link to its PR (`#8 draft`) and, when the head has one, `preview ↗`.
- `map-warnings` renders a row the board cannot read as an `unreadable units.tsv line 3` row beside its lane with why (`unknown state "in-progress"; states are ...`), and a ledger problem as a note.
- `map-lane-stale-day` marks a lane `no update since 15 Oct 09:12` in yellow when none of its files changed for a day, whoever runs it; `GitHub: <error>` when gh fails, so PRs keep their ledger verdict.
- `map-stalled` turns `since` into a yellow `in flight <duration>, since <date>` after eight hours in flight.
- `map-nesting` nests a unit under the first unit it waits for in the same lane and milestone, and writes other dependencies out as `after ...`.
- `map-then-you` shows a `needs-myuser` unit as `then you` until everything it waits for is done, then as `you` in Needs you.
- `map-unresolved` draws an unknown or cyclic dependency in yellow, such as `after ? nope`.
- `map-footer` counts skipped rows and unresolved dependencies per lane, with the first few line numbers and reasons.
- `map-nav` links `threads` and `map` in the header of both pages.

## How to get to it (user POV)

- Open `/map` on the board.
- Choose `map` in the header of the thread page.

## Driving it with chrome-devtools-axi

These commands are quota fallback only and require active `codex-browser-fallback status`.
Use a written Playwright flow first; otherwise Codex follows the actions and expected results through built-in computer use, without running these axi commands.

Written flows, on a fixture run:

- `node scripts/flows/map-refresh.mjs` covers `map-then-you` and the page refreshing itself after a lane edit (the Dependency done journey below), with screenshots and reads saved as `project-map-refresh-*` in `$BOARD_EVIDENCE`.
- `node scripts/flows/map-pr-live.mjs` covers `map-pr-state`, `map-pr-checks`, `map-pr-preview` and `map-pr-live`: it reads the `preview-live` row at all five viewports, lets the fixture's `e2e` check finish in `$BOARD_SCRATCH/gh/prs-board.json`, and waits for the page's own refresh to show `#16 ready` and `2/2 checks`, saving `project-map-pr-live-*` with the horizontal overflow of every page (0 means nothing is cut off).
- `node scripts/flows/look.mjs "$BOARD_URL/map" "$BOARD_EVIDENCE" map` saves the first screen and the full page at the five viewports with the overflow measured; open the done fold with `"$BOARD_URL/map?done=fixture-board%2FM1"` and the name `map-done` for the same set.
  It also saves JSON with the viewport, overflow, strip bounds and lane bounds.
  Full-page PNGs keep the device scale unless the page is taller than 16384 device pixels, where Chrome repeats a tile of the image; those are saved at CSS pixels, and the JSON's `fullScale` says which.
  Set `VERIFY_AGENT_BOARD_ENGINE=webkit` for an explicit WebKit pass on the iPad layouts; Chrome remains the default.
  For the uneven three-lane case, `seedMapShape(dir)` from `scripts/fixture.mjs` writes a fresh lanes directory with 51/17/106 units and 22/8/35 not done, using made-up names only.
  On a fixture run, replace the scratch lanes directory with that directory, then repeat `look.mjs` at all five viewports.
  At 1280 px and up all three lanes must occupy separate columns.
  At 900-1279 px two adjacent lanes share a column: lanes 1 and 2 on the left for this shape, because 22+8 rows beside 35 makes a shorter page than 22 beside 8+35.

Run them first; use the recipe below for the other sub-features.

Preconditions:

- A fixture run: doctor reports `pages: / and /map render the fixture data`.
- Lanes `fixture-board` (priority 1, coordinator running), `fixture-docs` (priority 2, its orchestrator thread closed), `fixture-jobs` (priority 3, laid out like job-tracker: ledger and review budgets under `state/`, one `in-progress` row, files two days old) and `fixture-legacy` (no `lane.json`).
- The fixture's `gh` is a stub at `$BOARD_SCRATCH/gh/gh` answering from `prs-board.json` and `prs-jobs.json` beside it; the board asks it again 3 s after its last answer.

- **Open from the header.** Open `/` and choose `map`. Run `chrome-devtools-axi open "$BOARD_URL/"`, `chrome-devtools-axi emulate --viewport "1920x1440x1"`, then `chrome-devtools-axi snapshot` and `chrome-devtools-axi click @<uid of the link named map>`. The title becomes `(5) project map`, and `map` in the header is underlined, not a link.
- **Lanes and notes.** Run `chrome-devtools-axi eval "[...document.querySelectorAll('.lane')].map((l) => l.querySelector('b').textContent + ' | ' + l.querySelector('small').textContent).concat([...document.querySelectorAll('.note')].map((n) => 'note | ' + n.textContent)).join('\n')"`. `fixture-board | priority 1 · Coordinator 3 (fixture) running · updated 5 min ago · PRs 8s ago` (the minutes count up from launch), `fixture-docs | priority 2 · no orchestrator thread · ...`, `fixture-jobs | priority 3 · Long refactor worker (fixture) running · no update since <two days ago, as 21 Oct 16:18> · PRs ...`, `fixture-legacy | no coordinator`, then `note | lane.json: missing` and `note | legacy layout: state/units.tsv converts in phase 2`.
- **Milestones.** Run `chrome-devtools-axi eval "[...document.querySelectorAll('.ms')].map((m) => m.innerText.replace('\n', ' | ')).join('\n')"`. `M1 Project map | 1 of 5 done`, `M2 Phone polish | 0 of 5 done` and `J1 Leads | 0 of 2 done`.
- **Rows.** Run `chrome-devtools-axi eval "[...document.querySelectorAll('section .u')].map((u) => [u.querySelector('.state').textContent, u.querySelector('.id').lastChild.textContent, u.querySelector('.pr').textContent, u.parentElement.classList.contains('kids') ? 'nested' : 'top', u.querySelector('.after') ? u.querySelector('.after').textContent : ''].join(' | ')).join('\n')"`. Among the lines: `in-flight | map-polish | #14 blocked | top`, `in-flight | preview-live | #16 open | top`, `then you | phone-check | no PR | top | after map-polish`, `queued | ghost | no PR | top | after ? nope`, `in-flight | docs-pass | no PR | top`, `queued | research | no PR | top | after docs-pass`, `in-flight | leads | #7 open | top`, `paused | apply | #8 draft | top | after leads`, and the warnings `unreadable | units.tsv line 12 | Bad Row | top`, `unreadable | units.tsv line 13 |  | top` and `unreadable | units.tsv line 3 | exports | top`.
- **Done fold.** `shipped` is absent initially.
  Open the `1 done` link under `M1 Project map`, then repeat the Rows read.
  It now includes `done | shipped | #11 merged | top`.
  The URL contains `done=fixture-board%2FM1`; wait for the automatic refresh and confirm `shipped` stays visible.
  Choose `1 done · hide` and confirm it disappears.
- **PR lines.** Run `chrome-devtools-axi eval "[...document.querySelectorAll('section .u')].filter((u) => u.querySelector('.pr-block')).map((u) => [u.querySelector('.id').lastChild.textContent, ...[...u.querySelectorAll('.pr-block .meta')].map((m) => m.textContent), u.querySelector('.more summary') ? u.querySelector('.more summary').textContent : '', u.querySelector('.checks') ? u.querySelector('.checks').textContent : ''].join(' | ')).join('\n')"`. One status line per PR, then what the folded `<details>` holds: `map-polish | blocked on: 1 check failing: lint · head bbb0000 · preview ↗ · verdict approve r1 on this head | 2/3 checks | buildlinte2e`, `preview-live | 1 check running · head eee1111 · preview ↗ | 1/2 checks | builde2e`, `leads | 1 check running · head aaa1111 · preview ↗ · verdict approve r1 on this head | review ledger: hosted walkthrough on aaa1111 · approved at this head · 2 review rounds, 1 extra allowed | 1/2 checks · review ledger | verifypreview` and `apply | behind main · head ccc3333 · no preview · verdict changes r1 on an older head bbb2222 | review ledger: the owner picks the job batch (order 56) | review ledger: rebase after #7 · 1 review round | 1/1 checks · review ledger | verify`. The blocker that is the owner's own action stays inline in peach; the rest of the ledger and the check list open on tap.
- **Titles and summaries.** Run `chrome-devtools-axi eval "[...document.querySelectorAll('section .u .title')].map((t) => t.closest('.u').querySelector('.id').lastChild.textContent + ' | ' + t.textContent + ' | ' + (t.nextElementSibling.classList.contains('summary') ? t.nextElementSibling.textContent : '')).join('\n')"`. The PR title is the headline and the summary is the first sentence of the description's Solution section, whole: `map-polish | feat(map): polish the unit rows (fixture) | Wrap every line.`, `leads | feat(leads): add the Leads screen (fixture) | Leads and Applied tabs.`, `preview-live | feat(map): live check status (fixture) | Shows each check as it finishes, so the map reads like the PR page.` among them.
- **Needs you from a PR blocker.** Run `chrome-devtools-axi eval "[...document.querySelectorAll('.todo')].map((u) => u.querySelector('.id').textContent + ' | ' + (u.querySelector('.ask') ? u.querySelector('.ask').textContent : '') + ' | ' + [...u.querySelectorAll('a')].map((a) => a.href).join(' ')).join('\n')"`. Five lines; one is `apply | the owner picks the job batch (order 56) · since <two days ago> · #8 draft | https://github.com/example/jobs/pull/8`, and `stale-merged` and `stale-squash` are absent.
- **Owner, stall and PR link.** Run `chrome-devtools-axi eval "document.querySelector('a[href$=\"/pull/14\"]').href + '\n' + [...document.querySelectorAll('section .u .sub .yellow, section .u .sub .red')].map((s) => s.className + ' | ' + s.textContent).join('\n')"`. `https://github.com/example/board/pull/14`, then `yellow | in flight 10 h, since <time>` for `old-stall` and `red | no activity 14 min` for the owner of `docs-pass`.
- **Footer.** Run `chrome-devtools-axi eval "document.querySelector('footer').textContent"`. It ends `fixture-board: 2 rows skipped, 1 dependency unresolved (bad unit id "Bad Row", line 12; 2 fields, header has 9, line 13; after ? nope, line 11). fixture-jobs: 1 row skipped (unknown state "in-progress", line 3).`
- **Capture.** Run `chrome-devtools-axi screenshot "$BOARD_EVIDENCE/project-map-fixture-desktop-1920.png" --full-page` and `curl -s "$BOARD_URL/map" -o "$BOARD_EVIDENCE/project-map-fixture.html"`. Three columns, `fixture-board` on the left.
- **Dependency done.** Mark `map-polish` done in the scratch lane file. Run `perl -pi -e 's/^map-polish\tin-flight/map-polish\tdone/' "$BOARD_SCRATCH/lanes/fixture-board/units.tsv"`, `chrome-devtools-axi wait 16000`, then `chrome-devtools-axi eval "document.title + ' | ' + [...document.querySelectorAll('.u.needs .id')].map((i) => i.lastChild.textContent).join(', ')"`. `(6) project map`, and `phone-check` is now in Needs you and shows `you` in its lane. Save a screenshot as `project-map-dependency-done-desktop-1920.png`.
- **Lane goes quiet.** Age the lane files by three hours. Run `touch -A -030000 "$BOARD_SCRATCH"/lanes/fixture-board/*`, `chrome-devtools-axi wait 16000`, then the Lanes and notes eval. `fixture-board` reads `no update for 3 h` in yellow.
- **A check finishes.** Let PR 16's `e2e` check pass in the stub gh's answer. Run `node -e "const f=process.argv[1],j=JSON.parse(require('fs').readFileSync(f,'utf8')),c=j.data.repository.p16.commits.nodes[0].commit;Object.assign(c.statusCheckRollup.contexts.nodes.find((n)=>n.name==='e2e'),{status:'COMPLETED',conclusion:'SUCCESS'});c.statusCheckRollup.state='SUCCESS';j.data.repository.p16.mergeStateStatus='CLEAN';require('fs').writeFileSync(f,JSON.stringify(j,null,2))" "$BOARD_SCRATCH/gh/prs-board.json"`, `chrome-devtools-axi wait 20000`, then the PR lines eval. `preview-live | head eee1111 · preview ↗ | 2/2 checksbuilde2e`, and its chip reads `#16 ready`. The written flow `map-pr-live.mjs` does this with screenshots at both widths.
- **Back to threads.** Snapshot, then click the link named `threads`. The title is `(N) agent board` again.
- **Undo.** Relaunch, or run `perl -pi -e 's/^map-polish\tdone/map-polish\tin-flight/' "$BOARD_SCRATCH/lanes/fixture-board/units.tsv"`.

## Gotchas

- The board rereads the lane files on every request, so edits show on the next reload; editing the real `~/orchestrator/lanes` is never part of a journey (the orchestrator is its only writer), so use `--fixture` or `--lanes-copy`.
- Columns are matched by header name; a row with the wrong number of fields is skipped, not repaired, which is why `short` never renders.
- Milestones sort by id; row order within each state group follows the file and dependency tree.
  Dependencies in another state group are written as `after` lines.
- A done row's `since` is its completion timestamp when no cached PR merge timestamp is available.
  Missing, invalid and future timestamps stay in the done fold.
- `since` accepts `HH:MM` (today in Singapore time) or an ISO timestamp; anything else is counted in the footer as `since unreadable`.
- The two-column layout starts at 900 pixels wide; below that the map is one column, as [phone and access](./phone-and-access.md) checks.
- PR state needs `gh` with a token that can read the lane's repo; in a live run the lane header says `GitHub: <error>` when it cannot, and the first render says `loading PR state from GitHub` until the background call answers (one self-refresh).
- A PR is asked for only while its unit is not done, so a done unit's chip uses any cached GitHub state, otherwise the ledger's word (`#11 merged`).
