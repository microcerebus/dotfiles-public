# Audit and batch 1 checks

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
