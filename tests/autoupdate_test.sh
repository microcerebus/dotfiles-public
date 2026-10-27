#!/usr/bin/env bash
# Tests for scripts/dotfiles-autoupdate against a sandboxed origin, checkout
# and fake system generations, with stub darwin-rebuild, nix-store, pnpm,
# brew, softwareupdate, sudo, curl, codesign, osascript and a clock. The terminal case (20) runs
# the program `autoupdate-now` names, built from this flake.
# Never touches the real system and writes only to a temp dir and the Nix
# store. The network is used only by Nix, to fetch what that build needs.
# Run: bash tests/autoupdate_test.sh
# In the foreground or in the background: started with & from a script it
# inherits SIGINT ignored, and the Ctrl-C cases restore it for the runs
# they signal, so a rollback or sync that ignores Ctrl-C fails either way.
set -euo pipefail
# Confine the suite under scripts/test-sandbox (see tests/lib/confine.sh).
# shellcheck source=tests/lib/confine.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/confine.sh"
repo="$(cd "$(dirname "$0")/.." && pwd)"
script="$repo/scripts/dotfiles-autoupdate"
tmp="$(mktemp -d)"
trap '[ -n "${KEEP_TMP:-}" ] || rm -rf "$tmp"' EXIT
export TZ=Asia/Singapore
fail=0

ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; shift; printf '  %s\n' "$@"; fail=1; }

# Under scripts/test-sandbox every write outside its scratch dir fails, and
# env -i drops TMPDIR, XDG_CACHE_HOME and the mktemp shim on PATH that keep
# the updater's temp files in there. Hand those on there and only there:
# outside the sandbox the clean env stays as it was. test-sandbox starts this
# script with $TEST_SANDBOX/bin on PATH; a TEST_SANDBOX without its bin dir on
# PATH is a stray export, not a sandbox (the rule in tests/lib/sandbox-env.cjs).
sandbox_env=() sandbox_bin=
if [ -n "${TEST_SANDBOX:-}" ] && [[ ":$PATH:" == *":$TEST_SANDBOX/bin:"* ]]; then
  sandbox_env=(TEST_SANDBOX="$TEST_SANDBOX")
  [ -z "${TMPDIR+set}" ] || sandbox_env+=(TMPDIR="$TMPDIR")
  [ -z "${XDG_CACHE_HOME+set}" ] || sandbox_env+=(XDG_CACHE_HOME="$XDG_CACHE_HOME")
  sandbox_bin="$TEST_SANDBOX/bin:"
fi

# Only the stubs, these real tools and, under test-sandbox, its shim dir
# $sandbox_bin (after the stubs, so a stub always wins) are on PATH, so
# nothing can reach the real brew, pnpm, softwareupdate or darwin-rebuild.
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
# sudo: a tripwire. Root runs git only on its own clone, never as myuser on
# his repo (audit H2), so nothing calls sudo; any call, across the whole
# suite, is recorded in $STUB_SUDO_LOG and refused.
cat >"$stubs/sudo" <<'EOF'
#!/bin/sh
echo "sudo $*" >>"$STUB_SUDO_LOG"
exit 1
EOF
export STUB_SUDO_LOG="$tmp/sudo.log"
: >"$STUB_SUDO_LOG"
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
# git: the real git. STUB_SYNC_STARTS=<pid>: a sync takes its lock as pid
# <pid> at apply's first git call, after its first look at the sync lock.
# STUB_HUMAN_SWITCH=<rev>: at apply's first ancestry question, after it
# sampled the system, a darwin-rebuild run outside `rebuild` finishes a
# switch to <rev>, once.
cat >"$stubs/git" <<EOF
#!/usr/bin/env bash
stub-terminal-check git
if [ -n "\${STUB_SYNC_STARTS:-}" ]; then
  mkdir -p "\$AUTOUPDATE_HOME/.local/state/dotfiles-autoupdate/lock"
  echo "\$STUB_SYNC_STARTS" >"\$AUTOUPDATE_HOME/.local/state/dotfiles-autoupdate/lock/pid"
fi
if [ -n "\${STUB_HUMAN_SWITCH:-}" ] && [ ! -e "\$STUB_LOG/human-switched" ] && [[ " \$* " == *" merge-base "* ]]; then
  touch "\$STUB_LOG/human-switched"
  ln -sfn "\$(mksystem "\$STUB_HUMAN_SWITCH")" "\$AUTOUPDATE_SYSTEM"
fi
exec $(command -v git) "\$@"
EOF
# ssh, as git runs it for root's fetch: records its arguments in
# $STUB_LOG/ssh, then answers as GitHub would. STUB_SSH: ok (unset) serves
# $STUB_SSH_REPO on any port; auth refuses the key; hostkey fails the host
# key check; offline reaches no port; offline22 reaches only port 443.
cat >"$stubs/ssh" <<'EOF'
#!/usr/bin/env bash
echo "ssh $*" >>"$STUB_LOG/ssh"
port=22 host=
while [ $# -gt 0 ]; do
  case $1 in
    -p) port=$2; shift 2 ;;
    -F | -i | -o) shift 2 ;;
    -*) shift ;;
    *) host=$1; shift; break ;;
  esac
done
case ${STUB_SSH:-ok}:$port in
  auth:*) echo "$host: Permission denied (publickey)." >&2; exit 255 ;;
  hostkey:*) echo "Host key verification failed." >&2; exit 255 ;;
  offline:* | offline22:22) echo "ssh: connect to host ${host#*@} port $port: Operation timed out" >&2; exit 255 ;;
esac
exec git upload-pack "$STUB_SSH_REPO"
EOF
cat >"$stubs/curl" <<'EOF'
#!/bin/sh
stub-terminal-check curl
[ "${STUB_OFFLINE:-0}" = 0 ]
EOF
# STUB_SILL_TEAM=<id>: codesign -dv reports an app signed by team <id>, or
# ad hoc for "not set"; unset means not signed at all.
cat >"$stubs/codesign" <<'EOF'
#!/bin/sh
[ "$1" = -dv ] || exit 2
if [ -z "${STUB_SILL_TEAM:-}" ]; then echo "$2: code object is not signed at all" >&2; exit 1; fi
printf 'Executable=%s/Contents/MacOS/Sill\nIdentifier=me.saffer.sill.mac\nTeamIdentifier=%s\n' "$2" "$STUB_SILL_TEAM" >&2
EOF
# osascript: records each notification instead of posting it.
# STUB_OSASCRIPT_FAIL: the notification does not post.
cat >"$stubs/osascript" <<'EOF'
#!/bin/sh
[ "${STUB_OSASCRIPT_FAIL:-0}" = 0 ] || exit 1
for a; do last=$a; done
echo "notify $last" >>"$STUB_LOG/calls"
EOF
# pgrep: a rebuild runs with STUB_REBUILD_RUNNING, or once a stub started one
# ($STUB_LOG/rebuilding).
cat >"$stubs/pgrep" <<'EOF'
#!/bin/sh
[ "${STUB_REBUILD_RUNNING:-0}" = 1 ] || [ -e "$STUB_LOG/rebuilding" ]
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
# STUB_PNPM_STARTS_REBUILD: the owner starts a rebuild while pnpm updates.
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
[ "${STUB_PNPM_STARTS_REBUILD:-0}" = 0 ] || [ "$1" != update ] || touch "$STUB_LOG/rebuilding"
case $1 in
  ls) if [ -n "${STUB_PNPM_LS:-}" ]; then echo "$STUB_PNPM_LS"
      else echo '[{"dependencies":{"gh-axi":{},"chrome-devtools-axi":{},"agent-device":{}}}]'; fi ;;
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
# public-sync --from-origin: records the publish. STUB_PUBLIC_FAIL: the
# leak gate or the mirror push failed.
cat >"$stubs/public-sync" <<'EOF'
#!/bin/sh
stub-terminal-check public-sync
echo "public-sync $*" >>"$STUB_LOG/calls"
if [ "${STUB_PUBLIC_FAIL:-0}" = 1 ]; then echo "[public-sync] LEAK GATE FAILED: 1 hit" >&2; exit 1; fi
echo "[public-sync] mirror already at origin/main"
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
# STUB_SWITCH_HOLD=<dir>: the switch announces itself in <dir>/started.<n>
# and runs until <dir>/release exists, as a long build does.
# darwin-rebuild --rollback / --switch-generation <n>: activates the fake
# generation before the running one, or generation <n> (counted from 1 in
# build order), and records its revision.
# darwin-rebuild --list-generations: lists them as nix-env does, the running
# one marked (current). STUB_LIST=<file>: prints that file instead.
cat >"$stubs/darwin-rebuild" <<'EOF'
#!/usr/bin/env bash
case $1 in
  switch) [ "$2" = --flake ] || exit 2 ;;
  --rollback) [ $# = 1 ] || exit 2 ;;
  --switch-generation) [ $# = 2 ] || exit 2 ;;
  --list-generations)
    [ $# = 1 ] || exit 2
    if [ -n "${STUB_LIST:-}" ]; then cat "$STUB_LIST"; exit 0; fi
    n=0
    for g in $(ls "$SYSTEMS" | grep -- '-darwin-system$' | sort -n); do
      n=$((n + 1))
      [ "$g" = "$(basename "$(readlink "$AUTOUPDATE_SYSTEM")")" ] && c='(current)' || c=''
      printf '%4d   2026-10-11 12:00:00   %s\n' "$n" "$c"
    done
    exit 0 ;;
  *) exit 2 ;;
esac
if [ -n "${STUB_SWITCH_HOLD:-}" ]; then
  echo "$*" >"$STUB_SWITCH_HOLD/started.$(ls "$STUB_SWITCH_HOLD" | grep -c '^started')"
  for _ in $(seq 300); do [ -e "$STUB_SWITCH_HOLD/release" ] && break; /bin/sleep 0.1; done
fi
if [ "$1" != switch ]; then
  gens=$(ls "$SYSTEMS" | grep -- '-darwin-system$' | sort -n)
  if [ "$1" = --rollback ]; then
    n=$(grep -nx -- "$(basename "$(readlink "$AUTOUPDATE_SYSTEM")")" <<<"$gens" | cut -d: -f1)
    n=$((n - 1))
  else
    n=$2
  fi
  sys="$SYSTEMS/$(sed -n "${n}p" <<<"$gens")"
  [ "$n" -ge 1 ] && [ -d "$sys" ] && [ "$sys" != "$SYSTEMS/" ] || { echo "darwin-rebuild: no generation $n" >&2; exit 1; }
  sed -n 's/.*"configurationRevision": *"\([^"]*\)".*/\1/p' "$sys/darwin-version.json" >>"$STUB_LOG/built"
  ln -sfn "$sys" "$AUTOUPDATE_SYSTEM"
  ln -sfn "$(cat "$sys/closure")" "$HM_GCROOT"
  exit 0
