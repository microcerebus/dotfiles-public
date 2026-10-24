require("./lib/agent-chrome-test-env.cjs");
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const session = require("../scripts/agent-chrome-session");

const HELPER = join(__dirname, "../scripts/agent-chrome-session");
const HOLD = join(__dirname, "lib/hold-before-watchdog.cjs");
const SPLIT_KILL = join(__dirname, "lib/split-kill.cjs");

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

const cliEnv = (home, log, extra = {}) => ({ ...process.env, AGENT_CHROME_STATE_HOME: home, AGENT_CHROME_SESSION_TEST_NOTIFY_LOG: log, [session.ENV]: "", ...extra });

// The running test's signal. node 22 aborts it when the test ends or times
// out, so a poll that sleeps on it, and a helper cli() starts, end with the
// test instead of keeping the file alive.
let current;
beforeEach((t) => { current = t.signal; });

function cli(home, log, command, extra = {}) {
  const child = spawn(process.execPath, [HELPER, "--minutes", "3", "--what", "long check", "--", ...command], {
    env: cliEnv(home, log, extra),
    stdio: ["ignore", "pipe", "pipe"],
  });
  current.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
  return child;
}

// Polls until check passes, with no deadline of its own: a slow start under
// parallel suites is not a failure. The test's timeout ends it.
async function waitFor(check) {
  for (;;) {
    const value = check();
    if (value) return value;
    await sleep(25, undefined, { signal: current });
  }
}

const exited = (child) => new Promise((resolve) => child.once("close", (code, signal) => resolve(code ?? signal)));

// The pid a command wrote, or 0 until it is one the test may signal: Number("")
// is 0, and kill(0) would reach the test's own group.
function readPid(file) {
  const pid = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
  return Number.isInteger(pid) && pid > 1 ? pid : 0;
}

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

test("killing the helper stops the child and still says done", { timeout: 60_000 }, async () => {
  const { home } = sandbox();
  const log = join(home, "notices");
  const child = cli(home, log, [process.execPath, "-e", "setInterval(() => {}, 1000)"]);
  await waitFor(() => session.declarations(session.stateDir(home)).length === 1);
  await waitFor(() => fs.existsSync(log));
  child.kill("SIGTERM");
  assert.equal(await exited(child), 143);
  assert.match(fs.readFileSync(log, "utf8"), /long check: stopped after/);
  assert.deepEqual(session.declarations(session.stateDir(home)), []);
});

