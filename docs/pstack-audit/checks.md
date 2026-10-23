# Audit and rollout checks

- `python3 -I scripts/check-skills`: all skills pass, including the repository-local verifier.
- `python3 -I tests/check_skills_test.py`: 20 tests pass.
- `python3 -I tests/check_plan_test.py`: 14 tests pass.
- `node --test tests/chrome_devtools_axi_test.cjs tests/codex_browser_fallback_test.cjs tests/axi_session_start_test.cjs`: 35 tests pass, with no live browser driving.
- `python3 docs/pstack-audit/render.py --check`: 200 unique items, all 56 current skills, all 23 playbooks, every changed upstream skill and both rendered outputs pass.
- T3 document renderer at 390 px and 728 px: inspected both images, no page overflow or console errors.
- Renderer assertions: status filter, combined group/status filter, case-insensitive search, empty state and reset pass at both widths.
- Tailnet HTTP check: 200, with the expected title and all 200 data rows in the returned page.
- Changed Markdown link check: 13 local targets and referenced heading anchors resolve.
- `bash tests/pre_push_test.sh`: all 68 scratch-repository checks pass, including the skill checker and mirror fixtures.
- `nix flake check --no-build`: the Darwin configuration evaluates successfully; no build or activation runs.
- Home Manager evaluation: all 27 proposed Codex skill aliases match the intended set.
- Fresh Codex sessions: discovery, router invocation and explicit-only catalog behavior pass, as described in [the discovery proof](codex-discovery-proof.md).
- Exact preference check: OPINIONS differs only by the approved five-sentence replacement; the adjacent list and VOICE are unchanged.
- Independent Astra High review, Fast off: no actionable findings; it separately confirmed the preference diff, 27 aliases, 18 explicit-only policies and scratch-proof limits.
- `git diff HEAD --check`: clean.

The repository has no separate general Markdown or documentation lint command.
The audit checker, local-link check and render checks cover these document changes.
This is not a physical-phone test or a live execution of every audited skill.
Batch 1 changes routing instructions, skill discovery declarations, invocation metadata and its checker.
Browser quota mechanics remain unchanged, and no live rollout occurred.

## Batch 2 checks

- `python3 -I scripts/check-skills`: all skills pass, including grilling's new explicit-only Codex metadata.
- `python3 -I tests/check_skills_test.py`: 20 tests pass.
- `python3 -I tests/check_plan_test.py`: 14 tests pass.
- `node --test tests/chrome_devtools_axi_test.cjs tests/codex_browser_fallback_test.cjs tests/axi_session_start_test.cjs tests/agent_chrome_session_test.cjs tests/agent_chrome_gate_test.cjs tests/agent_chrome_replay_test.cjs`: 76 tests pass.
  These use stubs and a throwaway replay browser, not the agent Chrome.
- `bash tests/claude_fallback_test.sh`: 30 shell assertions and 22 Python tests pass.
  No live watcher or provider switch ran.
- `bash tests/pre_push_test.sh`: all 68 scratch-repository assertions pass.
  The first attempt failed because its tracked-file export omitted the new untracked playbooks and invocation metadata.
  Including those files in the index resolved the fixture failure without changing the tests.
- `nix flake check --no-build`: Darwin evaluation passes, with no build or activation.
- Home Manager evaluation matches all 28 declared Codex aliases, including grilling.
- Three fresh Astra High sessions load the final router, their matched playbook and their leaf skill.
  [The route proof](batch-2-route-proof.md) includes exact prompts, observed behavior and the corrected initial goal-trigger miss.
- `python3 docs/pstack-audit/render.py --check`: all 200 rows and both generated outputs agree.
- Changed Markdown/HTML link check: 12 local links and heading anchors resolve; no em dash in the changed documents.
- T3 document preview at 390 px and 728 px: both screenshots inspected; no horizontal overflow or console errors.
  Status, combined group/search filtering, case-insensitive search, empty-state and reset assertions pass at both widths.
- The existing tailnet pack returns HTTP 200, contains all 200 rows and the new batch 2 state.
  Its JSON, route proof, source evidence and ownership record return HTTP 200 with exact local content.
  The pack link now points to this worktree's audit directory.

