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
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const env = require("./lib/agent-chrome-test-env.cjs");

const HELPER = join(__dirname, "lib/agent-chrome-test-env.cjs");
const REPO = join(__dirname, "..");
const SCRIPTS = join(REPO, "scripts");
const BOARD = join(REPO, ".claude/skills/verify-agent-board/scripts/board.mjs");
// Bare names, so a test that builds the path with join(REPO, "scripts", name) still counts.
const NAMES_A_SCRIPT = /\b(agent-chrome-(session|gate|playwright|ready)|chrome-devtools-axi|verify-agent-board)\b/;
// What the scripts read, listed here rather than taken from the helper, so a
// setting dropped from the helper is still checked.
const PORT_SETTINGS = ["AGENT_CHROME_SESSION_TEST_GATE_URL", "AGENT_CHROME_GATE_PORT", "AGENT_CHROME_GATE_CHROME_PORT", "AGENT_CHROME_READY_TEST_PORT", "CHROME_DEVTOOLS_AXI_PORT"];
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
  // The agent Chrome answers: record the browser URL and bridge port axi hands the real binary (stubbed, never run).
  await step("chrome-devtools-axi child", () => axi.run(["snapshot"], process.env, { ...axi.defaultDeps, fallbackUntil: () => Date.now() / 1000 + 3600,
    probe: () => true, browserCommandLines: () => ["chrome --disable-extensions --disable-sync"], lease: () => {}, endLease: () => {},
    spawn: (file, args, options) => {
      seen.push({ how: "hand the real binary CHROME_DEVTOOLS_AXI_BROWSER_URL", port: Number(URL.parse(options.env.CHROME_DEVTOOLS_AXI_BROWSER_URL ?? "")?.port) });
      seen.push({ how: "start the real binary's bridge on CHROME_DEVTOOLS_AXI_PORT", port: Number(options.env.CHROME_DEVTOOLS_AXI_PORT) });
      return { status: 0 };
    } }, { stderr: { write: () => {} } }));
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
    "spawnSync(cmd, undefined, { env })": envOf(spawnSync("/usr/bin/env", undefined, handBuilt).stdout),
    "execFileSync(cmd, null, { env })": envOf(execFileSync("/usr/bin/env", null, handBuilt)),
    "spawn(cmd, args, { env })": envOf(await collect(spawn("/usr/bin/env", [], { env: handBuilt.env }))),
    "execFile(cmd, args, { env }, cb)": envOf(await settle((cb) => execFile("/usr/bin/env", [], handBuilt, cb))),
    "exec(cmd, { env }, cb)": envOf(await settle((cb) => exec("/usr/bin/env", handBuilt, cb))),
    "execSync(cmd, { env })": envOf(execSync("/usr/bin/env", handBuilt)),
    "fork(module, args, { env })": JSON.parse(await collect(fork(join(scratch, "print-env.cjs"), [], { env: handBuilt.env, silent: true, execArgv: [] }))),
    // Unwrapped and with no preload, so only the ESM import of the helper can supply the settings.
    "an ESM test's spawnSync(cmd, args, { env })": JSON.parse(helper.original.execFileSync(process.execPath, [join(scratch, "esm-child.mjs")], handBuilt)),
  };
  // A test that passes an axi URL to a child on purpose keeps it there.
  out.childAxiUrl = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL))"],
    { env: { PATH: process.env.PATH, CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:9" }, encoding: "utf8" }).stdout;
  out.env = Object.fromEntries([...keys, "AGENT_CHROME_READY_TEST_KICKSTART", "CHROME_DEVTOOLS_AXI_BROWSER_URL", "CHROME_DEVTOOLS_AXI_MAIN_CHROME"].map((key) => [key, process.env[key]]));
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
})();
`;

function probeEachDefault(settings) {
  const cleared = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENT_CHROME_|CHROME_DEVTOOLS_AXI_)/.test(key)));
  Object.assign(cleared, settings);
  cleared.NODE_OPTIONS = (cleared.NODE_OPTIONS ?? "").replace(`--require ${JSON.stringify(HELPER)}`, "").trim();
  // The unwrapped execFileSync, so the env reaches the child as written.
  const out = JSON.parse(env.original.execFileSync(process.execPath, ["-e", PROBE], { env: cleared, encoding: "utf8", timeout: 60000 }));
  const dead = String(env.DEAD_PORT);
  assert.ok(out.guarded, "tests/lib/agent-chrome-test-env.cjs must load tests/lib/live-port-guard.cjs");
  assert.equal(new URL(out.gateUrl).port, dead, `agent-chrome-session GATE_URL is ${out.gateUrl} with AGENT_CHROME_SESSION_TEST_GATE_URL unset. ${FIX}`);
  for (const [name, attempts] of Object.entries(out.steps)) {
    assert.ok(attempts.length > 0, `${name} tried no connection, so this check proves nothing about it. Fix its step in PROBE in tests/agent_chrome_test_env_test.cjs so it reaches the production default again.`);
    for (const { how, port } of attempts) {
      assert.ok(!env.LIVE_PORTS.includes(port), `${name} would ${how} to the live port ${port} with its setting unset. ${FIX}`);
      assert.equal(port, env.DEAD_PORT, `${name} would ${how} to ${port}, not the dead port ${dead}. ${FIX}`);
    }
  }
  assert.equal(out.steps["chrome-devtools-axi probe"].length, 31, "chrome-devtools-axi must probe once, kickstart, then probe 30 more times; this check must reach its retry loop. If you changed the retry count in scripts/chrome-devtools-axi, update 31 here.");
  assert.match(out.axiTimeout, /did not come up on http:\/\/127\.0\.0\.1:9 within 15s/, `chrome-devtools-axi's timeout message must name the gate it probed, agent-chrome-session's GATE_URL; it printed: ${out.axiTimeout}`);
  assert.equal(out.steps["chrome-devtools-axi child"].length, 2, "chrome-devtools-axi did not start its (stubbed) child, so this check proves nothing about the URL and bridge port it hands the real binary. Fix the step in PROBE.");
  assert.ok(out.steps[DOCTOR].some(({ path }) => path === "/json/version"), `board.mjs doctor fetched no /json/version, so this check no longer sees its agent Chrome check. Fix the doctor step in PROBE in tests/agent_chrome_test_env_test.cjs.`);
  assert.match(out.boardDoctor, /^warn agent Chrome: 127\.0\.0\.1:9 does not answer;/m, `board.mjs doctor must name the gate it checked: ${out.boardDoctor}`);
  assert.match(out.boardMalformed, /^FAIL agent Chrome: AGENT_CHROME_SESSION_TEST_GATE_URL=9 is not a URL; unset it/m, `board.mjs doctor must fail its agent Chrome check, with the fix, on a malformed test gate URL: ${out.boardMalformed}`);
  assert.ok(!out.steps["verify-agent-board board.mjs doctor, malformed gate URL"].some(({ path }) => path === "/json/version"), "board.mjs doctor must not check the agent Chrome when the test gate URL is malformed.");
  assert.equal(out.boardRunsMalformed.status, 0, `a malformed test gate URL must only fail doctor's agent Chrome check, but board.mjs runs exited ${out.boardRunsMalformed.status}: ${out.boardRunsMalformed.stderr}`);
  assert.match(out.gateMain, new RegExp(`listening on 127\\.0\\.0\\.1:(?!(9333|9222|9334)\\b)\\d+, Chrome on ${dead}$`),
    `the agent-chrome-gate script started with "${out.gateMain}" with AGENT_CHROME_GATE_PORT and AGENT_CHROME_GATE_CHROME_PORT unset. ${FIX}`);
  const wheres = [["the test process", out.env], ...Object.entries(out.handBuilt).map(([shape, seen]) => [`a child given a hand-built env through ${shape}`, seen])];
  for (const key of PORT_SETTINGS) {
    for (const [where, seen] of wheres) {
      const port = /^\d+$/.test(seen[key] ?? "") ? seen[key] : URL.parse(seen[key] ?? "")?.port;
      assert.ok(port === dead || (key === "AGENT_CHROME_GATE_PORT" && port === "0"), `${key} is ${seen[key]} in ${where}; it must default to the dead port ${dead}. ${FIX}`);
    }
  }
  assert.equal(out.env.AGENT_CHROME_READY_TEST_KICKSTART, "true", "agent-chrome-ready needs a kickstart hook with its test port, or it refuses; the helper must set a no-op one.");
  assert.equal(out.env.CHROME_DEVTOOLS_AXI_BROWSER_URL, undefined, "an inherited CHROME_DEVTOOLS_AXI_BROWSER_URL can point a test's axi at a live Chrome; the helper must drop it.");
  assert.equal(out.env.CHROME_DEVTOOLS_AXI_MAIN_CHROME, undefined, "an inherited CHROME_DEVTOOLS_AXI_MAIN_CHROME=1 points a test's axi at the owner's own Chrome; the helper must drop it.");
  assert.equal(out.childAxiUrl, "http://127.0.0.1:9", "a child must keep a CHROME_DEVTOOLS_AXI_BROWSER_URL its test passed on purpose; the helper drops inherited ones only in the test process.");
  for (const [shape, seen] of Object.entries(out.handBuilt)) {
    assert.ok((seen.NODE_OPTIONS ?? "").includes(HELPER), `a child given a hand-built env through ${shape} must still preload tests/lib/agent-chrome-test-env.cjs.`);
  }
}

