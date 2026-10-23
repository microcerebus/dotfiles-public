#!/usr/bin/env python3
"""Check the switch-lock fix for the autoupdate rollback race with pinned TLC.

Runs the fixed model, three reviewed source/model mutations that each remove
one part of the fix, and the unfixed batch 4 model. Never executes
dotfiles-autoupdate: only Nix's pinned TLC and bash syntax checks run.
Exits 0 when every case gives its expected result, 1 otherwise.
"""

import difflib
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SOURCE = ROOT / "scripts/dotfiles-autoupdate"
# The reviewed fixed source. A change to the script stops the run until the
# source map and model are reviewed against it (README.md, "Rerunning").
SOURCE_SHA256 = "ea6ce6a02394c247dee38c982109e03cd1feb8ca8515fbb5753af5967b434c96"
UNFIXED_MODEL = ROOT / "docs/pstack-audit/batch-4-proof/Handoff.tla"
# Same pin as the batch 4 runner, so both results come from one TLC.
NIXPKGS = "7a6522c868711d06e3a520bbcdfafe9806f4337f"
NIXPKGS_NAR_HASH = "sha256-mN15cwddbOOIzzXSSwYUeRfOYeizz47Vy6y3Hzq6DuY="
PREFIX = ('let n = builtins.fetchTree { type = "github"; owner = "NixOS"; repo = "nixpkgs"; '
          f'rev = "{NIXPKGS}"; narHash = "{NIXPKGS_NAR_HASH}"; }}; '
          "p = import n { system = builtins.currentSystem; config = {}; overlays = []; }; in ")
NIX_SHELL = ["nix", "shell", "--impure", "--expr", PREFIX + "p.tlaplus", "--command"]
ALL = ["HandoffIsFetched", "ExactSelectedRevision", "ProtectLocalRebuild", "NoOverlappingSwitch"]
FIXED = {"HumanLocks": "TRUE", "ApplyLocks": "TRUE", "Recheck": "TRUE"}

# Source fragments the source map relies on; each must occur exactly once.
ANCHORS = [
    'lockf -k -t 0 "$switch_lock" "$BASH" "$0" apply-locked',
    '[ "$code" = 75 ] || return "$code"\n  log "the switch lock is held',
    'running=$(system_revision)\n\n  if [ -z "$target" ]',
    'echo $$ >"$daemon_dir/switching"',
    '  pgrep -qf darwin-rebuild && return 0\n  local now_running',
    'if [ "$now_running" != "$running" ]; then',
    'darwin-rebuild switch --flake "git+file://$repo?rev=$want#$host"',
    'lockf -k -t 0 "$switch_lock" darwin-rebuild switch --flake "$@"',
    'lockf -k -t "$rebuild_wait" "$switch_lock" darwin-rebuild switch --flake "$@"',
]

# Each pair removes one part of the fix from a scratch copy of the source and
# makes the reviewed corresponding change to the model, here a constant.
MUTATIONS = [
    {
        "name": "mutation-rebuild-no-lock",
        "source_old": 'lockf -k -t 0 "$switch_lock" darwin-rebuild switch --flake "$@"',
        "source_new": 'darwin-rebuild switch --flake "$@"',
        "constants": {"HumanLocks": "FALSE"},
        "mapping": "cmd_rebuild lockf -> HumanLocks (HumanRequest, HumanStart, HumanComplete)",
    },
    {
        "name": "mutation-apply-no-lock",
        "source_old": 'lockf -k -t 0 "$switch_lock" "$BASH" "$0" apply-locked',
        "source_new": '"$BASH" "$0" apply-locked',
        "constants": {"ApplyLocks": "FALSE"},
        "mapping": "cmd_apply lockf -> ApplyLocks (ApplyLock, ApplyUnlock)",
    },
    {
        "name": "mutation-no-recheck",
        "source_old": '''  pgrep -qf darwin-rebuild && return 0
  local now_running
  now_running=$(system_revision)
  if [ "$now_running" != "$running" ]; then
    log "the running system changed to ${now_running:-no revision} after the check; the next tick decides again"
    return 0
  fi
''',
        "source_new": "",
        "constants": {"Recheck": "FALSE"},
        "mapping": "cmd_apply_locked recheck -> Recheck (ApplyRecheckHuman, ApplyRecheckRunning)",
    },
]

# name, model, constants, spec, invariants, expected result, expected violation
CASES = [
    ("fixed", "fixed", FIXED, "Spec", ALL, "pass", None),
    ("fixed-pre-invoke-witness", "fixed", FIXED, "PreInvokeRaceSpec",
     ["ProtectLocalRebuild"], "pass", None),
    ("mutation-rebuild-no-lock", "fixed", {**FIXED, "HumanLocks": "FALSE"}, "Spec",
     ["ProtectLocalRebuild"], "counterexample", "ProtectLocalRebuild"),
    ("mutation-rebuild-no-lock-pre-invoke-witness", "fixed", {**FIXED, "HumanLocks": "FALSE"},
     "PreInvokeRaceSpec", ["ProtectLocalRebuild"], "counterexample", "ProtectLocalRebuild"),
    ("mutation-apply-no-lock", "fixed", {**FIXED, "ApplyLocks": "FALSE"}, "Spec",
     ["ProtectLocalRebuild"], "counterexample", "ProtectLocalRebuild"),
    ("mutation-no-recheck", "fixed", {**FIXED, "Recheck": "FALSE"}, "Spec", ALL, "pass", None),
    ("unfixed-batch-4", "unfixed", {}, "Spec", ALL[:3], "counterexample", "ProtectLocalRebuild"),
] + [(f"reach-{probe}", "fixed", FIXED, "Spec", [probe], "counterexample", probe)
     for probe in ["ApplyNeverSwitches", "RebuildNeverWaitsOnSwitch", "HumanNeverFollowsApply"]]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def execute(command, timeout=900):
    try:
        result = subprocess.run(command, cwd=ROOT, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=timeout)
        return result.returncode, result.stdout
    except subprocess.TimeoutExpired as error:
        return 124, (error.stdout or b"") + b"\nRUNNER TIMEOUT: inconclusive\n"