At the original batch 2 check boundary on 20 October 2026, the orchestrator had confirmed batch 1 landing and batch 2 still awaited push approval and activation.
The [current rollout status](audit.md#rollout-status) records subsequent push verification and the outstanding rebuild confirmation.
The package comparison and external-source findings are in [the source evidence](batch-2-sources.md).

## Batch 2 independent review

One fresh-context Codex Astra High review, with Fast off, found no actionable findings in the final staged diff against batch 1.
It verified route precedence, explicit-only policies, all 28 canonical aliases, final transcript reads and outcomes, the frozen upstream comparison, and audit/ownership consistency.
It independently reran check-skills, the audit renderer check and staged whitespace checks.
It also read the supplied test logs and confirmed the reported counts, including the 68 pre-push assertions.
No re-review was needed.

The reviewer did not independently repeat the external publication searches, tailnet check or document previews.
The ordinary-review exclusion and multi-turn interview behavior remain unexecuted scenarios.
Neither this review nor the scratch sessions claim live activation, current account notice delivery or a full package security audit.

## Batch 3 checks

- A fresh GitHub comparison matched all 35 changed pstack file blobs to the frozen 0.15.29 source used for the delta review.
- `python3 -I scripts/check-skills`: all skills pass, including the repository-local verifier.
- `python3 -I tests/check_skills_test.py`: 20 tests pass.
- `python3 -I tests/check_plan_test.py`: 14 tests pass.
- `node --test tests/chrome_devtools_axi_test.cjs tests/codex_browser_fallback_test.cjs tests/axi_session_start_test.cjs tests/agent_chrome_session_test.cjs tests/agent_chrome_gate_test.cjs tests/agent_chrome_replay_test.cjs`: 76 tests pass.
  These use stubs and a throwaway replay browser; no agent Chrome session ran.
- `bash tests/claude_fallback_test.sh`: 30 shell assertions and 22 Python tests pass.
  The watcher stays disabled and no provider switch ran.
- `bash tests/pre_push_test.sh`: all 68 scratch-repository assertions pass.
- `nix flake check --no-build`: Darwin evaluation passes without a build or activation.
- Two fresh Astra High sessions, Fast off: the automatic catch-up route lists all eight waiting decisions; explicit sharpen returns a rewritten prompt without performing the task.
  [Exact prompts and transcript limits](batch-3-route-proof.md) include the extra writing-skill reads and unproven risk ordering.
- `python3 docs/pstack-audit/render.py --check`: all 200 rows, 56 current skills, 23 playbooks, 16 batch 3 outcomes and 42 original ownership rows agree.
  Markdown, HTML and ownership are now generated from the same inventory; the checker rejects stale outputs.
- Original inventory order, unrelated audit rows, held preferences, router precedence, 28 aliases and explicit-only metadata are preserved.
- T3 document previews at 390 px and 728 px: both screenshots inspected, with no horizontal overflow or console errors.
  Filters show 17 upstream entries, only the held TypeScript entry still pending, three deliberate skips and thirteen reviewed local entries.
  Combined filtering, case-insensitive search, empty state and reset pass at both widths.
- Local Markdown link and whitespace checks pass.

These results prove the local artifacts and two bounded invocation cases.
They do not claim live skill activation, a physical-phone test, every edited workflow running end to end, or upstream package installation.

## Batch 3 independent review

One fresh-context Codex Astra High reviewer, with Fast off, found no actionable findings in the full batch 3 diff against batch 2.
It verified all 16 outcomes, all 35 upstream blobs and comparison patches, the saved pre-edit local adaptations, final skill text in both invocation transcripts, and the inventory and ownership records.
It independently passed the skill checker, renderer consistency check, full-diff whitespace check and local Markdown link checks.
No re-review was needed.

The reviewer assessed the broader test results from their logs.
It did not rerun the agent invocations, T3 previews, browser fixtures or live activation.
The second commit and the authorized pack repoint and HTTP verification follow this review boundary.
The initial second commit added only this review record after the reviewed implementation.
The later factual rollout correction below does not change skills or their review outcomes.

## Rollout copy correction

On 21 October 2026, the orchestrator confirmed that batch 2 was approved, pushed and independently verified at `2e8783a`, with the main checkout fast-forwarded there.
One rebuild covering batches 1 and 2 is requested but not confirmed.
The served page still described batch 2 as local and awaiting push approval; reading that page reproduced both stale statements.
Current rollout prose now comes from `audit.json`, and current route and ownership entries identify only activation confirmation as outstanding.
Dated proof-boundary descriptions remain historical and link to current status.
The targeted copy check failed before the correction and passes afterward, alongside renderer consistency and whitespace checks.
Regenerated T3 previews at 390 px and 728 px pass the current-copy, row-count and overflow checks; both screenshots were inspected.
This factual correction does not start another review round or authorize pushing batch 3.

## Batch 4 checks

- `python3 -I scripts/check-skills` passes the global skill tree and existing repository-local verifier.
- `python3 -I scripts/check-skills --local .agents/skills` passes the generated project verifier.
  The system skill-creator's generic validator rejects the established Claude `disable-model-invocation` field.
  The repository checker validates that field and Codex's separate explicit-only policy; the generic validator was not changed.
- `python3 -I tests/check_skills_test.py`: 20 tests pass.
- `python3 -I tests/check_plan_test.py`: 14 tests pass.
- The six browser/fallback fixture files listed in the batch 3 checks pass all 76 tests.
  They use stubs and a throwaway replay browser; no agent Chrome session ran.
- `bash tests/claude_fallback_test.sh`: 30 shell assertions and 22 Python tests pass.
  No live watcher or provider switch ran.
- `bash tests/pre_push_test.sh`: 68 assertions pass, including a repeat after staging the integrated proof and audit.
- `nix flake check --no-build`: Darwin evaluation passes without a system build or activation.
  Nix evaluation confirms 29 Codex aliases, including the new formal generator.
- `python3 docs/pstack-audit/batch-4-proof/verify.py`: the parent rerun returns 12, reproducing the baseline rollback counterexample, both bounded passes and all three intended mutation failures.
  The [proof report](batch-4-proof/README.md) records exact counts, bounds, output and limitations.
- A fresh read-only Astra High session follows poteto-mode's formal route and returns no-verifier for the README heading requirement.
  The original ordinary check passes and both in-memory broken variants fail.
  [The invocation record](batch-4-route-proof.md) states the prompt, observed reads and limits.
- `python3 docs/pstack-audit/render.py --check`: all 200 rows and three generated outputs agree.
  It checks the batch 4 selection and keeps maintenance pending.
- T3 document previews at 390 px and 728 px: both images inspected; no horizontal overflow or console errors.
  The generator is adapted, maintenance is pending, and combined filters, case-insensitive search, empty state and reset pass.
- All 36 local Markdown links in the new batch reports and generated skill resolve.
  Full-diff whitespace checks pass with the proof's narrow attributes preserving raw captured evidence.
- Fresh-context Astra High self-review found a first-run bootstrap defect: the runner read the TLC wrapper before realizing its closure.
  The runner now realizes the pinned temporary shell first.
  `python3 docs/pstack-audit/batch-4-proof/check_bootstrap.py` fails on the old runner and passes on the fix.
  A second parent run of the real pinned TLC suite returns 12 with the same model results.

The updater source, preferences and live skill links are unchanged.
The bounded counterexample is supported by source inspection; it is not an executed Nix activation or a complete proof of implementation behavior.
The maintenance skill, updater fix and live rollout remain separate work.

## Batch 4 independent review

One fresh-context Codex Astra High review, with Fast off, found no actionable findings or blockers in the complete batch 4 diff.
No re-review was needed.
The reviewer confirmed the pinned verifier and runtime, explicit-only policies, route evidence, maintenance deferral and source/model correspondence.
It checked hashes, configurations, mutation diffs, exit codes and state counts across the final suite, historical iterations and parent reruns.
It independently reproduced the missing-closure regression against the old runner and confirmed that the fix passes.
Both skill checks, renderer consistency and full-diff whitespace checks also passed independently.

The reviewer did not rerun TLC, the broader fixture suites, Nix evaluation, document previews or live activation.
It inspected their saved evidence.
It checked the child decision log against artifacts and the parent decision trail against the named current-session transcript and heading transcript.
It reported no trail flags.
The entire run used Codex; independent contexts do not constitute cross-provider evidence.

This review covers the implementation, proof and audit before this review record and the final local commit.
The authorized pack repoint and HTTP check follow that commit.

## Batch 4 pre-push fix

Rebasing batch 4 onto two daily flake updates made `verify.py` inconclusive: it read its nixpkgs pin from the root `flake.lock`, which the daily update moves.
The runner now pins nixpkgs `7a6522c` itself by revision and NAR hash and resolves the same nixpkgs and tlaplus store paths.
It also keeps Nix's stderr out of the parsed tool resolution: on a store without the pinned source, a "copying path" line had broken the JSON parse.
`SOURCE_COMMIT` now names `d553897`, the main commit that last changed the subject with the reviewed bytes, instead of a pre-rebase batch commit.

- `python3 -I docs/pstack-audit/batch-4-proof/check_pinned_toolchain.py`: three tests pass against the fixed runner and all three fail against the pre-fix runner.
  `test_root_lock_bump_does_not_change_tool_pin` stopped on the root-lock check, `test_nix_stderr_stays_out_of_resolution_json` failed to decode JSON, and `test_source_commit_holds_reviewed_source_on_main` found `da07c62` was not on origin/main.
- `python3 docs/pstack-audit/batch-4-proof/check_bootstrap.py` passes.
- `python3 docs/pstack-audit/batch-4-proof/verify.py` on the rebased tree, with the root lock at a newer nixpkgs, returns 12.
  All eight case results, exit codes, generated and distinct state counts, and source and model hashes match the committed evidence.
- The other batch 4 checks above pass again on the fixed tree.

## Batch 5 checks

- `python3 -I scripts/check-skills` passes the global tree, including the new explicit-only maintenance skill.
- `python3 -I scripts/check-skills --local .agents/skills` passes the updated project verifier and its new relative links.
- `python3 -I tests/check_skills_test.py`: 20 tests pass.
- `python3 -I tests/check_plan_test.py`: 14 tests pass.
- The six browser/fallback fixture files pass all 76 tests, with stubs and a throwaway replay browser; no agent Chrome session ran.
- `bash tests/claude_fallback_test.sh`: 30 shell assertions and 22 Python tests pass.
  No live watcher or provider switch ran.
- `bash tests/pre_push_test.sh`: 68 assertions pass.
- `nix flake check --no-build`: Darwin evaluation passes without a build or activation.
  Nix evaluation lists 30 Codex aliases, including both formal skills.
- `python3 docs/pstack-audit/batch-4-proof/verify.py` returns 12; all eight case results, exit codes and state counts match the committed summary.
- `check_bootstrap.py` passes, and `check_pinned_toolchain.py` passes its three tests.
- `python3 docs/pstack-audit/render.py --check`: all 200 rows and three generated outputs agree; it requires the batch 5 outcome and evidence.
- The fresh-context drift exercise is recorded in [the batch 5 delta](batch-5-delta.md#drift-exercise).

## Batch 5 self-review

A fresh-context Claude Opus 5.5 High review of the two commits found no blockers and eight smaller problems; all eight are fixed.
The drift check now searches the whole repository, outside docs and project skills, for `darwin-rebuild` and `configurationRevision`, which now includes `setup/mac.sh`'s rebuild, and searches `nix/` for updater invokers such as the daemon.
It no longer flags every `flake.nix` edit.
The maintenance skill does the reading step before calling a check in sync when a drift command is narrower than the repository.
Its edit scope includes source maps and proof notes, and any reproduction stays within the pinned tools without running the subject.
The project skill gives the trace comparison command, poteto-mode's leaf replies with maintenance's report, and the batch 4 line citations name `d553897`.
The widened drift commands are quiet on the unchanged tree, and the trace comparison returns 0 against the latest rerun.

## Batch 5 independent review

A fresh-context Claude Opus 5.5 xhigh review of the full diff, during the Codex usage limit, found one blocker and seven smaller problems.
The blocker: the project skill claimed the updater's `nix/` invokers as covered, but edits to the sync agent's arguments, the `autoupdate-now` alias, the daemon's schedule or a new caller outside `nix/` left every drift command empty.
The drift check now diffs the updater and its wrapper in full, searches `nix/` for lines naming the updater, and searches the repository for `darwin-rebuild`, `configurationRevision` and `dotfiles-autoupdate sync|apply`.
A fourth command lists untracked files, which Git diffs cannot see.
Launchd schedule fields that do not name the updater are stated as source-map assumptions that need the reading step, not covered code.
The maintenance skill takes the in-sync shortcut only when the verify skill says its drift command covers all of its covered code.

The smaller fixes list every departure from upstream in the delta, make reproductions source traces only, correct the friction count, say which drift check the exercise ran, and split a two-sentence rendered line.

In a scratch worktree, the four commands stay quiet on the unchanged tree and report each of these one-line edits: the sync agent's arguments, the `autoupdate-now` alias, an untracked script calling `darwin-rebuild`, the `rebuild` alias and the updater script.
A single re-review confirmed the blocker fixed and found the same class of gap: a quoted `"$root/scripts/dotfiles-autoupdate" apply` caller and an upper-case `AUTOUPDATE_USER` setting slipped past the patterns.
The reviewer's tested patterns are applied, the daemon's `AbandonProcessGroup` and `StartCalendarInterval` are now reported, and the project skill no longer claims its commands cover everything, so maintenance always does its reading step.
These last changes were not reviewed again, per the one re-review limit.
The reviewer independently confirmed the upstream and license hashes, Git 2.56.0 and Python 3.14.8 store paths from the root `flake.lock` nixpkgs, the runner's TLC pin, explicit-only metadata, the untouched alias line and updater, and that no skill text invites unpinned tools.
