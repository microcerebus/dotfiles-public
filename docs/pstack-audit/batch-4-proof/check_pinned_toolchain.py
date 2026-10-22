#!/usr/bin/env python3
"""Check that the runner's tool pin and tool parsing survive repository churn.

Runs the real runner and its real subprocess calls against a fake `nix` and
Java on PATH, with stubbed model runs. It never contacts Nix or claims a TLC
result. Run from the repository root. VERIFY_RUNNER selects another runner copy,
which is how the pre-fix runner was shown to fail.
"""

import hashlib
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
RUNNER = Path(os.environ.get("VERIFY_RUNNER", HERE / "verify.py")).resolve()
COPYING = "copying path '/nix/store/hb0x6qardylyc2fgk10dzb8dvqzqzj34-source' from 'https://cache.nixos.org'..."

FAKE_NIX = """#!/bin/bash
printf '%s\\0' "$@" >>"$FAKE_ROOT/nix-calls"
printf '\\n' >>"$FAKE_ROOT/nix-calls"
[ -n "$FAKE_NIX_STDERR" ] && printf '%s\\n' "$FAKE_NIX_STDERR" >&2
case "$1" in
  eval)
    printf '{"nixpkgsPath":"/nix/store/fake-source","revision":"%s","system":"aarch64-darwin","tool":"%s","version":"1.7.4"}\\n' \\
      "$FAKE_REVISION" "$FAKE_ROOT/tlaplus" ;;
  shell)
    mkdir -p "$FAKE_ROOT/tlaplus/bin"
    printf 'exec "%s" -cp tla2tools.jar tlc2.TLC "$@"\\n' "$FAKE_ROOT/zulu-ca-jdk-8.0.492/bin/java" \\
      >"$FAKE_ROOT/tlaplus/bin/tlc" ;;
  *) exit 2 ;;
esac
"""


def load_runner():
    spec = importlib.util.spec_from_file_location("verify_under_test", RUNNER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def stub_case(output, name, source, model, invariants, spec="Spec"):
    (output / name).mkdir()
    violated = invariants[0] if name.startswith("mutation-") else "ProtectLocalRebuild"
    return {"name": name, "result": "counterexample", "exit": 12, "violated": violated}


class PinnedToolchain(unittest.TestCase):
    def run_runner(self, locked_rev, nix_stderr=""):
        """Run main() with a fake root holding a flake.lock at locked_rev."""
        mod = load_runner()
        temp = tempfile.TemporaryDirectory(prefix="formal-tool-pin-")
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        bin_dir = root / "bin"
        bin_dir.mkdir()
        (bin_dir / "nix").write_text(FAKE_NIX)
        java = root / "zulu-ca-jdk-8.0.492/bin/java"
        java.parent.mkdir(parents=True)
        java.write_text("#!/bin/bash\necho 'fixture runtime' >&2\n")
        for path in (bin_dir / "nix", java):
            path.chmod(0o755)
        lock = {"nodes": {"nixpkgs": {"locked": {"rev": locked_rev}}}}
        (root / "flake.lock").write_text(json.dumps(lock))
        for name in ("Handoff.cfg", "Handoff.tla"):
            (root / name).write_bytes((RUNNER.parent / name).read_bytes())
        mod.ROOT = mod.HERE = root
        mod.SOURCE = REPO / "scripts/dotfiles-autoupdate"
        mod.run_case = stub_case
        environment = {"PATH": f"{bin_dir}:{os.environ['PATH']}", "FAKE_ROOT": str(root),
                       "FAKE_REVISION": mod.NIXPKGS, "FAKE_NIX_STDERR": nix_stderr}
        saved = {key: os.environ.get(key) for key in environment}
        os.environ.update(environment)
        try:
            result = mod.main()
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        calls = [record.split("\0") for record in
                 (root / "nix-calls").read_text().split("\0\n") if record]
        return mod, root, result, calls

    def test_root_lock_bump_does_not_change_tool_pin(self):
        mod, _, result, calls = self.run_runner("0" * 40)
        self.assertEqual(result, 12)
        expressions = [call[call.index("--expr") + 1] for call in calls]
        self.assertEqual([call[0] for call in calls], ["eval", "shell"])
        for expression in expressions:
            self.assertNotIn("getFlake", expression)
            self.assertIn(f'rev = "{mod.NIXPKGS}"', expression)
            self.assertIn(f'narHash = "{mod.NIXPKGS_NAR_HASH}"', expression)

    def test_nix_stderr_stays_out_of_resolution_json(self):
        mod, root, result, _ = self.run_runner(load_runner().NIXPKGS, COPYING)
        self.assertEqual(result, 12)
        resolution = (root / "evidence/tool-resolution.txt").read_text()
        self.assertEqual(json.loads(resolution)["revision"], mod.NIXPKGS)
        self.assertIn(COPYING, (root / "evidence/tool-resolution.stderr.txt").read_text())

    def test_source_commit_holds_reviewed_source_on_main(self):
        mod = load_runner()
        git = ["git", "-C", str(REPO)]
        if subprocess.run(git + ["cat-file", "-e", f"{mod.SOURCE_COMMIT}^{{commit}}"],
                          capture_output=True).returncode:
            self.skipTest(f"{mod.SOURCE_COMMIT} is absent: a shallow clone or the public mirror")
        has_main = subprocess.run(git + ["rev-parse", "--verify", "--quiet", "origin/main"],
                                  capture_output=True).returncode == 0
        main = "origin/main" if has_main else "HEAD"
        ancestor = subprocess.run(git + ["merge-base", "--is-ancestor", mod.SOURCE_COMMIT, main],
                                  capture_output=True)
        self.assertEqual(ancestor.returncode, 0, f"{mod.SOURCE_COMMIT} is not on {main}")
        shown = subprocess.run(["git", "-C", str(REPO), "show",
                                f"{mod.SOURCE_COMMIT}:scripts/dotfiles-autoupdate"],
                               capture_output=True, check=True).stdout
        self.assertEqual(hashlib.sha256(shown).hexdigest(), mod.SOURCE_SHA256)


if __name__ == "__main__":
    unittest.main(verbosity=2)
