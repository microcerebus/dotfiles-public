#!/usr/bin/env bash
# Tests for scripts/github-runner against stub runner binaries, sudo, nix, gh,
# netstat, lsof and pfctl, and for the runner's pf rules (nix/github-runner.pf).
# The listener probes use the real nc against real sockets on 127.0.0.1 and
# ::1; a stub nc sends tailnet addresses there too. Nothing else touches the
# network. Writes only to a temp dir.
# Run: bash tests/github_runner_test.sh
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
script="$repo/scripts/github-runner"
# Physical, so the chflags stub can match the directory -execdir runs it in.
tmp="$(cd "$(mktemp -d)" && pwd -P)"
server=
# scrub <dir>: lift every flag, ACL and closed mode the cases below set, top
# down so find can enter each directory after opening it, then delete <dir>.
scrub() {
  find -P "$1" \( -flags +uchg,uappnd -execdir chflags -h nouchg,nouappnd {} \; -o -true \) \
    \( -acl -type l -execdir chmod -h -N {} \; -o -true \) \( -acl ! -type l -execdir chmod -N {} \; -o -true \) \
    \( -type d ! -perm -0700 -execdir chmod u+rwx {} \; -o -true \) 2>/dev/null || true
  rm -rf "$1"
}
trap '[ -z "$server" ] || kill "$server" 2>/dev/null; scrub "$tmp"' EXIT
fail=0
token=test-registration-token

ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; shift; printf '  %s\n' "$@"; fail=1; }

# Stubs. config.sh registers only with the good token and records how it was
# called; the listener records the environment it was started with.
stubs="$tmp/stubs"
mkdir -p "$stubs"
cat >"$stubs/config.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >"$STUB_LOG/config.args"
printf '%s\n' "${ACTIONS_RUNNER_INPUT_TOKEN:-}" >"$STUB_LOG/config.token"
[ "${ACTIONS_RUNNER_INPUT_TOKEN:-}" = test-registration-token ] || exit 1
echo new >"$RUNNER_ROOT/.runner"
echo new >"$RUNNER_ROOT/.credentials"
EOF
cat >"$stubs/Runner.Listener" <<'EOF'
#!/usr/bin/env bash
printf 'args=%s\nHOME=%s\nTMPDIR=%s\nRUNNER_ROOT=%s\nTOKEN=%s\n' \
  "$*" "$HOME" "$TMPDIR" "$RUNNER_ROOT" "${ACTIONS_RUNNER_INPUT_TOKEN:-}" >"$STUB_LOG/listener"
EOF
cat >"$stubs/sudo" <<'EOF'
#!/usr/bin/env bash
[ "${STUB_SUDO_OK:-0}" = 1 ]
EOF
cat >"$stubs/nix" <<'EOF'
#!/usr/bin/env bash
[ "$*" = "store info --json" ] || exit 2
if [ "${STUB_NIX_TRUSTED:-0}" = 1 ]; then echo '{"trusted":true}'; else echo '{"trusted":false}'; fi
EOF
cat >"$stubs/gh" <<'EOF'
#!/usr/bin/env bash
[ "${STUB_GH_FAIL:-0}" = 1 ] && { echo "HTTP 401" >&2; exit 1; }
[ "$*" = "api -X POST repos/owner/repo/actions/runners/registration-token --jq .token" ] || exit 2
echo test-registration-token
EOF
# netstat and lsof print the fixtures a case writes to STUB_LOG.
cat >"$stubs/netstat" <<'EOF'
#!/usr/bin/env bash
[ "$*" = "-an -p tcp" ] || exit 2
cat "$STUB_LOG/netstat.txt"
EOF
cat >"$stubs/lsof" <<'EOF'
#!/usr/bin/env bash
[ "$*" = "-nP -a -u $(id -u) -iTCP -sTCP:LISTEN -Fn" ] || exit 2
cat "$STUB_LOG/lsof.txt" 2>/dev/null || true
EOF
# pfctl keeps its state in STUB_LOG: the main ruleset (pf.main), the anchor's
# rules (pf.anchor), whether pf is on (pf.enabled), and the changes it made.
cat >"$stubs/pfctl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "-s rules") cat "$STUB_LOG/pf.main" ;;
  "-a com.apple/github-runner -s rules") cat "$STUB_LOG/pf.anchor" 2>/dev/null || true ;;
  "-q -a com.apple/github-runner -f "*) cp "$5" "$STUB_LOG/pf.anchor" && echo "load $5" >>"$STUB_LOG/pf.calls" ;;
  "-s info")
    if [ -e "$STUB_LOG/pf.enabled" ]; then echo "Status: Enabled for 0 days 00:00:01           Debug: Urgent"
    else echo "Status: Disabled                              Debug: Urgent"; fi ;;
  "-q -E") touch "$STUB_LOG/pf.enabled" && echo enable >>"$STUB_LOG/pf.calls" ;;
  *) exit 2 ;;
esac
EOF
# launchctl keeps the runner's job in STUB_LOG: launchctl.loaded is the plist
# launchd loaded, absent when the runner is not loaded. Every call is logged.
# STUB_LOAD_PENDING=<file>: a load also writes <file>, as a switch that
# installs a newer plist during the reload would. STUB_UNLOAD_KILL=before or
# after kills the caller just before or just after the unload takes effect,
# as a daemon killed in the middle of a reload would be.
cat >"$stubs/launchctl" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG/launchctl.calls"
case "$1" in
  print) [ -e "$STUB_LOG/launchctl.loaded" ] ;;
  unload)
    # Like launchctl, a failed unload can still exit 0.
    [ "${STUB_UNLOAD_FAIL:-0}" = 1 ] && { echo "Unload failed: 5: Input/output error" >&2; exit 0; }
    [ "${STUB_UNLOAD_KILL:-}" != before ] || { kill -KILL "$PPID"; exit 0; }
    rm -f "$STUB_LOG/launchctl.loaded"
    [ "${STUB_UNLOAD_KILL:-}" != after ] || kill -KILL "$PPID" ;;
  load)
    [ "${STUB_LOAD_FAIL:-0}" = 1 ] && { echo "Load failed: 5: Input/output error" >&2; exit 0; }
    [ -z "${STUB_LOAD_PENDING:-}" ] || echo "9 newer" >"$STUB_LOAD_PENDING"
    cp "${@: -1}" "$STUB_LOG/launchctl.loaded" ;;
  *) exit 2 ;;
esac
EOF
# date +%s reads the test's clock, STUB_LOG/now, so a test and the script it
# runs agree on the time to the second; every other date is the real one.
cat >"$stubs/date" <<'EOF'
#!/usr/bin/env bash
if [ "$*" = +%s ] && [ -s "${STUB_LOG:-}/now" ]; then cat "$STUB_LOG/now"; else exec /bin/date "$@"; fi
EOF
# pgrep exits as pgrep.code says: 0 a job's worker runs, 1 none (the default).
cat >"$stubs/pgrep" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG/pgrep.calls"
exit "$(cat "$STUB_LOG/pgrep.code" 2>/dev/null || echo 1)"
EOF
# nc is the real one, except that it sends any 100.x and fd7a: address to
# loopback, so a tailnet listener answers or refuses as fast as a local one.
cat >"$stubs/nc" <<'EOF'
#!/usr/bin/env bash
args=()
for a in "$@"; do
  case "$a" in 100.*.*.*) a=127.0.0.1 ;; fd7a:*) a=::1 ;; esac
  args+=("$a")
done
exec /usr/bin/nc "${args[@]}"
EOF
# chflags as the runner user meets it on what macOS protects: it refuses
# the paths listed in $STUB_LOG/protected and below them, and passes the
# rest of the batch to the real one, exiting 1 if it refused any. find
# -execdir passes a name relative to the directory it runs in, which is
# resolved against that directory. The script calls /usr/bin/chflags, so
# the cases that need the stub run a copy pointed here (run_protected).
cat >"$stubs/chflags" <<'EOF'
#!/usr/bin/env bash
[ -e "$STUB_LOG/protected" ] || exec /usr/bin/chflags "$@"
opts=()
while [ $# -gt 0 ]; do
  case "$1" in --) opts+=("$1"); shift; break ;; -*) opts+=("$1"); shift ;; *) break ;; esac
