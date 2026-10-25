// Test-only: every agent Chrome test loads this first, before node:child_process
// and before any script. With an env var missing, the scripts fall back to the
// live agent Chrome (the gate on 9333, Chrome on 9334), and on 24 Oct 2026
// mutant runs that stripped a check reached it seven times, each a stray
// notice to the owner. So this file:
// - loads the live-port guard,
// - points every gate and Chrome setting at a dead port, notices at a file,
//   state at a temp dir and chrome-devtools-axi at a stub binary, unless the
//   test already set them to something safe,
// - puts a curl first on PATH that refuses the live ports, since curl (as in
//   scripts/agent-chrome-ready) is outside the node guard,
// - adds the same settings to any env a test builds for a child process, and
//   preloads this file there, so a hand-built env cannot drop them,
// - and, under scripts/test-sandbox, the sandbox's temp settings too
//   (tests/lib/sandbox-env.cjs), so that child's temp files stay in scratch.
// Checked by tests/agent_chrome_test_env_test.cjs.
const { LIVE_PORTS } = require("./live-port-guard.cjs");
const { withSandbox, DEFAULT_PATH } = require("./sandbox-env.cjs");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { promisify } = require("node:util");

// Port 9 (discard) has no listener on macOS, so a connection there is refused at once.
const DEAD_PORT = 9;
const DEAD_URL = `http://127.0.0.1:${DEAD_PORT}`;
const SELF = __filename;

let scratch = process.env.AGENT_CHROME_TEST_SCRATCH;
// The test process itself, not a child this file was preloaded into.
const topLevel = !scratch;
if (topLevel) {
  scratch = fs.mkdtempSync(join(tmpdir(), "agent-chrome-test-"));
  process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));
}
// The stub's one path. Written here and never to a SETTINGS value, so an edit
// there cannot overwrite the real binary's pnpm shim.
const AXI_STUB = join(scratch, "chrome-devtools-axi");

// Each setting a script reads, with the dead value it gets when it is missing.
const SETTINGS = {
  AGENT_CHROME_SESSION_TEST_GATE_URL: DEAD_URL, // scripts/agent-chrome-session GATE_URL
  AGENT_CHROME_GATE_PORT: "0", // scripts/agent-chrome-gate main: listen on any free port
  AGENT_CHROME_GATE_CHROME_PORT: String(DEAD_PORT), // scripts/agent-chrome-gate: Chrome behind it
  AGENT_CHROME_READY_TEST_PORT: String(DEAD_PORT), // scripts/agent-chrome-ready
  // The bridge port the real chrome-devtools-axi binary would start a new
  // bridge on. Unset, it hashes the session name into 9225-10224. This does not
  // keep the binary off a live bridge: it first reuses the bridge named in its
  // session's ~/.chrome-devtools-axi bridge.pid, whatever this says, and that
  // bridge drives the agent Chrome. Hence the stub binary below.
  CHROME_DEVTOOLS_AXI_PORT: String(DEAD_PORT),
  // scripts/chrome-devtools-axi runs this instead of the real binary.
  CHROME_DEVTOOLS_AXI_TEST_BINARY: AXI_STUB,
  AGENT_CHROME_SESSION_TEST_NOTIFY_LOG: join(scratch, "notices"), // notices to a file, not the owner
  AGENT_CHROME_STATE_HOME: join(scratch, "home"), // declarations outside ~/.local/state
  AGENT_CHROME_TEST_SCRATCH: scratch,
};
// axi drives whatever these name, and an agent shell's bridge port names its
// live bridge. The test process drops inherited ones; a test that wants one
// sets it on the env it passes to a child, which keeps it.
const DROPPED = ["CHROME_DEVTOOLS_AXI_BROWSER_URL", "CHROME_DEVTOOLS_AXI_AUTO_CONNECT", "CHROME_DEVTOOLS_AXI_MAIN_CHROME", "CHROME_DEVTOOLS_AXI_PORT"];

// Holds a curl that refuses the live ports and hands every other call to the
// next curl on PATH, so a test's own fake curl still runs. A committed file,
// not one per test: macOS takes about half a second over a script's first run.
const CURL_GUARD = join(__dirname, "curl-guard");
const AXI_REFUSAL = "tests never run the real chrome-devtools-axi binary; inject spawn";

