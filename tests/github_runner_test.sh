#!/usr/bin/env bash
# Tests for scripts/github-runner against stub runner binaries, sudo, nix and gh.
# Pure: no network, writes only to a temp dir.
# Run: bash tests/github_runner_test.sh
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
script="$repo/scripts/github-runner"
tmp="$(mktemp -d)"
trap 'chmod -R u+rwX "$tmp" 2>/dev/null; rm -rf "$tmp"' EXIT
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
chmod +x "$stubs"/*

# fresh: a new runner layout under $tmp/r with a config file pointing at it.
# The protected home is unreadable, as the owner's home is to the runner user.
fresh() {
  [ -d "$tmp/r" ] && chmod -R u+rwX "$tmp/r" && rm -rf "$tmp/r"
  r="$tmp/r"
  mkdir -p "$r"/{state,work,home,tmp,inbox,log} "$r/protected/.ssh" "$r/protected/Library/Keychains"
  chmod 000 "$r/protected"
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
if [ "$code" = 0 ] && [ "$(grep -c '^isolation ok' <<<"$out")" = 5 ]; then
  ok "check passes when isolated"
else bad "check passes when isolated" "exit $code" "$out"; fi

fresh; chmod 755 "$r/protected"; run check
if [ "$code" != 0 ] && grep -q "isolation FAILED: the runner user can list $r/protected$" <<<"$out" \
  && grep -q "can read $r/protected/.ssh" <<<"$out"; then
  ok "check fails when the owner's home is readable"
else bad "check fails when the owner's home is readable" "exit $code" "$out"; fi

fresh; STUB_SUDO_OK=1 run check
if [ "$code" != 0 ] && grep -q "can run sudo" <<<"$out"; then ok "check fails when sudo works"
else bad "check fails when sudo works" "exit $code" "$out"; fi

fresh; STUB_NIX_TRUSTED=1 run check
if [ "$code" != 0 ] && grep -q "trusted Nix user" <<<"$out"; then ok "check fails for a trusted Nix user"
else bad "check fails for a trusted Nix user" "exit $code" "$out"; fi

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

# ── job-completed ──────────────────────────────────────────────────────────
fresh; seed "$r/home"; seed "$r/tmp"; seed "$r/work"
mkdir -p "$r/work/_temp/x" "$r/work/_PipelineMapping/x" "$r/work/_actions/a" "$r/work/_tool/node" "$r/work/repo/repo"
ln -s "$r/protected" "$r/home/link-out"
mkdir -p "$tmp/elsewhere" && touch "$tmp/elsewhere/keep"
code=0
out="$(HOME="$tmp/elsewhere" TMPDIR="$tmp/elsewhere" PATH="$stubs:/usr/bin:/bin" \
  "$BASH" "$script" job-completed "$r/conf" 2>&1)" || code=$?
if [ "$code" = 0 ] && empty_dir "$r/home" && empty_dir "$r/tmp" \
  && [ "$(ls -A "$r/work" | tr '\n' ' ')" = "_PipelineMapping _temp " ] && [ -d "$r/work/_temp/x" ] \
  && [ -e "$tmp/elsewhere/keep" ]; then
  ok "job-completed wipes what the job wrote, keeps runner internals, ignores job env"
else bad "job-completed wipes what the job wrote, keeps runner internals, ignores job env" "exit $code" "$out" "$(ls -A "$r/home" "$r/work")"; fi

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