done
flags="$1"; shift
refused=0 pass=()
for a in "$@"; do
  case "$a" in /*) abs="$a" ;; *) abs="$(pwd -P)/${a#./}" ;; esac
  hit=0
  while IFS= read -r p; do
    case "$abs" in "$p" | "$p"/*) hit=1 ;; esac
  done <"$STUB_LOG/protected"
  if [ "$hit" = 1 ]; then echo "chflags: $a: Operation not permitted" >&2; refused=1; else pass+=("$a"); fi
done
if [ "${#pass[@]}" != 0 ]; then /usr/bin/chflags ${opts[@]+"${opts[@]}"} "$flags" "${pass[@]}" || exit 1; fi
exit "$refused"
EOF
# python3 is the real one unless a case makes it fail.
real_python3="$(command -v python3)"
# shellcheck disable=SC2016 # the stub expands these, not this script
printf '#!/usr/bin/env bash\n[ "${STUB_PYTHON_FAIL:-0}" = 1 ] && exit 1\nexec %q "$@"\n' "$real_python3" >"$stubs/python3"
chmod +x "$stubs"/*

# A real listener on 127.0.0.1 stands in for one of the owner's services. Two
# ports, one per address family, have nothing on them (bound, then released).
"$real_python3" -c '
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
s.listen()
print(s.getsockname()[1], flush=True)
while True:
    s.accept()[0].close()
' >"$tmp/open.port" &
server=$!
for _ in $(seq 50); do [ -s "$tmp/open.port" ] && break; sleep 0.1; done
open="$(cat "$tmp/open.port")"
read -r closed4 closed6 < <("$real_python3" -c '
import socket
a = socket.socket(); a.bind(("127.0.0.1", 0))
b = socket.socket(socket.AF_INET6); b.bind(("::1", 0))
print(a.getsockname()[1], b.getsockname()[1])
')

# The runner's launchd label, as activation and its plist name use it.
label=$(nix eval --raw "$repo#darwinConfigurations.myhost.config.launchd.daemons.github-runner.serviceConfig.Label")

# netstat_rows <proto local state>...: the rows as `netstat -an -p tcp` prints them.
netstat_rows() {
  echo "Active Internet connections (including servers)"
  echo "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)"
  while [ $# -ge 3 ]; do
    printf '%-5s      0      0  %-22s %-22s %s\n' "$1" "$2" '*.*' "$3"
    shift 3
  done
}

# fresh: a new runner layout under $tmp/r with a config file pointing at it.
# The protected home is closed to the runner user, as the owner's home is,
# though a directory below it is world-readable, like ~/.t3. netstat lists
# four listeners of other users with nothing behind them, two on the
# tailnet, so every probe is refused. pf runs Apple's stock main ruleset.
fresh() {
  [ ! -e "$tmp/r" ] || scrub "$tmp/r"
  r="$tmp/r"
  mkdir -p "$r"/{state,work,home,tmp,inbox,log} "$r/protected/.t3"
  chmod 755 "$r/protected/.t3"
  chmod 000 "$r/protected"
  netstat_rows tcp4 "127.0.0.1.$closed4" LISTEN tcp6 "*.$closed6" LISTEN \
    tcp4 "100.99.1.2.$closed4" LISTEN tcp6 "fd7a:115c:a1e0::1.$closed6" LISTEN \
    tcp4 "127.0.0.1.$open" ESTABLISHED >"$r/log/netstat.txt"
  /bin/date +%s >"$r/log/now"
  printf '%s\n' 'scrub-anchor "com.apple/*" all fragment reassemble' 'anchor "com.apple/*" all' >"$r/log/pf.main"
  echo "pass all" >"$r/rules.pf"
  # A tool seed as nix/github-runner.nix builds it: read-only, like the store.
  mkdir -p "$r/seed/node/22.23.2/arm64/bin" "$r/seed/node/22.23.2/arm64/lib"
  printf '#!/bin/sh\necho v22.23.2\n' >"$r/seed/node/22.23.2/arm64/bin/node"
  chmod +x "$r/seed/node/22.23.2/arm64/bin/node"
  ln -s ../lib/npm-cli.js "$r/seed/node/22.23.2/arm64/bin/npm"
  touch "$r/seed/node/22.23.2/arm64/lib/npm-cli.js" "$r/seed/node/22.23.2/arm64.complete"
  chmod -R a-w "$r/seed"
  cat >"$r/conf" <<EOF
url=https://github.com/owner/repo
name=testhost
labels=job-tracker
bin=$stubs
state=$r/state
work=$r/work
home=$r/home
tmp=$r/tmp
tool=$r/work/_tool
seed=$r/seed
inbox=$r/inbox
protected=$r/protected
anchor=com.apple/github-runner
rules=$r/rules.pf
loaded=$r/loaded
user=_github-runner
label=$label
plist=$r/LaunchDaemons/$label.plist
reload=$r/reload
reload_status=$r/reload.status
EOF
}

# run <command>: run the script with stubs first on PATH; sets out and code.
run() {
  code=0
  out="$(PATH="$stubs:/usr/bin:/bin" STUB_LOG="$r/log" "$BASH" "$script" "$1" "$r/conf" 2>&1)" || code=$?
}

# protect <path>...: stand in for what macOS's containermanagerd protects:
# locked, and the stub chflags refuses to unlock it, so chmod and rm get
# "Operation not permitted" as on the real directories. run_protected runs
# a copy of the script that calls that stub.
protected_script="$tmp/github-runner-protected"
sed "s|/usr/bin/chflags|$stubs/chflags|g" "$script" >"$protected_script"
if ! grep -q "$stubs/chflags" "$protected_script" || grep -q /usr/bin/chflags "$protected_script"; then
  echo "FAIL the protected copy of the script does not call the chflags stub"; exit 1
fi
protect() {
  chflags uchg "$@"
  printf '%s\n' "$@" >>"$r/log/protected"
}
run_protected() { local script="$protected_script"; run "$@"; }

# leave_locked <dir>: what a job can leave in <dir> to outlive the wipe, with
# what the runner user may do to its own files: a locked file, a locked
# directory, an append-only file, a directory under a deny ACL, a directory
# it closed with a locked file inside, locked files named like options, and
# locked links under a deny ACL to the files outside the tree (made by
# outside_target), which must stay as they are.
leave_locked() {
  mkdir -p "$1/locked-dir/sub" "$1/acl-dir/sub" "$1/closed/inner"
  touch "$1/locked-file" "$1/append-only" "$1/locked-dir/sub/f" "$1/acl-dir/sub/f" "$1/closed/inner/f" \
    "$1/-R" "$1/-h"
  chflags uchg "$1/locked-file" "$1/locked-dir/sub/f" "$1/locked-dir/sub" "$1/locked-dir" "$1/closed/inner/f" \
    "$1/-R" "$1/-h"
  chflags uappnd "$1/append-only"
  chmod +a "everyone deny list,search,add_file,add_subdirectory,delete,delete_child" "$1/acl-dir"
  chmod 000 "$1/closed"
  link_out "$1"
}
# link_out <dir>: a locked link under a deny ACL in <dir> to each file
# outside the tree.
link_out() {
  local v
  for v in acl uchg; do lock_link "$tmp/outside/$v" "$1/link-out-$v"; done
}
# lock_link <target> <link>: a link to <target>, locked and under a deny ACL.
lock_link() {
  ln -s "$1" "$2"
  chmod -h +a "everyone deny delete" "$2"
  chflags -h uchg "$2"
}
# outside_target: two files outside the tree, one under a deny ACL and one
# locked. On one file the lock would refuse a chmod -N that followed a link
# to it, so the ACL would stay and the follow would not show.
outside_target() {
  [ ! -e "$tmp/outside" ] || scrub "$tmp/outside"
  mkdir -p "$tmp/outside" && touch "$tmp/outside/acl" "$tmp/outside/uchg"
  chmod +a "everyone deny delete" "$tmp/outside/acl"
  chflags uchg "$tmp/outside/uchg"
}
# outside_intact: the files outside the tree kept their ACL and their flag.
outside_intact() {
  [ -n "$(find "$tmp/outside/acl" -acl)" ] && [ "$(stat -f %Sf "$tmp/outside/uchg")" = uchg ]
}

# seed <dir>: files a job might leave, including dotfiles and a read-only dir.
seed() {
  mkdir -p "$1/.cache/x" "$1/readonly/sub"
  touch "$1/.gitconfig" "$1/file" "$1/readonly/sub/f"
  chmod 500 "$1/readonly/sub" "$1/readonly"
}

empty_dir() { [ -z "$(ls -A "$1")" ]; }
# node_says: what the job's copy of node prints, or nothing if there is none.
node_says() { "$r/work/_tool/node/22.23.2/arm64/bin/node" 2>/dev/null || true; }

# ── check ──────────────────────────────────────────────────────────────────
fresh; run check
want="isolation ok: cannot list $r/protected
isolation ok: cannot enter $r/protected
isolation ok: cannot run sudo
isolation ok: cannot act as a trusted Nix user
isolation ok: cannot connect to listeners of other users on the tailnet: 100.99.1.2:$closed4 [fd7a:115c:a1e0::1]:$closed6
isolation ok: can still reach its own servers on 127.0.0.1 and [::1]"
if [ "$code" = 0 ] && [ "$out" = "$want" ]; then ok "check passes when isolated"
else bad "check passes when isolated" "exit $code" "want:" "$want" "got:" "$out"; fi

fresh; chmod 755 "$r/protected"; run check
if [ "$code" != 0 ] && grep -q "isolation FAILED: the runner user can list $r/protected$" <<<"$out" \
  && grep -q "isolation FAILED: the runner user can enter $r/protected$" <<<"$out" \
  && grep -q "refusing to run jobs" <<<"$out"; then
  ok "check fails when the owner's home is readable"
else bad "check fails when the owner's home is readable" "exit $code" "$out"; fi

# Searchable but not listable, as a 750 home is to a member of its group (the
# test runs as the directory's owner, so the owner bits stand in for those).
fresh; chmod 100 "$r/protected"; run check
if [ "$code" != 0 ] && grep -q "isolation ok: cannot list $r/protected$" <<<"$out" \
  && grep -q "isolation FAILED: the runner user can enter $r/protected$" <<<"$out"; then
  ok "check fails when the owner's home can be entered without being listed"
else bad "check fails when the owner's home can be entered without being listed" "exit $code" "$out"; fi

fresh; STUB_SUDO_OK=1 run check
if [ "$code" != 0 ] && grep -q "can run sudo" <<<"$out"; then ok "check fails when sudo works"
else bad "check fails when sudo works" "exit $code" "$out"; fi

fresh; STUB_NIX_TRUSTED=1 run check
if [ "$code" != 0 ] && grep -q "trusted Nix user" <<<"$out"; then ok "check fails for a trusted Nix user"
else bad "check fails for a trusted Nix user" "exit $code" "$out"; fi

# A wildcard listener is probed on loopback; the real one there answers. pf
# cannot stop that on macOS, so it is a warning. The 100.x addresses just
# outside the tailnet's /10 count as this Mac's own.
fresh; netstat_rows tcp4 "127.0.0.1.$closed4" LISTEN tcp4 "*.$open" LISTEN \
  tcp4 "100.63.255.255.$open" LISTEN tcp4 "100.128.0.1.$open" LISTEN >"$r/log/netstat.txt"
run check
if [ "$code" = 0 ] && grep -q "^isolation ok: no listeners of other users on the tailnet to probe$" <<<"$out" \
  && grep -q "^isolation warning: can connect to 3 listeners of other users on this Mac's own addresses, which pf cannot filter: 127.0.0.1:$open 100.63.255.255:$open 100.128.0.1:$open$" <<<"$out"; then
  ok "check warns, and still passes, when another user's loopback listener answers"
else bad "check warns, and still passes, when another user's loopback listener answers" "exit $code" "$out"; fi

fresh; netstat_rows tcp4 "100.64.0.1.$open" LISTEN tcp4 "100.127.255.255.$open" LISTEN \
  tcp4 "127.0.0.1.$closed4" LISTEN >"$r/log/netstat.txt"
run check
if [ "$code" != 0 ] && grep -q "refusing to run jobs" <<<"$out" \
  && grep -qF "isolation FAILED: the runner user can connect to listeners of other users on the tailnet: 100.64.0.1:$open 100.127.255.255:$open" <<<"$out"; then
  ok "check fails when another user's tailnet listener answers"
else bad "check fails when another user's tailnet listener answers" "exit $code" "$out"; fi

fresh; netstat_rows tcp4 "127.0.0.1.$closed4" LISTEN tcp4 "127.0.0.1.$open" LISTEN tcp4 "100.99.1.2.$open" LISTEN >"$r/log/netstat.txt"
printf 'p4242\nf9\nn127.0.0.1:%s\nf10\nn*:%s\np4343\nf3\nn[::1]:%s\n' "$open" "$closed6" "$closed6" >"$r/log/lsof.txt"
run check
if [ "$code" = 0 ] && ! grep -q "warning" <<<"$out" \
  && grep -q "^isolation ok: no listeners of other users on the tailnet to probe$" <<<"$out"; then
  ok "check leaves the runner's own listeners out of the probe"
else bad "check leaves the runner's own listeners out of the probe" "exit $code" "$out"; fi

fresh; netstat_rows >"$r/log/netstat.txt"; run check
if [ "$code" != 0 ] && grep -q "^isolation FAILED: found no listeners of other users to probe" <<<"$out"; then
  ok "check fails when it finds nothing to probe"
else bad "check fails when it finds nothing to probe" "exit $code" "$out"; fi

fresh; STUB_PYTHON_FAIL=1 run check
if [ "$code" != 0 ] && grep -q "^isolation FAILED: the runner user cannot reach its own servers" <<<"$out"; then
  ok "check fails when the runner cannot reach its own servers"
else bad "check fails when the runner cannot reach its own servers" "exit $code" "$out"; fi

# ── start ──────────────────────────────────────────────────────────────────
fresh; chmod 755 "$r/protected"; run start
if [ "$code" != 0 ] && [ ! -e "$r/log/listener" ] && grep -q "refusing to run jobs" <<<"$out"; then
  ok "start refuses to run jobs when not isolated"
else bad "start refuses to run jobs when not isolated" "exit $code" "$out"; fi

fresh; seed "$r/home"; seed "$r/tmp"; seed "$r/work"; mkdir -p "$r/work/_temp" "$r/work/_actions"
run start
if [ "$code" = 0 ] && [ ! -e "$r/log/listener" ] && grep -q "not registered" <<<"$out" \
  && empty_dir "$r/home" && empty_dir "$r/tmp" && empty_dir "$r/work"; then
  ok "start wipes job state and waits for a token when unregistered"
else bad "start wipes job state and waits for a token when unregistered" "exit $code" "$out" "$(ls -A "$r/home" "$r/tmp" "$r/work")"; fi

fresh; (umask 027; echo "$token" >"$r/inbox/token"); run start
args="$(cat "$r/log/config.args" 2>/dev/null)"
want="--unattended --disableupdate --replace --url https://github.com/owner/repo --name testhost --labels job-tracker --work $r/work"
if [ "$code" = 0 ] && [ "$args" = "$want" ] && [ "$(cat "$r/log/config.token")" = "$token" ] \
  && [ ! -e "$r/inbox/token" ] && [ -f "$r/state/.runner" ] && [ ! -e "$r/state/.previous" ]; then
  ok "start registers with a queued token, passed by env, then deletes it"
else bad "start registers with a queued token, passed by env, then deletes it" "exit $code" "want: $want" "got:  $args" "$out"; fi
listener="$(cat "$r/log/listener" 2>/dev/null)"
if [ "$listener" = "args=run --startuptype service
HOME=$r/home
TMPDIR=$r/tmp
RUNNER_ROOT=$r/state
TOKEN=" ]; then
  ok "start runs the listener with the job home, temp and state, and no token"
else bad "start runs the listener with the job home, temp and state, and no token" "$listener"; fi
if ! grep -q "$token" <<<"$out"; then ok "start never prints the token"
else bad "start never prints the token" "$out"; fi

fresh; echo old >"$r/state/.runner"; echo old >"$r/state/.credentials"
echo expired-token >"$r/inbox/token"; run start
if [ "$code" = 0 ] && [ -e "$r/log/listener" ] && [ "$(cat "$r/state/.runner")" = old ] \
  && [ "$(cat "$r/state/.credentials")" = old ] && [ ! -e "$r/inbox/token" ] \
  && [ ! -e "$r/state/.previous" ] && grep -q "registration failed" <<<"$out"; then
  ok "a rejected token keeps the previous registration"
else bad "a rejected token keeps the previous registration" "exit $code" "$out"; fi

fresh; echo expired-token >"$r/inbox/token"; run start
if [ "$code" = 0 ] && [ ! -e "$r/log/listener" ] && [ ! -e "$r/inbox/token" ] && grep -q "not registered" <<<"$out"; then
  ok "a rejected first token leaves the runner waiting"
else bad "a rejected first token leaves the runner waiting" "exit $code" "$out"; fi

# ── job-started ────────────────────────────────────────────────────────────
fresh; run job-started
if [ "$code" = 0 ] && [ "$(grep -c '^isolation ok' <<<"$out")" = 6 ]; then ok "job-started runs the isolation check"
else bad "job-started runs the isolation check" "exit $code" "$out"; fi

fresh; chmod 100 "$r/protected"; run job-started
if [ "$code" != 0 ] && grep -q "refusing to run jobs" <<<"$out"; then ok "job-started fails the job when not isolated"
else bad "job-started fails the job when not isolated" "exit $code" "$out"; fi

fresh; run job-started
t="$r/work/_tool/node/22.23.2"
if [ "$code" = 0 ] && grep -qx "tool cache: node/22.23.2/arm64 from $r/seed" <<<"$out" \
  && [ -e "$t/arm64.complete" ] && [ "$(node_says)" = v22.23.2 ] \
  && [ "$(readlink "$t/arm64/bin/npm")" = ../lib/npm-cli.js ] \
  && touch "$t/arm64/bin/pnpm" 2>/dev/null \
  && [ ! -w "$r/seed/node/22.23.2/arm64/bin" ] && [ ! -e "$r/seed/node/22.23.2/arm64/bin/pnpm" ]; then
  ok "job-started copies the pinned Node into a tool cache the job can write, leaving the seed read-only"
else bad "job-started copies the pinned Node into a tool cache the job can write, leaving the seed read-only" "exit $code" "$out" "$(find "$r/work" -ls 2>&1 | head -20)"; fi

# A job swaps in its own node and locks it and the marker with the user
# immutable flag, which the runner user may set on its own files. Neither
# the wipe nor the next job's copy may leave it in place.
poison() {
  local t="$r/work/_tool/node/22.23.2"
  mkdir -p "$t/arm64/bin" && printf '#!/bin/sh\necho poisoned\n' >"$t/arm64/bin/node" && chmod +x "$t/arm64/bin/node"
  touch "$t/arm64.complete"
  chflags uchg "$t/arm64/bin/node" "$t/arm64/bin" "$t/arm64.complete"
}
fresh; run job-started; poison; run job-completed; run job-started
if [ "$code" = 0 ] && [ "$(node_says)" = v22.23.2 ]; then
  ok "a job cannot hand the next job its own Node by locking its copy"
else bad "a job cannot hand the next job its own Node by locking its copy" "exit $code" "$out"; fi

# Same lock, but the wipe did not run (the hook crashed, or a reboot came
# first): the next job's copy must still replace it.
fresh; run job-started; poison; run job-started
if [ "$code" = 0 ] && [ "$(node_says)" = v22.23.2 ]; then
  ok "job-started replaces a locked copy an earlier job left"
else bad "job-started replaces a locked copy an earlier job left" "exit $code" "$out"; fi

# The same lock on the version directory and the copy under a deny ACL, as
# a job can leave them: job-started lifts both, with no wipe in between.
fresh; run job-started; poison; t="$r/work/_tool/node/22.23.2"
chmod +a "everyone deny delete,delete_child" "$t/arm64"
chflags uchg "$t"
run job-started
if [ "$code" = 0 ] && [ "$(node_says)" = v22.23.2 ]; then
  ok "job-started replaces a copy an earlier job locked in its version directory or put under a deny ACL"
else bad "job-started replaces a copy an earlier job locked in its version directory or put under a deny ACL" "exit $code" "$out"; fi

# A job replaces the tool cache's node directory with a link out of the tree.
# The copy must go into a real directory in the tree, never through the link.
fresh; mkdir -p "$r/work/_tool" "$tmp/elsewhere-tool"; ln -s "$tmp/elsewhere-tool" "$r/work/_tool/node"
run job-started
if [ "$code" = 0 ] && [ ! -L "$r/work/_tool/node" ] && [ "$(node_says)" = v22.23.2 ] \
  && empty_dir "$tmp/elsewhere-tool"; then
  ok "job-started copies into the tree, never through a link an earlier job planted"
else bad "job-started copies into the tree, never through a link an earlier job planted" "exit $code" "$out" \
  "outside: $(ls -A "$tmp/elsewhere-tool")"; fi
rm -rf "$tmp/elsewhere-tool"

# A job replaces the tool cache itself with a locked link to a file outside
# the tree under a deny ACL or a lock. Unlocking the tool cache unlocks the
# link, never what it points at.
for v in acl uchg; do
  fresh; outside_target; lock_link "$tmp/outside/$v" "$r/work/_tool"; run job-started
  if [ "$code" = 0 ] && outside_intact && [ ! -L "$r/work/_tool" ] && [ "$(node_says)" = v22.23.2 ]; then
    ok "job-started unlocks a tool cache link, never its target outside the tree ($v)"
  else bad "job-started unlocks a tool cache link, never its target outside the tree ($v)" "exit $code" "$out" \
    "outside: $(ls -lOe "$tmp/outside")"; fi
done

# A job closes the work dir to its owner; the next job still gets its copy.
fresh; chmod 000 "$r/work"; run job-started
if [ "$code" = 0 ] && [ "$(node_says)" = v22.23.2 ]; then
  ok "job-started opens a work dir an earlier job closed and copies the pinned Node"
else bad "job-started opens a work dir an earlier job closed and copies the pinned Node" "exit $code" "$out"; fi

# A leftover the runner user cannot delete at all (here: in a version
# directory macOS protects) refuses the job.
fresh; mkdir -p "$r/work/_tool/node/22.23.2"; touch "$r/work/_tool/node/22.23.2/arm64.complete"
protect "$r/work/_tool/node/22.23.2"
run_protected job-started
if [ "$code" != 0 ] && grep -q "isolation FAILED: cannot delete $r/work/_tool/node/22.23.2/arm64, which an earlier job left; refusing to run jobs" <<<"$out"; then
  ok "job-started refuses the job when an earlier job's copy cannot be deleted"
else bad "job-started refuses the job when an earlier job's copy cannot be deleted" "exit $code" "$out"; fi

# A copy that fails (here: a tool cache macOS keeps the runner user from
# writing) must not leave a marker setup-node would trust, and must not fail
# the job: setup-node can still download Node, as it did before the seed.
fresh; mkdir -p "$r/work/_tool"; protect "$r/work/_tool"; run_protected job-started
if [ "$code" = 0 ] && grep -q "warning: could not copy node/22.23.2/arm64 into the tool cache" <<<"$out" \
  && [ ! -e "$r/work/_tool/node/22.23.2/arm64.complete" ]; then
  ok "job-started warns, leaves no marker and runs the job when the copy fails"
else bad "job-started warns, leaves no marker and runs the job when the copy fails" "exit $code" "$out"; fi

fresh; run job-started; mkdir -p "$r/work/_tool/node/24.1.0/arm64"; run job-completed
if [ "$code" = 0 ] && [ "$(grep -c '^::warning::' <<<"$out")" = 1 ] \
  && grep -qx "::warning::setup-node downloaded node 24.1.0; the runner seeds 22.23.2; bump node in nix/github-runner.nix" <<<"$out"; then
  ok "job-completed warns when setup-node downloaded a Node the runner does not seed"
else bad "job-completed warns when setup-node downloaded a Node the runner does not seed" "exit $code" "$out"; fi

fresh; run job-started; chmod -R a-w "$r/work/_tool" 2>/dev/null || true; run job-completed
if [ "$code" = 0 ] && empty_dir "$r/work"; then ok "job-completed wipes the job's tool cache"
else bad "job-completed wipes the job's tool cache" "exit $code" "$out" "$(ls -A "$r/work")"; fi

# ── job-completed ──────────────────────────────────────────────────────────
fresh; seed "$r/home"; seed "$r/tmp"; seed "$r/work"
mkdir -p "$r/work/_temp/x" "$r/work/_PipelineMapping/x" "$r/work/_actions/a" "$r/work/_tool/node" "$r/work/repo/repo"
ln -s "$r/protected" "$r/home/link-out"
mkdir -p "$tmp/elsewhere" && touch "$tmp/elsewhere/keep"
code=0
out="$(HOME="$tmp/elsewhere" TMPDIR="$tmp/elsewhere" PATH="$stubs:/usr/bin:/bin" \
  "$BASH" "$script" job-completed "$r/conf" 2>&1)" || code=$?
if [ "$code" = 0 ] && empty_dir "$r/home" && empty_dir "$r/tmp" \
  && [ "$(find "$r/work" -mindepth 1 -maxdepth 1 -exec basename {} \; | sort | tr '\n' ' ')" = "_PipelineMapping _temp " ] \
  && [ -d "$r/work/_temp/x" ] \
  && [ -e "$tmp/elsewhere/keep" ]; then
  ok "job-completed wipes what the job wrote, keeps runner internals, ignores job env"
else bad "job-completed wipes what the job wrote, keeps runner internals, ignores job env" "exit $code" "$out" "$(ls -A "$r/home" "$r/work")"; fi

# macOS's containermanagerd puts directories in the runner's home that the
# runner user may not change (chmod and rm get "Operation not permitted").
# protect stands in for that protection here. They stay, and everything the
# job wrote around them goes.
fresh; seed "$r/home"
mkdir -p "$r/home/Library/ContainerManager/x" "$r/home/Library/Caches/com.apple.containermanagerd" \
  "$r/home/Library/Caches/ms-playwright/chromium" "$r/home/Library/Preferences"
touch "$r/home/Library/ContainerManager/x/f" "$r/home/Library/Caches/ms-playwright/chromium/bin" \
  "$r/home/Library/Preferences/p.plist"
protect "$r/home/Library/ContainerManager" "$r/home/Library/Caches/com.apple.containermanagerd"
run_protected job-completed
left="$(cd "$r/home" && find . -mindepth 1 | sort | tr '\n' ' ')"
if [ "$code" = 0 ] && [ "$left" = "./Library ./Library/Caches ./Library/Caches/com.apple.containermanagerd ./Library/ContainerManager ./Library/ContainerManager/x " ] \
  && grep -qF "kept what the runner user may not change: $r/home/Library/ContainerManager $r/home/Library/Caches/com.apple.containermanagerd" <<<"$out" \
  && grep -q "^wiped job state" <<<"$out"; then
  ok "job-completed keeps what macOS protects in the home and wipes the rest"
else bad "job-completed keeps what macOS protects in the home and wipes the rest" "exit $code" "$out" "left: $left"; fi

# start wipes the same way, so a protected directory must not stop the runner.
fresh; mkdir -p "$r/home/Library/ContainerManager" "$r/home/Library/Caches/junk"
protect "$r/home/Library/ContainerManager"
run_protected start
if [ "$code" = 0 ] && grep -q "not registered" <<<"$out" && [ ! -e "$r/home/Library/Caches" ] \
  && [ -d "$r/home/Library/ContainerManager" ]; then
  ok "start runs despite a protected directory in the home"
else bad "start runs despite a protected directory in the home" "exit $code" "$out"; fi

# macOS also makes Library/Preferences and Library/Application Support in
# the runner's home, empty, and they outlive the runner user's rm (protect
# stands in for that here). start must not fail on them.
fresh; mkdir -p "$r/home/Library/Preferences" "$r/home/Library/Application Support" \
  "$r/home/Library/ContainerManager" "$r/home/Library/Caches/com.apple.containermanagerd"
protect "$r/home/Library/Preferences" "$r/home/Library/Application Support" \
  "$r/home/Library/ContainerManager" "$r/home/Library/Caches/com.apple.containermanagerd"
run_protected start
if [ "$code" = 0 ] && grep -q "not registered" <<<"$out" && ! grep -q "^could not wipe" <<<"$out" \
  && grep -qxF "kept, emptied, what macOS makes: $r/home/Library/Preferences $r/home/Library/Application Support" <<<"$out" \
  && [ -d "$r/home/Library/Preferences" ] && [ -d "$r/home/Library/Application Support" ]; then
  ok "start runs when macOS's Preferences and Application Support stay in the home"
else bad "start runs when macOS's Preferences and Application Support stay in the home" "exit $code" "$out"; fi

# They stay as directories only: what a job put inside them, and in their
# extended attributes, still goes. Library is locked here so that the two
# outlive rm while what is inside them does not.
fresh; mkdir -p "$r/home/Library/Preferences" "$r/home/Library/Application Support/app"
touch "$r/home/Library/Preferences/p.plist" "$r/home/Library/Application Support/app/f"
xattr -w user.stash job-data "$r/home/Library/Preferences"
protect "$r/home/Library"
run_protected job-completed
left="$(cd "$r/home" && find . -mindepth 1 | sort | tr '\n' ' ')"
if [ "$code" = 0 ] && [ "$left" = "./Library ./Library/Application Support ./Library/Preferences " ] \
  && ! xattr "$r/home/Library/Preferences" | grep -q user.stash && grep -q "^wiped job state" <<<"$out"; then
  ok "job-completed wipes what a job put inside macOS's Preferences and Application Support"
else bad "job-completed wipes what a job put inside macOS's Preferences and Application Support" "exit $code" "$out" "left: $left" \
  "xattrs: $(xattr "$r/home/Library/Preferences" | tr '\n' ' ')"; fi

# The same goes for the extended attributes of the job dirs themselves and
# of the directories on the way to what macOS protects, but not for
# containermanagerd's own. On the live machine those carry no file flags,
# so here only a file inside one is locked, and its xattr must stay.
fresh; mkdir -p "$r/home/Library/ContainerManager" "$r/home/Library/Caches/com.apple.containermanagerd"
touch "$r/home/Library/ContainerManager/boot.txt"
stashed=("$r/home" "$r/tmp" "$r/work" "$r/home/Library" "$r/home/Library/Caches")
for path in "${stashed[@]}"; do xattr -w user.stash job-data "$path"; done
xattr -w user.cm macos "$r/home/Library/ContainerManager"
protect "$r/home/Library/ContainerManager/boot.txt" "$r/home/Library/Caches/com.apple.containermanagerd"
run_protected job-completed
left="$(for path in "${stashed[@]}"; do if xattr "$path" | grep -q user.stash; then echo "$path"; fi; done)"
if [ "$code" = 0 ] && [ -z "$left" ] && [ -d "$r/home/Library/Caches" ] && grep -q "^wiped job state" <<<"$out" \
  && xattr "$r/home/Library/ContainerManager" | grep -q user.cm; then
  ok "job-completed clears what a job put in the xattrs of the directories that may stay"
else bad "job-completed clears what a job put in the xattrs of the directories that may stay" "exit $code" "$out" \
  "still stashed: $left" "ContainerManager: $(xattr "$r/home/Library/ContainerManager" | tr '\n' ' ')"; fi

# It clears them on a wipe that fails too, as the next job still runs.
fresh; mkdir -p "$r/home/Library/ContainerManager" "$r/home/Library/Caches/com.apple.containermanagerd"
for path in "${stashed[@]}"; do xattr -w user.stash job-data "$path"; done
touch "$r/work/locked"
protect "$r/home/Library/ContainerManager" "$r/home/Library/Caches/com.apple.containermanagerd" "$r/work/locked"
run_protected job-completed
left="$(for path in "${stashed[@]}"; do if xattr "$path" | grep -q user.stash; then echo "$path"; fi; done)"
if [ "$code" != 0 ] && [ -z "$left" ] && grep -qx "could not wipe: $r/work/locked" <<<"$out"; then
  ok "job-completed clears the xattrs when the wipe fails"
else bad "job-completed clears the xattrs when the wipe fails" "exit $code" "$out" "still stashed: $left"; fi

# A process the job left running could swap a directory that may stay for a
# FIFO between the check and the clear. The clear must not block on it: a
# copy of the script makes that swap just before the clear.
cat >"$stubs/race" <<'STUB'
#!/bin/sh
[ "$1" = "${STUB_LOG%/log}/home" ] || exit 0
/usr/bin/chflags nouchg "$1/Library" && rmdir "$1/Library/Preferences" && mkfifo "$1/Library/Preferences"
STUB
chmod +x "$stubs/race"
race_script="$tmp/github-runner-race"
if ! awk -v line='  for path in "${stays[@]}"; do' -v hook="  $stubs/race \"\$dir\"" \
  '$0 == line { print hook; n++ } { print } END { exit n != 1 }' "$protected_script" >"$race_script"; then
  echo "FAIL the race copy of the script has no clear to run before"; exit 1
fi
fresh; mkdir -p "$r/home/Library/Preferences"
protect "$r/home/Library"
(PATH="$stubs:/usr/bin:/bin" STUB_LOG="$r/log" "$BASH" "$race_script" job-completed "$r/conf" >"$r/log/race.out" 2>&1
  echo "$?" >"$r/log/race.code") &
racer=$! hung=0
for _ in $(seq 100); do [ ! -s "$r/log/race.code" ] || break; sleep 0.1; done
if [ ! -s "$r/log/race.code" ]; then
  # Hung: open the FIFO, so the blocked open returns and nothing is left.
  hung=1
  for _ in $(seq 50); do [ ! -s "$r/log/race.code" ] || break; [ ! -p "$r/home/Library/Preferences" ] || : <>"$r/home/Library/Preferences"; sleep 0.1; done
  [ -s "$r/log/race.code" ] || kill "$racer" 2>/dev/null || true
fi
wait "$racer" || true
if [ "$hung" = 0 ] && [ -p "$r/home/Library/Preferences" ] && [ "$(cat "$r/log/race.code")" = 0 ] \
  && grep -q "^wiped job state" "$r/log/race.out"; then
  ok "job-completed does not block on a FIFO swapped in for a directory that may stay"
else bad "job-completed does not block on a FIFO swapped in for a directory that may stay" "hung $hung" \
  "exit $(cat "$r/log/race.code" 2>/dev/null)" "$(cat "$r/log/race.out")"; fi

# What stays inside them fails the wipe.
fresh; mkdir -p "$r/home/Library/Preferences"; touch "$r/home/Library/Preferences/p.plist"
protect "$r/home/Library/Preferences/p.plist" "$r/home/Library/Preferences"
run_protected job-completed
if [ "$code" != 0 ] && grep -qx "could not wipe: $r/home/Library/Preferences/p.plist" <<<"$out" \
  && [ "$(grep -c "^could not wipe" <<<"$out")" = 1 ] && ! grep -q "^wiped job state" <<<"$out"; then
  ok "job-completed fails when a file stays inside macOS's Preferences"
else bad "job-completed fails when a file stays inside macOS's Preferences" "exit $code" "$out"; fi

# A link named Preferences is not macOS's directory, and the wipe clears no
# xattrs through it.
fresh; mkdir -p "$r/home/Library" "$tmp/linked-prefs"
xattr -w user.own outside "$tmp/linked-prefs"
ln -s "$tmp/linked-prefs" "$r/home/Library/Preferences"
chflags -h uchg "$r/home/Library/Preferences"; echo "$r/home/Library/Preferences" >>"$r/log/protected"
run_protected job-completed
if [ "$code" != 0 ] && grep -qx "could not wipe: $r/home/Library/Preferences" <<<"$out" \
  && ! grep -q "^kept" <<<"$out" && ! grep -q "^wiped job state" <<<"$out" \
  && xattr "$tmp/linked-prefs" | grep -q user.own; then
  ok "job-completed fails when a link stands where macOS's Preferences would be"
else bad "job-completed fails when a link stands where macOS's Preferences would be" "exit $code" "$out"; fi

# Nor is a file named Preferences.
fresh; mkdir -p "$r/home/Library"; touch "$r/home/Library/Preferences"
protect "$r/home/Library/Preferences"
run_protected job-completed
if [ "$code" != 0 ] && grep -qx "could not wipe: $r/home/Library/Preferences" <<<"$out" \
  && ! grep -q "^kept" <<<"$out" && ! grep -q "^wiped job state" <<<"$out"; then
  ok "job-completed fails when a file stands where macOS's Preferences would be"
else bad "job-completed fails when a file stands where macOS's Preferences would be" "exit $code" "$out"; fi

# A job locks what it leaves, so the wipe cannot delete it: in its home, its
# temp dir, the work dir, a tool in the tool cache, and an action with its
# .completed marker, which the runner would trust for the next job. The wipe
# lifts the locks and deletes all of it, never touching what the links point
# at outside the tree.
leftovers() {
  local d
  outside_target
  for d in "$r/home" "$r/tmp" "$r/work" "$r/work/_tool/node/22.23.2/arm64" "$r/work/_actions/owner/action/v1"; do
    mkdir -p "$d"; leave_locked "$d"
  done
  touch "$r/work/_tool/node/22.23.2/arm64.complete" "$r/work/_actions/owner/action/v1.completed"
  chflags uchg "$r/work/_tool/node/22.23.2/arm64.complete" "$r/work/_actions/owner/action/v1.completed" \
    "$r/work/_actions/owner/action" "$r/work/_tool/node/22.23.2"
}
fresh; leftovers; run job-completed
if [ "$code" = 0 ] && empty_dir "$r/home" && empty_dir "$r/tmp" && empty_dir "$r/work" && outside_intact \
  && grep -q "^wiped job state" <<<"$out"; then
  ok "job-completed wipes what a job locked, made append-only or put under a deny ACL"
else bad "job-completed wipes what a job locked, made append-only or put under a deny ACL" "exit $code" "$out" \
  "left: $(cd "$r" && find home tmp work -mindepth 1 2>&1 | head -20 | tr '\n' ' ')"; fi

fresh; leftovers; run start
if [ "$code" = 0 ] && grep -q "not registered" <<<"$out" && empty_dir "$r/home" && empty_dir "$r/tmp" \
  && empty_dir "$r/work" && outside_intact; then
  ok "start wipes what a job locked, made append-only or put under a deny ACL"
else bad "start wipes what a job locked, made append-only or put under a deny ACL" "exit $code" "$out"; fi

# A job locks the directories it was given, or closes them to their owner.
fresh; seed "$r/home"; seed "$r/tmp"; seed "$r/work"
chmod +a "everyone deny delete_child,add_file" "$r/tmp"
chmod 000 "$r/work"
chflags uchg "$r/home"
run job-completed
if [ "$code" = 0 ] && empty_dir "$r/home" && empty_dir "$r/tmp" && empty_dir "$r/work" \
  && [ "$(stat -f %Sf "$r/home")" = - ] && [ -w "$r/tmp" ] && [ -w "$r/work" ]; then
  ok "job-completed wipes and reopens job dirs a job locked or closed"
else bad "job-completed wipes and reopens job dirs a job locked or closed" "exit $code" "$out"; fi

# A job dir that stays closed cannot be listed, so nothing in it can be
# checked: the wipe fails rather than report it clean.
fresh; seed "$r/work"; chmod 000 "$r/work"; protect "$r/work"; run_protected job-completed
if [ "$code" != 0 ] && grep -qx "could not wipe: $r/work" <<<"$out" && ! grep -q "^wiped job state" <<<"$out"; then
  ok "job-completed fails when a job dir stays closed"
else bad "job-completed fails when a job dir stays closed" "exit $code" "$out"; fi

# Only what macOS protects in the home may stay. The same protection on
# anything else in a job dir fails the wipe, which names it.
fresh; touch "$r/work/x"; protect "$r/work/x"; run_protected job-completed
if [ "$code" != 0 ] && grep -qx "could not wipe: $r/work/x" <<<"$out" && ! grep -q "^wiped job state" <<<"$out" \
  && ! grep -q "^kept" <<<"$out"; then
  ok "job-completed fails when anything but what macOS protects in the home stays"
else bad "job-completed fails when anything but what macOS protects in the home stays" "exit $code" "$out"; fi

# A job names a file it cannot be made to give up with a newline and a line
# that reads like rm refusing a protected path. The wipe reads what stays,
# not rm's errors, and no newline of the job's reaches the log.
fresh; mkdir -p "$r/home/Library/Caches/d" "$r/home/Library/ContainerManager"
fake="x"$'\n'"rm: ContainerManager: Operation not permitted"
touch "$r/home/Library/Caches/d/$fake"
protect "$r/home/Library/Caches/d" "$r/home/Library/ContainerManager"
run_protected job-completed
if [ "$code" != 0 ] && grep -qx "could not wipe: $r/home/Library/Caches/d" <<<"$out" \
  && grep -qxF "could not wipe: $r/home/Library/Caches/d/x?rm: ContainerManager: Operation not permitted" <<<"$out" \
  && ! grep -q "^rm: " <<<"$out" && ! grep -q "^wiped job state" <<<"$out"; then
  ok "job-completed is not fooled by a leftover named like rm's errors"
else bad "job-completed is not fooled by a leftover named like rm's errors" "exit $code" "$out"; fi

# A locked file and locked links nested past PATH_MAX (1024 bytes) still go,
# and what the links point at outside the tree stays as it is.
fresh; outside_target; seg="$(printf 'd%.0s' $(seq 1 200))"
(cd "$r/work" && for _ in 1 2 3 4 5 6; do mkdir "$seg" && cd "$seg"; done && touch f && chflags uchg f && link_out .)
run job-completed
if [ "$code" = 0 ] && empty_dir "$r/work" && outside_intact && grep -q "^wiped job state" <<<"$out"; then
  ok "job-completed wipes what a job locked deeper than PATH_MAX, never what its links point at"
else bad "job-completed wipes what a job locked deeper than PATH_MAX, never what its links point at" \
  "exit $code" "$out" "$(ls -A "$r/work")" "outside: $(ls -lOe "$tmp/outside")"; fi

# The same past PATH_MAX in bytes, under multibyte names and the runner's
# UTF-8 locale (nix/github-runner.nix), where the path is under 1000
# characters: in the work dir and in a home Library/ContainerManager the
# job made itself, which must not pass as what macOS protects.
fresh; seg="$(printf '\xe3\x81\x82%.0s' $(seq 1 100))"
mkdir -p "$r/home/Library/ContainerManager"
for d in "$r/work" "$r/home/Library/ContainerManager"; do
  (cd "$d" && for _ in 1 2 3 4; do mkdir "$seg" && cd "$seg"; done && touch f && chflags uchg f)
done
deep="$(cd "$r/work" && find . -name f)"
LC_ALL=en_US.UTF-8 run job-completed
if [ "$(printf %s "$r/work/$deep" | wc -c)" -gt 1024 ] \
  && [ "$(LC_ALL=en_US.UTF-8 bash -c 'p="$1"; echo "${#p}"' sh "$r/work/$deep")" -lt 1000 ] \
  && [ "$code" = 0 ] && empty_dir "$r/work" && empty_dir "$r/home" && grep -q "^wiped job state" <<<"$out" \
  && ! grep -q "^kept" <<<"$out"; then
  ok "job-completed wipes a locked file past PATH_MAX under multibyte names in a UTF-8 locale"
else bad "job-completed wipes a locked file past PATH_MAX under multibyte names in a UTF-8 locale" "exit $code" "$out"; fi

# A leftover that pins the home does not keep the wipe from the temp dir and
# the work dir, where the runner would trust a planted _actions .completed
# marker in the next job. The hook still fails.
dirty_home() {
  fresh; touch "$r/home/x"; protect "$r/home/x"; seed "$r/tmp"; seed "$r/work"
  mkdir -p "$r/work/_actions/actions/checkout/v4"; touch "$r/work/_actions/actions/checkout/v4.completed"
}
dirty_home; run_protected job-completed
if [ "$code" != 0 ] && grep -qx "could not wipe: $r/home/x" <<<"$out" && empty_dir "$r/tmp" && empty_dir "$r/work" \
  && ! grep -q "^wiped job state" <<<"$out"; then
  ok "job-completed wipes the temp and work dirs when the home stays, then fails"
else bad "job-completed wipes the temp and work dirs when the home stays, then fails" "exit $code" "$out" \
  "left: $(cd "$r" && find tmp work -mindepth 1 | head -5 | tr '\n' ' ')"; fi

dirty_home; run_protected start
if [ "$code" != 0 ] && grep -qx "could not wipe: $r/home/x" <<<"$out" && empty_dir "$r/tmp" && empty_dir "$r/work" \
  && ! grep -q "not registered" <<<"$out" && [ ! -e "$r/log/listener" ]; then
  ok "start wipes the temp and work dirs when the home stays, then fails"
else bad "start wipes the temp and work dirs when the home stays, then fails" "exit $code" "$out"; fi

# A link where macOS's directory would be is not that directory, even
# when it points at one and cannot be deleted.
fresh; mkdir -p "$r/home/Library" "$tmp/linked"
ln -s "$tmp/linked" "$r/home/Library/ContainerManager"
chflags -h uchg "$r/home/Library/ContainerManager"; echo "$r/home/Library/ContainerManager" >>"$r/log/protected"
run_protected job-completed
if [ "$code" != 0 ] && grep -qx "could not wipe: $r/home/Library/ContainerManager" <<<"$out" \
  && ! grep -q "^kept" <<<"$out" && ! grep -q "^wiped job state" <<<"$out"; then
  ok "job-completed fails when a link stands where macOS's directory would be"
else bad "job-completed fails when a link stands where macOS's directory would be" "exit $code" "$out"; fi

# A directory on the way to what macOS protects that stays closed hides
# everything in it: the wipe fails rather than report the home clean.
fresh; mkdir -p "$r/home/Library/ContainerManager"; touch "$r/home/Library/left"
chmod 000 "$r/home/Library"; protect "$r/home/Library"
run_protected job-completed
if [ "$code" != 0 ] && grep -qx "could not wipe: $r/home, which find could not list in full" <<<"$out" \
  && ! grep -q "^wiped job state" <<<"$out"; then
  ok "job-completed fails when it cannot list what is on the way to macOS's directories"
else bad "job-completed fails when it cannot list what is on the way to macOS's directories" "exit $code" "$out"; fi

# A locked read-only directory: its lock has to go before chmod can open
# it, and it has to be open before rm can delete what is inside.
fresh; mkdir "$r/work/d"; touch "$r/work/d/f"; chmod 555 "$r/work/d"; chflags uchg "$r/work/d"
run job-completed
if [ "$code" = 0 ] && empty_dir "$r/work"; then
  ok "job-completed unlocks a locked read-only directory before opening it"
else bad "job-completed unlocks a locked read-only directory before opening it" "exit $code" "$out"; fi

# What macOS protects or makes stays only in the home: the same paths in the
# temp dir or the work dir are a job's, and fail the wipe, even when empty.
fresh; mkdir -p "$r/work/Library/ContainerManager" "$r/tmp/Library/Caches/com.apple.containermanagerd" \
  "$r/work/Library/Preferences"
protect "$r/work/Library/ContainerManager" "$r/tmp/Library/Caches/com.apple.containermanagerd" \
  "$r/work/Library/Preferences"
run_protected job-completed
if [ "$code" != 0 ] && grep -qx "could not wipe: $r/work/Library/ContainerManager" <<<"$out" \
  && grep -qx "could not wipe: $r/tmp/Library/Caches/com.apple.containermanagerd" <<<"$out" \
  && grep -qx "could not wipe: $r/work/Library/Preferences" <<<"$out" \
  && ! grep -q "^kept" <<<"$out"; then
  ok "job-completed keeps macOS's home directories only in the home"
else bad "job-completed keeps macOS's home directories only in the home" "exit $code" "$out"; fi

# One unlock batch holds both what macOS protects and a directory the job
# locked: the job's own lock still goes.
fresh; mkdir -p "$r/home/Library/ContainerManager" "$r/home/Library/Caches/mine"; touch "$r/home/Library/Caches/mine/f"
chflags uchg "$r/home/Library/Caches/mine"; protect "$r/home/Library/ContainerManager"
run_protected job-completed
left="$(cd "$r/home" && find . -mindepth 1 | sort | tr '\n' ' ')"
if [ "$code" = 0 ] && [ "$left" = "./Library ./Library/ContainerManager " ] \
  && grep -qxF "kept what the runner user may not change: $r/home/Library/ContainerManager" <<<"$out"; then
  ok "job-completed unlocks a job's directory batched with one macOS protects"
else bad "job-completed unlocks a job's directory batched with one macOS protects" "exit $code" "$out" "left: $left"; fi

# BSD chflags and chmod read a -- after the flags or mode as a file, and
# chmod -N follows a link. An unlock batch of each kind (locked directories,
# links and files) runs from the hook's working directory, where a link to a
# file under a deny ACL, a locked file or a closed directory named -- must
# stay as it is. Each -- carries its own deny ACL too, and the count covers
# the link's target. find stays on the parents: it cannot read a closed --.
dash_state() { echo "$(stat -f '%Sf %Sp' "$tmp/cwd/--") acl:$(find "$tmp/cwd" "$tmp/dash" -mindepth 1 -maxdepth 1 -acl | wc -l | tr -d ' ')"; }
for kind in link file dir; do
  fresh; leftovers; scrub "$tmp/cwd"; scrub "$tmp/dash"; mkdir -p "$tmp/cwd" "$tmp/dash"
  case "$kind" in
    link) touch "$tmp/dash/victim" && chmod +a "everyone deny delete" "$tmp/dash/victim" \
      && ln -s "$tmp/dash/victim" "$tmp/cwd/--" && chmod -h +a "everyone deny delete" "$tmp/cwd/--" ;;
    file) touch "$tmp/cwd/--" && chmod +a "everyone deny delete" "$tmp/cwd/--" && chflags uchg "$tmp/cwd/--" ;;
    dir) mkdir -m 000 "$tmp/cwd/--" && chmod +a "everyone deny delete" "$tmp/cwd/--" ;;
  esac
  before="$(dash_state)"
  cd "$tmp/cwd"; run job-completed; cd - >/dev/null
  after="$(dash_state)"
  if [ "$code" = 0 ] && empty_dir "$r/work" && [ "$after" = "$before" ]; then
    ok "job-completed leaves a $kind named -- in its working directory as it is"
  else bad "job-completed leaves a $kind named -- in its working directory as it is" "exit $code" "$out" \
    "before: $before" "after: $after"; fi
done

# A job opens its dirs to everyone; the wipe closes them again.
fresh; seed "$r/home"; chmod 0777 "$r/home" "$r/tmp"; chmod 0755 "$r/work"; run job-completed
if [ "$code" = 0 ] && [ "$(stat -f %Lp "$r/home" "$r/tmp" "$r/work" | tr '\n' ' ')" = "700 700 700 " ]; then
  ok "job-completed sets the job dirs back to 0700"
else bad "job-completed sets the job dirs back to 0700" "exit $code" "$out" "$(stat -f '%Lp %N' "$r/home" "$r/tmp" "$r/work")"; fi

# ── firewall ───────────────────────────────────────────────────────────────
fresh; : >"$r/log/pf.main"; run firewall
if [ "$code" != 0 ] && [ ! -e "$r/log/pf.calls" ] && grep -q "no com.apple anchor" <<<"$out"; then
  ok "firewall waits for Apple's main ruleset instead of loading its own"
else bad "firewall waits for Apple's main ruleset instead of loading its own" "exit $code" "$out"; fi

fresh; run firewall
if [ "$code" = 0 ] && [ "$(cat "$r/log/pf.calls")" = "load $r/rules.pf
enable" ] && [ "$(cat "$r/log/pf.anchor")" = "pass all" ] && [ "$(cat "$r/loaded")" = "$r/rules.pf" ]; then
  ok "firewall loads the rules into the anchor and enables pf"
else bad "firewall loads the rules into the anchor and enables pf" "exit $code" "$out" "$(cat "$r/log/pf.calls" 2>/dev/null)"; fi

run firewall
if [ "$code" = 0 ] && [ -z "$out" ] && [ "$(wc -l <"$r/log/pf.calls" | tr -d ' ')" = 2 ]; then
  ok "firewall changes nothing, and says nothing, when all is in place"
else bad "firewall changes nothing, and says nothing, when all is in place" "exit $code" "$out" "$(cat "$r/log/pf.calls")"; fi

rm -f "$r/log/pf.anchor"; run firewall
if [ "$code" = 0 ] && [ "$(tail -1 "$r/log/pf.calls")" = "load $r/rules.pf" ] \
  && [ "$(wc -l <"$r/log/pf.calls" | tr -d ' ')" = 3 ]; then
  ok "firewall reloads a flushed anchor"
else bad "firewall reloads a flushed anchor" "exit $code" "$out" "$(cat "$r/log/pf.calls")"; fi

echo "block all" >"$r/rules2.pf"; sed -i '' "s|^rules=.*|rules=$r/rules2.pf|" "$r/conf"; run firewall
if [ "$code" = 0 ] && [ "$(tail -1 "$r/log/pf.calls")" = "load $r/rules2.pf" ] \
  && [ "$(cat "$r/log/pf.anchor")" = "block all" ]; then
  ok "firewall loads new rules after a rebuild"
else bad "firewall loads new rules after a rebuild" "exit $code" "$out" "$(cat "$r/log/pf.calls")"; fi

rm -f "$r/log/pf.enabled"; run firewall
if [ "$code" = 0 ] && [ "$(tail -1 "$r/log/pf.calls")" = enable ]; then ok "firewall enables pf again if something disabled it"
else bad "firewall enables pf again if something disabled it" "exit $code" "$out" "$(cat "$r/log/pf.calls")"; fi

# ── pf rules ───────────────────────────────────────────────────────────────
# pfctl -n parses without root or /dev/pf; the output is the rules as pf
# stores them, macros and lists expanded.
rules="$(sed 's/@uid@/533/g' "$repo/nix/github-runner.pf" | /sbin/pfctl -nvf - 2>/dev/null | grep -v '^[a-z]* = ' || true)"
want=
v4="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16" v6="fc00::/7 fe80::/10"
for rule in "pass out quick %s proto %s from any to %s port = 53 user = 533 no state" \
  "block return out quick %s proto %s from any to %s user = 533"; do
  for af in inet inet6; do
    nets="$v4"; [ "$af" = inet6 ] && nets="$v6"
    for proto in tcp udp; do
      # shellcheck disable=SC2059 # the rule is the format
      for net in $nets; do want+=$'\n'"$(printf "$rule" "$af" "$proto" "$net")"; done
    done
  done
done
want="${want#$'\n'}"
if [ "$rules" = "$want" ]; then ok "pf rules parse to the expected ruleset"
else bad "pf rules parse to the expected ruleset" "$(diff <(echo "$want") <(echo "$rules"))"; fi

# ── register ───────────────────────────────────────────────────────────────
fresh; run register
mode="$(stat -f %Lp "$r/inbox/token" 2>/dev/null || true)"
if [ "$code" = 0 ] && [ "$(cat "$r/inbox/token")" = "$token" ] && [ "$mode" = 640 ] \
  && [ "$(ls -A "$r/inbox")" = token ] && ! grep -q "$token" <<<"$out"; then
  ok "register queues a group-readable token without printing it"
else bad "register queues a group-readable token without printing it" "exit $code mode $mode" "$out" "$(ls -A "$r/inbox")"; fi

fresh; STUB_GH_FAIL=1 run register
if [ "$code" != 0 ] && empty_dir "$r/inbox" && grep -q "could not mint" <<<"$out"; then
  ok "register leaves nothing behind when gh fails"
else bad "register leaves nothing behind when gh fails" "exit $code" "$out" "$(ls -A "$r/inbox")"; fi

fresh; rmdir "$r/inbox"; run register
if [ "$code" != 0 ] && grep -q "rebuild" <<<"$out"; then ok "register explains a missing inbox"
else bad "register explains a missing inbox" "exit $code" "$out"; fi

# job-tracker's workflow names this path (JOB_TRACKER_EVIDENCE_STORE, its PR
# #88) and fails closed until it exists. The runner must own it to keep and
# prune; the owner reads it through group staff.
activation=$(nix eval --raw "$repo#darwinConfigurations.myhost.config.system.activationScripts.launchd.text")
store=/var/lib/github-runner/evidence
missing=
for line in "mkdir -p $store" "chown _github-runner:staff $store" "chmod 2750 $store"; do
  grep -qxF "$line" <<<"$activation" || missing="$missing [$line]"
done
if [ -z "$missing" ]; then ok "activation creates the evidence store, runner-owned and readable by staff"
else bad "activation creates the evidence store, runner-owned and readable by staff" "missing:$missing"; fi

cache=$(nix eval --raw "$repo#darwinConfigurations.myhost.config.launchd.daemons.github-runner.serviceConfig.EnvironmentVariables.RUNNER_TOOL_CACHE" 2>&1 | tail -n 1 || true)
if [ "$cache" = /var/lib/github-runner/work/_tool ]; then ok "the runner's tool cache is inside its work dir, which every job wipes"
else bad "the runner's tool cache is inside its work dir, which every job wipes" "RUNNER_TOOL_CACHE=$cache"; fi
# A reboot starts the runner from the installed plist, so the deferred
# reload's marker lives where a reboot clears it; its status must outlive one.
# The config is the store file at the end of the firewall daemon's command.
conf=$(nix eval --raw "$repo#darwinConfigurations.myhost.config.launchd.daemons.github-runner-firewall.command" \
  --apply 'c: builtins.readFile (builtins.substring (builtins.stringLength c - 62) 62 c)' 2>&1 || true)
if grep -qx 'reload=/var/run/github-runner-reload' <<<"$conf" && grep -qx 'reload_status=/var/lib/github-runner/reload.status' <<<"$conf"; then
  ok "the pending reload's marker is in /var/run, which a reboot clears, and its status is not"
else bad "the pending reload's marker is in /var/run, which a reboot clears, and its status is not" "$conf"; fi

# ── deferred reload ────────────────────────────────────────────────────────
# A switch that changes the runner's plist used to reload it at once and cut
# off the job it was running. These switches run what the evaluated
# activation runs for the runner: its own step, then nix-darwin's launchd
# step for the runner's plist, with /Library/LaunchDaemons and the new
# system's launchd dir moved under $r. Activation must not wait, lock or touch
# the network: those commands fail and are logged if anything calls them.
runner_part=$(sed -n '/setting up the GitHub Actions runner/,/setting up launchd services/p' <<<"$activation")
darwin_part=$(awk -v t="LaunchDaemons/$label.plist' " \
  'index($0, "if ! diff ") == 1 && index($0, t) { on = 1 } on { print } on && $0 == "fi" { exit }' <<<"$activation")
launchd=$(grep -o "/nix/store/[^/']*-launchd" <<<"$darwin_part" | head -n 1)
# The runner's activate command, with any continuation lines.
activate_line=$(awk '/^[^ ]+ activate / { on = 1 } on { print; if ($0 !~ /\\$/) exit }' <<<"$runner_part")
forbid="$tmp/forbid"
mkdir -p "$forbid"
for c in sleep pgrep curl git gh nc lockf flock timeout; do
  # shellcheck disable=SC2016 # the stub expands $*, not this script
  printf '#!/usr/bin/env bash\necho "%s $*" >>"$STUB_LOG/forbidden.calls"\nexit 1\n' "$c" >"$forbid/$c"
done
chmod +x "$forbid"/*

# plists [loaded]: the installed plist is the old definition and the switch
# brings a new one; with `loaded`, launchd runs the old one.
plists() {
  mkdir -p "$r/LaunchDaemons" "$r/new"
  echo old >"$r/LaunchDaemons/$label.plist"
  echo new >"$r/new/$label.plist"
  rm -f "$r/log/launchctl.calls" "$r/log/launchctl.loaded"
  if [ "${1:-}" = loaded ]; then echo old >"$r/log/launchctl.loaded"; fi
}
# switch [<dir>]: the runner's part of a switch to the system whose launchd
# dir is <dir> (default $r/new); sets out and code. Like store paths, each
# system's plist is a file of its own.
switch() {
  local s='' c='' new="${1:-$r/new}"
  if [ -n "$activate_line" ]; then read -r s _ c _ < <(head -n 1 <<<"$activate_line"); fi
  printf '%s\n%s\n' "$activate_line" "$darwin_part" \
    | sed -e "s|$launchd/Library/LaunchDaemons|$new|g" -e "s|/Library/LaunchDaemons|$r/LaunchDaemons|g" \
      ${s:+-e "s|^$s |\"$BASH\" \"$script\" |" -e "s| $c | $r/conf |"} >"$r/switch.sh"
  code=0
  out="$(PATH="$forbid:$stubs:/usr/bin:/bin" STUB_LOG="$r/log" "$BASH" -e "$r/switch.sh" 2>&1)" || code=$?
}
calls() { cat "$r/log/launchctl.calls" 2>/dev/null || true; }
# now: the test clock, which fresh starts at the real time; tick <seconds>
# moves it on. idle_since <seconds>: the first idle poll was that long ago.
now() { cat "$r/log/now"; }
tick() { echo $(($(now) + $1)) >"$r/log/now"; }
idle_since() { echo $(($(now) - $1)) >"$r/reload.idle"; }
field() { awk -F '\t' -v k="$1" '$1 == k { print $2; exit }' "$r/reload.status" 2>/dev/null; }

if [ -n "$darwin_part" ] && [ -n "$launchd" ]; then ok "the evaluated activation has nix-darwin's step for $label.plist"
else bad "the evaluated activation has nix-darwin's step for $label.plist" "$(head -c 400 <<<"$activation")"; fi
before=$(grep -nF "$(head -n 1 <<<"$activate_line")" <<<"$activation" | head -n 1 | cut -d: -f1)
after=$(grep -nF "$(head -n 1 <<<"$darwin_part")" <<<"$activation" | head -n 1 | cut -d: -f1)
if [ -n "$activate_line" ] && [ -n "$before" ] && [ "$before" -lt "$after" ]; then
  ok "activation installs the runner's plist itself, before nix-darwin compares it"
else bad "activation installs the runner's plist itself, before nix-darwin compares it" "runner part:" "$runner_part"; fi
# dotfiles-autoupdate status reads what the step leaves only on a system
# whose activation has the step; its pattern must match the real activation.
step_pattern=$(sed -n "s/.*grep -q -- '\([^']*\)' \"\$system\/activate\".*/\1/p" "$repo/scripts/dotfiles-autoupdate")
if [ "$(grep -c "" <<<"$step_pattern")" = 1 ] && [ -n "$step_pattern" ] && grep -q -- "$step_pattern" <<<"$activation"; then
  ok "dotfiles-autoupdate's activate-step pattern matches the evaluated activation"
