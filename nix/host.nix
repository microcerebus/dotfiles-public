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
      # Activation only installs what is missing and zaps what is undeclared.
      # Upgrades run as a separate `brew upgrade` AFTER activation (daily
      # dotfiles-autoupdate daemon below, and the `rebuild` alias), because
      # inside activation one failed download aborts everything after it:
      # on 2026-10-07 the chatgpt cask pointed at a 404 and blocked the whole
      # Home Manager switch. Outside activation a bad cask fails alone.
      # Guardrails: casks stay non-greedy (default) so self-updating apps
      # manage themselves; `brew pin <formula>` holds back a known-bad
      # version; the daily cloud routine reviews new formula/cask versions
      # for advisories alongside the flake.lock bump it pushes to main.
      autoUpdate = false;
      cleanup = "zap"; # remove anything not declared here (keeps machine honest)
      upgrade = false;
    };

    casks = [
      "ghostty"    # terminal emulator (AGENTS.md: the one and only)
      # Claude Code is NOT a cask: the native installer (~/.local/bin/claude,
      # `curl -fsSL https://claude.ai/install.sh | bash`) self-updates within
      # hours of each release, while brew skips the self-updating cask and
      # left it ~60 versions behind (2026-10-07).
      "t3-code@nightly" # T3 Code nightly (pingdotgg/t3code); self-updating.
                        # Data in ~/.t3 - removing this cask zaps it.
      "codex"      # OpenAI Codex CLI. A CLI, so by the layer rule it belongs in
                   # Home Manager, but nixpkgs ran ~11 releases behind (0.149 vs
                   # 0.160.1, 2026-10-07) and a read-only /nix/store binary left
                   # T3 Code unable to update it. The cask is upgraded daily by
                   # `brew upgrade` and T3 detects it and can upgrade it too.
                   # Auth via `codex login` browser flow - never an API key.
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
      "opensuperwhisper"     # voice typing, local Whisper (Starmel/OpenSuperWhisper, MIT).
                             # Upstream, not the opensuperwhisper.com fork (no cask, young).
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

  # Zap guard: dropping a cask lets cleanup=zap run its zap stanza. Two
  # dropped casks would destroy live data: claude-code's zap trashes
  # ~/.claude.json* and the native ~/.local/{bin,share}/claude install;
  # codex-app's zap trashes com.openai.codex prefs, which ChatGPT.app now
  # uses. Abort until they are removed with a plain (non-zap) uninstall.
  # Delete this block once neither Caskroom dir exists (2026-10-07).
  system.activationScripts.preActivation.text = ''
    for c in claude-code codex-app; do
      if [ -d "/opt/homebrew/Caskroom/$c" ]; then
        echo "error: cask $c is installed; its zap would delete live data." >&2
        echo "  Run first:  brew uninstall --cask claude-code codex-app" >&2
        exit 1
      fi
    done
  '';

  # App Store apps (masApps above, plus Tachimanga) update themselves.
  system.defaults.CustomSystemPreferences."com.apple.commerce".AutoUpdate = true;

  # ── Daily unattended update ──────────────────────────────────────────────
  # Once per calendar day, at the first hourly tick from 04:00 on (the cloud
  # routine pushes the flake.lock bump at 02:00): fast-forward ~/dotfiles to
  # origin/main, update pnpm globals, run the same switch as the `rebuild`
  # alias, then `brew upgrade` (non-fatal per app, see onActivation above). Hourly ticks + RunAtLoad instead of a calendar slot because launchd
  # drops calendar runs missed while the Mac is powered off; this way a Mac
  # that was off or asleep at 04:00 catches up within an hour of coming back.
  # A day counts as attempted once the network is up (stamp in /var/db), so a
  # failing run retries tomorrow, not hourly.
  # Cloud watchdog: the routine has silently skipped fires before (4 Mondays
  # in Sep 2026, no run records), so a flake.lock on main older than 3 days
  # raises the same shell banner.
  # Never applies local work: aborts if nix/ or flake.* are dirty, or if the
  # pull is not a fast-forward. Failures leave ~/Library/Logs/
  # dotfiles-autoupdate.failed, which every new zsh prints (nix/user.nix)
  # until a successful run or `rebuild` removes it. Known failure: casks that
  # ship a .pkg (karabiner-elements, logi-options+, google-drive) need an
  # interactive sudo to upgrade - run `rebuild` when the banner says so,
  # which retries `brew upgrade` interactively.
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
              PATH="$home/Library/pnpm/bin:/etc/profiles/per-user/$user/bin:/opt/homebrew/bin:$PATH" \
              PNPM_HOME="$home/Library/pnpm" "$@"
          }
          fail() { echo "$(ts) FAILED: $*"; echo "$(ts) $*" > "$marker"; exit 1; }

          stamp=/var/db/dotfiles-autoupdate.last
          [ "$(date +%H)" -ge 4 ] || exit 0
          [ "$(cat "$stamp" 2>/dev/null)" != "$(date +%F)" ] || exit 0
          # A human `rebuild` in flight (also: this daemon's RunAtLoad fires
          # mid-activation when a rebuild installs it) - try next hour.
          pgrep -qf darwin-rebuild && exit 0
          # A switch already happened today after 04:00 - that was today's run.
          switched=$(stat -f '%Sm' -t '%F %H' /run/current-system)
          if [ "''${switched% *}" = "$(date +%F)" ] && [ "''${switched#* }" -ge 4 ]; then
            date +%F > "$stamp"; exit 0
          fi

          # Ticks right after wake can beat Wi-Fi; no network = retry next hour.
          online=
          for _ in $(seq 30); do
            /usr/bin/curl -fsS -o /dev/null --max-time 5 https://github.com && { online=1; break; }
            sleep 10
          done
          [ -n "$online" ] || exit 0
          date +%F > "$stamp"

          echo "=== $(ts) dotfiles auto-update"
          echo "$(ts) running or interrupted" > "$marker"

          [ "$(as_user git -C "$repo" branch --show-current)" = main ] \
            || fail "$repo is not on main"
          [ -z "$(as_user git -C "$repo" status --porcelain -- flake.nix flake.lock nix)" ] \
            || fail "uncommitted changes in nix/ or flake.*"
          as_user git -C "$repo" pull --ff-only --quiet \
            || fail "git pull --ff-only failed (diverged from origin/main?)"

          as_user pnpm update -g --latest || echo "$(ts) warn: pnpm update -g failed"

          darwin-rebuild switch --flake "$repo" || fail "darwin-rebuild switch failed"

          # Runs last so a broken cask can't block the switch above.
          as_user brew upgrade \
            || fail "system updated, but brew upgrade failed for some apps (see log)"

          lock_age=$(( ($(date +%s) - $(as_user git -C "$repo" log -1 --format=%ct -- flake.lock)) / 86400 ))
          [ "$lock_age" -le 3 ] \
            || fail "applied OK, but flake.lock on main is $lock_age days old - is the cloud update routine running? (claude.ai/code/routines)"

          rm -f "$marker"
          echo "=== $(ts) done"
        ''}"
      ];
      StartInterval = 3600;
      RunAtLoad = true;
      AbandonProcessGroup = true;
      StandardOutPath = "/Users/${username}/Library/Logs/dotfiles-autoupdate.log";
      StandardErrorPath = "/Users/${username}/Library/Logs/dotfiles-autoupdate.log";
    };
  };

  security.pam.services.sudo_local.touchIdAuth = true; # Touch ID for sudo

  # Set once at first install; never change afterwards.
  system.stateVersion = 6;
}
