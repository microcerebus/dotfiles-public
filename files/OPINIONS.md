# Engineering opinions

How I think about building software.
Baseline adapted from DietrichGebert/ponytail ("lazy senior dev"), with engineering principles from Lauren Tan's pstack (cursor/plugins, `pstack/skills/principle-*`, MIT); local additions below.
This is a living document - update it when my actual decisions contradict it.
Last reviewed: 2026-10-07.

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
- Tests call code the way users do and assert literal expected values. A test that passes when everything returns undefined gets rewritten or deleted. [test-behavior-not-implementation]
- Before trusting a measured number, find what limits it and rule out that it measured something else. [explain-the-number]
- After two failed fixes built on the same assumption, question the assumption instead of writing a third. [attack-the-premise]
- Fewer polished features over more rough ones; user experience beats implementation convenience. [experience-first]
- Agents don't stop to ask about reversible work; they do it and show the result. Confirmation is for irreversible actions. [never-block-on-the-human]
- Big changes ship as small steps that each end in a state you can verify. [sequence-verifiable-units]

## Code taste

- Deletion over addition. Boring over clever.
  Applies to tooling too: unused skills, commands, plugins and apps get deleted, not kept "just in case".
- Fewer dependencies over convenient dependencies.
  Every dependency is a liability I have to carry.
- Question complexity in the request itself - ask what is actually needed before building the elaborate version.
- Match the style of the surrounding code; consistency beats personal preference.

## Choosing dependencies and libraries

Security is the number one priority; popularity is not evidence of quality.
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

## Environment and tooling

- Declarative and reproducible over imperative and drifting.
  My machine is a Nix flake; growth happens as small reviewed commits, not ad-hoc installs.
- Every installed app is declared, and everything updates itself daily.
  Update automation must catch up after downtime (Mac asleep or off) and fail loudly, never silently.
- Anything I review (artifacts, agent sessions) should be reachable from my phone over Tailscale.
- FOSS-first. Proprietary tools need a strong reason and an exit path.
- One tool per job, one obvious layer that owns it. No duplicate tooling.
- Aesthetics are consistent everywhere or not at all: Catppuccin theme, JetBrains Mono Nerd Font, across every tool that can be themed.