else bad "dotfiles-autoupdate's activate-step pattern matches the evaluated activation" "pattern: [$step_pattern]" "runner part:" "$runner_part"; fi
if ! grep -Eq '(^|[^a-z-])(sleep|wait|wait-idle|lockf|flock|curl|gh|git|nc|pgrep)( |$)' <<<"$runner_part"; then
  ok "the runner's activation step names no wait, lock or network command"
else bad "the runner's activation step names no wait, lock or network command" "$runner_part"; fi

fresh; plists loaded; echo 0 >"$r/log/pgrep.code"; switch
installed="github-runner: installed the runner's new plist; the github-runner-firewall daemon reloads the runner once no job is running"
if [ "$code" = 0 ] && [ "$out" = "$installed" ] && [ "$(calls)" = "print system/$label" ] && [ "$(cat "$r/log/launchctl.loaded")" = old ] \
  && [ "$(cat "$r/LaunchDaemons/$label.plist")" = new ] && [ -s "$r/reload.pending" ] && [ ! -e "$r/log/forbidden.calls" ]; then
  ok "a switch while a job runs installs the new plist and leaves the reload pending"
else bad "a switch while a job runs installs the new plist and leaves the reload pending" "exit $code" "$out" \
  "launchctl: $(calls | tr '\n' ';')" "loaded: $(cat "$r/log/launchctl.loaded" 2>/dev/null)" \
  "forbidden: $(cat "$r/log/forbidden.calls" 2>/dev/null)"; fi
