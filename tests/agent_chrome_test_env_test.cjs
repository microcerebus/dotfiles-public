require("./lib/agent-chrome-test-env.cjs");
// A test must never reach the live agent Chrome when it leaves a setting out.
// On 24 Oct 2026, mutant runs that stripped a check in
// scripts/agent-chrome-session fell through to its default gate on 9333 seven
// times, and each one sent the owner a stray notice. This checks the defence
// without leaning on the live-port guard: a child clears every setting, loads
// tests/lib/agent-chrome-test-env.cjs, then stubs connect and fetch on top of
// everything, so it records where each production default would connect and
// nothing leaves the process.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const env = require("./lib/agent-chrome-test-env.cjs");
// The unwrapped calls below build a child env by hand; under test-sandbox it needs the sandbox's temp settings too.
const { withSandbox } = require("./lib/sandbox-env.cjs");

const HELPER = join(__dirname, "lib/agent-chrome-test-env.cjs");
const SANDBOX_ENV = join(__dirname, "lib/sandbox-env.cjs");
const REPO = join(__dirname, "..");
const SCRIPTS = join(REPO, "scripts");
const BOARD = join(REPO, ".claude/skills/verify-agent-board/scripts/board.mjs");
// Bare names, so a test that builds the path with join(REPO, "scripts", name) still counts.
const NAMES_A_SCRIPT = /\b(agent-chrome-(session|gate|playwright|ready)|chrome-devtools-axi|verify-agent-board)\b/;
// What the scripts read, listed here rather than taken from the helper, so a
// setting dropped from the helper is still checked.
const PORT_SETTINGS = ["AGENT_CHROME_SESSION_TEST_GATE_URL", "AGENT_CHROME_GATE_PORT", "AGENT_CHROME_GATE_CHROME_PORT", "AGENT_CHROME_READY_TEST_PORT", "CHROME_DEVTOOLS_AXI_PORT"];
// Each must sit in the test's scratch dir, or a test that relies on the helper
// sends the owner a real notice, writes real state or runs the real axi binary.
const SCRATCH_SETTINGS = ["AGENT_CHROME_SESSION_TEST_NOTIFY_LOG", "AGENT_CHROME_STATE_HOME", "CHROME_DEVTOOLS_AXI_TEST_BINARY"];
const FIX = "Set it in SETTINGS in tests/lib/agent-chrome-test-env.cjs, and have the script read that variable before its production default.";
const DOCTOR = "verify-agent-board board.mjs doctor";

