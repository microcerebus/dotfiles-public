// Test-only: keeps a child's temp files inside scripts/test-sandbox's scratch dir.
// Under test-sandbox (TEST_SANDBOX set) every write outside that dir fails. The
// sandbox points TMPDIR and XDG_CACHE_HOME into it and puts its bin dir, with a
// mktemp shim, first on PATH, because macOS mktemp ignores TMPDIR. A child given
// an env built from scratch loses all of that, and its first mktemp or mkdtemp
// lands in /tmp or /var/folders and fails. Chrome on macOS ignores TMPDIR as
// well and makes its profile lock socket under MAC_CHROMIUM_TMPDIR, or the
// per-user temp dir without it.
// withSandbox(env) adds exactly those settings, keeping any the test set itself,
// and puts the shim dir after the test's own dirs, so a test's stub still wins.
// Outside the sandbox it returns env as it is. Checked by tests/sandbox_env_test.cjs.
const { join } = require("node:path");

// What the shell gives a child with no PATH.
const DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const SYSTEM_DIRS = DEFAULT_PATH.split(":");

// test-sandbox starts its command with TEST_SANDBOX/bin on PATH, and
// withSandbox keeps it there for each child. A TEST_SANDBOX without its bin
// dir on PATH is a stray export, not a sandbox, and changes nothing. Not
// "first on PATH": agent-chrome-test-env.cjs puts its curl guard ahead of it,
// and a child's stubs go ahead of it too. Read once, as this file loads.
function sandboxOf(parent) {
  const dir = parent.TEST_SANDBOX;
  if (!dir || !(parent.PATH ?? "").split(":").includes(join(dir, "bin"))) return null;
  return { TEST_SANDBOX: dir, TMPDIR: parent.TMPDIR, XDG_CACHE_HOME: parent.XDG_CACHE_HOME, MAC_CHROMIUM_TMPDIR: parent.TMPDIR };
}
const SANDBOX = sandboxOf(process.env);

function withSandbox(env) {
  if (!SANDBOX) return env;
  const out = { ...env };
  for (const [key, value] of Object.entries(SANDBOX)) {
    if (value !== undefined && (out[key] === undefined || out[key] === "")) out[key] = value;
  }
  // The shim goes after the dirs the test put first, its stubs among them, and
  // before the system dirs, whose mktemp it stands in for.
  const shim = join(SANDBOX.TEST_SANDBOX, "bin");
  const path = out.PATH === undefined ? DEFAULT_PATH : out.PATH;
  const dirs = path === "" ? [] : path.split(":");
  if (!dirs.includes(shim)) {
    const system = dirs.findIndex((dir) => SYSTEM_DIRS.includes(dir));
    dirs.splice(system < 0 ? dirs.length : system, 0, shim);
  }
  out.PATH = dirs.join(":");
  return out;
}

module.exports = { withSandbox, DEFAULT_PATH };