fi
ref=$3
echo "$ref" >>"$STUB_LOG/flake-refs"
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
uid=$(id -u)
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
  export STUB_LOG="$s/log" SYSTEMS="$s/systems"
  export AUTOUPDATE_USER=testuser AUTOUPDATE_HOST=testhost AUTOUPDATE_HOME="$home"
  export AUTOUPDATE_SYSTEM="$s/current-system" AUTOUPDATE_DAEMON_DIR="$s/daemon"
  export AUTOUPDATE_STAMP="$s/daemon/stamp" AUTOUPDATE_SILL_APP="$s/Applications/Sill.app"
  export AUTOUPDATE_PUBLIC_SYNC="$stubs/public-sync" AUTOUPDATE_RUNNER_STATUS="$s/runner-reload.status"
  export AUTOUPDATE_RUNNER_RELOAD="$s/run/github-runner-reload"
  export HM_GCROOT="$home/.local/state/home-manager/gcroots/current-home"
  # Root's clone and deploy key, as the owner's key steps leave them (owned by
  # this suite's uid, standing in for root), fetching from the local origin.
  # The ssh cases unset AUTOUPDATE_REMOTE to fetch GitHub's URLs via the stub.
  root="$s/var-lib/dotfiles-autoupdate"
  mkdir -p "$s/var-lib" && chmod 755 "$s" "$s/var-lib"
  mkdir -m 700 "$root" && : >"$root/deploy_key" && chmod 600 "$root/deploy_key"
  export AUTOUPDATE_ROOT_DIR="$root" AUTOUPDATE_ROOT_UID="$uid" AUTOUPDATE_REMOTE="$s/origin.git"
  export AUTOUPDATE_KNOWN_HOSTS="$repo/nix/github-known-hosts" AUTOUPDATE_SSH="$stubs/ssh" STUB_SSH_REPO="$s/origin.git"
  unset STUB_SSH STUB_HUMAN_SWITCH STUB_SWITCH_HOLD AUTOUPDATE_REBUILD_WAIT STUB_OFFLINE STUB_REBUILD_RUNNING STUB_PNPM_FAIL STUB_PNPM_CTRL_C STUB_BREW_OUTPUT STUB_BREW_SUDO STUB_TTY STUB_BREW_KILL STUB_SWITCH_EXIT STUB_HM_BROKEN STUB_SILL_TEAM STUB_OSASCRIPT_FAIL STUB_PNPM_STARTS_REBUILD STUB_SYNC_STARTS STUB_PUBLIC_FAIL STUB_LIST
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
# $as_path. Every as_path ends in $system_path, which carries the shim dir
# under test-sandbox.
system_path="$sandbox_bin/usr/bin:/bin:/usr/sbin:/sbin"
as_path="$stubs:$real:$system_path"
as() {
  local h=$1 v vars=()
  shift
  for v in $(compgen -e | grep -E '^(AUTOUPDATE|STUB)_'); do vars+=("$v=${!v}"); done
  env -i ${sandbox_env[@]+"${sandbox_env[@]}"} HOME="$h" TZ="$TZ" PATH="$as_path" FAKE_NOW="$FAKE_NOW" \
    SYSTEMS="$SYSTEMS" HM_GCROOT="$HM_GCROOT" "${vars[@]}" "$@"
}
# A terminal gives its foreground job the default SIGINT. A suite started
# with & from a non-interactive shell inherits SIGINT ignored, and its
# children with it, so a run that a test sends Ctrl-C (cases 21 and 34)
# starts under `$coreutils/bin/env --default-signal=INT`, as in a terminal.
coreutils=$(nix eval --raw "$repo#darwinConfigurations.myhost.pkgs.coreutils.outPath")

# ── Adapter: how this suite drives the updater and reads what it reports ──
# tick: one hourly launchd tick of every updater job, at the fake time.
tick() {
  as "$home" bash "$script" sync </dev/null >>"$s/log/out" 2>&1 || true
  as "$root_home" bash "$script" apply </dev/null >>"$s/log/out" 2>&1 || true
}
# sync_now: autoupdate-now's sync, as an agent shell runs it, with no terminal.
sync_now() { as "$home" bash "$script" sync --now </dev/null >>"$s/log/out" 2>&1 || true; }
# alarms: what reaches the owner (zsh banner, agent board, SessionStart hook).
# status never runs inside a terminal run (STUB_TTY), so neither does it here.
alarms() { STUB_TTY='' as "$home" bash "$script" status --alarms; }
# report: everything the updater reports, alarms and info.
report() { STUB_TTY='' as "$home" bash "$script" status; }
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
expect_eq "nothing heavy runs before 04:00" "$(calls brew)" 0
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
# status reads it from the last fetch. On 16 Oct 2026 the sync recorded the
# age as its own failure, which raised "no successful run" too and kept both
# up for a day after the routine was back.
fresh
at "2026-10-16 05:00"; tick; tick
expect_alarm "an old flake.lock raises an alarm" \
  "^dotfiles auto-update: routine: flake.lock on origin/main was last updated 4 days ago; is the cloud update routine running\? \(claude\.ai/code/routines\)$"
expect_report "an old flake.lock does not fail the sync" "^ok: sync: last good run 0 min ago$"
legacy=$(env -i ${sandbox_env[@]+"${sandbox_env[@]}"} HOME="$home" TZ="$TZ" PATH="$stubs:$sandbox_bin/usr/bin:/bin" FAKE_NOW="$FAKE_NOW" \
  AUTOUPDATE_HOME="$home" AUTOUPDATE_DAEMON_DIR="$AUTOUPDATE_DAEMON_DIR" AUTOUPDATE_SILL_APP="$AUTOUPDATE_SILL_APP" AUTOUPDATE_RUNNER_STATUS="$AUTOUPDATE_RUNNER_STATUS" AUTOUPDATE_RUNNER_RELOAD="$AUTOUPDATE_RUNNER_RELOAD" \
  /bin/bash "$script" status)
expect_eq "the flake.lock alarm reads the same under macOS's bash 3.2" "$legacy" "$(report)"
at "2026-10-16 05:10"; commit_upstream "C: flake.lock bump" flake.lock
git -C "$home/dotfiles" fetch -q origin
expect_no_alarm "fetching a fresh flake.lock clears the alarm without a sync"
git -C "$home/dotfiles" update-ref -d refs/remotes/origin/main
expect_alarm "a git that cannot read the flake.lock age alarms instead of going quiet" \
  "^dotfiles auto-update: routine: could not read the flake.lock age from origin/main in $home/dotfiles: "
rm -rf "$home/dotfiles"
expect_no_alarm "no checkout is no flake.lock alarm"

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
expect_report "a same-major macOS update is reported from day 1" "info: daily: macOS Tahoe 26.7.2"
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
"alarm: daily: brew upgrade failed for karabiner-elements; run autoupdate-now in a terminal, where sudo can prompt; see $home/Library/Logs/dotfiles-sync.log
info: sync: local main is 1 commits ahead of origin/main, waiting for push
ok: sync: last good run 2 h ago
ok: switch: last good run 2 h ago"
expect_eq "status --alarms is the banner and SessionStart text" "$(alarms)" \
"dotfiles auto-update: daily: brew upgrade failed for karabiner-elements; run autoupdate-now in a terminal, where sudo can prompt; see $home/Library/Logs/dotfiles-sync.log
  details: dotfiles-autoupdate status"
legacy=$(env -i ${sandbox_env[@]+"${sandbox_env[@]}"} HOME="$home" TZ="$TZ" PATH="$stubs:$sandbox_bin/usr/bin:/bin" FAKE_NOW="$FAKE_NOW" \
  AUTOUPDATE_HOME="$home" AUTOUPDATE_DAEMON_DIR="$AUTOUPDATE_DAEMON_DIR" AUTOUPDATE_SILL_APP="$AUTOUPDATE_SILL_APP" AUTOUPDATE_RUNNER_STATUS="$AUTOUPDATE_RUNNER_STATUS" AUTOUPDATE_RUNNER_RELOAD="$AUTOUPDATE_RUNNER_RELOAD" \
  /bin/bash "$script" status)
expect_eq "status reads the same under macOS's bash 3.2" "$legacy" "$(report)"

# 18. A runner that is installed but has not run yet still shows, so the
# board's card never looks like it tracks one runner. A failure that already
# names its log is not pointed at it twice.
fresh
at "2026-10-12 03:00"; tick
at "2026-10-12 03:30"
expect_report "an installed runner that has not run yet is reported" "^ok: daily: no run yet, installed 30 min ago$"
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
rebuild_cmd=$(nix eval --raw "$hm.programs.zsh.shellAliases.rebuild")
rollback_cmd=$(nix eval --raw "$hm.programs.zsh.shellAliases.rollback")
expect_eq "rebuild switches through the same program, under its switch lock" "${rebuild_cmd%% && *}" "sudo $agent rebuild $(nix eval --raw "$hm.home.homeDirectory")/dotfiles"
expect_eq "rollback rolls back through the same program, under its switch lock" "$rollback_cmd" "sudo $agent rollback"
built_by=$(nix eval --json "$hm.programs.zsh.shellAliases.autoupdate-now" \
  --apply 'a: map (d: d + "^*") (builtins.attrNames (builtins.getContext a))' | jq -r '.[]')
# shellcheck disable=SC2086 # one installable per derivation
[ -z "$built_by" ] || nix build --no-link $built_by
# The program sets the pinned host keys itself: `rollback` runs it under
# sudo, which drops the caller's env, and fetches with them too.
program_hosts=$(sed -n 's/^export AUTOUPDATE_KNOWN_HOSTS=//p' "$agent")
if [ "${program_hosts#/nix/store/}" != "$program_hosts" ] && cmp -s "$program_hosts" "$repo/nix/github-known-hosts"; then
  ok "every run of the program fetches trusting only the store copy of nix/github-known-hosts"
else bad "every run of the program fetches trusting only the store copy of nix/github-known-hosts" "got: ${program_hosts:-<none>}"; fi
terminal="$tmp/terminal" # the stubs, less timeout
mkdir -p "$terminal"
for f in "$stubs"/*; do [ "${f##*/}" = timeout ] || ln -s "$f" "$terminal/"; done
fresh
export STUB_BREW_SUDO=1 STUB_TTY=1
at "2026-10-12 05:00"
as_path="$repo/scripts:$terminal:$real:$system_path" \
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
# step that handles the signal itself, and the status says so.
fresh
export STUB_TTY=1 STUB_PNPM_CTRL_C=1
at "2026-10-12 05:00"
as_path="$repo/scripts:$terminal:$real:$system_path" \
  as "$home" "$coreutils/bin/env" --default-signal=INT \
  script -q "$s/log/terminal" bash -c "$alias_cmd" </dev/null >/dev/null 2>&1 || true
expect_eq "Ctrl-C in a terminal run stops it before the next step" "$(calls brew)" 0
expect_alarm "a run stopped by Ctrl-C says so" "daily: interrupted \(Ctrl-C\)"

# 22. Sill comes from its developer's own tap, which the daily brew upgrade
# trusts to replace the app. status alarms on a Sill.app signed by anyone but
# the developer's team, never on the developer's build or no Sill at all.
fresh
at "2026-10-12 05:00"; tick
expect_no_alarm "no Sill installed is no alarm"
mkdir -p "$AUTOUPDATE_SILL_APP"
STUB_SILL_TEAM=9B2KKVM937 expect_no_alarm "Sill signed by its developer is no alarm"
STUB_SILL_TEAM=ABCDE12345 expect_alarm "Sill signed by another team alarms with what to do" \
  "^dotfiles auto-update: sill: $AUTOUPDATE_SILL_APP is signed by team ABCDE12345, not its developer's team 9B2KKVM937; quit it and check the saffsanity/sill tap before opening it again$"