test("with every setting cleared, each production default resolves to a dead port", () => {
  // An agent shell can carry these; the helper must drop them. 9500 stands in for a live axi bridge.
  probeEachDefault({ CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:9222", CHROME_DEVTOOLS_AXI_MAIN_CHROME: "1", CHROME_DEVTOOLS_AXI_PORT: "9500" });
});

test("with every setting set to an empty string, each production default still resolves to a dead port", () => {
  // An empty export reads as unset in the scripts ("" || 9333), so the helper must fill it in.
  probeEachDefault(Object.fromEntries(PORT_SETTINGS.map((key) => [key, ""])));
});


test("a setting preset to a live port stops the test before anything runs", () => {
  for (const [key, value] of [["AGENT_CHROME_SESSION_TEST_GATE_URL", "http://127.0.0.1:9333"], ["AGENT_CHROME_GATE_CHROME_PORT", "9334"], ["AGENT_CHROME_READY_TEST_PORT", "9222"]]) {
    let failure;
    try { env.original.execFileSync(process.execPath, ["--require", HELPER, "-e", "process.stdout.write('ran')"], { env: { PATH: process.env.PATH, [key]: value }, encoding: "utf8", stdio: "pipe" }); }
    catch (error) { failure = error; }
    assert.ok(failure, `${key}=${value} ran`);
    assert.match(String(failure.stderr), new RegExp(`${key}=${value} is the live port`));
  }
});
