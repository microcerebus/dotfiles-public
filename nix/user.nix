# User layer: shell, CLI baseline, and config files linked into place.
# Layer ownership (AGENTS.md): Home Manager owns the CLI baseline and shell.
{ config, lib, pkgs, username, inputs, ... }:

let
  # Configs that should be editable without a rebuild are linked out-of-store.
  dotfiles = "${config.home.homeDirectory}/dotfiles";
  link = path: config.lib.file.mkOutOfStoreSymlink "${dotfiles}/${path}";

  # inshellisense (FOSS Fig successor: as-you-type dropdown from Fig's spec
  # DB). The nixpkgs build isn't a SEA bundle, so upstream's dev-mode fallback
  # resolves its shell/spec resources from $CWD and reports __VERSION__ —
  # point both at the package root instead. --replace-fail makes the build
  # error loudly if upstream drifts.
  inshellisense-patched = pkgs.inshellisense.overrideAttrs (old: {
    postInstall = (old.postInstall or "") + ''
      pkgroot=$out/lib/node_modules/@microsoft/inshellisense
      substituteInPlace $pkgroot/build/utils/version.js \
        --replace-fail '"__VERSION__"' '"${old.version}"'
      substituteInPlace $pkgroot/build/utils/node.js \
        --replace-fail 'path.join(process.cwd(), "shell")' \
          "\"$pkgroot/shell\"" \
        --replace-fail 'path.join(process.cwd(), "node_modules", "@withfig", "autocomplete", "build")' \
          "\"$pkgroot/node_modules/@withfig/autocomplete/build\""
    '';
  });
  # no-mistakes (workflow north star): Go CLI, not in nixpkgs yet, so built
  # from the release tag pinned in flake.nix. Update = bump tag + vendorHash.
  no-mistakes = pkgs.buildGoModule {
    pname = "no-mistakes";
    version = "1.57.0";
    src = inputs.no-mistakes-src;
    vendorHash = "sha256-NZOYxNYvt4192uqKBdKRxdgrKFvWx3585psdCnRdPSM=";
    subPackages = [ "cmd/no-mistakes" ];
    doCheck = false;
    # Version only. Upstream's Makefile also bakes in Umami telemetry ids
    # here - leaving them unset keeps telemetry off in our build.
    ldflags = [ "-X github.com/kunchenguid/no-mistakes/internal/buildinfo.Version=v1.57.0" ];
  };
  # treehouse (workflow north star): worktree pool for parallel agent
  # sessions; firstmate's crewmates depend on it. Built from the release tag
  # pinned in flake.nix. Update = bump tag + vendorHash.
  treehouse = pkgs.buildGoModule {
    pname = "treehouse";
    version = "2.0.0";
    src = inputs.treehouse-src;
    vendorHash = "sha256-fH93/19rZY/jduF4ZS0RLrqBWdCjz6XYnoN+3KPd4Lg=";
    doCheck = false;
    ldflags = [ "-X main.version=v2.0.0" ];
  };