STUB_SILL_TEAM="not set" expect_alarm "an ad hoc signed Sill alarms" "sill: .* is signed by no Developer ID, not"
expect_alarm "an unsigned Sill alarms" "sill: .* is signed by no Developer ID, not"
legacy=$(env -i ${sandbox_env[@]+"${sandbox_env[@]}"} HOME="$home" TZ="$TZ" PATH="$stubs:$sandbox_bin/usr/bin:/bin" FAKE_NOW="$FAKE_NOW" STUB_SILL_TEAM=ABCDE12345 \
  AUTOUPDATE_HOME="$home" AUTOUPDATE_DAEMON_DIR="$AUTOUPDATE_DAEMON_DIR" AUTOUPDATE_SILL_APP="$AUTOUPDATE_SILL_APP" AUTOUPDATE_RUNNER_STATUS="$AUTOUPDATE_RUNNER_STATUS" AUTOUPDATE_RUNNER_RELOAD="$AUTOUPDATE_RUNNER_RELOAD" \
  /bin/bash "$script" status)
expect_eq "the Sill alarm reads the same under macOS's bash 3.2" "$legacy" "$(STUB_SILL_TEAM=ABCDE12345 report)"

# 23. The day's run is the first from 04:00, after the cloud routine's 02:00
# flake.lock bump. On 16 Oct 2026 a `--now` run at 01:40 took its place, so
# the 01:50 bump waited a day to be handed over.
fresh
at "2026-10-16 01:40"; sync_now
at "2026-10-16 01:50"; commit_upstream "C: flake.lock bump" flake.lock
C=$(git -C "$s/upstream" rev-parse HEAD)
at "2026-10-16 04:00"; tick; tick
expect_eq "a --now run before 04:00 leaves the day's run to come" "$(calls brew)" 2
fresh
at "2026-10-16 08:30"; sync_now
at "2026-10-16 09:00"; tick
expect_eq "a --now run from 04:00 is the day's run" "$(calls brew)" 1

# 24. Pushed work goes live within the hour (the owner, 16 Oct 2026): every
# hourly sync hands origin/main over and the daemon switches to it. The heavy
# steps (pnpm, brew, macOS updates) still run once a day, from 04:00, and
# report as their own runner, so the sync's last good run is the hand-over.
fresh
at "2026-10-12 05:00"; tick; tick
at "2026-10-12 13:20"; commit_upstream "C: midday push"
C=$(git -C "$s/upstream" rev-parse HEAD)
at "2026-10-12 14:00"; tick
expect_eq "a midday push is switched to within the hour" "$(running_rev)" "$C"
expect_eq "the checkout fast-forwards hourly" "$(git -C "$home/dotfiles" rev-parse main)" "$C"
at "2026-10-12 15:00"; tick
expect_eq "the heavy steps run once a day" "$(calls brew) $(calls softwareupdate) $(calls 'pnpm update')" "1 1 1"
expect_report "the hourly hand-over is the sync's last good run" "^ok: sync: last good run 0 min ago$"
expect_report "the heavy steps report their own last good run" "^ok: daily: last good run 10 h ago$"
expect_eq "a routine switch notifies nobody" "$(calls notify)" 0
fresh
export STUB_PNPM_FAIL=1
for d in 12 13; do at "2026-10-$d 05:00"; tick; done
at "2026-10-13 18:00"; tick
expect_alarm "failing heavy steps go stale as the daily runner" "^dotfiles auto-update: daily: no successful run for 37 h"
got=$(alarms)
if grep -q "sync: no successful run" <<<"$got"; then bad "failing heavy steps leave the hourly hand-over good" "got: $got"
else ok "failing heavy steps leave the hourly hand-over good"; fi

# 25. The switch runs as root, which cannot reach the owner's screen, so the sync
# agent in his GUI session notifies him when a switch fails or has waited on
# him for 2 h: once per state, not every hour.
fresh
export STUB_SWITCH_EXIT=1
at "2026-10-12 04:30"; commit_upstream "C: push"
for h in 05 06 07 08; do at "2026-10-12 $h:00"; tick; done
expect_eq "a failed switch notifies once, not hourly" "$(grep -c '^notify switch to [0-9a-f]* failed (exit 1)' "$s/log/calls")" 1
fresh
at "2026-10-12 05:00"; tick
at "2026-10-12 10:00"; commit_local "L: unpushed"
ln -sfn "$(PATH="$stubs:$PATH" mksystem "$(git -C "$home/dotfiles" rev-parse HEAD)")" "$AUTOUPDATE_SYSTEM"
ln -sfn "$(cat "$AUTOUPDATE_SYSTEM/closure")" "$HM_GCROOT"
for h in 11 12; do at "2026-10-12 $h:00"; tick; done
expect_eq "a switch waiting for a push does not notify at first" "$(calls notify)" 0
for h in 13 14 15; do at "2026-10-12 $h:00"; tick; done
expect_eq "a switch waiting for a push notifies once after 2 h" "$(grep -c '^notify the running system is built from .* waiting for push$' "$s/log/calls")" 1
expect_alarm "a switch waiting for a push alarms after 2 h" "switch: the running system is built from .* waiting for push \(for 4 h\)"
fresh
export STUB_SWITCH_EXIT=1 STUB_OSASCRIPT_FAIL=1
at "2026-10-12 04:30"; commit_upstream "C: push"
for h in 05 06 07; do at "2026-10-12 $h:00"; tick; done
unset STUB_OSASCRIPT_FAIL
for h in 08 09; do at "2026-10-12 $h:00"; tick; done
expect_eq "a notification that did not post is posted at the next tick, once" \
  "$(grep -c '^notify switch to [0-9a-f]* failed (exit 1)' "$s/log/calls")" 1

# 26. Both jobs fire together on wake. Each takes its own lock before it
# checks the other's, so the switch's brew bundle never races brew upgrade.
fresh
at "2026-10-12 04:30"; commit_upstream "C: push"
C=$(git -C "$s/upstream" rev-parse HEAD)
/bin/sleep 60 & held=$!
echo "$held" >"$AUTOUPDATE_DAEMON_DIR/switching"
at "2026-10-12 05:00"
as "$home" bash "$script" sync </dev/null >>"$s/log/out" 2>&1 || true
expect_eq "a sync waits for a switch past its lock check" "$(calls brew) $(calls public-sync)" "0 0"
STUB_SYNC_STARTS=$held as "$root_home" bash "$script" apply </dev/null >>"$s/log/out" 2>&1 || true
expect_eq "the wake-race probe actually starts a sync" "$(cat "$home/.local/state/dotfiles-autoupdate/lock/pid" 2>/dev/null)" "$held"
expect_eq "a switch waits for a sync that took its lock after the switch checked" "$(built)" ""
kill "$held" 2>/dev/null; wait "$held" 2>/dev/null || true
rm -rf "$home/.local/state/dotfiles-autoupdate/lock"
at "2026-10-12 06:00"; tick
expect_eq "the switch follows at the next tick" "$(running_rev)" "$C"
expect_eq "a finished switch leaves no marker" "$(ls "$AUTOUPDATE_DAEMON_DIR/switching" 2>/dev/null)" ""
fresh
export STUB_PNPM_STARTS_REBUILD=1
at "2026-10-12 05:00"; tick
expect_eq "a rebuild started during pnpm leaves brew to it" "$(calls brew)" 0
unset STUB_PNPM_STARTS_REBUILD
rm -f "$s/log/rebuilding"
at "2026-10-12 06:00"; tick
expect_eq "the next tick runs the day's brew upgrade" "$(calls brew)" 1

# A forced sync overrides the schedule, while still excluding a switch.
fresh
/bin/sleep 60 & held=$!
echo "$held" >"$AUTOUPDATE_DAEMON_DIR/switching"
at "2026-10-12 05:00"; sync_now
expect_eq "a forced sync waits for an active switch" "$(calls brew) $(calls 'pnpm update')" "0 0"
expect_eq "a deferred forced sync leaves the daily run due" "$(cat "$home/.local/state/dotfiles-autoupdate/day" 2>/dev/null)" ""
kill "$held" 2>/dev/null; wait "$held" 2>/dev/null || true
fresh
export STUB_PNPM_STARTS_REBUILD=1
at "2026-10-12 05:00"; sync_now
expect_eq "a forced sync also checks for a rebuild after pnpm" "$(calls brew)" 0
unset STUB_PNPM_STARTS_REBUILD
rm -f "$s/log/rebuilding"
at "2026-10-12 06:00"; tick
expect_eq "a forced sync interrupted by a rebuild leaves daily work due" "$(calls brew)" 1

# 27. Right after a push the board runs the new status from the checkout,
# while the old agent still writes only sync.status (in its old format, with
# the daily steps' results) until the switch reloads it.
fresh
mkdir -p "$home/.local/state/dotfiles-autoupdate"
printf 'installed\t%s\nok\t%s\nran\t%s\n' "$FAKE_NOW" "$FAKE_NOW" "$FAKE_NOW" \
  >"$home/.local/state/dotfiles-autoupdate/sync.status"
cp "$home/.local/state/dotfiles-autoupdate/sync.status" "$AUTOUPDATE_DAEMON_DIR/status"
expect_no_alarm "a sync.status with no daily.status yet is no alarm"
expect_report "a sync.status with no daily.status yet says the daily run is to come" "^info: daily: no run yet"
printf 'installed\t%s\nran\t%s\nfail\tbrew upgrade failed for some-cask\n' "$FAKE_NOW" "$FAKE_NOW" \
  >"$home/.local/state/dotfiles-autoupdate/sync.status"
at "2026-10-12 13:00"; tick
expect_no_alarm "the first new sync replaces an old-format sync.status"

# Legacy daily results survive an hourly sync after today's run was used.
fresh
printf 'Error: some-cask: upgrade failed\n' >"$s/brew-failure"
export STUB_BREW_OUTPUT="$s/brew-failure"
at "2026-10-12 05:00"; tick
# Model the previous version, which wrote daily results to sync.status.
mv "$home/.local/state/dotfiles-autoupdate/daily.status" "$home/.local/state/dotfiles-autoupdate/sync.status"
legacy_status=$(cat "$home/.local/state/dotfiles-autoupdate/sync.status")
expect_alarm "the legacy brew failure is actionable before migration" "brew upgrade failed for some-cask"
at "2026-10-12 13:00"; tick
expect_eq "migration preserves all daily results and timestamps" "$(cat "$home/.local/state/dotfiles-autoupdate/daily.status")" "$legacy_status"
expect_alarm "migration keeps the unresolved daily failure visible" "daily: brew upgrade failed for some-cask"
expect_eq "migration does not rerun consumed daily work" "$(calls brew)" 1
unset STUB_BREW_OUTPUT STUB_BREW_SUDO
at "2026-10-13 05:00"; tick
expect_no_alarm "a successful daily retry clears the migrated failure"

