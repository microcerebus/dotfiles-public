# Phone and access

the owner reads the board on his phone over Tailscale, so both pages must fit a phone screen and the board must answer only on this Mac's own addresses.
On a narrow screen the clock hides, long titles stop at two lines, and the map is one column; the server answers GET and HEAD for allowlisted Host names only and never changes anything.

## Sub-features

- `phone-threads` fits `/` in 390 pixels: no horizontal scroll, the header clock hidden, long titles clamped to two lines and long branch names cut with an ellipsis.
- `phone-map` makes `/map` one column under 900 pixels, with unit details wrapping to at most two lines.
- `desktop-map` puts `/map` in two columns at 900 pixels and wider.
- `phone-tailnet` serves the same pages at this Mac's MagicDNS name on the run's port, from any device on the tailnet.
- `access-host` answers `403 Host not allowed.` to any Host other than loopback, the tailnet address or this Mac's MagicDNS names on the run's port.
- `access-read-only` answers `405 Read-only.` to anything but GET and HEAD, and `404 Not found.` to any other path.

## How to get to it (user POV)

- Open the phone URL that launch printed (`$BOARD_PHONE_URL/`, then `map` in the header) on a phone on the tailnet.
- Open the same URLs in a narrow desktop window.

## Driving it with chrome-devtools-axi

Preconditions:

- A fixture run, and Tailscale up for the tailnet steps: `$BOARD_PHONE_URL` is not empty.
- The fixture's long-titled idle thread starts `A deliberately long fixture thread title`.

- **Phone threads.** Open the phone URL in a phone-sized tab. Run `chrome-devtools-axi open "$BOARD_PHONE_URL/"` and `chrome-devtools-axi emulate --viewport "390x844x3,mobile,touch"`. The page loads under the MagicDNS name, not 127.0.0.1.
- **Check the fit.** Run `chrome-devtools-axi eval "[innerWidth, document.documentElement.scrollWidth, getComputedStyle(document.querySelector('.clock')).display, [...document.querySelectorAll('.name')].find((n) => n.textContent.startsWith('A deliberately long')).getClientRects()[0].height / parseFloat(getComputedStyle(document.querySelector('.name')).lineHeight)].join(' | ')"`. `390 | 390 | none | 2`: no horizontal scroll, no clock, and the long title is exactly two lines tall.
- **Capture phone threads.** Run `chrome-devtools-axi screenshot "$BOARD_EVIDENCE/phone-threads-phone.png" --full-page`. Nothing is cut at the right edge; the long branch on the long-titled card ends in an ellipsis.
- **Phone map.** Run `chrome-devtools-axi open "$BOARD_PHONE_URL/map"`, `chrome-devtools-axi emulate --viewport "390x844x3,mobile,touch"` and `chrome-devtools-axi eval "[document.documentElement.scrollWidth, getComputedStyle(document.querySelector('.cols')).display, Math.max(...[...document.querySelectorAll('.u .sub')].map((s) => Math.round(s.getClientRects()[0].height / parseFloat(getComputedStyle(s).lineHeight))))].join(' | ')"`. `390 | block | 2` at most: one column, and no unit detail line runs past two lines. Save `phone-map-phone.png` with `--full-page`.
- **Desktop map.** Run `chrome-devtools-axi emulate --viewport "1280x900x1"` on the same tab and `chrome-devtools-axi eval "getComputedStyle(document.querySelector('.cols')).display"`. `grid`. Save `desktop-map-desktop.png`.
- **Host guard.** Send a request with a foreign Host. Run `curl -s -w ' %{http_code}' -H 'Host: board.example.com' "$BOARD_URL/"` and `curl -s -w ' %{http_code}' -H "Host: localhost:4790" "$BOARD_URL/"`. Both print `Host not allowed.` and `403`: the second names the wrong port.
- **Read-only.** Run `curl -s -w ' %{http_code}' -X POST "$BOARD_URL/map"` and `curl -s -w ' %{http_code}' "$BOARD_URL/admin"`. `Read-only.` with `405`, and `Not found.` with `404`. Save the four curl lines to `$BOARD_EVIDENCE/access.txt`.

## Gotchas

- `emulate --viewport` sets the size for one tab only; never `resize`, which reshapes the one Chrome window every agent shares and is floored at 500 pixels by macOS.
- An emulated phone in desktop Chrome is close to the owner's phone, not the same: fonts fall back when JetBrains Mono is not installed on the device, and Safari's line clamping can differ. When a layout fix depends on the real phone, ask the owner to open `$BOARD_PHONE_URL/map` and say so in the report.
- The run binds the tailnet address on its spare port, the same exposure as the live board on 4790; stopping the run closes it.
- Without Tailscale, launch prints no phone URL; check the layout on `$BOARD_URL` and report `phone-tailnet` as not verified.
- The Host check compares the port too, so a request to the right name on the wrong port is refused; that is expected, not a bug.
