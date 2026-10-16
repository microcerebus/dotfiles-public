# Stale rows

A unit row waiting on the owner (state `needs-myuser`) whose branch has already landed gets a yellow `looks stale: ...` line, on the map and in Needs you on both pages, so the owner is not asked for work that is done.
The row keeps its state and stays listed; hovering the line says how the board knows.

## Sub-features

- `stale-branch` flags a row whose branch is merged into, or rebased onto, `origin/<base>`: `looks stale: branch already on main`.
- `stale-pr` flags a row whose PR number ends a squash or merge commit subject on `origin/<base>`: `looks stale: PR #12 merged`.
- `stale-why` puts the reason in the line's hover title.
- `stale-needs-you` repeats the flag in Needs you on `/map` and on `/`.
- `stale-not-flagged` leaves alone a branch merged only locally (still waiting for push) and a row whose PR column is a word such as `rebuild`.
- `stale-follows-git` flags a row once its branch reaches `origin/<base>`, within one page reload.
- `stale-clears` drops the flag and the Needs you entry once the lane owner marks the row done.

## How to get to it (user POV)

- Open `/map` and read the rows under each lane.
- Read Needs you at the top of `/map`.
- Read Needs you on `/`, the thread page.

## Driving it with chrome-devtools-axi

Preconditions:

- A fixture run: doctor reports `pages: / and /map render the fixture data`.
- Lane `fixture-board` has four `you` rows in milestone `M1`: `stale-merged` (branch `feat/merged`, merged), `stale-squash` (PR 12, squash-merged), `waiting-push` (branch `feat/unpushed`, merged into the local `main` only) and `await-rebuild` (branch `feat/merged`, PR column `rebuild`).
- The lane's checkout is the fixture repo at `$BOARD_SCRATCH/repo`.

- **Open the map.** Open `/map` at desktop width. Run `chrome-devtools-axi open "$BOARD_URL/map"` and `chrome-devtools-axi emulate --viewport "1280x900x1"`. The title is `(6) project map` and the page shows `Needs you · 6`.
- **Read the flags.** Read every stale line with its row and reason. Run `chrome-devtools-axi eval "[...document.querySelectorAll('.stale')].map((s) => [s.closest('section') ? s.closest('section').querySelector('.lane b').textContent : 'needs you', s.closest('.u').querySelector('.id').lastChild.textContent, s.textContent, s.title].join(' | ')).join('\n')"`. Exactly four lines: `stale-merged` with `looks stale: branch already on main` and title `feat/merged is merged into origin/main`, and `stale-squash` with `looks stale: PR #12 merged` and title `origin/main has the squash or merge commit of #12`, each once under `needs you` and once under `fixture-board`.
- **Check the controls.** List the lane's `you` rows and whether each is flagged. Run `chrome-devtools-axi eval "[...document.querySelectorAll('section .u')].filter((u) => u.querySelector('.state').textContent === 'you').map((u) => u.querySelector('.id').lastChild.textContent + (u.querySelector('.stale') ? ' flagged' : ' not flagged')).join('\n')"`. `stale-merged flagged`, `stale-squash flagged`, `waiting-push not flagged`, `await-rebuild not flagged`.
- **Capture the map.** Run `chrome-devtools-axi screenshot "$BOARD_EVIDENCE/stale-rows-map-desktop.png" --full-page` and `curl -s "$BOARD_URL/map" -o "$BOARD_EVIDENCE/stale-rows-map.html"`. The screenshot shows the two yellow lines under their rows in both places, and `grep -o 'class="stale"' "$BOARD_EVIDENCE/stale-rows-map.html" | wc -l` prints `4`.
- **Thread page.** Open `/` and read its flags. Run `chrome-devtools-axi open "$BOARD_URL/"` and `chrome-devtools-axi eval "[...document.querySelectorAll('.t .stale')].map((s) => s.closest('.t').querySelector('.name').textContent + ' | ' + s.textContent).join('\n')"`. `stale-merged | looks stale: branch already on main` and `stale-squash | looks stale: PR #12 merged`.
- **Branch lands.** Push the local `main` of the fixture repo, so `feat/unpushed` reaches `origin/main`. Run `node .claude/skills/verify-agent-board/scripts/git-env.mjs -C "$BOARD_SCRATCH/repo" update-ref refs/remotes/origin/main main`, then `chrome-devtools-axi open "$BOARD_URL/map"` and the Check the controls eval again. `waiting-push flagged` now, and `await-rebuild` is still `not flagged`. Save `chrome-devtools-axi screenshot "$BOARD_EVIDENCE/stale-rows-pushed-desktop.png" --full-page`.
- **Owner fixes the row.** Mark `stale-merged` done in the scratch lane file. Run `perl -pi -e 's/^stale-merged\tneeds-myuser/stale-merged\tdone/' "$BOARD_SCRATCH/lanes/fixture-board/units.tsv"`, then `chrome-devtools-axi open "$BOARD_URL/map"` and `chrome-devtools-axi eval "document.title"`. The title drops by one and `stale-merged` shows as a dimmed `done` row with no stale line.
- **Undo.** Run `node .claude/skills/verify-agent-board/scripts/git-env.mjs -C "$BOARD_SCRATCH/repo" update-ref refs/remotes/origin/main main~1` and `perl -pi -e 's/^stale-merged\tdone/stale-merged\tneeds-myuser/' "$BOARD_SCRATCH/lanes/fixture-board/units.tsv"`, or relaunch. The first eval prints its four lines again.

## Gotchas

- The board reads git in each lane's `checkout` against `origin/<base>`, never GitHub, so a merge only counts once it is in the checkout's fetched refs.
- A branch created from main with no commits of its own is an ancestor of main too; the board tells it from a merge by the branch's reflog and does not flag it, and it never flags an origin-only branch whose tip is on main.
- A branch the checkout does not have, or a lane with no `checkout` in `lane.json`, is skipped, and `board.log` in the run directory says why (`cannot check <lane>/<unit> for a stale row: ...`).
- Results are cached per base and branch commit; editing `units.tsv` alone never needs a relaunch.
- On live or lanes-copy data, which rows are flagged depends on the real repos at that moment; prove the behavior on the fixture and use live data only to look for false flags.
