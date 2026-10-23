const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const session = require("../scripts/agent-chrome-session");

const HELPER = join(__dirname, "../scripts/agent-chrome-session");

function sandbox() {
  const home = fs.mkdtempSync(join(tmpdir(), "agent-chrome-session-"));
  const notices = [];
  let now = 1_000_000;
  const deps = {
    dir: () => session.stateDir(home),
    notify: async (message) => { notices.push(message); },
    log: () => {},
    now: () => now,
  };
  const syncDeps = { ...deps, notify: (message) => { notices.push(message); } };
  return { home, notices, deps, syncDeps, advance: (ms) => { now += ms; } };
}

test("the CLI needs a duration, a description and a command after --", () => {
  assert.deepEqual(session.parseArgs(["--minutes", "5", "--what", "PR 84 hosted check", "--", "node", "check.mjs"]),
    { foreground: false, minutes: 5, what: "PR 84 hosted check", command: ["node", "check.mjs"] });
  for (const args of [
    ["--what", "x", "--", "node"],
    ["--minutes", "5", "--", "node"],
    ["--minutes", "0", "--what", "x", "--", "node"],
    ["--minutes", "5", "--what", " ", "--", "node"],
    ["--minutes", "5", "--what", "x", "node"],
    ["--minutes", "5", "--what", "x", "--"],
  ]) assert.throws(() => session.parseArgs(args), /Usage: agent-chrome-session --minutes N --what/);
});

test("the owner hears what and how long before the run, and that it ended after", async () => {
  const { notices, deps } = sandbox();
  const seen = await session.withSession({ what: "PR 84 hosted check", minutes: 5 }, async (env) => {
    assert.equal(notices.length, 1);
    const [{ declaration }] = session.declarations(deps.dir());
    assert.equal(declaration.id, env[session.ENV]);
    assert.equal(declaration.pid, process.pid);
    return "read";
  }, deps);
  assert.equal(seen, "read");
  assert.deepEqual(notices, [
    "PR 84 hosted check. About 5 min, background tabs only.",
    "PR 84 hosted check: finished after under a minute. Done with the agent Chrome.",
  ]);
  assert.deepEqual(session.declarations(deps.dir()), []);
});

test("a failed run still says it ended, and a nested helper stays quiet", async () => {
  const { notices, deps } = sandbox();
  await assert.rejects(session.withSession({ what: "flow", minutes: 2 }, async (env) => {
    const saved = process.env[session.ENV];
    process.env[session.ENV] = env[session.ENV];
    try { await session.withSession({ what: "inner", minutes: 1 }, async () => {}, deps); }
    finally { if (saved === undefined) delete process.env[session.ENV]; else process.env[session.ENV] = saved; }
    throw new Error("flow broke");
  }, deps), /flow broke/);
  assert.equal(notices.length, 2);
  assert.match(notices[1], /^flow: failed after/);
});

test("a notification that fails does not stop the run", async () => {
  const { deps } = sandbox();
  const result = await session.withSession({ what: "flow", minutes: 1 }, async () => "ran",
    { ...deps, notify: async () => { throw new Error("no notification center"); } });
  assert.equal(result, "ran");
});

