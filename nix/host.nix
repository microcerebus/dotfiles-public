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

  programs.zsh.enable = true; # default shell integration for nix-darwin

  # ── Declarative Homebrew (GUI apps only) ──────────────────────────────────
  # `setup/mac.sh` installs Homebrew itself; nix-darwin then manages the list.
  homebrew = {
    enable = true;
    onActivation = {
      # Upgrades happen only at human-run `rebuild`, never in the background:
      # brew refreshes taps and upgrades everything declared below while the
      # human watches the output. Guardrails: casks stay non-greedy (default)
      # so self-updating apps manage themselves; cleanup=zap keeps the set
      # declarative; `brew pin <formula>` holds back a known-bad version; the
      # weekly cloud routine reviews new formula/cask versions for advisories
      # alongside the flake.lock bump it pushes to main.
      autoUpdate = true;
      cleanup = "zap"; # remove anything not declared here (keeps machine honest)
      upgrade = true;
    };

    casks = [
      "ghostty"    # terminal emulator (AGENTS.md: the one and only)
      "claude-code" # Claude Code CLI, declared instead of the ~/.local/bin
                    # self-installer. After the first rebuild remove the old
                    # binary (`rm ~/.local/bin/claude`) or it shadows the cask
                    # (~/.local/bin precedes /opt/homebrew/bin in sessionPath).
      "codex-app"  # OpenAI Codex desktop app (agent manager). The codex *CLI*
                    # is separate and stays in Home Manager (nix/user.nix).
      "orbstack"   # container runtime (AGENTS.md: no Docker Desktop et al.)
      "karabiner-elements"   # opted in (PLAN Phase 0); config comes in Phase 2
      "hammerspoon"          # opted in (PLAN Phase 0); config comes in Phase 2
      "raycast"              # launcher; owns cmd+space (Spotlight hotkey disabled below)

      # Daily apps. Previously hand-installed; declared here so cleanup = "zap"
      # stops removing them and fresh machines get them for free.
      # One-time adoption of already-present apps (human runs):
      #   brew install --cask --adopt brave-browser chatgpt discord \
      #     kitlangton-hex logi-options+ rectangle visual-studio-code
      "brave-browser"   # kept installed; Chrome is the browser for agent tooling
      "chatgpt"         # OpenAI ChatGPT desktop app
      "cursor"          # Cursor editor
      "discord"
      "google-chrome"
      "google-drive"         # Google Drive desktop sync client
      "kitlangton-hex"       # Hex.app - voice-to-text (com.kitlangton.Hex)
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
    masApps = {
      "Dashlane" = 517914548;
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
      "dashlane/tap/dashlane-cli" # not in nixpkgs; official tap (PLAN Phase 4)
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

  security.pam.services.sudo_local.touchIdAuth = true; # Touch ID for sudo

  # Set once at first install; never change afterwards.
  system.stateVersion = 6;
}