# 28. The sync agent publishes origin/main to the public mirror on every
# tick (a no-op when the mirror holds it), and a failure alarms: the mirror
# is then behind main.
fresh
at "2026-10-12 05:00"; tick
at "2026-10-12 06:00"; tick
expect_eq "every sync publishes origin/main to the public mirror" "$(grep -c '^public-sync --from-origin$' "$s/log/calls")" 2
export STUB_PUBLIC_FAIL=1
at "2026-10-12 07:00"; tick
expect_alarm "a failed publish alarms that the mirror is behind main" \
  "^dotfiles auto-update: sync: the public mirror is behind main: public-sync --from-origin failed: \\[public-sync\\] LEAK GATE FAILED: 1 hit; see "
unset STUB_PUBLIC_FAIL
at "2026-10-12 08:00"; tick
expect_no_alarm "the next good publish clears it"
fresh
export STUB_OFFLINE=1
at "2026-10-12 05:00"; tick
expect_eq "an offline tick publishes nothing" "$(calls public-sync)" 0

# 29. lavish-axi was retired on 20 Oct 2026, and its upstream CLI opens the
# default browser. The daily run removes it when present instead of letting
# it float to the next release, and never touches it when it is gone.
fresh
export STUB_PNPM_LS='[{"dependencies":{"gh-axi":{},"lavish-axi":{},"chrome-devtools-axi":{},"agent-device":{}}}]'
at "2026-10-12 05:00"; tick
expect_eq "the daily run removes the retired lavish-axi global" "$(calls 'pnpm remove -g lavish-axi$')" 1
expect_eq "a retired global no longer floats" "$(calls 'pnpm update -g --latest gh-axi$')" 1
expect_no_alarm "removing a retired global is no alarm"
unset STUB_PNPM_LS
at "2026-10-13 05:00"; tick
expect_eq "nothing is removed once it is gone" "$(calls 'pnpm remove')" 1

# 30. Every failed pnpm step reaches the alarm: a later failed update once
# overwrote the failed lavish-axi removal, so the alarm named only "update".
fresh
export STUB_PNPM_LS='[{"dependencies":{"gh-axi":{},"lavish-axi":{},"chrome-devtools-axi":{},"agent-device":{}}}]'
export STUB_PNPM_FAIL=1
at "2026-10-12 05:00"; tick
expect_alarm "a failed removal of a retired global stays in the alarm" "remove lavish-axi, update, pin "

# 31. A human switch must never be rolled back by a decision made before it
# (docs/formal/autoupdate-handoff). Apply decides and switches under the
# switch lock, and `rebuild` switches under it too.
# wait_for <seconds> <command>...: polls until the command succeeds.
wait_for() {
  local i n=$(($1 * 10)); shift
  for ((i = 0; i < n; i++)); do "$@" && return 0; /bin/sleep 0.1; done
  return 1
}
# started: how many switches the STUB_SWITCH_HOLD stub has started.
started() { find "$s/hold" -name 'started.*' | wc -l | tr -d ' '; }
# rebuild_bg <out>: the owner's `rebuild` of the checkout, in the background.
rebuild_bg() {
  as "$root_home" bash "$script" rebuild "$home/dotfiles#testhost" </dev/null >"$1" 2>&1 &
  rebuild_pid=$!
}
# Apply samples A, decides to switch to the pushed C, and a darwin-rebuild of
# unpushed L finishes before the switch: the batch 4 counterexample.
fresh
at "2026-10-12 01:00"; commit_local "L: unpushed"
L=$(git -C "$home/dotfiles" rev-parse HEAD)
at "2026-10-12 02:00"; commit_upstream "C: flake.lock bump" flake.lock
C=$(git -C "$s/upstream" rev-parse HEAD)
at "2026-10-12 05:10"
STUB_HUMAN_SWITCH=$L as "$root_home" bash "$script" apply </dev/null >>"$s/log/out" 2>&1 || true
expect_eq "the race probe switches the system after apply sampled it" "$(ls "$s/log/human-switched" 2>/dev/null)" "$s/log/human-switched"
expect_eq "a human switch that lands after apply's decision is not rolled back" "$(running_rev) $(built)" "$L "
at "2026-10-12 06:10"
as "$root_home" bash "$script" apply </dev/null >>"$s/log/out" 2>&1 || true
expect_eq "the next tick waits for the push instead" "$(running_rev) $(built)" "$L "
expect_report "and says it waits for the push" "not on origin/main \(if main was rewritten, run rebuild from main\); waiting for push$"

# A daemon switch in progress makes `rebuild` say so and wait, then switch.
fresh
at "2026-10-12 01:00"; commit_local "L: unpushed"
L=$(git -C "$home/dotfiles" rev-parse HEAD)
at "2026-10-12 02:00"; commit_upstream "C: flake.lock bump" flake.lock
C=$(git -C "$s/upstream" rev-parse HEAD)
mkdir -p "$s/hold"; export STUB_SWITCH_HOLD="$s/hold" AUTOUPDATE_REBUILD_WAIT=60
at "2026-10-12 05:10"
as "$root_home" bash "$script" apply </dev/null >>"$s/log/out" 2>&1 &
apply_pid=$!
wait_for 10 test -e "$s/hold/started.0" || bad "the daemon switch starts" "no switch started"
rebuild_bg "$s/rebuild.out"
wait_for 15 grep -q "waiting up to 1 min" "$s/rebuild.out" || true
expect_eq "rebuild says it waits for the auto-update switch" \
  "$(grep -c '^rebuild: the hourly auto-update (pid [0-9]*) is switching this Mac to the pushed origin/main; waiting up to 1 min for it to finish, then rebuilding' "$s/rebuild.out")" 1
expect_eq "rebuild waits, without switching, while the daemon switches" \
  "$(started) $(kill -0 "$rebuild_pid" 2>/dev/null && echo waiting)" "1 waiting"
touch "$s/hold/release"
wait "$apply_pid" || true
rebuild_code=0; wait "$rebuild_pid" || rebuild_code=$?
expect_eq "rebuild switches after the daemon's switch, and its switch stays" \
  "$(built | tr '\n' ' ')$(running_rev) $rebuild_code" "$C $L $L 0"

# `rebuild` gives up, with a reason and what to do, rather than waiting forever.
fresh
mkdir -p "$s/hold"; export STUB_SWITCH_HOLD="$s/hold" AUTOUPDATE_REBUILD_WAIT=3
# shellcheck disable=SC2016 # $1 expands in the holder's shell
lockf -k "$AUTOUPDATE_DAEMON_DIR/switch.lock" sh -c 'touch "$1"; exec /bin/sleep 30' sh "$s/held" & held=$!
wait_for 5 test -e "$s/held" || bad "the lock holder starts" "no lock taken"
rebuild_bg "$s/rebuild.out"
rebuild_code=0; wait "$rebuild_pid" || rebuild_code=$?
expect_eq "rebuild gives up when the switch lock stays held" "$rebuild_code $(started)" "75 0"
# shellcheck disable=SC2016 # the backquotes are literal text
expect_eq "and says what to do" \
  "$(grep -c '^rebuild: gave up after [0-9]* min: another switch still holds .*Nothing was rebuilt\. See /var/log/dotfiles-autoupdate.log and `dotfiles-autoupdate status`, and run rebuild again once that switch ends\. If the auto-update.s switch is stuck, `sudo pkill -f .darwin-rebuild switch --flake git\[+\]file.` stops it; its activation may still be finishing, so check `pgrep -fl activate` before rebuilding\.$' "$s/rebuild.out")" 1
expect_eq "a lock held by no auto-update is not blamed on it" \
  "$(grep -c '^rebuild: another switch holds the switch lock (an auto-update deciding, or a rebuild in another terminal); waiting up to 0 min' "$s/rebuild.out")" 1
# pkill ends lockf too, so the kill can find it gone.
pkill -P "$held" 2>/dev/null || true; kill "$held" 2>/dev/null || true; wait "$held" 2>/dev/null || true

# Apply never decides while a rebuild holds the lock: it skips at once.
fresh
at "2026-10-12 01:00"; commit_local "L: unpushed"
L=$(git -C "$home/dotfiles" rev-parse HEAD)
at "2026-10-12 02:00"; commit_upstream "C: flake.lock bump" flake.lock
C=$(git -C "$s/upstream" rev-parse HEAD)
mkdir -p "$s/hold"; export STUB_SWITCH_HOLD="$s/hold" AUTOUPDATE_REBUILD_WAIT=60
at "2026-10-12 05:10"
rebuild_bg "$s/rebuild.out"
wait_for 10 test -e "$s/hold/started.0" || bad "the human switch starts" "no switch started"
as "$root_home" bash "$script" apply </dev/null >>"$s/log/out" 2>&1 &
apply_pid=$!
if wait_for 10 sh -c "! kill -0 $apply_pid 2>/dev/null"; then ok "apply does not wait for a rebuild's lock"
else bad "apply does not wait for a rebuild's lock" "apply still running"; fi
touch "$s/hold/release"
wait "$rebuild_pid" || true; wait "$apply_pid" || true
expect_eq "apply skips while a rebuild holds the switch lock" "$(built | tr '\n' ' ')$(running_rev)" "$L $L"
unset STUB_SWITCH_HOLD AUTOUPDATE_REBUILD_WAIT

# 32. `rollback` switches back a generation under the same switch lock, so a
# rollback never overlaps the daemon's switch or is replaced by a decision
# made before it.
# rollback_bg <out> [generation]: the owner's `rollback`, in the background, in
# the alias's environment: sudo sets SUDO_USER, nothing sets AUTOUPDATE_USER,
# and SIGINT is at its default, as in a terminal.
rollback_bg() {
  local out=$1; shift
  as "$root_home" "$coreutils/bin/env" --default-signal=INT -u AUTOUPDATE_USER SUDO_USER=testuser \
    bash "$script" rollback "$@" </dev/null >"$out" 2>&1 &
  rollback_pid=$!
}
# expect_clean <name>: the last rollback left no scratch file in the daemon
# dir and printed no shell error.
expect_clean() {
  expect_eq "$1" "$(find "$AUTOUPDATE_DAEMON_DIR" -name 'rollback.*' | wc -l | tr -d ' ') $(grep -c 'unbound variable' "$s/rollback.out")" "0 0"
}
fresh
at "2026-10-12 01:00"; commit_local "L: unpushed"
L=$(git -C "$home/dotfiles" rev-parse HEAD)
as "$root_home" bash "$script" rebuild "$home/dotfiles#testhost" </dev/null >"$s/rebuild.out" 2>&1 || true
rollback_bg "$s/rollback.out"; rollback_code=0; wait "$rollback_pid" || rollback_code=$?
expect_eq "rollback switches back to the previous generation" "$(built | tr '\n' ' ')$(running_rev) $rollback_code" "$L $A $A 0"
expect_clean "and leaves no scratch file or shell error"
expect_eq "and says the auto-update may switch forward again" \
  "$(grep -c "^rollback: this Mac now runs $A\. If that revision is on origin/main, the hourly auto-update switches forward to origin/main again; to stay on it, push a revert to main\.$" "$s/rollback.out")" 1
