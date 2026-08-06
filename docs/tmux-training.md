# tmux training

tmux exists in this setup for **terminal mastery training** (AGENTS.md). Herdr
does agent orchestration; don't rebuild Herdr layouts in tmux. Phase 5's
term-dojo generates drills from *this* config - keep doc and config in sync.

## Keybinding layering contract

Three layers, zero overlap. This is the rule every future binding must obey:

| Layer   | Owns                          | Examples                              |
|---------|-------------------------------|---------------------------------------|
| Ghostty | `cmd+*` (macOS-native chords) | `cmd+t` tab, `cmd+d` split, `cmd+c/v` |
| tmux    | `C-a` prefix + what follows   | `C-a |`, `C-a z`, `C-a [`             |
| Herdr   | its own in-app bindings       | must not require `cmd+*` or `C-a`     |

Support layer: Karabiner maps **Caps Lock → Ctrl (held) / Escape (tapped)**,
so the tmux prefix is a comfortable pinky-roll (`caps+a`) and Escape is home-row
for Neovim. Hammerspoon binds only hyper chords (`cmd+alt+ctrl+*`), which no
layer above uses. If `HERDR_ENV=1`, never auto-launch tmux (AGENTS.md).

## Core bindings (this repo's config)

Prefix is **`C-a`** (`C-b` is unbound). `C-a C-a` sends a literal `C-a` through.

### Sessions
- `tmux new -s <name>` / `tmux attach -t <name>` - named sessions survive the terminal
- `C-a d` - detach (session keeps running)
- `C-a s` - session picker

### Windows (tabs)
- `C-a c` - new window · `C-a ,` - rename
- `C-a 1..9` - jump by number (windows start at 1)
- `C-a n` / `C-a p` - next/previous · `C-a Tab` - last window (alt-tab style)

### Panes
- `C-a |` - split right · `C-a -` - split down (both keep current path)
- `C-a h/j/k/l` - move focus (vim directions)
- `C-a H/J/K/L` - resize, **repeatable**: keep tapping without re-pressing prefix
- `C-a z` - zoom pane to full window (toggle) · `C-a x` - kill pane
- `C-a q` - flash pane numbers, press one to jump

### Copy-mode (vi)
- `C-a [` - enter copy-mode, then move with `h/j/k/l`, `w/b`, `/` to search
- `v` - start selection · `y` - yank to system clipboard and exit
- `C-a ]` - paste tmux buffer

### Meta
- `C-a r` - reload this config · mouse works (scroll, click panes, drag borders)

## Drills

Do each daily until it's reflex; then it graduates.

1. **Session lifecycle**: create named session → run something → detach →
   attach from a new Ghostty tab → kill it. Under 30 seconds.
2. **Window flow**: 3 windows, rename each, hop by number, then bounce between
   two with `C-a Tab` only.
3. **Pane sculpting**: build a 3-pane layout (editor top, two shells below)
   with `|` and `-`, resize with held `H/J/K/L`, zoom one, unzoom, kill all.
4. **Copy-mode**: run `ls -la`, enter copy-mode, search a filename with `/`,
   select it with `v`, yank, paste into the prompt - no mouse.
5. **Recovery**: close the Ghostty window with tmux still attached, reopen
   Ghostty, reattach. Nothing lost.

## Graduation criteria (gate for Phase 5 term-dojo)

- All five drills done without consulting this doc.
- You reach for `C-a` bindings before the mouse for splits/focus/resize.
- You can explain the layering table from memory - which layer owns a chord
  and why a new binding does or doesn't clash.
