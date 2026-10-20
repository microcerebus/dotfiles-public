// Replays the 2026-10-20 mistake against a throwaway headless Chromium, never
// the agent Chrome: a job-tracker verifier (pw-pr84) attached Playwright to
// 9333 with no notice and called browser.newContext() for each user, which
// opened windows on the owner's screen. Real playwright-core talks to the real gate.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const { homedir, tmpdir } = require("node:os");
const { join } = require("node:path");
const { promisify } = require("node:util");
const { setTimeout: sleep } = require("node:timers/promises");
const session = require("../scripts/agent-chrome-session");

const run = promisify(execFile);
const GATE = join(__dirname, "../scripts/agent-chrome-gate");
const HELPER = join(__dirname, "../scripts/agent-chrome-session");

// Any installed headless shell will do; Playwright bumps its build number.
function headlessShell() {
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  let builds = [];
  try { builds = fs.readdirSync(cache).filter((name) => /^chromium_headless_shell-\d+$/.test(name)); } catch { /* none */ }
  builds.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  return builds.map((name) => join(cache, name, "chrome-headless-shell-mac-arm64/chrome-headless-shell")).find((file) => fs.existsSync(file));
}

let playwrightDir;
try { playwrightDir = require("../scripts/agent-chrome-playwright").playwrightDirectory(); } catch { /* skipped below */ }
const SHELL = headlessShell();
// Without playwright-core there is nothing to replay with. With it, a missing
// shell fails the run instead of skipping it quietly.
const skip = playwrightDir ? false : "needs the pnpm global playwright-core";

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function answers(port) {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error(`nothing answers on ${port}`);
}

// Each gate has its own state and notices, so one gate's sweep never reports
// the other's sessions.
function sandbox(name) {
  const home = fs.mkdtempSync(join(tmpdir(), `agent-chrome-replay-${name}-`));
  const notices = join(home, "notices");
  return { home, notices, env: { ...process.env, [session.ENV]: "", AGENT_CHROME_STATE_HOME: home, AGENT_CHROME_SESSION_TEST_NOTIFY_LOG: notices, PLAYWRIGHT_CORE: playwrightDir } };
}
const strict = sandbox("strict");
const grace = sandbox("grace");
const control = sandbox("control");
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : []);
const children = [];
let chromePort;

before(async () => {
  if (skip) return;
  assert.ok(SHELL, "no chrome-headless-shell in ~/Library/Caches/ms-playwright; install one with playwright-core's install chromium-headless-shell");
  chromePort = await freePort();
  strict.port = await freePort();
  grace.port = await freePort();
  children.push(spawn(SHELL, [`--remote-debugging-port=${chromePort}`, `--user-data-dir=${join(control.home, "profile")}`, "--no-first-run", "about:blank"], { stdio: "ignore" }));
  await answers(chromePort);
  for (const [gate, graceUntil] of [[strict, 1], [grace, Date.now() + 3600000]]) {
    children.push(spawn(process.execPath, [GATE], { stdio: "ignore", env: { ...gate.env, AGENT_CHROME_GATE_PORT: String(gate.port), AGENT_CHROME_GATE_CHROME_PORT: String(chromePort),
      AGENT_CHROME_GATE_TEST_GRACE_UNTIL: String(graceUntil), AGENT_CHROME_GATE_TEST_SWEEP_MS: "100" } }));
    await answers(gate.port);
  }
});

after(() => { for (const child of children) child.kill("SIGKILL"); });

// The pw-pr84 shape: attach to the shared Chrome, then a new context per user.
const PR84 = `
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:" + process.argv[1]);
  try {
    const context = await browser.newContext();
    await context.newPage();
    console.log("opened a new context");
  } catch (error) {
    console.log("newContext: " + error.message);
  }
  const page = await browser.contexts()[0].newPage();
  await page.goto("data:text/html,<title>replay</title>");
  console.log("background tab: " + await page.title());
  await page.close();
  await browser.close();
})().catch((error) => { console.error(error.message); process.exit(1); });
`;

test("control: straight to Chrome, as 9333 is before the gate, the pw-pr84 shape opens a new context with no notice", { skip }, async () => {
  const { stdout } = await run(process.execPath, ["-e", PR84, String(chromePort)], { env: control.env });
  assert.match(stdout, /^opened a new context$/m);
  assert.deepEqual(lines(control.notices), []);
});

test("in the migration window the pw-pr84 shape gets through, the owner is told on its behalf before and after, and its new context is still refused", { skip }, async () => {
  const { stdout } = await run(process.execPath, ["-e", PR84, String(grace.port)], { env: grace.env });
  assert.match(stdout, /^newContext: [\s\S]*refused Target\.createBrowserContext/m);
  assert.match(stdout, /^background tab: replay$/m);
  assert.deepEqual(lines(grace.notices)[0], "node is using the agent Chrome without agent-chrome-session, so how long is unknown.");
  // The client has exited; the gate's next sweep says done.
  for (let i = 0; i < 50 && lines(grace.notices).length < 2; i += 1) await sleep(100);
  assert.match(lines(grace.notices)[1], /^node: finished after under a minute\. Done with the agent Chrome\.$/);
  assert.equal(lines(grace.notices).length, 2);
});

