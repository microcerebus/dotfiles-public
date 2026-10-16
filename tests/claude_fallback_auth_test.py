"""Exercise the watcher auth lifecycle with a local CLI/OAuth fixture only."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/claude-fallback"


def module():
    loader = importlib.machinery.SourceFileLoader("fallback", str(SCRIPT))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    result = importlib.util.module_from_spec(spec)
    loader.exec_module(result)
    return result


def read():
    return json.loads(Path(os.environ["AUTH_FIXTURE"]).read_text())


def write(data):
    Path(os.environ["AUTH_FIXTURE"]).write_text(json.dumps(data))


def cli(args):
    data = read()
    _, kind, action, *rest = args
    entries = data[kind]
    if action == "list":
        print(json.dumps(entries))
    elif action == "create":
        entry = {"id": "own-pairing", "label": "claude-fallback"}
        entries.append(entry)
        write(data)
        print(json.dumps({**entry, "credential": "fixture-pairing-secret"}))
    elif action == "revoke":
        if os.environ.get("FAIL_REVOKE"):
            sys.exit(1)
        assert len(rest) == 1 and rest[0] != "all", "revoke must name one ID"
        key = "sessionId" if kind == "session" else "id"
        data[kind] = [e for e in entries if e[key] != rest[0]]
        data["revoked"].append(rest[0])
        write(data)
    else:
        raise AssertionError("unexpected auth operation")


def client_process():
    fallback = module()
    fault = os.environ.get("FAULT")

    class FixtureT3(fallback.T3):
        def http(self, path, body, headers=None, form=False):
            if path == "/oauth/mcp/register":
                if fault == "register":
                    raise RuntimeError("fixture registration failed")
                return {"client_id": "fixture-client"}
            if path == "/oauth/mcp/decision":
                self.state = body["authorization"]["state"]
                return {"redirectTo": "http://127.0.0.1:9/callback?code=fixture-code&state=" + self.state}
            if path == "/oauth/mcp/token":
                data = read()
                data["pairing"] = [p for p in data["pairing"] if p["id"] != "own-pairing"]
                data["session"].append({"sessionId": "own-session", "subject": "mcp-client",
                                        "client": {"label": "claude-fallback"}})
                write(data)
                if fault == "lost-response":
                    raise RuntimeError("fixture response lost after token issued")
                return {"access_token": "fixture-bearer-secret"}
            if path == "/mcp":
                if fault == "initialize":
                    raise RuntimeError("fixture initialization failed")
                if fault == "wait":
                    Path(os.environ["AUTH_READY"]).touch()
                    while True:
                        time.sleep(0.02)
                return {"result": {}}
            raise AssertionError(path)

    # Install the same termination handler used by the executable.
    if hasattr(fallback, "terminated"):
        signal.signal(signal.SIGTERM, fallback.terminated)
    client = FixtureT3()
    try:
        if fault == "body":
            raise RuntimeError("fixture tick failed")
    finally:
        client.close()


class AuthLifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.fixture = self.root / "auth.json"
        self.baseline = {
            "session": [
                {"sessionId": "other-phone", "subject": "paired-client", "client": {"label": "Fixture phone"}},
                {"sessionId": "other-desktop", "subject": "desktop-bootstrap", "client": {"label": "T3 Code Desktop"}},
                {"sessionId": "near-label", "subject": "mcp-client", "client": {"label": "claude-fallback-other"}},
                {"sessionId": "wrong-subject", "subject": "paired-client", "client": {"label": "claude-fallback"}},
            ],
            "pairing": [{"id": "other-pairing", "label": "Fixture phone"}], "revoked": [],
        }
        self.fixture.write_text(json.dumps(self.baseline))
        executable = self.root / "t3"
        executable.write_text(f'#!/bin/sh\nexec "{sys.executable}" -I "{Path(__file__).resolve()}" --cli "$@"\n')
        executable.chmod(0o700)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE_FALLBACK_", "FAULT", "FAIL_REVOKE"))}
        self.env.update(AUTH_FIXTURE=str(self.fixture), AUTH_READY=str(self.root / "ready"),
                        CLAUDE_FALLBACK_T3_BIN=str(executable), CLAUDE_FALLBACK_DB=str(self.root / "absent.sqlite"),
                        CLAUDE_FALLBACK_STATE=str(self.root / "state"), CLAUDE_FALLBACK_LOG=str(self.root / "audit.tsv"))

    def run_client(self, fault="", **env):
        return subprocess.run([sys.executable, "-I", __file__, "--client"],
                              env={**self.env, "FAULT": fault, **env}, capture_output=True, timeout=15)

    def assert_preserved(self):
        data = json.loads(self.fixture.read_text())
        self.assertEqual(data["session"], self.baseline["session"])
        self.assertEqual(data["pairing"], self.baseline["pairing"])
        self.assertTrue(set(data["revoked"]) <= {"own-session", "own-pairing"})

    def test_normal_exit_preserves_unrelated_sessions(self):
        result = self.run_client()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assert_preserved()
        self.assertIn("own-session", json.loads(self.fixture.read_text())["revoked"])
        self.assert_no_secrets(result)

    def assert_no_secrets(self, result):
        evidence = result.stdout + result.stderr
        for path in self.root.rglob("*"):
            if path.is_file():
                evidence += path.read_bytes()
        self.assertNotIn(b"fixture-bearer-secret", evidence)
        self.assertNotIn(b"fixture-pairing-secret", evidence)

    def test_failures_cleanup_even_before_constructor_returns(self):
        for fault in ("register", "lost-response", "initialize", "body"):
            with self.subTest(fault=fault):
                result = self.run_client(fault)
                self.assertNotEqual(result.returncode, 0)
                self.assert_preserved()
                self.assert_no_secrets(result)

    def start_waiting(self):
        proc = subprocess.Popen([sys.executable, "-I", __file__, "--client"],
                                env={**self.env, "FAULT": "wait"}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        deadline = time.monotonic() + 10
        while not (self.root / "ready").exists() and proc.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue((self.root / "ready").exists(), "client did not reach the post-mint barrier")
        return proc

    def test_sigterm_revokes_minted_token(self):
        proc = self.start_waiting()
        proc.terminate()
        proc.wait(timeout=10)
        self.assert_preserved()

    def test_sigkill_leftover_is_swept_by_next_idle_dry_tick(self):
        proc = self.start_waiting()
        proc.kill()
        proc.wait(timeout=10)
        self.assertIn("own-session", [s["sessionId"] for s in json.loads(self.fixture.read_text())["session"]])
        result = subprocess.run([sys.executable, "-I", str(SCRIPT), "--dry-run"], env=self.env,
                                capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assert_preserved()
        self.assert_no_secrets(result)

    def test_revoke_failure_is_not_reported_as_success(self):
        result = self.run_client(FAIL_REVOKE="1")
        self.assertNotEqual(result.returncode, 0)

    def test_live_flag_cannot_enable_production_switching(self):
        result = subprocess.run([sys.executable, "-I", str(SCRIPT), "--live"], env=self.env,
                                capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assert_preserved()


if __name__ == "__main__":
    if sys.argv[1:] and sys.argv[1] == "--cli":
        cli(sys.argv[2:])
    elif sys.argv[1:] and sys.argv[1] == "--client":
        client_process()
    else:
        unittest.main()
