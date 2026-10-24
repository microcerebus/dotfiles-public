// tests/agent_chrome_replay_test.cjs starts a headless shell and two gates in
// a file-level before() and waits for each to answer. On 24 Oct 2026 that
// wait had no bound, and node:test gives hooks no default timeout, so a run
// inside the write sandbox sat for 20 minutes with nothing in its output.
// This runs a copy of the replay file whose gate is a stub that never
// answers, and expects the file to fail fast and say why.
require("./lib/agent-chrome-test-env.cjs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
// What the replay file loads, copied so the stub can take the gate's place.
const COPIED = ["tests/agent_chrome_replay_test.cjs", "tests/lib", "scripts/agent-chrome-session", "scripts/agent-chrome-playwright",
  "scripts/chrome-devtools-axi", "scripts/codex-browser-fallback"];

let skip = false;
try { require("../scripts/agent-chrome-playwright").playwrightDirectory(); } catch { skip = "needs the pnpm global playwright-core, as the replay file does"; }

// A copy of the replay file whose scripts/agent-chrome-gate runs `stub` as a
// program. Required as a module (agent-chrome-playwright takes its framing
// from it), it is still the real gate.
function replayCopy(stub) {
  const dir = fs.mkdtempSync(join(process.env.AGENT_CHROME_TEST_SCRATCH, "replay-startup-"));
  for (const path of COPIED) fs.cpSync(join(ROOT, path), join(dir, path), { recursive: true });
  fs.copyFileSync(join(ROOT, "scripts/agent-chrome-gate"), join(dir, "scripts/agent-chrome-gate-real"));
  fs.writeFileSync(join(dir, "scripts/agent-chrome-gate"), `if (require.main !== module) { module.exports = require("./agent-chrome-gate-real"); return; }\n${stub}`);
  return join(dir, "tests/agent_chrome_replay_test.cjs");
}

// Runs the copy in its own process group and kills that group when it ends
// or after `limitMs`, so a hang shows as a failure here, not as a stuck suite.
function runReplay(file, limitMs, env) {
  const childEnv = { ...process.env, ...env };
  // Set by this file's own runner; inherited, it makes the nested run talk
  // the runner's binary protocol instead of TAP.
  delete childEnv.NODE_TEST_CONTEXT;
  const started = Date.now();
  const child = spawn(process.execPath, ["--test", file], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: childEnv });
  assert.ok(child.pid > 1);
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const killGroup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
  return new Promise((resolve) => {
    const timer = setTimeout(() => { killGroup(); resolve({ hung: true, ms: Date.now() - started, output }); }, limitMs);
    child.once("close", (code) => { clearTimeout(timer); killGroup(); resolve({ hung: false, code, ms: Date.now() - started, output }); });
  });
}

const tail = (output) => output.split("\n").slice(-40).join("\n");

test("a gate that listens and never answers fails the replay file's startup at its bound, with the gate's stderr", { skip, timeout: 120000 }, async () => {
  const file = replayCopy(`
const net = require("node:net");
const port = Number(process.env.AGENT_CHROME_GATE_PORT);
net.createServer(() => {}).listen(port, "127.0.0.1", () => process.stderr.write("stub gate: listening on " + port + ", never answering\\n"));
`);
  const result = await runReplay(file, 90000, { AGENT_CHROME_REPLAY_TEST_STARTUP_MS: "15000" });
  assert.equal(result.hung, false, `the replay file was still starting after ${result.ms} ms; its output:\n${tail(result.output)}`);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /nothing answers on \d+/);
  assert.match(result.output, /stub gate: listening on \d+, never answering/);
});

test("a gate that exits before it answers fails the replay file's startup at once, with its exit code and stderr", { skip, timeout: 120000 }, async () => {
  const file = replayCopy(`
process.stderr.write("stub gate: refusing to start\\n");
process.exit(3);
`);
  // The default bound stays in place: only the exit can end this early.
  const result = await runReplay(file, 45000, {});
  assert.equal(result.hung, false, `the replay file was still starting after ${result.ms} ms; its output:\n${tail(result.output)}`);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /nothing answers on \d+: agent-chrome-gate exited with code 3 before it answered/);
  assert.match(result.output, /stub gate: refusing to start/);
});
