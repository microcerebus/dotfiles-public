#!/usr/bin/env bash
# Tests for scripts/dotfiles-autoupdate against a sandboxed origin, checkout
# and fake system generations, with stub darwin-rebuild, nix-store, pnpm,
# brew, softwareupdate, sudo, curl and a clock. The terminal case (20) runs
# the program `autoupdate-now` names, built from this flake.
# Never touches the real system and writes only to a temp dir and the Nix
# store. The network is used only by Nix, to fetch what that build needs.
# Run: bash tests/autoupdate_test.sh
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
script="$repo/scripts/dotfiles-autoupdate"
tmp="$(mktemp -d)"
trap '[ -n "${KEEP_TMP:-}" ] || rm -rf "$tmp"' EXIT
export TZ=Asia/Singapore
fail=0

ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; shift; printf '  %s\n' "$@"; fail=1; }

# Only the stubs and these real tools are on PATH, so nothing can reach the
# real brew, pnpm, softwareupdate or darwin-rebuild.
real="$tmp/real"
mkdir -p "$real"
for t in git jq; do ln -s "$(command -v "$t")" "$real/$t"; done
ln -s "$BASH" "$real/bash"

stubs="$tmp/stubs"
mkdir -p "$stubs"
cat >"$stubs/date" <<'EOF'
#!/bin/sh
exec /bin/date -r "$FAKE_NOW" "$@"
EOF
cat >"$stubs/sleep" <<'EOF'
#!/bin/sh
EOF
cat >"$stubs/timeout" <<'EOF'
#!/bin/sh
while case $1 in -*) true ;; *) false ;; esac; do shift; done
shift
exec "$@"
EOF
# sudo -u <user> [-H] [env VAR=...] cmd: runs cmd as the caller, keeping the
# stub PATH whatever the caller asked for.
cat >"$stubs/sudo" <<'EOF'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case $1 in -u) shift 2 ;; -H|--set-home) shift ;; *) break ;; esac
done
if [ "${1:-}" = env ]; then
  shift
  args=()
  while [[ ${1:-} == *=* ]]; do [[ $1 == PATH=* ]] || args+=("$1"); shift; done
  exec env "${args[@]}" "$@"
fi
exec "$@"
EOF
# stub-terminal-check <name>: in a terminal run (STUB_TTY), records a step
# outside the terminal's foreground process group, where a terminal read or
# mode change stops it and Ctrl-C cannot reach it, and a step handed the
# terminal as stdin, which makes pnpm ask which builds to approve.
cat >"$stubs/stub-terminal-check" <<'EOF'
#!/bin/sh
[ -n "${STUB_TTY:-}" ] || exit 0
[ "$(ps -o pgid= -p $$ | tr -d ' ')" = "$(ps -o tpgid= -p $$ | tr -d ' ')" ] \
  || echo "$1 ran outside the terminal's foreground process group" >>"$STUB_LOG/calls"
[ ! -t 0 ] || echo "$1 had the terminal as stdin" >>"$STUB_LOG/calls"
EOF
cat >"$stubs/git" <<EOF
#!/bin/sh
stub-terminal-check git
exec $(command -v git) "\$@"
EOF
# STUB_LAVISH=<code>: a Lavish server on :4387 answers <code> for its page
# assets; STUB_LAVISH_APP names the app its /health reports. Only status
# probes Lavish, never a sync step, so the terminal check skips it.
cat >"$stubs/curl" <<'EOF'
#!/bin/sh
case "$*" in
  *:4387/chrome.css*) [ -n "${STUB_LAVISH:-}" ] || exit 7; printf '%s' "$STUB_LAVISH"; exit 0 ;;
  *:4387/health*) [ -n "${STUB_LAVISH:-}" ] || exit 7; printf '{"app":"%s"}' "${STUB_LAVISH_APP:-lavish-axi}"; exit 0 ;;
esac
stub-terminal-check curl
[ "${STUB_OFFLINE:-0}" = 0 ]
EOF
cat >"$stubs/pgrep" <<'EOF'
#!/bin/sh
[ "${STUB_REBUILD_RUNNING:-0}" = 1 ]
EOF
cat >"$stubs/sw_vers" <<'EOF'
#!/bin/sh
echo 26.7.1
EOF
cat >"$stubs/softwareupdate" <<'EOF'
#!/bin/sh
stub-terminal-check softwareupdate
echo softwareupdate >>"$STUB_LOG/calls"
if [ -s "$STUB_LOG/updates" ]; then cat "$STUB_LOG/updates"; else echo "No new software available." >&2; fi
EOF
# STUB_PNPM_CTRL_C: the owner presses Ctrl-C during `pnpm update`, which the
# terminal sends to its foreground process group. The step handles it and
# finishes its own work, the harder case for the run to notice.
cat >"$stubs/pnpm" <<'EOF'
#!/bin/sh
stub-terminal-check pnpm
echo "pnpm $*" >>"$STUB_LOG/calls"
if [ "${STUB_PNPM_CTRL_C:-0}" = 1 ] && [ "$1" = update ]; then
  trap '' INT
  kill -INT -- "-$(ps -o tpgid= -p $$ | tr -d ' ')"
