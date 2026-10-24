#!/usr/bin/env bash
# Daily unattended update of this Mac, split by privilege (review of 11 Oct
# 2026, design B). Each step runs where its credential and privilege live.
#
#   sync     myuser's launchd agent (nix/user.nix), in his GUI session, where
#            the login keychain answers. Hourly: fetch origin, fast-forward
#            ~/dotfiles, hand the fetched origin/main revision to the daemon
#            (sync.status), publish it to the public mirror, and notify
#            the owner of a switch that needs him.
#            Daily from 04:00 (daily.status): update pnpm globals, brew
#            upgrade, report pending macOS updates. A `--now` run does both;
#            before 04:00 it leaves the day's run to come.
#            `autoupdate-now` runs the same program in a terminal, which
#            shows each step and where sudo can prompt for brew.
#   apply    the root launchd daemon (nix/host.nix). Hourly: switches the
#            system to exactly the handed-over revision, never the working
#            tree, and never rolls back a system built from unpushed work.
#   rebuild  the owner's `rebuild` alias (nix/user.nix), under sudo: the same
#            switch, holding the switch lock apply decides and switches under.
#   rollback the owner's `rollback` alias (nix/user.nix), under sudo, for the
#            SUDO_USER: switches back a generation under the same switch lock.
#   status   the one reader of the status files, used by the zsh banner, the
#            agent board and the SessionStart hook. Prints alarms, info and
#            the last success of each runner, and alarms on a flake.lock on
#            origin/main 4 or more days old (check_flake_lock) and a
#            Sill.app signed by anyone but its developer (check_sill).
#
# launchd runs /nix/store copies of this file; root never runs the checkout.
# `status` must also run under macOS's bash 3.2 (the agent board calls it).
# Tests: tests/autoupdate_test.sh.
set -uo pipefail

user=${AUTOUPDATE_USER:-$(id -un)}
case ${1:-} in rollback | rollback-locked) user=${AUTOUPDATE_USER:-${SUDO_USER:-$user}} ;; esac
home=${AUTOUPDATE_HOME:-/Users/$user}
repo=$home/dotfiles
sync_dir=$home/.local/state/dotfiles-autoupdate
daemon_dir=${AUTOUPDATE_DAEMON_DIR:-/var/db/dotfiles-autoupdate}
system=${AUTOUPDATE_SYSTEM:-/run/current-system}
sync_log=$home/Library/Logs/dotfiles-sync.log
daemon_log=/var/log/dotfiles-autoupdate.log
switch_lock=$daemon_dir/switch.lock
# The runner's deferred reload (nix/github-runner.nix, scripts/github-runner).
runner_status=${AUTOUPDATE_RUNNER_STATUS:-/var/lib/github-runner/reload.status}
runner_reload=${AUTOUPDATE_RUNNER_RELOAD:-/var/run/github-runner-reload}
runner_firewall_log=/var/log/github-runner-firewall.log

stale_after=$((36 * 3600))    # no successful run for this long is an alarm
running_after=$((2 * 3600))   # a run unfinished for this long was killed
push_after=$((2 * 3600))      # waiting for push this long alarms and notifies
macos_after=$((7 * 86400))    # a same-major macOS update pending this long
retry_after=86400             # a failed revision is retried at most daily
rebuild_wait=${AUTOUPDATE_REBUILD_WAIT:-1800} # rebuild waits this long for apply's switch

terminal=  # set when sync runs in a terminal (autoupdate-now)

log() { # a terminal run also copies its lines to the sync log
  local line
  line="$(date '+%F %T') $*"
  echo "$line"
  [ -z "$terminal" ] || echo "$line" >>"$sync_log"
}

# Every step that can hang runs under timeout, which moves the step to a
# process group of its own. Unattended, that lets it kill the step's children
# too. In a terminal, a step in that background group stops (SIGTTIN/SIGTTOU)
# as soon as it reads the terminal or changes its mode, and Ctrl-C cannot
# reach it: on 14 Oct 2026 pnpm stopped there on a build-approval prompt and
# the terminal took no input. A terminal run keeps each step in the foreground.
timed() { # timed <seconds> <command>...
  if [ -n "$terminal" ]; then timeout --foreground "$@"; else timeout "$@"; fi
}
last_line() { printf '%s\n' "$1" | sed '/^[[:space:]]*$/d' | tail -n 1; }

# ── Status files ──────────────────────────────────────────────────────────
# One per runner, tab-separated, replaced whole by rename:
#   installed <epoch>        first time this runner ran on this machine
#   ok <epoch>               last run that finished with no failure
#   ran <epoch>              last run that finished
#   running <epoch>          a run started and has not finished
#   fail <text>              a step of the last run failed
#   note <key> <since> <alarm-after-seconds, 0 = never> <text>
# A note keeps its `since` across runs while its key stays the same.

prev_field() { [ -f "$status" ] && awk -F '\t' -v k="$1" '$1 == k { print $2; exit }' "$status"; }
prev_since() { [ -f "$status" ] && awk -F '\t' -v k="$1" '$1 == "note" && $2 == k { print $3; exit }' "$status"; }