rollback_bg "$s/rollback.out" 2; rollback_code=0; wait "$rollback_pid" || rollback_code=$?
expect_eq "rollback <n> switches to generation n" "$(running_rev) $rollback_code" "$L 0"
rollback_bg "$s/rollback.out" latest; rollback_code=0; wait "$rollback_pid" || rollback_code=$?
expect_eq "rollback refuses a generation that is not a number" "$(running_rev) $rollback_code $(grep -c '^usage: dotfiles-autoupdate rollback \[generation\]$' "$s/rollback.out")" "$L 2 1"
# rollback-locked runs as root and runs its arguments, so it takes only a
# darwin-rebuild --switch-generation.
locked_code=0
# shellcheck disable=SC2016 # $1 expands in the refused command's shell
as "$root_home" bash "$script" rollback-locked "$s/locked.result" sh -c 'touch "$1"' sh "$s/locked.ran" </dev/null >/dev/null 2>&1 || locked_code=$?
expect_eq "rollback-locked refuses any other command" "$locked_code $([ -e "$s/locked.ran" ] && echo ran) $(running_rev)" "2  $L"

# A daemon switch in progress makes `rollback` say so and wait, then roll
# back, so the rollback lands last. "Previous" means the generation before
# the one the Mac ran when the owner typed `rollback`, not before the one the
# daemon's switch adds while he waits.
fresh
at "2026-10-12 01:00"; commit_upstream "B: notes"
B=$(git -C "$s/upstream" rev-parse HEAD)
at "2026-10-12 01:10"; tick
at "2026-10-12 02:00"; commit_upstream "C: flake.lock bump" flake.lock
C=$(git -C "$s/upstream" rev-parse HEAD)
mkdir -p "$s/hold"; export STUB_SWITCH_HOLD="$s/hold" AUTOUPDATE_REBUILD_WAIT=60
at "2026-10-12 05:10"
as "$root_home" bash "$script" apply </dev/null >>"$s/log/out" 2>&1 &
apply_pid=$!
wait_for 10 test -e "$s/hold/started.0" || bad "the daemon switch starts" "no switch started"
rollback_bg "$s/rollback.out"
wait_for 15 grep -q "waiting up to 1 min" "$s/rollback.out" || true
expect_eq "rollback says it waits for the auto-update switch, and where it goes after" \
  "$(grep -c '^rollback: the hourly auto-update (pid [0-9]*) is switching this Mac to the pushed origin/main; waiting up to 1 min for it to finish, then rolling back to generation 1\.' "$s/rollback.out")" 1
expect_eq "rollback waits, without switching or holding anything, while the daemon switches" \
  "$(started) $(kill -0 "$rollback_pid" 2>/dev/null && echo waiting) $(cat "$AUTOUPDATE_DAEMON_DIR/attempt" 2>/dev/null)" "1 waiting "
# sync and apply look for a switch with `pgrep -f darwin-rebuild`.
# shellcheck disable=SC2009 # the full command line, as pgrep -f matches it
expect_eq "and its waiting command line names darwin-rebuild, for pgrep -f to find" \
  "$(ps -ax -o args= | grep -F -- "$AUTOUPDATE_DAEMON_DIR/rollback." | grep -c -- ' darwin-rebuild --switch-generation 1$')" 1
touch "$s/hold/release"
wait "$apply_pid" || true
rollback_code=0; wait "$rollback_pid" || rollback_code=$?
expect_eq "rollback lands after the daemon's switch, on the generation before the one it left" \
  "$(built | tr '\n' ' ')$(running_rev) $rollback_code" "$B $C $A $A 0"
expect_eq "and holds off the revision the daemon switched to, not the one it read before waiting" \
  "$(cat "$AUTOUPDATE_DAEMON_DIR/attempt" 2>/dev/null)" "$C $FAKE_NOW"
expect_eq "and says so" \
  "$(grep -c "^rollback: this Mac now runs $A\\. The hourly auto-update will not switch back to ${C:0:12} before Tue 13 Oct 05:10;" "$s/rollback.out")" 1
at "2026-10-12 06:10"; tick
expect_eq "so the next tick keeps the rollback" "$(running_rev) $(built | wc -l | tr -d ' ')" "$A 3"

# `rollback` gives up, with a reason and what to do, rather than waiting forever.
fresh
at "2026-10-12 01:00"; commit_local "L: unpushed"
L=$(git -C "$home/dotfiles" rev-parse HEAD)
as "$root_home" bash "$script" rebuild "$home/dotfiles#testhost" </dev/null >/dev/null 2>&1 || true
mkdir -p "$s/hold"; export STUB_SWITCH_HOLD="$s/hold" AUTOUPDATE_REBUILD_WAIT=3
# shellcheck disable=SC2016 # $1 expands in the holder's shell
lockf -k "$AUTOUPDATE_DAEMON_DIR/switch.lock" sh -c 'touch "$1"; exec /bin/sleep 30' sh "$s/held" & held=$!
wait_for 5 test -e "$s/held" || bad "the lock holder starts" "no lock taken"
rollback_bg "$s/rollback.out"
rollback_code=0; wait "$rollback_pid" || rollback_code=$?
expect_eq "rollback gives up when the switch lock stays held" "$rollback_code $(started) $(running_rev)" "75 0 $L"
expect_eq "and leaves no hold" "$(cat "$AUTOUPDATE_DAEMON_DIR/attempt" 2>/dev/null)" ""
# shellcheck disable=SC2016 # the backquotes are literal text
expect_eq "and says nothing was rolled back" \
  "$(grep -c '^rollback: gave up after [0-9]* min: another switch still holds .*Nothing was rolled back\. See /var/log/dotfiles-autoupdate.log and `dotfiles-autoupdate status`, and run rollback again once that switch ends\. .* before rolling back to generation 1\.$' "$s/rollback.out")" 1
# pkill ends lockf too, so the kill can find it gone.
pkill -P "$held" 2>/dev/null || true; kill "$held" 2>/dev/null || true; wait "$held" 2>/dev/null || true
unset STUB_SWITCH_HOLD AUTOUPDATE_REBUILD_WAIT

# What the hourly apply does after a rollback (README "Updating things").
# From a pushed revision, the rollback records it as a failed attempt, so
# apply holds off switching back to it for a day.
fresh
at "2026-10-12 02:00"; commit_upstream "C: flake.lock bump" flake.lock
C=$(git -C "$s/upstream" rev-parse HEAD)
at "2026-10-12 05:10"; tick
before=$(running_rev)
rollback_bg "$s/rollback.out"; rollback_code=0; wait "$rollback_pid" || rollback_code=$?
expect_eq "rollback from a pushed revision lands" "${before:0:12} $(running_rev) $rollback_code" "${C:0:12} $A 0"
expect_eq "and says when the auto-update may switch back" \
  "$(grep -c "^rollback: this Mac now runs $A\\. The hourly auto-update will not switch back to ${C:0:12} before Tue 13 Oct 05:10; a newer push to main switches forward sooner\\. To stay on this revision, push a revert to main\\.$" "$s/rollback.out")" 1
at "2026-10-12 06:10"; tick
expect_eq "the hourly apply holds off that revision, with no alarm" "$(running_rev) $(alarms | wc -l | tr -d ' ')" "$A 0"
at "2026-10-13 05:20"; tick
expect_eq "and switches forward to it a day later" "$(running_rev)" "$C"
# The hold goes in once the switch lands, under the same switch lock, so no
# apply decides between the two.
fresh
at "2026-10-12 02:00"; commit_upstream "C: flake.lock bump" flake.lock
C=$(git -C "$s/upstream" rev-parse HEAD)
at "2026-10-12 05:10"; tick
mkdir -p "$s/hold"; export STUB_SWITCH_HOLD="$s/hold"
rollback_bg "$s/rollback.out"
wait_for 10 test -e "$s/hold/started.0" || bad "the rollback's switch starts" "no switch started"
as "$root_home" bash "$script" apply </dev/null >>"$s/log/out" 2>&1 || true
expect_eq "no hold before the rollback's switch lands, and no apply decides meanwhile" \
  "$(cat "$AUTOUPDATE_DAEMON_DIR/attempt" 2>/dev/null) $(started)" " 1"
touch "$s/hold/release"
rollback_code=0; wait "$rollback_pid" || rollback_code=$?
unset STUB_SWITCH_HOLD
expect_eq "and the hold is there once it lands" "$(running_rev) $rollback_code $(cut -d' ' -f1 "$AUTOUPDATE_DAEMON_DIR/attempt")" "$A 0 $C"
# A rollback that fails from C takes its new record out again, and puts
# back the one that was there.
held_at=$(cat "$AUTOUPDATE_DAEMON_DIR/attempt")
ln -sfn "$(PATH="$stubs:$PATH" mksystem "$C")" "$AUTOUPDATE_SYSTEM"
at "2026-10-12 05:30"
rollback_bg "$s/rollback.out" 99; rollback_code=0; wait "$rollback_pid" || rollback_code=$?
expect_eq "a failed rollback puts back the record that was there" "$(running_rev) $rollback_code $(cat "$AUTOUPDATE_DAEMON_DIR/attempt")" "$C 1 $held_at"
expect_clean "and leaves no scratch file or shell error"
rm -f "$AUTOUPDATE_DAEMON_DIR/attempt"
rollback_bg "$s/rollback.out" 99; rollback_code=0; wait "$rollback_pid" || rollback_code=$?
expect_eq "and with none, leaves none" "$(running_rev) $rollback_code $(cat "$AUTOUPDATE_DAEMON_DIR/attempt" 2>/dev/null)" "$C 1 "
# A fresh record of a daemon switch that failed stays, so apply does not
# retry that revision at once.
fresh
at "2026-10-12 02:00"; commit_upstream "C: flake.lock bump" flake.lock
C=$(git -C "$s/upstream" rev-parse HEAD)
at "2026-10-12 05:10"; tick
at "2026-10-12 06:00"; commit_upstream "D: broken" flake.lock
D=$(git -C "$s/upstream" rev-parse HEAD)
export STUB_SWITCH_EXIT=1
at "2026-10-12 06:10"; tick
unset STUB_SWITCH_EXIT
failed_at=$(cat "$AUTOUPDATE_DAEMON_DIR/attempt")
at "2026-10-12 07:00"
rollback_bg "$s/rollback.out"; rollback_code=0; wait "$rollback_pid" || rollback_code=$?
expect_eq "a rollback keeps the record of a failed daemon switch" "$(running_rev) $rollback_code $(cat "$AUTOUPDATE_DAEMON_DIR/attempt")" "$A 0 $failed_at"
at "2026-10-12 07:10"; tick
expect_eq "so the hourly apply does not retry that revision at once" "$(running_rev) $(built | grep -c "$D")" "$A 1"
# A rollback to a generation built from unpushed work stays, with the
# waiting-for-push note.
fresh
at "2026-10-12 01:00"; commit_local "L: unpushed"
L=$(git -C "$home/dotfiles" rev-parse HEAD)
as "$root_home" bash "$script" rebuild "$home/dotfiles#testhost" </dev/null >/dev/null 2>&1 || true
commit_local "L2: unpushed"
as "$root_home" bash "$script" rebuild "$home/dotfiles#testhost" </dev/null >/dev/null 2>&1 || true
rollback_bg "$s/rollback.out"; rollback_code=0; wait "$rollback_pid" || rollback_code=$?
at "2026-10-12 05:10"; tick
expect_eq "a rollback to an unpushed generation stays through the hourly apply" "$(running_rev) $rollback_code" "$L 0"
expect_eq "with the waiting-for-push note" "$(report | grep -c "${L:0:12}, which is not on origin/main (if main was rewritten, run rebuild from main); waiting for push$")" 1