test("every test that runs an agent Chrome script loads the dead-port helper first", () => {
  assert.match('join(REPO, "scripts", "agent-chrome-gate")', NAMES_A_SCRIPT, "NAMES_A_SCRIPT must match a test that builds a script path with join(), not only the text scripts/<name>.");
  for (const name of fs.readdirSync(__dirname).filter((file) => /\.(c|m)?js$/.test(file))) {
    const source = fs.readFileSync(join(__dirname, name), "utf8");
    if (!NAMES_A_SCRIPT.test(source)) continue;
    const first = source.split("\n").find((line) => /^\s*import\b|\brequire\(/.test(line) && !/^\s*\/\//.test(line));
    assert.match(first ?? "", /\.\/lib\/agent-chrome-test-env\.cjs/,
      `tests/${name} runs an agent Chrome script, but its first require is ${JSON.stringify(first)}. Make require("./lib/agent-chrome-test-env.cjs") (or import "./lib/agent-chrome-test-env.cjs") its first line, before node:child_process and ../scripts, so a missing URL falls to a dead port instead of the live agent Chrome.`);
  }
});

// Preloaded into each board.mjs run after the helper: records every fetch URL
// and every socket connect, and sends nothing.
const RECORDER = `
const fs = require("node:fs");
const net = require("node:net");
const log = (line) => fs.appendFileSync(process.env.PROBE_REQUESTS, line + "\\n");
globalThis.fetch = async (input) => { log("fetch " + String(input?.url ?? input)); throw new Error("probe: fetch stubbed"); };
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  log("connect " + (typeof first === "object" && first !== null ? first.port : first));
  process.nextTick(() => this.destroy(new Error("probe: connect stubbed")));
  return this;
};
`;
// An ESM test that hands a child its own env: only the helper's import can give the child the settings.
const ESM_CHILD = `
import ${JSON.stringify(pathToFileURL(HELPER).href)};
import { spawnSync } from "node:child_process";
process.stdout.write(spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { env: { PATH: process.env.PATH }, encoding: "utf8" }).stdout);
`;

const PROBE = `
const helper = require(${JSON.stringify(HELPER)});
const net = require("node:net");
const http = require("node:http");
const fs = require("node:fs");
const { join } = require("node:path");
const { spawn, spawnSync, execFile, execFileSync, exec, execSync, fork } = require("node:child_process");
const S = ${JSON.stringify(SCRIPTS)};
// Before the stubs below replace them: the helper must have installed the live-port guard.
const guarded = net.Socket.prototype.connect.liveGuarded === true && globalThis.fetch.liveGuarded === true;
const seen = [];
const allowed = new Set();
const scratch = process.env.AGENT_CHROME_TEST_SCRATCH;
// Outermost: record the port and never connect, except to this process's own gate.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const port = Number(typeof first === "object" && first !== null ? first.port : first);
  if (allowed.has(port)) return connect.apply(this, args);
  seen.push({ how: "connect", port });
  process.nextTick(() => this.destroy(new Error("probe: connect stubbed")));
  return this;
};
globalThis.fetch = async (input) => {
  seen.push({ how: "fetch", port: Number(new URL(typeof input === "string" || input instanceof URL ? input : input.url).port) });
  throw new Error("probe: fetch stubbed");
};
const quietly = (promise) => Promise.resolve().then(() => promise).catch(() => {});
// agent-chrome-playwright finds playwright-core through pnpm. A fake pnpm lists a
// stub whose connectOverCDP fetches the URL it is given, so the stubbed fetch records it.
fs.mkdirSync(join(scratch, "bin"));
fs.mkdirSync(join(scratch, "playwright-core"));
fs.writeFileSync(join(scratch, "playwright-core/index.js"), 'module.exports = { chromium: { connectOverCDP: (url) => fetch(new URL("/json/version", url)) } };');
fs.writeFileSync(join(scratch, "pnpm-ls.json"), JSON.stringify([{ dependencies: { "playwright-core": { path: join(scratch, "playwright-core") } } }]));
fs.writeFileSync(join(scratch, "bin/pnpm"), "#!/bin/sh\\nexec cat " + JSON.stringify(join(scratch, "pnpm-ls.json")) + "\\n", { mode: 0o755 });
fs.writeFileSync(join(scratch, "record-requests.cjs"), ${JSON.stringify(RECORDER)});
fs.writeFileSync(join(scratch, "print-env.cjs"), "process.stdout.write(JSON.stringify(process.env))");
fs.writeFileSync(join(scratch, "esm-child.mjs"), ${JSON.stringify(ESM_CHILD)});
process.env.PATH = join(scratch, "bin") + ":" + process.env.PATH;
// board.mjs on a made-up run, with RECORDER outermost; returns its stdout.
const board = (args, extraEnv) => {
  const state = join(scratch, "board-state");
  const dir = join(state, "probe");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: "probe", mode: "probe", port: 9, checkout: ${JSON.stringify(REPO)}, dir, keeperPid: 0, boardPid: 0,
    board: "none", env: {}, expiresAt: new Date(Date.now() + 3600000).toISOString(), urls: { local: "http://127.0.0.1:9" }, evidence: dir }));
  const requests = join(scratch, "board-requests");
  fs.writeFileSync(requests, "");
  const result = spawnSync(process.execPath, ["--require", join(scratch, "record-requests.cjs"), ${JSON.stringify(BOARD)}, ...args],
    { env: { ...process.env, VERIFY_AGENT_BOARD_STATE: state, PROBE_REQUESTS: requests, ...extraEnv }, encoding: "utf8", timeout: 20000 });
  for (const line of fs.readFileSync(requests, "utf8").split("\\n").filter(Boolean)) {
    const [how, target] = line.split(" ");
    const url = how === "fetch" ? URL.parse(target) : null;
    seen.push(how === "fetch" ? { how: "fetch " + target, port: Number(url?.port), path: url?.pathname } : { how: "connect", port: Number(target) });
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};
(async () => {
  const session = require(S + "/agent-chrome-session");
  const runner = require(S + "/agent-chrome-playwright");
  const axi = require(S + "/chrome-devtools-axi");
  const gate = require(S + "/agent-chrome-gate");
  const out = { guarded, gateUrl: session.GATE_URL, steps: {} };
  const step = async (name, act) => { const from = seen.length; await quietly(act()); out.steps[name] = seen.slice(from); };
  await step("agent-chrome-session keepTab", () => session.keepTab("tab-1", "probe"));
  await step("agent-chrome-playwright defaults.keepTab", () => runner.defaults.keepTab("tab-1", "probe"));
  await step("agent-chrome-playwright defaults.openTab", () => runner.defaults.openTab("about:blank#probe"));
  await step("agent-chrome-playwright defaults.connect", () => runner.defaults.connect());
  // The agent Chrome never answers, so axi kickstarts it (stubbed: the real one runs launchctl) and retries 30 times.
  out.axiTimeout = "";
  await step("chrome-devtools-axi probe", () => axi.run(["snapshot"], {}, { ...axi.defaultDeps, fallbackUntil: () => null,
    probe: (url) => { seen.push({ how: "probe", port: Number(new URL(url).port) }); return false; },
    agentInstalled: () => true, kickstart: () => {}, sleep: () => {}, spawn: () => ({ status: 0 }), lease: () => {}, endLease: () => {} },
    { stderr: { write: (text) => { out.axiTimeout += text; } } }));
  // The agent Chrome answers: record the binary, browser URL and bridge port axi hands its child (spawn stubbed, nothing runs).
  out.axiBinaries = [];
  const axiChild = (env) => axi.run(["snapshot"], env, { ...axi.defaultDeps, fallbackUntil: () => Date.now() / 1000 + 3600,
    probe: () => true, browserCommandLines: () => ["chrome --disable-extensions --disable-sync"], lease: () => {}, endLease: () => {},
    spawn: (file, args, options) => {
      out.axiBinaries.push(file);
      const url = options.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
      seen.push(url === undefined
        ? { how: "hand the real binary no CHROME_DEVTOOLS_AXI_BROWSER_URL (main-Chrome or autoConnect mode)", fix: "The helper must drop inherited axi variables in the test process (DROPPED in tests/lib/agent-chrome-test-env.cjs)." }
        : { how: "hand the real binary CHROME_DEVTOOLS_AXI_BROWSER_URL", port: Number(URL.parse(url)?.port) });
      // Only a bridge the binary has to start: it reuses a live one named in its session's bridge.pid whatever this says.
      seen.push({ how: "hand the real binary CHROME_DEVTOOLS_AXI_PORT for a new bridge", port: Number(options.env.CHROME_DEVTOOLS_AXI_PORT) });
      return { status: 0 };
    } }, { stderr: { write: () => {} } });
  await step("chrome-devtools-axi child", () => axiChild(process.env));
  // nix/user.nix exports this URL in every shell, and axi must still hand the binary GATE_URL.
  await step("chrome-devtools-axi child, nix's 9333 URL", () => axiChild({ ...process.env, CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:9333" }));
  // The binary axi would run must be the helper's refusing stub; run it only once it is known to be: in scratch, and a
  // sh script that prints the refusal. Either check alone keeps the real binary from running here.
  const stub = out.axiBinaries[0] ?? "";
  const stubText = stub.startsWith(scratch + "/") && fs.existsSync(stub) ? fs.readFileSync(stub, "utf8") : "";
  out.axiStub = stubText.startsWith("#!/bin/sh\\n") && stubText.includes(helper.AXI_REFUSAL) ? spawnSync(stub, ["snapshot"], { encoding: "utf8" }) : null;
  // agent-chrome-ready's curl is outside the node guards. A recording curl and launchctl, first on PATH, refuse every call.
  await step("agent-chrome-ready", () => {
    const calls = join(scratch, "ready-calls");
    fs.writeFileSync(calls, "");
    fs.writeFileSync(join(scratch, "bin/curl"), "#!/bin/sh\\nfor a in \\"$@\\"; do case \\"$a\\" in http*) echo \\"curl $a\\" >> " + JSON.stringify(calls) + " ;; esac; done\\nexit 7\\n", { mode: 0o755 });
    fs.writeFileSync(join(scratch, "bin/launchctl"), "#!/bin/sh\\necho \\"launchctl $*\\" >> " + JSON.stringify(calls) + "\\nexit 1\\n", { mode: 0o755 });
    const hook = "echo kickstart >> " + JSON.stringify(calls) + "; " + process.env.AGENT_CHROME_READY_TEST_KICKSTART;
    const result = spawnSync("/bin/bash", [S + "/agent-chrome-ready"], { env: { ...process.env, AGENT_CHROME_READY_TEST_KICKSTART: hook }, encoding: "utf8", timeout: 20000 });
    const lines = fs.readFileSync(calls, "utf8").split("\\n").filter(Boolean);
    for (const line of lines) {
      if (line.startsWith("curl ")) seen.push({ how: line, port: Number(URL.parse(line.slice(5))?.port) });
      if (line.startsWith("launchctl ")) seen.push({ how: "run " + line + " instead of its test kickstart hook", fix: "scripts/agent-chrome-ready must run AGENT_CHROME_READY_TEST_KICKSTART whenever AGENT_CHROME_READY_TEST_PORT is set, and the helper must set both." });
    }
    out.ready = { status: result.status, stderr: result.stderr, kickstarts: lines.filter((line) => line === "kickstart").length };
  });
  // board.mjs doctor ends by checking the agent Chrome; its page checks fetch / and /map on the run's own port.
  await step(${JSON.stringify(DOCTOR)}, () => { out.boardDoctor = board(["doctor", "probe"], {}).stdout; });
  // A malformed test URL fails doctor's agent Chrome check, and nothing else.
  await step("verify-agent-board board.mjs doctor, malformed gate URL", () => { out.boardMalformed = board(["doctor", "probe"], { AGENT_CHROME_SESSION_TEST_GATE_URL: "9" }).stdout; });
  out.boardRunsMalformed = board(["runs"], { AGENT_CHROME_SESSION_TEST_GATE_URL: "9" });
  await step("agent-chrome-gate createGate over http", async () => {
    const server = gate.createGate({ identify: async () => ({ client: "probe", declaration: { what: "probe", current: () => ({ foreground: false }), live: () => true } }) });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    allowed.add(server.address().port);
    await new Promise((resolve) => http.get({ host: "127.0.0.1", port: server.address().port, path: "/json/version" }, (res) => res.resume().on("end", resolve)).on("error", resolve));
    server.closeAllConnections(); server.close();
  });
  const collect = (child) => new Promise((resolve) => { let text = ""; child.stdout.on("data", (chunk) => { text += chunk; }); child.on("close", () => resolve(text)); });
  // The real gate, as a child: it inherits the helper's env and preload.
  out.gateMain = await new Promise((resolve) => {
    const child = spawn(process.execPath, [S + "/agent-chrome-gate"], { stdio: ["ignore", "ignore", "pipe"] });
    let text = "";
    child.stderr.on("data", (chunk) => { text += chunk; if (text.includes("\\n")) { child.kill("SIGKILL"); resolve(text.split("\\n")[0]); } });
    setTimeout(() => { child.kill("SIGKILL"); resolve(text); }, 10000);
  });
  // A hand-built env still gets the dead settings and the preload, through every wrapped function and each call shape Node takes.
  const keys = ${JSON.stringify(PORT_SETTINGS)};
  const handBuilt = { env: { PATH: process.env.PATH }, encoding: "utf8" };
  const envOf = (text) => Object.fromEntries(text.split("\\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  const settle = (call) => new Promise((resolve, reject) => call((error, stdout) => (error ? reject(error) : resolve(stdout))));
  out.handBuilt = {
    "spawnSync(cmd, args, { env })": JSON.parse(spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], handBuilt).stdout),
    // With no PATH the child would get the shell's default, which has no guard.
    "spawnSync(cmd, args, { env }) with no PATH": JSON.parse(spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { env: {}, encoding: "utf8" }).stdout),
    "spawnSync(cmd, undefined, { env })": envOf(spawnSync("/usr/bin/env", undefined, handBuilt).stdout),
    "execFileSync(cmd, null, { env })": envOf(execFileSync("/usr/bin/env", null, handBuilt)),
    "spawn(cmd, args, { env })": envOf(await collect(spawn("/usr/bin/env", [], { env: handBuilt.env }))),
    "execFile(cmd, args, { env }, cb)": envOf(await settle((cb) => execFile("/usr/bin/env", [], handBuilt, cb))),
    "exec(cmd, { env }, cb)": envOf(await settle((cb) => exec("/usr/bin/env", handBuilt, cb))),
    "execSync(cmd, { env })": envOf(execSync("/usr/bin/env", handBuilt)),
    "fork(module, args, { env })": JSON.parse(await collect(fork(join(scratch, "print-env.cjs"), [], { env: handBuilt.env, silent: true, execArgv: [] }))),
    // Unwrapped and with no preload, so only the ESM import of the helper can supply the settings.
    "an ESM test's spawnSync(cmd, args, { env })": JSON.parse(helper.original.execFileSync(process.execPath, [join(scratch, "esm-child.mjs")],
      { ...handBuilt, env: require(${JSON.stringify(SANDBOX_ENV)}).withSandbox(handBuilt.env) })),
  };
  // A test that passes an axi URL to a child on purpose keeps it there.
  out.childAxiUrl = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL))"],
    { env: { PATH: process.env.PATH, CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:9" }, encoding: "utf8" }).stdout;
  out.env = Object.fromEntries([...keys, ...${JSON.stringify(SCRATCH_SETTINGS)}, "AGENT_CHROME_TEST_SCRATCH", "PATH", "AGENT_CHROME_READY_TEST_KICKSTART",
    "CHROME_DEVTOOLS_AXI_BROWSER_URL", "CHROME_DEVTOOLS_AXI_AUTO_CONNECT", "CHROME_DEVTOOLS_AXI_MAIN_CHROME"].map((key) => [key, process.env[key]]));
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
})();
`;

function probeEachDefault(settings) {
  const cleared = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENT_CHROME_|CHROME_DEVTOOLS_AXI_)/.test(key)));
  Object.assign(cleared, settings);
  cleared.NODE_OPTIONS = (cleared.NODE_OPTIONS ?? "").replace(`--require ${JSON.stringify(HELPER)}`, "").trim();
  // A scratch HOME, so a default that falls back to ~/Library/pnpm/bin/chrome-devtools-axi finds nothing to run.
  cleared.HOME = fs.mkdtempSync(join(tmpdir(), "agent-chrome-probe-home-"));
  // The unwrapped execFileSync, so the env reaches the child as written.
  let out;
  try { out = JSON.parse(env.original.execFileSync(process.execPath, ["-e", PROBE], { env: cleared, encoding: "utf8", timeout: 60000 })); }
  finally { fs.rmSync(cleared.HOME, { recursive: true, force: true }); }
  const dead = String(env.DEAD_PORT);
  assert.ok(out.guarded, "tests/lib/agent-chrome-test-env.cjs must load tests/lib/live-port-guard.cjs");
  assert.equal(new URL(out.gateUrl).port, dead, `agent-chrome-session GATE_URL is ${out.gateUrl} with AGENT_CHROME_SESSION_TEST_GATE_URL unset. ${FIX}`);
  for (const [name, attempts] of Object.entries(out.steps)) {
    assert.ok(attempts.length > 0, `${name} tried no connection, so this check proves nothing about it. Fix its step in PROBE in tests/agent_chrome_test_env_test.cjs so it reaches the production default again.`);
    for (const { how, port, fix } of attempts) {
      if (fix) assert.fail(`${name} would ${how}. ${fix}`);
      assert.ok(!env.LIVE_PORTS.includes(port), `${name} would ${how} to the live port ${port} with its setting unset. ${FIX}`);
      assert.equal(port, env.DEAD_PORT, `${name} would ${how} to ${port}, not the dead port ${dead}. ${FIX}`);
    }
  }
  assert.equal(out.steps["chrome-devtools-axi probe"].length, 31, "chrome-devtools-axi must probe once, kickstart, then probe 30 more times; this check must reach its retry loop. If you changed the retry count in scripts/chrome-devtools-axi, update 31 here.");
  assert.match(out.axiTimeout, /did not come up on http:\/\/127\.0\.0\.1:9 within 15s/, `chrome-devtools-axi's timeout message must name the gate it probed, agent-chrome-session's GATE_URL; it printed: ${out.axiTimeout}`);
  for (const name of ["chrome-devtools-axi child", "chrome-devtools-axi child, nix's 9333 URL"]) {
    assert.equal(out.steps[name].length, 2, `${name}: axi did not start its (stubbed) child, so this check proves nothing about the URL and bridge port it hands the real binary. Fix the step in PROBE.`);
  }
  for (const file of out.axiBinaries) {
    assert.equal(file, out.env.CHROME_DEVTOOLS_AXI_TEST_BINARY, `scripts/chrome-devtools-axi would run ${file}, not the helper's stub. The real binary reuses its session's live bridge whatever CHROME_DEVTOOLS_AXI_PORT says; read CHROME_DEVTOOLS_AXI_TEST_BINARY first, and set it in SETTINGS in tests/lib/agent-chrome-test-env.cjs.`);
  }
  assert.equal(out.axiStub?.status, 1, "the helper's chrome-devtools-axi stub must exit 1; see CHROME_DEVTOOLS_AXI_TEST_BINARY in tests/lib/agent-chrome-test-env.cjs.");
  assert.equal(out.axiStub.stderr.trim(), env.AXI_REFUSAL, "the helper's chrome-devtools-axi stub must say why it refused.");
  assert.equal(out.steps["agent-chrome-ready"].length, 2, `agent-chrome-ready must curl once, run the kickstart hook, then curl again with retries; it made ${out.steps["agent-chrome-ready"].length} calls. Fix its step in PROBE.`);
  assert.equal(out.ready.kickstarts, 1, `agent-chrome-ready must run its test kickstart hook once, the one the helper sets with its test port; it ran ${out.ready.kickstarts} times.`);
  assert.equal(out.ready.status, 1, `agent-chrome-ready must exit 1 when its port never answers; it exited ${out.ready.status}: ${out.ready.stderr}`);
  assert.match(out.ready.stderr, new RegExp(`not up on 127\\.0\\.0\\.1:${dead} after`), `agent-chrome-ready must name the port it checked: ${out.ready.stderr}`);
  assert.ok(out.steps[DOCTOR].some(({ path }) => path === "/json/version"), `board.mjs doctor fetched no /json/version, so this check no longer sees its agent Chrome check. Fix the doctor step in PROBE in tests/agent_chrome_test_env_test.cjs.`);
  assert.match(out.boardDoctor, /^warn agent Chrome: 127\.0\.0\.1:9 does not answer;/m, `board.mjs doctor must name the gate it checked: ${out.boardDoctor}`);
  assert.match(out.boardMalformed, /^FAIL agent Chrome: AGENT_CHROME_SESSION_TEST_GATE_URL=9 is not a URL; unset it/m, `board.mjs doctor must fail its agent Chrome check, with the fix, on a malformed test gate URL: ${out.boardMalformed}`);
  assert.ok(!out.steps["verify-agent-board board.mjs doctor, malformed gate URL"].some(({ path }) => path === "/json/version"), "board.mjs doctor must not check the agent Chrome when the test gate URL is malformed.");
  assert.equal(out.boardRunsMalformed.status, 0, `a malformed test gate URL must only fail doctor's agent Chrome check, but board.mjs runs exited ${out.boardRunsMalformed.status}: ${out.boardRunsMalformed.stderr}`);
  assert.match(out.gateMain, new RegExp(`listening on 127\\.0\\.0\\.1:(?!(9333|9222|9334)\\b)\\d+, Chrome on ${dead}$`),
    `the agent-chrome-gate script started with "${out.gateMain}" with AGENT_CHROME_GATE_PORT and AGENT_CHROME_GATE_CHROME_PORT unset. ${FIX}`);
  const wheres = [["the test process", out.env], ...Object.entries(out.handBuilt).map(([shape, seen]) => [`a child given a hand-built env through ${shape}`, seen])];
  for (const [where, seen] of wheres) {
    const own = seen.AGENT_CHROME_TEST_SCRATCH ?? "";
    assert.ok(own, `AGENT_CHROME_TEST_SCRATCH is unset in ${where}; the helper must set it.`);
    for (const key of SCRATCH_SETTINGS) {
      assert.ok((seen[key] ?? "").startsWith(own + "/"), `${key} is ${seen[key]} in ${where}; it must sit in the test's scratch dir ${own}, or a test that relies on the helper sends the owner a real notice, writes real state or runs the real axi binary. ${FIX}`);
    }
    const dirs = (seen.PATH ?? "").split(":");
    const guard = dirs.indexOf(env.CURL_GUARD);
    const firstCurl = dirs.findIndex((dir) => dir !== env.CURL_GUARD && fs.existsSync(join(dir, "curl")));
    assert.ok(guard >= 0 && (firstCurl < 0 || guard < firstCurl), `PATH in ${where} must have the helper's curl guard before ${dirs[firstCurl]}, the first other dir with a curl, since curl is outside the node guards: ${seen.PATH}`);
  }
  for (const key of PORT_SETTINGS) {
    for (const [where, seen] of wheres) {
      const port = /^\d+$/.test(seen[key] ?? "") ? seen[key] : URL.parse(seen[key] ?? "")?.port;
      assert.ok(port === dead || (key === "AGENT_CHROME_GATE_PORT" && port === "0"), `${key} is ${seen[key]} in ${where}; it must default to the dead port ${dead}. ${FIX}`);
    }
  }
  assert.equal(out.env.AGENT_CHROME_READY_TEST_KICKSTART, "true", "agent-chrome-ready needs a kickstart hook with its test port, or it refuses; the helper must set a no-op one.");
  assert.equal(out.env.CHROME_DEVTOOLS_AXI_BROWSER_URL, undefined, "an inherited CHROME_DEVTOOLS_AXI_BROWSER_URL can point a test's axi at a live Chrome; the helper must drop it.");
  assert.equal(out.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT, undefined, "an inherited CHROME_DEVTOOLS_AXI_AUTO_CONNECT=1 points a test's axi at the owner's own Chrome; the helper must drop it.");
  assert.equal(out.env.CHROME_DEVTOOLS_AXI_MAIN_CHROME, undefined, "an inherited CHROME_DEVTOOLS_AXI_MAIN_CHROME=1 points a test's axi at the owner's own Chrome; the helper must drop it.");
  assert.equal(out.childAxiUrl, "http://127.0.0.1:9", "a child must keep a CHROME_DEVTOOLS_AXI_BROWSER_URL its test passed on purpose; the helper drops inherited ones only in the test process.");
  for (const [shape, seen] of Object.entries(out.handBuilt)) {
    assert.ok((seen.NODE_OPTIONS ?? "").includes(HELPER), `a child given a hand-built env through ${shape} must still preload tests/lib/agent-chrome-test-env.cjs.`);
  }
}

