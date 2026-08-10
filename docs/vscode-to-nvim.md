# VSCode → Neovim

The Neovim setup is a personal NvChad v2.5 config that deliberately mimics
VSCode keybinds and UI (AGENTS.md: never swap this base for another distro).
Credit: this config was inspired by
[Bruno Krugel's dotfiles](https://github.com/BrunoKrugel/dotfiles) - an NvChad
config built by a VSCode user migrating to nvim. The `nvim` binary comes
from Home Manager; the config is a **plain git clone outside the Nix store** so
it stays fast to iterate on.

## Install / update procedure

Installed 2026-07-05 (PLAN Phase 3):

```sh
git clone https://github.com/BrunoKrugel/dotfiles ~/.config/nvim
cd ~/.config/nvim && git checkout -b myhost   # local tweaks live here
nvim --headless "+Lazy! sync" +qa              # first launch: plugins + base46 cache
```

Local tweaks are committed on the `myhost` branch. To pull upstream updates:

```sh
cd ~/.config/nvim
git fetch origin && git rebase origin/master   # replays our tweaks on top
nvim --headless "+Lazy! sync" +qa
```

If a rebase conflicts, resolve favoring upstream structure and re-apply our
tweaks minimally (they are deliberately tiny - see log on `myhost`).

Local tweaks so far:
- `lua/chadrc.lua`: `theme = "catppuccin"` (base46 builtin ≈ Mocha; AGENTS.md
  theme rule), `theme_toggle = { "catppuccin", "catppucin-latte" }`.
- `lua/plugins/init.lua`: wakatime removed (unused, nagged for an API key);
  blink.pairs uses `download()` (prebuilt lib) since Rust isn't global.
- `lua/configs/lspconfig.lua`: yamlls uses the public schema store - the
  upstream version reads `SCHEMA_*` env vars from a work machine and crashes without
  them ("table index is nil").
- `lua/plugins/init.lua`: which-key re-enabled (upstream disables it) - the
  leader-key hint popup is the discoverability net while bindings are being
  learned; flip back off once they're muscle memory.
- `lua/plugins/init.lua`: gitsigns `current_line_blame = true` - GitLens-style
  inline blame (Kun-video QOL adoption, 2026-07-06).
- `lua/mappings.lua`: insert-mode `<C-s>`/`<C-z>` (so Ghostty's cmd+S/cmd+Z
  translation doesn't type literal `^S`/`^Z` while typing) and
  clipboard-preserving visual paste (`xnoremap <expr> p ...`), both from the
  Kun-video QOL adoption (2026-07-06).
- AI layer swap (2026-07-06): copilot.lua/copilot-lsp removed everywhere
  (plugin, LSP entry, blink Tab chain, statusline global); sidekick.nvim now
  drives the **claude CLI** - `<leader>aa` toggle, `<leader>as` send visual
  selection, `<leader>at` send cursor position, `<leader>ap` prompt picker.
  Sidekick NES stays off (it needs copilot-lsp). Hex (voice) needs no nvim
  config - it types into any focused input, including nvim in Ghostty.
- Unused language plugins dropped (2026-07-06): kotlin.nvim, wezterm-types,
  and the Go-only test stack (neotest + neotest-golang, nvim-coverage,
  persistent-breakpoints) with their mappings/usercmds/edgy panels. Re-add
  neotest with `nvim-neotest/neotest-jest` / `neotest-python` if in-editor
  test running is wanted for the actual stack.
- Structural navigation added (2026-07-06): nvim-treesitter-textobjects (main
  branch, in `lua/configs/textobjects.lua`) - `]f`/`[f` functions, `]k`/`[k`
  classes, `]i`/`]o` conditionals/loops, `af`/`if`/`ac`/`ia`… textobjects,
  `sx`/`sX` argument swap. Try/catch folded into `@conditional` via
  `after/queries/ecma/textobjects.scm`. Same audit fixed silently-dead config:
  nvim-ts-autotag (duplicate `dependencies` key), mini.surround (`ops` typo -
  `sa`/`sd`/`sr` work now), and LSP codelens (`<leader>cl`, wrong capability
  path), plus removed inert master-branch treesitter module config.

External deps: `tree-sitter` CLI (Home Manager) - parsers fail to compile
without it. Font is inherited from Ghostty (JetBrains Mono Nerd Font); the
upstream README mentions Hack + WezTerm, both intentionally not used here.

## VSCode muscle memory → this config

Leader is **Space**. Bindings come from NvChad defaults + this config's
`lua/mappings.lua` (the authoritative list: `<leader>ch` opens the cheatsheet).

**The cmd key works for the core habits.**
Ghostty translates a small set of cmd chords into the ctrl bytes this config
already binds (see the VSCode block in `files/.config/ghostty/config`), so
`cmd+P/S/Z/A/B` behave like VSCode inside Neovim - no Neovim changes needed,
and it survives tmux and Herdr because plain control bytes pass through.
`cmd+C`/`cmd+V` are Ghostty's native copy/paste and already work everywhere.
Caveats: `cmd+A` inside tmux hits the prefix (press it twice); `cmd+S` at a
bare shell prompt is XOFF until the `stty -ixon` rebuild lands (`ctrl+q`
unfreezes); `cmd+Z` at a shell prompt suspends the job (`fg` returns).

| VSCode habit | Here | Notes |
|---|---|---|
| `cmd+P` quick open | `cmd+P` / `<C-p>` (or `<leader>ff`) | Telescope; git-files first, falls back to all files |
| `cmd+shift+F` search in files | `<leader>fw` | Telescope live grep |
| `cmd+B` / `cmd+shift+E` explorer | `cmd+B` / `<C-b>` or `<leader>e` | NvimTree toggle (cmd+B emits `<C-n>`, not `<C-b>`, to dodge Herdr's prefix) |
| `cmd+S` save | `cmd+S` / `<C-s>` | NvChad default (normal mode) |
| `cmd+Z` undo | `cmd+Z` / `<C-z>` | mapped in normal mode |
| `cmd+A` select all | `cmd+A` / `<C-a>` | **inside tmux press it twice** - tmux prefix eats the first one |
| `cmd+C` / `cmd+X` / `cmd+V` | `cmd+C` / `<C-x>` / `cmd+V` | Ghostty-native clipboard; `<C-c>`/`<C-v>` also work in normal mode |
| `cmd+shift+M` problems panel | Trouble (diagnostics tab) | VSCode-style diagnostics list |
| `F2` / rename symbol | `<leader>ra` | NvChad LSP rename |
| `cmd+.` quick fix | `<leader>ca` | LSP code action |
| `F12` go to definition | `gd` (hover docs on `K`) | LSP |
| format document | `<leader>fm` | Conform; format-on-save is off by design |
| find/replace in file | `<C-r>` → SearchBox | the `Match`/SearchBox flow |
| global search & replace | `<A-R>` | GrugFar panel |
| terminal toggle | `<A-i>` (float) / `<A-h>` / `<A-v>` | NvChad terms |
| go back / forward | `<BS>` / `<C-o>`·`<C-i>` | jumplist |
| switch tabs | `<Tab>` / `<S-Tab>` | NvChad tabufline (buffers) |
| command palette-ish | `<leader>ch` cheatsheet, `<leader>th` themes | discoverability |

Extras worth learning early: `]c`/`[c` git hunks, `]f`/`[f` functions and
`]k`/`[k` classes (treesitter), `<leader>lg` LazyGit, `<leader><leader>w` Hop
to any word, `<C-h/j/k/l>` move between splits (consistent with the tmux pane
keys under its prefix).

## Deliberate divergences

- Theme forced to Catppuccin via NvChad's own base46 mechanism (no second
  theming system); upstream defaults to a custom Frappé variant.
- Font/terminal: upstream uses Hack Nerd Font + WezTerm; we inherit JetBrains
  Mono Nerd Font from Ghostty and change nothing in nvim.
- Neovim's `<C-a>` (select all) collides with the tmux prefix by design of
  the upstream config; tmux wins when nested - `C-a C-a` passes through. Everything
  else respects the layering contract in `docs/tmux-training.md`.
