# System layer: macOS settings + declarative Homebrew.
# Layer ownership (AGENTS.md): Homebrew owns GUI/macOS-native apps ONLY.
{ lib, pkgs, username, hostname, ... }:

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
  #
  # atuin 18.23.0's e2e tests that drive a bash shell fail every darwin
  # build, on Hydra too, so atuin is not cached and the 16 Oct 2026 rebuild
  # stopped on it (NixOS/nixpkgs#573527). Darwin builds run unsandboxed, so
  # the tests' interactive bash reads nix-darwin's /etc/bashrc, which resets
  # PATH away from the atuin under test. The open fix NixOS/nixpkgs#574509
  # exports NOSYSBASHRC, but the test harness clears the environment before
  # it starts that bash, and the tests still failed with it here. So skip
  # only the bash cases: filtered_commands_leave_no_captured_output and the
  # e2e_pty cases named *bash_preexec* (their zsh and fish cases still run),
  # as nixpkgs already skips atuin's network tests. Drop this once atuin
  # builds on nixpkgs-unstable without it.
  nixpkgs.overlays = [
    (final: prev: {
      tmux = prev.tmux.overrideAttrs (old: {
        buildInputs = old.buildInputs ++ [ final.jemalloc ];
        configureFlags = old.configureFlags ++ [ "--enable-jemalloc" ];
      });
      atuin = prev.atuin.overrideAttrs (old: {
        checkFlags = (old.checkFlags or [ ]) ++ [
          "--skip=filtered_commands_leave_no_captured_output"
          "--skip=bash_preexec"
        ];
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
      # dotfiles-sync agent in nix/user.nix, and the `rebuild` alias), because
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
      # Agent Chrome (launchd agent in nix/user.nix). A separate app, so macOS
      # never routes Chrome links (open-chrome) into the agent's
      # window. Its zap also trashes Google's shared updater: read it before
      # ever dropping this cask (AGENTS.md).
      "google-chrome@beta"
      "google-drive"         # Google Drive desktop sync client
      "logi-options+"        # Logitech Options+ (mouse/keyboard driver)
      "lunar"                # adaptive brightness for external displays
      "rectangle"            # window snapping
      # Sill (Saffsanity/sill, open source): streams a Mac window or the
      # desktop to the iPhone/iPad app, with touch, Pencil and keyboard. Not
      # in homebrew/cask; this is the developer's own tap, installing the
      # signed release DMG with its SHA-256 checked. nix-darwin marks a
      # fully-qualified cask trusted (Homebrew's Tap Trust), so only this
      # cask is trusted, not the tap. brew bundle adopts the hand-installed
      # /Applications/Sill.app (same 0.5.1 build, checked 16 Oct 2026).
      # It has no self-updater; the daily `brew upgrade` updates it.
      "saffsanity/sill/sill"
      "handy"                # voice typing, local Whisper/Parakeet (cjpais/Handy, MIT).
                             # Picked 2026-10-07 over VoiceInk (unclear license),
                             # FluidVoice (beta), Hex; OpenSuperWhisper didn't work.
      "spotify"
      "termius"              # SSH client (hosts sync via Termius account)
      "visual-studio-code"
      "vlc"                  # media player
      "zoom"                 # video calls (interviews)

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
      # iOS Simulators for agents (agent-device skill, T3 Device panel).
      # App Store Xcode 27.0 needs macOS 26.6+ and a ~3.1 GB download that
      # expands well past that; a failed install aborts activation before
      # Home Manager. The App Store keeps it current (mas cannot pin).
      # One-time human steps after the first install:
      #   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
      #   sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch
      #   sudo DevToolsSecurity -enable      # no debugger auth prompt mid-run
      #   xcodebuild -downloadPlatform iOS   # simulator runtime, several GB
      "Xcode" = 497799835;
    };

    taps = [
      "dashlane/tap"
      "saffsanity/sill" # Sill, cask above
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
      # The Dock, here rather than in system.defaults.dock: any dock key there
      # makes every switch run `killall Dock`, and the root daemon switches
      # within the hour of a push, mid-session. A change here shows at the
      # next login, or after `killall Dock`.
      "com.apple.dock" = {
        autohide = true;
        orientation = "right"; # dock on the right edge
        tilesize = 128;
      };
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

  # Toolchain drift warning: a nixpkgs bump on 2026-10-10 moved the system
  # node (22.23.2 -> 22.23.3) and pnpm (11 -> 12) and broke job-tracker's
  # commit hooks with no warning at switch time. postActivation runs before
  # /run/current-system moves to $systemConfig, so this compares the running
  # generation with the new one, for `rebuild` and the daily daemon alike.
  # Warns only, never fails the switch. Tests: tests/toolchain_diff_test.sh.
  system.activationScripts.postActivation.text = lib.mkAfter ''
    PATH=${pkgs.coreutils}/bin:$PATH \
      ${pkgs.writeShellScript "toolchain-diff" (builtins.readFile ../scripts/toolchain-diff)} \
      /run/current-system "$systemConfig" ${username} || true
  '';

  # ── macOS and App Store updates ─────────────────────────────────────────
  # macOS updates install by hand: an automatic install restarted the Mac on
  # 11 Oct 2026 in the middle of overnight agent work. They still download in
  # the background, so installing is quick, and Apple's security responses
  # and XProtect data still install themselves. The dotfiles-sync agent
  # reports a pending update (scripts/dotfiles-autoupdate).
  # A plain domain name here would write root's own preferences, which macOS
  # ignores for these settings, hence the /Library/Preferences paths.
  system.defaults.SoftwareUpdate.AutomaticallyInstallMacOSUpdates = false;
  system.defaults.CustomSystemPreferences = {
    "/Library/Preferences/com.apple.SoftwareUpdate" = {
      AutomaticCheckEnabled = true;
      AutomaticDownload = true;
      CriticalUpdateInstall = true;
      ConfigDataInstall = true;
    };
    # App Store apps (masApps above, plus Tachimanga) update themselves.
    "/Library/Preferences/com.apple.commerce".AutoUpdate = true;
  };

  # ── Daily unattended update, root half ──────────────────────────────────
  # scripts/dotfiles-autoupdate, tests in tests/autoupdate_test.sh. The
  # dotfiles-sync agent (nix/user.nix) fetches origin in myuser's GUI session,
  # where the login keychain answers, and hands over the origin/main revision
  # it fetched, hourly on the hour. At ten past, this daemon switches to
  # exactly that revision, never the working tree, so uncommitted or unpushed
  # work is never applied as root, and a running system built from such work
  # waits for the push.
  # Until 11 Oct 2026 one root daemon did all of it and never once succeeded:
  # the keychain refuses a background session, a boot read as "already
  # switched today", and failures reached only a banner nobody opened.
  # `command` (not ProgramArguments) makes nix-darwin wait for /nix at boot.
  # AbandonProcessGroup: when activation reloads this daemon's own plist, the
  # bootout kills only the wrapper, not the in-flight darwin-rebuild.
  launchd.daemons.dotfiles-autoupdate = {
    command = "${pkgs.callPackage ./autoupdate.nix { }}/bin/dotfiles-autoupdate apply";
    path = [ "/run/current-system/sw/bin" "/nix/var/nix/profiles/default/bin" pkgs.git "/usr/bin" "/bin" "/usr/sbin" "/sbin" ];
    environment = {
      AUTOUPDATE_USER = username;
      AUTOUPDATE_HOST = hostname;
      HOME = "/var/root";
    };
    serviceConfig = {
      Label = "com.${username}.dotfiles-autoupdate";
      StartCalendarInterval = [ { Minute = 10; } ];
      RunAtLoad = true;
      AbandonProcessGroup = true;
      StandardOutPath = "/var/log/dotfiles-autoupdate.log";
      StandardErrorPath = "/var/log/dotfiles-autoupdate.log";
    };
  };

  security.pam.services.sudo_local.touchIdAuth = true; # Touch ID for sudo

  # Set once at first install; never change afterwards.
  system.stateVersion = 6;
}
