---
name: agent-device
description: "Drive native macOS apps and iOS Simulators through the pinned agent-device CLI (callstack/agent-device): open an app, read its accessibility tree as @refs, press, fill, type, scroll, take window screenshots, and verify the result. Use whenever a task needs a desktop app, a menu bar extra, or a simulator: testing a native flow, inspecting a running app, capturing evidence, or checking UI state beyond the browser. For screen-free web work use written Playwright scripts in background agent Chrome tabs; use codex-computer-use for interactive checks. chrome-devtools-axi is only a confirmed Codex quota fallback."
---

# agent-device

One CLI for both jobs: macOS desktop apps on this Mac, and iOS Simulators once Xcode is installed.
It reads the app's accessibility tree, so act on refs and selectors and treat screenshots as evidence.
T3 Code's Device panel uses the same tool through its own copy, which can be a different version.

## Before the first command

- `agent-device --version` must print the pinned version, `0.21.36`.
  If it is missing or different, stop and report it; do not install or upgrade it yourself, and never use `npx agent-device@latest`.
- `AGENT_DEVICE_MACOS_APP_BACKEND=native` is set for every shell.
  It drives app sessions through accessibility actions in the background, without moving the owner's pointer or putting the Mac in Automation Mode.
- macOS permissions come from T3 Code (Nightly), the app that spawned this session.
  Nothing else needs a grant.
- The first command that needs the small Swift helper after an install or upgrade builds it from the package source and takes about a minute, so give that command time before calling it failed.

## macOS apps

```sh
# $S is a session name unique to this task and app: a named session is shared across worktrees.
agent-device open Calculator --platform macos --session "$S"   # prints no @refs
agent-device snapshot -i --platform macos --session "$S"       # interactive elements, with @refs
agent-device press 'label="7"' --settle --platform macos --session "$S"
agent-device fill @e5 "text" --settle --platform macos --session "$S"
agent-device screenshot "$DIR/state.png" --platform macos --session "$S"
agent-device close --platform macos --session "$S"
```

1. Open the app by name or bundle id; if unsure of the name, run `agent-device apps --platform macos` (add `--all` for Apple's own apps) and pick one from the list.
   Plain `open` prints no refs, so get them with `snapshot -i`, or add `--foreground` to have a fresh `open` return an initial snapshot.
   `--foreground` only asks for that snapshot and does not bring the app to the front.
2. Act with `press`, `fill`, `scroll` plus `--settle`; it waits for the UI to go quiet and prints a diff.
   Continue from the diff; take a fresh `snapshot -i` only when the diff lacks the next target.
3. Refs expire after every action.
   Copy refs exactly as printed (`@e6~s575545`) and prefer `label=` or `id=` selectors over refs you have already used.
4. Verify the expected end state in the diff or a fresh snapshot before reporting success.
   A screenshot alone is not verification; look at it before relaying it.
5. End with `agent-device close`, and quit any app you launched that was not running before.

With the native backend, each app on the default `app` surface is its own device.
It opens in the background with or without `--foreground`, so the frontmost app stays in front.
`open` and `close` touch only that app.
Use a new `--session` for each app.
Sessions on different apps run in parallel; a second session on the same app or a whole-Mac surface conflicts.
An app session refuses clipboard, settings and audio probe, so use a `--surface desktop` session for those.

Other surfaces, which take the whole Mac: `--surface frontmost-app`, `--surface desktop` and `--surface menubar` on `open`.
On `frontmost-app` and `menubar`, `press` and `click` post synthetic mouse events, which the pointer promise above does not cover.
`desktop` is inspect-only.
Run `agent-device help macos` or `agent-device help workflow` when a command shape is unclear; error output carries a hint, follow it.

The native backend fails these with `UNSUPPORTED_OPERATION`: `record`, `prepare`, `back`, `longpress`, `--hold-ms`, `--double-tap`, `--button secondary`, gestures such as drags, and clicks on an element with no accessibility action.
When a task needs one, say so in the report instead of falling back to raw coordinates.

## iOS Simulators

Needs Xcode, and T3's agent device access turned on (Settings, Integrations, Devices).

1. Call the t3-code `device_open` tool first.
   It boots the simulator, shows it in the owner's Device panel so he can watch, and returns the exact `agent-device` command line to use.
2. Use that returned command, with its `--config` and `--session` flags, on every step; it points at T3's own copy and daemon.
   Both copies use `~/.agent-device/device-claims`, and upstream supports one version per claims directory.
   If `open` fails with `DEVICE_IN_USE`, `agent-device device status` lists the claims, which can include one from the other copy.
3. Grab what the owner sees with `device_screenshot`, and finish with `device_close`.

If `device_list` says agent device access is off, report that as a step for the owner; do not flip T3 settings yourself.

## Boundaries

- Never open or drive Brave.
  Screen-free web work goes through written Playwright scripts in background agent Chrome tabs (`agent-chrome-playwright --minutes N --what "..."`, which notifies the owner); interactive checks go through codex-computer-use.
  The chrome-devtools-axi fallback requires `codex-browser-fallback status` to be active.
- Personal apps (WhatsApp, Telegram, Dashlane, Mail, Messages, anything holding money or credentials) only when the brief names the app and the action.
  Never read message contents into chat or type secrets.
- Never change System Settings privacy panes or approve permission prompts on the owner's behalf.

## When it fails

- `AX unavailable`, a sparse snapshot, or a blank screenshot can mean the shared daemon was started from another app and carries that app's permissions (a Ghostty-started daemon has Ghostty's, not T3's).
  Run `agent-device daemon stop`, retry once, and if it still fails, report that T3 Code (Nightly) needs Accessibility or Screen and System Audio Recording.
- `daemon-incompatible` means a daemon from an older release is still running, which can happen on the first run after the updater moves the pin.
  Run `agent-device daemon stop` and retry once.
- `daemon-busy` means a daemon from another version or build still holds work, possibly another agent's.
  Report it if another agent may be using the daemon; otherwise run `agent-device daemon stop` and retry once.
- `simctl` or `xcodebuild` errors mean Xcode is missing or `xcode-select -p` still points at the Command Line Tools; report it, do not switch it.
