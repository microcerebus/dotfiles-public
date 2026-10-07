# Engineering opinions

How I think about building software.
Baseline adapted from DietrichGebert/ponytail ("lazy senior dev"); local additions below.
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
