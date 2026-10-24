// Test-only: every agent Chrome test loads this first, before node:child_process
// and before any script. With an env var missing, the scripts fall back to the
// live agent Chrome (the gate on 9333, Chrome on 9334), and on 24 Oct 2026
// mutant runs that stripped a check reached it seven times, each a stray
// notice to the owner. So this file:
// - loads the live-port guard,
// - points every gate and Chrome setting at a dead port, notices at a file and
//   state at a temp dir, unless the test already set them to something safe,
// - adds the same settings to any env a test builds for a child process, and
//   preloads this file there, so a hand-built env cannot drop them.
// Checked by tests/agent_chrome_test_env_test.cjs.
const { LIVE_PORTS } = require("./live-port-guard.cjs");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
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

// Each setting a script reads, with the dead value it gets when it is missing.
const SETTINGS = {
  AGENT_CHROME_SESSION_TEST_GATE_URL: DEAD_URL, // scripts/agent-chrome-session GATE_URL
  AGENT_CHROME_GATE_PORT: "0", // scripts/agent-chrome-gate main: listen on any free port
  AGENT_CHROME_GATE_CHROME_PORT: String(DEAD_PORT), // scripts/agent-chrome-gate: Chrome behind it
  AGENT_CHROME_READY_TEST_PORT: String(DEAD_PORT), // scripts/agent-chrome-ready
  // The real chrome-devtools-axi binary's bridge. Unset, it hashes the session
  // name (scripts/chrome-devtools-axi uses CLAUDE_CODE_SESSION_ID) into
  // 9225-10224, which finds this thread's live bridge, already attached to the
  // agent Chrome. Neither guard nor the gate log sees that.
  CHROME_DEVTOOLS_AXI_PORT: String(DEAD_PORT),
  AGENT_CHROME_SESSION_TEST_NOTIFY_LOG: join(scratch, "notices"), // notices to a file, not the owner
  AGENT_CHROME_STATE_HOME: join(scratch, "home"), // declarations outside ~/.local/state
  AGENT_CHROME_TEST_SCRATCH: scratch,
};
// axi drives whatever these name, and an agent shell's bridge port names its
// live bridge. The test process drops inherited ones; a test that wants one
// sets it on the env it passes to a child, which keeps it.
const DROPPED = ["CHROME_DEVTOOLS_AXI_BROWSER_URL", "CHROME_DEVTOOLS_AXI_AUTO_CONNECT", "CHROME_DEVTOOLS_AXI_MAIN_CHROME", "CHROME_DEVTOOLS_AXI_PORT"];

function livePort(value) {
  const text = String(value);
  const port = /^\d+$/.test(text) ? Number(text) : Number(/:(\d+)(?:[/?#]|$)/.exec(text)?.[1]);
  return LIVE_PORTS.includes(port) ? port : null;
}

function withDeadDefaults(env) {
  const out = { ...env };
  // A test port without a kickstart hook makes agent-chrome-ready refuse; only
  // add the no-op hook when this file supplies the port. The script reads "" as unset.
  if (!out.AGENT_CHROME_READY_TEST_PORT && !out.AGENT_CHROME_READY_TEST_KICKSTART) out.AGENT_CHROME_READY_TEST_KICKSTART = "true";
  for (const [key, value] of Object.entries(SETTINGS)) {
    if (out[key] === undefined || out[key] === "") out[key] = value;
    const port = livePort(out[key]);
    if (port !== null) throw new Error(`agent-chrome-test-env: ${key}=${out[key]} is the live port ${port}. Use a dead or stub port; leave it unset for ${value}.`);
  }
  const preload = `--require ${JSON.stringify(SELF)}`;
  if (!(out.NODE_OPTIONS ?? "").includes(SELF)) out.NODE_OPTIONS = `${out.NODE_OPTIONS ?? ""} ${preload}`.trim();
  return out;
}

if (topLevel) for (const key of DROPPED) delete process.env[key];
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

module.exports = { DEAD_PORT, DEAD_URL, SETTINGS, LIVE_PORTS, withDeadDefaults, original };