records=()
failed=0
fail() { records+=("fail	$*"); failed=1; log "FAILED: $*"; }
note() { # note <key> <alarm-after> <text>
  local since
  since=$(prev_since "$1")
  records+=("note	$1	${since:-$now}	$2	$3")
  [ -n "$since" ] || log "$3"
}

write_status() { # write_status <line>...: replaces $status atomically
  local tmp
  tmp=$(mktemp "$status.XXXXXX") || return 1
  printf '%s\n' "$@" >"$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$status"
}

begin() { # begin: makes sure $status exists, so a runner that stops is noticed
  mkdir -p "$(dirname "$status")"
  [ -f "$status" ] || write_status "installed	$now"
}

mark_running() { # keeps the last results, adds a running marker
  local lines=() line
  while IFS= read -r line; do
    case $line in running*) ;; *) lines+=("$line") ;; esac
  done <"$status"
  write_status "${lines[@]}" "running	$now"
}

finish() {
  local ok
  ok=$(prev_field ok)
  [ "$failed" = 1 ] || ok=$now
  write_status "installed	$(prev_field installed)" ${ok:+"ok	$ok"} "ran	$now" \
    ${records[@]+"${records[@]}"}
}

# ── sync: myuser's agent ─────────────────────────────────────────────────────
cmd_sync() {
  now=$(date +%s)
  # Every step reads /dev/null, as under launchd, so none of them prompts in
  # a terminal either; only brew gets the terminal, for sudo (sync_brew).
  if { : </dev/tty; } 2>/dev/null; then terminal=1; fi
  exec </dev/null
  mkdir -p "$sync_dir" || return 1
  # Hourly, the hand-over, so a push goes live within the hour (the owner, 16 Oct
  # 2026). Daily from 04:00, after the cloud routine's 02:00 SGT flake.lock
  # bump, the heavy steps too. `--now` runs both.
  local daily=1 now_run=
  [ "${1:-}" != --now ] || now_run=1
  if [ -z "$now_run" ]; then
    if [ "$(date +%H)" -lt 4 ] || [ "$(cat "$sync_dir/day" 2>/dev/null)" = "$(date +%F)" ]; then
      daily=
    fi
  fi
  if ! mkdir "$sync_dir/lock" 2>/dev/null; then
    if kill -0 "$(cat "$sync_dir/lock/pid" 2>/dev/null)" 2>/dev/null; then
      echo "another sync is running (pid $(cat "$sync_dir/lock/pid"))" >&2
      return 1
    fi
    rm -rf "$sync_dir/lock" && mkdir "$sync_dir/lock" || return 1
  fi
  echo $$ >"$sync_dir/lock/pid"
  trap 'rm -rf "$sync_dir/lock"' EXIT
  # A switch in flight (a rebuild also reloads this agent) runs its own brew
  # bundle. Both jobs fire together on wake, so each takes its own lock before
  # it checks the other's: one of them always sees the other and waits.
  if switch_running; then
    [ -z "$now_run" ] || log "a switch is running; retry autoupdate-now after it finishes"
    return 0
  fi
  # Before the hourly split, sync.status held the daily results too. Keep
  # them, including unresolved failures and note ages, until daily work runs
  # again. Migrate under the sync lock, before the hourly status is replaced.
  status=$sync_dir/daily.status
  if [ ! -f "$status" ] && [ -f "$sync_dir/sync.status" ]; then
    write_status "$(cat "$sync_dir/sync.status")" || return 1
  fi
  for status in "$sync_dir/sync.status" "$sync_dir/daily.status"; do begin || return 1; done
  notify_switch

  # Ticks right after wake can beat Wi-Fi; offline means retry next hour.
  local online='' try
  for try in $(seq 30); do
    curl -fsS -o /dev/null --max-time 5 https://github.com && { online=1; break; }
    [ "$try" != 1 ] || log "--- waiting up to 8 min for github.com"
    sleep 10
  done
  [ -n "$online" ] || { log "github.com is unreachable; the next tick retries"; return 0; }
  # A `--now` run before 04:00 is extra: on 16 Oct 2026 one at 01:40 took the
  # day's place, saw the lock from before the bump, and nothing handed over
  # the bump that day.
  if [ -n "$daily" ]; then
    [ "$(date +%H)" -lt 4 ] || date +%F >"$sync_dir/day"
    log "=== sync"
  fi
  # Ctrl-C in a terminal run reaches the running step (timed); the run then
  # stops after that step, whether the step died of it or handled it, and
  # records why instead of leaving a run that never finished.
  trap 'fail "interrupted (Ctrl-C)"; finish; exit 130' INT

  phase sync
  local out fetched='' handed
  [ -z "$daily" ] || log "--- git fetch origin"
  if out=$(GIT_TERMINAL_PROMPT=0 timed 300 git -C "$repo" fetch --quiet origin 2>&1); then
    fetched=$(git -C "$repo" rev-parse --verify -q refs/remotes/origin/main)
  else
    fail "git fetch from origin failed: $(last_line "$out")"
  fi
  if [ -n "$fetched" ]; then
    sync_main "$fetched"
    # The daemon waits while this sync holds its lock, so the switch's own
    # brew bundle never races the brew upgrade below.
    handed=$(cat "$sync_dir/revision" 2>/dev/null)
    printf '%s\n' "$fetched" >"$sync_dir/revision.tmp" && mv -f "$sync_dir/revision.tmp" "$sync_dir/revision"
    [ -z "$daily" ] && [ "$fetched" = "$handed" ] || log "handed origin/main ${fetched:0:12} to the daemon"
    sync_public "$([ -z "$daily" ] && [ "$fetched" = "$handed" ] || echo 1)"
  fi
  finish

  [ -n "$daily" ] || return 0
  phase daily
  sync_pnpm
  if switch_running; then
    # A rebuild the owner started during pnpm: leave brew to it, and the day's
    # run to the next tick.
    rm -f "$sync_dir/day"
    log "a switch started; brew upgrade waits for the next tick"
    finish
    return 0
  fi
  sync_brew
  sync_macos
  finish
  log "=== sync done"
}

