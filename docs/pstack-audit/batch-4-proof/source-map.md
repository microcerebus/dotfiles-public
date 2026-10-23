# Source map and limits

The reviewed source is scripts/dotfiles-autoupdate as of `d553897cb44f482e8bfd17f760d6e196d766c5b3`, the main commit that last changed it.
Its SHA-256 is `fb5b63e9bfd4ed2580f790f7d55003b7ee12b95e5d21e95debe3fcc8181d2442`.
Line numbers below refer to that version.
The runner checks this hash before it creates scratch variants.
The model was written by reading the shell source; there is no automated extraction.

## Promises checked

`HandoffIsFetched` says a successful handoff rename publishes the exact revision that sync read from origin/main after its successful fetch.
The harm is handing local checkout work to the privileged daemon instead of the fetched ref.
This is the captured ref, not necessarily the latest server commit or the ref at rename time.
Another fetch can update shared refs between the fetch command and rev-parse.

`ExactSelectedRevision` says an apply invocation names the frozen selected revision.
That revision is either the captured handoff or the sampled running revision after both ancestry checks admit it as a newer pushed revision.
This exception permits Home Manager repair at that newer revision.
The harm is activating an unrelated checkout or dirty tree because it changed after the check.
This invariant checks the flake argument, not the actual behavior of Nix or darwin-rebuild.

`ProtectLocalRebuild` says an updater activation never replaces a system currently built from local unpushed or dirty work with a different revision.
It is checked at the modeled activation effect, against the current system, rather than just against apply's earlier sample.
The harm is losing a human's local rebuild to a stale decision.
The current model fails this property when a human rebuild completes after the sample.
This property has not been weakened to require a quiescent human.

## Actions and implementation

| Model action or expression | Source location | Abstraction and interleaving |
| --- | --- | --- |
| `Init`, `Ancestor`, `Protected` | cmd_apply 415-450; flake.nix 64-68 | Fixed commit graph A to B to C, with a separate child L of B. L never becomes pushed in this run. Dirty and Unknown represent configurationRevision suffix/absence. |
| `SyncAcquire` | cmd_sync 132-138 | One successful lock-directory acquisition. No second sync, stale lock, crash or PID reuse. |
| `SyncPid` | cmd_sync 139-140 | Publishing the live PID is separate from acquiring the directory. Apply observes the PID, not the directory. |
| `SyncCheckHuman` | cmd_sync 144-147; switch_running 218 | First checks a human rebuild. A later start remains enabled. |
| `SyncReadDaemon` | switch_running 219-220 | Separately reads the daemon switching marker. |
| `SyncCheckDaemon` | switch_running 221 | A captured marker stops sync only if its owner is still alive. There are no stale/reused PIDs; this does not assert mutual exclusion. |
| `SyncFetch` | cmd_sync 158-165, 181-185 | Offline/fetch failure releases without writing. Success reaches a separate ref read. The remote and refs already contain B or C; network protocols and newly introduced objects are outside the model. |
| `ExternalFetch` | cmd_sync 182; cmd_apply 442; check_flake_lock comment 566-569 | One other worktree fetch can advance the shared ref B to C at any step. No force-push, ref deletion or object pruning. |
| `SyncReadRef` | cmd_sync 182 | Captures origin/main after the successful fetch. This read is separate from fetch and handoff writes. |
| `SyncReadHead` | cmd_sync 187; sync_main 265-267 | Main is the checked-out branch throughout. Separately captures its head. |
| `SyncCheckMain` | sync_main 268-272, 276-285 | Checks the captured head against fetched. Local ahead/divergent notes change no modeled state. Ancestry of literal commits is immutable. |
| `SyncMerge` | sync_main 273-274 | Git fast-forwards only if the current checkout head is still an ancestor. A concurrent checkout change can make it fail. Failure leaves the checkout unchanged; either clean or nonconflicting dirty content can permit success. This command's internal Git locking is abstracted as atomic. |
| `PublishValue`, `SyncWriteTemp` | cmd_sync 191, first command | Write the captured fetched value to a temp file, or fail without publication. |
| `SyncRename`, `SyncRenameFail` | cmd_sync 191, second command | Atomic rename publishes temp, or fails leaving the old handoff. No torn file reads, disk corruption or hostile writers. |
| `SyncRelease` | cmd_sync 140, 196-211 | EXIT removes lock and PID. Daily operations can delay release by arbitrary stuttering; their effects are outside the model. |
| `ApplyCheckHuman` | cmd_apply 411 | One process check before reading the target and system. A later human start remains enabled. |
| `ApplyCheckSync` | cmd_apply 412 | Checks whether sync's PID is live, in a separate step from the human check. |
| `ApplyReadTarget` | cmd_apply 415 | Atomic read of a rename-published file. None and Bad represent absent and invalid values. |
| `ApplyReadRunning` | cmd_apply 416 | Samples the current system revision separately from target, checks and activation. |
| `ApplyValidate` | cmd_apply 418-437, 440 | Empty/invalid handoff and sampled dirty/unknown system stop. Initializes want to target. String parsing is represented by equivalence classes, not verified. |
| `ApplyCheckNewer` | cmd_apply 441, first ancestry check | Checks target ancestry in sampled running commit. Literal commit identities have immutable ancestry. |
| `ApplyCheckOrigin` | cmd_apply 442 | Reads the mutable shared origin/main during the second ancestry query. Stores that observation. |
| `ApplyChoose` | cmd_apply 443 | Selects the sampled running revision when both checks succeeded. The ref may advance afterward. |
| `ApplySame`, `ApplyHM` | cmd_apply 445-447; hm_applied 495-499 | Equal revisions with applied Home Manager stop. A mismatch permits reapplication. Closure traversal and gcroot comparison are one Boolean observation. |
| `AdvanceAllowed`, `ApplyAdvance` | cmd_apply 448-452 | A differing sampled revision must be an ancestor of want. This is a guard on the sample, not on the system at activation time. |
| `ApplyRetry` | cmd_apply 454-458 | Cooldown either stops this attempt or allows it. No clocks or retry loop. |
| `ApplyMark` | cmd_apply 462-463 | Publishes switching marker separately from the last sync check. |
| `ApplyRecheck` | cmd_apply 464 | Checks only sync's live PID. It does not reread running or check a human rebuild again. |
| `RequestedRevision`, `ApplyInvoke` | cmd_apply 470 | The command uses a git flake URL with exact `rev=$want`. Command expansion is separate from its eventual effect. |
| `ApplyComplete`, `ApplyFail` | cmd_apply 470-489 | A successful switch atomically changes the installed revision to the requested one; an early failure leaves it unchanged. Partial activations and post-check error reporting are excluded. |
| `ApplyRelease` | cmd_apply 463 | EXIT removes switching marker. |
| `HumanStart`, `HumanComplete` | cmd_apply 408-411; nix/user.nix 219-222 at d553897; flake.nix 64-68 | One external rebuild starts and later installs L or Dirty. The rebuild alias does not check sync's or apply's marker. An external actor may pause while apply samples state. |
| `Spec` stuttering | no shell statement | Arbitrary finite delays. No fairness assumption and no liveness claim. |

