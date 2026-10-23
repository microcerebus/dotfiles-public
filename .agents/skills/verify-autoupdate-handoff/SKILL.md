---
name: verify-autoupdate-handoff
description: "Rerun the bounded sync/apply handoff checks after changes to dotfiles-autoupdate revision selection, handoff writes, or rebuild protection. The fixed script's check is docs/formal/autoupdate-handoff/verify.py; this batch 4 check is a frozen record of the unfixed revision."
---

# Verify autoupdate handoff

This check models one sync, one apply, one optional human rebuild and one optional shared-ref advance.
Read the [source map and limits](../../../docs/pstack-audit/batch-4-proof/source-map.md) before using its result.
This model describes the source at `d553897cb44f482e8bfd17f760d6e196d766c5b3`.
The generated model is a manual abstraction, not extracted code or complete implementation verification.

The race this check finds is fixed: `apply` and the `rebuild` alias now share a switch lock.
For the current script, run `python3 docs/formal/autoupdate-handoff/verify.py`, which guards the working tree's script hash and expects exit 0; read its README.
This batch 4 check stays a record of `d553897`: it reads the subject at that commit and returns 12 whatever the working tree holds.
The drift commands below therefore guard the current script's check, not this record.
Their sync commit is main at `73de16f`, checked on 23 October 2026.
The switch lock landed in `1929b36`, and the rollback-race work ended at `00f641e`, the last commit to change the script and the source the fixed model's hash pins.
The covered changes after it, bash guard parsing and an alias comment in `nix/user.nix`, were read and change nothing the fixed model describes.

To replay this batch 4 record, from the repository root:

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
An error, timeout or a hash mismatch at the reviewed commit is inconclusive.
The runner returns the restored baseline's TLC exit: 12 for a counterexample, 0 for a pass.
Otherwise it exits 1 with an INCONCLUSIVE reason, for example on a hash mismatch, tool failure or a run without a pass or invariant trace.
Do not interpret successful mutation detection as a passing baseline.

The covered code is [scripts/dotfiles-autoupdate](../../../scripts/dotfiles-autoupdate) and its `nix/autoupdate.nix` wrapper, every line under `nix/` that names the updater, every `darwin-rebuild` caller and `sync` or `apply` invocation in the repository, including the `rebuild` alias, and the `configurationRevision` setting in `flake.nix`.
The commands also report the daemon's `StartCalendarInterval` and `AbandonProcessGroup` settings.
Other launchd fields are source-map assumptions, not covered code.
The sync commit is the last main commit whose covered code was read against the current script's check.
Check for covered changes since it, including uncommitted edits:

```sh
sync=73de16f6e015f9bef9c8c01f561db6aa129f4a87
git diff --stat "$sync" -- scripts/dotfiles-autoupdate nix/autoupdate.nix
git diff --stat -G "darwin-rebuild|configurationRevision|dotfiles-autoupdate[\"']? +(sync|apply)" "$sync" -- . ':!docs' ':!.agents'
git diff --stat -G '[Aa]utoupdate|AUTOUPDATE|StartCalendarInterval|AbandonProcessGroup' "$sync" -- nix
git ls-files -o --exclude-standard -- . ':!docs' ':!.agents'
```

Empty output from all four commands means no covered change that these patterns can see.
They match names, not meaning: a caller that reaches the updater or `darwin-rebuild` through a variable or another spelling needs the maintenance reading step, so these commands do not cover all of the code listed above.
The last command lists untracked files, which the diffs cannot see.
The second command also reports prose and tests that mention `darwin-rebuild`; classify those as no effect in the reading step.
Any output means the fixed check may be stale: rerun `python3 docs/formal/autoupdate-handoff/verify.py` (recorded exit 0) and follow its README.
A rerun of this batch 4 runner says nothing about drift: it reads the subject at `d553897`, only notes that the working tree differs, and returns 12, the result recorded in [verification.exit](../../../docs/pstack-audit/batch-4-proof/verification.exit).
To confirm that a replay of this record still matches, compare its baseline trace with [the recorded one](../../../docs/pstack-audit/batch-4-proof/evidence/baseline/tlc.txt) from the proof directory, ignoring the state-count line:

```sh
trace() { sed -n '/Error: Invariant/,/states generated/p' "$1" | grep -v 'states generated'; }
diff <(trace evidence/baseline/tlc.txt) <(trace "$(ls -td reruns/run-* | head -1)/baseline/tlc.txt")
```
For covered changes made without this skill, read and follow `maintain-formal-verification-skill/SKILL.md` from the user skills directory (`~/.agents/skills` or `~/.claude/skills`); it is explicit-only, so read the file rather than waiting for it to load.

When covered code changes, update the fixed check in `docs/formal/autoupdate-handoff`, not this record.
Compare the diff with every affected row of its [source map](../../../docs/formal/autoupdate-handoff/source-map.md), and review the supporting rebuild alias and configurationRevision setting named there.
Its runner guards the hash of `scripts/dotfiles-autoupdate` against `SOURCE_SHA256`, the source anchors it names and the nixpkgs pin, not those supporting files or semantic correspondence.
Keep reads, guard checks, writes and activation separate where the shell allows interleaving.
Revise the corresponding model actions in its `Handoff.tla` manually, document the reasoning, and update `SOURCE_SHA256` and the sync commit above only after that comparison.
Record a commit that is already on main; a branch commit's SHA changes when the branch is rebased.
So land a source change first, then record its main commit in a follow-up.
The batch 4 runner is never re-pinned: it stays the record of the unfixed script at `d553897`.
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
Confirm that trace against the source at the reviewed commit; the fix for it is already in place, so do not propose another.