if [ "$(cut -f 1 "$r/reload.status" 2>/dev/null)" = installed ]; then
  ok "activation starts the reload status, so a daemon that never polls goes stale"
else bad "activation starts the reload status, so a daemon that never polls goes stale" "$(cat "$r/reload.status" 2>&1)"; fi

# The firewall daemon reloads only once no job has run for a minute; a job
# starts the minute again.
run firewall
if [ "$(cat "$r/log/launchctl.loaded")" = old ] && [ -e "$r/reload.pending" ] \
  && [ -n "$(field ok)" ] && ! grep -q '^fail' "$r/reload.status"; then
  ok "a poll while a job runs does not reload the runner"
else bad "a poll while a job runs does not reload the runner" "exit $code" "$out" "$(cat "$r/reload.status" 2>/dev/null)"; fi
echo 1 >"$r/log/pgrep.code"; run firewall
first=$(cat "$r/log/launchctl.loaded" 2>/dev/null || true)
idle_since 120; echo 0 >"$r/log/pgrep.code"; run firewall
echo 1 >"$r/log/pgrep.code"; run firewall
second=$(cat "$r/log/launchctl.loaded" 2>/dev/null || true)
if [ "$first" = old ] && [ "$second" = old ] && [ -e "$r/reload.pending" ]; then
  ok "one idle poll, or idle polls with a job between them, do not reload the runner"