# A rollback to an older generation of the running revision (a Home Manager
# repair rebuilds it) leaves nothing for apply to undo, so it holds nothing.
fresh
at "2026-10-12 02:00"; commit_upstream "C: flake.lock bump" flake.lock
C=$(git -C "$s/upstream" rev-parse HEAD)
at "2026-10-12 05:10"; tick
ln -sfn "$s/elsewhere" "$HM_GCROOT"
at "2026-10-12 06:10"; tick
rollback_bg "$s/rollback.out"; rollback_code=0; wait "$rollback_pid" || rollback_code=$?
expect_eq "a rollback to an older generation of the same revision switches and holds nothing" \
  "$(built | grep -c "$C") $(running_rev) $rollback_code $(cat "$AUTOUPDATE_DAEMON_DIR/attempt" 2>/dev/null)" "3 $C 0 "
expect_clean "and leaves no scratch file or shell error"

# A generation list rollback cannot read stops it, with a reason.
fresh
printf 'Generation 1   2026-10-11\nGeneration 2   2026-10-12   (current)\n' >"$s/list"
export STUB_LIST="$s/list"
rollback_bg "$s/rollback.out"; rollback_code=0; wait "$rollback_pid" || rollback_code=$?
unset STUB_LIST
expect_eq "rollback stops on a generation list it cannot read, and says so" \
  "$(running_rev) $rollback_code $(grep -c '^rollback: could not read the generation list' "$s/rollback.out")" "$A 1 1"

# rollback with no older generation says so, and waits for no lock.
fresh
rollback_bg "$s/rollback.out"; rollback_code=0; wait "$rollback_pid" || rollback_code=$?
expect_eq "rollback with no older generation switches nothing" \
  "$(running_rev) $rollback_code $(grep -c '^rollback: there is no generation before the current one (1)\.' "$s/rollback.out")" "$A 1 1"

# 33. The runner's firewall daemon records each poll in its own status file
# (scripts/github-runner reload_when_idle), which status reads like the
# updater's: quiet when good, an alarm on a failed deferred reload. Before
# the first switch creates it there is nothing to read and nothing to say,
# so a push does not alarm until the switch. A pending reload is read from
# its marker, not the daemon's status, so it alarms after 2 hours even when
# the daemon stopped polling. Only a running system whose activation has the
# runner's activate step reads them.
runner_step() { # runner_step: give the running system the runner's activate step
  printf '%s\n' "/nix/store/x-github-runner activate /nix/store/x-github-runner.conf /nix/store/x-launchd/Library/LaunchDaemons/x.plist \\" \
    "  || echo warning" >"$(readlink "$AUTOUPDATE_SYSTEM")/activate"
}
fresh
at "2026-10-12 05:00"; tick
runner_step
expect_no_alarm "no runner status before the first switch is no alarm"
runner_poll() { # runner_poll <line>...: the daemon's latest poll, at the fake time
  printf 'installed\t%s\n' $((FAKE_NOW - 86400)) >"$AUTOUPDATE_RUNNER_STATUS"
  printf '%s\n' "$@" >>"$AUTOUPDATE_RUNNER_STATUS"
}
runner_poll "ok	$FAKE_NOW" "ran	$FAKE_NOW"
expect_no_alarm "a good runner poll is no alarm"
expect_report "a good runner poll reports a success, worded as the daemon's poll and not CI" \
  "^ok: runner-reload: last good poll 0 min ago$"
runner_poll "ok	$((FAKE_NOW - 120))" "ran	$FAKE_NOW" "fail	deferred reload failed: launchd has not loaded /Library/LaunchDaemons/x.plist"
expect_alarm "a failed deferred reload alarms, pointing at the firewall daemon's log" \
  "^dotfiles auto-update: runner-reload: deferred reload failed: launchd has not loaded /Library/LaunchDaemons/x.plist; see /var/log/github-runner-firewall.log$"
# The daemon notes a runner whose starts keep failing (its isolation check,
# or its seatbelt), and status alarms once that is 5 minutes old.
failing="the runner keeps failing to start (last exit 1), so it runs no jobs; see /var/log/github-runner/github-runner.log"
runner_poll "ok	$FAKE_NOW" "ran	$FAKE_NOW" "note	start	$((FAKE_NOW - 240))	300	$failing"
expect_no_alarm "a runner failing to start for 4 minutes is no alarm"
expect_report "a runner failing to start for 4 minutes is reported" "^info: runner-reload: the runner keeps failing to start"
runner_poll "ok	$FAKE_NOW" "ran	$FAKE_NOW" "note	start	$((FAKE_NOW - 300))	300	$failing"
expect_alarm "a runner failing to start for 5 minutes alarms, pointing at its log" \
  "^dotfiles auto-update: runner-reload: the runner keeps failing to start \(last exit 1\), so it runs no jobs; see /var/log/github-runner/github-runner.log \(for 5 min\)$"
# The daemon keeps launchd's count of runs beside the note, for its next poll.
runner_poll "ok	$FAKE_NOW" "ran	$FAKE_NOW" "runs	15" "note	start	$((FAKE_NOW - 300))	300	${failing/exit 1/start killed by Abort trap: 6}"
expect_alarm "the runs count beside the note changes nothing in status" \
  "^dotfiles auto-update: runner-reload: the runner keeps failing to start \(last start killed by Abort trap: 6\), so it runs no jobs; see /var/log/github-runner/github-runner.log \(for 5 min\)$"
runner_poll "ok	$FAKE_NOW" "ran	$FAKE_NOW" "runs	15"
expect_no_alarm "a runs count alone is no alarm"
waiting="the runner restarts on its new config once no job is running"
runner_poll "ok	$FAKE_NOW" "ran	$FAKE_NOW"
mkdir -p "${AUTOUPDATE_RUNNER_RELOAD%/*}"
echo "$((FAKE_NOW - 3600)) /nix/store/x-launchd/Library/LaunchDaemons/x.plist" >"$AUTOUPDATE_RUNNER_RELOAD.pending"
expect_no_alarm "a reload pending for an hour is no alarm"
expect_report "a reload pending for an hour is reported" "^info: runner-reload: $waiting \(switched 1 h ago\)$"
echo "$((FAKE_NOW - 7200)) /nix/store/x-launchd/Library/LaunchDaemons/x.plist" >"$AUTOUPDATE_RUNNER_RELOAD.pending"
expect_alarm "a reload pending for 2 hours alarms" \
  "^dotfiles auto-update: runner-reload: $waiting, but it has waited 2 h since the switch; see /var/log/github-runner-firewall.log$"
rm -f "$AUTOUPDATE_RUNNER_STATUS"
expect_alarm "a reload pending for 2 hours alarms with no daemon status at all" "^dotfiles auto-update: runner-reload: $waiting, but it has waited 2 h"
rm -f "$AUTOUPDATE_RUNNER_RELOAD.pending"
runner_poll "ran	$FAKE_NOW"
at "2026-10-13 18:00"
expect_alarm "a runner daemon with no good poll for 36 hours alarms" "runner-reload: no successful poll for"

# A system without the runner's activate step, after a rollback or a push
# that reverted it, switched the runner itself and runs a firewall daemon
# that neither clears the marker nor writes the status. What the step left
# behind is no alarm and no report.
fresh
at "2026-10-12 05:00"; tick
mkdir -p "${AUTOUPDATE_RUNNER_RELOAD%/*}"
echo "$((FAKE_NOW - 3 * 86400)) /nix/store/x.plist" >"$AUTOUPDATE_RUNNER_RELOAD.pending"
printf 'installed\t%s\nok\t%s\nran\t%s\nfail\tdeferred reload failed: x\n' \
  $((FAKE_NOW - 4 * 86400)) $((FAKE_NOW - 3 * 86400)) $((FAKE_NOW - 3 * 86400)) >"$AUTOUPDATE_RUNNER_STATUS"
expect_no_alarm "a system without the runner's activate step ignores the reload marker and status it left"
got_report=$(report)
expect_eq "a system without the runner's activate step reports nothing about the runner's reload" \
  "$(grep -c runner-reload <<<"$got_report")" 0
runner_step
expect_alarm "the same files alarm once the running system has the step again" "runner-reload: "

# 34. Ctrl-C, or a TERM or HUP, while `rollback` waits for the switch lock
# stops it before it switches, and leaves no hold: the hourly apply goes on
# applying origin/main. A terminal signals its foreground job's whole
# process group, so each run here gets its own group (set -m).
fresh
at "2026-10-12 02:00"; commit_upstream "C: flake.lock bump" flake.lock
C=$(git -C "$s/upstream" rev-parse HEAD)
at "2026-10-12 05:10"; tick
mkdir -p "$s/hold"; export STUB_SWITCH_HOLD="$s/hold" AUTOUPDATE_REBUILD_WAIT=60
# shellcheck disable=SC2016 # $1 expands in the holder's shell
lockf -k "$AUTOUPDATE_DAEMON_DIR/switch.lock" sh -c 'touch "$1"; exec /bin/sleep 60' sh "$s/held" & held=$!
wait_for 5 test -e "$s/held" || bad "the lock holder starts" "no lock taken"
for sig in INT TERM HUP; do
  set -m; rollback_bg "$s/rollback.out"; set +m
  wait_for 15 grep -q "waiting up to 1 min" "$s/rollback.out" \
    || bad "rollback waits for the lock before the $sig" "$(cat "$s/rollback.out")"
  kill -"$sig" -- "-$rollback_pid"
  rollback_code=0; wait "$rollback_pid" 2>/dev/null || rollback_code=$?
  expect_eq "a $sig while rollback waits for the lock stops it, switches nothing and holds nothing" \
    "$([ "$rollback_code" -gt 128 ] && echo stopped) $(started) $(running_rev) $(cat "$AUTOUPDATE_DAEMON_DIR/attempt" 2>/dev/null)" "stopped 0 $C "
done
pkill -P "$held" 2>/dev/null || true; kill "$held" 2>/dev/null || true; wait "$held" 2>/dev/null || true
unset STUB_SWITCH_HOLD AUTOUPDATE_REBUILD_WAIT
expect_eq "and leaves no scratch file" "$(find "$AUTOUPDATE_DAEMON_DIR" -name 'rollback.*' | wc -l | tr -d ' ')" 0
# The cost of a stray hold: Home Manager drifts, and the next tick must
# apply it again.
ln -sfn "$s/elsewhere" "$HM_GCROOT"
at "2026-10-12 06:10"; tick
expect_eq "so the next tick still repairs Home Manager" "$(running_rev) $(built | grep -c "$C")" "$C 2"

