# Bug fix

You own the fix and its proof.
Every shipped line traces to runtime evidence.
A change that "might help" is a hypothesis, not a fix, and it does not ship.
When evidence refutes a hypothesis, revert what it motivated.

1. Reproduce it yourself on main, the way the user hit it, with the repo's verification skill (`verify-<app>` or `control-<app>` under the repo's `.claude/skills/`).
   With no such skill, drive the surface directly.
   A web page runs in the agent Chrome from `~/.claude/CLAUDE.md`.
   Use a written Playwright script in a background tab for screen-free work; use `codex-computer-use` for interactive checks.
   chrome-devtools-axi is available only while Codex is out of quota and `codex-browser-fallback status` is active.
   Native apps and simulators go through agent-device the same way, and a CLI runs as itself.
   Save the failing output, screenshot or video as the "before".
   If it will not reproduce, tighten the conditions, synthesize the trigger or add logging until it does.
   Ask the owner only with a specific reason the surface cannot be reached, after driving it as far as it goes.
2. Find the cause by elimination.
   Seed the hypotheses with `how/SKILL.md` over the subsystem and `why/SKILL.md` for regression history.
   Each pass, run the check that cuts the most remaining space, and get runtime evidence.
   When state is unclear, add logging and read it as the code runs.
   Confirm the mechanism before you plan a fix.
3. Plan the smallest fix the evidence justifies.
   If it crosses a function boundary, run `references/architect.md` first.
   Hand clear-spec edits to a worker in its own worktree (`codex exec`, or an Opus subagent) with an exact scope.
4. Verify on the same surface: the original repro now passes, and you save the "after".
   Inconclusive, or a pass on a different surface, is not a pass.
   Unit tests show branch behavior, not that the bug is gone.
5. Commit the failing repro (a test or a script) before the fix, so history shows red, then green.
   When the bug has a cheap local test, follow `tdd/SKILL.md` for this step.
6. Run the repo's checks, then follow its push and PR rules.

**Reply.**
What was broken, the root cause, the fix, and how you verified it.
Paste the failing and then the passing repro output verbatim, or link the before and after screenshots or video.