# switch_running: a darwin-rebuild, or the daemon between its check of the
# sync lock and its switch. The daemon runs as root, so kill -0 cannot probe
# its pid from here; ps can.
switch_running() {
  pgrep -qf darwin-rebuild && return 0
  local pid
  pid=$(cat "$daemon_dir/switching" 2>/dev/null)
  [ -n "$pid" ] && ps -p "$pid" >/dev/null 2>&1
}

phase() { # phase <sync|daily>: the steps that follow report to that status file
  status=$sync_dir/$1.status
  records=()
  failed=0
  mark_running
}

# The switch runs as root, which cannot reach the owner's screen. This agent runs
# in his GUI session, so it posts a notification for each switch state he
# must act on: a failed switch, or one waiting longer than push_after. Each
# state notifies once; a state that clears and comes back notifies again.
# Nothing else notifies: the board and the zsh banner show every alarm. The
# daemon starts a note's clock at ten past and this agent reads it on the
# hour, so a waiting notification follows the board's alarm by under an hour.
notify_switch() {
  local file=$daemon_dir/status sent=$sync_dir/notified kind a b c d key keys='' text
  [ -f "$file" ] || return 0
  while IFS='	' read -r kind a b c d; do
    case $kind in
      fail) key="fail $a" text=$a ;;
      note) [ "$c" -gt 0 ] && [ $((now - b)) -ge "$c" ] || continue
            key="note $a" text=$d ;;
      *) continue ;;
    esac
    # A notification that did not post is tried again next tick.
    if grep -qxF -- "$key" "$sent" 2>/dev/null \
      || timed 30 osascript -e 'on run argv' \
        -e 'display notification (item 1 of argv) with title "dotfiles auto-update"' \
        -e 'end run' "$text" >/dev/null 2>&1; then
      keys="$keys$key
"
    else
      log "could not post a notification: $text"
    fi
  done <"$file"
  printf '%s' "$keys" >"$sent.tmp" && mv -f "$sent.tmp" "$sent"
}

# Fast-forwards the checkout the live links point at. Local commits that are
# not on origin/main wait for the owner's push; they are not an error.
sync_main() {
  local fetched=$1 branch head out
  branch=$(git -C "$repo" branch --show-current)
  head=$(git -C "$repo" rev-parse main)
  if [ "$branch" != main ]; then
    fail "$repo is on ${branch:-a detached HEAD}, not main, so its live links are not updating"
  elif [ "$head" = "$fetched" ]; then
    :
  elif git -C "$repo" merge-base --is-ancestor "$head" "$fetched"; then
    out=$(git -C "$repo" merge --ff-only --quiet "$fetched" 2>&1) \
      || fail "could not fast-forward main to origin/main: $(last_line "$out")"
  else
    local ahead behind
    ahead=$(git -C "$repo" rev-list --count "$fetched..$head")
    behind=$(git -C "$repo" rev-list --count "$head..$fetched")
    if [ "$behind" = 0 ]; then
      note main 0 "local main is $ahead commits ahead of origin/main, waiting for push"
    else
      note main 0 "local main has $ahead commits not on origin/main and lacks $behind from it; waiting for push"
    fi
  fi
}

# Only origin/main reaches the public mirror (docs/public-mirror.md), and
# this agent publishes it: public-sync needs the owner's git credentials for both
# repos. It fetches and gates origin/main with that commit's own rules, and
# is a no-op when the mirror holds it already. A failure leaves the mirror
# behind main until a run succeeds.
public_sync=${AUTOUPDATE_PUBLIC_SYNC:-$repo/scripts/public-sync}
sync_public() { # sync_public <1 to log the result>
  local out
  if out=$(GIT_TERMINAL_PROMPT=0 timed 600 "$public_sync" --from-origin 2>&1); then
    [ -z "$1" ] || log "public mirror: $(last_line "$out")"
  else
    printf '%s\n' "$out"
    fail "the public mirror is behind main: public-sync --from-origin failed: $(last_line "$out")"
  fi
}