# 35. as() hands the updater the clean env launchd would, and nothing else
# from this shell. Under test-sandbox it adds only the sandbox's temp
# settings and its shim dir, after the stubs. A TEST_SANDBOX without its bin
# dir on PATH is a stray export and adds nothing.
fresh
want=("HOME=$home" "TZ=$TZ" "FAKE_NOW=$FAKE_NOW" "SYSTEMS=$SYSTEMS" "HM_GCROOT=$HM_GCROOT")
for v in $(compgen -e | grep -E '^(AUTOUPDATE|STUB)_'); do want+=("$v=${!v}"); done
if [ -n "${TEST_SANDBOX:-}" ] && [[ ":$PATH:" == *":$TEST_SANDBOX/bin:"* ]]; then
  want+=("PATH=$stubs:$real:$TEST_SANDBOX/bin:/usr/bin:/bin:/usr/sbin:/sbin" "TEST_SANDBOX=$TEST_SANDBOX")
  [ -z "${TMPDIR+set}" ] || want+=("TMPDIR=$TMPDIR")
  [ -z "${XDG_CACHE_HOME+set}" ] || want+=("XDG_CACHE_HOME=$XDG_CACHE_HOME")
else
  want+=("PATH=$stubs:$real:/usr/bin:/bin:/usr/sbin:/sbin")
fi
expect_eq "the updater runs with exactly the clean env, and the sandbox's settings only under test-sandbox" \
  "$(as "$home" /usr/bin/env | LC_ALL=C sort)" "$(printf '%s\n' "${want[@]}" | LC_ALL=C sort)"

# 36. Audit H2 (26 Oct 2026): any process running as myuser could commit on
# top of the running revision in ~/dotfiles, write that commit to the sync's
# hand-over file, and the root daemon built it at the next tick. Root now
# fetches GitHub's main into its own clone and builds only that.
apply_now() { as "$root_home" bash "$script" apply </dev/null >>"$s/log/out" 2>&1 || true; }
state="$home/.local/state/dotfiles-autoupdate"
fresh
at "2026-10-12 05:00"; tick
commit_local "X: not on GitHub"
X=$(git -C "$home/dotfiles" rev-parse HEAD)
echo "$X" >"$state/revision"
at "2026-10-12 05:10"; apply_now
expect_eq "a commit written to myuser's hand-over file is never built as root" "$(running_rev) $(built)" "$A "
git -C "$home/dotfiles" update-ref refs/remotes/origin/main "$X"
echo "$X" >"$state/revision"
at "2026-10-12 06:10"; apply_now
expect_eq "nor when myuser's own origin/main ref names it too" "$(running_rev) $(built)" "$A "

# A push goes live with no sync at all: the daemon fetches GitHub's main.
fresh
at "2026-10-12 05:00"; tick
at "2026-10-12 05:30"; commit_upstream "C: push"
C=$(git -C "$s/upstream" rev-parse HEAD)
at "2026-10-12 06:10"; apply_now
expect_eq "apply switches to a new push by itself, with no sync" "$(running_rev)" "$C"
expect_eq "built from root's own clone at exactly that revision" \
  "$(tail -n 1 "$s/log/flake-refs")" "git+file://$root/repo.git?rev=$C#testhost"
expect_eq "and logs the fetch for the real-machine check" "$(grep -c "fetched GitHub main $C$" "$s/log/out")" 1
expect_eq "the sync leaves no hand-over file behind" "$(at "2026-10-12 07:00"; tick; ls "$state/revision" 2>/dev/null)" ""

# A hand-over file with anything in it means nothing to apply now.
fresh
at "2026-10-12 05:00"; tick
printf 'not a commit\n' >"$state/revision"
at "2026-10-12 05:10"; apply_now
expect_no_alarm "a garbage hand-over file is ignored"

# Root's clone and key are root's alone. Anything else alarms at once and
# stops before any fetch or build, and apply never changes a mode or writes
# through a link.
# expect_refused <name> <alarm regex>: the next tick alarms and builds nothing.
expect_refused() {
  at "2026-10-12 04:30"; commit_upstream "C: push"
  at "2026-10-12 05:00"; tick
  expect_alarm "$1 alarms" "$2"
  expect_eq "$1 fetches and builds nothing" \
    "$(built) $(git --git-dir="$root/repo.git" rev-parse -q --verify refs/remotes/origin/main 2>/dev/null)" " "
}
fresh
rm -f "$root/deploy_key"
expect_refused "no deploy key" \
  "^dotfiles auto-update: switch: there is no deploy key at $root/deploy_key; generate it as root and add it to GitHub read-only \(docs/secrets\.md, \"Auto-update deploy key\", steps 1-3\); nothing was fetched or switched; see "
fresh
chmod 644 "$root/deploy_key"
expect_refused "a deploy key others can read" "switch: $root/deploy_key must be a regular file \(not a link\) owned by root with mode 600 or 400"
expect_eq "and its mode stays" "$(/usr/bin/stat -f %Lp "$root/deploy_key")" 644
fresh
chmod 755 "$root"
expect_refused "a clone dir others can list" "switch: $root must be a directory \(not a link\) owned by root with mode 700"
expect_eq "and its mode stays" "$(/usr/bin/stat -f %Lp "$root")" 755
fresh
mv "$root" "$s/elsewhere-root"
ln -s "$s/elsewhere-root" "$root"
expect_refused "a clone dir that is a link" "switch: $root must be a directory \(not a link\)"
expect_eq "and nothing is written through the link" "$(ls -A "$s/elsewhere-root") $(/usr/bin/stat -f %Lp "$s/elsewhere-root")" "deploy_key 700"
fresh
chmod 777 "$s/var-lib"
expect_refused "a parent dir others can write" "switch: $s/var-lib is not a directory that only root can write"
chmod 755 "$s/var-lib"

# Before the owner's key steps: the daemon makes its 0700 dir, then alarms on
# the missing key each tick and switches nothing; the sync agent notifies
# him once.
fresh
rm -rf "$root"
expect_refused "a Mac with no key steps done yet" "switch: there is no deploy key at $root/deploy_key"
expect_eq "creates only root's dir, mode 700" "$(/usr/bin/stat -f %Lp "$root") $(ls -A "$root")" "700 "
for h in 06 07 08; do at "2026-10-12 $h:00"; tick; done
expect_eq "and notifies once" "$(grep -c '^notify there is no deploy key' "$s/log/calls")" 1

# The fetch from GitHub: pinned ssh options, the 443 fallback, and how each
# failure reads. Through the stub ssh, on the real default URLs.
fresh
unset AUTOUPDATE_REMOTE
at "2026-10-12 04:30"; commit_upstream "C: push"
C=$(git -C "$s/upstream" rev-parse HEAD)
at "2026-10-12 05:00"; tick
expect_eq "apply fetches GitHub's main over ssh and switches to it" "$(running_rev)" "$C"
expect_eq "ssh reads no config or agent, uses only the deploy key and trusts only the pinned host keys" \
  "$(head -n 1 "$s/log/ssh" | sed 's/ -o SendEnv=GIT_PROTOCOL//; s/ git-upload-pack .*//')" \
  "ssh -F /dev/null -i $root/deploy_key -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$repo/nix/github-known-hosts -o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no -o ConnectTimeout=20 git@github.com"
fresh
unset AUTOUPDATE_REMOTE
export STUB_SSH=offline22
at "2026-10-12 04:30"; commit_upstream "C: push"
C=$(git -C "$s/upstream" rev-parse HEAD)
at "2026-10-12 05:00"; tick
expect_eq "a blocked port 22 falls back to ssh.github.com:443" \
  "$(running_rev) $(grep -c -- '-p 443 git@ssh.github.com ' "$s/log/ssh")" "$C 1"
expect_no_alarm "and raises no alarm"
for kind in auth hostkey; do
  fresh
  unset AUTOUPDATE_REMOTE
  export STUB_SSH=$kind
  case $kind in
    auth) refusal="switch: GitHub refused the deploy key at $root/deploy_key \(not added to microcerebus/dotfiles-public, or revoked" ;;
    hostkey) refusal="switch: GitHub's SSH host key does not match the pinned keys in $repo/nix/github-known-hosts" ;;
  esac
  expect_refused "a fetch that fails with STUB_SSH=$kind" "$refusal"
  expect_eq "and it does not retry on port 443" "$(grep -c -- '-p 443' "$s/log/ssh")" 0
done
fresh
unset AUTOUPDATE_REMOTE
export STUB_SSH=offline
at "2026-10-12 04:30"; commit_upstream "C: push"
at "2026-10-12 05:10"; tick
expect_report "GitHub unreachable on both ports is reported" "^info: switch: GitHub is unreachable over SSH, on ports 22 and 443"
expect_no_alarm "and is no alarm at first, as after a wake"
for h in 06 07 08 09 10 11; do at "2026-10-12 $h:10"; apply_now; done
expect_alarm "and alarms after 6 h" "switch: GitHub is unreachable over SSH, on ports 22 and 443 .* \(for 6 h\)$"
expect_eq "and never builds" "$(built)" ""

# A force-push that drops the running revision is never applied silently,
# whatever tree it brings: apply says so and waits for a human rebuild.
fresh
at "2026-10-12 04:30"; commit_upstream "C: push"
C=$(git -C "$s/upstream" rev-parse HEAD)
at "2026-10-12 05:00"; tick
git -C "$s/upstream" reset -q --hard "$A"
echo "F" >>"$s/upstream/notes"
git -C "$s/upstream" -c user.email=t@example.com -c user.name=t commit -qam "F: rewritten"
git -C "$s/upstream" push -q -f origin main
at "2026-10-12 06:10"; apply_now
expect_eq "a rewritten main is not switched to" "$(running_rev) $(built | wc -l | tr -d ' ')" "$C 1"
expect_report "and apply says main was rewritten" "^info: switch: GitHub's main was rewritten and no longer contains ${C:0:12}, which this Mac runs; run rebuild from main to accept it$"
at "2026-10-12 08:10"; apply_now
expect_alarm "and alarms after 2 h" "switch: GitHub's main was rewritten"

# A sync lock naming a live pid (myuser's uid writes it) stalls every switch;
# apply alarms once it has waited 6 h, keeping the last run's notes.
fresh
at "2026-10-12 01:00"; commit_local "L: unpushed"
ln -sfn "$(PATH="$stubs:$PATH" mksystem "$(git -C "$home/dotfiles" rev-parse HEAD)")" "$AUTOUPDATE_SYSTEM"
ln -sfn "$(cat "$AUTOUPDATE_SYSTEM/closure")" "$HM_GCROOT"
at "2026-10-12 05:00"; tick
mkdir -p "$state/lock"
/bin/sleep 600 & held=$!
echo "$held" >"$state/lock/pid"
for h in 06 07 08 09 10 11; do at "2026-10-12 $h:10"; apply_now; done
expect_report "a held sync lock is reported" "^info: switch: every switch waits for dotfiles-sync"
at "2026-10-12 12:10"; apply_now
expect_alarm "a sync lock held 6 h alarms" "switch: every switch waits for dotfiles-sync, whose lock names a live pid \($held\); see .* \(for 6 h\)$"
expect_alarm "and keeps the waiting-for-push alarm it carried" "switch: the running system is built from .* waiting for push \(for 7 h\)$"
rm -f "$state/lock/pid"; mkfifo "$state/lock/pid"
at "2026-10-12 13:10"
as "$root_home" "$coreutils/bin/timeout" 30 bash "$script" apply </dev/null >>"$s/log/out" 2>&1 || true
# Reads the alarms first: under pipefail, `alarms | grep -q` fails whenever
# grep's early exit kills the writer, which read a match as no match.
expect_no_alarm_matching() {
  local got; got=$(alarms)
  if grep -q -- "$2" <<<"$got"; then bad "$1" "want no alarm matching: $2" "got: $got"; else ok "$1"; fi
}
expect_no_alarm_matching "a FIFO for a lock pid is no sync, and never hangs apply" "every switch waits"
kill "$held" 2>/dev/null; wait "$held" 2>/dev/null || true

