"""Run real ticks against SQLite with a transport that updates T3 projections.

No auth, network, alerts, or production database access is used here.
"""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/claude-fallback"
NOW = "2026-10-16T15:00:00Z"
RESET = "2026-10-16T17:00:00Z"
AFTER = "2026-10-16T17:15:00Z"
ORIGINAL = {"instanceId": "claudeAgent", "model": "claude-opus-5-5",
            "options": [{"id": "effort", "value": "high"}]}


class SequenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        loader = importlib.machinery.SourceFileLoader("fallback_sequence", str(SCRIPT))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        self.f = importlib.util.module_from_spec(spec)
        loader.exec_module(self.f)
        self.f.DB = str(root / "t3.sqlite")
        self.f.STATE = str(root / "state")
        self.f.LOG = str(root / "audit.tsv")
        self.f.T3_STUB = None  # Exercise production pre-write selection checks.
        self.db = sqlite3.connect(self.f.DB)
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE orchestration_v2_projection_threads
              (thread_id TEXT, title TEXT, payload_json TEXT, archived_at TEXT, deleted_at TEXT);
            CREATE TABLE orchestration_v2_projection_runs
              (run_id TEXT, thread_id TEXT, ordinal INTEGER, status TEXT,
               provider_instance_id TEXT, payload_json TEXT, completed_at TEXT);
            CREATE TABLE orchestration_v2_projection_turn_items
              (thread_id TEXT, run_id TEXT, ordinal INTEGER, type TEXT, payload_json TEXT, updated_at TEXT);
            CREATE TABLE orchestration_events
              (sequence INTEGER PRIMARY KEY, stream_id TEXT, event_type TEXT, actor_kind TEXT);
            CREATE TABLE orchestration_v2_projection_runtime_requests
              (thread_id TEXT, status TEXT);
        """)
        payload = {"modelSelection": ORIGINAL, "limitRecovery": {
            "runId": "limited", "resetAt": RESET, "autoResume": True}}
        self.db.execute("INSERT INTO orchestration_v2_projection_threads VALUES ('t','Fixture',?,NULL,NULL)",
                        (json.dumps(payload),))
        self.add_run("limited", "failed", "claudeAgent")
        self.add_limit("limited", RESET)
        self.db.commit()
        self.calls = []
        self.alerts = []
        self.fail_before = None
        self.fail_after = None
        self.after_call = None
        self.catalog_fails = 0
        self.f.Tick.meter = lambda _: {"unknown": (100 if self.now == NOW else 1, RESET)}
        self.real_codex_out = self.f.Tick.codex_out
        self.f.Tick.codex_out = lambda _: None
        self.f.Tick.alert = lambda _, text: self.alerts.append(text)
        owner = self

        class Transport:
            def has_model(self, _):
                if owner.catalog_fails:
                    owner.catalog_fails -= 1
                    raise RuntimeError("catalog temporarily unavailable")
                return True

            def close(self):
                pass

            def call(self, tool, args):
                owner.calls.append((tool, args))
                if owner.fail_before == tool:
                    raise RuntimeError("response unavailable")
                if tool == "t3_queue_cancel":
                    owner.db.execute("UPDATE orchestration_v2_projection_runs SET status='cancelled' WHERE run_id=?",
                                     (args["queuedRunId"],))
                elif tool == "t3_thread_configure":
                    owner.select(args["modelSelection"])
                elif tool == "t3_thread_send":
                    owner.add_run("sent-" + str(len(owner.calls)),
                                  "queued" if args["mode"] == "queue" else "running",
                                  owner.payload()["modelSelection"]["instanceId"])
                owner.db.commit()
                if owner.after_call:
                    owner.after_call(tool, args)
                if owner.fail_after == tool:
                    raise RuntimeError("write landed but reply was lost")
                return {}

        self.f.T3 = Transport

    def payload(self):
        return json.loads(self.db.execute("SELECT payload_json FROM orchestration_v2_projection_threads").fetchone()[0])

    def select(self, selection):
        payload = self.payload()
        payload["modelSelection"] = selection
        self.db.execute("UPDATE orchestration_v2_projection_threads SET payload_json=?", (json.dumps(payload),))
        self.db.execute("INSERT INTO orchestration_events(stream_id,event_type,actor_kind) VALUES ('t','thread.model-selection-updated','server')")
        self.db.commit()

    def add_run(self, name, status, provider):
        ordinal = self.db.execute("SELECT coalesce(max(ordinal),0)+1 FROM orchestration_v2_projection_runs").fetchone()[0]
        self.db.execute("INSERT INTO orchestration_v2_projection_runs VALUES (?,'t',?,?,?,?,?)",
                        (name, ordinal, status, provider, json.dumps({"userMessageId": name}), NOW))

    def add_limit(self, run, reset):
        self.db.execute("INSERT INTO orchestration_v2_projection_turn_items VALUES ('t',?,1,'error',?,?)",
                        (run, json.dumps({"failure": {"class": "usage_limit", "resetAt": reset}}), NOW))

    def held(self, name, text):
        self.add_run(name, "queued", "claudeAgent")
        self.db.execute("INSERT INTO orchestration_v2_projection_turn_items VALUES ('t',?,1,'user_message',?,?)",
                        (name, json.dumps({"messageId": name, "text": text, "createdBy": "agent"}), NOW))
        self.db.commit()

    def tick(self, now=NOW):
        self.now = now
        tick = self.f.Tick("live", self.f.utc(now))
        try:
            tick.run()
            return next(iter(tick.ledger.episodes.values()))
        finally:
            tick.close()

    def codex_limit(self):
        self.db.execute("UPDATE orchestration_v2_projection_runs SET status='failed' WHERE status='running'")
        run = self.db.execute("SELECT run_id FROM orchestration_v2_projection_runs ORDER BY ordinal DESC LIMIT 1").fetchone()[0]
        self.add_limit(run, "2026-10-17T17:00:00Z")
        self.db.commit()

    def test_restore_event_does_not_block_resume(self):
        self.assertEqual(self.tick()["state"], "switched")
        self.codex_limit()
        episode = self.tick(AFTER)
        self.assertEqual([tool for tool, _ in self.calls], [
            "t3_thread_configure", "t3_thread_send", "t3_thread_configure", "t3_thread_send"])
        self.assertEqual(episode["state"], "done")
        self.assertEqual(self.payload()["modelSelection"], ORIGINAL)
        self.tick(AFTER)
        self.assertEqual(len(self.calls), 4)

    def test_held_messages_cancel_then_replay_in_order_once(self):
        self.held("held-1", "first follow-up")
        self.held("held-2", "second follow-up")
        self.assertEqual(self.tick()["state"], "switched")
        self.assertEqual([tool for tool, _ in self.calls], [
            "t3_queue_cancel", "t3_queue_cancel", "t3_thread_configure",
            "t3_thread_send", "t3_thread_send", "t3_thread_send"])
        self.assertEqual([args["message"] for _, args in self.calls[-2:]], ["first follow-up", "second follow-up"])
        self.assertTrue(all(args["mode"] == "queue" for _, args in self.calls[-2:]))
        self.tick()
        self.assertEqual(len(self.calls), 6)

    def test_catalog_failure_retries_before_any_mutation(self):
        self.catalog_fails = 1
        self.assertEqual(self.tick()["state"], "planned")
        self.assertEqual(self.calls, [])
        self.assertEqual(self.tick()["state"], "switched")
        self.assertEqual(len(self.calls), 2)

    def test_catalog_failure_stops_after_three_attempts(self):
        self.catalog_fails = 4
        for _ in range(3):
            episode = self.tick()
        self.assertEqual(episode["state"], "gave-up")
        self.tick()
        self.assertEqual(self.catalog_fails, 1)
        self.assertEqual(len(self.alerts), 1)

    def test_retry_rechecks_codex_headroom(self):
        self.catalog_fails = 1
        self.assertEqual(self.tick()["state"], "planned")
        self.f.Tick.codex_out = lambda _: "fixture: Codex now exhausted"
        self.tick()
        self.tick()
        self.assertEqual(self.calls, [], "retry must not switch onto exhausted Codex")
        self.assertEqual(len(self.alerts), 1)
        self.f.Tick.codex_out = lambda _: None
        self.assertEqual(self.tick()["state"], "switched")
        self.assertEqual(len(self.calls), 2)

    def test_headroom_loss_after_cancel_preserves_recovery_text(self):
        self.held("held-1", "preserve this follow-up")
        def pause_after_cancel(tool, _):
            if tool == "t3_queue_cancel":
                self.db.execute("INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('t','pending')")
                self.db.commit()
        self.after_call = pause_after_cancel
        episode = self.tick()
        self.assertIn("cancel:held-1", episode["done"])
        self.db.execute("DELETE FROM orchestration_v2_projection_runtime_requests")
        self.db.commit()
        self.f.Tick.codex_out = lambda _: "fixture: Codex now exhausted"
        episode = self.tick()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(episode["held"][0]["text"], "preserve this follow-up")
        self.f.Tick.codex_out = lambda _: None
        self.assertEqual(self.tick()["state"], "switched")
        self.assertEqual(self.calls[-1][1]["message"], "preserve this follow-up")

    def rollout(self, limits):
        self.f.Tick.codex_out = self.real_codex_out
        sessions = Path(self.temp.name) / "rollouts"
        sessions.mkdir(exist_ok=True)
        self.f.CODEX_SESSIONS = str(sessions)
        sample = sessions / "rollout-fixture.jsonl"
        sample.write_text(json.dumps({"payload": {"rate_limits": limits}}) + "\n")
        timestamp = self.f.utc(NOW).timestamp()
        os.utime(sample, (timestamp, timestamp))

    def dry_decisions(self):
        self.now = NOW
        tick = self.f.Tick("dry-run", self.f.utc(NOW))
        try:
            tick.run()
            return tick.decisions
        finally:
            tick.close()

    def test_expired_rollout_limit_does_not_block_dry_plan(self):
        for window in ("primary", "secondary"):
            with self.subTest(window=window):
                self.rollout({"rate_limit_reached_type": window,
                              window: {"used_percent": 100, "resets_at": self.f.utc(NOW).timestamp() - 60}})
                # Each sample gets its own dry-run ledger to exercise planning.
                self.f.STATE = str(Path(self.temp.name) / ("state-" + window))
                self.assertIn("would-switch", self.dry_decisions())

    def test_active_or_unknown_rollout_limit_blocks_dry_plan(self):
        samples = [
            {"rate_limit_reached_type": "primary", "primary": {"resets_at": self.f.utc(NOW).timestamp() + 60}},
            {"rate_limit_reached_type": "secondary", "secondary": {}},
            {"rate_limit_reached_type": "unknown"},
            {"rate_limit_reached_type": "primary", "primary": {"resets_at": self.f.utc(NOW).timestamp() - 60},
             "secondary": {"used_percent": 100, "resets_at": self.f.utc(NOW).timestamp() + 60}},
        ]
        for index, limits in enumerate(samples):
            with self.subTest(index=index):
                self.rollout(limits)
                self.f.STATE = str(Path(self.temp.name) / ("state-active-" + str(index)))
                self.assertIn("codex-out", self.dry_decisions())

    def assert_unknown_stops(self):
        episode = self.tick()
        self.assertEqual(episode.get("inflight"), "configure")
        self.assertEqual(self.tick()["state"], "gave-up")
        self.tick()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(self.alerts), 1)

    def test_failure_before_write_is_not_retried(self):
        self.fail_before = "t3_thread_configure"
        self.assert_unknown_stops()

    def test_lost_response_after_write_is_not_retried(self):
        self.fail_after = "t3_thread_configure"
        self.assert_unknown_stops()

    def test_resume_retries_without_repeating_successful_restore(self):
        self.tick()
        self.codex_limit()
        def pending(tool, _):
            if tool == "t3_thread_configure":
                self.db.execute("INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('t','pending')")
                self.db.commit()
        self.after_call = pending
        episode = self.tick(AFTER)
        self.assertIn("restore", episode["done"])
        self.assertNotIn("inflight", episode)
        self.assertEqual(len(self.calls), 3)
        self.db.execute("DELETE FROM orchestration_v2_projection_runtime_requests")
        self.db.commit()
        self.assertEqual(self.tick(AFTER)["state"], "done")
        self.assertEqual([tool for tool, _ in self.calls[-2:]], ["t3_thread_configure", "t3_thread_send"])

    def test_changed_held_message_is_not_cancelled(self):
        self.held("held-1", "original")
        self.catalog_fails = 1
        self.tick()
        self.db.execute("UPDATE orchestration_v2_projection_turn_items SET payload_json=json_set(payload_json,'$.text','edited') WHERE run_id='held-1'")
        self.db.commit()
        self.tick()
        self.assertEqual(self.calls, [])
        self.assertEqual(self.db.execute("SELECT status FROM orchestration_v2_projection_runs WHERE run_id='held-1'").fetchone()[0], "queued")

    def test_unrelated_cancelled_run_blocks_configure(self):
        self.catalog_fails = 1
        self.tick()
        self.add_run("manual-stop", "cancelled", "claudeAgent")
        self.db.commit()
        self.tick()
        self.assertEqual(self.calls, [])

    def test_lost_cancel_response_preserves_held_text_without_replay(self):
        self.held("held-1", "recover this follow-up")
        self.fail_after = "t3_queue_cancel"
        self.tick()
        episode = self.tick()
        self.assertEqual(episode["state"], "gave-up")
        self.assertEqual(episode["held"][0]["text"], "recover this follow-up")
        self.assertEqual(len(self.calls), 1)
        ledger = self.f.Ledger("live", self.f.utc("2026-11-16T15:00:00Z"))
        self.assertEqual(len(ledger.episodes), 1, "unreconciled text must not expire")

    def test_manual_same_selection_before_restore_is_preserved(self):
        self.tick()
        self.codex_limit()
        self.select(self.payload()["modelSelection"])
        self.assertEqual(self.tick(AFTER)["state"], "done")
        self.assertEqual(len(self.calls), 2)
        self.assertIn("leave-moved", Path(self.f.LOG).read_text())

    def test_manual_selection_after_configure_stops_continue(self):
        def hand_move(tool, _):
            if tool == "t3_thread_configure":
                self.select(ORIGINAL)
        self.after_call = hand_move
        self.tick()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.payload()["modelSelection"], ORIGINAL)


if __name__ == "__main__":
    unittest.main()
