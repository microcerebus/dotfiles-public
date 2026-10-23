# Batch 3 upstream delta

This review compares pstack 0.15.24 at `1e5c90a4b6f249917bd21fe361b3a2a7deb741b8` with 0.15.29 at `88d47514b82e7c44f00f2b2a72ff6dd12158038c`.
The starting local adaptation is batch 2 at `2e8783a`.
A fresh GitHub comparison verified all 35 changed pstack file blobs against the source copies used for this review.
The old source, new source and pre-edit local patches were compared before editing.
The decisions below describe local preparation, not activation.

## Principles

The principle leaf skills remain deliberately uninstalled.
Their local equivalents are OPINIONS and routed playbooks.
This batch leaves both preference files unchanged and ports applicable guidance into the workflows that use it.

| Entry | Outcome | Upstream change | Local decision and evidence |
|---|---|---|---|
| principle-attack-the-premise | Ported | Replaces the mandatory imbalance census with a direct, rerunnable premise check. | `poteto-mode/references/bug-fix.md` now requires writing and testing the shared premise after two failed fixes. The short OPINIONS summary already names that threshold. |
| principle-fix-root-causes | Ported | Finds the first incorrect transition and permits guards for legitimate states. | The bug-fix playbook now distinguishes legitimate from invalid state and checks persisted state on restart failures. Its real-user reproduction, runtime evidence and same-interface verification remain. |
| principle-make-operations-idempotent | Ported | Derives actions from current state and requires recognizable leftovers at every interruption point. | `poteto-mode/references/autonomous-run.md` applies that guidance to retries and interrupted operations, with repeat and interruption checks. It does not turn intentional optimization iterations into no-ops. |
| principle-migrate-callers-then-delete-legacy-apis | Kept local | Deletes the migration and immediate-removal rules, retaining the contract-test rule and applicability limits. | Keep the coordinated caller migration and deletion in `poteto-mode/references/refactor.md` and OPINIONS. Removing them would weaken the approved simplification policy; no upstream leaf is installed. |
| principle-test-behavior-not-implementation | Ported | Replaces assertion-shape bans with observable contracts that fail on broken behavior and survive internal refactors. | `tdd/SKILL.md` now covers external effects, meaningful absence, error contracts and invariants. Its cheap-test boundary, red-before-green workflow and explicit-only metadata remain. The held OPINIONS summary stays unchanged; no new blanket assertion ban is added. |
| principle-type-system-discipline | Kept local | Removes several detailed rules about impossible states, casts, exhaustiveness and strengthening types. | Keep the concise OPINIONS guidance on illegal states, boundary parsing and avoiding compiler-silencing casts. It already covers the retained upstream boundary advice. The separate project TypeScript refresh remains with job-tracker after order 71. |

No principle edit changes a skill trigger, model route, alias or invocation policy.
The first commit contains only these principle adaptations and their decision record.

## Remaining skills

| Entry | Outcome | Upstream change | Local decision and evidence |
|---|---|---|---|
| correct | Ported | Replaces the return-nothing heuristic with broken-behavior and internal-refactor checks. | Update that sentence in `correct/SKILL.md`. Preserve its automatic correction trigger, architecture-first ordering and rule-enforcement table. |
| interrogate | Ported | Trims the lead-review introduction and verdict calibration, including the five-finding cutoff. | Remove those sections from `interrogate/references/lead-judgment.md`. The parent skill still owns contextual judgment, four finding buckets and dismissal reasons. Its fresh Codex reviewers and routing adapter are unchanged. |
| ketchup | Ported | Lists every waiting decision, includes evidence and risk per item, removes the total word cap and uses visuals to explain changes. | Adapt `ketchup/SKILL.md` while preserving Needs the owner first, authorization deduplication, five lines per unit, identifier privacy, read-only operation and T3 rendering. Keep narrative short without truncating decisions. |
| poteto-mode | Kept local | Normalizes the name and changes three principle summaries. | The name is already `poteto-mode`. Keep its automatic router, all 16 local playbooks, Codex roles and batch 2 precedence. Principle changes belong in bug-fix and TDD, not a second always-loaded principles list. |
| make-bot-ui | Skipped | Only normalizes the frontmatter name to `make-bot-ui`. | No local leaf exists. Keep the existing skip: Cursor/Grok bot webhooks and secret setup do not match the T3 pack workflow. The earlier audit's description of this delta as trimmed guidance was inaccurate. |
| poteto-help | Skipped | Adds formal-verification help, Claude package instructions and updated sharpen/catch-up recipes. | No local leaf exists. The local router and workflow guide own navigation; the package replacement is rejected in batch 2, and formal verification belongs to batches 4 and 5. Record the sharpen/catch-up behavior in the local guide instead of adding a second help router. |
| setup-pstack | Skipped | Adds an optional formal-verification offer. | No local leaf exists. Keep `docs/model-routing.md` as the sole role owner and leave generator adoption to batches 4 and 5. The Claude harness mapping is a separate documentation change, not a change to this skill's delta. |
| sharpen | Ported | Returns an expert-informed rewritten prompt instead of executing the embedded task. | `sharpen/SKILL.md` now names primary material, methods and independent evidence before the rewrite. Preserve user constraints, unresolved choices and explicit-only policies. |
| swarm | Ported | Deletes an introductory summary, worker-count instruction and duplicated aggregate-report sentence. | Remove the duplicated report sentence. Keep the local introduction that states worktree ownership and the distinction between total workers and the lane concurrency limit. Those lines carry local operational constraints. Models, isolation and report requirements stay unchanged. |
| Documentation and package metadata | Kept local | Updates both manifests to 0.15.29, adds Claude installation/adapter instructions, formal-verification guidance, new recipes and prose cleanup. | Keep the 0.15.24 baseline pin and record the selective 0.15.29 refresh in `nix/user.nix` and `docs/workflow-north-star.md`. Do not install or regenerate the upstream package. The held TypeScript refresh and new formal-verification skills retain their separate owners. |