test("after the window the pw-pr84 shape without the helper is refused before it can open anything, and the error names the helper", { skip }, async () => {
  const result = await run(process.execPath, ["-e", PR84, String(strict.port)], { env: strict.env }).catch((error) => error);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /403 Forbidden[\s\S]*did not tell him[\s\S]*agent-chrome-session --minutes N --what/);
  assert.doesNotMatch(result.stdout, /opened a new context/);
  assert.deepEqual(lines(strict.notices), []);
});

test("through the helper it is announced, its new context is refused naming a headless launch, and its background tab works", { skip }, async () => {
  const { stdout } = await run(process.execPath, [HELPER, "--minutes", "2", "--what", "PR 84 hosted check replay", "--",
    process.execPath, "-e", PR84, String(strict.port)], { env: strict.env });
  assert.match(stdout, /^newContext: [\s\S]*refused Target\.createBrowserContext[\s\S]*chromium\.launch\(\{ headless: true \}\)/m);
  assert.match(stdout, /^background tab: replay$/m);
  assert.deepEqual(lines(strict.notices), [
    "PR 84 hosted check replay. About 2 min, background tabs only.",
    "PR 84 hosted check replay: finished after under a minute. Done with the agent Chrome.",
  ]);
});

async function until(check) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error("timed out waiting for the gate");
}

test("a code change keeps the gate up with a live CDP socket, then exits zero once it closes", { skip }, async (t) => {
  const state = sandbox("restart");
  const file = join(state.home, "agent-chrome-gate");
  fs.copyFileSync(GATE, file);
  fs.copyFileSync(HELPER, join(state.home, "agent-chrome-session"));
  const port = await freePort();
  let log = "";
  const child = spawn(process.execPath, [file], { stdio: ["ignore", "ignore", "pipe"], env: { ...state.env,
    AGENT_CHROME_GATE_PORT: String(port), AGENT_CHROME_GATE_CHROME_PORT: String(chromePort),
    AGENT_CHROME_GATE_TEST_GRACE_UNTIL: "1", AGENT_CHROME_GATE_TEST_WATCH_MS: "20" } });
  children.push(child);
  child.stderr.on("data", (chunk) => { log += chunk; });
  const gone = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(() => child.kill("SIGKILL"));
  await answers(port);
  await session.withSession({ minutes: 1, what: "restart replay" }, async () => {
    const browser = await require(playwrightDir).chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    t.after(() => browser.close());
    const cdp = await browser.newBrowserCDPSession();
    await sleep(100);
    fs.appendFileSync(file, "\n// Replay code change.\n");
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    await until(() => log.includes("its code changed"));
    await sleep(100);
    assert.equal(child.exitCode, null);
    assert.equal((await fetch(`http://127.0.0.1:${port}/json/version`)).status, 200);
    assert.ok((await cdp.send("Target.getTargets")).targetInfos.length > 0);
    await browser.close();
    await until(() => child.exitCode !== null || child.signalCode !== null);
    assert.deepEqual(await gone, { code: 0, signal: null });
  }, { dir: () => session.stateDir(state.home), now: Date.now, notify: async () => {}, log: () => {} });
});

test("the gate ends an adopted declaration and says done at the grace deadline while its client lives", { skip }, async (t) => {
  const state = sandbox("deadline");
  const port = await freePort();
  const notify = async (message) => fs.appendFileSync(state.notices, `${message}\n`);
  await session.adopt({ pid: process.pid, what: "deadline replay" }, { dir: () => session.stateDir(state.home), now: Date.now, notify, log: () => {} });
  const deadline = Date.now() + 1500;
  const child = spawn(process.execPath, [GATE], { stdio: "ignore", env: { ...state.env,
    AGENT_CHROME_GATE_PORT: String(port), AGENT_CHROME_GATE_CHROME_PORT: String(chromePort),
    AGENT_CHROME_GATE_TEST_GRACE_UNTIL: String(deadline), AGENT_CHROME_GATE_TEST_SWEEP_MS: "20" } });
  children.push(child);
  t.after(() => child.kill("SIGKILL"));
  await answers(port);
  const browser = await require(playwrightDir).chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  t.after(() => browser.close());
  assert.equal(lines(state.notices).length, 1);
  const disconnected = new Promise((resolve) => browser.once("disconnected", resolve));
  await until(() => lines(state.notices).length === 2);
  await disconnected;
  assert.ok(Date.now() >= deadline);
  assert.match(lines(state.notices)[1], /^deadline replay: finished after under a minute\. Done with the agent Chrome\.$/);
  assert.deepEqual(session.declarations(session.stateDir(state.home)), []);
});

test("the runner closes popups from a page the flow opens with context.newPage", { skip }, async () => {
  const { run: runFlow } = require("../scripts/agent-chrome-playwright");
  const logs = [];
  await runFlow(async (page) => {
    const extra = await page.context().newPage();
    try {
      await extra.goto("data:text/html,<title>extra flow page</title>");
      const opened = extra.waitForEvent("popup");
      await extra.evaluate(() => { window.open("about:blank#flow-popup"); });
      const popup = await opened;
      try {
        if (!popup.isClosed()) await popup.waitForEvent("close", { timeout: 1000 });
        assert.equal(popup.isClosed(), true);
        assert.equal(extra.isClosed(), false);
      } finally { await popup.close(); }
    } finally { await extra.close(); }
  }, {
    ready: () => true, identityError: () => null,
    connect: () => require(playwrightDir).chromium.connectOverCDP(`http://127.0.0.1:${chromePort}`),
    sleep, log: (message) => logs.push(message),
  });
  assert.equal(logs.length, 1);
});
