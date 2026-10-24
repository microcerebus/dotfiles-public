#!/usr/bin/env bash
# Tests for scripts/claude-fallback against a fixture T3 database.
# The fixture tables copy the real statev2.sqlite schema. T3, the Claude
# meter, the Codex reading and alerts are stubs, so nothing leaves the temp dir.
# Run: bash tests/claude_fallback_test.sh
set -euo pipefail
# Confine the suite under scripts/test-sandbox (see tests/lib/confine.sh).
# shellcheck source=tests/lib/confine.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/confine.sh"
repo="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail=0

now=2026-10-16T15:00:00Z
reset=2026-10-16T17:00:00Z
reset_epoch=1792170000
after_reset=2026-10-16T17:05:00Z

export CLAUDE_FALLBACK_DB="$tmp/state.sqlite"
export CLAUDE_FALLBACK_STATE="$tmp/state"
export CLAUDE_FALLBACK_LOG="$tmp/audit.tsv"
export CLAUDE_FALLBACK_T3_STUB="$tmp/calls.jsonl"
export CLAUDE_FALLBACK_METER="$tmp/meter"
export CLAUDE_FALLBACK_ALERT="$tmp/alert"
export CLAUDE_FALLBACK_CODEX_SESSIONS="$tmp/codex"
printf '#!/bin/sh\n[ -f "%s/meter.txt" ] || exit 1\ncat "%s/meter.txt"\n' "$tmp" "$tmp" >"$tmp/meter"
printf '#!/bin/sh\necho "$*" >>"%s/alerts"\n' "$tmp" >"$tmp/alert"
chmod +x "$tmp/meter" "$tmp/alert"

sql() { sqlite3 "$CLAUDE_FALLBACK_DB" "$@"; }

fresh() {
  rm -rf "$CLAUDE_FALLBACK_DB" "$CLAUDE_FALLBACK_STATE" "$tmp/audit.tsv" "$tmp/calls.jsonl" "$tmp/alerts" "$tmp/codex" "$tmp/meter.txt"
  sql <<'SQL'
CREATE TABLE orchestration_v2_projection_threads ( thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, default_provider TEXT NOT NULL, runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL, active_provider_thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, deleted_at TEXT, payload_json TEXT NOT NULL , provider_instance_id TEXT);
CREATE TABLE orchestration_v2_projection_runs ( run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL, provider TEXT NOT NULL, provider_thread_id TEXT, status TEXT NOT NULL, requested_at TEXT NOT NULL, completed_at TEXT, payload_json TEXT NOT NULL , provider_instance_id TEXT);
CREATE TABLE orchestration_v2_projection_turn_items ( turn_item_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, node_id TEXT, provider_thread_id TEXT, provider_turn_id TEXT, parent_item_id TEXT, ordinal INTEGER NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL );
CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY, stream_id TEXT, event_type TEXT, actor_kind TEXT);
CREATE TABLE orchestration_v2_projection_runtime_requests (runtime_request_id TEXT PRIMARY KEY, thread_id TEXT, status TEXT);
SQL
}

claude_sel() { printf '{"instanceId":"claudeAgent","model":"claude-opus-5-5","options":[{"id":"effort","value":"%s"}]}' "$1"; }
astra_sel='{"instanceId":"codex","model":"gpt-6-astra","options":[{"id":"reasoningEffort","value":"high"},{"id":"serviceTier","value":"default"}]}'

# limited <thread> [effort] [lastVisitedAt]: a thread whose latest run failed
# on the Claude 5-hour limit and that T3 armed for recovery.
limited() {
  local t="$1" effort="${2:-high}" visited="${3:-}" sel
  sel="$(claude_sel "$effort")"
  [ -n "$visited" ] && visited="\"$visited\"" || visited=null
  sql "INSERT INTO orchestration_v2_projection_threads VALUES ('$t','p','Title $t','claudeAgent','full-access','default',NULL,'$now','$now',NULL,NULL,
    '{\"modelSelection\":$sel,\"limitRecovery\":{\"runId\":\"run:$t:1\",\"resetAt\":\"$reset\",\"autoResume\":true,\"snooze\":true},\"lastVisitedAt\":$visited,\"settledAt\":null}','claudeAgent');
  INSERT INTO orchestration_v2_projection_runs VALUES ('run:$t:1','$t',1,'claudeAgent',NULL,'failed','2026-10-16T14:50:00Z','2026-10-16T14:50:01Z','{\"modelSelection\":$sel,\"userMessageId\":\"msg:$t:1\"}','claudeAgent');
  INSERT INTO orchestration_v2_projection_turn_items VALUES ('um:$t:1','$t','run:$t:1',NULL,NULL,NULL,NULL,1,'user_message','completed','2026-10-16T14:50:00Z','{\"messageId\":\"msg:$t:1\",\"createdBy\":\"agent\",\"text\":\"do the thing\"}');
  INSERT INTO orchestration_v2_projection_turn_items VALUES ('err:$t','$t','run:$t:1',NULL,NULL,NULL,NULL,2,'error','completed','2026-10-16T14:50:01Z','{\"failure\":{\"class\":\"usage_limit\",\"code\":\"api_error_429\",\"retryable\":true,\"resetAt\":\"$reset\"}}');
  INSERT INTO orchestration_v2_projection_turn_items VALUES ('notice:$t','$t','run:$t:1',NULL,NULL,NULL,NULL,3,'system_notice','completed','2026-10-16T14:50:01Z','{\"nativeItemRef\":{\"nativeId\":\"usage-limit:provider-turn:x:five_hour:$reset_epoch\"}}');"
}

