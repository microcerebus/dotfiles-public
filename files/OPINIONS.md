# Engineering opinions

How I think about building software.
Baseline adapted from DietrichGebert/ponytail ("lazy senior dev"), with engineering principles from Lauren Tan's pstack (cursor/plugins, `pstack/skills/principle-*`, MIT); local additions below.
This is a living document - update it when my actual decisions contradict it.
Last reviewed: 2026-10-15.

## Before writing code, climb this ladder

Check each rung in order; stop at the first one that solves the problem.

1. Does this need to exist at all? (YAGNI)
2. Does this codebase already do it somewhere? Reuse, don't rewrite.
3. Does the standard library do it?
4. Does the platform do it natively?
5. Does an already-installed dependency do it?
6. Can it be one line?
7. Only then: write the minimum code that works.

Be lazy about the solution, never about the reading.
Understand the problem fully and trace the real flow before picking a rung.

## Never be lazy about

- Input validation, error handling that prevents data loss, security, accessibility.
- Anything I explicitly asked for.
- Root causes: fix the disease, not the symptom.
- Testing non-trivial logic: leave at least one runnable check that fails if the logic breaks.

## Engineering principles (pstack)

Paraphrased from pstack; the name in brackets is the upstream skill to read for the full version.

- Get the data structures and types right first, and the code that uses them gets obvious. Encode the domain in a structure, not in conditionals scattered across files. [foundational-thinking, model-the-domain]
- Make illegal states unrepresentable. Parse external data once at the boundary, then trust the types inside. No casts or `any` to quiet the compiler. [type-system-discipline, boundary-discipline]
- Validation and error handling live at system edges (CLI, config, network, external APIs). Business logic stays pure. [boundary-discipline]
- Remove dead code and redundant checks before building on top. When a new API replaces an old one, migrate every caller and delete the old one in the same change, no compatibility shims. [subtract-before-you-add, migrate-callers-then-delete-legacy-apis]
- A new requirement gets designed in as if it had been there from day one, not bolted on. [redesign-from-first-principles]
- Anything that runs amid crashes, restarts, or retries must be idempotent: rerunning converges to the same state. [make-operations-idempotent]
- If two concurrent actors can write the same thing, remove the sharing before adding locks. [separate-before-serializing-shared-state]
- When a correction repeats, turn it into a lint, check, or script rather than more instructions. [encode-lessons-in-structure]
- For non-trivial work, build the tool that does it or proves it (script, codemod, generator), so a reviewer can rerun it. [build-the-lever]
- Done means checked against the real thing: run it, read the actual value, look at the diff. "It compiles" is not done. [prove-it-works]
- Keep verification simple: Playwright, Chrome DevTools and curl wherever they can do the job, instead of long chains of custom scripts.
- Tests call code the way users do and assert literal expected values. A test that passes when everything returns undefined gets rewritten or deleted. [test-behavior-not-implementation]
- Write the failing test first and watch it fail, then make it pass.
- Before trusting a measured number, find what limits it and rule out that it measured something else. [explain-the-number]
- After two failed fixes built on the same assumption, question the assumption instead of writing a third. [attack-the-premise]
- Fewer polished features over more rough ones; user experience beats implementation convenience. [experience-first]
- When I'm building a tool for my own use, the first goal is a workable end-to-end version I can start using.
  Its UI has to be workable and usable before it has to be perfect.
- Agents don't stop to ask about reversible work; they do it and show the result. Confirmation is for irreversible actions. [never-block-on-the-human]
- Big changes ship as small steps that each end in a state you can verify. [sequence-verifiable-units]
- Small, independent PRs over stacks: each branches from main and merges on its own, so one stuck review never holds up the rest.
- A PR that changes what users see includes before and after screenshots or a recording.
- Pre-commit hooks finish in under a minute; heavy suites (E2E, full test runs, builds) run in CI.
- Verification comes before parallelism: add agents only once their work can be checked without me. [create-verification-skill]

## Code taste

- Deletion over addition. Boring over clever.
  Applies to tooling too: unused skills, commands, plugins and apps get deleted, not kept "just in case".
- Fewer dependencies over convenient dependencies.
  Every dependency is a liability I have to carry.
- Question complexity in the request itself - ask what is actually needed before building the elaborate version.
- Match the style of the surrounding code; consistency beats personal preference.

## Choosing dependencies and libraries