function cli(home, log, command) {
  return spawn(process.execPath, [HELPER, "--minutes", "3", "--what", "long check", "--", ...command], {
    env: { ...process.env, AGENT_CHROME_STATE_HOME: home, AGENT_CHROME_SESSION_TEST_NOTIFY_LOG: log, [session.ENV]: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function until(check) {
  for (let i = 0; i < 200; i += 1) {
    const value = check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error("timed out");
}

const exited = (child) => new Promise((resolve) => child.once("close", (code, signal) => resolve(code ?? signal)));

test("the CLI hands the child its session and passes its exit code on", async () => {
  const { home } = sandbox();
  const log = join(home, "notices");
  const child = cli(home, log, [process.execPath, "-e", `process.stdout.write(process.env.${session.ENV}); process.exit(3)`]);
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  assert.equal(await exited(child), 3);
  assert.match(out, /^[0-9a-f-]{36}$/);
  assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n").map((line) => line.replace(/after .*/, "after")),
    ["long check. About 3 min, background tabs only.", "long check: failed (exit 3) after"]);
});

test("killing the helper stops the child and still says done", async () => {
  const { home } = sandbox();
  const log = join(home, "notices");
  const child = cli(home, log, [process.execPath, "-e", "setInterval(() => {}, 1000)"]);
  await until(() => session.declarations(session.stateDir(home)).length === 1);
  await until(() => fs.existsSync(log));
  child.kill("SIGTERM");
  assert.equal(await exited(child), 143);
  assert.match(fs.readFileSync(log, "utf8"), /long check: stopped after/);
  assert.deepEqual(session.declarations(session.stateDir(home)), []);
});

test("a helper killed with SIGKILL is reported done by the sweep", async (t) => {
  const { home, notices, deps } = sandbox();
  const log = join(home, "notices");
  const pidFile = join(home, "child.pid");
  const child = cli(home, log, [process.execPath, "-e", "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", pidFile]);
  // The orphaned child keeps the helper's pipes open, so wait for exit, not close, and kill it here.
  t.after(() => { try { process.kill(Number(fs.readFileSync(pidFile, "utf8"))); } catch { /* gone */ } });
  await until(() => session.declarations(session.stateDir(home)).length === 1 && fs.existsSync(pidFile));
  await session.sweep({ ...deps, now: Date.now });
  assert.deepEqual(notices, []);
  const gone = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await gone;
  await session.sweep({ ...deps, now: Date.now });
  assert.equal(notices.length, 1);
  assert.match(notices[0], /^long check: stopped without saying so after/);
  assert.deepEqual(session.declarations(deps.dir()), []);
});

test("a lease notifies once, renews quietly and the sweep ends it when it expires", async () => {
  const { notices, deps, syncDeps, advance } = sandbox();
  const spec = { id: "axi-claude-1234", what: "axi fallback", minutes: 30 };
  session.lease(spec, syncDeps);
  advance(10 * 60000);
  session.lease({ ...spec, foreground: true }, syncDeps);
  assert.equal(notices.length, 1);
  assert.equal(session.declarations(deps.dir())[0].declaration.foreground, true);
  advance(29 * 60000);
  await session.sweep(deps);
  assert.equal(notices.length, 1);
  advance(2 * 60000);
  await session.sweep(deps);
  assert.deepEqual(notices.slice(1), ["axi fallback: finished after 40 min. Done with the agent Chrome."]);
  session.lease(spec, syncDeps);
  session.endLease(spec.id, syncDeps);
  assert.equal(notices.length, 4);
  assert.deepEqual(session.declarations(deps.dir()), []);
});

test("an adopted client is announced once and reported finished when it exits", async () => {
  const { notices, deps } = sandbox();
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 200)"], { stdio: "ignore" });
  await session.adopt({ pid: child.pid, what: "node pw-pr84.mjs" }, deps);
  await session.adopt({ pid: child.pid, what: "node pw-pr84.mjs" }, deps);
  assert.deepEqual(notices, ["node pw-pr84.mjs is using the agent Chrome without agent-chrome-session, so how long is unknown."]);
  await new Promise((resolve) => child.once("exit", resolve));
  await session.sweep(deps);
  assert.match(notices[1], /^node pw-pr84\.mjs: finished after under a minute\. Done with the agent Chrome\.$/);
  assert.deepEqual(session.declarations(deps.dir()), []);
});

test("a signal during the start notice stops the run before its command starts", async () => {
  const { home, notices, deps } = sandbox();
  const marker = join(home, "started");
  const slow = { ...deps, notify: async (message) => { notices.push(message); if (notices.length === 1) await sleep(100); } };
  setTimeout(() => process.emit("SIGINT", "SIGINT"), 20);
  const code = await session.main(["--minutes", "1", "--what", "slow notice", "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`], slow);
  assert.equal(code, 130);
  assert.equal(fs.existsSync(marker), false);
  assert.match(notices[1], /^slow notice: stopped after/);
});

test("the sweep ends adopted declarations at the grace deadline while their process is alive", async () => {
  const { notices, deps, advance } = sandbox();
  await session.adopt({ pid: process.pid, what: "node" }, deps);
  session.lease({ id: "declared", what: "declared flow", minutes: 2 }, { ...deps, notify: (message) => notices.push(message) });
  const deadline = deps.now() + 60000;
  advance(59999);
  await session.sweep(deps, deadline);
  assert.equal(notices.length, 2);
  advance(1);
  await session.sweep(deps, deadline);
  assert.equal(notices.length, 3);
  assert.match(notices[2], /^node: finished after 1 min/);
  assert.deepEqual(session.declarations(deps.dir()).map(({ declaration }) => declaration.id), ["declared"]);
  await session.sweep(deps, deadline);
  assert.equal(notices.length, 3);
});

test("a second signal during a blocked start notice exits before the child starts", async (t) => {
  const { home } = sandbox();
  const log = join(home, "notices");
  const marker = join(home, "started");
  const script = `
    const fs = require('node:fs');
    const session = require(${JSON.stringify(HELPER)});
    session.main(['--minutes', '1', '--what', 'slow notice', '--', process.execPath, '-e',
      ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`)}], {
      dir: () => session.stateDir(${JSON.stringify(home)}), now: Date.now, log: () => {},
      notify: async (message) => {
        fs.appendFileSync(${JSON.stringify(log)}, message + '\\n');
        if (!message.includes('Done with')) {
          setInterval(() => {}, 1000);
          process.on('SIGINT', () => console.log('signal seen'));
          console.log('ready');
          await new Promise(() => {});
        }
      },
    });
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, [session.ENV]: "" } });
  t.after(() => child.kill("SIGKILL"));
  const gone = exited(child);
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  await until(() => output.includes("ready"));
  child.kill("SIGINT");
  await until(() => output.includes("signal seen"));
  child.kill("SIGINT");
  const code = await Promise.race([gone, sleep(1000).then(() => "still waiting for start notice")]);
  assert.equal(code, 130);
  assert.equal(fs.existsSync(marker), false);
  assert.match(fs.readFileSync(log, "utf8"), /slow notice: stopped after/);
});

