---
name: codex-computer-use
description: Ask the codex CLI (GPT-5.5) to run local app verification that needs computer use - native macOS apps, simulators, screenshots, app launching, or independent runtime inspection beyond the browser. Use when the user asks to test a flow, verify UI behavior, inspect a running app, capture screenshots, or confirm implemented behavior end-to-end. For browser-only work, prefer chrome-devtools-axi.
---

# codex-computer-use

Route computer-use verification to GPT-5.5 through the codex CLI.
Codex's desktop computer use covers native macOS surfaces (Xcode, simulators, arbitrary apps) that browser automation cannot reach; screenshots and long visual loops are token-heavy, which is exactly what should not run on Fable.

## Workflow

1. Decide the surface first: if the whole verification lives in a browser tab, use the chrome-devtools-axi skill instead and stop here.
2. Write a small, concrete verification script in prose: what to launch, what to click or type, and what observable outcome counts as pass.
3. Create a scratch dir for evidence: `DIR=$(mktemp -d)`.
4. Run codex with the verification prompt, using the Codex desktop app's bundled binary, not the `codex` on PATH.
   The Computer Use service authenticates its caller by code signature and rejects the Nix-installed CLI with "Sender process is not authenticated", which surfaces as "Sky Computer Use native pipe startup failed" (diagnosed 2026-08-24).
   `-s danger-full-access` is required: codex exec's default read-only sandbox blocks screencapture, app launching, and writes to $DIR, which is the entire job here.

   ```sh
   CODEX=/Applications/ChatGPT.app/Contents/Resources/codex
   "$CODEX" exec -s danger-full-access "Verify this flow on my Mac: <steps>. Capture screenshots of each key state into $DIR. Finish with a PASS or FAIL verdict and one line per step describing what you observed."
   ```

   Bring the target app to the front in the prompt; computer use refuses to act while the Codex app itself is frontmost.
   If startup still fails, a stale service may hold the IPC socket: `pkill SkyComputerUseService`, then retry once.

5. Read the verdict and inspect the screenshots before relaying results.
   Treat codex's PASS as evidence, not proof - spot-check the screenshot for the claimed state.
6. If codex reports it could not complete the flow, relay that verbatim with the step it stopped at - do not re-run silently.

## Prompting codex

- Keep prompts short, plain, and self-contained; describe the flow like a manual test case.
- One flow per invocation; batch verdicts confuse the parent session.
- Codex calls can time out on long visual loops: retry once, then report the timeout instead of looping.