There are 9 ported entries, 4 kept local and 3 deliberate skips across the 16 assigned entries.
"Ported" includes changes adapted to a local workflow and partial adoption with the retained differences recorded above.
No added script, hook, network operation or dependency comes from upstream.
The explicit-only policies and all 28 Codex aliases remain unchanged.

## Documentation comparison

Every changed documentation file was read as a diff against the same frozen revisions.
The documentation/package entry covers these 15 files:

- Both `pstack/plugin.json` and `pstack/.cursor-plugin/plugin.json` change only the version.
  They are not local package manifests, so copying their version would misrepresent this selective refresh.
- `pstack/README.md` adds Claude installation and generated-package instructions, formal-verification skills, sharpen and ketchup descriptions, revised principle summaries, and Cursor-specific mode, PR and automation wording.
  Keep the local installation and routing documentation; adopt the selected behaviors through the entries above.
- `docs/guide/01-setup.md` adds Claude commands, formal-verification offers and a corrected Cursor Custom Mode link.
  Keep declarative local discovery and the separately assigned verification work.
- `docs/guide/02-poteto-mode.md` updates navigation and describes sharpen returning a prompt.
  The local guide records the new sharpen behavior without changing router precedence.
- `docs/guide/03-understand.md`, `04-design.md` and `05-build-and-clean.md` contain prose cleanup without a new local behavior requirement.
  Keep the existing local playbooks.
- `docs/guide/06-verify-and-ship.md` adds bounded formal proof, model drift, surviving cleanup evidence, helper documentation and watcher wording.
  Formal-verification selection and proof remain in batches 4 and 5; existing project verification and T3 watches remain local equivalents.
  The upstream guide's added generator detail does not change that generator's source in this comparison.
- `docs/guide/07-overnight.md` adds catch-up guidance and distinguishes a full swarm review from a fresh verifier after a minor patch.
  Port catch-up behavior; keep the existing bounded local review policy and app-owned orchestration instead of adopting autopilot.
- `docs/guide/08-principles.md` updates premise and test-contract summaries and removes a rhetorical phrase.
  The principle decisions above cover them.
- `docs/guide/09-make-it-yours.md` adds formal-generator navigation and prose cleanup.
  Keep local authoring, correction and verification routes; do not imply the unadopted generators are available.
- `docs/guide/10-recipes-and-pitfalls.md` adds sharpen, formal proof and ketchup examples and simplifies wording.
  Local documentation records the selected recipes; formal proof remains pending.
- `docs/guide/README.md` adds formal proof to its chapter description.
  The local audit remains the adoption index.
- `docs/harness/claude-code.md` adds tool, subagent, path, model and Cursor-only fallback mappings.
  Keep the Codex-first shared adapter instead: the upstream mapping would omit non-Claude models and inherit Claude, overwrite a separate role file, and skip some unavailable steps.
  Batch 2 already rejected direct package replacement.

## Limits and follow-ups

The baseline pin stays at 0.15.24; this is a reviewed set of selected 0.15.29 changes.
The upstream comparison remains frozen and the audit retains all 200 original inventory rows.
The TypeScript project refresh, formal-verification adoption, schedules and external-source blockers remain outside this batch.
No changes to OPINIONS or VOICE are proposed as a prerequisite for these ports.
Fresh invocation evidence and final checks are recorded separately in `batch-3-route-proof.md` and `checks.md`.
Push approval and normal activation were separate from these local commits; both are now done, as the [current rollout status](audit.md#rollout-status) records.
