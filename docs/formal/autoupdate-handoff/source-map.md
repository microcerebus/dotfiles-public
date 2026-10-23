# Source map

The model is [Handoff.tla](Handoff.tla), derived by hand from the batch 4 model (`docs/pstack-audit/batch-4-proof/Handoff.tla`) and its [source map](../../pstack-audit/batch-4-proof/source-map.md).
Line numbers below refer to `scripts/dotfiles-autoupdate` with the switch-lock fix; `verify.py` pins its SHA-256 and checks that each fragment the map relies on occurs exactly once.
The `rebuild` alias in `nix/user.nix` runs `sudo dotfiles-autoupdate rebuild ~/dotfiles && brew upgrade`.

## Unchanged from batch 4

Sync's actions (`SyncAcquire` to `SyncRelease`), `ExternalFetch`, `ApplyCheckSync`, `ApplyReadTarget` to `ApplyRetry`, `ApplyMark`, `ApplyRecheck`, `ApplyInvoke`, `ApplyComplete` and `ApplyFail` keep their batch 4 meaning and bounds.
The fix added four lines above cmd_sync, so batch 4's sync line numbers move down by 4.
Apply's decision moved into `cmd_apply_locked` (lines 431-518) unchanged, apart from reading the system revision through `system_revision`.
The properties HandoffIsFetched, ExactSelectedRevision and ProtectLocalRebuild are batch 4's, unweakened.

## Changed or new

| Model action or expression | Source | Abstraction |
| --- | --- | --- |
| `HumanVisible` | 222, 415, 489 (`pgrep -qf darwin-rebuild`) | A human switch, or a `rebuild` waiting in lockf, whose command line names darwin-rebuild. Sync and apply see both. |
| `ApplyCheckHuman`, `SyncCheckHuman` | 415; 222 | As batch 4, with `HumanVisible` in place of a running human only. |
| `ApplyLock` | 425-428 | `lockf -t 0` takes the free lock and runs the rest of apply as one command, or exits 75 and apply stops. With `ApplyLocks` FALSE, apply proceeds without the lock. |
| `ApplyRecheckHuman` | 489 | pgrep again, just before the switch. Off when `Recheck` is FALSE. |
| `ApplyRecheckRunning` | 490-495 | Rereads the running revision; a change since the sample stops apply. Off when `Recheck` is FALSE. |
| `ApplyRelease` | 484 | EXIT trap removes the switching marker. |
| `ApplyUnlock` | 425 | lockf releases the lock when `cmd_apply_locked` exits, after its trap. Every exit inside the locked region passes through it. |
| `HumanRequest` | nix/user.nix `rebuild`; 529-549 | With `HumanLocks`, `rebuild` waits in lockf (visible to pgrep). Without it, a darwin-rebuild starts at once, as the old alias did. |
| `HumanStart` | 538, 549 | Takes the free lock and starts darwin-rebuild. |
| `HumanGiveUp` | 549-559 | The 30-minute wait ends with exit 75 and no switch. |
| `HumanComplete` | 538, 549 | Installs L or Dirty, then lockf releases the lock. |
| `NoOverlappingSwitch` | 425, 538, 549 | Apply never has a switch in progress while a human switch runs. |
| `PreInvokeRaceSpec` | none | Batch 4's witness: the human changes state only while apply is about to invoke darwin-rebuild, and finishes before it does. |

## Constants and mutations

| Constant | Fixed source | Scratch source edit when FALSE |
| --- | --- | --- |
| `HumanLocks` | `rebuild` runs darwin-rebuild under lockf (538, 549) | the first attempt (538) runs darwin-rebuild without lockf |
| `ApplyLocks` | apply runs `cmd_apply_locked` under lockf (425) | `"$BASH" "$0" apply-locked` without lockf |
| `Recheck` | lines 489-495 | those lines removed |

`verify.py` applies each edit to a scratch copy, checks it with `bash -n`, and saves the diff; it never runs the scratch copy.

## Bounds and assumptions

The bounds are batch 4's: one sync, one apply, at most one human rebuild and one external ref advance, with 384 initial states.
The lock adds one shared variable and two human states, waiting and given up.
`lockf` is modeled as an atomic test-and-set with release on exit; the stub tests exercise the real `lockf` across processes.
PIDs are accurate and pgrep sees every darwin-rebuild command line.
`rebuild` first tries the lock without waiting (line 538), and prints its waiting message only when that attempt finds it held.
lockf frees the lock if lockf itself is killed while its child runs, so a broad `pkill -f darwin-rebuild` can free it mid-switch; the model assumes lockf lives as long as its command.
A darwin-rebuild started outside `rebuild` takes no lock; the model covers it only with `HumanLocks` FALSE, where the rollback is still possible.
There is no fairness assumption, so no claim that a waiting rebuild eventually switches; the test suite covers that it does once the daemon's switch ends.
