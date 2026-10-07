# System layer: macOS settings + declarative Homebrew.
# Layer ownership (AGENTS.md): Homebrew owns GUI/macOS-native apps ONLY.
{ pkgs, username, ... }:

{
  # Required by nix-darwin for user-scoped options (homebrew, defaults, ...).
  system.primaryUser = username;

  users.users.${username} = {
    name = username;
    home = "/Users/${username}";
  };

  # Determinate Nix manages the Nix installation with its own daemon;
  # nix-darwin must not also manage it (activation aborts otherwise).
  # Consequence: nix.* options are unavailable here. Nix settings (flakes are
  # on by default; trusted-users etc.) belong in /etc/nix/nix.custom.conf,
  # owned by Determinate. See AGENTS.md sharp edges.
  nix.enable = false;

  # tmux 3.7c's configure aborts on macOS unless told what to do about
  # jemalloc (macOS calloc(3) mis-zeroes; tmux recommends jemalloc there).
  # Mirrors the nixpkgs master fix; drop this overlay once it reaches
  # nixpkgs-unstable (check: tmux builds without it).
  nixpkgs.overlays = [
    (final: prev: {
      tmux = prev.tmux.overrideAttrs (old: {
        buildInputs = old.buildInputs ++ [ final.jemalloc ];
        configureFlags = old.configureFlags ++ [ "--enable-jemalloc" ];
      });
    })
  ];

  programs.zsh.enable = true; # default shell integration for nix-darwin

  # ── Declarative Homebrew (GUI apps only) ──────────────────────────────────
  # `setup/mac.sh` installs Homebrew itself; nix-darwin then manages the list.
  homebrew = {
    enable = true;
    onActivation = {
      # Upgrades happen at every activation: the daily dotfiles-autoupdate
      # daemon below, or a human-run `rebuild`. brew refreshes taps and
      # upgrades everything declared here. Guardrails: casks stay non-greedy
      # (default) so self-updating apps manage themselves; cleanup=zap keeps
      # the set declarative; `brew pin <formula>` holds back a known-bad
      # version; the daily cloud routine reviews new formula/cask versions for
      # advisories alongside the flake.lock bump it pushes to main.
      autoUpdate = true;
      cleanup = "zap"; # remove anything not declared here (keeps machine honest)
      upgrade = true;
    };

    casks = [
      "ghostty"    # terminal emulator (AGENTS.md: the one and only)
      # Claude Code is NOT a cask: the native installer (~/.local/bin/claude,
      # `curl -fsSL https://claude.ai/install.sh | bash`) self-updates within
      # hours of each release, while brew skips the self-updating cask and
      # left it ~60 versions behind (2026-10-07).
      "t3-code@nightly" # T3 Code nightly (pingdotgg/t3code); self-updating.
                        # Data in ~/.t3 - removing this cask zaps it.
      "orbstack"   # container runtime (AGENTS.md: no Docker Desktop et al.)
      "karabiner-elements"   # key remapping (files/.config/karabiner)
      "hammerspoon"          # macOS automation (files/.hammerspoon)
      "raycast"              # launcher; owns cmd+space (Spotlight hotkey disabled below)

      # Daily apps. Previously hand-installed; declared here so cleanup = "zap"
      # stops removing them and fresh machines get them for free.
      # One-time adoption of already-present apps (human runs):
      #   brew install --cask --adopt <cask>
      "brave-browser"   # kept installed; Chrome is the browser for agent tooling
      "chatgpt"         # ChatGPT.app - also the Codex desktop app now (bundle
                        # id com.openai.codex), so no separate codex-app cask.
                        # The codex *CLI* stays in Home Manager (nix/user.nix).
      "cursor"          # Cursor editor
      "discord"
      "google-chrome"
      "google-drive"         # Google Drive desktop sync client
      "logi-options+"        # Logitech Options+ (mouse/keyboard driver)
      "lunar"                # adaptive brightness for external displays
      "rectangle"            # window snapping
      "spotify"
      "termius"              # SSH client (hosts sync via Termius account)
      "visual-studio-code"
      "vlc"                  # media player

      # Tailscale GUI app: provides the TUN via a Network Extension, so no
      # root daemon to manage (the `tailscale` *formula* needs sudo tailscaled).
      # Needed to reach this Mac from iPhone/iPad (Termius over the tailnet).
      "tailscale-app"
    ];

    # App Store apps, installed/pinned via `mas` (requires being signed in to
    # the App Store; already-installed apps are simply adopted).
    # Tachimanga is an iOS app running on Apple Silicon; mas cannot manage
    # those, so it stays a hand install (App Store updates it, see below).
    masApps = {
      "Amphetamine" = 937984704;
      "Dashlane" = 517914548;
      "The Unarchiver" = 425424353;
      "Dynamic Wallpaper" = 1582358382;
      "Telegram" = 747648890;
      "WhatsApp" = 310633997;
    };

    taps = [
      "dashlane/tap"
    ];

    brews = [
      # Prefer Home Manager for CLI tools. Add here only when a formula truly
      # needs Homebrew (macOS-native daemons, etc.).
      "dashlane/tap/dashlane-cli" # not in nixpkgs; official tap
      "mas" # Mac App Store CLI; required by masApps above
    ];
  };

  # ── Fonts (AGENTS.md: JetBrains Mono Nerd Font everywhere) ───────────────
  fonts.packages = [ pkgs.nerd-fonts.jetbrains-mono ];

  # ── Sensible macOS defaults (small on purpose; grow via reviewed diffs) ──
  system.defaults = {
    dock = {
      autohide = true;
      orientation = "right"; # dock on the right edge
      tilesize = 128;
    };

    finder = {
      AppleShowAllExtensions = true;
      CreateDesktop = false; # clean desktop: Finder draws no icons on it
    };

    # Sonoma+ desktop behavior: keep the desktop clean and clicking the
    # wallpaper must not shove windows aside.
    WindowManager = {
      StandardHideDesktopIcons = true;
      StandardHideWidgets = true;
      EnableStandardClickToShowDesktop = false;
    };

    trackpad.Clicking = true; # tap to click

    menuExtraClock = {
      ShowAMPM = true;
      ShowDate = 0; # 0 = show date only when space allows
      ShowDayOfWeek = true;
    };

    NSGlobalDomain = {
      KeyRepeat = 2;
      InitialKeyRepeat = 15;
      AppleInterfaceStyle = "Dark";
      _HIHideMenuBar = false; # menu bar always visible
      "com.apple.mouse.tapBehavior" = 1; # tap to click (user-level half)
    };

    CustomUserPreferences = {
      # cmd+space → Raycast. Symbolic hotkey 64 is Spotlight search; disabling
      # it frees the chord. Keys absent from this dict keep macOS defaults.
      # Takes effect after logout/login (macOS caches symbolic hotkeys).
      "com.apple.symbolichotkeys" = {
        AppleSymbolicHotKeys = {
          "64" = { enabled = false; };
        };
      };
      # Raycast reads its global hotkey from defaults (49 = space keycode).
      # First launch still runs onboarding; the hotkey will already be set.
      "com.raycast.macos" = {
        raycastGlobalHotkey = "Command-49";
      };
    };
  };

  # App Store apps (masApps above, plus Tachimanga) update themselves.
  system.defaults.CustomSystemPreferences."com.apple.commerce".AutoUpdate = true;

  # ── Daily unattended update ──────────────────────────────────────────────
  # 04:30 daily (or on wake, if asleep then): fast-forward ~/dotfiles to
  # origin/main (the cloud routine pushes the daily flake.lock bump), update
  # pnpm globals, then the same switch as the `rebuild` alias - which also
  # upgrades every Homebrew cask/formula/mas app declared above.
  # Never applies local work: aborts if nix/ or flake.* are dirty, or if the
  # pull is not a fast-forward. Failures leave ~/Library/Logs/
  # dotfiles-autoupdate.failed, which every new zsh prints (nix/user.nix)
  # until a successful run or `rebuild` removes it. Known failure: casks that
  # ship a .pkg (karabiner-elements, logi-options+, google-drive) need an
  # interactive sudo to upgrade - run `rebuild` when the banner says so.
  # AbandonProcessGroup: when activation reloads this daemon's own plist, the
  # bootout kills only the wrapper, not the in-flight darwin-rebuild.
  launchd.daemons.dotfiles-autoupdate = {
    serviceConfig = {
      Label = "com.${username}.dotfiles-autoupdate";
      ProgramArguments = [
        "${pkgs.writeShellScript "dotfiles-autoupdate" ''
          set -uo pipefail
          user=${username}
          home=/Users/${username}
          repo=$home/dotfiles
          marker=$home/Library/Logs/dotfiles-autoupdate.failed
          export HOME=/var/root
          export PATH=/run/current-system/sw/bin:/nix/var/nix/profiles/default/bin:/usr/bin:/bin:/usr/sbin:/sbin
          ts() { date '+%F %T'; }
          as_user() {
            /usr/bin/sudo -u "$user" -H env \
              PATH="$home/Library/pnpm/bin:/etc/profiles/per-user/$user/bin:$PATH" \
              PNPM_HOME="$home/Library/pnpm" "$@"
          }
          fail() { echo "$(ts) FAILED: $*"; echo "$(ts) $*" > "$marker"; exit 1; }

          echo "=== $(ts) dotfiles auto-update"
          echo "$(ts) running or interrupted" > "$marker"

          # Missed 04:30 runs fire right after wake, before Wi-Fi is back.
          for _ in $(seq 60); do
            /usr/bin/curl -fsS -o /dev/null --max-time 5 https://github.com && break
            sleep 10
          done

          [ "$(as_user git -C "$repo" branch --show-current)" = main ] \
            || fail "$repo is not on main"
          [ -z "$(as_user git -C "$repo" status --porcelain -- flake.nix flake.lock nix)" ] \
            || fail "uncommitted changes in nix/ or flake.*"
          as_user git -C "$repo" pull --ff-only --quiet \
            || fail "git pull --ff-only failed (diverged from origin/main?)"

          as_user pnpm update -g --latest || echo "$(ts) warn: pnpm update -g failed"

          darwin-rebuild switch --flake "$repo" || fail "darwin-rebuild switch failed"

          rm -f "$marker"
          echo "=== $(ts) done"
        ''}"
      ];
      StartCalendarInterval = [ { Hour = 4; Minute = 30; } ];
      AbandonProcessGroup = true;
      StandardOutPath = "/Users/${username}/Library/Logs/dotfiles-autoupdate.log";
      StandardErrorPath = "/Users/${username}/Library/Logs/dotfiles-autoupdate.log";
    };
  };

  security.pam.services.sudo_local.touchIdAuth = true; # Touch ID for sudo

  # Set once at first install; never change afterwards.
  system.stateVersion = 6;
}
