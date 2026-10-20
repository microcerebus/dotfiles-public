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

Batch 1 landing was confirmed by the orchestrator after the original checks above.
Batch 2 remains local and awaits push approval and activation.
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
