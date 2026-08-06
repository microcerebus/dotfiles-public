# Terminal Field Guide

> v1.4 · 2026-07-06 · `term-wiki` opens the visual HTML version; this file is the terminal-native port (renders in nvim via render-markdown, `<leader>ch`).

## cmd keys (VSCode muscle memory)

| Press | Does | How |
|---|---|---|
| `cmd+p` | quick open (Telescope, git-files first) | Ghostty sends `ctrl+p` |
| `cmd+s` | save (insert mode: drops to normal, autosave fires) | sends `ctrl+s` |
| `cmd+z` | undo, insert mode too | sends `ctrl+z` |
| `cmd+a` | select whole buffer | sends `ctrl+a` |
| `cmd+b` | toggle NvimTree sidebar | sends `ctrl+n` (ctrl+b = Herdr prefix) |
| `cmd+c` / `cmd+v` | copy / paste, every mode, every app | Ghostty-native clipboard |
| `cmd+t` / `w` / `d` | terminal tab new / close / split | Ghostty-native |
| `cmd+shift+,` | reload Ghostty config | Ghostty-native |

> [!WARNING]
> Inside tmux `cmd+a` hits the prefix - press twice.
> At a bare shell prompt: `cmd+z` suspends (`fg` returns); `cmd+s` freezes output until the `stty -ixon` rebuild lands (`ctrl+q` unfreezes).

## shell keys

| Press | Does |
|---|---|
| type... | ghost text appears from history (zsh-autosuggestions) |
| `ctrl+f` | accept the ghost text (home row) |
| `TAB` | fzf-tab: fuzzy menu over real completions |
| `ctrl+r` | atuin: search history across all sessions (up-arrow stays session-scoped) |
| `ctrl+t` / `alt+c` | fzf: insert file path / cd into directory |
| `z part-of-path` | zoxide: jump to any directory you have visited |
| `caps` | held = Ctrl, tapped = Esc (Karabiner) |
| `cmd+space` | Raycast (Spotlight disabled) |
| `hyper+g` | focus/launch Ghostty from anywhere (hyper = cmd+alt+ctrl) |

## vim core - the grammar

Vim is a language: **[count] verb + motion/text-object**.
`d2w` = delete two words, `ci"` = change inside quotes, `y}` = yank to end of paragraph.

### Motions

| Key | Goes |
|---|---|
| `h j k l` | left · down · up · right |
| `w` / `b` / `e` | next word start / back / word end (`W B E` = space-delimited) |
| `0` / `^` / `$` | line start / first char / line end |
| `fx` / `tx` | onto / just before next "x" (`F T` backwards; repeat `;`, reverse `,`) |
| `{` / `}` | paragraph up / down |
| `gg` / `G` / `42G` | file top / bottom / line 42 |
| `%` | matching bracket |
| `H M L` | screen top / middle / bottom |
| `ctrl+d` / `ctrl+u` | half-page down / up · `zz` centers cursor line |
| `]f` / `[f` | next / previous function (`]F` `[F` = function end) - treesitter |
| `]k` / `[k` | next / previous class or interface (`]K` `[K` = end) |
| `]i` / `[i` · `]o` / `[o` | next / previous if/switch/try · loop (`]c` `[c` stay git hunks) |

### Operators

| Key | Does |
|---|---|
| `d` / `c` / `y` | delete / change / yank - each takes any motion |
| `dd cc yy` | doubled = whole line |
| `D` / `C` | delete / change to end of line |
| `x` / `rx` / `s` | delete char / replace char / substitute char |
| `>` `<` `=` | indent · outdent · auto-indent (`>ip`, `=ap`) |
| `gu` / `gU` / `g~` | lowercase / uppercase / toggle case |
| `J` | join line below |
| `u` / `ctrl+r` | undo / redo (persistent undo is on) |
| `.` | repeat last change - the most underrated key |

### Text objects

| Key | Selects |
|---|---|
| `iw` / `aw` | inner word / word + space |
| `i"` `i'` `` i` `` | inside quotes (`a"` includes them) |
| `i(` `i[` `i{` `i<` | inside brackets (`a(` includes them) |
| `it` / `at` | inside / around an HTML/JSX tag |
| `ip` / `ap` | inner / around paragraph |
| `if` / `af` | inner / around function (treesitter, arrow fns too) |
| `ic` / `ac` | inner / around class |
| `ia` / `aa` | inner / around argument |
| `ii` / `ai` · `il` / `al` | inner / around if/try · loop |

Combos to internalize: `ciw` rename word · `di(` clear args · `ya"` yank string · `dap` delete block · `cit` edit tag text · `vaf` select function · `cia` change argument.

Surround (mini.surround): `saiw"` quote a word (`sa` + object + char) · `sd"` delete quotes · `sr"'` swap quote style. Swap arguments: `sx` / `sX` with next / previous.

### Insert mode

| Key | Enters |
|---|---|
| `i` / `a` | before / after cursor |
| `I` / `A` | line start / end |
| `o` / `O` | open line below / above |
| `Esc` (tap `caps`) | back to normal - autosave fires on leaving insert |

## vim power

### Search & replace

| Key | Does |
|---|---|
| `/foo` / `?foo` | search fwd / back · `n`/`N` next/prev |
| `*` / `#` | search word under cursor fwd / back |
| `:%s/old/new/g` | replace in file (`/gc` confirms each; visual-select first to scope) |
| `:noh` | clear highlight |
| `:g/pat/d` | run a command on every matching line |

### Visual mode