else bad "one idle poll, or idle polls with a job between them, do not reload the runner" "after first idle: $first" "after idle, busy, idle: $second"; fi
# A switch that reloads the firewall daemon makes it poll again at once.
run firewall
if [ "$(cat "$r/log/launchctl.loaded")" = old ] && [ -e "$r/reload.pending" ]; then
  ok "two idle polls seconds apart do not reload the runner"
else bad "two idle polls seconds apart do not reload the runner" "$out" "launchctl: $(calls | tr '\n' ';')"; fi
idle_since 59; run firewall
if [ "$(cat "$r/log/launchctl.loaded")" = old ]; then ok "59 seconds idle do not reload the runner"
else bad "59 seconds idle do not reload the runner" "$out" "launchctl: $(calls | tr '\n' ';')"; fi
idle_since 60; run firewall
if [ "$code" = 0 ] && [ "$(cat "$r/log/launchctl.loaded")" = new ] && [ ! -e "$r/reload.pending" ] \
  && [ ! -e "$r/reload.idle" ] && grep -q "reloaded" <<<"$out" \
  && [ "$(calls | grep -v '^print' | tr '\n' ';')" = "unload $r/LaunchDaemons/$label.plist;load $r/LaunchDaemons/$label.plist;" ]; then
  ok "an idle poll a minute after the first reloads the runner and clears the marker"