# pnpm globals float to their latest release, except the pins, which move only
# by reviewed commit: chrome-devtools-axi is tested against the
# chrome-devtools-mcp pin in nix/user.nix, agent-device ships several
# releases a week from one publisher, and playwright-core runs the
# verify-agent-board written flows, whose playwright.mjs names the same
# version. pnpm 12's `--latest` moves exact pins too, and a '!pkg' filter
# turns the whole update into a no-op, so update the rest by name, then
# re-assert the pins (which also installs a missing one).
pins="chrome-devtools-axi@0.1.39 agent-device@0.21.23 playwright-core@1.64.1"
# Retired globals are removed when present instead of floating: lavish-axi
# went on 20 Oct 2026, and its upstream CLI opens the default browser.
retired="lavish-axi"
sync_pnpm() {
  local listed floating stale failed_steps='' pin
  log "--- pnpm globals"
  if ! listed=$(timed 120 pnpm ls -g --depth 0 --json); then
    fail "pnpm ls -g failed; pnpm globals were not updated"
    return
  fi
  floating=$(printf '%s\n' "$listed" | jq -r --arg pins "$pins" --arg retired "$retired" \
    '($pins | split(" ") | map(sub("@[^@]*$"; ""))) as $p | ($retired | split(" ")) as $r
     | .[0].dependencies // {} | keys[] | select(IN($p[], $r[]) | not)')
  stale=$(printf '%s\n' "$listed" | jq -r --arg retired "$retired" \
    '($retired | split(" ")) as $r | .[0].dependencies // {} | keys[] | select(IN($r[]))')
  if [ -n "$stale" ]; then
    # shellcheck disable=SC2086 # one argument per package name
    timed 120 pnpm remove -g $stale || failed_steps="remove $stale"
  fi
  if [ -n "$floating" ]; then
    # shellcheck disable=SC2086 # one argument per package name
    timed 600 pnpm update -g --latest $floating || failed_steps="$failed_steps${failed_steps:+, }update"
  fi
  for pin in $pins; do
    timed 300 pnpm add -g -E "$pin" || failed_steps="$failed_steps${failed_steps:+, }pin $pin"
  done
  [ -z "$failed_steps" ] || fail "pnpm globals: $failed_steps failed (see $sync_log)"
}

# Casks that ship a .pkg need sudo, which an unattended run cannot answer, so
# that alarm sends the owner to `autoupdate-now`. There brew alone gets the
# terminal as stdin, for sudo, and its output is copied to the log as it runs.
# Only a sudo password failure asks for a terminal; a failed download is the
# network.
sync_brew() {
  local out code kind casks named=
  log "--- brew upgrade"
  out=$(mktemp) || { fail "brew upgrade did not run: mktemp failed"; return; }
  if [ -n "$terminal" ]; then
    timed 3600 brew upgrade </dev/tty 2>&1 | tee -a "$sync_log" "$out"
  else
    timed 3600 brew upgrade 2>&1 | tee "$out"
  fi
  code=$?
  if [ "$code" != 0 ]; then
    # brew ends with one `Error: <cask>: <reason>` line per failed cask.
    while IFS='	' read -r kind casks; do
      named=1
      case $kind in
        download) fail "brew upgrade could not download $casks (a network error); the next daily run retries them" ;;
        sudo) fail "brew upgrade failed for $casks; run autoupdate-now in a terminal, where sudo can prompt" ;;
        *) fail "brew upgrade failed for $casks" ;;
      esac
    done < <(sed -n 's/^Error: \([^:[:space:]]*\): \(.*\)/\1	\2/p' "$out" | sort -u \
      | awk -F '\t' -v password="$(grep -c '^sudo: .*password' "$out")" '
          seen[$1]++ { next }
          { kind = $2 ~ /Download failed/ ? "download" : (password > 0 && $2 ~ /sudo/) ? "sudo" : "other"
            casks[kind] = casks[kind] (casks[kind] == "" ? "" : ", ") $1 }
          END { n = split("sudo download other", order, " ")
                for (i = 1; i <= n; i++) if (order[i] in casks) print order[i] "\t" casks[order[i]] }')
    [ -n "$named" ] || fail "brew upgrade failed (exit $code)"
  fi
  rm -f "$out"
}

# Reports pending updates, never installs them. A same-major macOS update
# (26.x) alarms after 7 days so security fixes cannot sit unnoticed; a major
# upgrade (27.x, which the owner declined on 10 Oct) and anything else stay info.
sync_macos() {
  local out current title version
  log "--- macOS updates"
  current=$(sw_vers -productVersion)
  if ! out=$(timed 300 softwareupdate --list 2>&1); then
    fail "softwareupdate --list failed: $(last_line "$out")"
    return
  fi
  while IFS='	' read -r title version; do
    case $title in
      macOS*)
        if [ "${version%%.*}" = "${current%%.*}" ]; then
          note "macos:$version" "$macos_after" "$title is waiting to be installed; it restarts the Mac, so pick a quiet time"
        else
          note "macos-major:$version" 0 "$title is available (a major upgrade, not planned)"
        fi ;;
      *) note "update:$title" 0 "$title is available" ;;
    esac
  done < <(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*Title: \(.*\), Version: \([^,]*\),.*/\1	\2/p')
}

