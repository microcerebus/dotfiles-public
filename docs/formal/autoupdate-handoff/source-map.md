# Source map

The model is [Handoff.tla](Handoff.tla), derived by hand from the batch 4 model (`docs/pstack-audit/batch-4-proof/Handoff.tla`) and its [source map](../../pstack-audit/batch-4-proof/source-map.md).
Line numbers below refer to `scripts/dotfiles-autoupdate` with the switch-lock fix, the locked `rollback`, the root fetch of GitHub's main (26 Oct 2026) and its review fixes (fetch before the lock, in apply and rollback); `verify.py` pins its SHA-256 and checks that each fragment the map relies on occurs exactly once.
The `rebuild` alias in `nix/user.nix` runs `sudo dotfiles-autoupdate rebuild ~/dotfiles && brew upgrade`, and the `rollback` alias runs `sudo dotfiles-autoupdate rollback`.
Both reach darwin-rebuild only through `switch_locked` (lines 871-899).

## Unchanged from batch 4

Sync's actions (`SyncAcquire` to `SyncRelease`), `ExternalFetch`, `ApplyCheckSync`, `ApplyReadTarget` to `ApplyRetry`, `ApplyMark`, `ApplyRecheck`, `ApplyInvoke`, `ApplyComplete` and `ApplyFail` keep their batch 4 meaning and bounds.
Lines added since batch 4 move its sync line numbers down by 29 to 31: the lock directory at batch 4's 132 is at 161, and switch_running's check at 218 is at 250.
Apply's decision moved into `cmd_apply_locked` (lines 484-571) unchanged, apart from reading the system revision through `system_revision`.
Since the root fetch, apply no longer reads a revision the sync agent hands over: see "Root fetch" below.
The properties HandoffIsFetched, ExactSelectedRevision and ProtectLocalRebuild are batch 4's, unweakened.

## Changed or new

| Model action or expression | Source | Abstraction |
| --- | --- | --- |
| `HumanVisible` | 250, 443, 543 (`pgrep -qf darwin-rebuild`) | A human switch, or a `rebuild` or `rollback` waiting in lockf, whose command line names darwin-rebuild. Sync and apply see both. |
| `ApplyCheckHuman`, `SyncCheckHuman` | 443; 250 | As batch 4, with `HumanVisible` in place of a running human only. |
| `ApplyLock` | 478-481 | `lockf -t 0` takes the free lock and runs the rest of apply as one command, or exits 75 and apply stops. With `ApplyLocks` FALSE, apply proceeds without the lock. |
| `ApplyRecheckHuman` | 543 | pgrep again, just before the switch. Off when `Recheck` is FALSE. |
| `ApplyRecheckRunning` | 544-549 | Rereads the running revision; a change since the sample stops apply. Off when `Recheck` is FALSE. |
| `ApplyRelease` | 538 | EXIT trap removes the switching marker. |
| `ApplyUnlock` | 478 | lockf releases the lock when `cmd_apply_locked` exits, after its trap. Every exit inside the locked region passes through it. |
| `HumanRequest` | nix/user.nix `rebuild` and `rollback`; 755-761, 769-864, 871-888 | With `HumanLocks`, `rebuild` or `rollback` waits in lockf (visible to pgrep). Without it, a darwin-rebuild starts at once, as the old alias did. |
| `HumanStart` | 877, 888 | Takes the free lock and starts darwin-rebuild. |
| `HumanGiveUp` | 888-898 | The 30-minute wait ends with exit 75 and no switch. |
| `HumanComplete` | 877, 888 | Installs L or Dirty, then lockf releases the lock. A `rollback` to a generation built from unpushed work is the same action. A `rollback` to a pushed revision is outside ProtectLocalRebuild. Once its switch lands on another revision, and before lockf releases the lock, it records the pushed revision it rolled back from as a failed attempt (`cmd_rollback_locked`, 849-863), unless a fresh record names another revision; a rollback stopped or failed before then records nothing. Apply reads the record at 525. `rollback` fetches GitHub's main before it waits for the lock (788-792), so the record covers a push it rebuilt before the hourly fetch; that fetch only advances root's clone, like `ExternalFetch`, and adds no action. The model's `ApplyRetry` cooldown already lets apply either hold off or switch, so this adds no action. |
| `NoOverlappingSwitch` | 478, 877, 888 | Apply never has a switch in progress while a human switch runs. |
| `PreInvokeRaceSpec` | none | Batch 4's witness: the human changes state only while apply is about to invoke darwin-rebuild, and finishes before it does. |

## Root fetch (26 Oct 2026)

Apply now fetches GitHub's main into root's own clone (`root_fetch`, called at 456, just before the switch lock) and, under the lock, takes the clone's tip as the target (490), instead of the revision file the sync agent wrote.
The lock logic, the recheck and every human action are unchanged, so the model keeps its shape:

| Model action or expression | Source | Abstraction |
| --- | --- | --- |
| `ApplyReadTarget` | 490 (the clone's tip); the fetch at 456 | The target is a pushed commit, now the tip of root's clone of GitHub's main, read under the lock, rather than `g.handoff`. The fetch before the lock, and `rollback`'s, only advance that clone, as `ExternalFetch` advances the ref. The model still draws it from `g.handoff`, the sync's fetch of the same main, which covers every value the root fetch can return. A failed fetch ends the run before the lock and the sample, like `ApplyValidate`'s exit. |
| `ApplyCheckNewer` | none | The "newest pushed wins" step is gone: a pushed revision the owner rebuilt is on main, so the fresh tip equals it or descends from it. The model's step only widens what apply may pick, so the properties still hold for the code. |
| `HandoffIsFetched` | none | Holds trivially: nothing is handed over. Kept so the model stays batch 4's. |


| Constant | Fixed source | Scratch source edit when FALSE |
| --- | --- | --- |
| `HumanLocks` | `switch_locked` runs darwin-rebuild under lockf for `rebuild` and `rollback` (877, 888) | the first attempt (877) runs darwin-rebuild without lockf |
| `ApplyLocks` | apply runs `cmd_apply_locked` under lockf (478) | `"$BASH" "$0" apply-locked` without lockf |
| `Recheck` | lines 543-549 | those lines removed |

`verify.py` applies each edit to a scratch copy, checks it with `bash -n`, and saves the diff; it never runs the scratch copy.

## Bounds and assumptions

The bounds are batch 4's: one sync, one apply, at most one human rebuild and one external ref advance, with 384 initial states.
The lock adds one shared variable and two human states, waiting and given up.
`lockf` is modeled as an atomic test-and-set with release on exit; the stub tests exercise the real `lockf` across processes.
PIDs are accurate and pgrep sees every darwin-rebuild command line.
`switch_locked` first tries the lock without waiting (line 877), and prints its waiting message only when that attempt finds it held.
lockf frees the lock if lockf itself is killed while its child runs, so a broad `pkill -f darwin-rebuild` can free it mid-switch; the model assumes lockf lives as long as its command.
A darwin-rebuild started outside `rebuild` and `rollback` takes no lock; the model covers it only with `HumanLocks` FALSE, where the rollback is still possible.
There is no fairness assumption, so no claim that a waiting rebuild eventually switches; the test suite covers that it does once the daemon's switch ends.
