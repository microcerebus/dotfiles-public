# Herdr workflows

Herdr is the **agent cockpit** (AGENTS.md): a Rust agent multiplexer that runs
*inside* Ghostty, gives every agent a real terminal pane, and keeps sessions
alive on a local server when you close the window. It is not a terminal
emulator and it does not replace tmux (tmux = training; Herdr = agents).

## Install / update (verified 2026-07-05, herdr 0.7.1)

Installed as a **flake input** (`flake.nix` → `inputs.herdr`, wired into
`home.packages` in `nix/user.nix`), pinned in `flake.lock` like hunk.

- Update: `nix flake update herdr` in `~/dotfiles`, then `rebuild`.
- Do **not** use `herdr update` / channels - the binary comes from the Nix
  store (read-only); updates go through the flake.
- After an update that changes the server protocol: `herdr server stop`, then
  relaunch (named sessions: `herdr session stop <name>`).
- Config: `~/.config/herdr/config.toml` → symlinked from
  `files/.config/herdr/config.toml` (theme: catppuccin, auto light/dark).
  Full reference: `herdr --default-config`.

## Keybinding layering

Herdr keeps its default prefix **`ctrl+b`**. The contract
(`docs/tmux-training.md`): Ghostty `cmd+*` · tmux `ctrl+a` · Herdr `ctrl+b`.
No overlap between the three. One soft caveat: Neovim maps `<C-b>` to
NvimTree - inside a Herdr pane use `<leader>e` instead.

Prefix-mode basics: `C-b ?` help · `C-b w` workspace picker · `C-b s`
settings · `C-b q` detach (server keeps agents alive).

## Cockpit layout

Launch `herdr` from a project directory. Agents get panes; Herdr detects
supported CLIs (claude, codex, opencode, …) and shows per-pane status
(blocked / working / done) in the sidebar.

- **Claude Code** pane: `claude` - primary driver.
- **Codex** pane: `codex` - ChatGPT Plus account via `codex login` (browser
  flow; no API key). Useful as a second opinion / parallel worker.
- OpenCode: not installed (no account - PLAN Phase 4 decision).

## Agent skill + HERDR_ENV contract

The Herdr agent skill teaches Claude Code to drive Herdr from inside a pane
(split panes, read sibling output, wait on other agents):

```sh
pnpm dlx skills add ogulcancelik/herdr --skill herdr -g
```

Guardrails:
- The skill refuses to act unless `HERDR_ENV=1` - i.e. only when actually
  running inside a Herdr pane.
- Mirror rule (AGENTS.md + `nix/user.nix`): when `HERDR_ENV=1`, never
  auto-launch tmux wrappers.

## Herdr vs tmux

| Want | Use |
|---|---|
| Run/monitor coding agents, survive disconnects, mobile glance | Herdr |
| Practice terminal mastery, drills, plain shells | tmux (`docs/tmux-training.md`) |
| Both at once | Herdr for agents; a separate Ghostty tab running tmux |

Do not recreate Herdr layouts in tmux or vice versa.