test("with every setting cleared, each production default resolves to a dead port", () => {
  // An agent shell can carry these; the helper must drop them. 9500 stands in for a live axi bridge.
  probeEachDefault({ CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:9222", CHROME_DEVTOOLS_AXI_MAIN_CHROME: "1", CHROME_DEVTOOLS_AXI_AUTO_CONNECT: "1", CHROME_DEVTOOLS_AXI_PORT: "9500" });
});

test("with every setting set to an empty string, each production default still resolves to a dead port", () => {
  // An empty export reads as unset in the scripts ("" || 9333), so the helper must fill it in.
  // The other scratch settings stay set: an empty AGENT_CHROME_STATE_HOME crashes the probe before it can name the setting.
  probeEachDefault(Object.fromEntries([...PORT_SETTINGS, "CHROME_DEVTOOLS_AXI_TEST_BINARY"].map((key) => [key, ""])));
});


test("a setting preset to a live port stops the test before anything runs", () => {
  for (const [key, value] of [["AGENT_CHROME_SESSION_TEST_GATE_URL", "http://127.0.0.1:9333"], ["AGENT_CHROME_SESSION_TEST_GATE_URL", "http://127.0.0.1:9333/"],
    ["AGENT_CHROME_GATE_CHROME_PORT", "9334"], ["AGENT_CHROME_READY_TEST_PORT", "9222"]]) {
    let failure;
    try { env.original.execFileSync(process.execPath, ["--require", HELPER, "-e", "process.stdout.write('ran')"], { env: withSandbox({ PATH: process.env.PATH, [key]: value }), encoding: "utf8", stdio: "pipe" }); }
    catch (error) { failure = error; }
    assert.ok(failure, `${key}=${value} ran: the helper let a live preset through; see livePort() in tests/lib/agent-chrome-test-env.cjs.`);
    assert.match(String(failure.stderr), new RegExp(`${key}=${value} is the live port`));
  }
});

test("an axi test binary inherited from the shell, or outside the temp dir, stops the test before anything runs", () => {
  const run = (extra, script = "process.stdout.write('ran')") => {
    try { return env.original.execFileSync(process.execPath, ["--require", HELPER, "-e", script], { env: withSandbox({ PATH: process.env.PATH, ...extra }), encoding: "utf8", stdio: "pipe" }); }
    catch (error) { return error; }
  };
  const inherited = run({ CHROME_DEVTOOLS_AXI_TEST_BINARY: join(tmpdir(), "chrome-devtools-axi") });
  assert.match(String(inherited.stderr), /an inherited CHROME_DEVTOOLS_AXI_TEST_BINARY=.* is outside this test's scratch dir/, "the helper kept an inherited axi binary; see AXI_STUB in tests/lib/agent-chrome-test-env.cjs.");
  // A test may hand a child its own stub, but never one outside the temp dir, where the real binary lives.
  const handed = run({}, `require("node:child_process").spawnSync(process.execPath, ["-e", ""], { env: { CHROME_DEVTOOLS_AXI_TEST_BINARY: "/nonexistent/Library/pnpm/bin/chrome-devtools-axi" } })`);
  assert.match(String(handed.stderr), /CHROME_DEVTOOLS_AXI_TEST_BINARY=\/nonexistent\/Library\/pnpm\/bin\/chrome-devtools-axi is outside/, "the helper let a test hand a child an axi binary outside the temp dir.");
  assert.equal(env.SETTINGS.CHROME_DEVTOOLS_AXI_TEST_BINARY, env.AXI_STUB, "the stub's path is AXI_STUB; the helper writes only there.");
});

test("the helper's curl guard refuses the live ports and hands every other call to the next curl on PATH", (t) => {
  // The only curl behind the guard is a recorder, so a guard that let a live port through records it and reaches nothing.
  const dir = fs.mkdtempSync(join(tmpdir(), "curl-guard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = join(dir, "calls");
  fs.mkdirSync(join(dir, "bin"));
  fs.writeFileSync(join(dir, "bin/curl"), `#!/bin/sh\necho "$* proxy=\${ALL_PROXY:-}\${all_proxy:-}\${HTTP_PROXY:-}\${http_proxy:-}\${HTTPS_PROXY:-}\${https_proxy:-}" >> '${calls}'\n`, { mode: 0o755 });
  fs.writeFileSync(join(dir, "config"), "url = http://127.0.0.1:9333/json/version\n");
  const curl = (args, extra = {}) => env.original.spawnSync(join(env.CURL_GUARD, "curl"), args, { env: { PATH: `${env.CURL_GUARD}:${join(dir, "bin")}`, ...extra }, encoding: "utf8", timeout: 60000 });
  const recorded = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "");
  // Each a way curl 8 connects to the port it names; the URL is never last, and the hosts vary.
  const refused = [
    ...env.LIVE_PORTS.map((port) => ["-sf", `http://127.0.0.1:${port}/json/version`, "-o", "/dev/null"]),
    ["-sf", "http://localhost:9222/json/version", "-o", "/dev/null"],
    ["-sf", "http://[::1]:9334/json/version", "-o", "/dev/null"],
    ["-sf", "http://127.0.0.1:09333/json/version", "-o", "/dev/null"],
    ["-sf", "http://127.0.0.1:93[33-33]/json/version", "-o", "/dev/null"],
    ["-sf", "http://127.0.0.1:{9333}/json/version", "-o", "/dev/null"],
    ["-sf", "--connect-to", "::127.0.0.1:9333", `http://127.0.0.1:${env.DEAD_PORT}/`],
    ["-sf", "-K", join(dir, "config"), "-o", "/dev/null"],
    ["-sfK", join(dir, "config"), "-o", "/dev/null"],
    ["-sf", "--config", join(dir, "config"), "-o", "/dev/null"],
    ["-sf", "--variable", "p=9333", "--expand-url", "http://127.0.0.1:{{p}}/json/version", "-o", "/dev/null"],
  ];
  for (const args of refused) {
    const result = curl(args);
    assert.equal(result.status, 7, `the curl guard let "curl ${args.join(" ")}" through; see tests/lib/curl-guard/curl.`);
    assert.match(result.stderr, /agent-chrome-test-env: refused curl/);
  }
  assert.equal(recorded(), "", "the curl guard handed a live-port call on");
  const dead = `http://127.0.0.1:${env.DEAD_PORT}/json/version`;
  assert.equal(curl(["-sf", dead], { ALL_PROXY: "http://127.0.0.1:9333", all_proxy: "x", HTTP_PROXY: "x", http_proxy: "x", HTTPS_PROXY: "x", https_proxy: "x" }).status, 0, "the curl guard must hand other calls to the next curl on PATH");
  assert.equal(recorded(), `-q -g -sf ${dead} proxy=\n`, "the guard must pass -q first (no ~/.curlrc) and -g (no globbing, which can hide a port), and drop the proxy variables, which can carry a call to a live port");
});

// Two guard copies on one PATH (two checkouts), or a fake curl that runs curl by name, used to exec each other forever.
test("the curl guard skips other guards and every curl it already ran, so it never loops", (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), "curl-guard-loop-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = join(dir, "calls");
  const guard = fs.readFileSync(join(env.CURL_GUARD, "curl"), "utf8");
  const bins = {
    same: guard, // another checkout at the same commit
    other: `${guard}# another checkout at another commit\n`,
    fake: `#!/bin/sh\necho "fake $*" >> '${calls}'\nexec curl "$@"\n`, // a test's fake curl that hands on by name
    real: `#!/bin/sh\necho "real $*" >> '${calls}'\necho "$AGENT_CHROME_CURL_GUARD_RAN" > '${join(dir, "ran")}'\n`,
  };
  for (const [name, text] of Object.entries(bins)) {
    fs.mkdirSync(join(dir, name));
    fs.writeFileSync(join(dir, name, "curl"), text, { mode: 0o755 });
  }
  const path = [env.CURL_GUARD, ...Object.keys(bins).map((name) => join(dir, name))].join(":");
  // Every curl here is a script that execs the next, so a loop keeps one pid; the kill is a hang bound only.
  const result = env.original.spawnSync(join(env.CURL_GUARD, "curl"), ["-sf", "http://127.0.0.1:9/"], { env: { PATH: path }, encoding: "utf8", timeout: 60_000 });
  assert.equal(result.signal, null, "the curl guards looped until killed");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(calls, "utf8"), "fake -q -g -sf http://127.0.0.1:9/\nreal -q -g -sf http://127.0.0.1:9/\n");
  const ran = fs.readFileSync(join(dir, "ran"), "utf8").trim().split(":");
  assert.ok(!ran.includes(join(dir, "same", "curl")), `a guard ran another copy of itself instead of skipping it: ${ran}`);
});