function livePort(value) {
  const text = String(value);
  const port = /^\d+$/.test(text) ? Number(text) : Number(/:(\d+)(?:[/?#]|$)/.exec(text)?.[1]);
  return LIVE_PORTS.includes(port) ? port : null;
}

function withDeadDefaults(env) {
  const out = withSandbox({ ...env });
  // A test port without a kickstart hook makes agent-chrome-ready refuse; only
  // add the no-op hook when this file supplies the port. The script reads "" as unset.
  if (!out.AGENT_CHROME_READY_TEST_PORT && !out.AGENT_CHROME_READY_TEST_KICKSTART) out.AGENT_CHROME_READY_TEST_KICKSTART = "true";
  for (const [key, value] of Object.entries(SETTINGS)) {
    if (out[key] === undefined || out[key] === "") out[key] = value;
    const port = livePort(out[key]);
    if (port !== null) throw new Error(`agent-chrome-test-env: ${key}=${out[key]} is the live port ${port}. Use a dead or stub port; leave it unset for ${value}.`);
  }
  // A test may hand a child a stub of its own, but only one in a temp dir: the real binary sits in ~/Library/pnpm/bin.
  // The test process's temp dir holds scratch, and a child given no TMPDIR has /tmp for tmpdir(), so both count.
  if (![dirname(scratch), tmpdir()].some((dir) => out.CHROME_DEVTOOLS_AXI_TEST_BINARY.startsWith(dir + "/"))) throw new Error(`agent-chrome-test-env: CHROME_DEVTOOLS_AXI_TEST_BINARY=${out.CHROME_DEVTOOLS_AXI_TEST_BINARY} is outside the test's temp dir ${dirname(scratch)}. Tests never run the real chrome-devtools-axi binary; leave it unset for the helper's stub.`);
  // A child env without PATH gets the shell's default PATH, with no guard: give it the guard and that default.
  const path = out.PATH === undefined ? DEFAULT_PATH : out.PATH;
  out.PATH = path.split(":").includes(CURL_GUARD) ? path : `${CURL_GUARD}:${path}`;
  const preload = `--require ${JSON.stringify(SELF)}`;
  if (!(out.NODE_OPTIONS ?? "").includes(SELF)) out.NODE_OPTIONS = `${out.NODE_OPTIONS ?? ""} ${preload}`.trim();
  return out;
}

if (topLevel) {
  for (const key of DROPPED) delete process.env[key];
  // Inherited from the shell, it cannot be this run's stub: the scratch dir is new.
  if (process.env.CHROME_DEVTOOLS_AXI_TEST_BINARY) throw new Error(`agent-chrome-test-env: an inherited CHROME_DEVTOOLS_AXI_TEST_BINARY=${process.env.CHROME_DEVTOOLS_AXI_TEST_BINARY} is outside this test's scratch dir. Unset it; the helper points it at its own stub.`);
  fs.writeFileSync(AXI_STUB, `#!/bin/sh\necho ${JSON.stringify(AXI_REFUSAL)} >&2\nexit 1\n`, { mode: 0o755 });
}
Object.assign(process.env, withDeadDefaults(process.env));
fs.mkdirSync(process.env.AGENT_CHROME_STATE_HOME, { recursive: true });

// A child gets the dead settings even when the test passes an env of its own.
const original = {};
// spawn/execFile/fork(command, args?, options?) and exec(command, options?):
// options is the first plain object after the command. Node also takes
// (command, undefined, options) and (command, null, options).
const optionsAt = (args) => args.findIndex((arg, i) => i > 0 && arg !== null && typeof arg === "object" && !Array.isArray(arg));
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
  const fn = childProcess[name];
  original[name] = fn;
  const wrapped = function (...args) {
    const at = optionsAt(args);
    if (at >= 0 && args[at].env) args[at] = { ...args[at], env: withDeadDefaults(args[at].env) };
    return fn.apply(this, args);
  };
  if (fn[promisify.custom]) {
    // execFile and exec resolve { stdout, stderr }; keep that shape through the wrapper.
    wrapped[promisify.custom] = (...args) => new Promise((resolve, reject) => {
      wrapped(...args, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
    });
  }
  childProcess[name] = wrapped;
}
// ESM tests import named bindings from node:child_process; make them see the wrappers.
require("node:module").syncBuiltinESMExports();

module.exports = { DEAD_PORT, DEAD_URL, SETTINGS, LIVE_PORTS, CURL_GUARD, AXI_STUB, AXI_REFUSAL, withDeadDefaults, original };