in
{
  home.username = username;
  home.homeDirectory = "/Users/${username}";
  home.stateVersion = "25.05"; # set once; never change afterwards

  home.sessionVariables.EDITOR = "nvim"; # git commit, crontab, etc. open Neovim

  # CLI-launched links (gh, OAuth login flows, anything honoring $BROWSER)
  # open in Chrome so agent sessions stay out of the personal default browser
  # (Brave). Tools that call /usr/bin/open directly still hit the default;
  # the agent-side rule lives in files/AGENTS.md. `open-chrome` is defined
  # in home.packages below.
  home.sessionVariables.BROWSER = "open-chrome";

  # pnpm's global-install home (`pnpm add -g`). npm's own prefix is the
  # read-only Nix store, so npm-distributed CLIs that must be real commands
  # (firstmate's gh-axi / chrome-devtools-axi / lavish-axi / tasks-axi) are
  # installed here instead - mutable like ~/.local/bin, PATH wired below.
  home.sessionVariables.PNPM_HOME = "${config.home.homeDirectory}/Library/pnpm";

  programs.home-manager.enable = true;

  # ── CLI baseline (enabled-by-default stacks only; see AGENTS.md) ─────────
  home.packages = with pkgs; [
    # core
    (writeShellScriptBin "open-chrome" ''
      exec /usr/bin/open -a "Google Chrome" "$@"
    '')              # $BROWSER target: routes CLI-opened links to Chrome
    git-lfs
    gh
    ripgrep
    fd
    jq
    tree
    wget
    # editor + git UX
    neovim          # binary only; config is a plain clone at ~/.config/nvim (Phase 3)
                    # lazygit comes from programs.lazygit below (Catppuccin-themed)
    tree-sitter     # CLI required by nvim-treesitter to compile parsers (Phase 3)
    inputs.hunk.packages.${pkgs.stdenv.hostPlatform.system}.default
                    # hunk: review-first terminal diff viewer for agent changesets
    # terminal life
    tmux
    inshellisense-patched  # `is`: Fig-style dropdown; OPT-IN only (see zsh notes)
    no-mistakes     # validation-gate pipeline + /no-mistakes skill (north star)
    treehouse       # worktree pool; firstmate crewmate dependency (north star)
    shellcheck      # shell lint; firstmate bin/fm-lint.sh pins 0.11.0 (nixpkgs matches). Replaces an ad-hoc brew install (2026-08-24)
    # agents (PLAN Phase 4)
    codex           # OpenAI Codex CLI; auth via `codex login` browser flow
                    # (ChatGPT Plus plan) — never an API key in config
    inputs.herdr.packages.${pkgs.stdenv.hostPlatform.system}.default
                    # herdr: agent cockpit (AGENTS.md); runs inside Ghostty
    # enabled-by-default toolchains (kept lean; projects use devShells)
    nodejs_22       # TypeScript/Node/React baseline (tsc etc. per-project)
    pnpm            # package manager, same layer as npm (not a toolchain)
    python3         # Python basics
    uv
  ];

  # ── Git ───────────────────────────────────────────────────────────────────
  programs.git = {
    enable = true;
    # Home Manager renamed userName/userEmail/extraConfig → settings.* (2026-07 drift)
    settings = {
      user.name = "CHANGE_ME";
      user.email = "CHANGE_ME@example.com";
      init.defaultBranch = "main";
      pull.rebase = true;
      push.autoSetupRemote = true;
    };
    ignores = [ ".DS_Store" ".direnv/" ];
  };

  # ── Zsh (FOSS autocomplete stack, polished but not slow) ─────────────────
  programs.zsh = {
    enable = true;
    autosuggestion.enable = true;
    syntaxHighlighting.enable = true;
    enableCompletion = true;

    # oh-my-zsh purely as an alias/plugin library — the classic git shortcuts
    # (gst, gco, gaa, gp, glog, …). Theme stays empty: starship owns the prompt.
    oh-my-zsh = {
      enable = true;
      plugins = [ "git" ];
      theme = "";
    };

    plugins = [
      {
        # Fig-like completion menu inside tab-completion, powered by fzf.
        name = "fzf-tab";
        src = pkgs.zsh-fzf-tab;
        file = "share/fzf-tab/fzf-tab.plugin.zsh";
      }
    ];

    shellAliases = {
      rebuild = "sudo darwin-rebuild switch --flake ${dotfiles}";
      vim = "nvim";
      v = "nvim";
      c = "clear";
      lg = "lazygit";
      g = "git";
      # pnpm (no oh-my-zsh core plugin exists for it)
      pn = "pnpm";
      pi = "pnpm install";
      pa = "pnpm add";
      pad = "pnpm add -D";
      pr = "pnpm run";
      pt = "pnpm test";
      px = "pnpm dlx";
      # High-agency Claude (Kun's `cc`): skips ALL permission prompts. Use in
      # trusted repos only; prefer plain `claude` when tools touch the system.
      cc = "claude --dangerously-skip-permissions";
    };

    initContent = lib.mkMerge [
      # inshellisense (`is`) is OPT-IN, never auto-started: it re-renders the
      # whole pty through its own terminal emulation, which corrupts
      # full-screen TUIs - nvim/lazygit layouts break and mouse escapes leak
      # as text (microsoft/inshellisense#411). Our workflow lives in TUIs, so
      # run `is` manually for a Fig-style dropdown session and `exit` to
      # leave it; fzf-tab below covers completion everywhere else.
      # mkOrder 550 = before compinit (which oh-my-zsh runs). Homebrew's
      # completions (_brew: subcommands + formula/cask names) live outside the
      # Nix profiles, so fpath must pick them up here or `brew <TAB>` is dead.
      # Probe headlessly with tests/zsh_completion_probe.zsh.
      (lib.mkOrder 550 ''
        fpath+=(/opt/homebrew/share/zsh/site-functions)
        # Cache slow candidate listings (`brew casks` takes ~2s uncached).
        zstyle ':completion:*' use-cache on
      '')
      ''
        # Free ctrl+s/ctrl+q from legacy XON/XOFF flow control: Ghostty's
        # VSCode layer (files/.config/ghostty/config) sends ctrl+s for cmd+s,
        # which would otherwise freeze the terminal at a shell prompt.
        stty -ixon

        # Accept the autosuggestion ghost text from the home row (default is
        # right-arrow/End). ctrl+f is otherwise just forward-char here.
        bindkey '^f' autosuggest-accept

        # Herdr is the agent cockpit; never auto-wrap it in tmux (AGENTS.md).
        # SSH logins (phone/iPad via Termius) land in the persistent herdr
        # session instead of a bare shell. Guards: skip when already inside
        # herdr or tmux, and never touch local (non-SSH) shells.
        if [[ -n "$SSH_CONNECTION" && -z "$HERDR_ENV" && -z "$TMUX" ]] \
            && command -v herdr >/dev/null; then
          exec herdr
        fi

        # More aggressive shell candidates, off by default (PLAN Phase 2):
        # - carapace: https://github.com/carapace-sh/carapace-bin
        # (inshellisense: installed but opt-in only - see note at the top)
      ''
    ];
  };

  # ── Prompt / fuzzy / history / per-project envs ───────────────────────────
  programs.starship.enable = true;

  programs.fzf = {
    enable = true;
    enableZshIntegration = true;
    # Atuin owns ctrl-r (history); fzf keeps ctrl-t (files) and alt-c (dirs).
    historyWidget.command = "";
    # Catppuccin Mocha (AGENTS.md theme rule)
    colors = {
      "bg+" = "#313244";
      bg = "#1e1e2e";
      spinner = "#f5e0dc";
      hl = "#f38ba8";
      fg = "#cdd6f4";
      header = "#f38ba8";
      info = "#cba6f7";
      pointer = "#f5e0dc";
      marker = "#b4befe";
      "fg+" = "#cdd6f4";
      prompt = "#cba6f7";
      "hl+" = "#f38ba8";
    };
  };

  # Catppuccin Mocha (AGENTS.md theme rule)
  programs.lazygit = {
    enable = true;
    settings.gui.theme = {
      activeBorderColor = [ "#cba6f7" "bold" ];
      inactiveBorderColor = [ "#a6adc8" ];
      optionsTextColor = [ "#89b4fa" ];
      selectedLineBgColor = [ "#313244" ];
      cherryPickedCommitBgColor = [ "#45475a" ];
      cherryPickedCommitFgColor = [ "#cba6f7" ];
      unstagedChangesColor = [ "#f38ba8" ];
      defaultFgColor = [ "#cdd6f4" ];
      searchingActiveBorderColor = [ "#f9e2af" ];
    };
  };

  programs.zoxide = {
    enable = true;
    enableZshIntegration = true;
  };

  programs.direnv = {
    enable = true;
    nix-direnv.enable = true; # powers on-demand toolchains via devShells
  };

  # Atuin history — opted in (PLAN Phase 0), enabled in Phase 2. Local-only:
  # sync requires an account (`atuin register`/`login`), opt in later if wanted.
  programs.atuin = {
    enable = true;
    enableZshIntegration = true;
    settings = {
      style = "compact";
      inline_height = 20;
      # Up-arrow stays scoped to this session; ctrl-r searches everything.
      filter_mode_shell_up_key_binding = "session";
    };
  };

  # inshellisense config — the only look/feel knobs it exposes. Icons render
  # via JetBrains Mono Nerd Font (AGENTS.md font rule); dropdown colors come
  # from the terminal palette, i.e. Catppuccin Mocha in Ghostty. Keybindings
  # default to Fig's (tab = accept, arrows = navigate, esc = dismiss).
  xdg.configFile."inshellisense/rc.toml".text = ''
    useNerdFont = true
    useAliases = true
    maxSuggestions = 8
  '';

  # ── Global agent instruction files ────────────────────────────────────────
  # ~/AGENTS.md is the cross-tool entrypoint (mirrors the ln -s workflow:
  # Claude Code reads the same file via ~/.claude/CLAUDE.md). OPINIONS.md and
  # VOICE.md are read lazily by instruction from AGENTS.md.
  home.file."AGENTS.md".source = link "files/AGENTS.md";
  home.file."OPINIONS.md".source = link "files/OPINIONS.md";
  home.file."VOICE.md".source = link "files/VOICE.md";
  home.file.".claude/CLAUDE.md".source = link "files/AGENTS.md";

  # Agent skills (vendored from upstream repos; see docs/workflow-north-star.md
  # for provenance + update procedure). lavish and chrome-devtools-axi run via
  # `pnpm dlx`, no install; no-mistakes uses the flake-built binary above.
  home.file.".claude/skills/lavish".source = link "files/.claude/skills/lavish";
  home.file.".claude/skills/no-mistakes".source = link "files/.claude/skills/no-mistakes";
  home.file.".claude/skills/chrome-devtools-axi".source = link "files/.claude/skills/chrome-devtools-axi";
  # Codex delegation (own authorship, inspired by Theo's Fable 5 workflow):
  # route token-heavy review, bounded implementation, and native computer-use
  # verification to GPT-5.5 via the codex CLI declared above.
  home.file.".claude/skills/codex-review".source = link "files/.claude/skills/codex-review";
  home.file.".claude/skills/codex-implement".source = link "files/.claude/skills/codex-implement";
  home.file.".claude/skills/codex-computer-use".source = link "files/.claude/skills/codex-computer-use";
  # handoff / claude-handoff (mattpocock/skills): session-lifecycle skills that
  # shape compactions into handoff documents. Prompt-only markdown,
  # security-read 2026-07-05. Both are disable-model-invocation, so they stay
  # out of the model-facing skill listing (slash commands only).
  home.file.".claude/skills/handoff".source = link "files/.claude/skills/handoff";
  home.file.".claude/skills/claude-handoff".source = link "files/.claude/skills/claude-handoff";
  # Status line (Catppuccin Mocha): ~/.claude/settings.json invokes this via
  # `bash`, so no execute bit is required. Edit files/.claude/statusline.sh,
  # not the symlink target.
  home.file.".claude/statusline.sh".source = link "files/.claude/statusline.sh";

  # ── App configs linked into place (editable without rebuild) ─────────────
  xdg.configFile."ghostty/config".source = link "files/.config/ghostty/config";
  xdg.configFile."tmux/tmux.conf".source = link "files/.config/tmux/tmux.conf";
  xdg.configFile."starship.toml".source = link "files/.config/starship.toml";
  # Karabiner rewrites karabiner.json in place (breaking a file symlink), so
  # link the whole directory; its runtime noise is gitignored.
  xdg.configFile."karabiner".source = link "files/.config/karabiner";
  xdg.configFile."herdr/config.toml".source = link "files/.config/herdr/config.toml";
  home.file.".hammerspoon/init.lua".source = link "files/.hammerspoon/init.lua";
  # NOTE: ~/.config/nvim is intentionally NOT managed here — it is a plain
  # clone of the NvChad config (docs/vscode-to-nvim.md; PLAN Phase 3, AGENTS.md).

  # ── Personal scripts + user-local installers on PATH ─────────────────────
  # ~/.local/bin is where self-installers (claude, uv tools, pipx) put
  # binaries; it is not on macOS's default PATH.
  home.sessionPath = [
    "${dotfiles}/scripts"
    "${config.home.homeDirectory}/.local/bin"
    "${config.home.homeDirectory}/Library/pnpm/bin" # pnpm global shims (PNPM_HOME/bin)
    "/opt/homebrew/bin" # brew CLI formulae (e.g. dcli); GUI casks don't need it
  ];
}
