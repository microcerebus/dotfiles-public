---
name: verify-autoupdate-handoff
description: "Rerun the bounded sync/apply handoff check after changes to dotfiles-autoupdate revision selection, handoff writes, or rebuild protection."
---

# Verify autoupdate handoff

This check models one sync, one apply, one optional human rebuild and one optional shared-ref advance.
Read the [source map and limits](../../../docs/pstack-audit/batch-4-proof/source-map.md) before using its result.
The last source commit reviewed is `d553897cb44f482e8bfd17f760d6e196d766c5b3`.
The generated model is a manual abstraction, not extracted code or complete implementation verification.

From the repository root, use this one rerun command:

```sh
python3 docs/pstack-audit/batch-4-proof/verify.py
```

It pins nixpkgs by revision and NAR hash in the runner, never the registry or the root flake.lock, and changes no profile.
The pin is `7a6522c868711d06e3a520bbcdfafe9806f4337f`, package `tlaplus` 1.7.4, TLC 2.19, with Zulu JDK 8.0.492 on aarch64-darwin.
It saves full TLC output, configurations, source/model diffs and exit statuses under the proof directory.
It never executes the subject script or an activation command.

Read the baseline result before the mutation results.
TLC exit 0 means the named invariants passed within the documented finite model.
TLC exit 12 with an invariant trace is a counterexample, including when the current source already fails.
An error, timeout or source-drift refusal is inconclusive.
The runner returns the restored baseline's TLC exit: 12 for a counterexample, 0 for a pass.
Otherwise it exits 1 with an INCONCLUSIVE reason, for example on drift, tool failure or a run without a pass or invariant trace.
Do not interpret successful mutation detection as a passing baseline.

When source changes, compare its diff with the recorded source snapshot and every affected source-map row.
Also review the supporting rebuild alias and configurationRevision setting named in the source map.
The runner's drift guard checks the subject script and the nixpkgs pin, not those supporting files or semantic correspondence.
Keep reads, guard checks, writes and activation separate where the shell allows interleaving.
Revise the corresponding model actions manually, document the reasoning and update the reviewed source hash and commit only after that comparison.
Record a commit that is already on main; a branch commit's SHA changes when the branch is rebased.
So land a source change first, then record its main commit in a follow-up.
Never add a guard or remove an actor just to eliminate a reachable trace.
If an abstraction was wrong, preserve the failing output and explain the correction.

For each safety invariant, copy the real script into a scratch evidence directory and make a targeted source edit that breaks it.
Identify the action changed by that edit using the source map, then make the corresponding semantic model edit.
The runner encodes three such reviewed pairs in its mutation definitions.
These fixed pairs are examples and replayable evidence, not a general source-to-model translator.
Keep both diffs, run the mutated model with that invariant, and require a semantic trace rather than a source-drift warning.
Restore the baseline source and model copies byte for byte, then rerun all invariants.
Do not mutate the real subject.

Report pass, counterexample or no-verifier with the bounds, source revision, trace interpretation and exclusions.
The initial check expects a counterexample to protection of a human rebuild that completes after apply sampled the running revision.
Confirm that trace against the source before proposing a separate fix.
