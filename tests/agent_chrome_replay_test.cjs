// Replays the 2026-10-20 mistake against a throwaway headless Chromium, never
// the agent Chrome: a job-tracker verifier (pw-pr84) attached Playwright to
// 9333 with no notice and called browser.newContext() for each user, which
// opened windows on the owner's screen. Real playwright-core talks to the real gate.
require("./lib/agent-chrome-test-env.cjs");
const { test, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const { homedir, tmpdir } = require("node:os");
const { join } = require("node:path");
const { promisify } = require("node:util");
const { setTimeout: sleep } = require("node:timers/promises");
const session = require("../scripts/agent-chrome-session");

// The running test's signal. node 22 aborts it when the test ends or times
// out, so a poll that sleeps on it, and a child run() starts, end with the
// test instead of keeping the file alive.
let current;
beforeEach((t) => { current = t.signal; });
const tick = (ms) => sleep(ms, undefined, { signal: current });
const run = (file, args, options) => promisify(execFile)(file, args, { ...options, signal: current });
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
// Chrome's own sandbox cannot start inside test-sandbox's, since macOS
// seatbelt sandboxes do not nest: its GPU process dies at once and Chrome
// exits ("GPU process isn't usable. Goodbye."). There the outer sandbox does
// the confining, so the shell runs without its own; elsewhere it keeps it.
function shellArgs(port, profile, env = process.env) {
  return [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", ...(env.TEST_SANDBOX ? ["--no-sandbox"] : []), "about:blank"];
}
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

// How long each started process gets to answer. Not a test's timeout: the
// file-level before() is a hook, and node:test gives hooks none by default.
// A timeout does not stop a poll either (node 22 aborts a test's signal when
// it times out, never a hook's), and a poll left running keeps the file
// alive for good. So the bound is generous, well above the slowest start
// under six parallel suites, but never absent.
const STARTUP_MS = Number(process.env.AGENT_CHROME_REPLAY_TEST_STARTUP_MS) || 60000;

// Every process the file starts. Each one's stderr goes to a file in its own
// sandbox, printed when a test fails or it never answers.
const children = [];
function start(name, home, file, args, env) {
  const log = join(home, `${name}.stderr`);
  const fd = fs.openSync(log, "a");
  const child = spawn(file, args, { stdio: ["ignore", "ignore", fd], env });
  fs.closeSync(fd);
  const exited = new AbortController();
  child.once("exit", (code, signal) => { child.status = signal ? `signal ${signal}` : `code ${code}`; exited.abort(); });
  const proc = { name, log, child, exited: exited.signal };
  children.push(proc);
  return proc;
}
const stderrOf = ({ name, log }) => `--- ${name} stderr (${log}) ---\n${fs.existsSync(log) ? fs.readFileSync(log, "utf8").slice(-4000) : ""}`;

// Fails at once if the process exits first, else at STARTUP_MS.
async function answers(port, proc) {
  const started = Date.now();
  const deadline = started + STARTUP_MS;
  let last = "none yet";
  for (;;) {
    if (proc.exited.aborted) throw new Error(`nothing answers on ${port}: ${proc.name} exited with ${proc.child.status} before it answered\n${stderrOf(proc)}`);
    if (Date.now() >= deadline) throw new Error(`nothing answers on ${port}: ${proc.name} did not answer within ${STARTUP_MS} ms (last try: ${last})\n${stderrOf(proc)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.any([AbortSignal.timeout(deadline - Date.now()), proc.exited]) });
      last = `HTTP ${response.status}`;
      await response.body?.cancel();
      if (response.ok) {
        process.stderr.write(`replay startup: ${proc.name} answered on ${port} in ${Date.now() - started} ms (bound ${STARTUP_MS} ms)\n`);
        return;
      }
    } catch (error) { last = error.cause?.code ?? error.name; }
    await sleep(100, undefined, { signal: proc.exited }).catch(() => {});
  }
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
let chromePort;

// Three starts in a row, each bounded by answers(); this is the backstop.
before(async () => {
  if (skip) return;
  assert.ok(SHELL, "no chrome-headless-shell in ~/Library/Caches/ms-playwright; install one with playwright-core's install chromium-headless-shell");
  chromePort = await freePort();
  strict.port = await freePort();
  grace.port = await freePort();
  await answers(chromePort, start("chrome-headless-shell", control.home, SHELL, shellArgs(chromePort, join(control.home, "profile"))));
  for (const [gate, graceUntil] of [[strict, 1], [grace, Date.now() + 3600000]]) {
    await answers(gate.port, start("agent-chrome-gate", gate.home, process.execPath, [GATE], { ...gate.env, AGENT_CHROME_GATE_PORT: String(gate.port), AGENT_CHROME_GATE_CHROME_PORT: String(chromePort),
      AGENT_CHROME_GATE_TEST_GRACE_UNTIL: String(graceUntil), AGENT_CHROME_GATE_TEST_SWEEP_MS: "100" }));
  }
}, { timeout: 3 * STARTUP_MS + 10000 });

const failed = [];
afterEach((t) => { if (!t.passed) failed.push(t.name); });

after(() => {
  for (const { child } of children) child.kill("SIGKILL");
  if (failed.length) process.stderr.write(`${failed.length} failed; the stderr of each process this file started:\n${children.map(stderrOf).join("\n")}\n`);
});

test("the headless shell drops Chrome's own sandbox only inside test-sandbox, and the one started here got those flags", { skip }, () => {
  assert.deepEqual(shellArgs(1, "profile", {}), ["--remote-debugging-port=1", "--user-data-dir=profile", "--no-first-run", "about:blank"]);
  assert.deepEqual(shellArgs(1, "profile", { TEST_SANDBOX: "/tmp/scratch" }), ["--remote-debugging-port=1", "--user-data-dir=profile", "--no-first-run", "--no-sandbox", "about:blank"]);
  const shell = children.find(({ name }) => name === "chrome-headless-shell");
  assert.deepEqual(shell.child.spawnargs.slice(1), shellArgs(chromePort, join(control.home, "profile")));
});

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

test("control: straight to Chrome, as 9333 is before the gate, the pw-pr84 shape opens a new context with no notice", { skip, timeout: 120000 }, async () => {
  const { stdout } = await run(process.execPath, ["-e", PR84, String(chromePort)], { env: control.env });
  assert.match(stdout, /^opened a new context$/m);
  assert.deepEqual(lines(control.notices), []);
});

test("in the migration window the pw-pr84 shape gets through, the owner is told on its behalf before and after, and its new context is still refused", { skip, timeout: 120000 }, async () => {
  const { stdout } = await run(process.execPath, ["-e", PR84, String(grace.port)], { env: grace.env });
  assert.match(stdout, /^newContext: [\s\S]*refused Target\.createBrowserContext/m);
  assert.match(stdout, /^background tab: replay$/m);
  assert.deepEqual(lines(grace.notices)[0], "node is using the agent Chrome without agent-chrome-session, so how long is unknown.");
  // The client has exited; the gate's next sweep says done.
  while (lines(grace.notices).length < 2) await tick(100);
  assert.match(lines(grace.notices)[1], /^node: finished after under a minute\. Done with the agent Chrome\.$/);
  assert.equal(lines(grace.notices).length, 2);
});

test("after the window the pw-pr84 shape without the helper is refused before it can open anything, and the error names the helper", { skip, timeout: 120000 }, async () => {
  const result = await run(process.execPath, ["-e", PR84, String(strict.port)], { env: strict.env }).catch((error) => error);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /403 Forbidden[\s\S]*did not tell him[\s\S]*agent-chrome-session --minutes N --what/);
  assert.doesNotMatch(result.stdout, /opened a new context/);
  assert.deepEqual(lines(strict.notices), []);
});

test("through the helper it is announced, its new context is refused naming a headless launch, and its background tab works", { skip, timeout: 120000 }, async () => {
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
  while (!check()) await tick(50);
}

test("a code change keeps the gate up with a live CDP socket, then exits zero once it closes", { skip, timeout: 120000 }, async (t) => {
  const state = sandbox("restart");
  const file = join(state.home, "agent-chrome-gate");
  fs.copyFileSync(GATE, file);
  fs.copyFileSync(HELPER, join(state.home, "agent-chrome-session"));
  const port = await freePort();
  const gate = start("agent-chrome-gate", state.home, process.execPath, [file], { ...state.env,
    AGENT_CHROME_GATE_PORT: String(port), AGENT_CHROME_GATE_CHROME_PORT: String(chromePort),
    AGENT_CHROME_GATE_TEST_GRACE_UNTIL: "1", AGENT_CHROME_GATE_TEST_WATCH_MS: "20" });
  const { child } = gate;
  const gone = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(() => child.kill("SIGKILL"));
  await answers(port, gate);
  await session.withSession({ minutes: 1, what: "restart replay" }, async () => {
    const browser = await require(playwrightDir).chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    t.after(() => browser.close());
    const cdp = await browser.newBrowserCDPSession();
    await sleep(100);
    fs.appendFileSync(file, "\n// Replay code change.\n");
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    await until(() => fs.readFileSync(gate.log, "utf8").includes("its code changed"));
    await sleep(100);
    assert.equal(child.exitCode, null);
    assert.equal((await fetch(`http://127.0.0.1:${port}/json/version`)).status, 200);
    assert.ok((await cdp.send("Target.getTargets")).targetInfos.length > 0);
    await browser.close();
    await until(() => child.exitCode !== null || child.signalCode !== null);
    assert.deepEqual(await gone, { code: 0, signal: null });
  }, { dir: () => session.stateDir(state.home), now: Date.now, notify: async () => {}, log: () => {} });
});

test("the gate ends an adopted declaration and says done at the grace deadline while its client lives", { skip, timeout: 120000 }, async (t) => {
  const state = sandbox("deadline");
  const port = await freePort();
  const notify = async (message) => fs.appendFileSync(state.notices, `${message}\n`);
  await session.adopt({ pid: process.pid, what: "deadline replay" }, { dir: () => session.stateDir(state.home), now: Date.now, notify, log: () => {} });
  const deadline = Date.now() + 1500;
  const gate = start("agent-chrome-gate", state.home, process.execPath, [GATE], { ...state.env,
    AGENT_CHROME_GATE_PORT: String(port), AGENT_CHROME_GATE_CHROME_PORT: String(chromePort),
    AGENT_CHROME_GATE_TEST_GRACE_UNTIL: String(deadline), AGENT_CHROME_GATE_TEST_SWEEP_MS: "20" });
  t.after(() => gate.child.kill("SIGKILL"));
  await answers(port, gate);
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

test("the runner closes popups from a page the flow opens with context.newPage", { skip, timeout: 120000 }, async () => {
  const { run: runFlow, openBackgroundTab } = require("../scripts/agent-chrome-playwright");
  const logs = [];
  await runFlow(async (page) => {
    const extra = await page.context().newPage();
    try {
      await extra.goto("data:text/html,<title>extra flow page</title>");
      const opened = extra.waitForEvent("popup");
      await extra.evaluate(() => { window.open("about:blank#flow-popup"); });
      const popup = await opened;
      try {
        if (!popup.isClosed()) await popup.waitForEvent("close", { timeout: 60000 });
        assert.equal(popup.isClosed(), true);
        assert.equal(extra.isClosed(), false);
      } finally { await popup.close(); }
    } finally { await extra.close(); }
  }, {
    ready: () => true, identityError: () => null,
    openTab: (marker) => openBackgroundTab(marker, `http://127.0.0.1:${chromePort}`),
    connect: () => require(playwrightDir).chromium.connectOverCDP(`http://127.0.0.1:${chromePort}`),
    sleep, log: (message) => logs.push(message),
  });
  assert.equal(logs.length, 1);
});

test("through the gate and the helper, the runner's own CDP connection opens its background tab, and the runner closes only that tab", { skip, timeout: 120000 }, async () => {
  const flow = `
    const { run, openBackgroundTab } = require(${JSON.stringify(require.resolve("../scripts/agent-chrome-playwright"))});
    const { chromium } = require(process.env.PLAYWRIGHT_CORE);
    const url = "http://127.0.0.1:" + process.argv[1];
    run(async (page) => {
      await page.goto("data:text/html,<title>runner replay</title>");
      console.log("title: " + await page.title());
    }, {
      ready: () => true, identityError: () => null,
      openTab: (marker) => openBackgroundTab(marker, url),
      connect: () => chromium.connectOverCDP(url),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log: () => {},
    }).catch((error) => { console.error(error.message); process.exit(1); });
  `;
  const before = (await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json()).filter((target) => target.type === "page").map((target) => target.id);
  const { stdout } = await run(process.execPath, [HELPER, "--minutes", "1", "--what", "runner replay", "--",
    process.execPath, "-e", flow, String(strict.port)], { env: strict.env });
  assert.match(stdout, /^title: runner replay$/m);
  const after = (await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json()).filter((target) => target.type === "page").map((target) => target.id);
  assert.deepEqual(after.sort(), before.sort());
});

// Follow-up of playwright-session-signals review r2: a client killed right
// after it asked for a tab left that tab open in the shared Chrome for good.
const KILLED = `
const marker = process.argv[2];
(async () => {
  const { webSocketDebuggerUrl } = await (await fetch("http://127.0.0.1:" + process.argv[1] + "/json/version")).json();
  const socket = new WebSocket(webSocketDebuggerUrl);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: marker, background: true } }));
    socket.addEventListener("message", () => process.kill(process.pid, "SIGKILL"));
  });
})();
`;

test("a client SIGKILLed after opening a tab leaves no tab once its session ends", { skip, timeout: 120000 }, async () => {
  const marker = `about:blank#killed-${process.pid}`;
  const open = async () => (await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json()).filter(({ url }) => url === marker);
  const result = await run(process.execPath, [HELPER, "--minutes", "1", "--what", "killed client replay", "--",
    process.execPath, "-e", KILLED, String(strict.port), marker], { env: strict.env }).catch((error) => error);
  assert.equal(result.code, 137);
  assert.ok(lines(strict.notices).some((line) => /^killed client replay: stopped after/.test(line)));
  while ((await open()).length) await tick(100);
  assert.deepEqual(await open(), []);
});

// Review r1 of agent-chrome-session-orphans: apply workers leave review tabs
// open for the owner (their helper opens one with a raw Target.createTarget, then
// navigates it), and the gate closed them when the session ended.
const pageUrls = async () => (await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json()).filter(({ type }) => type === "page").map(({ id, url }) => ({ id, url }));
const keptRecords = () => {
  try { return JSON.parse(fs.readFileSync(session.tabsFile(session.stateDir(strict.home)), "utf8")).kept; } catch { return []; }
};

async function settled(tag, expected) {
  const tagged = async () => (await pageUrls()).filter(({ url }) => url.includes(tag));
  while ((await tagged()).length !== expected) await tick(100);
  // A few more sweeps: a kept tab must stay, not just outlast the first one.
  await sleep(500);
  return tagged();
}

test("a flow keeps a tab opened the apply way; the gate closes its sibling and the runner's tab, and leaves the kept one", { skip, timeout: 120000 }, async () => {
  const tag = `apply-${process.pid}`;
  const flow = `
    const { run, openBackgroundTab, targetIdOf } = require(${JSON.stringify(require.resolve("../scripts/agent-chrome-playwright"))});
    const session = require(${JSON.stringify(HELPER)});
    const { chromium } = require(process.env.PLAYWRIGHT_CORE);
    const url = "http://127.0.0.1:" + process.argv[1];
    const tag = process.argv[2];
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    run(async (page, { keep }) => {
      const context = page.context();
      const cdp = await context.browser().newBrowserCDPSession();
      const marker = "about:blank#" + tag + "-kept";
      await cdp.send("Target.createTarget", { url: marker, background: true });
      let tab;
      while (!tab) { tab = context.pages().find((candidate) => candidate.url() === marker); if (!tab) await sleep(50); }
      await tab.goto("data:text/html,<title>" + tag + "-kept</title>");
      const sibling = await context.newPage();
      await sibling.goto("data:text/html,<title>" + tag + "-sibling</title>");
      await keep(tab, "form for the owner to review");
      console.log("kept");
    }, {
      ready: () => true, identityError: () => null,
      openTab: (marker) => openBackgroundTab(marker, url),
      connect: () => chromium.connectOverCDP(url),
      targetId: targetIdOf,
      keepTab: (targetId, why) => session.keepTab(targetId, why, url),
      sleep, log: () => {},
    }).catch((error) => { console.error(error.message); process.exit(1); });
  `;
  const before = (await pageUrls()).map(({ id }) => id);
  const { stdout } = await run(process.execPath, [HELPER, "--minutes", "1", "--what", "apply replay", "--",
    process.execPath, "-e", flow, String(strict.port), tag], { env: strict.env });
  assert.match(stdout, /^kept$/m);
  const left = await settled(tag, 1);
  assert.equal(left.length, 1);
  assert.match(decodeURIComponent(left[0].url), /-kept<\/title>$/);
  assert.deepEqual((await pageUrls()).map(({ id }) => id).filter((id) => !before.includes(id)), [left[0].id], "the runner's own tab and the sibling are closed");
  assert.ok(lines(strict.notices).some((line) => /^apply replay: finished after .*, and left 1 tab open for you\.$/.test(line)));
  assert.deepEqual(keptRecords().filter(({ targetId }) => targetId === left[0].id).map(({ what }) => what), ["form for the owner to review"]);
  // the owner closes it; the gate forgets it.
  await fetch(`http://127.0.0.1:${chromePort}/json/close/${left[0].id}`);
  while (keptRecords().some(({ targetId }) => targetId === left[0].id)) await tick(100);
  assert.equal(keptRecords().some(({ targetId }) => targetId === left[0].id), false);
});

// A raw-CDP script keeps one tab with the CLI and one with the fetch line
// documented in agent-chrome-session, and leaves a third.
const RAW_KEEP = `
const { execFileSync } = require("node:child_process");
const [port, tag, helper] = process.argv.slice(1);
(async () => {
  const { webSocketDebuggerUrl } = await (await fetch("http://127.0.0.1:" + port + "/json/version")).json();
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  const replies = new Map();
  let id = 0;
  socket.addEventListener("message", (event) => { const message = JSON.parse(event.data); replies.get(message.id)?.(message); });
  const create = (url) => new Promise((resolve) => {
    id += 1;
    replies.set(id, (message) => resolve(message.result.targetId));
    socket.send(JSON.stringify({ id, method: "Target.createTarget", params: { url, background: true } }));
  });
  const cliTab = await create("about:blank#" + tag + "-cli");
  const targetId = await create("about:blank#" + tag + "-fetch");
  await create("about:blank#" + tag + "-sibling");
  console.log(execFileSync(process.execPath, [helper, "keep", "--what", "sign-in for the owner", cliTab], { encoding: "utf8" }).trim());
  const kept = await fetch(\`http://127.0.0.1:\${port}/agent-chrome/keep/\${targetId}?what=\${encodeURIComponent("form for the owner to review")}\`, { method: "PUT" });
  if (!kept.ok && kept.status !== 404) throw new Error(\`keep refused (\${kept.status}): \${await kept.text()}\`);
  try { execFileSync(process.execPath, [helper, "keep", "--what", "not mine", "no-such-tab"], { stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { console.log("refused: " + error.stderr.toString().trim()); }
  socket.close();
  process.exit(0);
})().catch((error) => { console.error(error.message); process.exit(1); });
`;

test("a raw-CDP script keeps tabs with agent-chrome-session keep and the documented fetch, and the gate closes the rest", { skip, timeout: 120000 }, async () => {
  const tag = `raw-${process.pid}`;
  const { stdout } = await run(process.execPath, [HELPER, "--minutes", "1", "--what", "raw keep replay", "--",
    process.execPath, "-e", RAW_KEEP, String(strict.port), tag, HELPER], { env: { ...strict.env, AGENT_CHROME_SESSION_TEST_GATE_URL: `http://127.0.0.1:${strict.port}` } });
  assert.match(stdout, /^kept \S+: the gate leaves it open after "raw keep replay" ends\.$/m);
  assert.match(stdout, /^refused: agent-chrome-session: agent-chrome-gate: refused to keep tab no-such-tab .*may keep only a tab it opened itself/m);
  const left = (await settled(tag, 2)).map(({ url }) => url.slice(url.indexOf("#") + 1)).sort();
  assert.deepEqual(left, [`${tag}-cli`, `${tag}-fetch`]);
  assert.ok(lines(strict.notices).some((line) => /^raw keep replay: finished after .*, and left 2 tabs open for you\.$/.test(line)));
  for (const { id, url } of await pageUrls()) if (url.includes(tag)) await fetch(`http://127.0.0.1:${chromePort}/json/close/${id}`);
});
