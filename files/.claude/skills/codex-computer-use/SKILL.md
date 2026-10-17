---
name: codex-computer-use
description: Ask the codex CLI to run local app verification that needs computer use - native macOS apps, simulators, interactive browser checks in the agent Chrome, screenshots, app launching, or independent runtime inspection. Use when the user asks to test a flow, verify UI behavior, inspect a running app, capture screenshots, or confirm implemented behavior end-to-end. A repeatable browser flow belongs in a Playwright script instead; chrome-devtools-axi is only the fallback while Codex is out of quota.
---

# codex-computer-use

Route computer-use verification to the codex CLI (model set in ~/.codex/config.toml).
Codex's desktop computer use covers native macOS surfaces (Xcode, simulators, arbitrary apps) that browser automation cannot reach; screenshots and long visual loops are token-heavy, which is exactly what should not run on Fable.

## Workflow

1. Decide the surface first.
   A repeatable browser flow belongs in a written Playwright script; an interactive browser check runs here, in the agent Chrome (see Browser checks below).
   chrome-devtools-axi is only the fallback while Codex is out of quota, and the evidence names it.
2. Write a small, concrete verification script in prose: what to launch, what to click or type, and what observable outcome counts as pass.
3. Create a scratch dir for evidence: `DIR=$(mktemp -d)`.
4. Run codex with the verification prompt, using the Codex desktop app's bundled binary, not the `codex` on PATH.
   The Computer Use service authenticates its caller by code signature and rejects the Nix-installed CLI with "Sender process is not authenticated", which surfaces as "Sky Computer Use native pipe startup failed" (diagnosed 2026-08-24).
   `-s danger-full-access` is required: codex exec's default read-only sandbox blocks screencapture, app launching, and writes to $DIR, which is the entire job here.

   ```sh
   CODEX="/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
   "$CODEX" exec -s danger-full-access "Verify this flow on my Mac: <steps>. Capture screenshots of each key state into $DIR. Finish with a PASS or FAIL verdict and one line per step describing what you observed."
   ```

   Bring the target app to the front in the prompt; computer use refuses to act while the Codex app itself is frontmost.
   If startup still fails, a stale service may hold the IPC socket: `pkill SkyComputerUseService`, then retry once.

5. Read the verdict and inspect the screenshots before relaying results.
   Treat codex's PASS as evidence, not proof - spot-check the screenshot for the claimed state.
6. If codex reports it could not complete the flow, relay that verbatim with the step it stopped at - do not re-run silently.

## Browser checks

Codex drives the agent Chrome with computer use, the same way it drives any app.
It reached for chrome-devtools-axi until told not to, and could not act in Chrome Beta until the app was brought to the front (coordinator 24, 2026-10-17), so the brief says both.

1. Make sure the agent Chrome is up.
   Its launchd agent `com.myuser.agent-chrome` is the only way Google Chrome Beta is ever started: it adds `--disable-extensions --disable-sync` and port 9333.
   Never start it any other way (`open -a`, `tell application ... to activate` or the binary): Chrome Beta would open its default profile without those flags, and the synced extensions load.
   Run `agent-chrome-ready` before Codex, as its own command, and stop if it exits 1.
   It kickstarts the agent, waits up to 15 seconds for 9333 to answer, and points at `~/Library/Logs/agent-chrome.log` if it never does.

2. Start the prompt with these three sentences, as written:

   > Drive the agent Chrome (Google Chrome Beta, its own profile on 127.0.0.1:9333) through computer use: click, type and screenshot in its window. Do not use chrome-devtools-axi, Playwright or any other browser tool, and never Brave or the owner's own Chrome.
   >
   > First bring Google Chrome Beta to the front with `osascript -e 'tell application "System Events" to set frontmost of process "Google Chrome Beta" to true'`, which cannot start it: its launchd agent is the only way Chrome Beta is ever started, so if it is not running, stop and report instead of starting it.
   >
   > Every agent shares this one window: open your own new tab and close it when done, never resize or move the window, and never touch other tabs.

## Prompting codex

- Keep prompts short, plain, and self-contained; describe the flow like a manual test case.
- One flow per invocation; batch verdicts confuse the parent session.
- Codex calls can time out on long visual loops: retry once, then report the timeout instead of looping.
