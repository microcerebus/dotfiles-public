#!/usr/bin/env bash
# Tests for scripts/github-runner against stub runner binaries, sudo, nix, gh,
# netstat, lsof and pfctl, and for the runner's pf rules (nix/github-runner.pf).
# The listener probes use the real nc against real sockets on 127.0.0.1 and
# ::1; nothing else touches the network. Writes only to a temp dir.
# Run: bash tests/github_runner_test.sh
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
script="$repo/scripts/github-runner"
tmp="$(mktemp -d)"
server=
trap '[ -z "$server" ] || kill "$server" 2>/dev/null; chmod -R u+rwX "$tmp" 2>/dev/null; rm -rf "$tmp"' EXIT
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
# two listeners of other users with nothing behind them, so every probe is
# refused, as the firewall makes it for the runner. pf runs Apple's stock
# main ruleset.
fresh() {
  [ -d "$tmp/r" ] && chmod -R u+rwX "$tmp/r" && rm -rf "$tmp/r"
  r="$tmp/r"
  mkdir -p "$r"/{state,work,home,tmp,inbox,log} "$r/protected/.t3"
  chmod 755 "$r/protected/.t3"
  chmod 000 "$r/protected"
  netstat_rows tcp4 "127.0.0.1.$closed4" LISTEN tcp6 "*.$closed6" LISTEN \
    tcp4 "127.0.0.1.$open" ESTABLISHED >"$r/log/netstat.txt"
  printf '%s\n' 'scrub-anchor "com.apple/*" all fragment reassemble' 'anchor "com.apple/*" all' >"$r/log/pf.main"
  echo "pass all" >"$r/rules.pf"
  cat >"$r/conf" <<EOF
url=https://github.com/owner/repo
name=testhost
labels=job-tracker
bin=$stubs
state=$r/state
work=$r/work
home=$r/home
tmp=$r/tmp
inbox=$r/inbox
protected=$r/protected
anchor=com.apple/github-runner
rules=$r/rules.pf
loaded=$r/loaded
EOF
}

# run <command>: run the script with stubs first on PATH; sets out and code.
run() {
  code=0
  out="$(PATH="$stubs:/usr/bin:/bin" STUB_LOG="$r/log" "$BASH" "$script" "$1" "$r/conf" 2>&1)" || code=$?
}

# seed <dir>: files a job might leave, including dotfiles and a read-only dir.
seed() {
  mkdir -p "$1/.cache/x" "$1/readonly/sub"
  touch "$1/.gitconfig" "$1/file" "$1/readonly/sub/f"
  chmod 500 "$1/readonly/sub" "$1/readonly"
}

empty_dir() { [ -z "$(ls -A "$1")" ]; }

# ── check ──────────────────────────────────────────────────────────────────
fresh; run check
want="isolation ok: cannot list $r/protected
isolation ok: cannot enter $r/protected
isolation ok: cannot run sudo
isolation ok: cannot act as a trusted Nix user
isolation ok: cannot connect to 2 listeners of other users: 127.0.0.1:$closed4 [::1]:$closed6
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

# A wildcard listener is probed on loopback; the real one there answers.
fresh; netstat_rows tcp4 "127.0.0.1.$closed4" LISTEN tcp4 "*.$open" LISTEN >"$r/log/netstat.txt"
run check
if [ "$code" != 0 ] \
  && grep -q "^isolation FAILED: the runner user can connect to listeners of other users: 127.0.0.1:$open$" <<<"$out"; then
  ok "check fails when another user's listener answers"
else bad "check fails when another user's listener answers" "exit $code" "$out"; fi

fresh; netstat_rows tcp4 "127.0.0.1.$closed4" LISTEN tcp4 "127.0.0.1.$open" LISTEN >"$r/log/netstat.txt"
printf 'p4242\nf9\nn127.0.0.1:%s\nf10\nn*:%s\np4343\nf3\nn[::1]:%s\n' "$open" "$closed6" "$closed6" >"$r/log/lsof.txt"
run check
if [ "$code" = 0 ] && grep -q "^isolation ok: cannot connect to 1 listeners of other users: 127.0.0.1:$closed4$" <<<"$out"; then
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
want="pass out quick on lo0 proto tcp all user = 533 no state tag github-runner
pass out quick on lo0 proto udp all user = 533 no state tag github-runner
block return in quick on lo0 proto tcp all user != 533 tagged github-runner
block return in quick on lo0 proto udp all user != 533 tagged github-runner"
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

exit "$fail"
