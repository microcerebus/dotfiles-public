#!/usr/bin/env bash
# Tests for scripts/check-flake-pr against flake.lock pairs, a throwaway git
# repo and a stub gh. The fixture nodes are real shapes from this repo's
# flake.lock history (5308a4f -> d2f2197), plus one git-type input for revCount.
# Pure: no network, writes only to a temp dir.
# Run: bash tests/check_flake_pr_test.sh
# CHECK_FLAKE_PR=<path> runs the same cases against another copy of the checker.
set -euo pipefail
# Confine the suite under scripts/test-sandbox (see tests/lib/confine.sh).
# shellcheck source=tests/lib/confine.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/confine.sh"
repo="$(cd "$(dirname "$0")/.." && pwd)"
checker="${CHECK_FLAKE_PR:-$repo/scripts/check-flake-pr}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail=0

cat >"$tmp/old.lock" <<'EOF'
{
  "nodes": {
    "home-manager": {
      "inputs": {
        "nixpkgs": [
          "nixpkgs"
        ]
      },
      "locked": {
        "lastModified": 1792085665,
        "narHash": "sha256-X9iN67cdW9KqLuvbyyr9rdF4Zssk1uFHh1UC/GZH08s=",
        "owner": "nix-community",
        "repo": "home-manager",
        "rev": "54ad640b81c5e9a32db1a29e7561fda628601117",
        "type": "github"
      },
      "original": {
        "owner": "nix-community",
        "repo": "home-manager",
        "type": "github"
      }
    },
    "nixpkgs": {
      "locked": {
        "lastModified": 1791966044,
        "narHash": "sha256-t1hT8UW97rFCWCJO7/pClvu0AhLN5V3uir2M0ic4w/Q=",
        "owner": "NixOS",
        "repo": "nixpkgs",
        "rev": "319e4cebef10cbb636c6ea392137b52ad105336a",
        "type": "github"
      },
      "original": {
        "owner": "NixOS",
        "ref": "nixpkgs-unstable",
        "repo": "nixpkgs",
        "type": "github"
      }
    },
    "no-mistakes-src": {
      "flake": false,
      "locked": {
        "lastModified": 1790411406,
        "narHash": "sha256-ne+JfVfV0jjMldqyv25KTwrdexFs5ynFAGWgILiGPAk=",
        "owner": "kunchenguid",
        "repo": "no-mistakes",
        "rev": "4822244e763fd4c3d7f48be6433f92df10bb5b33",
        "type": "github"
      },
      "original": {
        "owner": "kunchenguid",
        "ref": "v1.84.0",
        "repo": "no-mistakes",
        "type": "github"
      }
    },
    "pinned-git": {
      "flake": false,
      "locked": {
        "lastModified": 1790000000,
        "narHash": "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        "ref": "refs/heads/main",
        "rev": "1111111111111111111111111111111111111111",
        "revCount": 100,
        "type": "git",
        "url": "https://example.com/pinned.git"
      },
      "original": {
        "type": "git",
        "url": "https://example.com/pinned.git"
      }
    },
    "root": {
      "inputs": {
        "home-manager": "home-manager",
        "nixpkgs": "nixpkgs",
        "no-mistakes-src": "no-mistakes-src",
        "pinned-git": "pinned-git"
      }
    }
  },
  "root": "root",
  "version": 7
}
EOF

# The routine's real update: nixpkgs and home-manager move forward.
bump='
  .nodes.nixpkgs.locked += {lastModified: 1792812153,
    narHash: "sha256-T2+XBfNbf9pecLUWS4+RtuVNZ3W8K5taG5QdV71mWlk=",
    rev: "674a2028661e550a97400c1cc992b9cca9a668a1"}
  | .nodes."home-manager".locked += {lastModified: 1792896866,
    narHash: "sha256-/0tELNnhdSnP+bHSdWiEe6KpfSwi6WrTnT9cm/jNkjA=",
    rev: "c216bf5a1f173b0481bd5c8c489ebe5595ecc68c"}'
jq "$bump" "$tmp/old.lock" >"$tmp/good.lock"

