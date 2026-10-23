# Autoupdate handoff proof

Result: **counterexample**.
The bounded model permits apply to replace a human's unpushed rebuild after apply sampled the old system revision.
Source inspection confirms that the running-revision read precedes the final sync-lock check and that apply does not repeat it before invoking the exact-revision switch.
The source and live system were not changed or executed.

Run from the repository root:

```sh
python3 docs/pstack-audit/batch-4-proof/verify.py
```

The command returns the restored baseline's TLC exit status: **12** for the current counterexample, or 0 once a revised source and model pass.
Otherwise it exits 1 with an INCONCLUSIVE reason, for example when the subject at the source commit does not match its reviewed hash, the pinned tools do not resolve or a run ends without a pass or invariant trace.
With the committed source and model it returns 12.
It reads the subject with `git show` at the source commit, never from the working tree, so it still returns 12 after the script is fixed.
That needs the private history: in the public mirror or a shallow clone without the source commit it stops INCONCLUSIVE.
When the working tree's script differs from that commit, it says so and records `working_tree_matches_source` in `reviewed-input.json`.
It preserves the committed evidence and writes subsequent runs under the ignored reruns directory.
It pins nixpkgs itself by revision and NAR hash, with empty user config and overlays, so neither the daily root `flake.lock` update nor local nixpkgs config changes its tools or result.
It realizes the pinned TLC closure before inspecting its Java wrapper, so a fresh store or garbage collection does not prevent the first run.
Nix's fetch log goes to a separate stderr file, so it cannot corrupt the parsed tool resolution.
[check_pinned_toolchain.py](check_pinned_toolchain.py) tests the pin, the stderr split and the source commit record against a fake Nix.
The [generated project skill](../../../.agents/skills/verify-autoupdate-handoff/SKILL.md) owns the rerun and source-change procedure.
The [source map](source-map.md) defines every action, property, mutation mapping and limitation.

## Observed results

The [full summary](evidence/summary.json) records exit codes, hashes and state counts.
Each case directory contains its complete source copy, model, configuration, TLC command, full output and exit status.

| Run | Result | TLC exit | Distinct states |
| --- | --- | --- | ---: |
| [Baseline, all properties](evidence/baseline/tlc.txt) | ProtectLocalRebuild counterexample | 12 | 175,540 |
| [Fetched handoff and exact selected revision](evidence/baseline-handoff-and-exact/tlc.txt) | Both pass within bounds | 0 | 375,282 |
| [Baseline with human disabled, diagnostic only](evidence/baseline-no-human-diagnostic/tlc.txt) | All three pass in this narrower model | 0 | 161,078 |
| [Human finishes before daemon invocation, witness only](evidence/baseline-pre-invoke-witness/tlc.txt) | ProtectLocalRebuild counterexample | 12 | 87,530 |
| [Scratch handoff mutation](evidence/mutation-handoff/tlc.txt) | HandoffIsFetched counterexample | 12 | 86,215 |
| [Scratch flake-argument mutation](evidence/mutation-exact-revision/tlc.txt) | ExactSelectedRevision counterexample | 12 | 102,824 |
| [Scratch ancestry-guard mutation, no human](evidence/mutation-local-protection/tlc.txt) | ProtectLocalRebuild counterexample | 12 | 90,726 |
| [Restored baseline](evidence/baseline-restored/tlc.txt) | Same ProtectLocalRebuild counterexample | 12 | 175,540 |

The two passing properties exhausted 1,214,761 generated states, with no states left on the queue.
The failing runs stopped at a counterexample; their state counts do not describe exhaustive searches.
The narrower diagnostics do not replace the unrestricted failing baseline.

## Counterexample in source terms

The [pre-invocation witness](evidence/baseline-pre-invoke-witness/tlc.txt) has 16 states.
It uses a stale handoff A, an installed system A, and a Home Manager mismatch.
No sync or external fetch needs to run.

1. Apply sees no human rebuild and samples installed revision A, at source lines 411-416.
2. Since target and sampled running revision are A, the Home Manager mismatch permits reapplication, at lines 445-447.
3. Apply passes its retry check, publishes its switching marker and sees no sync PID, at lines 454-464.
4. The human starts and completes a rebuild of unpushed L.
   Witness states 13 and 14 leave apply poised at its invocation.
   The rebuild alias at nix/user.nix line 222 as of d553897 has no check of the updater's marker.
5. Apply invokes its frozen revision A at line 470, then its successful activation replaces L with A.
   Witness states 15 and 16 record `before = L` and `built = A`.

This schedule needs no overlapping darwin-rebuild commands.
The model also admits schedules with overlapping commands; the unrestricted baseline finds one.
The counterexample is source-supported at the shell's decision and command boundaries.
Actual Nix activation and operating-system scheduling remain assumptions, not an executed production reproduction.
A fix is a separate task.

## Mutation evidence

The generator required changes to scratch copies of the real script, followed by manual reconciliation into the model.
The generated skill was read and followed before the runner executed those pairs.

| Property | Source edit and corresponding model edit | Observed trace |
| --- | --- | --- |
| Fetched handoff | [Source diff](evidence/mutation-handoff/source.diff), [model diff](evidence/mutation-handoff/model.diff) | Sync captured B but published local HEAD L. |
| Exact selected revision | [Source diff](evidence/mutation-exact-revision/source.diff), [model diff](evidence/mutation-exact-revision/model.diff) | Apply selected A but requested dirty checkout content. |
| Local rebuild protection | [Source diff](evidence/mutation-local-protection/source.diff), [model diff](evidence/mutation-local-protection/model.diff) | With no human step, apply sampled L and replaced it with A after the ancestry rejection was removed. |

