# dotfiles - Mac-first terminal agent workstation

A reproducible macOS setup built around terminal-native AI agents.
**Nix (nix-darwin + Home Manager)** owns the CLI baseline, **Homebrew** owns
GUI apps, **Ghostty** is the terminal, **tmux** is for terminal training,
**Herdr** is the agent cockpit, **Bruno Krugel's NvChad** is the editor.
Catppuccin + JetBrains Mono Nerd Font everywhere.

> **This is a sanitized public mirror.** It is generated from a private repo,
> so identity values ship as `CHANGE_ME` placeholders, the personal build
> journal is omitted, and `files/VOICE.md` is a blank template rather than a
> filled-in profile. Pull requests here cannot be merged upstream - fork it
> and make it yours. See [Make it yours](#make-it-yours).

Durable rules live in [`AGENTS.md`](AGENTS.md).

---

## Architecture: who owns what

| Layer                  | Owner                                       | Examples                                            |
| ---------------------- | ------------------------------------------- | --------------------------------------------------- |
| CLI tools + shell      | Home Manager (`nix/user.nix`)               | git, ripgrep, nvim, tmux, codex, herdr, pnpm        |
| GUI / macOS apps       | Homebrew, declared in `nix/host.nix`        | Ghostty, OrbStack, Karabiner, Hammerspoon, Raycast  |
| Per-project toolchains | devShells + direnv (`templates/devshells/`) | node, python, opentofu - never global               |
| Editor config          | plain git clone, outside Nix                | `~/.config/nvim` (BrunoKrugel/dotfiles)             |

Two flake inputs beyond the platform (nixpkgs/nix-darwin/home-manager):
[`hunk`](https://github.com/modem-dev/hunk) (terminal diff review) and
[`herdr`](https://github.com/ogulcancelik/herdr) (agent multiplexer), both
pinned in `flake.lock`.

App configs under `files/` are linked **out-of-store** (`mkOutOfStoreSymlink`):
edit them and the change is live immediately - no rebuild. Changes to
`nix/*.nix` or `flake.nix` need a `rebuild`.

## The idea worth stealing

Most of this is ordinary Nix plumbing. Three parts are not:

- **One layer owns each job.** Home Manager for CLI, Homebrew for GUI apps,
  devShells for per-project toolchains. Nothing is installed twice, and
  `homebrew.onActivation.cleanup = "zap"` means an undeclared app does not
  survive the next rebuild. The config is the machine.
- **A keybinding contract across nested TUIs.** Ghostty, tmux, Herdr,
  Hammerspoon, Raycast, and Karabiner each own a disjoint keyspace, written
  down and enforced (see below). Nested terminal multiplexers otherwise eat
  each other's prefixes.
- **Agent instructions as version-controlled files.** `files/AGENTS.md`,
  `files/OPINIONS.md`, and `files/VOICE.md` are symlinked to `~` and read by
  every agent harness. Rules live in git and get reviewed like code, instead
  of being re-explained in every conversation.

## Keybinding contract

Zero overlap between layers; every new binding must respect this:

| Layer       | Owns                   | Notes                                                    |
| ----------- | ---------------------- | -------------------------------------------------------- |
| Ghostty     | `cmd+*`                | defaults; `cmd+d` split, `cmd+t` tab, `cmd+f` search     |
| tmux        | `ctrl+a` prefix        | training only; `C-a C-a` sends a literal through         |
| Herdr       | `ctrl+b` prefix        | agent cockpit inside Ghostty                             |
| Hammerspoon | hyper (`cmd+alt+ctrl`) | `hyper+g` focuses Ghostty, `hyper+r` reloads             |
| Raycast     | `cmd+space`            | Spotlight hotkey disabled via defaults                   |
| Karabiner   | Caps Lock              | tap = Esc, hold = Ctrl (makes both prefixes comfortable) |

Known nesting caveats (inherent to the VSCode-style Neovim config, both have
alternatives): nvim's `C-a` select-all needs `C-a C-a` inside tmux; nvim's
`C-b` file-tree is eaten inside Herdr panes - use `Space e`.
Details: [`docs/tmux-training.md`](docs/tmux-training.md).

## Daily commands

```sh
rebuild            # apply the flake (alias: sudo darwin-rebuild switch --flake ~/dotfiles)
term-dojo          # daily training: 10 questions from YOUR live configs
term-dojo drill X  # hands-on exercises (ghostty|tmux|neovim|motions|shell|git|nix|herdr|agents)
term-dojo tutor X  # interactive tutorial (tmux|vim): do it for real, verified live
dev-doctor         # inspect a project, suggest a devShell
dev-enable node    # drop a devShell template into a project (then: direnv allow)
lg                 # lazygit  ·  v = nvim  ·  c = clear  ·  gst/gco/gaa/gp… (omz git)
pn / pi / pa / pr  # pnpm / install / add / run
```

`ctrl-r` = Atuin history · `ctrl-t` = fzf files · `alt-c` = fzf cd ·
`z <frag>` = zoxide jump · Tab = fzf-tab menu · ghost text = autosuggestions (→).

Generated reference: [`docs/cheatsheet.md`](docs/cheatsheet.md)
(`term-dojo cheatsheet` regenerates it from the live configs).

## Repo map

```
flake.nix               # inputs + darwinConfigurations.<hostname>
nix/host.nix            # macOS defaults, fonts, Touch ID sudo, declarative Homebrew
nix/user.nix            # shell, CLI baseline, aliases, config links, PATH
files/                  # ghostty, tmux, starship, herdr, karabiner, hammerspoon
files/AGENTS.md         # agent rules, symlinked to ~/AGENTS.md and ~/.claude/CLAUDE.md
files/OPINIONS.md       # engineering philosophy agents consult for judgment calls
files/VOICE.md          # writing-voice template (blank in this mirror)
setup/mac.sh            # the ONE bootstrap script (idempotent; human-run only)
tests/mac_setup_test.sh # sandboxed bootstrap test (agents validate here, never live)
scripts/                # term-dojo, dev-doctor, dev-enable, term-wiki
templates/devshells/    # node, python, terraform (opentofu) flakes
docs/                   # guides (see index below)
AGENTS.md               # durable agent rules + sharp edges for THIS repo
CLAUDE.md               # points Claude Code at AGENTS.md
```

Docs index: [tmux training](docs/tmux-training.md) ·
[VSCode → Neovim](docs/vscode-to-nvim.md) ·
[Herdr workflows](docs/herdr-workflows.md) ·
[mobile access](docs/mobile-workflows.md) ·
[secrets](docs/secrets.md) ·
[optional toolchains](docs/optional-toolchains.md) ·
[workflow north star](docs/workflow-north-star.md) ·
[cheatsheet (generated)](docs/cheatsheet.md)

## Make it yours

This mirror will not build until you personalize it. Three placeholders:

| File          | Line                | Set to                                    |
| ------------- | ------------------- | ----------------------------------------- |
| `flake.nix`   | `username`          | `whoami`                                  |
| `flake.nix`   | `hostname`          | `scutil --get LocalHostName`              |
| `nix/user.nix`| `user.name`/`.email`| your git identity                         |

`setup/mac.sh` refuses to run while `flake.nix` still contains `CHANGE_ME`, and
`tests/mac_setup_test.sh` checks both directions.

Then review before your first `rebuild` - this is someone else's machine:

- `nix/host.nix` casks and `masApps` are a personal app list. Cut what you do
  not want. `cleanup = "zap"` **uninstalls anything not declared here**, so a
  first rebuild with the list unchanged will remove your undeclared apps.
- `files/AGENTS.md` and `files/OPINIONS.md` encode opinions, including a model
  routing table with specific cost and quality judgments. Treat them as a
  worked example of the format, not as advice.
- `files/VOICE.md` is a template. Fill it in and keep it private.
- `docs/mobile-workflows.md` enables SSH and exposes the Mac to a tailnet.
  Understand it before following it.

## Reproducing on a fresh Mac

```sh
xcode-select --install
git clone https://github.com/microcerebus/dotfiles-public.git ~/dotfiles && cd ~/dotfiles
$EDITOR flake.nix    # replace the CHANGE_ME placeholders first
bash setup/mac.sh    # installs Determinate Nix + Homebrew, first darwin-rebuild switch
```

Then the manual/interactive tail: clone the Neovim config
([`docs/vscode-to-nvim.md`](docs/vscode-to-nvim.md)), generate a per-device
SSH key ([`docs/secrets.md`](docs/secrets.md)), `codex login`, launch
Karabiner/Hammerspoon once to grant permissions. Sharp edges hit during a real
bootstrap (the Determinate installer reboot, etc.) are recorded in
[`AGENTS.md`](AGENTS.md) - read those first, they will save you an hour.

## Testing

```sh
bash tests/mac_setup_test.sh   # bootstrap logic in a sandboxed HOME w/ stubbed PATH
nix flake check                # flake evaluates
```

Agents never run `setup/mac.sh`, `darwin-rebuild`, or `brew` against the real
system - they propose diffs; the human applies them (`AGENTS.md`).

## License

MIT. See [`LICENSE`](LICENSE).