else bad "an idle poll a minute after the first reloads the runner and clears the marker" "exit $code" "$out" \
  "launchctl: $(calls | tr '\n' ';')" "loaded: $(cat "$r/log/launchctl.loaded" 2>/dev/null)"; fi
grep -E '^(note|fail)' "$r/reload.status" >"$r/status.lines" || true
if [ -n "$(field installed)" ] && [ "$(field ok)" = "$(field ran)" ] && [ ! -s "$r/status.lines" ]; then
  ok "after the reload the status is a good run with nothing pending"
else bad "after the reload the status is a good run with nothing pending" "$(cat "$r/reload.status" 2>/dev/null)"; fi
: >"$r/log/launchctl.calls"; run firewall
if [ "$code" = 0 ] && [ -z "$(calls)" ] && [ -z "$out" ]; then ok "with nothing pending the firewall daemon leaves the runner alone"
else bad "with nothing pending the firewall daemon leaves the runner alone" "exit $code" "$out" "$(calls)"; fi

# The marker is the time of the switch, then the new plist, readable by the
# owner: dotfiles-autoupdate status reads it and alarms after 2 hours.
fresh; plists loaded; echo 0 >"$r/log/pgrep.code"; switch; run firewall
read -r since pending_plist <"$r/reload.pending" || true
if [ "$since" = "$(now)" ] && [ "$pending_plist" = "$r/new/$label.plist" ] \
  && [ "$(stat -f %Lp "$r/reload.pending")" = 644 ] && ! grep -q '^note' "$r/reload.status"; then
  ok "a pending reload is a world-readable marker with the switch time and the new plist"
