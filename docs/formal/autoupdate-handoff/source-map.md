# Source map

The model is [Handoff.tla](Handoff.tla), derived by hand from the batch 4 model (`docs/pstack-audit/batch-4-proof/Handoff.tla`) and its [source map](../../pstack-audit/batch-4-proof/source-map.md).
Line numbers below refer to `scripts/dotfiles-autoupdate` with the switch-lock fix and the locked `rollback`; `verify.py` pins its SHA-256 and checks that each fragment the map relies on occurs exactly once.
The `rebuild` alias in `nix/user.nix` runs `sudo dotfiles-autoupdate rebuild ~/dotfiles && brew upgrade`, and the `rollback` alias runs `sudo dotfiles-autoupdate rollback`.
Both reach darwin-rebuild only through `switch_locked` (lines 634-662).

## Unchanged from batch 4

Sync's actions (`SyncAcquire` to `SyncRelease`), `ExternalFetch`, `ApplyCheckSync`, `ApplyReadTarget` to `ApplyRetry`, `ApplyMark`, `ApplyRecheck`, `ApplyInvoke`, `ApplyComplete` and `ApplyFail` keep their batch 4 meaning and bounds.
The fix and the `rollback` entry point added seven lines above cmd_sync, one of them so `rollback` asks git as the user sudo names, so batch 4's sync line numbers move down by 7.
Apply's decision moved into `cmd_apply_locked` (lines 438-525) unchanged, apart from reading the system revision through `system_revision`.
The properties HandoffIsFetched, ExactSelectedRevision and ProtectLocalRebuild are batch 4's, unweakened.

## Changed or new

| Model action or expression | Source | Abstraction |
| --- | --- | --- |
| `HumanVisible` | 229, 422, 496 (`pgrep -qf darwin-rebuild`) | A human switch, or a `rebuild` or `rollback` waiting in lockf, whose command line names darwin-rebuild. Sync and apply see both. |
| `ApplyCheckHuman`, `SyncCheckHuman` | 422; 229 | As batch 4, with `HumanVisible` in place of a running human only. |
| `ApplyLock` | 432-435 | `lockf -t 0` takes the free lock and runs the rest of apply as one command, or exits 75 and apply stops. With `ApplyLocks` FALSE, apply proceeds without the lock. |
| `ApplyRecheckHuman` | 496 | pgrep again, just before the switch. Off when `Recheck` is FALSE. |
| `ApplyRecheckRunning` | 497-502 | Rereads the running revision; a change since the sample stops apply. Off when `Recheck` is FALSE. |
| `ApplyRelease` | 491 | EXIT trap removes the switching marker. |
| `ApplyUnlock` | 432 | lockf releases the lock when `cmd_apply_locked` exits, after its trap. Every exit inside the locked region passes through it. |
| `HumanRequest` | nix/user.nix `rebuild` and `rollback`; 532-538, 546-627, 634-651 | With `HumanLocks`, `rebuild` or `rollback` waits in lockf (visible to pgrep). Without it, a darwin-rebuild starts at once, as the old alias did. |
| `HumanStart` | 640, 651 | Takes the free lock and starts darwin-rebuild. |
| `HumanGiveUp` | 651-661 | The 30-minute wait ends with exit 75 and no switch. |
| `HumanComplete` | 640, 651 | Installs L or Dirty, then lockf releases the lock. A `rollback` to a generation built from unpushed work is the same action. A `rollback` to a pushed revision is outside ProtectLocalRebuild. Once its switch lands on another revision, and before lockf releases the lock, it records the pushed revision it rolled back from as a failed attempt (`cmd_rollback_locked`, 616-626), unless a fresh record names another revision; a rollback stopped or failed before then records nothing. Apply reads the record at 483. The model's `ApplyRetry` cooldown already lets apply either hold off or switch, so this adds no action. |
| `NoOverlappingSwitch` | 432, 640, 651 | Apply never has a switch in progress while a human switch runs. |
| `PreInvokeRaceSpec` | none | Batch 4's witness: the human changes state only while apply is about to invoke darwin-rebuild, and finishes before it does. |

## Constants and mutations

| Constant | Fixed source | Scratch source edit when FALSE |
| --- | --- | --- |
| `HumanLocks` | `switch_locked` runs darwin-rebuild under lockf for `rebuild` and `rollback` (640, 651) | the first attempt (640) runs darwin-rebuild without lockf |
| `ApplyLocks` | apply runs `cmd_apply_locked` under lockf (432) | `"$BASH" "$0" apply-locked` without lockf |
| `Recheck` | lines 496-502 | those lines removed |

`verify.py` applies each edit to a scratch copy, checks it with `bash -n`, and saves the diff; it never runs the scratch copy.

## Bounds and assumptions

The bounds are batch 4's: one sync, one apply, at most one human rebuild and one external ref advance, with 384 initial states.
The lock adds one shared variable and two human states, waiting and given up.
`lockf` is modeled as an atomic test-and-set with release on exit; the stub tests exercise the real `lockf` across processes.
PIDs are accurate and pgrep sees every darwin-rebuild command line.
`switch_locked` first tries the lock without waiting (line 640), and prints its waiting message only when that attempt finds it held.
lockf frees the lock if lockf itself is killed while its child runs, so a broad `pkill -f darwin-rebuild` can free it mid-switch; the model assumes lockf lives as long as its command.
A darwin-rebuild started outside `rebuild` and `rollback` takes no lock; the model covers it only with `HumanLocks` FALSE, where the rollback is still possible.
There is no fairness assumption, so no claim that a waiting rebuild eventually switches; the test suite covers that it does once the daemon's switch ends.
