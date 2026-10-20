---
name: codex-computer-use
description: "Use Codex computer use for interactive checks that need the screen, including native macOS apps, simulators and interactive Chrome checks. Screen-free browser reading, screenshots and WhatsApp Web use written Playwright scripts attached to the agent Chrome in background tabs. chrome-devtools-axi is only a confirmed Codex quota fallback."
---

# codex-computer-use

Route computer-use verification to the codex CLI (model set in ~/.codex/config.toml).
Codex's desktop computer use covers native macOS surfaces (Xcode, simulators, arbitrary apps) that browser automation cannot reach; screenshots and long visual loops are token-heavy, which is exactly what should not run on Fable.

## Screen-free browser work

Reading pages, taking browser screenshots and reading WhatsApp Web do not need the screen.
Use a written Playwright script attached to Google Chrome Beta on 127.0.0.1:9333, in its own background tab.
Run it with `agent-chrome-playwright <flow.cjs>`.
The helper checks readiness and the actual Chrome application and flags, creates a background target, and passes only that page to the script.
It closes its target and disconnects when the script finishes; it never quits the shared Chrome.
Do not call `bringToFront`, change the shared window, browse other tabs or close the shared browser.
Use per-page viewport sizing when a screenshot needs a phone layout.
Existing headless Playwright fixture tests stay independent of signed-in account work.

A flow file exports one async function:

```js
module.exports = async function (page) {
  await page.goto("https://example.com");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: "/tmp/page-proof.png", fullPage: true });
  console.log(await page.title());
};
```

Use interactive computer use below only when the check needs screen control.

## Workflow

1. Decide the surface first.
   Screen-free browser work belongs in a written Playwright script attached to the agent Chrome in a background tab; an interactive check runs here (see Browser checks below).
   chrome-devtools-axi is only the fallback while Codex is out of quota, and the evidence names it.
   It requires active `codex-browser-fallback status`; record the reported reset time following `~/dotfiles/docs/model-routing.md` and clear the state when Codex returns.
2. Write a small, concrete verification script in prose: what to launch, what to click or type, and what observable outcome counts as pass.
3. Create a scratch dir for evidence: `DIR=$(mktemp -d)`.
4. Run every computer-use check through `codex-computer-use`, never the raw Codex binary.
   The launcher runs `agent-chrome-ready`, reserves the screen against concurrent runs, and shows this macOS dialog before starting Codex:
   "Codex needs your screen for about N min. Please stop using the Mac until it's done."
   "Start now" proceeds; "Wait 10 min" defers and asks again.
   If the dialog has no answer after 60 seconds, the launcher proceeds only when `ioreg` reports at least two minutes of HID idle time.
   Otherwise it keeps waiting; missing idle data never grants screen control.
   `--minutes` supplies the estimate, defaulting to 5.
   When Codex exits, even with a failed check, the launcher posts a notification that the screen is free again.

   ```sh
   codex-computer-use --minutes 5 -- "Verify this flow on my Mac: <steps>. Capture screenshots of each key state into $DIR. Finish with a PASS or FAIL verdict and one line per step describing what you observed."
   ```

   The launcher owns the ChatGPT app's bundled signed Codex binary and `exec -s danger-full-access` flags.
   The Computer Use service rejects an unsigned CLI with "Sender process is not authenticated"; the default read-only sandbox blocks screenshots and evidence writes.
   Do not bypass the launcher when a dialog fails, a run is deferred or another run holds the screen lock.
   If a crashed run left `~/.local/state/codex-computer-use/screen.lock`, inspect its recorded process and remove it only after confirming the run has ended.

   Bring the target app to the front in the prompt; computer use refuses to act while the Codex app itself is frontmost.
   If startup still fails, a stale service may hold the IPC socket: `pkill SkyComputerUseService`, then retry once.

5. Read the verdict and inspect the screenshots before relaying results.
   Treat codex's PASS as evidence, not proof - spot-check the screenshot for the claimed state.
6. If codex reports it could not complete the flow, relay that verbatim with the step it stopped at - do not re-run silently.

## Browser checks

For interactive checks, Codex drives the agent Chrome with computer use.
Screen-free reading, screenshots and WhatsApp Web use the Playwright route above.
It reached for chrome-devtools-axi until told not to, and could not act in Chrome Beta until the app was brought to the front (coordinator 24, 2026-10-17), so the brief says both.

1. Make sure the agent Chrome is up.
   Its launchd agent `com.myuser.agent-chrome` is the only way Google Chrome Beta is ever started: it adds `--disable-extensions --disable-sync` and port 9333.
   Never start it any other way (`open -a`, `tell application ... to activate` or the binary): Chrome Beta would open its default profile without those flags, and the synced extensions load.
   The `codex-computer-use` launcher runs `agent-chrome-ready` before showing the warning and stops if readiness fails.
   That check kickstarts the agent, waits up to 15 seconds for 9333 to answer, and points at `~/Library/Logs/agent-chrome.log` if it never does.

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
