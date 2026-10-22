#!/usr/bin/env python3
"""Replay a manually reconciled bounded model and source-mutation evidence.

Never executes dotfiles-autoupdate. Only Nix's pinned TLC, Java version output,
and bash syntax checks run. All writes stay in this proof directory.
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
# The main commit that last changed the subject, so the record survives rebases.
SOURCE_COMMIT = "d553897cb44f482e8bfd17f760d6e196d766c5b3"
SOURCE_SHA256 = "fb5b63e9bfd4ed2580f790f7d55003b7ee12b95e5d21e95debe3fcc8181d2442"
# Pinned here, not read from the root flake.lock: the daily flake update moves
# that lock, and the reviewed tool provenance must not move with it.
NIXPKGS = "7a6522c868711d06e3a520bbcdfafe9806f4337f"
NIXPKGS_NAR_HASH = "sha256-mN15cwddbOOIzzXSSwYUeRfOYeizz47Vy6y3Hzq6DuY="
PREFIX = ('let n = builtins.fetchTree { type = "github"; owner = "NixOS"; repo = "nixpkgs"; '
          f'rev = "{NIXPKGS}"; narHash = "{NIXPKGS_NAR_HASH}"; }}; '
          "p = import n { system = builtins.currentSystem; config = {}; overlays = []; }; in ")
NIX_SHELL = ["nix", "shell", "--impure", "--expr", PREFIX + "p.tlaplus", "--command"]
INVARIANTS = ["HandoffIsFetched", "ExactSelectedRevision", "ProtectLocalRebuild"]

# These pairs were chosen by source review using the generated skill.
# String replacement replays the review; it does not extract shell semantics.
MUTATIONS = [
    {
        "name": "mutation-handoff",
        "invariant": "HandoffIsFetched",
        "spec": "Spec",
        "source_old": """printf '%s\\n' "$fetched" >"$sync_dir/revision.tmp" """,
        "source_new": """printf '%s\\n' "$(git -C "$repo" rev-parse main)" >"$sync_dir/revision.tmp" """,
        "model_old": "PublishValue == s.fetched",
        "model_new": "PublishValue == g.head",
        "mapping": "cmd_sync:191 -> PublishValue used by SyncWriteTemp",
    },
    {
        "name": "mutation-exact-revision",
        "invariant": "ExactSelectedRevision",
        "spec": "Spec",
        "source_old": 'darwin-rebuild switch --flake "git+file://$repo?rev=$want#$host"',
        "source_new": 'darwin-rebuild switch --flake "$repo#$host"',
        "model_old": "RequestedRevision == a.want",
        "model_new": 'RequestedRevision == IF g.dirty THEN "Dirty" ELSE g.head',
        "mapping": "cmd_apply:470 -> RequestedRevision used by ApplyInvoke",
    },
    {
        "name": "mutation-local-protection",
        "invariant": "ProtectLocalRebuild",
        "spec": "NoHumanSpec",
        "source_old": 'elif ! user_git merge-base --is-ancestor "$running" "$want"; then',
        "source_new": "elif false; then",
        "model_old": "AdvanceAllowed == Ancestor(a.sampled, a.want)",
        "model_new": "AdvanceAllowed == TRUE",
        "mapping": "cmd_apply:448 -> AdvanceAllowed used by ApplyAdvance",
    },
]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def execute(command, cwd=ROOT, timeout=180):
    try:
        result = subprocess.run(command, cwd=cwd, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=timeout)
        return result.returncode, result.stdout
    except subprocess.TimeoutExpired as error:
        return 124, (error.stdout or b"") + b"\nRUNNER TIMEOUT: inconclusive\n"


def execute_split(command, cwd=ROOT, timeout=180):
    """Keep stderr apart for output that must parse; Nix logs fetches there."""
    try:
        result = subprocess.run(command, cwd=cwd, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout)
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired as error:
        return 124, error.stdout or b"", (error.stderr or b"") + b"\nRUNNER TIMEOUT: inconclusive\n"


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f"Expected one reviewed mutation site, got {text.count(old)}: {old}")
    return text.replace(old, new, 1)


def diff(before, after, name):
    return "".join(difflib.unified_diff(
        before.splitlines(keepends=True), after.splitlines(keepends=True),
        fromfile=f"baseline/{name}", tofile=f"scratch/{name}"))


def run_case(output, name, source, model, invariants, spec="Spec"):
    case = output / name
    case.mkdir()
    (case / "subject.sh").write_text(source)
    (case / "Handoff.tla").write_text(model)
    (case / "Handoff.cfg").write_text(
        f"SPECIFICATION {spec}\nCHECK_DEADLOCK FALSE\n"
        + "".join(f"INVARIANT {invariant}\n" for invariant in invariants))
    syntax_code, syntax_output = execute(["/bin/bash", "-n", str(case / "subject.sh")])
    (case / "source-syntax.txt").write_bytes(syntax_output)
    (case / "source-syntax.exit").write_text(f"{syntax_code}\n")
    if syntax_code:
        raise ValueError(f"{name}: scratch shell syntax failed")
    command = NIX_SHELL + [
        "tlc", "-workers", "1", "-seed", "1", "-fp", "0",
        "-metadir", str(case / ".tlc-states"),
        "-config", str(case / "Handoff.cfg"), str(case / "Handoff.tla"),
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
        "invariants": invariants,
        "violated": violation.group(1) if violation else None,
        "source_sha256": digest(source.encode()), "model_sha256": digest(model.encode()),
        "states_generated": int(statistics.group(1).replace(",", "")) if statistics else None,
        "states_distinct": int(statistics.group(2).replace(",", "")) if statistics else None,
    }
    write_json(case / "result.json", summary)
    # Keep text traces and complete inputs, not TLC's temporary fingerprint DB.
    shutil.rmtree(case / ".tlc-states", ignore_errors=True)
    print(f"{name}: {result}, TLC exit {code}, violated={summary['violated']}", flush=True)
    return summary


def main():
    source = SOURCE.read_text()
    if digest(source.encode()) != SOURCE_SHA256:
        sys.exit("INCONCLUSIVE: source drift. Follow the generated skill before updating the reviewed hash.")
    model = (HERE / "Handoff.tla").read_text()
    expected_cfg = ("SPECIFICATION Spec\nCHECK_DEADLOCK FALSE\n"
                    + "".join(f"INVARIANT {name}\n" for name in INVARIANTS))
    if (HERE / "Handoff.cfg").read_text() != expected_cfg:
        sys.exit("INCONCLUSIVE: reconcile the canonical config and runner invariant list.")

    output = HERE / "evidence"
    if output.exists():
        reruns = HERE / "reruns"
        reruns.mkdir(exist_ok=True)
        output = Path(tempfile.mkdtemp(prefix="run-", dir=reruns))
    else:
        output.mkdir()
    print(f"Evidence: {output.relative_to(ROOT)}", flush=True)

    expression = PREFIX + """{
      revision = n.rev; system = builtins.currentSystem;
      version = p.tlaplus.version; tool = toString p.tlaplus;
      nixpkgsPath = toString n;
    }"""
    command = ["nix", "eval", "--impure", "--json", "--expr", expression]
    # A fresh store fetches the pinned nixpkgs source here, which can take minutes.
    code, provenance, log = execute_split(command, timeout=900)
    (output / "tool-resolution.txt").write_bytes(provenance)
    (output / "tool-resolution.stderr.txt").write_bytes(log)
    (output / "tool-resolution.exit").write_text(f"{code}\n")
    write_json(output / "tool-resolution-command.json", command)
    if code:
        sys.exit("INCONCLUSIVE: pinned tool resolution failed.")
    tool = json.loads(provenance)
    if (tool["revision"] != NIXPKGS or tool["version"] != "1.7.4"
            or tool["system"] != "aarch64-darwin"):
        sys.exit("INCONCLUSIVE: tool platform or version differs from reviewed provenance.")
    # Evaluation returns an output path without ensuring that it is in the store.
    # Realize the pinned closure before reading the wrapper, including after GC.
    command = NIX_SHELL + ["true"]
    code, realization = execute(command, timeout=900)
    write_json(output / "tool-realization-command.json", command)
    (output / "tool-realization.txt").write_bytes(realization)
    (output / "tool-realization.exit").write_text(f"{code}\n")
    if code:
        sys.exit("INCONCLUSIVE: pinned tool realization failed.")
    wrapper = (Path(tool["tool"]) / "bin/tlc").read_text()
    (output / "tlc-wrapper.txt").write_text(wrapper)
    java = re.search(r'exec "([^"]+/bin/java)"', wrapper)
    if not java or "zulu-ca-jdk-8.0.492" not in java.group(1):
        sys.exit("INCONCLUSIVE: TLC wrapper runtime differs from reviewed provenance.")
    java_code, java_output = execute([java.group(1), "-version"])
    (output / "java-version.txt").write_bytes(java_output)
    (output / "java-version.exit").write_text(f"{java_code}\n")
    if java_code:
        sys.exit("INCONCLUSIVE: pinned Java failed.")
    write_json(output / "reviewed-input.json", {
        "source_commit": SOURCE_COMMIT, "source_sha256": SOURCE_SHA256,
        "model_sha256": digest(model.encode()), "nixpkgs_revision": NIXPKGS,
        "abstraction": "manual; fixed mutation mappings, no automated extraction",
    })

    results = [
        run_case(output, "baseline", source, model, INVARIANTS),
        run_case(output, "baseline-handoff-and-exact", source, model, INVARIANTS[:2]),
        run_case(output, "baseline-no-human-diagnostic", source, model, INVARIANTS, "NoHumanSpec"),
        run_case(output, "baseline-pre-invoke-witness", source, model,
                 ["ProtectLocalRebuild"], "PreInvokeRaceSpec"),
    ]
    scratch = output / "scratch"
    scratch.mkdir()
    for mutation in MUTATIONS:
        changed_source = replace_once(source, mutation["source_old"], mutation["source_new"])
        changed_model = replace_once(model, mutation["model_old"], mutation["model_new"])
        (scratch / "subject.sh").write_text(changed_source)
        (scratch / "Handoff.tla").write_text(changed_model)
        result = run_case(output, mutation["name"], (scratch / "subject.sh").read_text(),
                          (scratch / "Handoff.tla").read_text(),
                          [mutation["invariant"]], mutation["spec"])
        case = output / mutation["name"]
        (case / "source.diff").write_text(diff(source, changed_source, "scripts/dotfiles-autoupdate"))
        (case / "model.diff").write_text(diff(model, changed_model, "Handoff.tla"))
        write_json(case / "reconciliation.json", mutation)
        results.append(result)

    (scratch / "subject.sh").write_text(source)
    (scratch / "Handoff.tla").write_text(model)
    assert (scratch / "subject.sh").read_bytes() == SOURCE.read_bytes()
    assert (scratch / "Handoff.tla").read_bytes() == (HERE / "Handoff.tla").read_bytes()
    write_json(output / "restoration.json", {
        "scratch_source_equals_real_source": True,
        "scratch_model_equals_baseline_model": True,
        "real_source_sha256": digest(SOURCE.read_bytes()),
    })
    results.append(run_case(output, "baseline-restored", (scratch / "subject.sh").read_text(),
                            (scratch / "Handoff.tla").read_text(), INVARIANTS))
    write_json(output / "summary.json", results)

    expected_mutations = {m["name"]: m["invariant"] for m in MUTATIONS}
    for result in results:
        if result["result"] == "inconclusive":
            sys.exit("INCONCLUSIVE: a TLC run did not produce a pass or invariant trace.")
        if result["name"] in expected_mutations and result["violated"] != expected_mutations[result["name"]]:
            sys.exit("INCONCLUSIVE: a mutation did not demonstrate its intended safety violation.")
    if results[0]["result"] != results[-1]["result"] or results[0]["violated"] != results[-1]["violated"]:
        sys.exit("INCONCLUSIVE: restored baseline differs from the first baseline.")
    if digest(SOURCE.read_bytes()) != SOURCE_SHA256:
        sys.exit("INCONCLUSIVE: the real source changed during this run.")
    print(f"Restored baseline: {results[-1]['result']}; all three source/model mutations detected.")
    return results[-1]["exit"]


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, AssertionError) as error:
        sys.exit(f"INCONCLUSIVE: {error}")
