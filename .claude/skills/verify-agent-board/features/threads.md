# Thread list

The thread page at `/` lists every open T3 thread in three sections: Needs you (input cards, approvals and lane units that are the owner's turn), Running, and Idle.
Each card shows what the thread is doing or how long ago it stopped, its context use, model, project and branch, and a running card gets a context bar that turns yellow past 200k tokens and red past 230k.

## Sub-features

- `threads-sections` groups threads into `Needs you · N`, `Running · N` and `Idle · N`, and the page title counts what needs the owner.
- `threads-needs` lists pending input cards and approvals, plus lane units that are the owner's turn, oldest first.
- `threads-running` shows the latest tool and how long ago it ran, with the context bar.
- `threads-context-bands` colours the bar teal below 200k, yellow from 200k and red from 230k.
- `threads-quiet` turns a running card red with `no activity N min` after 10 quiet minutes.
- `threads-children` shows a delegated child (`↳ parent`) only while it runs.
- `threads-idle` shows done, failed (red) and stopped threads, the newest 12, then `+N more`.
- `threads-hidden` leaves out settled, archived and deleted threads and idle children.

## How to get to it (user POV)

- Open the board's root URL.
- Choose `threads` in the header from `/map`.

## Driving it with chrome-devtools-axi

Preconditions:

- A fixture run: doctor reports `pages: / and /map render the fixture data`.
- The seeded threads all carry `(fixture)` in their title, apart from the three lane units in Needs you and one long-titled idle thread.

- **Open the page.** Open `/` at desktop width. Run `chrome-devtools-axi open "$BOARD_URL/"` and `chrome-devtools-axi emulate --viewport "1280x900x1"`. The title is `(6) agent board`: five things need the owner plus the auto-update alarm.
- **Read the sections.** Run `chrome-devtools-axi eval "[...document.querySelectorAll('h2')].map((h) => h.textContent).join('\n')"`. `Auto-update`, `Needs you · 5`, `Running · 5`, `Idle · 14`, in that order.
- **Read the cards.** List each card with its state label. Run `chrome-devtools-axi eval "[...document.querySelectorAll('.t')].map((t) => t.querySelector('.name').textContent + ' | ' + (t.querySelector('.state') ? t.querySelector('.state').className + ' ' + t.querySelector('.state').textContent : '')).join('\n')"`. Needs you ends with `Design worker (fixture)` (`peach`, `input card 12 min`) and `Release check (fixture)` (`peach`, `approval`); Running has `Coordinator 3 (fixture)` (`green`, `Bash` and seconds), `Map reviewer (fixture)` (`red`, `no activity 14 min`) and `Delegated lint pass (fixture)`; Idle has `Failed build (fixture)` (`red`, `failed 40 min ago`) and `Stopped spike (fixture)` (`muted`, `stopped 3 h ago`).
- **Context bands.** Run `chrome-devtools-axi eval "[...document.querySelectorAll('.t .ctx i')].map((i) => i.closest('.t').querySelector('.name').textContent + ' | ' + (i.className || 'teal') + ' | ' + i.style.width).join('\n')"`. Five lines: `Design worker (fixture) | teal | 18.2%`, `Release check (fixture) | teal | 6.4%`, `Coordinator 3 (fixture) | teal | 9.6%`, `Board polish worker (fixture) | warn | 20.5%` and `Long refactor worker (fixture) | hot | 23.8%`. Idle cards and cards without a context maximum have no bar.
- **Children and hidden threads.** Check what is not shown. Run `chrome-devtools-axi eval "['Finished child', 'Settled thread', 'Archived thread'].filter((t) => document.body.innerText.includes(t)).length + ' hidden threads shown; ' + document.querySelector('.more').textContent"`. `0 hidden threads shown; +2 more`, and the `Delegated lint pass (fixture)` card has a `↳ Coordinator 3 (fixture)` line.
- **Capture.** Run `chrome-devtools-axi screenshot "$BOARD_EVIDENCE/threads-fixture-desktop.png" --full-page`. The screenshot shows the alarm card first, then the three sections, with the yellow and red bars visible.

## Gotchas

- Times are relative to the launch, and the page reloads every 15 seconds, so labels such as `Bash 27s` and `no activity 14 min` drift; assert the colour class and the word, not the number.
- The quiet flag comes from the Claude log's modification time; the fixture sets it, and editing a log under `$BOARD_SCRATCH/projects` moves it.
- Needs you on this page also carries lane units (`waiting-push`, `await-rebuild`, `apply`) with links to their PR and preview; a `needs-myuser` row whose branch already landed is left out, which [stale rows](./stale-rows.md) owns.
- Context for a thread without T3 context usage comes from its Claude log, which is why `Map reviewer (fixture)` shows `163k` with no maximum and no bar width.
- On live data the counts are whatever is open now; use live mode only to check that real threads still render, not to assert counts.