test("a second signal kills a child that ignored the first, and the run still says done", async () => {
  const { home } = sandbox();
  const log = join(home, "notices");
  const child = cli(home, log, [process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready')"]);
  await new Promise((resolve) => child.stdout.once("data", resolve));
  child.kill("SIGTERM");
  await sleep(200);
  assert.equal(child.exitCode, null);
  child.kill("SIGTERM");
  assert.equal(await exited(child), 137);
  assert.match(fs.readFileSync(log, "utf8"), /long check: stopped after/);
});

test("a library run that fails because it was signalled is reported stopped, not failed", async () => {
  const { notices, deps } = sandbox();
  const seen = [];
  await assert.rejects(session.withSession({ minutes: 1, what: "flow", onSignal: (signal, count) => seen.push([signal, count]) }, async () => {
    process.emit("SIGTERM", "SIGTERM");
    throw new Error("Target page, context or browser has been closed");
  }, deps));
  assert.deepEqual(seen, [["SIGTERM", 1]]);
  assert.match(notices[1], /^flow: stopped after/);
});

// Review r3 of agent-chrome-playwright-attach: the handlers went before the
// done notice, and a stop during it found the declaration claimed and exited
// at once, so the notice was lost and <id>.json.ending stayed behind.
test("signals while the done notice goes out wait for it, and nothing is left behind", { timeout: 10000 }, async (t) => {
  for (const signals of [1, 3]) {
    const home = fs.mkdtempSync(join(tmpdir(), "agent-chrome-session-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const log = join(home, "notices");
    const script = `
      const fs = require("node:fs");
      const session = require(${JSON.stringify(HELPER)});
      session.withSession({ what: "flow", minutes: 1 }, async () => {
        for (let i = 0; i < ${signals}; i += 1) setTimeout(() => process.kill(process.pid, "SIGINT"), 100 + 50 * i);
      }, {
        dir: () => session.stateDir(${JSON.stringify(home)}), now: Date.now, log: () => {},
        notify: (message) => new Promise((resolve) => setTimeout(() => { fs.appendFileSync(${JSON.stringify(log)}, message + "\\n"); resolve(); }, message.includes("Done") ? 400 : 0)),
      });
    `;
    const child = spawn(process.execPath, ["-e", script], { stdio: "ignore", env: { ...process.env, [session.ENV]: "" } });
    t.after(() => child.kill("SIGKILL"));
    assert.equal(await exited(child), 130, `${signals} signal(s)`);
    assert.match(fs.readFileSync(log, "utf8"), /flow: finished after under a minute\. Done/, `${signals} signal(s)`);
    assert.deepEqual(fs.readdirSync(session.stateDir(home)), [], `${signals} signal(s)`);
  }
});
