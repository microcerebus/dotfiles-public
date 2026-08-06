-- Hammerspoon — macOS automation (opted in, PLAN Phase 0; config Phase 2).
-- Keybinding layering (AGENTS.md / docs/tmux-training.md): Ghostty owns
-- cmd+*, tmux owns C-a, Herdr owns its in-app keys. Hammerspoon therefore
-- binds ONLY hyper chords (cmd+alt+ctrl), which none of those layers use.
local hyper = { "cmd", "alt", "ctrl" }

-- hyper+r: reload this config
hs.hotkey.bind(hyper, "r", function()
  hs.reload()
end)

-- hyper+g: focus (or launch) Ghostty
hs.hotkey.bind(hyper, "g", function()
  hs.application.launchOrFocus("Ghostty")
end)

hs.alert.show("Hammerspoon ready")
