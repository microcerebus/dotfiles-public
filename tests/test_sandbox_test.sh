#!/usr/bin/env bash
# Tests for scripts/test-sandbox. A canary dir beside the scratch dir must come
# through every destructive call made through a link unchanged, a refused
# scratch dir must never run the command, and no process may outlive a run.
#
# The one suite that cannot confine itself: macOS does not nest sandboxes.
# So that a mutant of test-sandbox stays harmless too, every link points only
# at the canary, every destructive call goes through such a link, and the
# refusal cases use a HOME and TMPDIR inside this suite's temp dir. A refusal
# a mutant drops therefore lets test-sandbox write only in that temp dir (the
# passwd-home case names the real home, which the /tmp rule refuses too).
# Every victim a kill case aims at is a process this suite started, in a
# group it made.
# Run: bash tests/test_sandbox_test.sh
# shellcheck disable=SC2016 # the single-quoted commands expand in the sandbox
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
ts="$repo/scripts/test-sandbox"
tmp="$(cd "$(mktemp -d)" && pwd -P)"
# A dir of the suite's own in /tmp, for the case that /tmp stays refused.
probe_dir="$(mktemp -d /private/tmp/test-sandbox-probe.XXXXXX)"
# One in the user temp dir, and one in /tmp whose name starts like a bash
# here-document's (sh-thd-<number>) but is not one.
user_tmp_probe="$(mktemp -d "$(getconf DARWIN_USER_TEMP_DIR)test-sandbox-probe.XXXXXX")"
thd_dir="$(mktemp -d "/private/tmp/sh-thd-$$x.XXXXXX")"
# Every process a case starts writes "pid start-time" to a *.pid file (rec
# below), so a case that fails cannot leave one behind: cleanup kills that
# process's whole group, which takes the sentinel and the command with it,
# but only while the pid still has the start time it was recorded with.
# shellcheck disable=SC2016 # expands in the command's shell
rec='rec() { echo "$1 $(/bin/ps -o lstart= -p "$1")" >"$2"; };'
eval "$rec"
# kill_rec <pidfile>: SIGKILL the recorded process and its group, if it is
# still that process.
kill_rec() {
  local pid start now pgid a b
  read -r pid start <"$1" 2>/dev/null || return 0
  now=$(ps -o lstart= -p "$pid" 2>/dev/null) || return 0
  read -r -a a <<<"$now"; read -r -a b <<<"$start"
  [ -n "$start" ] && [ "${a[*]}" = "${b[*]}" ] || return 0
  pgid=$(ps -o pgid= -p "$pid" | tr -d ' ') || true
  if [ -n "$pgid" ] && [ "$pgid" != "$my_pgid" ] && [ "$pgid" -gt 1 ]; then kill -9 -- "-$pgid" 2>/dev/null || true; fi
  kill -9 "$pid" 2>/dev/null || true
}
# shellcheck disable=SC2329 # run by the EXIT trap
cleanup() {
  local f
  for f in "$tmp"/*.pid "$tmp"/c/scratch/*.pid; do
    [ ! -f "$f" ] || kill_rec "$f"
  done
  rm -rf "$probe_dir"
  # Outside $tmp, so no recursive delete: each holds at most one entry.
  rmdir "$user_tmp_probe/.git" "$user_tmp_probe" 2>/dev/null || rmdir "$user_tmp_probe" 2>/dev/null || true
  rm -f "$thd_dir/f"
  rmdir "$thd_dir" 2>/dev/null || true
  chflags -R nouchg "$tmp" 2>/dev/null || true
  rm -rf "$tmp"
}
my_pgid=$(ps -o pgid= -p $$ | tr -d ' ')
trap cleanup EXIT
fail=0

ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; shift; printf '  %s\n' "$@"; fail=1; }
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "want: $3" "got:  $2"; fi; }

# gone <pidfile>: the process it names, which must have started, is dead
# within 2s.
gone() {
  local pid
  read -r pid _ <"$1" 2>/dev/null || { echo "  (no pid file $1: the case never started)"; return 1; }
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || return 0
    [[ "$(ps -o stat= -p "$pid" 2>/dev/null)" != Z* ]] || return 0
    sleep 0.2
  done
  return 1
}

# in_group <seconds> <command...>: run the command as the leader of a new
# process group and SIGKILL that group at the deadline, so a case that
# hangs cannot outlive it. Exits with the command's status, 137 at the
# deadline.
in_group() {
  perl -MPOSIX=:sys_wait_h -e '
    my $t = shift;
    my $pid = fork() // die "fork: $!\n";
    if ($pid == 0) { setpgrp(0, 0) or die "setpgrp: $!\n"; exec { $ARGV[0] } @ARGV or die "exec: $!\n" }
    $pid > 1 or die "bad pid $pid\n";
    POSIX::setpgid($pid, $pid);
    my $end = time + $t;
    while (waitpid($pid, WNOHANG) != $pid) {
      if (time >= $end) { kill "KILL", -$pid; waitpid($pid, 0); exit 137 }
      select(undef, undef, undef, 0.2);
    }
    exit(($? & 127) ? 128 + ($? & 127) : $? >> 8)' "$@"
}

# ── Canary: a scratch dir with a link to a canary dir beside it ──
c="$tmp/c"
canary() {
  if [ -d "$c" ]; then chflags -R nouchg "$c"; rm -rf "$c"; fi
  mkdir -p "$c/canary/sub" "$c/scratch"
  echo alpha >"$c/canary/a.txt"
  echo beta >"$c/canary/sub/b.txt"
  echo locked >"$c/canary/locked.txt"
  echo tagged >"$c/canary/tagged.txt"
  xattr -w com.example.tag keep "$c/canary/tagged.txt"
  chflags uchg "$c/canary/locked.txt"
  ln -s ../canary "$c/scratch/link"
}
# manifest: path, inode, mode, flags, size, mtime, content and xattrs of
# everything in the canary.
manifest() {
  (cd "$c/canary" && find . | LC_ALL=C sort | while IFS= read -r p; do
    stat -f '%N %i %p %f %z %m' "$p"
    [ ! -f "$p" ] || cksum <"$p"
    xattr -lx "$p" 2>/dev/null || true
  done)
}

# refused <name> <command>: run under test-sandbox from $c with the scratch
# dir as its sandbox. It must fail and leave the canary exactly as it was.
refused() {
  local before after code=0
  canary
  before=$(manifest)
  "$ts" --scratch "$c/scratch" --timeout 20 -- /bin/sh -c "cd '$c' && $2" >"$tmp/out" 2>&1 || code=$?
  after=$(manifest)
  if [ "$code" != 0 ] && [ "$before" = "$after" ]; then ok "$1"
  else bad "$1" "exit $code" "canary diff: $(diff <(echo "$before") <(echo "$after") | head -6)" "$(head -3 "$tmp/out")"; fi
}

refused "rm -rf link/ leaves the canary" 'rm -rf scratch/link/'
# BSD find refuses -L with -delete before it touches anything, so the walk
# that follows the link uses rm.
refused "find -L -exec rm through the link leaves the canary" 'find -L scratch -type f -exec rm -f {} +'
refused "chmod -R 777 link/ leaves the canary" 'chmod -R 777 scratch/link/'
refused "chflags -R nouchg link/ leaves the canary" 'chflags -R nouchg scratch/link/'
refused "xattr -c through the link leaves the canary" 'xattr -c scratch/link/tagged.txt'
refused "xattr -w through the link leaves the canary" 'xattr -w com.example.evil 1 scratch/link/a.txt'
refused "mv a canary file out leaves the canary" 'mv scratch/link/a.txt scratch/stolen.txt'
refused "mv within the canary leaves it" 'mv scratch/link/a.txt scratch/link/moved.txt'
refused "ln -sf over a canary file leaves the canary" 'ln -sf /etc/hosts scratch/link/a.txt'
refused "touch into the canary leaves it" 'touch scratch/link/new.txt'
refused "touch -t on a canary file leaves it" 'touch -t 200001010000 scratch/link/a.txt'
refused "cp into the canary leaves it" 'cp /etc/hosts scratch/link/copied.txt'
refused "cp over a canary file leaves it" 'cp /etc/hosts scratch/link/a.txt'
refused ": > a canary file leaves it" ': > scratch/link/a.txt'
refused "mkdir in the canary leaves it" 'mkdir scratch/link/newdir'
refused "a hard link to a canary file is refused" 'ln scratch/link/a.txt scratch/hard'
refused "a direct write beside the scratch dir is refused" 'echo x > canary/a.txt'

canary
before=$(manifest) code=0
"$ts" --scratch "$c/scratch" -- /bin/sh -c "cd '$c' && rm -rf scratch/link && [ ! -e scratch/link ]" >"$tmp/out" 2>&1 || code=$?
expect_eq "rm -rf link (no slash) removes only the link" "$code $(manifest | cmp -s - <(echo "$before") && echo same)" "0 same"

canary
out=$("$ts" --scratch "$c/scratch" -- /bin/sh -c 'cd "$TEST_SANDBOX" && echo hi >f && mkdir d && ln -s f l &&
  chmod 600 f && chflags uchg f && chflags nouchg f && xattr -w a b f && mv f g && rm -rf d g l &&
  : >"$TMPDIR/t" && echo writes-ok' 2>&1) || true
expect_eq "writes inside the scratch dir still work" "$out" writes-ok

out=$("$ts" --scratch "$c/scratch" -- /bin/sh -c 'cd "$TEST_SANDBOX" && echo hi >f && { ln f h 2>/dev/null || echo link-refused; }' 2>&1) || true
expect_eq "no hard link can be made, even inside the scratch dir" "$out $([ -e "$c/scratch/h" ] && echo h-exists)" "link-refused "

out=$("$ts" --scratch "$c/scratch" -- /bin/sh -c 'cat <<EOF
heredoc-ok
EOF
{ : >'"$probe_dir/p"'; } 2>/dev/null || echo tmp-refused' 2>&1) || true
expect_eq "/bin/sh here-documents work; other files in /tmp stay refused" "$out" "heredoc-ok
tmp-refused"

# Only exact here-document names are open, not every path that starts like
# one. The dir is this suite's own, so even a version of test-sandbox that
# let the write through writes nowhere else.
out=$("$ts" --scratch "$c/scratch" -- /bin/sh -c "{ : >'$thd_dir/f'; } 2>/dev/null || echo thd-refused" 2>&1) || true
expect_eq "a /tmp path that only starts like a here-document stays refused" \
  "$out $([ -e "$thd_dir/f" ] && echo written)" "thd-refused "

out=$("$ts" --scratch "$c/scratch" -- /bin/sh -c '/bin/launchctl version >/dev/null 2>&1 || echo launchctl-refused
/usr/bin/osascript -e "return 1" >/dev/null 2>&1 || echo osascript-refused' 2>&1) || true
expect_eq "launchctl and osascript cannot run (they would write outside)" "$out" "launchctl-refused
osascript-refused"

out=$("$ts" --scratch "$c/scratch" -- /bin/sh -c 'for d in "$TMPDIR" "$XDG_CACHE_HOME" "$(mktemp)" "$(mktemp -d)" "$(mktemp -t x)"; do
  case "$d" in "$TEST_SANDBOX"/*) ;; *) echo "outside: $d" ;; esac; done; echo done' 2>&1) || true
expect_eq "TMPDIR, XDG_CACHE_HOME and bare mktemp stay inside the scratch dir" "$out" "done"

# A caller under set -u whose SHELLOPTS is exported (telegram-alert under an
# inherited xtrace) starts the shim with nounset on. In bash 3.2, the shim's
# /bin/bash, "${flags[@]}" of an empty array is then an unbound variable.
# SHELLOPTS is readonly in the shell, so env sets it for the shim alone.
out=$("$ts" --scratch "$c/scratch" -- /bin/sh -c 'd=$(/usr/bin/env SHELLOPTS=nounset mktemp) || { echo "mktemp failed"; exit 0; }
  case "$d" in "$TEST_SANDBOX"/*) echo inside ;; *) echo "outside: $d" ;; esac' 2>&1) || true
expect_eq "bare mktemp stays inside the scratch dir with nounset in an exported SHELLOPTS" "$out" "inside"

# A scratch dir reused after an earlier run may hold links where the shim
# goes. Installing it must not write through them.
# shim_link <name> <link> <target>: plant the link, run, and the canary must
# be unchanged and the command must not have run.
shim_link() {
  local before code=0
  canary
  mkdir -p "$(dirname "$c/scratch/$2")"
  ln -s "$3" "$c/scratch/$2"
  before=$(manifest)
  "$ts" --scratch "$c/scratch" -- echo command-ran >"$tmp/out" 2>&1 || code=$?
  expect_eq "$1" "$code $(manifest | cmp -s - <(echo "$before") && echo same) $(grep -c command-ran "$tmp/out")" "125 same 0"
}
shim_link "a bin link to a dir beside the scratch dir gets no shim" bin ../canary
shim_link "a mktemp link to a canary file is not written through" bin/mktemp ../../canary/a.txt
shim_link "a tmp link to a dir beside the scratch dir is refused" tmp ../canary

# A hard link made outside the sandbox (ln, cp -l, rsync --link-dest) has
# its name inside the scratch dir, so the path-based profile would let a
# write through it. Such a scratch dir is refused before anything runs.
# hard_link <name> <link> <command>: hard-link <link> in the scratch dir to
# a canary file, run <command> from the scratch dir, and the canary must be
# unchanged and the command must not have run.
hard_link() {
  local before code=0
  canary
  mkdir -p "$(dirname "$c/scratch/$2")"
  ln "$c/canary/a.txt" "$c/scratch/$2"
  before=$(manifest)
  "$ts" --scratch "$c/scratch" -- /bin/sh -c "cd '$c/scratch' && $3; echo command-ran" >"$tmp/out" 2>&1 || code=$?
  expect_eq "$1" "$code $(manifest | cmp -s - <(echo "$before") && echo same) $(grep -c command-ran "$tmp/out") $(grep -c 'hard links' "$tmp/out")" \
    "125 same 0 1"
}
hard_link "a hard link at bin/mktemp gets no shim written through it" bin/mktemp ':'
hard_link "a hard-linked file cannot be appended to" hl 'echo evil >>hl'
hard_link "a hard-linked file cannot be chmodded" hl 'chmod 666 hl'

# The victim leads a group this suite made; only the command's own
# processes may be signalled.
canary
perl -e 'setpgrp(0, 0); exec qw(sleep 120)' &
victim=$!
rec "$victim" "$tmp/victim.pid"
out=$(V=$victim "$ts" --scratch "$c/scratch" -- /bin/bash -c 'kill -TERM "$V" 2>/dev/null && echo outside-signalled
  sleep 30 & kill -TERM $!; wait $!; echo "own child: $?"; kill -0 $$ && echo self-ok' 2>/dev/null) || true
sleep 0.3
expect_eq "signals reach the command's own processes, not others" "$out $(kill -0 "$victim" 2>/dev/null && echo victim-alive)" \
  "own child: 143
self-ok victim-alive"
kill_rec "$tmp/victim.pid"
wait "$victim" 2>/dev/null || true

# ── Refused scratch dirs: exit 125, and the command never runs ──
# refuses <name> <scratch> <message part> [VAR=value...]: the variables are
# the environment test-sandbox sees.
refuses() {
  local code=0 out
  out=$(env "${@:4}" "$ts" --scratch "$2" -- echo command-ran 2>&1) || code=$?
  if [ "$code" = 125 ] && [[ "$out" == *"$3"* ]] && [[ "$out" != *command-ran* ]]; then ok "$1"
  else bad "$1" "exit $code" "want a message with: $3" "got: $out"; fi
}
mkdir -p "$tmp/repo/.git" "$tmp/repo/sub" "$tmp/quo\"te" "$tmp/home" "$tmp/up/home" "$tmp/outer/deep/repo/.git"
ln -s repo/sub "$tmp/alias"
passwd_home=$(perl -e 'print +(getpwuid $<)[7]')
refuses "refuses /" / "scratch dir is /"
refuses "refuses \$HOME" "$tmp/home" "scratch dir is \$HOME" HOME="$tmp/home"
refuses "refuses the passwd home whatever HOME says" "$passwd_home" "scratch dir is \$HOME" HOME="$tmp/home"
refuses "refuses an ancestor of \$HOME" "$tmp/up" "an ancestor of \$HOME" HOME="$tmp/up/home"
refuses "refuses a dir outside /tmp and the user temp dir" /usr/share "not inside /tmp or the user temp dir"
refuses "a TMPDIR there does not widen that" /usr/share/man "not inside /tmp or the user temp dir" TMPDIR=/usr/share
# A repo checkout of this suite's own in each makes a version of
# test-sandbox that let these through refuse anyway, before it writes its
# shim into /tmp or the user temp dir.
mkdir "$probe_dir/.git" "$user_tmp_probe/.git"
refuses "refuses /tmp itself" /tmp "not inside /tmp or the user temp dir"
refuses "refuses the user temp dir itself" "$(getconf DARWIN_USER_TEMP_DIR)" "not inside /tmp or the user temp dir"
refuses "refuses TMPDIR=/" "$c/scratch" "TMPDIR is /" TMPDIR=/
refuses "refuses TMPDIR=\$HOME" "$c/scratch" "is \$HOME or an ancestor of it" HOME="$tmp/home" TMPDIR="$tmp/home"
refuses "refuses a TMPDIR above \$HOME" "$c/scratch" "is \$HOME or an ancestor of it" HOME="$tmp/up/home" TMPDIR="$tmp/up"
refuses "refuses a repo checkout" "$tmp/repo/sub" "inside a repo checkout"
refuses "resolves links before checking" "$tmp/alias" "inside a repo checkout ($tmp/repo)"
refuses "refuses a repo checkout below the scratch dir" "$tmp/outer" "holds a repo checkout ($tmp/outer/deep/repo)"
refuses "refuses a missing dir" "$tmp/missing" "does not exist"
refuses "refuses a path SBPL cannot quote" "$tmp/quo\"te" "contains a quote"
refuses "refuses to nest (macOS cannot)" "$c/scratch" "sandboxes do not nest" TEST_SANDBOX="$c/scratch"
code=0
out=$("$ts" --timeout 0 --scratch "$c/scratch" -- echo command-ran 2>&1) || code=$?
expect_eq "refuses a bad timeout" "$code $out" "125 test-sandbox: refused: --timeout must be a positive whole number of seconds"

# ── Processes: nothing outlives the run, nothing else is signalled ──
# Two nets catch leftovers: the process group test-sandbox creates, and a
# scan of the parent chain for children that leave it. A daemon that leaves
# both between two scans is a documented gap, so no case starts one.
canary
code=0
"$ts" --scratch "$c/scratch" -- /bin/bash -c "$rec sleep 600 & rec \$! '$c/scratch/orphan.pid'; disown; exit 7" || code=$?
expect_eq "passes on the command's exit status" "$code" 7
if gone "$c/scratch/orphan.pid"; then ok "kills a disowned grandchild when the command exits"
else bad "kills a disowned grandchild when the command exits" "pid $(cat "$c/scratch/orphan.pid") still alive"; fi

code=0 start=$SECONDS
"$ts" --scratch "$c/scratch" --timeout 1 -- /bin/bash -c "$rec sleep 30 & rec \$! '$c/scratch/timeout.pid'; sleep 30" 2>"$tmp/err" || code=$?
expect_eq "a timeout exits 124 within the grace period" "$code $((SECONDS - start < 10))" "124 1"
if gone "$c/scratch/timeout.pid"; then ok "a timeout kills the whole group"
else bad "a timeout kills the whole group" "pid $(cat "$c/scratch/timeout.pid") still alive"; fi

"$ts" --scratch "$c/scratch" -- /bin/bash -c "$rec perl -e 'setpgrp(0, 0); exec qw(sleep 600)' &
  rec \$! '$c/scratch/setpgid.pid'; sleep 1" 2>"$tmp/err" || true
if gone "$c/scratch/setpgid.pid"; then ok "kills a child that left the group with setpgid"
else bad "kills a child that left the group with setpgid" "pid $(cat "$c/scratch/setpgid.pid") still alive"; fi

"$ts" --scratch "$c/scratch" -- /bin/bash -c "$rec sleep 600 & rec \$! '$c/scratch/killed.pid'; sleep 600" &
wrapper=$!
sleep 1.5
kill -KILL "$wrapper"
wait "$wrapper" 2>/dev/null || true
if gone "$c/scratch/killed.pid"; then ok "SIGKILL to test-sandbox still kills the group"
else bad "SIGKILL to test-sandbox still kills the group" "pid $(cat "$c/scratch/killed.pid") still alive"; fi

# Kill targets come from the group test-sandbox made and the escapees it
# tracked, never from the caller's PATH. A ps stub ahead of /bin names a
# victim, which leads a group this suite made, as a child of the sentinel;
# it would make a kill that trusted PATH aim at the victim. The stub logs
# each call, and test-sandbox must make none.
mkdir -p "$tmp/stubs"
printf '%s\n' '#!/bin/bash' "echo \"\$*\" >>'$tmp/stub.log'" \
  'if [ "$*" = "-ax -o pid=,ppid=,pgid=,stat=" ] && [ "${SBX_VICTIM:-0}" -gt 1 ]; then' \
  '  /bin/ps "$@"' \
  '  leader=$(/bin/ps -ax -o pid=,ppid=,comm= | /usr/bin/awk -v p="$PPID" '"'"'$2 == p && $3 ~ /perl/ { print $1; exit }'"'"')' \
  '  [ -z "$leader" ] || echo "$SBX_VICTIM $leader $SBX_VICTIM S"' \
  '  exit 0' \
  'fi' \
  'exec /bin/ps "$@"' >"$tmp/stubs/ps"
cp "$tmp/stubs/ps" "$tmp/stubs/pgrep"
chmod +x "$tmp/stubs/ps" "$tmp/stubs/pgrep"
canary
perl -e 'setpgrp(0, 0); exec qw(sleep 120)' &
victim=$!
rec "$victim" "$tmp/victim.pid"
sleep 0.3
code=0
SBX_VICTIM=$victim PATH="$tmp/stubs:$PATH" "$ts" --scratch "$c/scratch" -- /bin/sh -c 'sleep 1' 2>"$tmp/err" || code=$?
sleep 0.3
expect_eq "a ps or pgrep ahead of /bin on PATH cannot steer the kill" \
  "$code $([ -e "$tmp/stub.log" ] && echo stub-ran) $(kill -0 "$victim" 2>/dev/null && echo victim-alive)" "0  victim-alive"
kill_rec "$tmp/victim.pid"
wait "$victim" 2>/dev/null || true

# Every signal goes through one guarded call. TEST_SANDBOX_KILL_LOG makes it
# record each target instead of sending it, so this case can see every
# target with nothing signalled at all: the command's own group, and the
# pid of a child that left it. Nothing else may appear, least of all 0, 1,
# -1, the victim or this suite's own group. The child, left alive by the
# record-only kill, fails the run with 123 and is killed by kill_rec.
canary
perl -e 'setpgrp(0, 0); exec qw(sleep 120)' &
victim=$!
rec "$victim" "$tmp/victim.pid"
sleep 0.3
code=0
: >"$tmp/kill.log"
SBX_VICTIM=$victim PATH="$tmp/stubs:$PATH" TEST_SANDBOX_KILL_LOG="$tmp/kill.log" TEST_SANDBOX_GRACE=1 \
  "$ts" --scratch "$c/scratch" -- /bin/bash -c "$rec /bin/ps -o pgid= -p \$\$ | tr -d ' ' >'$c/scratch/own.pgid'
  perl -e 'setpgrp(0, 0); exec qw(sleep 60)' & rec \$! '$c/scratch/left.pid'; sleep 1" 2>"$tmp/err" || code=$?
own=$(cat "$c/scratch/own.pgid" 2>/dev/null || true) left=''
read -r left _ <"$c/scratch/left.pid" || true
kill_rec "$c/scratch/left.pid"
targets=$(awk '{ print $2 }' "$tmp/kill.log" | sort -u | paste -sd' ' -)
want=$(printf '%s\n' "-$own" "$left" | sort -u | paste -sd' ' -)
expect_eq "signals reach only the command's group and the pid that left it" \
  "$code $([ "$own" -gt 1 ] && [ "$left" -gt 1 ] && echo ids-ok) $targets $(kill -0 "$victim" 2>/dev/null && echo victim-alive)" \
  "123 ids-ok $want victim-alive"
bad_targets=$(awk -v me="-$my_pgid" -v v="$victim" -v vg="-$victim" '$2 ~ /^-?[01]$/ || $2 == me || $2 == v || $2 == vg' "$tmp/kill.log")
expect_eq "no recorded target is 0, 1, -1, the victim or a foreign group" "$bad_targets" ""
kill_rec "$tmp/victim.pid"
wait "$victim" 2>/dev/null || true

# An escapee that exits can have its pid reused by an unrelated process,
# whose children must never become targets. A seed plants that state: the
# pid of a stranger (a group this suite made, with one child) under a start
# time no process has. Seeds work only with the kill log on, so nothing is
# signalled. The entry must be dropped, leaving no pid target at all.
perl -e 'setpgrp(0, 0); my $c = fork() // die; if (!$c) { exec qw(sleep 120) } waitpid($c, 0)' &
stranger=$!
rec "$stranger" "$tmp/stranger.pid"
sleep 0.3
stranger_child=$(ps -ax -o pid=,ppid= | awk -v s="$stranger" '$2 == s { print $1; exit }')
code=0
: >"$tmp/seed.log"
TEST_SANDBOX_SEED_ESCAPEE=$stranger TEST_SANDBOX_KILL_LOG="$tmp/seed.log" TEST_SANDBOX_GRACE=1 \
  "$ts" --scratch "$c/scratch" -- /bin/sleep 1 2>"$tmp/err" || code=$?
pid_targets=$(awk '$2 !~ /^-/ { print $2 }' "$tmp/seed.log" | sort -u | paste -sd' ' -)
expect_eq "an escapee whose pid was reused is dropped, not signalled" \
  "$code $([ "${stranger_child:-0}" -gt 1 ] && echo child-ok) pid targets: $pid_targets; $(grep -c 'left process group' "$tmp/err")" \
  "0 child-ok pid targets: ; 0"
kill_rec "$tmp/stranger.pid"
wait "$stranger" 2>/dev/null || true

# The Chrome ports (9333, 9222, 9334) are denied by one rule shape. This
# suite never connects to them; it adds a port of its own listener to the
# same rule and checks a connection fails, after one without it succeeds.
perl -MIO::Socket::INET -e 'setpgrp(0, 0); my $s = IO::Socket::INET->new(LocalAddr => "127.0.0.1", LocalPort => 0, Listen => 8) or die;
  open my $f, ">", $ARGV[0]; print $f $s->sockport; close $f; alarm 60; while (my $c = $s->accept) { close $c }' "$tmp/port" &
listener=$!
rec "$listener" "$tmp/listener.pid"
for _ in 1 2 3 4 5 6 7 8 9 10; do [ ! -s "$tmp/port" ] || break; sleep 0.2; done
port=$(cat "$tmp/port" 2>/dev/null || true)
dial='perl -MIO::Socket::INET -e "print IO::Socket::INET->new(PeerAddr => q{127.0.0.1:$P}, Timeout => 3) ? q{connected} : q{refused}"'
expect_eq "a connection to a denied port is refused (rule checked on our own listener)" \
  "$(P=$port "$ts" --scratch "$c/scratch" -- /bin/sh -c "$dial") $(P=$port TEST_SANDBOX_EXTRA_DENY_PORT=$port "$ts" --scratch "$c/scratch" -- /bin/sh -c "$dial")" \
  "connected refused"
kill_rec "$tmp/listener.pid"
wait "$listener" 2>/dev/null || true

code=0
"$ts" --scratch "$c/scratch" -- /bin/bash -c "$rec sleep 600 & rec \$! '$c/scratch/term.pid'; sleep 600" &
wrapper=$!
sleep 1.5
kill -TERM "$wrapper"
wait "$wrapper" || code=$?
expect_eq "TERM to test-sandbox exits 143" "$code" 143
if gone "$c/scratch/term.pid"; then ok "TERM to test-sandbox kills the group"
else bad "TERM to test-sandbox kills the group" "pid $(cat "$c/scratch/term.pid") still alive"; fi

# A TERM the caller ignores stays ignored through exec, so the command
# ignores the timeout's TERM too. The final signal must follow within the
# grace period, not wait for the command to end. in_group bounds the case
# in case test-sandbox hangs.
code=0 start=$SECONDS
in_group 25 /bin/bash -c 'trap "" TERM; exec "$@"' _ "$ts" --scratch "$c/scratch" --timeout 2 -- \
  /bin/bash -c "$rec sleep 60 & rec \$! '$c/scratch/termign.pid'; sleep 60" 2>"$tmp/err" || code=$?
expect_eq "with TERM ignored, a timeout still exits 124 within the grace period" "$code $((SECONDS - start < 12))" "124 1"
if gone "$c/scratch/termign.pid"; then ok "with TERM ignored, a timeout still kills the group"
else bad "with TERM ignored, a timeout still kills the group" "pid $(cat "$c/scratch/termign.pid") still alive"; fi

code=0
TEST_SANDBOX_KILL_SIGNAL=USR1 TEST_SANDBOX_GRACE=1 "$ts" --scratch "$c/scratch" -- /bin/bash -c \
  "$rec perl -e '\$SIG{TERM} = \$SIG{USR1} = q{IGNORE}; exec qw(sleep 30)' & rec \$! '$c/scratch/survivor.pid'; sleep 0.5" \
  2>"$tmp/err" || code=$?
expect_eq "a process that outlives the final signal fails the run with 123" \
  "$code $(grep -c 'survived SIGUSR1' "$tmp/err")" "123 1"
kill_rec "$c/scratch/survivor.pid"

# Each case sets the caller's disposition itself: a harness that starts this
# suite in the background hands it INT already ignored.
int='perl -e "print \$SIG{INT} // q{default}"'
expect_eq "a foreground caller's SIGINT reaches the command" \
  "$(perl -e '$SIG{INT} = q{DEFAULT}; exec @ARGV' "$ts" --scratch "$c/scratch" -- /bin/sh -c "$int")" default
expect_eq "a SIGINT the caller ignores stays ignored" \
  "$(trap '' INT; "$ts" --scratch "$c/scratch" -- /bin/sh -c "$int")" IGNORE

# ── Every other shell suite confines itself ──
# tests/lib/confine.sh re-execs a suite under test-sandbox and, inside it,
# refuses unless a sandbox is really on.
printf '#!/bin/bash\nset -eu\n. "%s/tests/lib/confine.sh"\necho suite-ran${TEST_SANDBOX:+ confined}\n' "$repo" >"$tmp/fake_test.sh"
code=0
out=$(TEST_SANDBOX="$c/scratch" "$BASH" "$tmp/fake_test.sh" 2>&1) || code=$?
expect_eq "a suite with TEST_SANDBOX set by hand refuses to run" "$code $out" \
  "125 fake_test.sh: refused: TEST_SANDBOX is set but no sandbox is on; unset it to run confined"
expect_eq "a suite run plainly re-execs itself confined" "$("$BASH" "$tmp/fake_test.sh" 2>&1)" "suite-ran confined"
# Each suite runs confined anyway, so one that never sources the helper
# runs its tests inside a sandbox until the timeout, never outside one.
for suite in "$repo"/tests/*.sh; do
  [ "$suite" != "$repo/tests/test_sandbox_test.sh" ] || continue
  code=0
  out=$(TEST_SANDBOX_CONFINE_CHECK=1 "$ts" --rm-scratch --timeout 30 --scratch "$(mktemp -d "$tmp/confine.XXXXXX")" \
    -- "$BASH" "$suite" 2>&1) || code=$?
  if [ "$code" = 3 ] && [ "$out" = "confined: ${suite##*/}" ]; then
    ok "${suite##*/} sources tests/lib/confine.sh"
  else
    bad "${suite##*/} sources tests/lib/confine.sh" "source it right after the set line" "exit $code: $(echo "$out" | head -2)"
  fi
done

exit "$fail"