Security is the number one priority; popularity is not evidence of quality.
Never run code from a moving branch or an unpinned URL; pin a version or commit.
Before adopting any library, plugin, or tool, check the actual repo data (gh api, not vibes):

1. Security surface: no prebuilt binaries or opaque blobs, minimal transitive dependencies, no unnecessary network access.
2. Alive: recent commits and a regular release cadence.
3. Maintainer responsiveness: open-issue count relative to adoption, active discussions, issues actually getting fixed.
4. Stability: semver discipline and low breaking-change churn - a project on major version 28 rewrites itself too often.
5. Community adoption: what do mature ecosystems standardize on.

Prefer the boring, widely-adopted, steadily-maintained option over the flashy feature-rich one.

## Writing and documents

- Text-heavy is a defect.
  Prefer diagrams, tables, and short paragraphs; cut restatement.
- Say each detail once, in the surface that owns it.
  If a diagram's annotations already carry the reasoning, the prose points at the diagram instead of restating it; the doc exists to aid understanding, not to duplicate.
- A submitted document should be as short as the judgment allows - attention to detail shows in the choices, not the word count.
- A UI review page shows the real components from the product's design system, with as little prose as possible.

## Environment and tooling

- Declarative and reproducible over imperative and drifting.
  My machine is a Nix flake; growth happens as small reviewed commits, not ad-hoc installs.
- Every installed app is declared, and everything updates itself daily.
  Update automation must catch up after downtime (Mac asleep or off) and fail loudly, never silently.
- Anything I review (artifacts, agent sessions) should be reachable from my phone over Tailscale.
- Open source for the dev toolchain (terminal, editor, shell, CLIs). Closed GUI and agent apps are fine when declared in `nix/host.nix`; anything my workflow depends on needs an exit path.
- One tool per job, one obvious layer that owns it. No duplicate tooling.
- Skills only help when they get used: make them model-invocable or name them in the brief.
- pstack's skills (poteto mode) are the default method for plans, reviews and investigations.
- pnpm over npm wherever a JS package manager is needed.
- For web apps, default to React with TanStack Start, Tailwind and Vite.
  Unit tests use Vitest with React Testing Library, and end-to-end tests use Playwright.
  The backend uses Effect wherever it fetches data, and Prettier formats the code.
- Default to free tiers and services I already pay for.
  Starting a new paid plan is my call.
- CodeRabbit remains the recorded PR-review preference, subject to the separate setup decision.
  Use Codex by default for new conversations, coordination, design, writing, implementation and review, following docs/model-routing.md.
  Use Astra High for judgment, Sol High for routine implementation and Sol Low for mechanical collection, with Fast off.
  Judge user-facing output against its acceptance checks, and apply unslop to writing.
  Use Claude for an explicit task-level exception, a demonstrated capability gap or a confirmed Codex usage limit.
  Tried and dropped, don't re-suggest: GitHub Copilot, Wakatime, Paseo, mosh/Moshi, Hex and OpenSuperWhisper (voice typing is Handy now), Codex cloud tasks (couldn't carry a real session), agenttrail (a 3D view of one repo; can't show T3 threads, who waits on me or context, so the agent board does that).
- Claude Code installs natively, not as a brew cask (reversed 2026-10-07: the cask fell ~60 versions behind because brew skips self-updating casks).
- Catppuccin for the dev toolchain (terminal, editor, shell), with JetBrains Mono Nerd Font; products I build get their own design system.

## Product design blacklist

- No decorative colored left-edge accent rails on navigation, cards, alerts, dialogs or other panels.
  Use neutral selection fills, clear text hierarchy or subtle whole-surface status tint instead.
  Keep meaningful structural separators, timeline lines and accessible focus indicators.
  Added from job-tracker design feedback on 2026-10-08.
- No raw ISO dates or times on screen.
  Format them with the platform's `Intl` APIs and set them with native date and time pickers where the platform has them.
  ISO stays in storage and APIs.
- No one-off controls.
  Get the design system right before building screens, then every screen uses its standard components, date and time pickers included.
- No values or panels that sit off-center or off-edge.
  Text in inputs, pickers and rows is vertically centered, and a drawer meets the screen edge flush.
  Check alignment on every UI change, because reviews caught it four times between 2026-10-08 and 2026-10-11.
- No silent hiding.
  When the UI hides or ranks something low by default, it says so and offers a way to show it.
- No text inside skeleton loaders.
- No status styles that look alike.
  Success, warning and error each read differently at a glance.
  Added from job-tracker reviews on 2026-10-08 to 2026-10-11.
