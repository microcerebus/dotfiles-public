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
    version = "1.84.0";
    src = inputs.no-mistakes-src;
    vendorHash = "sha256-maAVBptEtdrGanJHwAPAmuGBorzIMUgK6T+NmIz1kS0=";
    subPackages = [ "cmd/no-mistakes" ];
    doCheck = false;
    # Version only. Upstream's Makefile also bakes in Umami telemetry ids
    # here - leaving them unset keeps telemetry off in our build.
    ldflags = [ "-X github.com/kunchenguid/no-mistakes/internal/buildinfo.Version=v1.84.0" ];
  };
  # treehouse (workflow north star): worktree pool for parallel agent
  # sessions; firstmate's crewmates depend on it. Built from the release tag
  # pinned in flake.nix. Update = bump tag + vendorHash.
  treehouse = pkgs.buildGoModule {
    pname = "treehouse";
    version = "2.1.1";
    src = inputs.treehouse-src;
    vendorHash = "sha256-z8IndcHcZ6nLqhLtAYul3ppddpOA4AHGQWIlfYY/pfI=";
    doCheck = false;
    ldflags = [ "-X main.version=v2.1.1" ];
  };
  # chrome-devtools-mcp: the automation server behind chrome-devtools-axi.
  # Left alone, axi runs `npx chrome-devtools-mcp@latest` on every bridge
  # start, an unpinned download (OPINIONS.md). Pinned instead to the npm
  # tarball, hash = npm's published dist.integrity; the package is
  # self-contained (no runtime dependencies). Update = bump version + hash
  # from `npm view chrome-devtools-mcp@<v> dist.integrity`, and check the
  # installed chrome-devtools-axi still drives it.
  # axi spawns `node $CHROME_DEVTOOLS_AXI_MCP_PATH`, so the entry shim below
  # (not a wrapper script) turns off Google usage statistics, npm update
  # checks, and sending trace URLs to the CrUX API.
  chrome-devtools-mcp = pkgs.stdenvNoCC.mkDerivation rec {
    pname = "chrome-devtools-mcp";
    version = "1.10.1";
    src = pkgs.fetchurl {
      url = "https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-${version}.tgz";
      hash = "sha512-Klw6HWDqHC/XS1JwZldd2r49aUhbUJN9m9Mvcx4SEueIPXtzuQX+QelxAViobv8YUkDZ7HWDrmViR6LeYK0wAw==";
    };
    nativeBuildInputs = [ pkgs.makeWrapper ];
    installPhase = ''
      lib=$out/lib/chrome-devtools-mcp
      mkdir -p $lib $out/bin
      cp -r . $lib
      cat > $lib/axi-entry.mjs <<'EOF'
      process.env.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS = "1";
      process.env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS = "1";
      process.argv.push("--no-performance-crux");
      await import("./build/src/bin/chrome-devtools-mcp.js");
      EOF
      makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/chrome-devtools-mcp \
        --add-flags $lib/axi-entry.mjs
    '';
  };
  chromeDevtoolsMcpEntry = "${chrome-devtools-mcp}/lib/chrome-devtools-mcp/axi-entry.mjs";
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

  # chrome-devtools-axi attaches to the agent Chrome (launchd agent below)
  # instead of launching a throwaway browser or attaching to the owner's own
  # Chrome, whose chrome://inspect toggle asks "Allow" for every session.
  # scripts/chrome-devtools-axi enforces the same default and refuses his own
  # Chrome without an opt-in; these cover anything that bypasses it. The
  # server is the pinned build above, never `npx ...@latest`. T3 Code hands
  # agents only PATH from the login shell, but every agent Bash command runs
  # zsh and ~/.zshenv sources these, so T3 threads get them.
  home.sessionVariables.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9333";
  home.sessionVariables.CHROME_DEVTOOLS_AXI_MCP_PATH = chromeDevtoolsMcpEntry;
  # agent-device: drive macOS apps through accessibility actions in the
  # background (no pointer takeover or Automation Mode), and skip its npm
  # update check so the pin in nix/host.nix stays the only upgrade path.
  home.sessionVariables.AGENT_DEVICE_MACOS_APP_BACKEND = "native";
  home.sessionVariables.AGENT_DEVICE_NO_UPDATE_NOTIFIER = "1";

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
    ffmpeg          # media; with yt-dlp, used by the ig-collection-extract skill
    yt-dlp          # (ffmpeg replaces an ad-hoc brew install, 2026-10-07)
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
    chrome-devtools-mcp  # pinned server for chrome-devtools-axi (see let block)
    shellcheck      # shell lint; firstmate bin/fm-lint.sh pins 0.11.0 (nixpkgs matches). Replaces an ad-hoc brew install (2026-08-24)
    actionlint      # GitHub workflow lint; firstmate bin/fm-lint-workflows.sh pins 1.7.12 (nixpkgs matches)
    # agents (PLAN Phase 4)
    # codex CLI: Homebrew cask in nix/host.nix (nixpkgs lagged releases)
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
    # .resume/: pause-safely resume notes stay local in every repo (they
    # carry thread ids and would ride along in a `wip:` commit otherwise).
    ignores = [ ".DS_Store" ".direnv/" ".resume/" ];
  };

  # ── Zsh (FOSS autocomplete stack, polished but not slow) ─────────────────
  programs.zsh = {
    # Homebrew goes LAST on PATH (zshenv, so every shell gets it): brew pulls
    # in dependency formulae (python@3.14 on 2026-10-07) whose binaries must
    # not shadow the Nix-declared ones. Brew-only CLIs (dcli, codex) still
    # resolve because nothing earlier provides them.
    envExtra = ''
      path+=(/opt/homebrew/bin)
    '';
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
      # brew upgrade runs after the switch so one broken cask cannot block it
      # (see homebrew.onActivation in nix/host.nix).
      rebuild = "sudo darwin-rebuild switch --flake ${dotfiles} && brew upgrade && rm -f ~/Library/Logs/dotfiles-autoupdate.failed";
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

        # Daily auto-update status (launchd daemon in nix/host.nix).
        if [[ -e ~/Library/Logs/dotfiles-autoupdate.failed ]]; then
          print -P "%F{red}dotfiles auto-update: $(<~/Library/Logs/dotfiles-autoupdate.failed)%f"
          print -P "%F{8}  log: ~/Library/Logs/dotfiles-autoupdate.log - fix, then \`rebuild\`%f"
        fi

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
  # Codex reads ~/.codex/AGENTS.md, not ~/AGENTS.md. Until 2026-10-07 that was
  # a hand-edited July copy that silently missed every later rule change.
  # The first rebuild moves the old file aside as AGENTS.md.hm-backup.
  home.file.".codex/AGENTS.md".source = link "files/AGENTS.md";

  # Agent skills (vendored from upstream repos; see docs/workflow-north-star.md
  # for provenance + update procedure). lavish-axi and chrome-devtools-axi are
  # pnpm globals reached through the wrappers in scripts/ (Chrome only, agent
  # Chrome by default); no-mistakes uses the flake-built binary above.
  home.file.".claude/skills/lavish".source = link "files/.claude/skills/lavish";
  home.file.".claude/skills/no-mistakes".source = link "files/.claude/skills/no-mistakes";
  home.file.".claude/skills/chrome-devtools-axi".source = link "files/.claude/skills/chrome-devtools-axi";
  # agent-device (own authorship): native macOS apps and iOS Simulators via the
  # pinned callstack/agent-device CLI (pnpm global, pinned in nix/host.nix).
  home.file.".claude/skills/agent-device".source = link "files/.claude/skills/agent-device";
  # unslop (cursor/plugins, pstack/skills/unslop): strips AI writing tells from
  # everything user-facing; prompt-only markdown, security-read 2026-08-24.
  # Captain standing instruction: apply by default to all writing.
  home.file.".claude/skills/unslop".source = link "files/.claude/skills/unslop";
  # mattpocock/skills: grilling (relentless plan interviews). Prompt-only
  # markdown, security-read 2026-08-24. Slash-command only since 2026-10-07.
  # domain-modeling was dropped 2026-10-10: zero uses, and pstack's
  # model-the-domain principle (folded into OPINIONS.md) covers it.
  home.file.".claude/skills/grilling".source = link "files/.claude/skills/grilling";
  # Codex delegation (own authorship, inspired by Theo's Fable 5 workflow):
  # independent review and native computer-use verification via the codex CLI
  # (Homebrew cask, nix/host.nix). codex-review is slash-command only and is
  # the cross-family reviewer for show-me-your-work. codex-implement was
  # dropped 2026-10-10: unused, and T3's delegate_task now hands bounded work
  # to Codex directly (AGENTS.md, T3 Code fallback routing).
  home.file.".claude/skills/codex-review".source = link "files/.claude/skills/codex-review";
  home.file.".claude/skills/codex-computer-use".source = link "files/.claude/skills/codex-computer-use";
  # Own skills adapted from pstack playbooks (MIT, Lauren Tan) for T3 Code:
  # recall (mine Claude, Codex and T3 history; scripts/recall.py, read-only,
  # stdlib Python), pause-safely and session-pickup (auto-compact is off, so
  # threads hand off through resume notes), standing-orders (lane rules and
  # authorizations that survive thread death). They replace mattpocock's
  # handoff skill (dropped 2026-10-10).
  home.file.".claude/skills/recall".source = link "files/.claude/skills/recall";
  home.file.".claude/skills/pause-safely".source = link "files/.claude/skills/pause-safely";
  home.file.".claude/skills/session-pickup".source = link "files/.claude/skills/session-pickup";
  home.file.".claude/skills/standing-orders".source = link "files/.claude/skills/standing-orders";
  # pstack (cursor/plugins, pstack/skills, MIT, Lauren Tan), vendored at
  # df581122cde17e6e27686b5a448bde23e4ad4318 (2026-10-05) and security-read
  # 2026-10-10: prompt-only markdown plus one append-only TSV helper
  # (show-me-your-work/scripts/log.sh), no network. Edits from upstream are
  # limited to Cursor paths (.cursor/skills -> .claude/skills, transcript
  # location), the cross-family reviewer, and making correct and
  # show-me-your-work model-invocable. The rest stay slash-command only, as
  # upstream ships them. Update procedure: docs/workflow-north-star.md.
  home.file.".claude/skills/correct".source = link "files/.claude/skills/correct";
  home.file.".claude/skills/show-me-your-work".source = link "files/.claude/skills/show-me-your-work";
  home.file.".claude/skills/create-verification-skill".source = link "files/.claude/skills/create-verification-skill";
  home.file.".claude/skills/maintain-verification-skill".source = link "files/.claude/skills/maintain-verification-skill";
  home.file.".claude/skills/tdd".source = link "files/.claude/skills/tdd";
  home.file.".claude/skills/blast-radius".source = link "files/.claude/skills/blast-radius";
  # Status line (Catppuccin Mocha): ~/.claude/settings.json invokes this via
  # `bash`, so no execute bit is required. Edit files/.claude/statusline.sh,
  # not the symlink target.
  home.file.".claude/statusline.sh".source = link "files/.claude/statusline.sh";
  # Guardrail hooks (2026-10-10), each encoding a correction that rules alone
  # did not stop: turn_context.py prints the SGT time and the thread's context
  # size every turn; bash_guard.py blocks container/VM starts and em dashes in
  # commit messages; write_guard.py flags em dashes in prose files. Tests:
  # tests/claude_hooks_test.sh.
  home.file.".claude/hooks/turn_context.py".source = link "files/.claude/hooks/turn_context.py";
  home.file.".claude/hooks/bash_guard.py".source = link "files/.claude/hooks/bash_guard.py";
  home.file.".claude/hooks/write_guard.py".source = link "files/.claude/hooks/write_guard.py";
  # ~/.claude/settings.json stays a plain file because Claude Code, herdr and
  # the axi tools write to it at runtime. Each switch deep-merges the keys
  # this repo owns (files/.claude/settings.managed.json: transcript retention,
  # auto-compact off, the hooks above) and leaves everything else alone.
  home.activation.claudeManagedSettings = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    run ${pkgs.bash}/bin/bash ${dotfiles}/files/.claude/merge-settings.sh \
      ${pkgs.jq}/bin/jq "$HOME/.claude/settings.json" \
      ${dotfiles}/files/.claude/settings.managed.json
  '';

  # Lavish over Tailscale: Lavish binds 127.0.0.1:4387 and rejects non-localhost
  # Host headers, so a small node proxy on 127.0.0.1:4389 rewrites Host and
  # strips X-Forwarded-*; `tailscale serve --bg http://127.0.0.1:4389` (one-time,
  # persisted by tailscaled) publishes it as https://myhost.<tailnet>.ts.net.
  # Phone URL for a session = https://myhost.tail608a89.ts.net/session/<id>.
  home.file."bin/lavish-tailscale-proxy.mjs".source = link "files/bin/lavish-tailscale-proxy.mjs";
  launchd.agents.lavish-tailscale-proxy = {
    enable = true;
    config = {
      Label = "com.myuser.lavish-tailscale-proxy";
      ProgramArguments = [ "${pkgs.nodejs_22}/bin/node" "${config.home.homeDirectory}/dotfiles/files/bin/lavish-tailscale-proxy.mjs" ];
      RunAtLoad = true;
      KeepAlive = true;
      StandardOutPath = "${config.home.homeDirectory}/Library/Logs/lavish-tailscale-proxy.log";
      StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/lavish-tailscale-proxy.log";
    };
  };

  # Agent Chrome: Google Chrome Beta (never Brave) with its own profile, which
  # agents drive through chrome-devtools-axi on 127.0.0.1:9333 without an
  # "Allow" prompt. Chrome 136+ refuses a debugging port on the default
  # profile, so the separate --user-data-dir is what makes this work. Beta is a
  # separate app: a second copy of Google Chrome would share its app identity,
  # and macOS would route Chrome links into whichever copy started first
  # (chrome-devtools-axi#166). The port binds 127.0.0.1 by default; headed
  # Chrome ignores --remote-debugging-address. Sign-ins persist across
  # restarts. Restarted only after a crash: a clean
  # quit (Cmd-Q) stays quit, and restarting a clean exit would loop, because
  # a second Chrome on the same profile hands off to the first and exits 0.
  # scripts/chrome-devtools-axi starts it again on demand (launchctl kickstart).
  launchd.agents.agent-chrome = {
    enable = true;
    config = {
      Label = "com.myuser.agent-chrome";
      ProgramArguments = [
        "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"
        "--user-data-dir=${config.home.homeDirectory}/Library/Application Support/AgentChrome"
        "--remote-debugging-port=9333"
        "--no-first-run"
        "--no-default-browser-check"
      ];
      RunAtLoad = true;
      KeepAlive.SuccessfulExit = false;
      ProcessType = "Interactive";
      StandardOutPath = "${config.home.homeDirectory}/Library/Logs/agent-chrome.log";
      StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/agent-chrome.log";
    };
  };

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
  ];
}
