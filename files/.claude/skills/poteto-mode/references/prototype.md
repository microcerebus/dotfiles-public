# Prototype

You own the design decision, not the code.
The prototype is a throwaway instrument; the real build follows `references/feature.md`.
Speed beats polish here: no tests, no abstractions, and no production framework unless the question needs one.

Do not adversarially review a design nobody has built.
List its open questions and answer them with a prototype first.
Reviews of abstract designs invent theoretical risks and edge cases that never happen.

1. Name the decision the prototype exists to make (a layout, an interaction, a data shape, an approach, a timing) and list the open questions.
   No decision means no prototype: go to `references/feature.md`.
2. When the design space is open, gather prior art first: other apps, upstream projects, and past sessions through recall.
   Skip this when the direction is set.
3. Build two or three variants away from production source: a scratch directory under `/tmp`, or a throwaway branch in its own worktree.
   Add a variant nobody asked for when you see a better idea.
   For a visual or interaction decision, put the variants behind one switcher (buttons or a key), each one labeled.
   For a behavior or timing decision, write the smallest script that exercises the question.
   For a new screen, have `arena/SKILL.md` build the variants in independent contexts within the lane concurrency limit.
4. Drive each variant with the repo's verification skill (`verify-<app>` or `control-<app>`).
   When there is none, a web prototype runs in the agent Chrome from `~/.claude/CLAUDE.md`, never Brave or a plain headless Chrome.
   Use a written Playwright script in a background tab for screen-free work; use `codex-computer-use` for interactive checks.
   While Codex is out of quota and `codex-browser-fallback status` is active, chrome-devtools-axi is the fallback.
   Native apps and simulators go through agent-device the same way.
   Switch between the variants with the prototype's own switcher, screenshot every variant in the same state, and measure what decides it: timing, layout, output, token count.
   The observation is the test.
5. Present the variants, the evidence, the tradeoffs and your pick, then let the owner choose.
   For a visual comparison, publish one page with the screenshots side by side with T3 `html_render` (`visual-reply` skill).
6. Hand the chosen variant to `references/feature.md`, or to `references/architect.md` for its shape.
   Never merge the prototype into production code.

**Reply.**
The question each variant answers, the evidence (screenshots for a visual decision, observed output or timing for a behavior one), the tradeoffs, your pick, and the scratch path.
Say plainly that the prototype is throwaway.
