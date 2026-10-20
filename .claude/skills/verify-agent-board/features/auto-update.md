# Auto-update alarms

The thread page shows the dotfiles auto-updater's own status (`scripts/dotfiles-autoupdate status`) as one card.
With an alarm, the card goes first under a peach `Auto-update` heading, its alarm lines are red, and the page title counts it; when the updater is healthy, the card sits quietly below the threads.

## Sub-features

- `updates-alarm-first` puts a card with any alarm above Needs you, with a peach heading and red alarm lines.
- `updates-title-count` adds one to the page title's count while any alarm shows.
- `updates-lines` shows info lines plain and healthy lines muted, in the order alarm, info, ok.
- `updates-healthy-last` moves the card below the threads, with a grey heading, once no alarm is left.
- `updates-thread-page-only` keeps the card off `/map`.
- `updates-live-match` shows the same alarms as the updater's own reader on the live system.

## How to get to it (user POV)

- Open the board's root URL; the card is first when something is wrong, last otherwise.
- The same alarms appear in the zsh banner and at agent session start, from the same reader.

## Driving it with chrome-devtools-axi

These commands are quota fallback only and require active `codex-browser-fallback status`.
Use a written Playwright flow first; otherwise Codex follows the actions and expected results through built-in computer use, without running these axi commands.

Preconditions:

- A fixture run: doctor reports `pages: / and /map render the fixture data`.
- The fixture's switch status at `$BOARD_SCRATCH/daemon/status` has one `fail` line, and its sync status is healthy.

- **Open the page.** Run `chrome-devtools-axi open "$BOARD_URL/"` and `chrome-devtools-axi emulate --viewport "1280x900x1"`. The title is `(6) agent board`.
- **Read the card.** Run `chrome-devtools-axi eval "document.querySelector('h2').outerHTML + '\n' + [...document.querySelectorAll('.line')].map((l) => (l.className.replace('line', '').trim() || 'plain') + ' | ' + l.textContent).join('\n')"`. The first heading is `<h2 class="attn">Auto-update</h2>`, then `red | switch: switch to 1a2b3c4d5e6f exited 1 (fixture); see /var/log/dotfiles-autoupdate.log`, `plain | switch: macOS 27.0.1 is available (fixture)`, `muted | sync: last good run 2 h ago` and `muted | switch: last good run 25 h ago`.
- **Capture the alarm.** Run `chrome-devtools-axi screenshot "$BOARD_EVIDENCE/auto-update-alarm-desktop.png"`. The card is first, with a peach heading and a red line.
- **Clear the alarm.** Remove the fail line and let the page reload. Run `perl -ni -e 'print unless /^fail\t/' "$BOARD_SCRATCH/daemon/status"`, `chrome-devtools-axi wait 16000`, then `chrome-devtools-axi eval "document.title + '\n' + [...document.querySelectorAll('h2')].map((h) => h.textContent + (h.className ? ' (' + h.className + ')' : '')).join('\n')"`. `(5) agent board`, then `Needs you · 5 (attn)`, `Running · 5`, `Idle · 14`, `Auto-update` last with no class.
- **Capture healthy.** Run `chrome-devtools-axi screenshot "$BOARD_EVIDENCE/auto-update-healthy-desktop.png" --full-page`. The card is at the bottom, above the footer, with only grey and plain lines.
- **Map has no card.** Run `curl -s "$BOARD_URL/map" | grep -c 'Auto-update'`. It prints `0`.
- **Undo.** Run `printf 'fail\tswitch to 1a2b3c4d5e6f exited 1 (fixture)\n' >> "$BOARD_SCRATCH/daemon/status"`, or relaunch.
- **Live match.** On a live run (`scripts/board.mjs launch`), compare the red lines with the reader. Run `/bin/bash scripts/dotfiles-autoupdate status | grep '^alarm:'` from the checkout root (the board uses macOS's bash too), then `chrome-devtools-axi open "$BOARD_URL/"` and `chrome-devtools-axi eval "[...document.querySelectorAll('.line.red')].map((l) => l.textContent).join('\n')"`. The same alarms, minus the `alarm: ` prefix; none at all means the card is last and healthy.

## Gotchas

- The board runs the updater's reader on every page load, with a five-second timeout, so a fixture edit shows on the next reload with no relaunch.
- The fixture points the reader's Sill check at an app that does not exist, so it adds no alarm; on live data it can.
- A reader that fails to run becomes one alarm, `could not read the auto-update status: ...`; the unit tests cover it (`node --test tests/agent_board_test.mjs`), and the fixture does not seed it.
- Live alarms reflect this Mac's real updater state, which the board never changes; never fix them from a verification run.