# expect <name> <code> <stdout> <cmd...>: run cmd, compare exit code and stdout.
expect() {
  local name="$1" want_code="$2" want="$3" got code=0
  shift 3
  got="$("$@" 2>"$tmp/stderr")" || code=$?
  if [ "$code" = "$want_code" ] && [ "$got" = "$want" ]; then
    echo "ok   $name"
  else
    echo "FAIL $name (exit $code, want $want_code)"
    printf '  want: %s\n  got:  %s\n  stderr: %s\n' "$want" "$got" "$(cat "$tmp/stderr")"
    fail=1
  fi
}

# error <name> <cmd...>: cmd must exit 2 with a check-flake-pr message on stderr.
error() {
  local name="$1" code=0
  shift
  "$@" >"$tmp/stdout" 2>"$tmp/stderr" || code=$?
  if [ "$code" = 2 ] && grep -q '^check-flake-pr: ' "$tmp/stderr" && [ ! -s "$tmp/stdout" ]; then
    echo "ok   $name"
  else
    echo "FAIL $name (exit $code, want 2)"
    printf '  stdout: %s\n  stderr: %s\n' "$(cat "$tmp/stdout")" "$(cat "$tmp/stderr")"
    fail=1
  fi
}

# lock <jq filter>: write old.lock run through the filter, print its path.
lock() {
  local f
  f="$(mktemp "$tmp/case.XXXXXX")"
  jq "$1" "$tmp/old.lock" >"$f"
  echo "$f"
}

files() { python3 -I "$checker" --files "$tmp/old.lock" "$1"; }

echo "--- lock rules (--files)"
expect "a real update passes" 0 \
  "lock rules ok for home-manager, nixpkgs (offline: nothing checked upstream, not a merge decision)" files "$tmp/good.lock"
expect "a git input may move rev, narHash, lastModified and revCount" 0 \
  "lock rules ok for pinned-git (offline: nothing checked upstream, not a merge decision)" files "$(lock '.nodes."pinned-git".locked += {revCount: 105, lastModified: 1790000500,
    rev: "2222222222222222222222222222222222222222", narHash: "sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB="}')"
expect "an equal lastModified passes" 0 \
  "lock rules ok for nixpkgs (offline: nothing checked upstream, not a merge decision)" files "$(lock '.nodes.nixpkgs.locked.rev = "674a2028661e550a97400c1cc992b9cca9a668a1"')"
expect "the same lock fails" 1 \
  "flake.lock: no input changed" files "$tmp/old.lock"
expect "reformatting alone fails" 1 \
  "flake.lock: no input changed" files "$(jq -c . "$tmp/old.lock" >"$tmp/compact.lock" && echo "$tmp/compact.lock")"
expect "an added node fails" 1 \
  "node evil: added" files "$(lock '.nodes.evil = .nodes.nixpkgs')"
expect "a removed node fails" 1 \
  "node pinned-git: removed
node root: inputs changed" files "$(lock 'del(.nodes."pinned-git") | del(.nodes.root.inputs."pinned-git")')"
expect "rewiring a root input fails" 1 \
  "node root: inputs changed" files "$(lock '.nodes.root.inputs.nixpkgs = "home-manager"')"
expect "rewiring a follows fails" 1 \
  "node home-manager: inputs changed" files "$(lock '.nodes."home-manager".inputs.nixpkgs = ["no-mistakes-src"]')"
expect "an added inputs map fails" 1 \
  "node nixpkgs: inputs added" files "$(lock '.nodes.nixpkgs.inputs = {}')"
expect "a changed owner fails" 1 \
  "node nixpkgs: locked.owner changed" files "$(lock '.nodes.nixpkgs.locked.owner = "N1xOS"')"
expect "a changed repo fails" 1 \
  "node home-manager: locked.repo changed" files "$(lock '.nodes."home-manager".locked.repo = "home-manager-fork"')"
expect "a changed type fails" 1 \
  "node nixpkgs: locked.type changed" files "$(lock '.nodes.nixpkgs.locked.type = "gitlab"')"
expect "a changed url fails" 1 \
  "node pinned-git: locked.url changed" files "$(lock '.nodes."pinned-git".locked.url = "https://example.org/pinned.git"')"
