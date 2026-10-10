---
name: agent-device
description: "Drive native macOS apps and iOS Simulators through the pinned agent-device CLI (callstack/agent-device): open an app, read its accessibility tree as @refs, press, fill, type, scroll, take window screenshots, and verify the result. Use whenever a task needs a desktop app, a menu bar extra, or a simulator: testing a native flow, inspecting a running app, capturing evidence, or checking UI state beyond the browser. For web pages use chrome-devtools-axi instead."
---

# agent-device

One CLI for both jobs: macOS desktop apps on this Mac, and iOS Simulators once Xcode is installed.
It reads the app's accessibility tree, so act on refs and selectors and treat screenshots as evidence.
It is the same tool T3 Code uses for its Device panel.

## Before the first command

- `agent-device --version` must print the pinned version, `0.21.23`.
  If it is missing or different, stop and report it; do not install or upgrade it yourself, and never use `npx agent-device@latest`.
- `AGENT_DEVICE_MACOS_APP_BACKEND=native` is set for every shell.
  It drives apps through accessibility actions in the background, without moving the owner's pointer or putting the Mac in Automation Mode.
- macOS permissions come from T3 Code (Nightly), the app that spawned this session.
  Nothing else needs a grant.
- The first macOS snapshot after an install or upgrade builds a small Swift helper from the package source and takes about a minute.

## macOS apps

```sh
agent-device open Calculator --platform macos      # starts a session, prints @refs
agent-device snapshot -i --platform macos          # interactive elements only
agent-device press 'label="7"' --settle --platform macos
agent-device fill @e5 "text" --settle --platform macos
agent-device screenshot "$DIR/state.png" --platform macos
agent-device close --platform macos
```

1. Open the app by name or bundle id; if unsure of the name, run `agent-device apps --platform macos` (add `--all` for Apple's own apps) and pick one from the list.
   Leave out `--foreground` unless the task needs the app in front.
2. Act with `press`, `fill`, `scroll` plus `--settle`; it waits for the UI to go quiet and prints a diff.
   Continue from the diff; take a fresh `snapshot -i` only when the diff lacks the next target.
3. Refs expire after every action.
   Copy refs exactly as printed (`@e6~s575545`) and prefer `label=` or `id=` selectors over refs you have already used.
4. Verify the expected end state in the diff or a fresh snapshot before reporting success.
   A screenshot alone is not verification; look at it before relaying it.
5. End with `agent-device close`, and quit any app you launched that was not running before.

Other surfaces: `--surface frontmost-app`, `--surface desktop` and `--surface menubar` on `open`.
Run `agent-device help macos` or `agent-device help workflow` when a command shape is unclear; error output carries a hint, follow it.

The native backend refuses drags, double clicks, secondary clicks and press-and-hold.
When a task needs one, say so in the report instead of falling back to raw coordinates.

## iOS Simulators

Needs Xcode, and T3's agent device access turned on (Settings, Integrations, Devices).

1. Call the t3-code `device_open` tool first.
   It boots the simulator, shows it in the owner's Device panel so he can watch, and returns the exact `agent-device` command line to use.
2. Use that returned command, with its `--config` and `--session` flags, on every step; it points at T3's own copy and daemon.
3. Grab what the owner sees with `device_screenshot`, and finish with `device_close`.

If `device_list` says agent device access is off, report that as a step for the owner; do not flip T3 settings yourself.

## Boundaries

- Never open or drive Brave.
  Web pages go through chrome-devtools-axi in Google Chrome.
- Personal apps (WhatsApp, Telegram, Dashlane, Mail, Messages, anything holding money or credentials) only when the brief names the app and the action.
  Never read message contents into chat or type secrets.
- Never change System Settings privacy panes or approve permission prompts on the owner's behalf.

## When it fails

- `AX unavailable`, a sparse snapshot, or a blank screenshot can mean the shared daemon was started from another app and carries that app's permissions (a Ghostty-started daemon has Ghostty's, not T3's).
  Run `agent-device daemon stop`, retry once, and if it still fails, report that T3 Code (Nightly) needs Accessibility or Screen and System Audio Recording.
- `simctl` or `xcodebuild` errors mean Xcode is missing or `xcode-select -p` still points at the Command Line Tools; report it, do not switch it.
