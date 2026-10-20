#!/usr/bin/env bash
# scripts/lavish-axi is a tombstone: it exits 2, points at the visual-reply
# skill and packs, and opens nothing, whatever it is asked.
# Pure: stubs open and the browsers on PATH, writes only to a temp dir.
# Run: bash tests/lavish_retired_test.sh
set -uo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail=0
for tool in open osascript node; do
  printf '#!/bin/sh\necho %s >>"%s/calls"\n' "$tool" "$tmp" >"$tmp/$tool"
  chmod +x "$tmp/$tool"
done
for args in "" "page.html" "--no-open page.html" "poll" "stop"; do
  # shellcheck disable=SC2086 # one argument per word
  PATH="$tmp:/usr/bin:/bin" "$repo/scripts/lavish-axi" $args >"$tmp/out" 2>"$tmp/err"
  code=$?
  if [ "$code" = 2 ] && [ ! -s "$tmp/out" ] && grep -q "Lavish is retired" "$tmp/err" &&
    grep -q "visual-reply skill" "$tmp/err" && grep -q "a pack in ~/packs" "$tmp/err"; then
    echo "ok   lavish-axi ${args:-(no args)} refuses and points at visual-reply"
  else
    echo "FAIL lavish-axi ${args:-(no args)}: exit $code, stdout $(cat "$tmp/out"), stderr $(cat "$tmp/err")"
    fail=1
  fi
done
if [ -e "$tmp/calls" ]; then echo "FAIL lavish-axi ran $(tr '\n' ' ' <"$tmp/calls")"; fail=1
else echo "ok   lavish-axi opens nothing"; fi
exit "$fail"