else bad "a pending reload is a world-readable marker with the switch time and the new plist" \
  "$(ls -l "$r/reload.pending" 2>&1)" "$(cat "$r/reload.pending" 2>/dev/null)" "$(cat "$r/reload.status" 2>/dev/null)"; fi
# A second switch while still pending keeps the first switch's time.
mkdir -p "$r/newer"; echo newer >"$r/newer/$label.plist"; since=$(cut -d ' ' -f 1 "$r/reload.pending" 2>/dev/null || true)
tick 1; switch "$r/newer"
if [ -n "$since" ] && [ "$(cat "$r/reload.pending")" = "$since $r/newer/$label.plist" ] && [ "$(cat "$r/LaunchDaemons/$label.plist")" = newer ] \
  && [ "$(cat "$r/log/launchctl.loaded")" = old ]; then
  ok "a second switch while a reload is pending installs its plist and keeps the pending time"
else bad "a second switch while a reload is pending installs its plist and keeps the pending time" "$(cat "$r/reload.pending" 2>/dev/null)" "$(calls)"; fi

# A marker whose plist is not the installed one was left behind: a system
# without the runner's activate step (a rollback, or a push that reverted it)
# installed and loaded another plist since. The next switch that defers a
# reload starts its time and idle minute afresh.
fresh; plists loaded; echo 0 >"$r/log/pgrep.code"; mkdir -p "$r/before"; echo before >"$r/before/$label.plist"
echo "1 $r/before/$label.plist" >"$r/reload.pending"; echo 1 >"$r/reload.idle"; switch
if [ "$code" = 0 ] && [ "$(cat "$r/reload.pending")" = "$(now) $r/new/$label.plist" ] && [ ! -e "$r/reload.idle" ] \
  && [ "$(cat "$r/LaunchDaemons/$label.plist")" = new ] && [ "$(cat "$r/log/launchctl.loaded")" = old ]; then
  ok "a switch drops a marker that a system without the runner's step left behind"
else bad "a switch drops a marker that a system without the runner's step left behind" "exit $code" "$out" \
  "pending: $(cat "$r/reload.pending" 2>&1)" "idle: $(cat "$r/reload.idle" 2>&1)"; fi

# A reload whose load fails leaves the runner unloaded: it alarms, keeps the
# marker and the last good poll's time, and loads the runner on the next poll.
fresh; plists loaded; echo 0 >"$r/log/pgrep.code"; switch; echo 1 >"$r/log/pgrep.code"
run firewall; good=$(field ok); tick 1; idle_since 60; STUB_LOAD_FAIL=1 run firewall
if [ ! -e "$r/log/launchctl.loaded" ] && [ -e "$r/reload.pending" ] && grep -q '^fail	' "$r/reload.status" \
  && grep -q "not loaded" <<<"$out"; then
  ok "a failed reload is a fail line in the status and in the log"
