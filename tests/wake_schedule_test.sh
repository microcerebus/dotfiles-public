#!/usr/bin/env bash
# Tests for scripts/wake-schedule against a stub pmset that keeps its state in
# a temp dir, and a fake clock that the stub sleep moves forward.
# Pure: never touches the real power settings, writes only to a temp dir.
# Run: bash tests/wake_schedule_test.sh
set -euo pipefail
# Confine the suite under scripts/test-sandbox (see tests/lib/confine.sh).
# shellcheck source=tests/lib/confine.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/confine.sh"
repo="$(cd "$(dirname "$0")/.." && pwd)"
script="$repo/scripts/wake-schedule"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export TZ=Asia/Singapore
fail=0

# Only the stubs and these macOS tools are on PATH, the ones the daemon's PATH
# gives it (nix/wake-schedule.nix), so the real pmset is out of reach.
real="$tmp/real"
mkdir -p "$real"
for t in /bin/cat /usr/bin/grep /usr/bin/head /bin/mv /bin/rm /usr/bin/tr; do ln -s "$t" "$real/"; done
ln -s "$BASH" "$real/bash"

stubs="$tmp/stubs"
mkdir -p "$stubs"
cat >"$stubs/date" <<'EOF'
#!/bin/sh
if [ "$*" = "+%s" ]; then exec /bin/cat "$WS_DIR/clock"; fi
exec /bin/date "$@"
EOF
cat >"$stubs/sleep" <<'EOF'
#!/bin/sh
echo $(($(/bin/cat "$WS_DIR/clock") + $1)) >"$WS_DIR/clock"
EOF
# pmset: -g, -g sched, -g batt, -a disablesleep N, schedule [cancel] wake "MM/dd/yy HH:mm:ss" owner.
# Every change is appended to $WS_DIR/calls.
cat >"$stubs/pmset" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
d=$WS_DIR
case "$*" in
  "-g") printf 'System-wide power settings:\n SleepDisabled\t\t%s\n' "$(<"$d/disabled")" ;;
  "-g sched")
    [ -s "$d/sched" ] || exit 0
    echo "Scheduled power events:"
    i=0
    while IFS= read -r l; do echo " [$i]  $l"; i=$((i + 1)); done <"$d/sched" ;;
  "-g batt") cat "$d/batt" ;;
  "-a disablesleep "[01]) echo "$3" >"$d/disabled"; echo "disablesleep $3" >>"$d/calls" ;;
  "schedule wake "*|"schedule cancel wake "*)
    [ "$2" = cancel ] && shift
    when=$(/bin/date -j -f '%m/%d/%y %H:%M:%S' "$3" '+%m/%d/%Y %H:%M:%S')
    line="wake at $when by '$4'"
    if [ "$2" = cancel ]; then
      grep -vxF "$line" "$d/sched" >"$d/sched.new" || true
      mv "$d/sched.new" "$d/sched"
      echo "cancel $when" >>"$d/calls"
    else
      echo "$line" >>"$d/sched"
      echo "wake $when" >>"$d/calls"
    fi ;;
  *) echo "pmset stub: unexpected: $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$stubs"/*

slots="08:00/0123456 09:00/0 10:00/0123456 18:00/0123456"
ac=$'Now drawing from \'AC Power\'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true'
low=$'Now drawing from \'Battery Power\'\n -InternalBattery-0 (id=1)\t10%; discharging; 0:40 remaining present: true'

# epoch <YYYY-MM-DD HH:MM>. Seconds given explicitly: date -j fills missing fields from the real clock.
epoch() { /bin/date -j -f '%Y-%m-%d %H:%M:%S' "$1:00" +%s; }

# fresh <case> <YYYY-MM-DD HH:MM> <SleepDisabled> [batt]: a new machine state at that time.
fresh() {
  export WS_DIR="$tmp/$1"
  mkdir -p "$WS_DIR"
  epoch "$2" >"$WS_DIR/clock"
  echo "$3" >"$WS_DIR/disabled"
  printf '%s\n' "${4:-$ac}" >"$WS_DIR/batt"
  : >"$WS_DIR/sched"
  : >"$WS_DIR/calls"
}

# go [slots]: one run; the log without timestamps lands in $WS_DIR/log.
go() {
  local code=0
  PATH="$stubs:$real" WAKE_SLOTS="${1:-$slots}" WAKE_STATE="$WS_DIR/hold" \
    bash "$script" run >"$WS_DIR/out" 2>&1 || code=$?
  cut -d' ' -f3- "$WS_DIR/out" >"$WS_DIR/log"
  echo "exit $code" >>"$WS_DIR/log"
}

ok() { echo "ok   $1"; }
# bad <name>: the run's log goes along with the failure.
bad() { echo "FAIL $1"; sed 's/^/  /' "$WS_DIR/log"; fail=1; }

# expect <name> <file> <want>
expect() {
  local got
  got="$(cat "$WS_DIR/$2")"
  if [ "$got" = "$3" ]; then
    ok "$1"
  else
    echo "FAIL $1"
    diff <(echo "$3") <(echo "$got") | sed 's/^/  /' || true
    fail=1
  fi
}

# 1. Thu 14:30, nothing queued: three days of wakes, no hold, SleepDisabled untouched.
fresh queue "2026-10-15 14:30" 0
echo "wake at 10/16/2026 00:32:34 by 'com.apple.alarm.user-invisible-com.apple.acmd.alarm'" >"$WS_DIR/sched"
go
expect "queues three days of wakes 5 min before each slot" log "queued wake Thu 15 Oct 17:55
queued wake Fri 16 Oct 07:55
queued wake Fri 16 Oct 09:55
queued wake Fri 16 Oct 17:55
queued wake Sat 17 Oct 07:55
queued wake Sat 17 Oct 09:55
queued wake Sat 17 Oct 17:55
queued wake Sun 18 Oct 07:55
queued wake Sun 18 Oct 08:55
queued wake Sun 18 Oct 09:55
exit 0"
expect "touches nothing but the queue" calls "$(printf 'wake %s\n' "10/15/2026 17:55:00" \
  "10/16/2026 07:55:00" "10/16/2026 09:55:00" "10/16/2026 17:55:00" \
  "10/17/2026 07:55:00" "10/17/2026 09:55:00" "10/17/2026 17:55:00" \
  "10/18/2026 07:55:00" "10/18/2026 08:55:00" "10/18/2026 09:55:00")"

# 2. The same run again changes nothing.
: >"$WS_DIR/calls"
go
expect "second run is a no-op" log "exit 0"
expect "second run calls nothing" calls ""

# 3. A slot dropped from the config: its future wakes go, other owners' stay.
go "08:00/0123456 09:00/0 10:00/0123456"
expect "cancels wakes no slot needs" log "cancelled wake Thu 15 Oct 17:55: no slot needs it
cancelled wake Fri 16 Oct 17:55: no slot needs it
cancelled wake Sat 17 Oct 17:55: no slot needs it
exit 0"
if grep -q "com.apple.acmd.alarm" "$WS_DIR/sched"; then ok "keeps other owners' events"; else bad "keeps other owners' events"; fi

# 4. Woken at 07:55 with SleepDisabled 0: hold first, then queue, release at 08:25.
fresh hold "2026-10-16 07:55" 0
go
expect "holds through the 08:00 run" log "hold started until Fri 16 Oct 08:25: SleepDisabled 0 -> 1
queued wake Fri 16 Oct 09:55
queued wake Fri 16 Oct 17:55
queued wake Sat 17 Oct 07:55
queued wake Sat 17 Oct 09:55
queued wake Sat 17 Oct 17:55
queued wake Sun 18 Oct 07:55
queued wake Sun 18 Oct 08:55
queued wake Sun 18 Oct 09:55
queued wake Sun 18 Oct 17:55
queued wake Mon 19 Oct 07:55
hold ended (window closed): SleepDisabled 1 -> 0
exit 0"
expect "SleepDisabled set before anything else, cleared last" calls "disablesleep 1
$(printf 'wake %s\n' "10/16/2026 09:55:00" "10/16/2026 17:55:00" \
  "10/17/2026 07:55:00" "10/17/2026 09:55:00" "10/17/2026 17:55:00" \
  "10/18/2026 07:55:00" "10/18/2026 08:55:00" "10/18/2026 09:55:00" "10/18/2026 17:55:00" \
  "10/19/2026 07:55:00")
disablesleep 0"
if [ "$(cat "$WS_DIR/clock")" -ge "$(epoch "2026-10-16 08:25")" ]; then ok "hold lasts until 08:25"; else bad "hold lasts until 08:25"; fi
if [ ! -e "$WS_DIR/hold" ]; then ok "marker removed"; else bad "marker removed"; fi

# 5. SleepDisabled already 1 (a night with work): not ours, never touched.
fresh theirs "2026-10-16 07:55" 1
go
if ! grep -q disablesleep "$WS_DIR/calls" && [ "$(cat "$WS_DIR/disabled")" = 1 ] \
  && [ "$(head -1 "$WS_DIR/log")" = "no hold needed: SleepDisabled is already 1" ]; then
  ok "leaves someone else's SleepDisabled alone"
else
  bad "leaves someone else's SleepDisabled alone"
fi

# 6. On battery at 10%: wake, but no hold.
fresh lowbatt "2026-10-16 07:55" 0 "$low"
go
if [ "$(head -1 "$WS_DIR/log")" = "no hold: on battery at 10%" ] && ! grep -q disablesleep "$WS_DIR/calls"; then
  ok "no hold on low battery"
else
  bad "no hold on low battery"
fi

# 7. A reload killed the hold at 08:10: the next run resumes it and ends it at 08:25.
fresh resume "2026-10-16 08:10" 1
: >"$WS_DIR/hold"
go
if [ "$(head -1 "$WS_DIR/log")" = "hold resumed until Fri 16 Oct 08:25" ] \
  && [ "$(tail -2 "$WS_DIR/log" | head -1)" = "hold ended (window closed): SleepDisabled 1 -> 0" ] \
  && [ "$(cat "$WS_DIR/disabled")" = 0 ]; then
  ok "resumes a hold a reload interrupted"
else
  bad "resumes a hold a reload interrupted"
fi

# 8. A marker left past its window (killed, then nothing ran until 12:00): released at once.
fresh stale "2026-10-16 12:00" 1
: >"$WS_DIR/hold"
go
if [ "$(tail -2 "$WS_DIR/log" | head -1)" = "hold ended (no window open): SleepDisabled 1 -> 0" ] \
  && [ "$(cat "$WS_DIR/disabled")" = 0 ] && [ ! -e "$WS_DIR/hold" ]; then
  ok "releases a stale hold"
else
  bad "releases a stale hold"
fi

# 9. A window that opens during a hold extends it (08:00 and 08:15 slots: hold to 08:40).
fresh overlap "2026-10-16 07:55" 0
go "08:00/0123456 08:15/0123456"
if [ "$(head -1 "$WS_DIR/log")" = "hold started until Fri 16 Oct 08:25: SleepDisabled 0 -> 1" ] \
  && [ "$(cat "$WS_DIR/clock")" -ge "$(epoch "2026-10-16 08:40")" ]; then
  ok "overlapping windows extend the hold"
else
  bad "overlapping windows extend the hold"
fi

# 10. Sunday: the 09:00 export gets its own wake at 08:55, after the 08:00 hold ends.
fresh sunday "2026-10-18 08:55" 0
go
if [ "$(head -1 "$WS_DIR/log")" = "hold started until Sun 18 Oct 09:25: SleepDisabled 0 -> 1" ]; then
  ok "Sunday 09:00 window"
else
  bad "Sunday 09:00 window"
fi

exit "$fail"