expect "a changed locked ref fails" 1 \
  "node pinned-git: locked.ref changed" files "$(lock '.nodes."pinned-git".locked.ref = "refs/heads/dev"')"
expect "an added host fails" 1 \
  "node nixpkgs: locked.host added" files "$(lock '.nodes.nixpkgs.locked.host = "git.example.com"')"
expect "an added dir fails" 1 \
  "node nixpkgs: locked.dir added" files "$(lock '.nodes.nixpkgs.locked.dir = "sub"')"
expect "a removed narHash fails" 1 \
  "node nixpkgs: locked.narHash removed" files "$(lock 'del(.nodes.nixpkgs.locked.narHash)')"
expect "an added revCount fails" 1 \
  "node nixpkgs: locked.revCount added" files "$(lock '.nodes.nixpkgs.locked.revCount = 1')"
expect "a removed locked fails" 1 \
  "node nixpkgs: locked removed" files "$(lock 'del(.nodes.nixpkgs.locked)')"
expect "a changed original ref fails" 1 \
  "node no-mistakes-src: original.ref changed" files "$(lock '.nodes."no-mistakes-src".original.ref = "v1.85.0"')"
expect "an added original rev fails" 1 \
  "node nixpkgs: original.rev added" files "$(lock '.nodes.nixpkgs.original.rev = "674a2028661e550a97400c1cc992b9cca9a668a1"')"
expect "a dropped flake = false fails" 1 \
  "node no-mistakes-src: flake removed" files "$(lock 'del(.nodes."no-mistakes-src".flake)')"
expect "an added node key fails" 1 \
  "node nixpkgs: parent added" files "$(lock '.nodes.nixpkgs.parent = []')"
expect "an older lastModified fails" 1 \
  "node nixpkgs: locked.lastModified went back (1791966044 -> 1791966043)" \
  files "$(lock '.nodes.nixpkgs.locked.lastModified = 1791966043')"
expect "a lastModified that is not a number fails" 1 \
  "node nixpkgs: locked.lastModified is not well formed" \
  files "$(lock '.nodes.nixpkgs.locked.lastModified = "1792812153"')"
expect "a changed root fails" 1 \
  "flake.lock: root changed" files "$(lock '.root = "nixpkgs"')"
expect "a changed version fails" 1 \
  "flake.lock: version changed" files "$(lock '.version = 8')"
expect "every problem gets its own line" 1 \
  "node home-manager: locked.owner changed