# queued <thread> <ordinal> <text>: a follow-up held behind the limited run.
queued() {
  local sel; sel="$(claude_sel high)"
  sql "INSERT INTO orchestration_v2_projection_runs VALUES ('run:$1:$2','$1',$2,'claudeAgent',NULL,'queued','2026-10-16T14:55:00Z',NULL,'{\"modelSelection\":$sel,\"userMessageId\":\"msg:$1:$2\"}','claudeAgent');
  INSERT INTO orchestration_v2_projection_turn_items VALUES ('um:$1:$2','$1','run:$1:$2',NULL,NULL,NULL,NULL,10,'user_message','pending','2026-10-16T14:55:00Z','{\"messageId\":\"msg:$1:$2\",\"createdBy\":\"agent\",\"text\":\"$3\"}');"
}

set_sel() { sql "UPDATE orchestration_v2_projection_threads SET provider_instance_id=json_extract('$2','\$.instanceId'), payload_json=json_set(payload_json,'\$.modelSelection',json('$2')) WHERE thread_id='$1'"; }
codex_used() { mkdir -p "$tmp/codex/2026/10/16"; printf '{"payload":{"rate_limits":{"primary":{"used_percent":%s,"window_minutes":10080,"resets_at":1792500000},"rate_limit_reached_type":%s}}}\n' "$1" "$2" >"$tmp/codex/2026/10/16/rollout-1.jsonl"; }

tick() { CLAUDE_FALLBACK_NOW="$1" python3 -I "$repo/scripts/claude-fallback" "${@:2}" >>"$tmp/out.log" 2>&1; }
calls() { if [ -f "$tmp/calls.jsonl" ]; then grep -c "$1" "$tmp/calls.jsonl" || :; else echo 0; fi; }
rows() { if [ -f "$tmp/audit.tsv" ]; then grep -c "$1" "$tmp/audit.tsv" || :; else echo 0; fi; }

check() {
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected '$3', got '$2'"; fail=1; fi
}

# 1. A limited thread moves to Codex Astra High and gets one continue message.
fresh; limited t1; echo "five_hour 100 $reset" >"$tmp/meter.txt"
tick "$now" --live
check "switch: configure to astra" "$(calls '"tool":"t3_thread_configure".*"model":"gpt-6-astra"')" 1
check "switch: continue sent" "$(calls '"tool":"t3_thread_send".*Continue where you left off')" 1
check "switch: audit row" "$(rows 'switch	Title t1')" 1
# 2. The next tick does nothing new.
set_sel t1 "$astra_sel"; tick "$now" --live
check "second tick: no new calls" "$(calls '"tool":"t3_thread_')" 2
# 3. After the reset, with the meter recovered, the idle thread goes back to its Claude selection.
echo "five_hour 2 2026-10-16T22:00:00Z" >"$tmp/meter.txt"; tick "$after_reset" --live
check "switch back: configure to claude" "$(calls '"tool":"t3_thread_configure".*"model":"claude-opus-5-5"')" 1
check "switch back: audit row" "$(rows 'switch-back	Title t1')" 1

# 4. Codex out of allowance: no switch, one alert across two ticks.
fresh; limited t1; codex_used 100 '"primary"'; touch "$tmp/codex/2026/10/16/rollout-1.jsonl"
tick "$now" --live; tick "$now" --live
check "codex out: no calls" "$(calls 't3_thread_')" 0
check "codex out: one alert" "$( [ -f "$tmp/alerts" ] && wc -l <"$tmp/alerts" | tr -d ' ' || echo 0)" 1

# 5. A thread the owner opened 5 minutes ago is left alone.
fresh; limited t1 high 2026-10-16T14:55:00Z; tick "$now" --live
check "visited: no calls" "$(calls 't3_thread_')" 0
check "visited: logged" "$(rows 'skip-visited	Title t1')" 1

