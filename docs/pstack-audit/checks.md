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
