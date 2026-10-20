const { test } = require("node:test");
const assert = require("node:assert/strict");
const { run } = require("../scripts/agent-chrome-playwright");

function harness({ ready = true, identityError = null, attach = true } = {}) {
  const calls = [];
  let marker;
  const listeners = {};
  const page = { url: () => marker, on: (event, listener) => { listeners[event] = listener; }, emit: (event, value) => listeners[event]?.(value) };
  const session = { send: async (method, args) => {
    calls.push([method, args]);
    if (method === "Target.createTarget") { marker = args.url; return { targetId: "own-target" }; }
  } };
  const deps = {
    ready: () => { calls.push("ready"); return ready; },
    identityError: () => identityError,
    connect: async () => {
      calls.push("connect");
      return {
        contexts: () => [{ pages: () => attach ? [{ url: () => "https://other-tab.example" }, page] : [] }],
        newBrowserCDPSession: async () => session,
        close: async () => { calls.push("disconnect"); },
      };
    },
    sleep: async () => {},
    log: (message) => calls.push(["log", message]),
  };
  return { calls, page, deps };
}

test("a written flow gets only its own background tab and closes that target before disconnecting", async () => {
  const { calls, page, deps } = harness();
  assert.equal(await run(async (actual) => { assert.equal(actual, page); return "read"; }, deps), "read");
  assert.deepEqual(calls.slice(0, 2), ["ready", "connect"]);
  assert.equal(calls[2][0], "Target.createTarget");
  assert.equal(calls[2][1].background, true);
  assert.deepEqual(calls.slice(-2), [["Target.closeTarget", { targetId: "own-target" }], "disconnect"]);
});

test("failed flows and attachment timeouts still clean up only the owned tab", async () => {
  for (const attach of [true, false]) {
    const { calls, deps } = harness({ attach });
    await assert.rejects(run(async () => { throw new Error("failed flow"); }, deps), attach ? /failed flow/ : /did not attach/);
    assert.deepEqual(calls.slice(-2), [["Target.closeTarget", { targetId: "own-target" }], "disconnect"]);
  }
});

test("Chrome readiness and application identity failures refuse before connecting", async () => {
  for (const options of [{ ready: false }, { identityError: "not Google Chrome Beta with safe flags" }]) {
    const { calls, deps } = harness(options);
    await assert.rejects(run(async () => assert.fail("must not drive"), deps));
    assert.deepEqual(calls, ["ready"]);
  }
});

test("the CLI takes what and how long for the notice, and old calls with only the flow still run", () => {
  const { parseArgs } = require("../scripts/agent-chrome-playwright");
  assert.deepEqual(parseArgs(["--minutes", "2", "--what", "Reading WhatsApp Web", "read.cjs"]),
    { minutes: 2, what: "Reading WhatsApp Web", file: "read.cjs", keepPopups: false, missing: [] });
  assert.deepEqual(parseArgs(["/tmp/flows/board.cjs"]),
    { minutes: 5, what: "Playwright flow board.cjs", file: "/tmp/flows/board.cjs", keepPopups: false, missing: ["--minutes", "--what"] });
  assert.equal(parseArgs(["--keep-popups", "a.cjs"]).keepPopups, true);
  assert.throws(() => parseArgs([]), /Usage: agent-chrome-playwright/);
  assert.throws(() => parseArgs(["a.cjs", "b.cjs"]), /Usage: agent-chrome-playwright/);
});

test("a popup the flow opens is closed at once and the flow is told why, unless it keeps popups", async () => {
  for (const keepPopups of [false, true]) {
    const { calls, page, deps } = harness();
    let closed = 0;
    await run(async () => { page.emit("popup", { close: async () => { closed += 1; } }); }, { ...deps, keepPopups });
    assert.equal(closed, keepPopups ? 0 : 1);
    const logs = calls.filter((call) => call[0] === "log");
    assert.equal(logs.length, keepPopups ? 0 : 1);
    if (!keepPopups) assert.match(logs[0][1], /front of the owner's screen[\s\S]*page\.goto[\s\S]*--keep-popups/);
  }
});

test("stopping a run closes the flow's own tab once, which ends the flow", async () => {
  const { calls, deps } = harness();
  const stopping = new AbortController();
  await assert.rejects(run(async () => {
    stopping.abort();
    await new Promise((resolve) => setImmediate(resolve));
    throw new Error("Target page, context or browser has been closed");
  }, { ...deps, signal: stopping.signal }), /has been closed/);
  assert.deepEqual(calls.filter((call) => call[0] === "Target.closeTarget"), [["Target.closeTarget", { targetId: "own-target" }]]);
  assert.equal(calls.at(-1), "disconnect");
  const early = harness();
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(run(async () => assert.fail("must not run"), { ...early.deps, signal: aborted.signal }), /Stopped before/);
  assert.deepEqual(early.calls, []);
});

test("a stop during the start notice skips readiness and reports stopped", async () => {
  const session = require("../scripts/agent-chrome-session");
  const fs = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const home = fs.mkdtempSync(join(tmpdir(), "agent-chrome-playwright-"));
  const { calls, deps } = harness();
  const stopping = new AbortController();
  const notices = [];
  await assert.rejects(session.withSession({ minutes: 1, what: "flow" },
    () => run(async () => assert.fail("must not run"), { ...deps, signal: stopping.signal }), {
      dir: () => session.stateDir(home), now: Date.now, log: () => {},
      notify: async (message) => { notices.push(message); if (notices.length === 1) stopping.abort(); },
    }), /Stopped before/);
  assert.deepEqual(calls, []);
  assert.match(notices[1], /^flow: stopped after/);
});

test("a stop during blocking readiness opens no tab and reports stopped", async (t) => {
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const { setTimeout: sleep } = require("node:timers/promises");
  const home = fs.mkdtempSync(join(tmpdir(), "agent-chrome-playwright-"));
  const marker = join(home, "ready");
  const log = join(home, "notices");
  const script = `
    const { spawnSync } = require('node:child_process');
    const fs = require('node:fs');
    const { run } = require(${JSON.stringify(require.resolve("../scripts/agent-chrome-playwright"))});
    const session = require(${JSON.stringify(require.resolve("../scripts/agent-chrome-session"))});
    const stopping = new AbortController();
    session.withSession({ minutes: 1, what: 'flow', onSignal: () => stopping.abort() }, () => run(() => {}, {
      signal: stopping.signal,
      ready: () => spawnSync(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, ''); setInterval(() => {}, 1000)`)}]).status === 0,
      identityError: () => null,
      connect: () => { fs.writeFileSync(${JSON.stringify(join(home, "connected"))}, ''); throw new Error('connected'); },
    }), {
      dir: () => session.stateDir(${JSON.stringify(home)}), now: Date.now, log: () => {},
      notify: async (message) => fs.appendFileSync(${JSON.stringify(log)}, message + '\\n'),
    }).catch(() => { process.exitCode = 1; });
  `;
  const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore", env: { ...process.env, AGENT_CHROME_SESSION: "" } });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } });
  const gone = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  for (let i = 0; i < 100 && !fs.existsSync(marker); i += 1) await sleep(25);
  assert.ok(fs.existsSync(marker), "readiness child started");
  process.kill(-child.pid, "SIGINT");
  assert.equal(await gone, 1);
  assert.equal(fs.existsSync(join(home, "connected")), false);
  assert.match(fs.readFileSync(log, "utf8"), /flow: stopped after/);
});