All scratch sources passed `bash -n`.
The runner never executes them.
The ancestry mutation uses the no-human diagnostic so the existing baseline race cannot masquerade as evidence that the mutation matters.
The unchanged source passes the identical no-human diagnostic.
The [restoration record](evidence/restoration.json) confirms that scratch source and model returned byte for byte to baseline before the final run.
The restored scratch source equals the subject at the source commit, byte for byte.

## Bounds and provenance

The run covers one sync, one apply, at most one human rebuild and at most one external shared-ref advance.
It uses the fixed graph A to B to C with a local branch B to L, 384 initial states, absent/invalid handoff classes, dirty/unknown system classes, and either Home Manager state.
There is no depth cutoff, state constraint, symmetry reduction, fairness requirement or liveness claim.
TLC used one worker, seed 1 and fingerprint polynomial 0.

The source commit is `d553897cb44f482e8bfd17f760d6e196d766c5b3`, the main commit that last changed the script.
The committed evidence and the model header name `da07c62`, a pre-rebase batch commit that held the same bytes and never reached main.
The script SHA-256 is `fb5b63e9bfd4ed2580f790f7d55003b7ee12b95e5d21e95debe3fcc8181d2442`.
The runner pins nixpkgs `7a6522c868711d06e3a520bbcdfafe9806f4337f` by revision and NAR hash, imported for aarch64-darwin.
The committed [tool resolution](evidence/tool-resolution.txt) predates that pin and reached the same revision through the root flake.lock; both resolve the same nixpkgs and tlaplus store paths.
The package is tlaplus 1.7.4, whose executable reports TLC 2.19.
Its [wrapper](evidence/tlc-wrapper.txt) selects the pinned Zulu JDK 8.0.492; [Java output](evidence/java-version.txt) confirms runtime 1.8.0_492.
No registry, installation, profile mutation, rebuild, browser, container or push was used.

The model is manual and the mutation mappings are fixed reviewed pairs.
There is no general shell-to-TLA translator.
The automated guard covers the subject script at the source commit, the resolved nixpkgs revision, the package version and the Java runtime; supporting source references need manual review.
Finite graphs, one-attempt bounds, reliable PID observations, monotonic refs, atomic file publication and successful activation semantics limit the result.
Crashes, force-pushes, partial activation, malformed-input parsing, Git internals, Home Manager internals and arbitrary repeated schedules are not verified.
Exact selection includes the source's newer-pushed-running-revision exception and Home Manager repair.
It does not mean every switch always uses the last handoff.

## Generator exercise and audit

The assigned cold-user prompt requested a source-mapped sync/apply model, a generated local skill, pinned TLC runs and real-source mutation evidence.
This run loaded poteto-mode's skill-change playbook, the adapted create-formal-verification-skill, show-me-your-work and unslop.
It then read and used the generated verifier skill.
No other agent or independent cold session ran, because the task explicitly forbade additional agents.

The [default skill check](skill-check-default.txt) and [project-skill check](skill-check-project.txt) both returned 0.
The second command was `python3 -I scripts/check-skills --local .agents/skills`, because the default checker scans the Claude local tree.
It checked the generated skill's frontmatter, license and relative link.
Discovery in a fresh Codex session remains untested.

The [decision log](decisions.tsv) records the syntax failure, abstraction refinements, diagnostic choice and final checks.
The [acceptance audit](acceptance-audit.json) checks saved hashes, exit statuses, restored inputs and local links against the actual artifacts.
The [initial TLC output](initial-tlc.txt) preserves the parser failure.
The [second exploratory run](second-tlc.txt) preserves the first safety counterexample.
The iterations directory retains earlier complete suites before the final separation of sync observations.
Their saved commands record the paths used at execution time, before archival.
These are intermediate evidence; the evidence directory contains the final model and results.
The local Git attributes preserve whitespace in unified diffs and captured TLC wrappers so the evidence remains verbatim.

Attention

No independent reviewer ran inside the proof worker, as required by its no-additional-agents restriction.
This agent checked the current-thread tool record and inspected the final traces and diffs.
The main limitation is manual source-to-model correspondence; the passing results do not establish complete implementation correctness.
The parent batch's checks and review are recorded in [checks.md](../checks.md).

## Runner bootstrap regression

The parent's fresh-context self-review found that `nix eval` returns a package path without realizing it.
The original runner tried to read the TLC wrapper at that path before invoking `nix shell`.
On a fresh store, that would stop the documented command before TLC ran.
The runner now invokes the locked temporary Nix shell first and records its realization command, output and exit status.

`python3 docs/pstack-audit/batch-4-proof/check_bootstrap.py` simulates an absent closure and stubs external commands and model runs.
After correcting the fixture's temporary-root setup, the fixture failed on the original runner and passes on the fix.
It verifies bootstrap ordering, not model correctness.
The parent then reran the real pinned TLC suite and reproduced the same baseline counterexample, bounded passes and mutation failures.
The original evidence remains unchanged; later runs are under the ignored reruns directory.