| Key | Does |
|---|---|
| `v` / `V` / `ctrl+v` | char / line / block select, then any operator |
| `o` / `gv` | swap selection end / reselect last |
| block + `I`/`A` | multi-cursor-style column insert, apply with `Esc` |

### Registers & macros

| Key | Does |
|---|---|
| `"+y` | yank to system clipboard (clipboard is shared; plain `y` works too) |
| `"0p` | paste last yank, ignoring deletes |
| `"_d` | delete into the void (visual paste already preserves clipboard here) |
| `:reg` | inspect registers |
| `qa ... q` | record macro into a (nvim-recorder: `q` toggles, `Q` plays) |
| `@a` / `@@` / `5@a` | play / replay last / play 5 times |

### Marks & jumps

| Key | Does |
|---|---|
| `ma` / `` `a `` | set mark a / jump to it (`` `` `` = previous spot) |
| `ctrl+o` / `ctrl+i` | jumplist back / forward (`BS` = back, here) |
| `g;` / `g,` | previous / next change location |

### Windows & buffers

| Key | Does |
|---|---|
| `:vsp` / `:sp` | vertical / horizontal split |
| `ctrl+h/j/k/l` | move between splits (same letters as tmux panes) |
| `Tab` / `shift+Tab` | next / previous buffer |
| `:w :q :wq :q!` | save · quit · both · discard |

Practice ladder: 1) hjkl + w/b/e + i/a/o → 2) operators × motions, then text objects → 3) f/t + `;`, `%`, marks, `.` → 4) macros, block visual, `:g` - drill with `term-dojo game`.

## neovim (leader = Space)

| VSCode habit | Here | Notes |
|---|---|---|
| Quick open | `cmd+p` / `<leader>ff` | Telescope |
| Search in files | `<leader>fw` | live grep |
| Explorer | `cmd+b` / `<leader>e` | NvimTree |
| Go to definition / hover | `gd` / `K` | LSP |
| Rename / quick fix | `<leader>ra` / `<leader>ca` | LSP (also `<leader>.`) |
| Problems panel | Trouble | diagnostics list |
| Format | `<leader>fm` | Conform; format-on-save off by design |
| CodeLens | `<leader>cl` | run the lens under cursor (servers that offer it, e.g. gopls) |
| Source control | `<leader>lg` · `]c` `[c` | LazyGit float · jump hunks |
| Switch tabs | `Tab` / `shift+Tab` | buffer line |
| **Claude** | `<leader>aa` toggle · `<leader>as` send selection · `<leader>at` send position · `<leader>ap` prompts | sidekick + claude CLI |
| Hop anywhere | `<leader><leader>w` / `l` | hop.nvim |
| Comment | `<leader>/` | gcc under the hood |
| Terminals | `alt+i` / `alt+h` / `alt+v` | float / horizontal / vertical |
| Folds | `za` / `zR` / `zM` | ufo |
| Invert value | `<leader>i` | nvim-toggler (true↔false) |
| Resolve git conflict | `<leader>gxx` | git-conflict |
| Project replace | `alt+R` | grug-far |
| Auto-generated keymap grid | `<leader>cH` (`:NvCheatsheet`) | every mapped key with a desc |

Discoverability: press `Space` and wait - which-key shows every follow-up.

## tmux & herdr

**Herdr** (agent cockpit) - prefix `ctrl+b`:
`c`/`&` tab new/close · `"`/`%` splits · `h j k l` focus · `w` workspace picker · `g` goto · `y` copy-mode.
Rule: when `HERDR_ENV=1`, nothing auto-wraps in tmux.

**tmux** (training env) - prefix `ctrl+a`:
`|`/`-` splits (keep path) · `h j k l` focus · `H J K L` resize · `Tab` last window · `r` reload.
Copy-mode is vi: `v` select, `y` yank to clipboard.
Practice: `term-dojo game` (chapter 6) or `term-dojo tutor tmux`.

## aliases & commands

| Command | Does |
|---|---|
| `rebuild` | apply the flake - the one command that changes the machine |
| `v` · `vim` | nvim (`$EDITOR` too) |
| `lg` | lazygit |
| `g` + git plugin | gst · gco · gaa · gp · glog ... |
| `pn pi pa pad pr pt px` | pnpm family (px = pnpm dlx) |
| `cc` | claude --dangerously-skip-permissions - **trusted repos only** |
| `is` | inshellisense dropdown session, opt-in only |
| `term-dojo` | game · quiz · tutor · stats |
| `term-wiki` | this guide (HTML in browser; `term-wiki md` for this file) |

## Reference

- **Key layers**: Karabiner (caps→ctrl/esc) → Ghostty owns `cmd+*` → tmux `ctrl+a` / Herdr `ctrl+b` → nvim leader `Space`. Never overlap.
- **Two speeds of change**: `files/*` symlinked = instant; `nix/*.nix` = `rebuild` (human runs it). Homebrew cleanup is zap - declare everything in `nix/host.nix`.
- **AI layer**: Claude Code everywhere (`cc` in shell, `<leader>aa` in nvim via sidekick; copilot removed). Hex handles voice-to-text system-wide.
- **Browser split**: agents and CLI-opened links use Google Chrome (`$BROWSER=open-chrome` routes gh/OAuth flows); Brave is personal and off limits to agents.
- **Repo map**: `flake.nix` · `nix/host.nix` (macOS/casks) · `nix/user.nix` (shell/CLI) · `files/` (live configs) · `docs/` · `scripts/`.
- Deep dives: `docs/vscode-to-nvim.md` · `docs/tmux-training.md` · `docs/herdr-workflows.md` · `docs/workflow-north-star.md`.