## Bounds and exclusions

There is one sync attempt, one apply attempt, at most one human rebuild, and at most one external ref advance.
The fixed graph has four commits and two protected-system classes, plus an unknown-system class.
Initial origin is B or C; initial handoff is absent, invalid, A or B; initial system is A, B, C, L, Dirty or Unknown.
The checkout initially has HEAD A or L, independently clean or dirty.
Home Manager initially may or may not match.
These choices give 384 initial states.
Different checkout and system revisions are intentional; a running generation need not match the checkout.
An absent handoff can later be populated by sync.

TLC exhausts the finite reachable state graph for the two passing invariants and uses breadth-first search to find a counterexample to the third.
There is no depth cutoff, state constraint, symmetry reduction or fairness assumption.
Deadlock checking is disabled because terminal attempts and stuttering are legal.
State fingerprints are TLC's probabilistic 64-bit hashes; the pass output reports collision estimates.
The result does not quantify over larger commit graphs, repeated attempts or arbitrary implementation schedules.

Processes do not crash, PIDs are accurate, ordinary Git queries succeed, commit objects remain available, and published history only advances.
Status I/O, notifications, daily package updates, public mirroring, retry times and malformed-file parsing are outside the checked claims.
The model includes only main-branch checkout handling and treats the Git merge command's internal operations as atomic.
It separates the shell's head read and ancestry check from that command.
The observed rollback counterexample does not need sync to start, an external fetch, a malformed file, a failed command, or a concurrent checkout change.
The model assumes activation of the exact requested commit succeeds in the demonstrated trace.
It does not prove that Nix, launchd, git, filesystem operations or Home Manager satisfy their abstractions.
This is a bounded model result supported by source inspection, not an end-to-end execution of the real updater.

## Mutation reconciliation

The generated verifier skill directs a source diff review before any model edit.
The runner replays these three manually reviewed pairs; it does not infer them from shell syntax.

| Property | Real-source scratch edit | Reconciled model edit | Reason |
| --- | --- | --- | --- |
| `HandoffIsFetched` | cmd_sync 191 writes `git rev-parse main` instead of fetched | `PublishValue` becomes `g.head` | A checkout with unpushed L can publish L while captured origin is B or C. Dirty checkout content is not part of rev-parse. |
| `ExactSelectedRevision` | cmd_apply 470 uses the checkout flake path instead of the git URL with rev | `RequestedRevision` becomes Dirty when the checkout is dirty, otherwise `g.head` | A path flake resolves checkout content, which may differ from want. The model takes that observation at invocation; delayed resolution is outside this mutation. |
| `ProtectLocalRebuild` | cmd_apply 448 replaces the ancestry rejection condition with `false` | `AdvanceAllowed` becomes TRUE | A sampled unpushed L no longer stops apply. The baseline already fails with a concurrent human; this mutation also admits replacement without any human step. |

For each variant the runner copies the real source, checks that each expected source fragment occurs exactly once, applies the edit, saves a unified diff and applies the reviewed model edit.
It checks shell syntax but never runs the source copy.
It runs TLC with that property's unchanged invariant.
For the local-protection mutation, a diagnostic run leaves `h` idle throughout so the already-known baseline race cannot mask whether the removed guard matters.
The unchanged baseline gets the same diagnostic, in addition to its unrestricted failing run.
The diagnostic narrows the actor set explicitly and is never substituted for the main result.

`PreInvokeRaceSpec` is a second diagnostic that retains the same actions and invariant but selects schedules where the human starts and finishes while apply is about to invoke its command.
It permits no overlap between the modeled human rebuild command and the daemon rebuild command.
Its counterexample demonstrates that unknown command-level serialization cannot by itself rule out this stale-sample schedule.
It does not replace the unrestricted baseline result.