# 6. A 429 while the meter shows headroom in the named window is transient.
fresh; limited t1; echo "five_hour 40 $reset" >"$tmp/meter.txt"; tick "$now" --live
check "transient 429: no calls" "$(calls 't3_thread_')" 0
check "transient 429: logged" "$(rows 'skip-transient	Title t1')" 1

# 7. Low effort goes to Sol Low, and a held follow-up is cancelled and re-sent after the continue.
fresh; limited t1 low; queued t1 2 "held follow-up"; tick "$now" --live
check "low effort: sol low" "$(calls '"model":"gpt-6.1-sol","options":\[{"id":"reasoningEffort","value":"low"}')" 1
check "held: cancelled" "$(calls '"tool":"t3_queue_cancel".*"queuedRunId":"run:t1:2"')" 1
check "held: re-sent last" "$(tail -1 "$tmp/calls.jsonl" | grep -c 'held follow-up')" 1

# 8. A thread moved by hand during the episode is not switched back.
fresh; limited t1; echo "five_hour 100 $reset" >"$tmp/meter.txt"; tick "$now" --live
set_sel t1 '{"instanceId":"codex","model":"gpt-6.1-sol"}'
echo "five_hour 2 2026-10-16T22:00:00Z" >"$tmp/meter.txt"; tick "$after_reset" --live
check "hand move: no switch back" "$(calls '"model":"claude-opus-5-5"')" 0
check "hand move: logged" "$(rows 'leave-moved	Title t1')" 1

# 9. A busy thread waits for idle before switching back.
fresh; limited t1; echo "five_hour 100 $reset" >"$tmp/meter.txt"; tick "$now" --live
set_sel t1 "$astra_sel"
sql "INSERT INTO orchestration_v2_projection_runs VALUES ('run:t1:2','t1',2,'codex',NULL,'running','2026-10-16T17:01:00Z',NULL,'{}','codex')"
echo "five_hour 2 2026-10-16T22:00:00Z" >"$tmp/meter.txt"; tick "$after_reset" --live
check "busy: no switch back yet" "$(calls '"model":"claude-opus-5-5"')" 0
sql "UPDATE orchestration_v2_projection_runs SET status='completed' WHERE run_id='run:t1:2'"; tick "$after_reset" --live
check "busy: switches back once idle" "$(calls '"model":"claude-opus-5-5"')" 1

# 10. The default mode is a dry run: audit rows, no T3 calls, no alerts, once per episode.
fresh; limited t1; echo "five_hour 100 $reset" >"$tmp/meter.txt"; tick "$now"; tick "$now"
check "dry run: no calls" "$(calls 't3_')" 0
check "dry run: one would-switch row" "$(rows 'dry-run	would-switch	Title t1')" 1

# Guardrails apply to the audit plan as well as fixture switching.
fresh; limited t1; set_sel t1 "$astra_sel"; tick "$now"
check "hand moved before tick: no plan" "$(rows 'would-switch')" 0
fresh; limited t1
sql "UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'\$.limitRecovery.autoResume',json('false'))"
tick "$now"
check "auto resume disabled: no plan" "$(rows 'would-switch')" 0
fresh; limited t1; queued t1 2 "held attachment"
sql "UPDATE orchestration_v2_projection_turn_items SET payload_json=json_set(payload_json,'\$.attachments',json('[{\"type\":\"image\"}]')) WHERE turn_item_id='um:t1:2'"
tick "$now" --live
check "attachment: queue preserved" "$(calls 't3_')" 0
check "attachment: manual review logged" "$(rows 'skip-manual')" 1
fresh; limited t1
sql "INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('request:t1','t1','pending')"
tick "$now"
check "pending approval: no plan" "$(rows 'would-switch')" 0
fresh; limited t1; tick "$now"; tick "$after_reset"
check "dry reset: respects meter grace" "$(rows 'would-switch-back')" 0
echo "five_hour 2 2026-10-16T22:00:00Z" >"$tmp/meter.txt"; tick "$after_reset"
check "dry reset: restore plan" "$(rows 'would-switch-back')" 1
fresh; limited t1; tick "$now"
sql "INSERT INTO orchestration_events VALUES (1,'t1','thread.model-selection-updated','server')"
echo "five_hour 2 2026-10-16T22:00:00Z" >"$tmp/meter.txt"; tick "$after_reset"
check "same model chosen by user: no restore" "$(rows 'would-switch-back')" 0
check "same model chosen by user: logged" "$(rows 'leave-moved')" 1

python3 -I "$repo/tests/claude_fallback_auth_test.py" || fail=1
python3 -I "$repo/tests/claude_fallback_sequence_test.py" || fail=1

exit "$fail"