fi
case $1 in
  ls) echo '[{"dependencies":{"gh-axi":{},"lavish-axi":{},"chrome-devtools-axi":{},"agent-device":{}}}]' ;;
  *) [ "${STUB_PNPM_FAIL:-0}" = 0 ] ;;
esac
EOF
cat >"$stubs/brew" <<'EOF'
#!/bin/sh
echo "brew $*" >>"$STUB_LOG/calls"
[ "${STUB_BREW_KILL:-0}" = 1 ] && kill -KILL "$(cat "$HOME/.local/state/dotfiles-autoupdate/lock/pid")"
# STUB_BREW_OUTPUT: a failed upgrade, as brew printed it.
if [ -n "${STUB_BREW_OUTPUT:-}" ]; then cat "$STUB_BREW_OUTPUT" >&2; exit 1; fi
# STUB_BREW_SUDO: a cask whose .pkg needs sudo. Like sudo, it can prompt only
# in a terminal (STUB_TTY) and from that terminal's foreground process group.
# In the terminal it also records whether it has the terminal as stdin, and
# whether its output reaches the log while it runs.
if [ "${STUB_BREW_SUDO:-0}" = 1 ]; then
  echo "==> Upgrading karabiner-elements"
  if [ -n "${STUB_TTY:-}" ]; then
    [ -t 0 ] && echo "brew stdin is the terminal" >>"$STUB_LOG/calls"
    for _ in $(seq 50); do
      if grep -q "Upgrading karabiner" "$HOME/Library/Logs/dotfiles-sync.log" 2>/dev/null; then
        echo "brew output is live" >>"$STUB_LOG/calls"
        break
      fi
      /bin/sleep 0.1
    done
  fi
  if [ -n "${STUB_TTY:-}" ] && [ "$(ps -o pgid= -p $$ | tr -d ' ')" = "$(ps -o tpgid= -p $$ | tr -d ' ')" ]; then
    echo "sudo prompted" >>"$STUB_LOG/calls"
  else
    echo "sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper" >&2
    echo "Error: karabiner-elements: Failure while executing; \`/usr/bin/sudo -u root -- /usr/sbin/installer\` exited with 1." >&2
    exit 1
  fi
