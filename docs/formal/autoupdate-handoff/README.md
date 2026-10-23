# Autoupdate rollback race: fix and proof

Result: **fixed within the model's bounds**.
The fixed model passes all four safety properties, and removing either lock brings back the rollback.

## The bug

The batch 4 proof (`docs/pstack-audit/batch-4-proof/README.md`) found that the root daemon could roll back the owner's rebuild of unpushed work.
`dotfiles-autoupdate apply` sampled the running system, decided to switch to the pushed origin/main, and then switched without looking at the system again.
A `rebuild` of unpushed commit L that finished in between was replaced by the older pushed revision.
Nothing serialized the two: the `rebuild` alias ran `sudo darwin-rebuild switch` directly, and darwin-rebuild takes no lock of its own.

## The fix

One switch lock, `/var/db/dotfiles-autoupdate/switch.lock`, held through macOS's `lockf`, which releases it when the holder exits, crash included.

- `apply` makes its whole decision and switch as one command under the lock (`cmd_apply` runs `cmd_apply_locked` through `lockf -t 0`).
  If the lock is held, a rebuild is in flight, and the next hourly tick decides again.
  Fetching stays with the sync agent and never holds the lock.
- `rebuild` now runs `sudo dotfiles-autoupdate rebuild ~/dotfiles`, which runs darwin-rebuild switch under the same lock.
  It switches at once if the lock is free; if the daemon is switching, it prints that it is waiting for the hourly auto-update to finish, with the daemon's pid and log, and waits up to 30 minutes.
  It then switches, so the owner's switch lands last.
  If the lock is held by something else (an auto-update still deciding, or a rebuild in another terminal), the message says that instead.
  If the lock is still held after 30 minutes, it stops with exit 75, says nothing was rebuilt, points to the log and `dotfiles-autoupdate status`, and names the `pkill` that stops a stuck auto-update switch (its activation may still be finishing); `brew upgrade` does not run.
- `rollback` runs `sudo dotfiles-autoupdate rollback`, which runs `darwin-rebuild --rollback` (or `--switch-generation <n>`) through the same `switch_locked` code as `rebuild`, with the same wait and messages.
  A rollback to a generation built from unpushed work stays, as a rebuild of it would.
  A rollback to a pushed revision lasts until the next hourly apply, which switches forward to origin/main; `rollback` says so and points to pushing a revert.
- Just before invoking darwin-rebuild, `apply` checks again for a darwin-rebuild process and for a running revision that differs from its sample.
  This only catches a darwin-rebuild run outside `rebuild` and `rollback` that finished before that check; the lock is what closes the race.

Apply still switches only to the exact handed-over revision (`git+file://...?rev=`), never the working tree.

## Model results

`python3 docs/formal/autoupdate-handoff/verify.py` from the repository root returns 0 when every case below gives its expected result.
It uses the batch 4 pin of nixpkgs, so TLC is tlaplus 1.7.4 (TLC 2.19) in both proofs.
The committed run is in [evidence](evidence/summary.json); later runs go to the ignored `reruns/` directory.

| Case | Expected and observed | Distinct states |
| --- | --- | ---: |
| Fixed, all four properties | pass | 713,411 |
| Fixed, human finishes just before apply's switch | pass | 203,890 |
| `rebuild` without the lock (the old alias) | ProtectLocalRebuild counterexample | 271,512 |
| Same, human finishes just before apply's switch | ProtectLocalRebuild counterexample, 19 states | 132,468 |
| `apply` without the lock | ProtectLocalRebuild counterexample | 539,025 |
| Without the pre-switch recheck | pass (diagnostic) | 705,547 |
| Unfixed batch 4 model | ProtectLocalRebuild counterexample | 175,540 |
| Reachability: apply switches; rebuild waits through apply's switch; human switch lands after apply's | each probe violated, as expected | up to 539,026 |