node nixpkgs: locked.lastModified went back (1791966044 -> 1)
node nixpkgs: original.ref changed" \
  files "$(lock "$bump"' | .nodes."home-manager".locked.owner = "x" | .nodes.nixpkgs.locked.lastModified = 1
    | .nodes.nixpkgs.original.ref = "nixos-unstable"')"
printf '{"nodes": {}, "nodes": {}, "root": "root", "version": 7}\n' >"$tmp/dup.lock"
expect "a duplicate key fails" 1 \
  "new flake.lock: not valid JSON (duplicate key nodes)" files "$tmp/dup.lock"
printf 'not json\n' >"$tmp/bad.lock"
expect "a lock that is not JSON fails" 1 \
  "new flake.lock: not valid JSON (Expecting value: line 1 column 1 (char 0))" files "$tmp/bad.lock"
expect "nodes that are not an object fail" 1 \
  "new flake.lock: nodes is not an object" files "$(lock '.nodes = []')"
expect "a lock that is not an object fails" 1 \
  "new flake.lock: not an object" files "$(lock '[.]')"
printf '{"nodes": {"a": {"x": 1, "x": 2}}, "root": "root", "version": 7}\n' >"$tmp/dup2.lock"
expect "a nested duplicate key fails" 1 \
  "new flake.lock: not valid JSON (duplicate key x)" files "$tmp/dup2.lock"
printf '{"nodes": {}, "root": "root", "version": NaN}\n' >"$tmp/nan.lock"
expect "NaN fails" 1 "new flake.lock: not valid JSON (NaN is not JSON)" files "$tmp/nan.lock"
expect "flake = false turned 0 fails" 1 \
  "node no-mistakes-src: flake changed" files "$(lock '.nodes."no-mistakes-src".flake = 0')"
expect "a rev that is not a sha fails" 1 \
  "node nixpkgs: locked.rev is not well formed" files "$(lock '.nodes.nixpkgs.locked.rev = {"x": 1}')"
expect "a narHash that is not sha256 fails" 1 \
  "node nixpkgs: locked.narHash is not well formed" files "$(lock '.nodes.nixpkgs.locked.narHash = "md5-x"')"
expect "an older revCount fails" 1 \
  "node pinned-git: locked.revCount went back (100 -> 99)" files "$(lock '.nodes."pinned-git".locked.revCount = 99')"
for enc in UTF-16LE UTF-16 UTF-32BE; do
  iconv -f UTF-8 -t "$enc" "$tmp/good.lock" >"$tmp/$enc.lock"
  expect "a $enc lock fails" 1 "new flake.lock: not UTF-8" files "$tmp/$enc.lock"
done
printf '\357\273\277' | cat - "$tmp/good.lock" >"$tmp/bom.lock"
expect "a lock with a BOM fails" 1 \
  "new flake.lock: not valid JSON (Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0))" files "$tmp/bom.lock"
expect "a look-alike name is quoted" 1 \
  'node "n\u0456xpkgs": added' files "$(lock '.nodes["n\u0456xpkgs"] = {}')"
expect "a name with a newline is quoted" 1 \
  'node "x\nok: nixpkgs moved forward": added' files "$(lock '.nodes["x\nok: nixpkgs moved forward"] = {}')"

echo "--- usage"
error "no arguments is a usage error" python3 -I "$checker"
error "a missing file is a usage error" files "$tmp/missing.lock"
error "a pr that is not a number is a usage error" python3 -I "$checker" 12x
error "--files with one file is a usage error" python3 -I "$checker" --files "$tmp/old.lock"

echo "--- diff scope (--refs)"
g="$tmp/git"
git() { GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 command git -C "$g" -c user.name=t -c user.email=t@example.invalid "$@"; }
mkdir "$g" && git init -q -b main
cp "$tmp/old.lock" "$g/flake.lock"
printf '{ }\n' >"$g/flake.nix"
git add . && git commit -qm base && git tag base
refs() { (cd "$g" && python3 -I "$checker" --refs "$@"); }

cp "$tmp/good.lock" "$g/flake.lock" && git commit -qam bump && git tag bump
expect "a lock-only commit passes" 0 "lock rules ok for home-manager, nixpkgs (offline: nothing checked upstream, not a merge decision)" refs base bump
printf '{ inputs = { }; }\n' >"$g/flake.nix" && git commit -qam nix && git tag nix
expect "a commit that also touches flake.nix fails" 1 "file flake.nix: changed outside flake.lock" refs base nix
git checkout -q base && printf 'x\n' >"$g/README" && git add README && git commit -qm readme && git tag readme
expect "a commit without flake.lock fails" 1 "file README: changed outside flake.lock
flake.lock: not changed" refs base readme
git checkout -q base && git rm -q flake.lock && ln -s flake.nix "$g/flake.lock" && git add flake.lock \
  && git commit -qm link && git tag link
expect "a lock turned symlink fails" 1 "flake.lock: not a regular file (mode 120000)" refs base link
git checkout -q base && git mv flake.lock flake2.lock && git commit -qm move && git tag move
expect "a renamed lock fails" 1 "file flake2.lock: changed outside flake.lock
flake.lock: deleted" refs base move
git checkout -q base && chmod +x "$g/flake.lock" && git commit -qam exec && git tag exec
expect "a lock made executable fails" 1 "flake.lock: mode changed (100644 -> 100755)" refs base exec
error "an unknown ref is an error" refs base nosuchref

echo "--- pull requests (stub gh)"
mkdir -p "$tmp/bin" "$tmp/gh"
cat >"$tmp/bin/gh" <<'EOF'
#!/bin/sh
# Stub gh: prints the answer stored for exactly these arguments, logs each call.
printf '%s\n' "$*" >>"$GH_STUB/calls"
[ ! -e "$GH_STUB/fail" ] || { echo "gh: HTTP 502" >&2; exit 1; }
f="$GH_STUB/r-$(printf '%s' "$*" | tr -c 'A-Za-z0-9._-' '_')"
[ -e "$f" ] || { echo "stub gh: unexpected call: $*" >&2; exit 1; }
cat "$f"
EOF
chmod +x "$tmp/bin/gh"
cat >"$tmp/bin/nix" <<'EOF'
#!/bin/sh
# Stub nix: like stub gh; also logs both cache dirs and how many entries
# NIX_CACHE_HOME had (Nix reads it before XDG_CACHE_HOME).
printf '%s cache=%s xdg=%s entries=%s\n' "$*" "${NIX_CACHE_HOME:-unset}" "$XDG_CACHE_HOME" \
  "$(ls -A "${NIX_CACHE_HOME:-$XDG_CACHE_HOME}" | wc -l | tr -d ' ')" >>"$GH_STUB/nix-calls"
f="$GH_STUB/n-$(printf '%s' "$*" | tr -c 'A-Za-z0-9._-' '_')"
[ -e "$f" ] || { echo "stub nix: unexpected call: $*" >&2; exit 1; }
cat "$f"
EOF
chmod +x "$tmp/bin/nix"
# answer <gh arguments> <output>: what the stub prints for those arguments.
answer() { printf '%s\n' "$2" >"$tmp/gh/r-$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')"; }
sha() { printf '%040d' 0 | tr 0 "$1"; }
# fetched <owner/repo> <rev> <narHash> <lastModified>: what nix flake prefetch reports.
fetched() {
  printf '{"hash": "%s", "locked": {"lastModified": %s, "narHash": "%s", "rev": "%s", "type": "github"}}\n' \
    "$3" "$4" "$3" "$2" >"$tmp/gh/n-$(printf '%s' "flake prefetch --json github:$1/$2" | tr -c 'A-Za-z0-9._-' '_')"
}
base="$(sha b)" head="$(sha c)"
# tree <commit> <lock file> [lock mode or none] [scripts/x.sh blob]: the
# commit's recursive tree and its lock blob.
tree() {
  local lock_sha entries
  lock_sha="$(command git hash-object "$2")"
  entries="{\"path\": \"flake.nix\", \"mode\": \"100644\", \"type\": \"blob\", \"sha\": \"$(sha 1)\"},
    {\"path\": \"scripts\", \"mode\": \"040000\", \"type\": \"tree\", \"sha\": \"$(sha 2)\"},
    {\"path\": \"scripts/x.sh\", \"mode\": \"100755\", \"type\": \"blob\", \"sha\": \"${4:-$(sha 3)}\"}"
  [ "${3:-}" = none ] || entries="$entries,
    {\"path\": \"flake.lock\", \"mode\": \"${3:-100644}\", \"type\": \"blob\", \"sha\": \"$lock_sha\"}"
  answer "api repos/acme/dots/git/trees/$1?recursive=1" "{\"sha\": \"$1\", \"truncated\": false, \"tree\": [$entries]}"
  answer "api repos/acme/dots/git/blobs/$lock_sha" \
    "{\"sha\": \"$lock_sha\", \"encoding\": \"base64\", \"content\": \"$(base64 <"$2" | tr -d '\n')\"}"
}
# view <state> <base branch> <cross repo> [head branch]: the PR as gh pr view reports it.
fields=state,url,baseRefName,baseRefOid,headRefName,headRefOid,isCrossRepository
view() {
  local json="{\"state\": \"$1\", \"url\": \"https://github.com/acme/dots/pull/7\", \"baseRefName\": \"$2\",
      \"baseRefOid\": \"$base\", \"headRefName\": \"${4:-bot/flake-update}\", \"headRefOid\": \"$head\",
      \"isCrossRepository\": $3}"
  answer "pr view 7 --json $fields" "$json"
  answer "pr view 7 --json $fields -R acme/dots" "$json"
}
# upstream <owner/repo> <rev> <ref> <status>: gh's compare of rev...ref.
upstream() { answer "api repos/$1/compare/$2...$3?per_page=1 --jq .status" "$4"; }
# main <tip> <merge base>: main's current head, and its merge base with the PR head.
main() {
  answer "api repos/acme/dots/git/ref/heads/main --jq .object.sha" "$1"
  answer "api repos/acme/dots/compare/$1...$head?per_page=1 --jq .merge_base_commit.sha" "$2"
}
nix_old=319e4cebef10cbb636c6ea392137b52ad105336a nix_new=674a2028661e550a97400c1cc992b9cca9a668a1
hm_old=54ad640b81c5e9a32db1a29e7561fda628601117 hm_new=c216bf5a1f173b0481bd5c8c489ebe5595ecc68c
reset_pr() {
  rm -f "$tmp/gh/nix-calls"
  view OPEN main false
  main "$base" "$base"
  tree "$base" "$tmp/old.lock"
  tree "$head" "$tmp/good.lock"
  answer "api repos/nix-community/home-manager --jq .default_branch" master
  upstream NixOS/nixpkgs 674a2028661e550a97400c1cc992b9cca9a668a1 nixpkgs-unstable ahead
  upstream nix-community/home-manager c216bf5a1f173b0481bd5c8c489ebe5595ecc68c master identical
  upstream NixOS/nixpkgs "$nix_old" "$nix_new" ahead
  upstream nix-community/home-manager "$hm_old" "$hm_new" ahead
  fetched NixOS/nixpkgs "$nix_new" "sha256-T2+XBfNbf9pecLUWS4+RtuVNZ3W8K5taG5QdV71mWlk=" 1792812153
  fetched nix-community/home-manager "$hm_new" "sha256-/0tELNnhdSnP+bHSdWiEe6KpfSwi6WrTnT9cm/jNkjA=" 1792896866
}
pr() { PATH="$tmp/bin:$PATH" GH_STUB="$tmp/gh" python3 -I "$checker" "$@"; }
ok_pr="ok: home-manager, nixpkgs moved forward
checked head $head on main $base; re-run this check right before merging, then:
  gh pr merge 7 --squash --match-head-commit $head --subject \"chore(flake): update inputs\" --body \"\"
  check-flake-pr --verify-merged 7 $head $base"

reset_pr
expect "a lock-only PR passes and names its head" 0 "$ok_pr" pr 7
expect "-R reaches gh pr view" 0 "$ok_pr" pr -R acme/dots 7
if grep -qx "pr view 7 --json $fields -R acme/dots" "$tmp/gh/calls"; then
  echo "ok   -R is passed on"
else
  echo "FAIL -R is passed on"
  fail=1
fi
tree "$head" "$tmp/good.lock" 100644 "$(sha 4)"
expect "a PR that also changes a nested file fails" 1 "file scripts/x.sh: changed outside flake.lock" pr 7
tree "$head" "$tmp/old.lock" 100644 "$(sha 4)"
expect "a PR without a lock change fails" 1 "file scripts/x.sh: changed outside flake.lock
flake.lock: not changed" pr 7
tree "$head" "$tmp/good.lock" none
expect "a PR that deletes flake.lock fails" 1 "flake.lock: deleted" pr 7
tree "$head" "$tmp/good.lock" 120000
expect "a PR that turns the lock into a symlink fails" 1 "flake.lock: not a regular file (mode 120000)" pr 7
tree "$head" "$tmp/good.lock" 100755
expect "a PR that makes the lock executable fails" 1 "flake.lock: mode changed (100644 -> 100755)" pr 7
reset_pr && tree "$base" "$tmp/old.lock" 120000
expect "a base whose lock is a symlink fails" 1 "flake.lock: was not a regular file (mode 120000)" pr 7
reset_pr && tree "$head" "$(lock '.nodes.nixpkgs.locked.owner = "N1xOS"')"
expect "a PR with a changed owner fails" 1 "node nixpkgs: locked.owner changed" pr 7
reset_pr && main "$(sha d)" "$base"
expect "a PR that is not up to date with main fails" 1 \
  "pull request: not up to date with main $(sha d); run gh pr update-branch 7, then check again" pr 7
reset_pr && view OPEN main false feature
expect "a PR from another branch fails" 1 "pull request: comes from feature, not bot/flake-update" pr 7
reset_pr && upstream NixOS/nixpkgs "$nix_old" "$nix_new" behind
expect "a rollback to an older commit on the branch fails" 1 \
  "node nixpkgs: locked.rev is not a descendant of $nix_old (behind)" pr 7
reset_pr && answer "api repos/NixOS/nixpkgs/compare/$nix_old...$nix_new?per_page=1 --jq .status" ""
expect "an empty ancestry answer fails" 1 \
  "node nixpkgs: locked.rev is not a descendant of $nix_old (\"\")" pr 7
reset_pr && rm "$tmp/gh/r-$(printf '%s' "api repos/NixOS/nixpkgs/compare/$nix_old...$nix_new?per_page=1 --jq .status" | tr -c 'A-Za-z0-9._-' '_')"
error "an ancestry lookup that fails is an error" pr 7
reset_pr && tree "$head" "$(lock '.nodes.nixpkgs.locked.narHash = "sha256-T2+XBfNbf9pecLUWS4+RtuVNZ3W8K5taG5QdV71mWlk="')"
upstream NixOS/nixpkgs "$nix_old" "$nix_old" identical
upstream NixOS/nixpkgs "$nix_old" nixpkgs-unstable ahead
expect "a narHash-only change fails" 1 "node nixpkgs: locked.rev is not a descendant of $nix_old (identical)" pr 7
reset_pr && fetched NixOS/nixpkgs "$nix_new" "sha256-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=" 1792812153
expect "a narHash that is not the rev's source fails" 1 \
  "node nixpkgs: locked.narHash does not match the fetched source" pr 7
reset_pr && fetched NixOS/nixpkgs "$nix_new" "sha256-T2+XBfNbf9pecLUWS4+RtuVNZ3W8K5taG5QdV71mWlk=" 1792812000
expect "a lastModified that is not the rev's fails" 1 \
  "node nixpkgs: locked.lastModified does not match the fetched source (1792812000)" pr 7
# An inherited NIX_CACHE_HOME (here one that already has an entry) must not
# reach nix: it would answer for a rev it already holds.
mkdir -p "$tmp/old-cache" && touch "$tmp/old-cache/fetcher-cache-v4.sqlite"
reset_pr && NIX_CACHE_HOME="$tmp/old-cache" pr 7 >/dev/null 2>&1 || true
line="$(grep "^flake prefetch --json github:NixOS/nixpkgs/$nix_new " "$tmp/gh/nix-calls" || true)"
if [[ "$line" =~ \ cache=("$TMPDIR"[^ ]*)\ xdg=([^ ]*)\ entries=0$ ]] && [ "${BASH_REMATCH[1]}" = "${BASH_REMATCH[2]}" ]; then
  echo "ok   prefetch runs with a fresh, empty cache dir"
else
  echo "FAIL prefetch runs with a fresh, empty cache dir"
  sed 's/^/  /' "$tmp/gh/nix-calls"
  fail=1
fi
reset_pr && rm "$tmp/gh/n-$(printf '%s' "flake prefetch --json github:NixOS/nixpkgs/$nix_new" | tr -c 'A-Za-z0-9._-' '_')"
error "a prefetch that fails is an error" pr 7
reset_pr && upstream NixOS/nixpkgs 674a2028661e550a97400c1cc992b9cca9a668a1 nixpkgs-unstable diverged
expect "a rev that is not on the input's branch fails" 1 \
  "node nixpkgs: locked.rev is not on NixOS/nixpkgs nixpkgs-unstable (diverged)" pr 7
reset_pr && upstream nix-community/home-manager c216bf5a1f173b0481bd5c8c489ebe5595ecc68c master behind
expect "the default branch is used when original has no ref" 1 \
  "node home-manager: locked.rev is not on nix-community/home-manager master (behind)" pr 7
reset_pr && tree "$head" "$(lock '.nodes."pinned-git".locked += {revCount: 105, rev: "2222222222222222222222222222222222222222"}')"
expect "a moved input that is not on github fails" 1 \
  "node pinned-git: cannot check its new rev upstream (type git)" pr 7
reset_pr && tree "$base" "$(lock '.nodes.nixpkgs.locked.owner = "NixOS/x"')" \
  && tree "$head" "$(lock "$bump"' | .nodes.nixpkgs.locked.owner = "NixOS/x"')"
expect "an owner that is not a GitHub name is not sent to gh" 1 \
  "node nixpkgs: cannot check its new rev upstream (type github)" pr 7
reset_pr && view MERGED dev true
expect "a merged, mistargeted fork PR fails on each count" 1 "pull request: MERGED, not open
pull request: targets dev, not main
pull request: comes from a fork" pr 7
reset_pr && answer "pr view 7 --json $fields" '[]'
error "a malformed gh answer is an error" pr 7
reset_pr && answer "api repos/acme/dots/git/trees/$head?recursive=1" '{"truncated": true, "tree": []}'
error "a truncated tree is an error" pr 7
reset_pr && main "$base" ""
error "a PR without a merge base is an error" pr 7

echo "--- after the merge (--verify-merged, stub gh)"
merged="$(sha e)" tree_ok="$(sha 5)"
# merged_view <state> <head> [base branch]: the merged PR as gh pr view reports it.
merged_view() {
  local json="{\"state\": \"$1\", \"url\": \"https://github.com/acme/dots/pull/7\",
      \"baseRefName\": \"${3:-main}\", \"headRefOid\": \"$2\", \"mergeCommit\": {\"oid\": \"$merged\"}}"
  answer "pr view 7 --json state,url,baseRefName,headRefOid,mergeCommit" "$json"
  answer "pr view 7 --json state,url,baseRefName,headRefOid,mergeCommit -R acme/dots" "$json"
}
# commit <sha> <tree> <parent...>: the git commit as gh's git/commits reports it.
commit() {
  local c="$1" t="$2" parents=""
  shift 2
  for p in "$@"; do parents="$parents${parents:+, }{\"sha\": \"$p\"}"; done
  answer "api repos/acme/dots/git/commits/$c" "{\"sha\": \"$c\", \"tree\": {\"sha\": \"$t\"}, \"parents\": [$parents]}"
}
reset_merged() {
  merged_view MERGED "$head"
  commit "$head" "$tree_ok" "$base"
  commit "$merged" "$tree_ok" "$base"
}
verify() { pr --verify-merged 7 "$head" "$base"; }
revert="merge commit $merged: revert it on main before the next sync"
reset_merged
expect "a merge of the checked tree onto the checked main passes" 0 \
  "ok: PR 7 landed on main as $merged, parent $base, tree of $head" verify
expect "-R reaches the merged PR" 0 \
  "ok: PR 7 landed on main as $merged, parent $base, tree of $head" pr -R acme/dots --verify-merged 7 "$head" "$base"
reset_merged && commit "$merged" "$(sha 6)" "$(sha d)"
expect "a squash onto a main that moved fails and says to revert" 1 \
  "merge commit $merged: parents $(sha d), not only the checked main $base
merge commit $merged: tree is not the checked head's tree
$revert" verify
reset_merged && commit "$merged" "$(sha 6)" "$base"
expect "a merged tree that is not the head's fails" 1 \
  "merge commit $merged: tree is not the checked head's tree
$revert" verify
reset_merged && commit "$merged" "$tree_ok" "$base" "$head"
expect "a merge commit with two parents fails" 1 \
  "merge commit $merged: parents $base $head, not only the checked main $base
$revert" verify
reset_merged && merged_view OPEN "$head"
expect "a PR that is not merged fails" 1 "pull request: OPEN, not merged" verify
reset_merged && merged_view MERGED "$(sha f)"
expect "a PR merged at another head fails" 1 \
  "pull request: merged head $(sha f) is not the checked head $head" verify
error "--verify-merged without the main sha is a usage error" pr --verify-merged 7 "$head"
error "--verify-merged with a short sha is a usage error" pr --verify-merged 7 "$head" abc123
reset_merged && rm "$tmp/gh/r-$(printf '%s' "api repos/acme/dots/git/commits/$merged" | tr -c 'A-Za-z0-9._-' '_')"
error "a merge commit lookup that fails is an error" verify
touch "$tmp/gh/fail"
error "a gh failure is an error" pr 7

exit "$fail"