fi
EOF
# nix-store -qR <system>: the fake system's closure file.
cat >"$stubs/nix-store" <<'EOF'
#!/bin/sh
[ "$1" = -qR ] || exit 2
cat "$2/closure"
EOF
# darwin-rebuild switch --flake <ref>: records the revision it would build
# (exact ?rev=, or the checkout's HEAD, -dirty with tracked edits), then
# activates a fake system built from it. STUB_HM_BROKEN leaves Home Manager
# on its old generation, as the brew bundle abort of Aug-Oct 2026 did.
cat >"$stubs/darwin-rebuild" <<'EOF'
#!/usr/bin/env bash
[ "$1" = switch ] && [ "$2" = --flake ] || exit 2
ref=$3
if [[ $ref == *'?rev='* ]]; then
  rev=${ref#*\?rev=}; rev=${rev%%#*}
else
  rev=$(git -C "${ref%%#*}" rev-parse HEAD)
  [ -z "$(git -C "${ref%%#*}" status --porcelain --untracked-files=no)" ] || rev=$rev-dirty
fi
echo "$rev" >>"$STUB_LOG/built"
[ "${STUB_SWITCH_EXIT:-0}" = 0 ] || exit "$STUB_SWITCH_EXIT"
sys=$(mksystem "$rev")
ln -sfn "$sys" "$AUTOUPDATE_SYSTEM"
[ "${STUB_HM_BROKEN:-0}" = 1 ] || ln -sfn "$(cat "$sys/closure")" "$HM_GCROOT"
EOF
# mksystem <rev>: a fake nix-darwin generation built from <rev>.
cat >"$stubs/mksystem" <<'EOF'
#!/usr/bin/env bash
n=$(ls "$SYSTEMS" | wc -l | tr -d ' ')
sys="$SYSTEMS/$n-darwin-system" gen="$SYSTEMS/$n-home-manager-generation"
mkdir -p "$sys" "$gen"
printf '{\n  "darwinLabel": "26.11.test",\n  "configurationRevision": "%s"\n}\n' "$1" >"$sys/darwin-version.json"
echo "$gen" >"$sys/closure"
echo "$sys"
EOF
chmod +x "$stubs"/*

# at <YYYY-MM-DD HH:MM>: sets the fake clock, seconds pinned to :00 (without
# them, date -j takes the real clock's seconds, and "7 days later" could land
# a few seconds short when a run crossed a minute).
at() { FAKE_NOW=$(/bin/date -j -f '%Y-%m-%d %H:%M:%S' "$1:00" +%s); export FAKE_NOW; }

# fresh: origin with one pushed commit A, a clean checkout of it on main, and
# the running system built from A with Home Manager applied.
fresh() {
  [ -d "$tmp/s" ] && rm -rf "$tmp/s"
  s="$tmp/s"
  home="$s/home"
  root_home="$s/root"
  mkdir -p "$home/.local/state/home-manager/gcroots" "$home/Library/Logs" "$root_home" "$s/log" "$s/systems" "$s/daemon"
  touch "$s/log/calls"
  touch "$s/log/calls"
  export STUB_LOG="$s/log" SYSTEMS="$s/systems"
  export AUTOUPDATE_USER=testuser AUTOUPDATE_HOST=testhost AUTOUPDATE_HOME="$home"
  export AUTOUPDATE_SYSTEM="$s/current-system" AUTOUPDATE_DAEMON_DIR="$s/daemon"
  export AUTOUPDATE_STAMP="$s/daemon/stamp"
  export HM_GCROOT="$home/.local/state/home-manager/gcroots/current-home"
  unset STUB_OFFLINE STUB_REBUILD_RUNNING STUB_PNPM_FAIL STUB_PNPM_CTRL_C STUB_BREW_OUTPUT STUB_BREW_SUDO STUB_TTY STUB_BREW_KILL STUB_SWITCH_EXIT STUB_HM_BROKEN
  at "2026-10-11 12:00"
  git init -q --bare -b main "$s/origin.git"
  git clone -q "$s/origin.git" "$s/upstream" 2>/dev/null
  echo '{}' >"$s/upstream/flake.lock"
  commit_upstream "A: initial"
  A=$(git -C "$s/upstream" rev-parse HEAD)
  git clone -q "$s/origin.git" "$home/dotfiles"
  git -C "$home/dotfiles" config user.email t@example.com
  git -C "$home/dotfiles" config user.name t
  local sys
  sys=$(PATH="$stubs:$PATH" mksystem "$A")
  ln -sfn "$sys" "$AUTOUPDATE_SYSTEM"
  ln -sfn "$(cat "$sys/closure")" "$HM_GCROOT"
}

# commit_upstream <msg> [file]: a commit pushed to origin at the fake time.
commit_upstream() {
  local f=${2:-notes}
  echo "$1" >>"$s/upstream/$f"
  git -C "$s/upstream" add -A
  GIT_AUTHOR_DATE="$FAKE_NOW +0800" GIT_COMMITTER_DATE="$FAKE_NOW +0800" \
    git -C "$s/upstream" -c user.email=t@example.com -c user.name=t commit -qm "$1"
  git -C "$s/upstream" push -q origin main
}

# commit_local <msg>: a commit on the checkout's main that is not pushed.
commit_local() {
  echo "$1" >>"$home/dotfiles/notes"
  git -C "$home/dotfiles" add -A
  GIT_AUTHOR_DATE="$FAKE_NOW +0800" GIT_COMMITTER_DATE="$FAKE_NOW +0800" \
    git -C "$home/dotfiles" commit -qm "$1"
}

# as <home> cmd...: runs cmd with a clean environment, as launchd would, on
# $as_path.
as_path="$stubs:$real:/usr/bin:/bin:/usr/sbin:/sbin"
as() {
  local h=$1 v vars=()
  shift
  for v in $(compgen -e | grep -E '^(AUTOUPDATE|STUB)_'); do vars+=("$v=${!v}"); done
  env -i HOME="$h" TZ="$TZ" PATH="$as_path" FAKE_NOW="$FAKE_NOW" \
    SYSTEMS="$SYSTEMS" HM_GCROOT="$HM_GCROOT" "${vars[@]}" "$@"
}

# ── Adapter: how this suite drives the updater and reads what it reports ──
# tick: one hourly launchd tick of every updater job, at the fake time.
tick() {
  as "$home" bash "$script" sync </dev/null >>"$s/log/out" 2>&1 || true
  as "$root_home" bash "$script" apply </dev/null >>"$s/log/out" 2>&1 || true
}
# alarms: what reaches the owner (zsh banner, agent board, SessionStart hook).
alarms() { as "$home" bash "$script" status --alarms; }
# report: everything the updater reports, alarms and info.
report() { as "$home" bash "$script" status; }
# ─────────────────────────────────────────────────────────────────────────

running_rev() { sed -n 's/.*"configurationRevision": *"\([^"]*\)".*/\1/p' "$AUTOUPDATE_SYSTEM/darwin-version.json"; }
built() { cat "$s/log/built" 2>/dev/null || true; }
calls() { grep -c "^$1" "$s/log/calls" 2>/dev/null || true; }

# expect_alarm <name> <regex>: some alarm line matches.
expect_alarm() {
  local got; got=$(alarms)
  if grep -Eq -- "$2" <<<"$got"; then ok "$1"; else bad "$1" "want alarm matching: $2" "got: ${got:-<none>}"; fi
}
expect_report() {
  local got; got=$(report)
  if grep -Eq -- "$2" <<<"$got"; then ok "$1"; else bad "$1" "want report matching: $2" "got: ${got:-<none>}"; fi
}
expect_no_alarm() {
  local got; got=$(alarms)
  if [ -z "$got" ]; then ok "$1"; else bad "$1" "want no alarm" "got: $got"; fi
}
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "want: $3" "got: $2"; fi; }

# 1. Boot relinks /run/current-system; the old daemon read that as "already
# switched today" and skipped the day with no log line.
fresh
at "2026-10-12 02:00"; commit_upstream "C: flake.lock bump" flake.lock
C=$(git -C "$s/upstream" rev-parse HEAD)
touch -h -t 202610120500 "$AUTOUPDATE_SYSTEM"
at "2026-10-12 06:00"; tick; tick
expect_eq "boot relink does not skip the day" "$(running_rev)" "$C"

# 2. Unpushed commits on local main must never be applied as root.
fresh
at "2026-10-12 01:00"; commit_local "L: unpushed"
L=$(git -C "$home/dotfiles" rev-parse HEAD)
at "2026-10-12 05:00"; tick; tick
if built | grep -q "^$L"; then bad "unpushed local commits are never applied" "built: $(built | tr '\n' ' ')"
else ok "unpushed local commits are never applied"; fi

fresh
at "2026-10-12 01:00"; commit_local "L: unpushed"
L=$(git -C "$home/dotfiles" rev-parse HEAD)
at "2026-10-12 02:00"; commit_upstream "C: flake.lock bump" flake.lock
C=$(git -C "$s/upstream" rev-parse HEAD)
at "2026-10-12 05:00"; tick; tick
expect_eq "diverged main still gets origin/main applied, never the local commit" "$(built | tr '\n' ' ')" "$C "

# 3. A running system built from unpushed work waits for the push, then
# alarms after 36 h instead of being rolled back.
fresh
at "2026-10-12 01:00"; commit_local "L: unpushed"
L=$(git -C "$home/dotfiles" rev-parse HEAD)
ln -sfn "$(PATH="$stubs:$PATH" mksystem "$L")" "$AUTOUPDATE_SYSTEM"
ln -sfn "$(cat "$AUTOUPDATE_SYSTEM/closure")" "$HM_GCROOT"
at "2026-10-12 02:00"; commit_upstream "C: flake.lock bump" flake.lock
at "2026-10-12 05:00"; tick; tick
expect_eq "running unpushed work is not rolled back" "$(running_rev)" "$L"
expect_report "running unpushed work reports waiting for push" "waiting for push"
expect_no_alarm "waiting for push is not an alarm at first"
at "2026-10-13 18:00"; tick
expect_alarm "waiting for push alarms after 36 h" "waiting for push"

fresh
ln -sfn "$(PATH="$stubs:$PATH" mksystem "$A-dirty")" "$AUTOUPDATE_SYSTEM"
ln -sfn "$(cat "$AUTOUPDATE_SYSTEM/closure")" "$HM_GCROOT"
at "2026-10-12 02:00"; commit_upstream "C: flake.lock bump" flake.lock
at "2026-10-12 05:00"; tick; tick
expect_eq "a system built from uncommitted edits is not rolled back" "$(running_rev)" "$A-dirty"

# 4. A pnpm failure must reach the owner; the old daemon only printed "warn".
fresh
export STUB_PNPM_FAIL=1
at "2026-10-12 05:00"; tick; tick
expect_alarm "pnpm failure raises an alarm" "pnpm"

# 5. Nothing ran at all: the old daemon had nothing to write, so no alarm.
fresh
at "2026-10-14 09:00"
expect_alarm "an updater that never ran raises an alarm" "never"

fresh
at "2026-10-12 05:00"; tick; tick
expect_no_alarm "a clean run raises no alarm"
at "2026-10-14 06:00"
expect_alarm "an updater that stops running alarms after 36 h" "no successful run"

# 6. The happy path: origin/main moves, the checkout fast-forwards, the
# system switches to exactly that revision once, and no alarm is raised.
fresh
at "2026-10-12 02:00"; commit_upstream "C: flake.lock bump" flake.lock
C=$(git -C "$s/upstream" rev-parse HEAD)
at "2026-10-12 03:00"; tick
expect_eq "nothing runs before 04:00" "$(built)" ""
at "2026-10-12 04:10"; tick; tick
at "2026-10-12 05:10"; tick
expect_eq "origin/main is switched to exactly once" "$(built | tr '\n' ' ')" "$C "
expect_eq "the checkout fast-forwards to origin/main" "$(git -C "$home/dotfiles" rev-parse main)" "$C"
expect_eq "sync works once a day" "$(calls brew)" 1
expect_no_alarm "a run that switched raises no alarm"
at "2026-10-13 04:30"; tick; tick
expect_eq "nothing new on origin/main means no switch" "$(built | tr '\n' ' ')" "$C "
expect_eq "the next day syncs again" "$(calls brew)" 2

# 7. Home Manager must actually apply: an equal system path does not prove it.
fresh
ln -sfn "$s/elsewhere" "$HM_GCROOT"
at "2026-10-12 05:00"; tick; tick
expect_eq "an unapplied Home Manager is repaired by switching again" "$(built | tr '\n' ' ')" "$A "

fresh
export STUB_HM_BROKEN=1
at "2026-10-12 02:00"; commit_upstream "C: flake.lock bump" flake.lock
at "2026-10-12 05:00"; tick; tick
expect_alarm "a switch that leaves Home Manager unapplied is loud" "Home Manager"

# 8. A failed switch is loud and retried at most daily, not hourly.
fresh
export STUB_SWITCH_EXIT=1
at "2026-10-12 02:00"; commit_upstream "C: flake.lock bump" flake.lock
C=$(git -C "$s/upstream" rev-parse HEAD)
at "2026-10-12 05:00"; tick; tick
expect_alarm "a failed switch raises an alarm" "switch"
at "2026-10-12 06:00"; tick
at "2026-10-12 07:00"; tick
expect_eq "a failed revision is not retried hourly" "$(built | wc -l | tr -d ' ')" 1
unset STUB_SWITCH_EXIT
at "2026-10-13 05:30"; tick; tick
expect_eq "a failed revision is retried the next day" "$(running_rev)" "$C"
expect_no_alarm "a successful retry clears the alarm"

# 9. A fetch failure (the 10 Oct credential error) is loud and stops the
# handoff; it is the forced failure used on the real Mac.
fresh
git -C "$home/dotfiles" remote set-url origin "$s/unreachable.git"
at "2026-10-12 05:00"; tick; tick
expect_alarm "an unreachable remote raises an alarm" "fetch"
expect_eq "nothing is switched when the fetch fails" "$(built)" ""

# 10. brew names the cask that failed and how to finish it.
fresh
export STUB_BREW_SUDO=1
at "2026-10-12 05:00"; tick; tick
expect_alarm "a brew failure names the cask and the fix" "karabiner-elements.*autoupdate-now"

# 11. Offline ticks retry next hour instead of burning the day.
fresh
export STUB_OFFLINE=1
at "2026-10-12 05:00"; tick
expect_eq "an offline tick does nothing" "$(calls brew)" 0
unset STUB_OFFLINE
at "2026-10-12 06:00"; tick
expect_eq "the next online tick runs the day's sync" "$(calls brew)" 1

# 12. A human rebuild in flight defers the switch.
fresh
at "2026-10-12 02:00"; commit_upstream "C: flake.lock bump" flake.lock
export STUB_REBUILD_RUNNING=1
at "2026-10-12 05:00"; tick; tick
expect_eq "a rebuild in flight defers the switch" "$(built)" ""
expect_eq "a rebuild in flight defers the sync and its brew upgrade" "$(calls brew)" 0
unset STUB_REBUILD_RUNNING
at "2026-10-12 06:00"; tick
expect_eq "the switch follows once the rebuild is done" "$(built)" "$(git -C "$s/upstream" rev-parse HEAD)"

# 13. The cloud routine watchdog: flake.lock on origin/main older than 3 days.
fresh
at "2026-10-16 05:00"; tick; tick
expect_alarm "an old flake.lock raises an alarm" "flake.lock"

# 14. A sync killed mid-run is not silent.
fresh
export STUB_BREW_KILL=1
at "2026-10-12 05:00"; tick
unset STUB_BREW_KILL
at "2026-10-12 05:30"
expect_no_alarm "a run in progress is not an alarm"
at "2026-10-12 08:00"
expect_alarm "a run that never finished alarms after 2 h" "never finished"

# 15. Pending macOS updates: same major (26.x) alarms after 7 days pending,
# a major upgrade (27.x) and other updates never alarm.
fresh
cat >"$s/log/updates" <<'EOF'
Software Update Tool

Finding available software
Software Update found the following new or updated software:
* Label: Command Line Tools for Xcode 27.0-27.0
	Title: Command Line Tools for Xcode 27.0, Version: 27.0, Size: 519460KiB, Recommended: YES,
* Label: macOS Tahoe 26.7.2-25H101
	Title: macOS Tahoe 26.7.2, Version: 26.7.2, Size: 2184211KiB, Recommended: YES, Action: restart,
* Label: macOS 27.0.1-26A5434
	Title: macOS 27.0.1, Version: 27.0.1, Size: 17929043KiB, Recommended: YES, Action: restart,
EOF
for d in 12 13 14 15 16 17 18; do
  at "2026-10-$d 01:00"; commit_upstream "lock $d" flake.lock
  at "2026-10-$d 05:00"; tick; tick
done
expect_report "a same-major macOS update is reported from day 1" "info: sync: macOS Tahoe 26.7.2"
expect_no_alarm "a same-major macOS update pending 6 days is not an alarm"
at "2026-10-19 01:00"; commit_upstream "lock 19" flake.lock
at "2026-10-19 05:00"; tick; tick
expect_alarm "a same-major macOS update alarms after 7 days" "macOS Tahoe 26.7.2"
got=$(alarms)
if grep -q "27\.0" <<<"$got"; then bad "a major macOS upgrade and other updates never alarm" "got: $got"
else ok "a major macOS upgrade and other updates never alarm"; fi

# 17. A system the owner rebuilt after pushing is newer than the last handover;
# it is never rolled back, and nothing waits for a push that happened.
fresh
at "2026-10-12 05:00"; tick
at "2026-10-12 20:00"; commit_upstream "C: evening push"
C=$(git -C "$s/upstream" rev-parse HEAD)
git -C "$home/dotfiles" pull -q --ff-only
ln -sfn "$(PATH="$stubs:$PATH" mksystem "$C")" "$AUTOUPDATE_SYSTEM"
ln -sfn "$(cat "$AUTOUPDATE_SYSTEM/closure")" "$HM_GCROOT"
at "2026-10-12 21:00"; tick
expect_eq "a newer pushed rebuild is not rolled back" "$(built)" ""
got=$(report)
if grep -q "waiting for push" <<<"$got"; then bad "a newer pushed rebuild is not reported as waiting for push" "got: $got"
else ok "a newer pushed rebuild is not reported as waiting for push"; fi
ln -sfn "$s/elsewhere" "$HM_GCROOT"
at "2026-10-12 22:00"; tick
expect_eq "Home Manager on a newer pushed rebuild is repaired at that revision" "$(built)" "$C"

# 16. status is one reader for every surface; the agent board runs it with
# macOS's bash 3.2, so it must read the same there.
fresh
export STUB_BREW_SUDO=1
at "2026-10-12 01:00"; commit_local "L: unpushed"
at "2026-10-12 05:00"; tick
unset STUB_BREW_SUDO
at "2026-10-12 07:00"
expect_eq "status reports alarms, info and successes in that order" "$(report)" \
"alarm: sync: brew upgrade failed for karabiner-elements; run autoupdate-now in a terminal, where sudo can prompt; see $home/Library/Logs/dotfiles-sync.log
info: sync: local main is 1 commits ahead of origin/main, waiting for push
ok: switch: last good run 2 h ago"
expect_eq "status --alarms is the banner and SessionStart text" "$(alarms)" \
"dotfiles auto-update: sync: brew upgrade failed for karabiner-elements; run autoupdate-now in a terminal, where sudo can prompt; see $home/Library/Logs/dotfiles-sync.log
  details: dotfiles-autoupdate status"
legacy=$(env -i HOME="$home" TZ="$TZ" PATH="$stubs:/usr/bin:/bin" FAKE_NOW="$FAKE_NOW" \
  AUTOUPDATE_HOME="$home" AUTOUPDATE_DAEMON_DIR="$AUTOUPDATE_DAEMON_DIR" /bin/bash "$script" status)
expect_eq "status reads the same under macOS's bash 3.2" "$legacy" "$(report)"

# 18. A runner that is installed but has not run yet still shows, so the
# board's card never looks like it tracks one runner. A failure that already
# names its log is not pointed at it twice.
fresh
at "2026-10-12 03:00"; tick
at "2026-10-12 03:30"
expect_report "an installed runner that has not run yet is reported" "^ok: sync: no run yet, installed 30 min ago$"
export STUB_SWITCH_EXIT=1
at "2026-10-12 04:00"; commit_upstream "C: push"
at "2026-10-12 05:00"; tick
unset STUB_SWITCH_EXIT
got=$(alarms)
if [ "$(grep -o 'see /' <<<"$got" | wc -l | tr -d ' ')" = 1 ]; then ok "a failure that names its log is pointed at it once"
else bad "a failure that names its log is pointed at it once" "got: $got"; fi

# 19. The alarm's advice follows brew's cause. On 14 Oct 2026 four casks
# failed to download and the alarm said to run autoupdate-now where sudo can
# prompt; a download failure is the network, and the next run retries.
cat >"$tmp/brew-download.out" <<'EOF'
==> Fetching downloads for: chatgpt, cursor, discord, google-chrome and visual-studio-code
✔︎ Cask visual-studio-code (1.141.1)
✘ Cask google-chrome (155.0.8059.80)
Error: Download failed on Cask 'google-chrome' with message: Download failed: https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg
curl: (56) Recv failure: Connection reset by peer
✘ Cask cursor (3.24.18,be4c9e5350d77747b42cd467cbd3370a753d464b)
Error: Download failed on Cask 'cursor' with message: Download failed: https://downloads.cursor.com/production/be4c9e5350d77747b42cd467cbd3370a753d464b/darwin/arm64/Cursor-darwin-arm64.zip
curl: (56) Recv failure: Connection reset by peer
✘ Cask chatgpt (26.1007.41230)
Error: Download failed on Cask 'chatgpt' with message: Download failed: https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-26.1007.41230.zip
curl: (56) Recv failure: Connection reset by peer
✘ Cask discord (0.0.416)
Error: Download failed on Cask 'discord' with message: Download failed: https://dl.discordapp.net/apps/osx/0.0.416/Discord.dmg
curl: (56) Recv failure: Connection reset by peer
Error: chatgpt: Download failed for chatgpt.
Error: cursor: Download failed for cursor.
Error: discord: Download failed for discord.
Error: google-chrome: Download failed for google-chrome.
==> Upgrading visual-studio-code
🍺  visual-studio-code was successfully upgraded!
EOF
fresh
export STUB_BREW_OUTPUT="$tmp/brew-download.out"
at "2026-10-12 05:00"; tick; tick
expect_alarm "a brew download failure names the casks and says the next run retries" \
  "could not download chatgpt, cursor, discord, google-chrome.*next daily run retries"
got=$(alarms)
if grep -q sudo <<<"$got"; then bad "a brew download failure does not send the owner to sudo" "got: $got"
else ok "a brew download failure does not send the owner to sudo"; fi

printf '%s\n' "==> Upgrading foo" \
  "Error: foo: It seems there is already an App at '/Applications/Foo.app'." >"$tmp/brew-other.out"
fresh
export STUB_BREW_OUTPUT="$tmp/brew-other.out"
at "2026-10-12 05:00"; tick; tick
expect_alarm "any other brew failure names the cask and points at the log" "brew upgrade failed for foo; see "
got=$(alarms)
if grep -Eq 'sudo|network' <<<"$got"; then bad "any other brew failure guesses no cause" "got: $got"
else ok "any other brew failure guesses no cause"; fi

# 20. autoupdate-now, typed in a terminal, runs the dotfiles-sync agent's own
# program. On 14 Oct 2026 it ran the checkout on the shell's PATH, which has
# no timeout (macOS ships none), and every step failed. With timeout on PATH,
# brew's captured output, /dev/null stdin and timeout's background process
# group then kept sudo from prompting, and the terminal stopped taking input.
# After that fix, pnpm, still under plain timeout and given the terminal,
# asked which builds to approve from a background process group, stopped, and
# the terminal took no input, not even Ctrl-C.
darwin="$repo#darwinConfigurations.myhost.config"
hm="$darwin.home-manager.users.myuser"
alias_cmd=$(nix eval --raw "$hm.programs.zsh.shellAliases.autoupdate-now")
agent=$(nix eval --raw "$hm.launchd.agents.dotfiles-sync.config.ProgramArguments" --apply builtins.head)
daemon=$(nix eval --raw "$darwin.launchd.daemons.dotfiles-autoupdate.command")
expect_eq "autoupdate-now runs the dotfiles-sync agent's program" "${alias_cmd%% *}" "$agent"
expect_eq "the root daemon runs the same program" "${daemon%% *}" "$agent"
built_by=$(nix eval --json "$hm.programs.zsh.shellAliases.autoupdate-now" \
  --apply 'a: map (d: d + "^*") (builtins.attrNames (builtins.getContext a))' | jq -r '.[]')
# shellcheck disable=SC2086 # one installable per derivation
[ -z "$built_by" ] || nix build --no-link $built_by
terminal="$tmp/terminal" # the stubs, less timeout
mkdir -p "$terminal"
for f in "$stubs"/*; do [ "${f##*/}" = timeout ] || ln -s "$f" "$terminal/"; done
fresh
export STUB_BREW_SUDO=1 STUB_TTY=1
at "2026-10-12 05:00"
as_path="$repo/scripts:$terminal:$real:/usr/bin:/bin:/usr/sbin:/sbin" \
  as "$home" script -q "$s/log/terminal" bash -c "$alias_cmd" </dev/null >/dev/null 2>&1 || true
got=$(alarms)
if grep -q timeout <<<"$got"; then bad "autoupdate-now runs on a shell PATH without timeout" "got: $got"
else ok "autoupdate-now runs on a shell PATH without timeout"; fi
expect_eq "autoupdate-now in a terminal lets sudo prompt" "$(calls "sudo prompted")" 1
expect_eq "autoupdate-now hands brew the terminal as stdin" "$(calls "brew stdin is the terminal")" 1
expect_eq "autoupdate-now shows brew's output as it runs, and logs it" "$(calls "brew output is live")" 1
got=$(alarms | grep 'sync:' || true)
if [ -z "$got" ]; then ok "autoupdate-now in a terminal finishes the sync with no alarm"
else bad "autoupdate-now in a terminal finishes the sync with no alarm" "got: $got"; fi
expect_eq "a terminal run keeps every step in the terminal's foreground process group" \
  "$(grep "outside the terminal's foreground" "$s/log/calls" | sort -u)" ""
expect_eq "a terminal run gives the terminal only to brew, so nothing else prompts" \
  "$(grep "had the terminal as stdin" "$s/log/calls" | sort -u)" ""
steps="sync
git fetch origin
pnpm globals
brew upgrade
macOS updates
sync done"
expect_eq "a terminal run shows each step" \
  "$(tr -d '\r' <"$s/log/terminal" | sed -n 's/^.*[0-9]\{4\}-[0-9-]\{5\} [0-9:]\{8\} [-=]\{3\} //p')" "$steps"
expect_eq "a terminal run copies its steps to the sync log" \
  "$(sed -n 's/^.*[0-9]\{4\}-[0-9-]\{5\} [0-9:]\{8\} [-=]\{3\} //p' "$home/Library/Logs/dotfiles-sync.log")" "$steps"

# 21. Ctrl-C in a terminal run stops it after the step it interrupts, even a
# step that handles the signal itself, and the status says so. A shell gives
# its foreground job the default SIGINT; a background one, such as a test
# runner started with &, would pass on an ignored one, so reset it.
coreutils=$(nix eval --raw "$repo#darwinConfigurations.myhost.pkgs.coreutils.outPath")
fresh
export STUB_TTY=1 STUB_PNPM_CTRL_C=1
at "2026-10-12 05:00"
as_path="$repo/scripts:$terminal:$real:/usr/bin:/bin:/usr/sbin:/sbin" \
  as "$home" "$coreutils/bin/env" --default-signal=INT \
  script -q "$s/log/terminal" bash -c "$alias_cmd" </dev/null >/dev/null 2>&1 || true
expect_eq "Ctrl-C in a terminal run stops it before the next step" "$(calls brew)" 0
expect_alarm "a run stopped by Ctrl-C says so" "sync: interrupted \(Ctrl-C\)"

# 22. A Lavish server left running from a package that a pnpm update deleted
# answers 500 for its page assets and every page is blank (16 Oct 2026).
# status alarms on it, never on a healthy server, no server, or another app.
fresh
at "2026-10-12 05:00"; tick
expect_no_alarm "no Lavish server running is no alarm"
STUB_LAVISH=200 expect_no_alarm "a Lavish server serving its assets is no alarm"
STUB_LAVISH=404 STUB_LAVISH_APP=other expect_no_alarm "another app on the Lavish port is no alarm"
STUB_LAVISH=500 expect_alarm "a Lavish server failing its assets alarms with the fix" \
  "^dotfiles auto-update: lavish: the server on :4387 answers 500 for its page assets, so every Lavish page is blank; run lavish-axi --restart-stale-server$"
legacy=$(env -i HOME="$home" TZ="$TZ" PATH="$stubs:/usr/bin:/bin" FAKE_NOW="$FAKE_NOW" STUB_LAVISH=500 \
  AUTOUPDATE_HOME="$home" AUTOUPDATE_DAEMON_DIR="$AUTOUPDATE_DAEMON_DIR" /bin/bash "$script" status)
expect_eq "the Lavish alarm reads the same under macOS's bash 3.2" "$legacy" "$(STUB_LAVISH=500 report)"

exit "$fail"