test("a helper killed with SIGKILL is reported done by the sweep", { timeout: 60_000 }, async (t) => {
  const { home, notices, deps } = sandbox();
  const log = join(home, "notices");
  const pidFile = join(home, "child.pid");
  const child = cli(home, log, [process.execPath, "-e", "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", pidFile]);
  t.after(() => {
    const pid = readPid(pidFile);
    if (pid) try { process.kill(pid); } catch { /* gone */ }
  });
  await waitFor(() => session.declarations(session.stateDir(home)).length === 1 && fs.existsSync(pidFile));
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

test("a second signal during a blocked start notice exits before the child starts", { timeout: 60_000 }, async (t) => {
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
  await waitFor(() => output.includes("ready"));
  child.kill("SIGINT");
  await waitFor(() => output.includes("signal seen"));
  child.kill("SIGINT");
  const code = await Promise.race([gone, sleep(1000).then(() => "still waiting for start notice")]);
  assert.equal(code, 130);
  assert.equal(fs.existsSync(marker), false);
  assert.match(fs.readFileSync(log, "utf8"), /slow notice: stopped after/);
});

test("a second signal kills a child that ignored the first, and the run still says done", { timeout: 60_000 }, async () => {
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
test("signals while the done notice goes out wait for it, and nothing is left behind", { timeout: 60_000 }, async (t) => {
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

const running = (pid) => {
  assert.ok(Number.isInteger(pid) && pid > 1, `${pid} is no pid the test may probe`);
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// A shell that ignores the stop signals, with a grandchild that inherits that
// and writes its pid, as a command with a helper of its own does.
function stubborn(pidFile) {
  return ["/bin/sh", "-c", `trap "" INT TERM HUP; /bin/sleep 60 >/dev/null 2>&1 & echo $! > ${pidFile}; wait; wait`];
}

// Follow-up of playwright-session-signals review r2: a real second Ctrl-C
// SIGKILLed only the command, and what it had started kept running.
test("a second signal kills everything the command started, not just the command", { timeout: 60_000 }, async (t) => {
  const { home } = sandbox();
  const log = join(home, "notices");
  const pidFile = join(home, "grandchild.pid");
  const child = cli(home, log, stubborn(pidFile));
  const grandchild = await waitFor(() => readPid(pidFile));
  t.after(() => { try { process.kill(grandchild, "SIGKILL"); } catch { /* gone */ } });
  child.kill("SIGINT");
  await sleep(200);
  const code = new Promise((resolve) => child.once("exit", (status, signal) => resolve(status ?? signal)));
  child.kill("SIGINT");
  assert.equal(await code, 137);
  await waitFor(() => !running(grandchild));
  assert.match(fs.readFileSync(log, "utf8"), /long check: stopped after/);
});

// Review r3 of chrome-dead-gate-followups: XNU's killpg reaches a group's
// members one at a time, newest first, so under load the command's shell saw
// its child die and exited 0 before its own SIGKILL, and the session reported
// a stopped run as finished. The split-kill preload makes that order certain.
test("a second signal is reported as a stop even if the command's shell exits 0 first", { timeout: 60_000 }, async (t) => {
  const { home } = sandbox();
  const log = join(home, "notices");
  const pidFile = join(home, "grandchild.pid");
  const child = cli(home, log, stubborn(pidFile), {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(SPLIT_KILL)}`.trim(),
    AGENT_CHROME_SESSION_TEST_SPLIT_KILL: pidFile,
  });
  t.after(() => {
    child.kill("SIGKILL");
    const grandchild = readPid(pidFile);
    if (grandchild) try { process.kill(grandchild, "SIGKILL"); } catch { /* gone */ }
  });
  const grandchild = await waitFor(() => readPid(pidFile));
  child.kill("SIGINT");
  await sleep(200);
  const code = new Promise((resolve) => child.once("exit", (status, signal) => resolve(status ?? signal)));
  child.kill("SIGINT");
  assert.equal(await code, 137);
  await waitFor(() => !running(grandchild));
  assert.match(fs.readFileSync(log, "utf8"), /long check: stopped after/);
});

// The command's own process group must not let it outlive a harness that
// SIGKILLs the session, as it did when the command shared the session's group.
test("a session SIGKILLed by its harness takes its command and what it started down with it", { timeout: 60_000 }, async (t) => {
  const { home } = sandbox();
  const log = join(home, "notices");
  const pidFile = join(home, "grandchild.pid");
  const child = cli(home, log, stubborn(pidFile));
  const grandchild = await waitFor(() => readPid(pidFile));
  t.after(() => { try { process.kill(grandchild, "SIGKILL"); } catch { /* gone */ } });
  child.kill("SIGKILL");
  await waitFor(() => !running(grandchild));
});

// Review r4 of chrome-dead-gate-followups: the helper started the command and
// only then its watchdog, so a harness SIGKILL between the two left the command
// and what it started running with nothing to take them down. The hold preload
// stops the helper in that gap, so the SIGKILL lands there every time.
test("a session SIGKILLed before its watchdog starts runs none of its command", { timeout: 60_000 }, async (t) => {
  const { home } = sandbox();
  const log = join(home, "notices");
  const pidFile = join(home, "grandchild.pid");
  const hold = join(home, "held");
  const child = cli(home, log, stubborn(pidFile), {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(HOLD)}`.trim(),
    AGENT_CHROME_SESSION_TEST_HOLD: hold,
  });
  t.after(() => {
    child.kill("SIGKILL");
    const grandchild = readPid(pidFile);
    if (grandchild) try { process.kill(grandchild, "SIGKILL"); } catch { /* gone */ }
  });
  const group = await waitFor(() => readPid(hold));
  // The group is the helper's own child, so the SIGKILL below cannot strand anything the test did not start.
  assert.ok(Number.isInteger(group) && group > 1, `held group ${group}`);
  assert.equal(Number(spawnSync("/bin/ps", ["-o", "ppid=", "-p", String(group)], { encoding: "utf8" }).stdout), child.pid);
  child.kill("SIGKILL");
  await waitFor(() => !running(group) || fs.existsSync(pidFile));
  assert.equal(fs.existsSync(pidFile), false, "the command ran before its watchdog had its group");
});

// The launcher that holds the command until its watchdog runs is a shell, and
// bash rewrites PWD and drops OLDPWD and _ from what it passes on, and a
// launcher shell would add SHLVL and the like of its own.
test("the command gets the session's environment as it is, and no pipe of the launcher's", async () => {
  const { home } = sandbox();
  const log = join(home, "notices");
  const given = { OLDPWD: "/nowhere/old", PWD: "/nowhere/now", _: "/nowhere/last", AGENT_CHROME_SESSION_TEST_VALUE: "a=b c\nd" };
  // Left out of what the test passes, so one a launcher shell adds shows up.
  const unset = { SHLVL: undefined };
  const run = async (command) => {
    const child = cli(home, log, command, { ...given, ...unset });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    assert.equal(await exited(child), 0);
    return out;
  };
  const env = (await run(["/usr/bin/env", "-0"])).split("\0").filter(Boolean);
  for (const [name, value] of Object.entries(given)) assert.ok(env.includes(`${name}=${value}`), `${name} must reach the command unchanged`);
  // The session adds only its own id, which the test's env already names, empty.
  const own = [session.ENV];
  const names = (entries) => [...new Set(entries)].sort();
  const passed = Object.entries(cliEnv(home, log, { ...given, ...unset })).filter(([, value]) => value !== undefined).map(([name]) => name);
  assert.deepEqual(names(env.map((entry) => entry.slice(0, entry.indexOf("=")))), names([...passed, ...own]));
  assert.equal(await run(["/bin/sh", "-c", "if { : <&3; } 2>/dev/null; then echo open; else echo closed; fi"]), "closed\n");
});

// The three ways the helper starts a command: from an agent's harness (no
// terminal, so a group of its own), from a terminal, and inside another
// session. Each run gets its own notice logs; script(1) puts the command's
// stdout and stderr both on its own stdout.
async function onEachPath(home, command, extra = {}) {
  const helper = (what) => [process.execPath, HELPER, "--minutes", "3", "--what", what, "--", ...command];
  const starts = {
    grouped: (log) => cli(home, log, command, extra),
    terminal: (log) => spawn("/usr/bin/script", ["-q", "/dev/null", ...helper("long check")], { env: cliEnv(home, log, extra), stdio: ["ignore", "pipe", "pipe"] }),
    nested: (log) => cli(home, log, helper("inner check"), extra),
  };
  const runs = {};
  const logs = fs.mkdtempSync(join(home, "notices-"));
  for (const [path, start] of Object.entries(starts)) {
    const log = join(logs, path);
    const child = start(log);
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    const code = await exited(child);
    const notices = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => line.replace(/ after .*/, " after")) : [];
    runs[path] = { code, out, err: path === "terminal" ? out : err, notices };
  }
  return runs;
}

// Review r2 of chrome-dead-gate-followups: env reads a leading NAME=value
// operand as an assignment, so `-- ./a=b` ran nothing, printed the session's
// whole environment and said "finished" on the agent path, while the terminal
// path ran the file.
test("a command name with \"=\" in it is refused on every path, and nothing prints the environment", { timeout: 60_000 }, async () => {
  const { home } = sandbox();
  const file = join(home, "a=b");
  fs.writeFileSync(file, "#!/bin/sh\necho the file ran\n", { mode: 0o755 });
  const mark = "agent-chrome-session-test-env-mark";
  const runs = await onEachPath(home, [file], { AGENT_CHROME_SESSION_TEST_MARK: mark });
  for (const [path, run] of Object.entries(runs)) {
    // First, so the messages below never quote an environment.
    for (const output of [run.out, run.err]) {
      assert.ok(!output.includes(mark), `${path} printed the environment`);
      assert.ok(!output.includes("the file ran"), `${path} ran the file`);
    }
    assert.equal(run.code, 2, `${path}: exit code`);
    assert.ok(run.err.includes(`agent-chrome-session: command name may not contain "=": ${file}`), `${path}: says why, not ${JSON.stringify(run.err.slice(0, 200))}`);
    assert.deepEqual(run.notices, ["long check. About 3 min, background tabs only.", "long check: failed (exit 2) after"], path);
  }
});

test("a missing command exits 127 and an unexecutable one 126, with the helper's message, on every path", { timeout: 60_000 }, async () => {
  const { home } = sandbox();
  const unexecutable = join(home, "not-executable");
  fs.writeFileSync(unexecutable, "#!/bin/sh\necho the file ran\n", { mode: 0o644 });
  const cases = [
    [join(home, "missing"), 127, "command not found"],
    ["agent-chrome-session-test-no-such-command", 127, "command not found"],
    [unexecutable, 126, "permission denied"],
  ];
  for (const [command, code, why] of cases) {
    for (const [path, run] of Object.entries(await onEachPath(home, [command]))) {
      assert.equal(run.code, code, `${path} ${command}: exit code`);
      assert.ok(run.err.includes(`agent-chrome-session: ${command}: ${why}`), `${path} ${command}: says why, not ${JSON.stringify(run.err.slice(0, 200))}`);
      assert.ok(!run.out.includes("the file ran"), `${path} ran ${command}`);
      assert.deepEqual(run.notices, ["long check. About 3 min, background tabs only.", `long check: failed (exit ${code}) after`], `${path} ${command}`);
    }
  }
});

// As from a shell, a script with no #! line runs through /bin/sh.
test("a script with no shebang runs through /bin/sh on every path", { timeout: 60_000 }, async () => {
  const { home } = sandbox();
  const script = join(home, "no-shebang");
  fs.writeFileSync(script, 'echo "no shebang, ran"\n', { mode: 0o755 });
  for (const [path, run] of Object.entries(await onEachPath(home, [script]))) {
    assert.equal(run.code, 0, `${path}: exit code, stderr ${JSON.stringify(run.err.slice(0, 200))}`);
    assert.match(run.out, /no shebang, ran/, path);
  }
});

// What each process's group is, as the command sees it.
const GROUPS = `printf '%s %s\\n' "$(ps -o pgid= -p $PPID | tr -d ' ')" "$(ps -o pgid= -p $$ | tr -d ' ')"`;

test("without a terminal the command gets its own process group; from a terminal it keeps the terminal's", async () => {
  const { home } = sandbox();
  const log = join(home, "notices");
  const piped = cli(home, log, ["/bin/sh", "-c", GROUPS]);
  let out = "";
  piped.stdout.on("data", (chunk) => { out += chunk; });
  assert.equal(await exited(piped), 0);
  const [sessionGroup, commandGroup] = out.trim().split(" ");
  assert.notEqual(commandGroup, sessionGroup);
  // script(1) runs the helper on a pseudo-terminal, as a person's shell does.
  const command = [process.execPath, HELPER, "--minutes", "3", "--what", "long check", "--", "/bin/sh", "-c", GROUPS];
  const tty = spawn("/usr/bin/script", ["-q", "/dev/null", ...command], {
    env: { ...process.env, AGENT_CHROME_STATE_HOME: home, AGENT_CHROME_SESSION_TEST_NOTIFY_LOG: log, [session.ENV]: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let seen = "";
  tty.stdout.on("data", (chunk) => { seen += chunk; });
  assert.equal(await exited(tty), 0);
  // script echoes the ^D it sends for the closed stdin before the output.
  const [ttySession, ttyCommand] = seen.match(/\d+/g).slice(-2);
  assert.equal(ttyCommand, ttySession);
});

// Review r1 of agent-chrome-session-orphans: nothing pinned that a nested
// session leaves its command in the outer session's group, where the outer
// one's second signal and watchdog reach it.
test("a nested session keeps its command in the outer session's process group", async () => {
  const { home } = sandbox();
  const log = join(home, "notices");
  const nested = cli(home, log, [process.execPath, HELPER, "--minutes", "1", "--what", "inner check", "--", "/bin/sh", "-c", GROUPS]);
  let out = "";
  nested.stdout.on("data", (chunk) => { out += chunk; });
  assert.equal(await exited(nested), 0);
  const [innerSessionGroup, commandGroup] = out.trim().split(" ");
  assert.equal(commandGroup, innerSessionGroup);
});

// Review r1 of agent-chrome-session-orphans: the gate closed tabs apply
// workers left open for the owner on purpose, and nothing told him they were left.
test("the done notice says how many tabs the session kept for the owner, counting only this run's", async () => {
  const { home, notices, deps, syncDeps, advance } = sandbox();
  const record = (session, at) => ({ targetId: `tab-${at}`, what: "form to review", session, at });
  const keepIn = (records) => fs.writeFileSync(session.tabsFile(deps.dir()), JSON.stringify({ sessions: [], kept: records }));
  await session.withSession({ what: "apply flow", minutes: 5 }, async (env) => {
    keepIn([record(env[session.ENV], 1_000_000), record(env[session.ENV], 1_000_001), record("other", 1_000_000)]);
  }, deps);
  assert.equal(notices.at(-1), "apply flow: finished after under a minute. Done with the agent Chrome, and left 2 tabs open for you.");
  // A lease's id comes back; a tab kept under an earlier lease is not this one's.
  keepIn([record("axi-default", 999_000)]);
  session.lease({ id: "axi-default", what: "axi", minutes: 1 }, syncDeps);
  keepIn([record("axi-default", 999_000), record("axi-default", 1_000_000)]);
  advance(120000);
  await session.sweep(deps);
  assert.equal(notices.at(-1), "axi: finished after 1 min. Done with the agent Chrome, and left 1 tab open for you.");
});

test("keep runs only inside a session, and needs a reason and one target id", async () => {
  const { home } = sandbox();
  const keep = (args, env = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [HELPER, "keep", ...args], { env: { ...process.env, AGENT_CHROME_STATE_HOME: home, [session.ENV]: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.once("close", (code) => resolve({ code, err }));
  });
  for (const args of [["tab-1"], ["--what", "form", "tab-1", "tab-2"], ["--what", "form"]]) {
    const { code, err } = await keep(args);
    assert.equal(code, 2);
    assert.match(err, /Usage: agent-chrome-session keep --what/);
  }
  const outside = await keep(["--what", "form to review", "tab-1"]);
  assert.equal(outside.code, 2);
  assert.match(outside.err, /inside the session that opened the tab/);
  await assert.rejects(session.keepTab("tab-1", " "), /--what must say/);
});

test("keep against a gate from before keep (Chrome's 404) says the tab stays; any other refusal still fails", async (t) => {
  const http = require("node:http");
  let status = 404;
  const server = http.createServer((req, res) => res.writeHead(status).end(status === 403 ? "refused\n" : "")).listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.match(await session.keepTab("tab-1", "form to review", url), /stays open anyway/);
  status = 403;
  await assert.rejects(session.keepTab("tab-1", "form to review", url), /refused/);
});

test("the launcher and watchdog survive a drained socket (tests/agent_chrome_session_drain_test.py)", () => {
  const run = spawnSync("python3", ["-I", join(__dirname, "agent_chrome_session_drain_test.py")], { encoding: "utf8", timeout: 90000 });
  assert.equal(run.status, 0, `${run.stderr}${run.error ? run.error.message : ""}`.slice(-4000));
});