# ── apply: the root daemon ──────────────────────────────────────────────────
cmd_apply() {
  local host=${AUTOUPDATE_HOST:?set AUTOUPDATE_HOST to the darwinConfigurations name}
  status=$daemon_dir/status
  now=$(date +%s)
  begin
  chmod 755 "$daemon_dir"
  # A human `rebuild` in flight (also: this daemon's RunAtLoad fires
  # mid-activation when a rebuild installs it), or a sync still running
  # brew upgrade: try next hour.
  pgrep -qf darwin-rebuild && return 0
  kill -0 "$(cat "$sync_dir/lock/pid" 2>/dev/null)" 2>/dev/null && return 0
  # Decide and switch under the switch lock, which `rebuild` holds for the
  # whole of a human's switch (cmd_rebuild). Without it, a rebuild of
  # unpushed work could finish between the decision below and its switch,
  # and the switch rolled it back (docs/formal/autoupdate-handoff). lockf
  # holds a kernel lock for as long as one command runs, so the decision runs
  # as that command, and a crash cannot leave the lock behind. A held lock is
  # a rebuild in flight: lockf exits 75 (EX_TEMPFAIL), and the next tick
  # decides again.
  "$BASH" "$0" apply-locked
  local code=$?
  [ "$code" = 75 ] || return "$code"
  log "the switch lock is held (a rebuild in flight); the next tick decides again"
}

cmd_apply_locked() {
  local host=${AUTOUPDATE_HOST:?set AUTOUPDATE_HOST to the darwinConfigurations name}
  status=$daemon_dir/status
  now=$(date +%s)
  local target running
  target=$(head -c 64 "$sync_dir/revision" 2>/dev/null | tr -d '\n')
  running=$(system_revision)

  if [ -z "$target" ]; then
    note handoff 0 "no revision from dotfiles-sync yet"
    finish
    return
  fi
  case $target in
    *[!0-9a-f]*) fail "the revision handed over by dotfiles-sync is not a commit id"; finish; return ;;
  esac
  [ "${#target}" = 40 ] || { fail "the revision handed over by dotfiles-sync is not a commit id"; finish; return; }

  case $running in
    '')
      note waiting:unknown "$push_after" "the running system has no recorded revision (built before this updater?); run rebuild from a pushed main"
      finish
      return ;;
    *-dirty)
      note "waiting:$running" "$push_after" "the running system was built from uncommitted changes on ${running:0:12}; waiting for them to be pushed and rebuilt"
      finish
      return ;;
  esac
  # The newest pushed revision wins: a system the owner rebuilt after a push is
  # newer than the last handover, and stays.
  local want=$target
  if [ "$running" != "$target" ] && user_git merge-base --is-ancestor "$target" "$running" \
      && user_git merge-base --is-ancestor "$running" refs/remotes/origin/main; then
    want=$running
  fi
  if [ "$running" = "$want" ]; then
    if hm_applied; then finish; return; fi
    log "system is at ${want:0:12} but Home Manager is not applied; switching again"
  elif ! user_git merge-base --is-ancestor "$running" "$want"; then
    note "waiting:$running" "$push_after" "the running system is built from ${running:0:12}, which is not on origin/main yet; waiting for push"
    finish
    return
  fi

  local attempt
  attempt=$(cat "$daemon_dir/attempt" 2>/dev/null)
  if [ "${attempt% *}" = "$want" ] && [ $((now - ${attempt#* })) -lt "$retry_after" ]; then
    return 0
  fi

  # The other half of cmd_sync's lock check: mark the switch, then look for a
  # sync that started since the check above.
  echo $$ >"$daemon_dir/switching"
  trap 'rm -f "$daemon_dir/switching"' EXIT
  kill -0 "$(cat "$sync_dir/lock/pid" 2>/dev/null)" 2>/dev/null && return 0
  # A darwin-rebuild run without `rebuild` takes no lock, so just before the
  # switch, look again for one (or for a rebuild waiting on this lock), and
  # for a system that changed since the decision.
  pgrep -qf darwin-rebuild && return 0
  local now_running
  now_running=$(system_revision)
  if [ "$now_running" != "$running" ]; then
    log "the running system changed to ${now_running:-no revision} after the check; the next tick decides again"
    return 0
  fi
  mark_running
  log "=== switching to ${want:0:12} (running: $running)"
  # Nix opens the repo through libgit2, which lets root read a repo another
  # user owns only when SUDO_UID names that owner, as it does under `rebuild`.
  # the owner's read-only sudo check of 11 Oct says whether root needs it here.
  SUDO_UID=$(stat -f %u "$repo") darwin-rebuild switch --flake "git+file://$repo?rev=$want#$host"
  local code=$?
  running=$(system_revision)
  if [ "$code" != 0 ]; then
    fail "switch to ${want:0:12} failed (exit $code); see $daemon_log"
  elif [ "$running" != "$want" ]; then
    fail "switch to ${want:0:12} exited 0 but the system reports ${running:-no revision}; see $daemon_log"
  elif ! hm_applied; then
    fail "switch to ${want:0:12} finished but Home Manager did not apply (brew bundle failed?); see $daemon_log"
  fi
  if [ "$failed" = 1 ]; then
    echo "$want $now" >"$daemon_dir/attempt"
  else
    rm -f "$daemon_dir/attempt"
    log "=== switched to ${want:0:12}"
  fi
  finish
}

system_revision() { sed -n 's/.*"configurationRevision": *"\([^"]*\)".*/\1/p' "$system/darwin-version.json" 2>/dev/null; }

# ── rebuild and rollback: the owner's switches ──────────────────────────────────
# rebuild <flake> [darwin-rebuild options]: the `rebuild` alias, as root
# under sudo.
cmd_rebuild() {
  if [ $# = 0 ]; then
    echo "usage: dotfiles-autoupdate rebuild <flake> [darwin-rebuild options]" >&2
    return 2
  fi
  switch_locked rebuild rebuilt rebuilding darwin-rebuild switch --flake "$@"
}

# rollback [generation]: the `rollback` alias, as root under sudo. Switches
# back to the previous system generation, or to the numbered one
# (`sudo darwin-rebuild --list-generations` lists them). A pushed revision
# rolled back from is recorded as a failed attempt, so the hourly apply
# holds off switching back to it for retry_after (a day); a newer push
# switches forward sooner. A generation built from unpushed work stays.
cmd_rollback() {
  local gen code running result record=''
  case $# in
    0)
      # Resolved before waiting for the lock, so a daemon switch that lands
      # meanwhile does not change which generation "previous" means.
      gen=$(previous_generation) || return 1 ;;
    1)
      case $1 in
        '' | *[!0-9]*) echo "usage: dotfiles-autoupdate rollback [generation]" >&2; return 2 ;;
      esac
      gen=$1 ;;
    *) echo "usage: dotfiles-autoupdate rollback [generation]" >&2; return 2 ;;
  esac
  mkdir -p "$daemon_dir" && result=$(mktemp "$daemon_dir/rollback.XXXXXX") || return 1
  # Expanded now: the trap runs after this function returns, without its locals.
  # shellcheck disable=SC2064
  trap "rm -f $(printf %q "$result")" EXIT
  # The command line names darwin-rebuild, so the pgrep checks in sync and
  # apply see a rollback waiting for the lock, as they see a rebuild.
  switch_locked rollback "rolled back" "rolling back to generation $gen" \
    "$BASH" "$0" rollback-locked "$result" darwin-rebuild --switch-generation "$gen"
  code=$?
  running=$(system_revision)
  record=$(cat "$result" 2>/dev/null)
  [ "$code" = 0 ] || return "$code"
  if [ -n "$record" ]; then
    echo "rollback: this Mac now runs ${running:-a generation with no recorded revision}." \
      "The hourly auto-update will not switch back to ${record:0:12} before $(date -v+"$retry_after"S '+%a %d %b %H:%M');" \
      "a newer push to main switches forward sooner. To stay on this revision, push a revert to main." >&2
  else
    echo "rollback: this Mac now runs ${running:-a generation with no recorded revision}." \
      "If that revision is on origin/main, the hourly auto-update switches forward to origin/main again;" \
      "to stay on it, push a revert to main." >&2
  fi
}