else bad "a failed reload is a fail line in the status and in the log" "$out" "$(cat "$r/reload.status" 2>/dev/null)"; fi
if [ -n "$good" ] && [ "$(field ok)" = "$good" ] && [ "$(field ran)" != "$good" ]; then
  ok "a failed poll keeps the last good poll's time"
else bad "a failed poll keeps the last good poll's time" "before: ok $good" "$(cat "$r/reload.status" 2>/dev/null)"; fi
echo 0 >"$r/log/pgrep.code"; run firewall
if [ "$(cat "$r/log/launchctl.loaded" 2>/dev/null)" = new ] && [ ! -e "$r/reload.pending" ] && ! grep -q '^fail' "$r/reload.status"; then
  ok "the next poll loads a runner a failed reload left unloaded and clears the alarm"
else bad "the next poll loads a runner a failed reload left unloaded and clears the alarm" "$out" "$(cat "$r/reload.status" 2>/dev/null)"; fi

# An unload that fails leaves the old runner running: an alarm, no load, and
# the next idle poll tries again.
fresh; plists loaded; echo 0 >"$r/log/pgrep.code"; switch; echo 1 >"$r/log/pgrep.code"
run firewall; idle_since 60; : >"$r/log/launchctl.calls"; STUB_UNLOAD_FAIL=1 run firewall
if [ "$(cat "$r/log/launchctl.loaded")" = old ] && grep -q '^fail	.*unload' "$r/reload.status" \
  && grep -q "could not unload" <<<"$out" && ! grep -q '^load' "$r/log/launchctl.calls" && [ -e "$r/reload.pending" ]; then
  ok "a failed unload is a fail line in the status and in the log"
else bad "a failed unload is a fail line in the status and in the log" "$out" "launchctl: $(calls | tr '\n' ';')" "$(cat "$r/reload.status" 2>/dev/null)"; fi
run firewall
if [ "$(cat "$r/log/launchctl.loaded")" = new ] && [ ! -e "$r/reload.pending" ] && ! grep -q '^fail' "$r/reload.status"; then
  ok "the next idle poll after a failed unload reloads the runner and clears the alarm"
else bad "the next idle poll after a failed unload reloads the runner and clears the alarm" "$out" "$(cat "$r/reload.status" 2>/dev/null)"; fi

# A daemon killed in the middle of a reload. Killed before the unload, it
# leaves "unloading" with the old runner still loaded: the next poll starts
# the idle minute again rather than call the old runner reloaded. Killed after
# the unload, it leaves the runner unloaded: the next poll loads it.
fresh; plists loaded; echo 0 >"$r/log/pgrep.code"; switch; echo 1 >"$r/log/pgrep.code"
run firewall; idle_since 60; STUB_UNLOAD_KILL=before run firewall
killed=$code; : >"$r/log/launchctl.calls"; run firewall
if [ "$killed" != 0 ] && [ "$(cat "$r/log/launchctl.loaded")" = old ] && [ -e "$r/reload.pending" ] \
  && [ "$(cat "$r/reload.idle" 2>/dev/null)" = "$(now)" ] && ! calls | grep -qv "^print" && ! grep -q reloaded <<<"$out"; then
  ok "a daemon killed before the unload leaves the reload pending and starts the idle minute again"
else bad "a daemon killed before the unload leaves the reload pending and starts the idle minute again" "killed: exit $killed" "$out" \
  "launchctl: $(calls | tr '\n' ';')" "idle: $(cat "$r/reload.idle" 2>&1)" "pending: $(cat "$r/reload.pending" 2>&1)"; fi
tick 60; run firewall
if [ "$(cat "$r/log/launchctl.loaded")" = new ] && [ ! -e "$r/reload.pending" ] && [ ! -e "$r/reload.idle" ]; then
  ok "a minute later the runner is reloaded"
else bad "a minute later the runner is reloaded" "$out" "launchctl: $(calls | tr '\n' ';')"; fi
fresh; plists loaded; echo 0 >"$r/log/pgrep.code"; switch; echo 1 >"$r/log/pgrep.code"
run firewall; idle_since 60; STUB_UNLOAD_KILL=after run firewall
killed=$code; run firewall
if [ "$killed" != 0 ] && [ "$(cat "$r/log/launchctl.loaded" 2>/dev/null)" = new ] && [ ! -e "$r/reload.pending" ] \
  && [ ! -e "$r/reload.idle" ] && grep -q reloaded <<<"$out"; then
  ok "a daemon killed after the unload has the runner loaded again on the next poll"
else bad "a daemon killed after the unload has the runner loaded again on the next poll" "killed: exit $killed" "$out" \
  "launchctl: $(calls | tr '\n' ';')" "loaded: $(cat "$r/log/launchctl.loaded" 2>&1)"; fi

# A switch that installs a newer plist while the daemon reloads keeps its
# marker, so that plist is reloaded too.
fresh; plists loaded; echo 0 >"$r/log/pgrep.code"; switch; echo 1 >"$r/log/pgrep.code"
run firewall; idle_since 60; STUB_LOAD_PENDING="$r/reload.pending" run firewall
if [ "$(cat "$r/log/launchctl.loaded")" = new ] && [ "$(cat "$r/reload.pending" 2>/dev/null)" = "9 newer" ]; then
  ok "a marker a newer switch wrote during the reload stays"
else bad "a marker a newer switch wrote during the reload stays" "$out" "$(cat "$r/reload.pending" 2>&1)"; fi

# A runner stopped by hand while a reload is pending stays stopped, whether
# or not an idle minute had started.
for started in no yes; do
  fresh; plists loaded; echo 0 >"$r/log/pgrep.code"; switch; echo 1 >"$r/log/pgrep.code"
  [ "$started" = no ] || { run firewall; idle_since 120; }
  rm -f "$r/log/launchctl.loaded"; : >"$r/log/launchctl.calls"; run firewall; said=$out; run firewall
  if [ ! -e "$r/log/launchctl.loaded" ] && ! grep -q '^load' "$r/log/launchctl.calls" && [ ! -e "$r/reload.pending" ] \
    && [ ! -e "$r/reload.idle" ] && ! grep -q '^fail' "$r/reload.status" && grep -q "stopped by hand" <<<"$said"; then
    ok "a runner stopped by hand while a reload is pending stays stopped (idle minute started: $started)"
  else bad "a runner stopped by hand while a reload is pending stays stopped (idle minute started: $started)" "$said" \
    "launchctl: $(calls | tr '\n' ';')" "loaded: $(cat "$r/log/launchctl.loaded" 2>/dev/null)"; fi
done

# An idle time later than now (the clock stepped back) counts as now, so the
# reload waits one minute, not until the clock catches up.
fresh; plists loaded; echo 0 >"$r/log/pgrep.code"; switch; echo 1 >"$r/log/pgrep.code"
idle_since -3600; run firewall; first=$(cat "$r/reload.idle" 2>/dev/null || true)
tick 60; run firewall
if [ "$first" = "$(($(now) - 60))" ] && [ "$(cat "$r/log/launchctl.loaded")" = new ] && [ ! -e "$r/reload.pending" ]; then
  ok "an idle time in the future counts as now, and the runner is reloaded a minute later"
else bad "an idle time in the future counts as now, and the runner is reloaded a minute later" "idle after the first poll: $first, now $(now)" \
  "$out" "loaded: $(cat "$r/log/launchctl.loaded" 2>/dev/null)"; fi

# If pgrep breaks, idle cannot be told from busy: no reload, and an alarm.
fresh; plists loaded; echo 0 >"$r/log/pgrep.code"; switch; echo 3 >"$r/log/pgrep.code"
run firewall; said=$out; idle_since 120; run firewall; run firewall
if [ "$(cat "$r/log/launchctl.loaded")" = old ] && grep -q '^fail	.*pgrep' "$r/reload.status"; then
  ok "a pgrep that fails never counts as idle and alarms"
else bad "a pgrep that fails never counts as idle and alarms" "$out" "$(cat "$r/reload.status" 2>/dev/null)"; fi
if grep -q "cannot tell whether a job is running" <<<"$said" && ! grep -q "cannot tell" <<<"$out"; then
  ok "a failure is logged once, not on every poll that repeats it"
else bad "a failure is logged once, not on every poll that repeats it" "first poll: $said" "third poll: $out"; fi
if grep -q -- "-U _github-runner -f /Runner\[.\]Worker( |\$)" "$r/log/pgrep.calls"; then
  ok "idle means no Runner.Worker process of the runner user"
else bad "idle means no Runner.Worker process of the runner user" "$(sort -u "$r/log/pgrep.calls")"; fi

# With no runner loaded (first switch, or a stopped runner), the switch
# loads the new plist at once, as before, and drops any pending marker.
fresh; plists; echo "1 $r/new/$label.plist" >"$r/reload.pending"; echo 1 >"$r/reload.idle"; switch
if [ "$code" = 0 ] && [ "$(cat "$r/log/launchctl.loaded" 2>/dev/null)" = new ] && [ ! -e "$r/reload.pending" ] \
  && [ ! -e "$r/reload.idle" ] && [ ! -e "$r/log/forbidden.calls" ]; then
  ok "a switch with no runner loaded loads the new plist directly and drops the marker"
else bad "a switch with no runner loaded loads the new plist directly and drops the marker" "exit $code" "$out" "$(calls)"; fi
# If the plist cannot be installed, activate fails and leaves no marker, so
# nix-darwin's step reloads the runner as it always did.
fresh; plists loaded; chmod a-w "$r/LaunchDaemons"; code=0
out="$(PATH="$forbid:$stubs:/usr/bin:/bin" STUB_LOG="$r/log" "$BASH" "$script" activate "$r/conf" "$r/new/$label.plist" 2>&1)" || code=$?
chmod u+w "$r/LaunchDaemons"
if [ "$code" != 0 ] && [ ! -e "$r/reload.pending" ] && [ "$(cat "$r/LaunchDaemons/$label.plist")" = old ]; then
  ok "activate that cannot install the plist fails and leaves no marker"
else bad "activate that cannot install the plist fails and leaves no marker" "exit $code" "$out"; fi
# If the marker cannot be written, activate installs nothing and fails, and
# nix-darwin's step reloads the runner, as the warning says.
fresh; plists loaded; echo 0 >"$r/log/pgrep.code"; mkdir "$r/reload.pending"; switch
if [ "$code" = 0 ] && grep -q "could not defer the runner's reload; nix-darwin reloads it now" <<<"$out" \
  && [ "$(cat "$r/LaunchDaemons/$label.plist")" = new ] && [ "$(cat "$r/log/launchctl.loaded" 2>/dev/null)" = new ]; then
  ok "a switch that cannot write the marker has nix-darwin reload the runner, as its warning says"
else bad "a switch that cannot write the marker has nix-darwin reload the runner, as its warning says" "exit $code" "$out" \
  "launchctl: $(calls | tr '\n' ';')" "loaded: $(cat "$r/log/launchctl.loaded" 2>/dev/null)"; fi
fresh; plists loaded; cp "$r/new/$label.plist" "$r/LaunchDaemons/$label.plist"; echo new >"$r/log/launchctl.loaded"; switch
if [ "$code" = 0 ] && [ "$(calls | grep -cv '^print')" = 0 ] && [ ! -e "$r/reload.pending" ]; then
  ok "a switch that leaves the plist as it is touches nothing"
else bad "a switch that leaves the plist as it is touches nothing" "exit $code" "$out" "$(calls)"; fi

exit "$fail"
