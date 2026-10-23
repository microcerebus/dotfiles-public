# Batch 5 formal verification maintenance

## Selection

Adopt-adapted: `maintain-formal-verification-skill`.
The [audited upstream source](https://github.com/cursor/plugins/blob/88d47514b82e7c44f00f2b2a72ff6dd12158038c/pstack/skills/maintain-formal-verification-skill/SKILL.md) is prompt-only Markdown from pstack 0.15.29, one file with no scripts.
Its license is [pstack/LICENSE at the same revision](https://github.com/cursor/plugins/blob/88d47514b82e7c44f00f2b2a72ff6dd12158038c/pstack/LICENSE), the same MIT text batch 4 retained.
The fetched skill's SHA-256 is `0c96f54293542d3818b68754562b338073958781a9684454611dca37592e2d2c`.
The license's SHA-256 is `bc957ca6bee02792566a1a028d105e02e247c6e77cf057061674273da77b200e`.

The earlier removal was about unpinned remote code at each use.
This version runs no code of its own: it tells the agent to run the project's recorded verify command and Git.
In this repository that command is the batch 4 runner, which pins its tools.

Maintenance adds three things the batch 4 project skill lacks:

- **Changes that skip the project skill.** The project skill handles an edit made while an agent uses it.
  The runner's hash guard refused a changed subject script (it now reads the subject at its reviewed commit instead), but nothing flagged a changed `rebuild` alias or `configurationRevision` setting, both of which the source map relies on.
  The parallel rollback-race fix is expected to change the subject script and may change the alias, so this case is close, not hypothetical.
- **A judgment for each result.** Outcomes are in sync, updated, bug or blocked, and every covered change is classified before the model changes.
  A pass after an update must be shown to fail on a scratch break.
- **Keeping the record true.** The sync commit advances only after the comparison, only to a commit already on the target branch, main here, and never for a blocked check.

The local `maintain-verification-skill` keeps UI feature maps honest and does not cover formal models, so the two do not overlap.

## Adaptation

- Edit scope also names configurations, source maps, proof notes and the runner's recorded source hash and commit, because the batch 4 proof keeps its correspondence in those files.
- The description drops upstream's slash-command trigger phrases, because the skill is explicit-only and the owner does not type slash commands; agents reach it through the routes below.
- Upstream's "cheap test or reproduction against the real code" becomes a step-by-step trace against the source, because running the updater could switch the system and the tool rule allows no new runner.
- The report adds the runner's recorded tool provenance.
- Step 7 adds "land the checked code first and record its commit in a follow-up", the batch 4 rule for commits that a rebase would change.
- Tools: only the verify skill's command, its pinned runner and Git.
  No new verifier, version change, registry alias, unpinned download, curl-to-shell, brew or global npm.
  An unresolvable pinned tool makes the check blocked; a needed new tool goes to the task owner with options.
- A new detection step runs the verify skill's drift command, or `git diff --stat <sync> -- <covered paths>`, which includes uncommitted edits to tracked files, plus a list of untracked files.
  Empty output and a rerun that reproduces the recorded result mean in sync, reported in one line with no edits.
- A check whose recorded result is already a counterexample stays in sync while nothing covered changes and the same trace returns.
  The open bug is reported with it.
- Break checks mutate scratch copies of the source and model, never the live subject, as the generator requires.
- The sync commit must be on the target branch, because a rebase changes branch SHAs.
- Fresh contexts use the shared role adapter in `arena/references/model-families.md`; the skill names no provider models.
- Reruns go where the runner already writes them; run notes stay in scratch.

Routing keeps the upstream explicit-only policy in both harnesses: `disable-model-invocation: true` and `allow_implicit_invocation: false`.
Agents reach it three ways:

- The [project verify skill](../../.agents/skills/verify-autoupdate-handoff/SKILL.md) now names its covered code, its recorded result, a trace comparison and a four-command drift check, and tells the reader to read the maintenance SKILL.md for covered changes made without it.
- The generator asks every new project verify skill for a drift command, its recorded result and the same pointer.
- poteto-mode's formal leaf sends a request about a subject an existing verify skill covers to maintenance, with maintenance's report as the reply.

The poteto-mode route table is unchanged, so automatic discovery from a cold prompt is the same as in batch 4.
This adds one canonical Claude declaration and one Codex alias in `nix/user.nix`; Nix evaluation shows 30 Codex aliases.
The edits stay clear of the `rebuild` alias line, which the rollback-race worker owns.

## Tool provenance

| Tool | Source | Version |
| --- | --- | --- |
| TLC, through `verify.py` | nixpkgs `7a6522c868711d06e3a520bbcdfafe9806f4337f`, pinned in the runner by revision and NAR hash | tlaplus 1.7.4, TLC 2.19, Zulu JDK 8.0.492 |
| Git | Home Manager profile, root `flake.lock` nixpkgs `5adc50831c259f87faeb09ddf930d43597197473`; store path matches that input's `git` | 2.56.0 |
| Python, for `verify.py` | Home Manager profile from the same nixpkgs; stdlib only | 3.14.8 |
| Nix | the system's Determinate Nix, as in batch 4 | unchanged |

Batch 4 recorded the TLC row; this batch adds no tool.
The source review fetched only the frozen Markdown and license text through read-only GitHub API calls.
No curl-to-shell, unpinned executable download, brew or global npm install ran.

## Drift exercise

A fresh-context Claude Opus 5.5 child at High effort followed the adapted skill once, steps 1 to 4, in two scratch worktrees of the first batch 5 commit.
Claude ran it because Codex is usage-limited until 27 October.
The child was told to read the maintenance skill, not left to discover it.
It edited nothing in either checkout.
Both checkouts were removed afterward; the scratch edit never reached this branch.

| Checkout | Drift command | `verify.py` | Outcome |
| --- | --- | --- | --- |
| Unchanged | [empty](batch-5-exercise/quiet-1.txt) | [exit 12](batch-5-exercise/quiet-2.txt), the restored-baseline counterexample | **in sync**, with the recorded rollback bug still open |
| One-line scratch edit to the updater | [`scripts/dotfiles-autoupdate \| 1 -`](batch-5-exercise/drift-1.txt) | [exit 1](batch-5-exercise/drift-2.txt), `INCONCLUSIVE: source drift` | stale; update needed |

In the unchanged checkout, the rerun's counterexample trace matches the committed baseline trace [line for line](batch-5-exercise/quiet-3.txt).

The [scratch edit](batch-5-exercise/drift-3.txt) deleted apply's second check for a live sync after it publishes its switching marker.
The child classified it as both "the verification no longer describes the code" and "the promise may be broken", because the comment above the deleted line still describes the check.
It named the model action to remove (`ApplyRecheck`), the source-map rows and line references to update, and the hash and commit to advance.
It predicted **updated** with the same open bug, because none of the three properties depends on that check, and flagged that this would hide a real loss of sync/apply exclusion.
That prediction was not run.

The child reported seven points of friction; this batch fixes all seven, six in the skills and one in the proof docs:

1. Step 2 now always continues to the run; the in-sync stop comes after step 3 reproduces the recorded result.
2. The project skill names where its recorded result and baseline trace live, and the generator asks new project skills to do the same.
3. Step 4 reads the drift commands' own output in full, with their filters, instead of an unfiltered diff of `nix/`, which was 8 unrelated commits.
4. An uncommitted edit without a doc comment or test stating a new promise counts as "the promise may be broken".
5. A change to behavior no property checks, such as the deleted recheck, is reported as uncovered; an unchanged result says nothing about it.
6. The source map cited `nix/user.nix 220-223` but claims sync-commit line numbers; at `d553897` the alias block is lines 219-222.
   The source map and proof README now cite those lines with the commit they refer to.
7. The skill is explicit-only, so the project skill and generator now say to read its SKILL.md from the user skills directory rather than wait for it to load.
   This keeps the upstream policy and avoids an always-loaded description.

## Limits

The exercise covers detection and classification on one proof.
It stopped before model updates, so it does not demonstrate the updated or bug outcomes on a revised model.
The seven fixes postdate the exercise and were checked by review, not by a second exercise.
The exercise ran the first commit's two-command drift check, which diffed all of `flake.nix`.
After both reviews the check has four commands (see [checks](checks.md#batch-5-independent-review)); they were checked by scratch edits and a quiet run on this tree, not by a second exercise.
The rollback-race fix landed with its own proof in `docs/formal/autoupdate-handoff` and pinned this one to its reviewed commit; recording the fix's main commit here is the first real maintenance pass, still to do.
The drift commands match two paths, name patterns and untracked files; covered behavior that moves without those names still needs the skill's reading step.
No Codex invocation proof ran, because Codex is usage-limited until 27 October.