# previous_generation: the generation before the current one, the one
# darwin-rebuild --rollback would pick.
previous_generation() {
  local list gens
  list=$(darwin-rebuild --list-generations) || { echo "rollback: could not list the system generations" >&2; return 1; }
  gens=$(printf '%s\n' "$list" | awk '/\(current\)/ { print prev " " $1; exit } { prev = $1 }')
  case $gens in
    '') echo "rollback: darwin-rebuild --list-generations marks no generation (current)" >&2; return 1 ;;
    ' '*) echo "rollback: there is no generation before the current one (${gens# })." >&2; return 1 ;;
    *[!0-9\ ]*) echo "rollback: could not read the generation list (darwin-rebuild --list-generations)" >&2; return 1 ;;
  esac
  echo "${gens% *}"
}

# rollback-locked <result> <darwin-rebuild command>...: cmd_rollback's
# switch, run under the switch lock. Only a pushed revision needs holding off: apply never switches
# to unpushed work. The record goes in once the switch has landed on another
# revision, still under the lock, so no apply decides between the two, and a
# rollback stopped or failed before then leaves none. (Written before the
# wait, a Ctrl-C while rollback waited for the lock left a day's hold for a
# switch that never ran.) A fresh record for another revision (a daemon
# switch that failed) stays: apply retries that one, not this, and replacing
# it would retry it at once. The record also goes to <result>, for
# cmd_rollback to report.
cmd_rollback_locked() {
  local result=$1 from running prev prev_at record
  shift
  case $#:${1:-}:${2:-}:${3:-} in
    3:darwin-rebuild:--switch-generation:*[!0-9]* | 3:darwin-rebuild:--switch-generation:) return 2 ;;
    3:darwin-rebuild:--switch-generation:*) ;;
    *) return 2 ;;
  esac
  from=$(system_revision)
  "$@" || return
  running=$(system_revision)
  [ "$running" != "$from" ] || return 0
  case $from in *[!0-9a-f]* | '') return 0 ;; esac
  [ "${#from}" = 40 ] && user_git merge-base --is-ancestor "$from" refs/remotes/origin/main || return 0
  prev=$(cat "$daemon_dir/attempt" 2>/dev/null)
  prev_at=${prev#* }
  case $prev_at in '' | *[!0-9]*) prev_at=0 ;; esac
  [ "${prev% *}" = "$from" ] || [ $(($(date +%s) - prev_at)) -ge "$retry_after" ] || return 0
  record="$from $(date +%s)"
  echo "$record" >"$daemon_dir/attempt" && echo "$record" >"$result"
}