def run_case(output, name, model, constants, spec, invariants):
    case = output / name
    case.mkdir()
    (case / "Handoff.tla").write_text(model)
    (case / "Handoff.cfg").write_text(
        f"SPECIFICATION {spec}\nCHECK_DEADLOCK FALSE\n"
        + "".join(f"CONSTANT {key} = {value}\n" for key, value in sorted(constants.items()))
        + "".join(f"INVARIANT {invariant}\n" for invariant in invariants))
    command = NIX_SHELL + [
        "tlc", "-workers", "1", "-seed", "1", "-fp", "0",
        "-metadir", str((case / ".tlc-states").relative_to(ROOT)),
        "-config", str((case / "Handoff.cfg").relative_to(ROOT)),
        str((case / "Handoff.tla").relative_to(ROOT)),
    ]
    write_json(case / "command.json", command)
    code, text = execute(command)
    (case / "tlc.txt").write_bytes(text)
    (case / "tlc.exit").write_text(f"{code}\n")
    decoded = text.decode(errors="replace")
    violation = re.search(r"Error: Invariant (\w+) is violated", decoded)
    if code == 0 and "Model checking completed. No error has been found." in decoded:
        result = "pass"
    elif code == 12 and violation:
        result = "counterexample"
    else:
        result = "inconclusive"
    statistics = re.search(r"([\d,]+) states generated, ([\d,]+) distinct states found", decoded)
    summary = {
        "name": name, "result": result, "exit": code, "spec": spec,
        "constants": constants, "invariants": invariants,
        "violated": violation.group(1) if violation else None,
        "model_sha256": digest(model.encode()),
        "states_generated": int(statistics.group(1).replace(",", "")) if statistics else None,
        "states_distinct": int(statistics.group(2).replace(",", "")) if statistics else None,
    }
    write_json(case / "result.json", summary)
    shutil.rmtree(case / ".tlc-states", ignore_errors=True)
    print(f"{name}: {result}, TLC exit {code}, violated={summary['violated']}", flush=True)
    return summary


def main():
    source = SOURCE.read_text()
    if digest(source.encode()) != SOURCE_SHA256:
        sys.exit("INCONCLUSIVE: scripts/dotfiles-autoupdate changed; review the source map "
                 "and model against it, then update SOURCE_SHA256.")
    for anchor in ANCHORS:
        if source.count(anchor) != 1:
            sys.exit(f"INCONCLUSIVE: source anchor not found exactly once: {anchor!r}")
    models = {"fixed": (HERE / "Handoff.tla").read_text(), "unfixed": UNFIXED_MODEL.read_text()}

    output = HERE / "evidence"
    if output.exists():
        reruns = HERE / "reruns"
        reruns.mkdir(exist_ok=True)
        output = Path(tempfile.mkdtemp(prefix="run-", dir=reruns))
    else:
        output.mkdir()
    print(f"Evidence: {output.relative_to(ROOT)}", flush=True)

    code, realization = execute(NIX_SHELL + ["tlc", "-h"])
    (output / "tool-realization.txt").write_bytes(realization)
    if code not in (0, 1) or b"Version 2.19 of 08 August 2024" not in realization:
        sys.exit("INCONCLUSIVE: the pinned TLC did not resolve to TLC 2.19.")
    write_json(output / "reviewed-input.json", {
        "source_sha256": SOURCE_SHA256,
        "fixed_model_sha256": digest(models["fixed"].encode()),
        "unfixed_model_sha256": digest(models["unfixed"].encode()),
        "nixpkgs_revision": NIXPKGS,
    })

    scratch = output / "scratch"
    scratch.mkdir()
    for mutation in MUTATIONS:
        if source.count(mutation["source_old"]) != 1:
            sys.exit(f"INCONCLUSIVE: mutation site for {mutation['name']} not found exactly once")
        changed = source.replace(mutation["source_old"], mutation["source_new"], 1)
        (scratch / f"{mutation['name']}.sh").write_text(changed)
        syntax, _ = execute(["/bin/bash", "-n", str(scratch / f"{mutation['name']}.sh")])
        if syntax:
            sys.exit(f"INCONCLUSIVE: {mutation['name']} scratch source fails bash -n")
        (scratch / f"{mutation['name']}.diff").write_text("".join(difflib.unified_diff(
            source.splitlines(keepends=True), changed.splitlines(keepends=True),
            fromfile="scripts/dotfiles-autoupdate", tofile=f"scratch/{mutation['name']}.sh")))
        write_json(scratch / f"{mutation['name']}.json", mutation)

    results, wrong = [], []
    for name, model, constants, spec, invariants, expected, violated in CASES:
        result = run_case(output, name, models[model], constants, spec, invariants)
        result["expected"] = expected
        results.append(result)
        if result["result"] != expected or result["violated"] != violated:
            wrong.append(name)
    write_json(output / "summary.json", results)
    if digest(SOURCE.read_bytes()) != SOURCE_SHA256:
        sys.exit("INCONCLUSIVE: the real source changed during this run.")
    if wrong:
        print(f"UNEXPECTED: {', '.join(wrong)}")
        return 1
    print("Fixed model passes; each removed part of the fix and the unfixed model fail as expected.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError) as error:
        sys.exit(f"INCONCLUSIVE: {error}")
