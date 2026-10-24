# shellcheck shell=bash
# Sourced by every shell suite in tests/ right after its set line, so the
# suite, and any mutant run of it, runs under scripts/test-sandbox: no file
# write outside a fresh scratch dir, no process outliving the run.
# tests/test_sandbox_test.sh runs each suite to check it sources this.
if [ -z "${TEST_SANDBOX:-}" ]; then
  exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/test-sandbox" --rm-scratch --timeout 900 \
    --scratch "$(mktemp -d "${TMPDIR:-/tmp}/test-suite.XXXXXX")" -- "$BASH" "${BASH_SOURCE[1]}" "$@"
fi
# TEST_SANDBOX set by hand would skip the re-exec. macOS refuses to apply a
# sandbox inside another one, so a sandbox that applies means none is on.
if /usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true 2>/dev/null; then
  echo "${BASH_SOURCE[1]##*/}: refused: TEST_SANDBOX is set but no sandbox is on; unset it to run confined" >&2
  exit 125
fi
# Only tests/test_sandbox_test.sh sets this. The suite stops before any
# test, and fails, so a stray setting cannot pass a run.
if [ -n "${TEST_SANDBOX_CONFINE_CHECK:-}" ]; then
  echo "confined: ${BASH_SOURCE[1]##*/}"
  exit 3
fi