# switch_locked <name> <done> <doing> <command>...: runs the command (a
# darwin-rebuild) under the switch lock, so apply never decides on a system
# that a human switch is about to replace. A held lock is apply deciding,
# which takes a moment, or switching to the pushed origin/main, which can
# take minutes: say so and wait, then switch, so the owner's switch lands last.
switch_locked() {
  local name=$1 done=$2 doing=$3 code pid holder
  shift 3
  mkdir -p "$daemon_dir" || return 1
  # Switch at once when the lock is free; lockf prints "already locked" when
  # it is not (75).
  lockf -k -t 0 "$switch_lock" "$@"
  code=$?
  [ "$code" = 75 ] || return "$code"
  pid=$(cat "$daemon_dir/switching" 2>/dev/null)
  if [ -n "$pid" ] && ps -p "$pid" >/dev/null 2>&1; then
    holder="the hourly auto-update (pid $pid) is switching this Mac to the pushed origin/main"
  else
    holder="another switch holds the switch lock (an auto-update deciding, or a rebuild in another terminal)"
  fi
  echo "$name: $holder; waiting up to $((rebuild_wait / 60)) min for it to finish, then $doing." \
    "The auto-update's log: $daemon_log" >&2
  lockf -k -t "$rebuild_wait" "$switch_lock" "$@"
  code=$?
  if [ "$code" = 75 ]; then
    # A stuck activation holds the lock until its darwin-rebuild ends;
    # stopping that process fails the auto-update's switch and frees it.
    echo "$name: gave up after $((rebuild_wait / 60)) min: another switch still holds $switch_lock." \
      "Nothing was $done. See $daemon_log and \`dotfiles-autoupdate status\`, and run $name again once that switch ends." \
      "If the auto-update's switch is stuck, \`sudo pkill -f 'darwin-rebuild switch --flake git[+]file'\` stops it;" \
      "its activation may still be finishing, so check \`pgrep -fl activate\` before $doing." >&2
  fi
  return "$code"
}

# Root asks git questions about myuser's repo as myuser, never as itself: a
# repo's own config can run commands.
user_git() { sudo -u "$user" -H "$(command -v git)" -C "$repo" "$@" 2>/dev/null; }

# An equal system path does not prove Home Manager applied (AGENTS.md, the
# brew bundle sharp edge): compare the closure's generation with HM's own.
hm_applied() {
  local want
  want=$(nix-store -qR "$system" 2>/dev/null | grep -- '-home-manager-generation$' | head -n 1)
  [ -n "$want" ] && [ "$want" = "$(readlink "$home/.local/state/home-manager/gcroots/current-home")" ]
}

# ── status: the one reader ──────────────────────────────────────────────────
age() {
  local s=$1
  if [ "$s" -lt 3600 ]; then echo "$((s / 60)) min"
  elif [ "$s" -lt 172800 ]; then echo "$((s / 3600)) h"
  else echo "$((s / 86400)) d"; fi
}

alarm_lines='' info_lines='' ok_lines=''
alarm() { alarm_lines="$alarm_lines$1
"; }
info() { info_lines="$info_lines$1
"; }

read_status() { # read_status <name> <file> <log> [<what a run is called>]
  local name=$1 file=$2 logfile=$3 what=${4:-run} kind a b c d installed='' ok='' ran='' running=''
  if [ ! -f "$file" ]; then
    alarm "$name: has never run ($file is missing); is its launchd job loaded?"
    return
  fi
  while IFS='	' read -r kind a b c d; do
    case $kind in
      installed) installed=$a ;;
      ok) ok=$a ;;
      ran) ran=$a ;;
      running) running=$a ;;
      fail) case $a in *"$logfile"*) alarm "$name: $a" ;; *) alarm "$name: $a; see $logfile" ;; esac ;;
      note)
        if [ "$c" -gt 0 ] && [ $((now - b)) -ge "$c" ]; then alarm "$name: $d (for $(age $((now - b))))"
        else info "$name: $d"; fi ;;
    esac
  done <"$file"
  if [ -n "$running" ]; then
    if [ $((now - running)) -ge "$running_after" ]; then
      alarm "$name: a run started $(age $((now - running))) ago and never finished; see $logfile"
    else
      info "$name: running for $(age $((now - running)))"
    fi
  fi
  local good=${ok:-${installed:-0}}
  if [ $((now - good)) -ge "$stale_after" ]; then
    alarm "$name: no successful $what for $(age $((now - good)))${ran:+ (last $what $(age $((now - ran))) ago)}; see $logfile"
  elif [ -n "$ok" ]; then
    ok_lines="${ok_lines}$name: last good $what $(age $((now - ok))) ago
"
  elif [ -z "$ran$running" ]; then
    ok_lines="${ok_lines}$name: no $what yet, installed $(age $((now - good))) ago