The four properties are batch 4's HandoffIsFetched, ExactSelectedRevision and ProtectLocalRebuild, plus NoOverlappingSwitch: apply never switches while a human switch runs.
The witness without the human lock shows apply passing its recheck at state 14, the human switch starting and finishing at states 16 and 17, and apply then replacing it.
The recheck narrows the window but cannot close it; both locks are needed, and the lock alone is enough in the model.
Each mutation removes one part of the fix from a scratch copy of the real source, checks it with `bash -n` and records the diff under `evidence/scratch/`, and sets the matching model constant.

## Tests against the real script

`tests/autoupdate_test.sh` case 31 runs the real script with stub darwin-rebuild, git, sudo and clock and the real `lockf`, without sudo or a real activation.

- "a human switch that lands after apply's decision is not rolled back": the sudo stub finishes a darwin-rebuild switch to unpushed L, outside `rebuild`, while apply asks git about its decision.
  This is the batch 4 witness against the real script: it fails on 817f7a9 (the system ends at the pushed revision) and passes with the fix.
  It exercises the recheck, not the lock, because that switch takes no lock.
- The lock itself: "rebuild says it waits for the auto-update switch", "rebuild waits, without switching, while the daemon switches" and "rebuild switches after the daemon's switch, and its switch stays" hold a daemon switch open and check that `rebuild` prints its message, waits, then switches last.
  "apply does not wait for a rebuild's lock" and "apply skips while a rebuild holds the switch lock" hold a `rebuild` switch open and check that apply skips at once.
- "rebuild gives up when the switch lock stays held", "and says what to do" and "a lock held by no auto-update is not blamed on it": the 30-minute limit, set to 3 seconds in the test.

Case 32 holds `rollback` to the same checks: "rollback waits, without switching, while the daemon switches", "rollback lands after the daemon's switch" and "rollback gives up when the switch lock stays held".
Every case 32 check fails on cb9c321, which had no `rollback` and left only a bare `darwin-rebuild --rollback`.
Its last checks pin what the hourly apply does after a rollback: from a pushed revision, the rollback records that revision as a failed attempt before it switches, so apply holds off switching back to it for a day; a generation built from unpushed work stays with the waiting-for-push note.
They run `rollback` as the alias does, with `SUDO_USER` set and no `AUTOUPDATE_USER`, against a sudo stub that refuses any user but the repo's owner.
A failed rollback puts back the record that was there, and a fresh record of a failed daemon switch stays, so apply does not retry that revision at once.

On 817f7a9 every check in case 31 fails except the race probe's own setup check, "the race probe switches the system after apply sampled it".
The whole suite passes with the fix.

## Bounds and what was not exercised

The model keeps batch 4's bounds: one sync, one apply, at most one human rebuild and one external ref advance, the fixed commit graph A to B to C with local L, and 384 initial states (see [source-map.md](source-map.md)).
The human may wait, give up, or switch; there is no fairness or liveness claim, so the model does not show that a waiting rebuild eventually runs.
A darwin-rebuild run outside `rebuild` and `rollback` (including `setup/mac.sh`'s first install) takes no lock and is protected only by the recheck's narrower window.
Claude agents cannot start one: `files/.claude/hooks/bash_guard.py` refuses a bare darwin-rebuild switch, activation or rollback and names the locked commands.
The lock relies on `lockf` and BSD `flock` semantics, which the tests exercise with real processes; activation, Nix and launchd behaviour remain assumptions.
Nothing here ran a real darwin-rebuild, sudo, launchctl or activation.
The fix goes live only after a push and the owner's `rebuild`; until the new alias is in his shell, `rebuild` still runs darwin-rebuild directly.

## Rerunning

`verify.py` checks the SHA-256 of `scripts/dotfiles-autoupdate` and the source fragments the source map names.
After a change to the script, review the source map and model against it, update both, then update `SOURCE_SHA256`.
The batch 4 `verify.py` still models the unfixed script: it reads its subject at d553897 and returns 12, the unfixed counterexample, so it does not check this script.