# GitHub's host keys, pinned in nix/github-known-hosts for both names root
# connects to, match the fingerprints GitHub publishes at
# https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
# (read 26 Oct 2026). A key rotation needs both changed.
expect_eq "the pinned GitHub host keys match GitHub's published fingerprints" \
  "$(ssh-keygen -lf "$repo/nix/github-known-hosts" | awk '{ print $2, $3, $4 }' | LC_ALL=C sort)" \
  "$(printf '%s\n' \
    'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU github.com,[ssh.github.com]:443 (ED25519)' \
    'SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM github.com,[ssh.github.com]:443 (ECDSA)' \
    'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s github.com,[ssh.github.com]:443 (RSA)' | LC_ALL=C sort)"

# 37. The review of 26 Oct 2026 (c41-d1-review-r1b), fix round 2.
# A failed switch, then a tick with GitHub unreachable (as right after a
# wake), then GitHub back while the failed revision is held for a day (probe
# P1). The failure alarm stays the whole time, and no stale "unreachable"
# note alarms 6 h after GitHub answered again.
fresh
unset AUTOUPDATE_REMOTE
at "2026-10-12 04:00"; tick
at "2026-10-12 04:30"; commit_upstream "C: push"
C=$(git -C "$s/upstream" rev-parse HEAD)
export STUB_SWITCH_EXIT=1
at "2026-10-12 05:10"; apply_now
unset STUB_SWITCH_EXIT
export STUB_SSH=offline
at "2026-10-12 06:10"; apply_now
expect_alarm "a failed switch still alarms after a tick with GitHub unreachable" "switch: switch to ${C:0:12} failed \(exit 1\)"
expect_report "and that tick reports GitHub unreachable" "^info: switch: GitHub is unreachable over SSH"
unset STUB_SSH
for h in 07 08 09 10 11 12; do at "2026-10-12 $h:10"; apply_now; done
expect_alarm "and keeps alarming once GitHub is back, while the revision is held" "switch: switch to ${C:0:12} failed \(exit 1\)"
expect_no_alarm_matching "with no stale 'GitHub is unreachable' alarm 6 h later" "GitHub is unreachable"
expect_eq "and the held revision is not retried within the day" "$(built | tr '\n' ' ')" "$C "
at "2026-10-13 05:20"; apply_now
expect_eq "the retry a day later switches" "$(running_rev)" "$C"
expect_no_alarm "and clears the alarm"

# the owner pushes P, rebuilds it before the :10 tick, finds it broken and rolls
# back, still before the tick (probe P2). rollback fetches GitHub's main
# first, so root's clone knows P and the hold covers it.
fresh
at "2026-10-12 05:10"; tick
at "2026-10-12 05:30"; commit_upstream "P: push"
P=$(git -C "$s/upstream" rev-parse HEAD)
git -C "$home/dotfiles" pull -q --ff-only
as "$root_home" bash "$script" rebuild "$home/dotfiles#testhost" </dev/null >"$s/rebuild.out" 2>&1 || true
expect_eq "a rebuild of a fresh push lands it before the tick" "$(running_rev)" "$P"
at "2026-10-12 05:40"
rollback_bg "$s/rollback.out"; rollback_code=0; wait "$rollback_pid" || rollback_code=$?
expect_eq "a rollback from it, still before the tick, holds it off for a day" \
  "$(running_rev) $rollback_code $(cat "$AUTOUPDATE_DAEMON_DIR/attempt" 2>/dev/null)" "$A 0 $P $FAKE_NOW"
expect_eq "and says so" \
  "$(grep -c "^rollback: this Mac now runs $A\\. The hourly auto-update will not switch back to ${P:0:12} before Tue 13 Oct 05:40;" "$s/rollback.out")" 1
for h in 06 07; do at "2026-10-12 $h:10"; tick; done
expect_eq "so the hourly apply does not switch back to it" "$(running_rev) $(built | grep -c "$P")" "$A 1"

# A rollback that cannot reach GitHub says so and still rolls back; the hold
# then goes by the clone's last hourly fetch, and rollback's last line says
# which way it went.
fresh
unset AUTOUPDATE_REMOTE
at "2026-10-12 05:10"; tick
at "2026-10-12 05:30"; commit_upstream "P: push"
P=$(git -C "$s/upstream" rev-parse HEAD)
git -C "$home/dotfiles" pull -q --ff-only
as "$root_home" bash "$script" rebuild "$home/dotfiles#testhost" </dev/null >"$s/rebuild.out" 2>&1 || true
export STUB_SSH=offline
at "2026-10-12 05:40"
rollback_bg "$s/rollback.out"; rollback_code=0; wait "$rollback_pid" || rollback_code=$?
unset STUB_SSH
expect_eq "a rollback with GitHub unreachable still rolls back" "$(running_rev) $rollback_code" "$A 0"
expect_eq "and says it could not fetch first" \
  "$(grep -c "^rollback: could not fetch GitHub's main first: GitHub is unreachable over SSH, on ports 22 and 443 (.*)\\. Rolling back anyway; the hold goes by the auto-update's last fetch\\.$" "$s/rollback.out")" 1
expect_eq "and that the auto-update may switch forward again" \
  "$(grep -c "^rollback: this Mac now runs $A\\. If that revision is on origin/main, the hourly auto-update switches forward" "$s/rollback.out")" 1
expect_clean "and leaves no scratch file or shell error"

# Apply fetches before it takes the switch lock, so a slow GitHub never holds
# up a human switch, and decides under the lock from the clone's tip.
fresh
at "2026-10-12 05:30"; commit_upstream "C: push"
C=$(git -C "$s/upstream" rev-parse HEAD)
# shellcheck disable=SC2016 # $1 and $2 expand in the holder's shell
lockf -k "$AUTOUPDATE_DAEMON_DIR/switch.lock" sh -c 'touch "$1"; while [ ! -e "$2" ]; do /bin/sleep 0.1; done' \
  sh "$s/held" "$s/release-lock" & held=$!
wait_for 5 test -e "$s/held" || bad "the lock holder starts" "no lock taken"
at "2026-10-12 06:10"; apply_now
expect_eq "apply fetches GitHub's main while a rebuild holds the switch lock" \
  "$(git --git-dir="$root/repo.git" rev-parse -q --verify refs/remotes/origin/main) $(running_rev)" "$C $A"
expect_eq "and leaves the decision to the next tick" "$(grep -c 'the switch lock is held' "$s/log/out")" 1
touch "$s/release-lock"; wait "$held" || true
at "2026-10-12 07:10"; apply_now
expect_eq "which switches to the clone's tip" "$(running_rev)" "$C"

# Root reads the pid in myuser's sync lock with one open that follows no link,
# and only from a regular file (the FIFO case is in 36).
fresh
at "2026-10-12 05:00"; tick
mkdir -p "$state/lock"
echo "$$" >"$s/pid-elsewhere"
ln -s "$s/pid-elsewhere" "$state/lock/pid"
at "2026-10-12 05:30"; commit_upstream "C: push"
C=$(git -C "$s/upstream" rev-parse HEAD)
at "2026-10-12 06:10"; apply_now
expect_eq "a sync lock pid that is a link to a live pid is no sync" "$(running_rev)" "$C"
expect_no_alarm_matching "and is never reported as one" "every switch waits"
rm -f "$state/lock/pid"

# Whether GitHub's main once had the running revision comes from the commits
# root's clone holds, which only ever come from GitHub's main, not from its
# reflog, whose entries can expire. A clone that never saw the revision
# cannot tell unpushed from rewritten, and its note claims neither.
fresh
at "2026-10-12 04:30"; commit_upstream "C: push"
C=$(git -C "$s/upstream" rev-parse HEAD)
at "2026-10-12 05:00"; tick
git -C "$s/upstream" reset -q --hard "$A"
echo "F" >>"$s/upstream/notes"
git -C "$s/upstream" -c user.email=t@example.com -c user.name=t commit -qam "F: rewritten"
git -C "$s/upstream" push -q -f origin main
git --git-dir="$root/repo.git" reflog expire --expire=now --expire-unreachable=now --all
at "2026-10-12 06:10"; apply_now
expect_report "a rewritten main reads as rewritten with the clone's reflog expired" \
  "^info: switch: GitHub's main was rewritten and no longer contains ${C:0:12}, which this Mac runs; run rebuild from main to accept it$"
rm -rf "$root/repo.git"
at "2026-10-12 07:10"; apply_now
expect_report "a clone made after the rewrite says only what it knows" \
  "^info: switch: the running system is built from ${C:0:12}, which is not on origin/main \(if main was rewritten, run rebuild from main\); waiting for push$"
expect_eq "and neither builds" "$(built | wc -l | tr -d ' ')" 1

# Root's fetch reads no global or system git config, so a gitconfig in
# root's HOME cannot point it at another repo (probe P3).
fresh
git init -q --bare -b main "$s/evil.git"
git clone -q "$s/origin.git" "$s/evilwork" 2>/dev/null
echo evil >>"$s/evilwork/notes"
git -C "$s/evilwork" -c user.email=t@example.com -c user.name=t commit -qam "E: evil"
git -C "$s/evilwork" push -q "$s/evil.git" HEAD:main
printf '[url "%s"]\n\tinsteadOf = %s\n' "$s/evil.git" "$s/origin.git" >"$root_home/.gitconfig"
at "2026-10-12 05:10"; apply_now
expect_eq "a gitconfig in root's HOME does not redirect the fetch" \
  "$(running_rev) $(git --git-dir="$root/repo.git" rev-parse -q --verify refs/remotes/origin/main)" "$A $A"
rm -f "$root_home/.gitconfig"

# Nix builds root's clone, in the shape apply makes it, at an exact ?rev=,
# and prints nothing about a HEAD it cannot resolve (the 26 Oct 2026 probe).
fresh
git -C "$s/upstream" rm -q flake.lock
echo '{ outputs = _: { }; }' >"$s/upstream/flake.nix"
commit_upstream "N: a flake"
N=$(git -C "$s/upstream" rev-parse HEAD)
at "2026-10-12 05:10"; apply_now
nix flake metadata --json "git+file://$root/repo.git?rev=$N" >"$s/nix.json" 2>"$s/nix.err" || true
expect_eq "nix reads root's clone at ?rev=" "$(jq -r .revision "$s/nix.json" 2>/dev/null)" "$N"
expect_eq "and prints no warning or error, about its HEAD or anything else" \
  "$(tr '\r' '\n' <"$s/nix.err" | grep -Ei '^(warning|error|fatal)' | head -n 3)" ""

# Root asks no git question as myuser anywhere in this suite: nothing ran sudo.
expect_eq "no run of the updater calls sudo" "$(sort -u "$STUB_SUDO_LOG")" ""

exit "$fail"