"
  fi
}

# A switch that changed the runner's plist while a job ran leaves
# $runner_reload.pending (the first such switch's time, then the plist) until
# the github-runner-firewall daemon reloads the runner. Read here rather than
# from the daemon's status, so a daemon that stopped polling still alarms.
check_runner_reload() {
  local since waiting="the runner restarts on its new config once no job is running"
  [ -f "$runner_reload.pending" ] || return 0
  since=$(cut -d ' ' -f 1 "$runner_reload.pending" 2>/dev/null)
  case $since in '' | *[!0-9]*) since=$(stat -f %m "$runner_reload.pending") ;; esac
  if [ $((now - since)) -ge 7200 ]; then
    alarm "runner-reload: $waiting, but it has waited $(age $((now - since))) since the switch; see $runner_firewall_log"
  else
    info "runner-reload: $waiting (switched $(age $((now - since))) ago)"
  fi
}

# Sill comes from its developer's own tap (saffsanity/sill, nix/host.nix),
# which the daily brew upgrade trusts to replace the app. A build signed by
# anyone else means the tap or its download changed hands. codesign -dv reads
# the signature without verifying it (about 20 ms). No Sill is fine.
sill_team=9B2KKVM937 # Developer ID Application: NOAH WILLIAM SAFFER
check_sill() {
  local app=${AUTOUPDATE_SILL_APP:-/Applications/Sill.app} team
  [ -d "$app" ] || return 0
  team=$(codesign -dv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')
  [ "$team" != "$sill_team" ] || return 0
  case $team in ''|'not set') team='no Developer ID' ;; *) team="team $team" ;; esac
  alarm "sill: $app is signed by $team, not its developer's team $sill_team; quit it and check the saffsanity/sill tap before opening it again"
}

# The cloud routine bumps flake.lock on origin/main daily at 02:00 SGT; a
# lock 4 or more days old means it stopped. This reads the last fetch, never
# the network: the daily sync's, or any fetch in a ~/dotfiles worktree, which
# share its refs. So the alarm clears with the first fetch of a fresh lock.
# The sync used to record the age as its own failure, which kept the alarm
# and "no successful run" up for a day after the routine was back (16 Oct
# 2026). No checkout is fine; a git that fails here (the board runs
# /usr/bin/git, which a macOS upgrade can break) is an alarm, not silence.
check_flake_lock() {
  local stamp days
  [ -e "$repo/.git" ] || return 0
  if ! stamp=$(git -C "$repo" log -1 --format=%ct refs/remotes/origin/main -- flake.lock 2>&1); then
    alarm "routine: could not read the flake.lock age from origin/main in $repo: $(last_line "$stamp")"
    return 0
  fi
  [ -n "$stamp" ] || return 0
  days=$(( (now - stamp) / 86400 ))
  [ "$days" -le 3 ] \
    || alarm "routine: flake.lock on origin/main was last updated $days days ago; is the cloud update routine running? (claude.ai/code/routines)"
}

cmd_status() {
  now=$(date +%s)
  read_status sync "$sync_dir/sync.status" "$sync_log"
  # The board runs status from the checkout, live on push, before the switch
  # reloads the agent that writes daily.status.
  if [ -f "$sync_dir/sync.status" ] && [ ! -f "$sync_dir/daily.status" ]; then
    info "daily: no run yet; the sync agent starts it after the next switch"
  else
    read_status daily "$sync_dir/daily.status" "$sync_log"
  fi
  read_status switch "$daemon_dir/status" "$daemon_log"
  # A system without the runner's activate step (a rollback, or a push that
  # reverted it) switches the runner itself, and its firewall daemon neither
  # clears the marker nor writes the status, so what the step left is stale.
  if grep -q -- '-github-runner activate ' "$system/activate" 2>/dev/null; then
    [ ! -f "$runner_status" ] || read_status runner-reload "$runner_status" "$runner_firewall_log" poll
    check_runner_reload
  fi
  check_flake_lock
  check_sill
  if [ "${1:-}" = --alarms ]; then
    [ -n "$alarm_lines" ] || return 0
    printf '%s' "$alarm_lines" | sed 's/^/dotfiles auto-update: /'
    echo "  details: dotfiles-autoupdate status"
    return 0
  fi
  printf '%s' "$alarm_lines" | sed 's/^/alarm: /'
  printf '%s' "$info_lines" | sed 's/^/info: /'
  printf '%s' "$ok_lines" | sed 's/^/ok: /'
}

case ${1:-} in
  sync) shift; cmd_sync "$@" ;;
  apply) shift; cmd_apply "$@" ;;
  apply-locked) cmd_apply_locked ;; # cmd_apply runs it under the switch lock
  rebuild) shift; cmd_rebuild "$@" ;;
  rollback) shift; cmd_rollback "$@" ;;
  rollback-locked) shift; cmd_rollback_locked "$@" ;; # cmd_rollback runs it under the switch lock
  status) shift; cmd_status "$@" ;;
  *) echo "usage: dotfiles-autoupdate sync [--now] | apply | rebuild <flake> | rollback [generation] | status [--alarms]" >&2; exit 2 ;;
esac
