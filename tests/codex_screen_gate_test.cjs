const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { parseArgs, decision, parseIdle, dialogScript, dependencies, run, acquireLock, codexArgs } = require("../scripts/codex-computer-use");

function harness(answers, idle = [0], exit = 0) {
  const events = [];
  const deps = {
    ready: async () => { events.push("ready"); },
    dialog: async (minutes) => { events.push(["dialog", minutes]); assert.ok(answers.length, "unexpected extra dialog"); return answers.shift(); },
    idle: async () => { events.push("idle"); return idle.shift(); },
    sleep: async (ms) => { events.push(["sleep", ms]); },
    codex: async (prompt) => { events.push(["codex", prompt]); return exit; },
    notify: async () => { events.push("notify"); },
    log: () => {},
  };
  return { deps, events };
}
const options = { minutes: 7, prompt: "test interactive flow" };

test("Start now runs immediately after readiness and the warning, then frees the screen", async () => {
  const { deps, events } = harness(["start"]);
  assert.equal(await run(options, deps), 0);
  assert.deepEqual(events, ["ready", ["dialog", 7], ["codex", options.prompt], "notify"]);
});

test("Wait 10 min always defers even on an idle Mac, then asks again", async () => {
  const { deps, events } = harness(["defer", "start"], [999]);
  await run(options, deps);
  assert.deepEqual(events, ["ready", ["dialog", 7], ["sleep", 600000], ["dialog", 7], ["codex", options.prompt], "notify"]);
});

test("a timed-out warning starts only at 120 seconds of idle time", async () => {
  const { deps, events } = harness(["timeout"], [120]);
  await run(options, deps);
  assert.deepEqual(events, ["ready", ["dialog", 7], "idle", ["codex", options.prompt], "notify"]);
  for (const idle of [119.999, null, undefined, NaN, Infinity, -1]) assert.equal(decision("timeout", idle), "wait");
});

test("timeout while busy or unknown keeps waiting until the Mac becomes idle", async () => {
  const { deps, events } = harness(["timeout", "timeout", "timeout"], [10, null, 121]);
  await run(options, deps);
  assert.deepEqual(events, ["ready", ["dialog", 7], "idle", ["sleep", 60000],
    ["dialog", 7], "idle", ["sleep", 60000], ["dialog", 7], "idle", ["codex", options.prompt], "notify"]);
});

test("a dialog error, invalid response or readiness failure never starts Codex", async () => {
  for (const stage of ["ready", "dialog", "invalid"]) {
    const { deps, events } = harness(["invalid"]);
    if (stage !== "invalid") deps[stage] = async () => { throw new Error("unavailable"); };
    await assert.rejects(run(options, deps));
    assert.equal(events.some((event) => Array.isArray(event) && event[0] === "codex"), false);
    assert.equal(events.includes("notify"), false);
  }
});

test("Codex failure still notifies, preserving its exit status or error", async () => {
  const failed = harness(["start"], [], 3);
  assert.equal(await run(options, failed.deps), 3);
  assert.equal(failed.events.at(-1), "notify");
  const thrown = harness(["start"]);
  thrown.deps.codex = async () => { throw new Error("Codex failed"); };
  await assert.rejects(run(options, thrown.deps), /Codex failed/);
  assert.equal(thrown.events.at(-1), "notify");
});

test("idle parser uses HIDIdleTime nanoseconds and fails closed for missing data", () => {
  assert.equal(parseIdle('"HIDIdleTime" = 120000000000'), 120);
  assert.equal(parseIdle('"HIDIdleTime" = 500000000'), 0.5);
  assert.equal(parseIdle("no idle time"), null);
});

test("duration defaults to five minutes, validates input and dialog waits sixty seconds", () => {
  assert.deepEqual(parseArgs(["--", "prompt"]), { minutes: 5, prompt: "prompt" });
  assert.deepEqual(parseArgs(["--minutes", "9", "--", "prompt"]), { minutes: 9, prompt: "prompt" });
  for (const args of [[], ["--", ""], ["--", "one", "two"], ["--minutes", "0", "--", "p"], ["--minutes", "121", "--", "p"]]) {
    assert.throws(() => parseArgs(args));
  }
  const script = dialogScript(9);
  assert.match(script, /Codex needs your screen for about 9 min\. Please stop using the Mac until it's done\./);
  assert.match(script, /buttons \{"Wait 10 min", "Start now"\}/);
  assert.match(script, /giving up after 60/);
});

test("one screen owner holds a private lock until the run releases it", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "screen-gate-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const release = acquireLock(home);
  assert.throws(() => acquireLock(home), /Screen control is already reserved/);
  assert.equal(fs.statSync(path.join(home, ".local/state/codex-computer-use/screen.lock")).mode & 0o777, 0o600);
  release();
  acquireLock(home)();
});

test("run spawns codex exec with the prompt after --, so one that starts with a dash or names a subcommand stays the prompt", async () => {
  for (const prompt of ["-x check the page", "--help", "resume", "review the pack"]) {
    const spawned = [];
    const start = (command, args, options) => {
      spawned.push([path.basename(command), args, options]);
      const child = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => child.emit("close", 0));
      return child;
    };
    const { deps } = harness(["start"]);
    deps.codex = dependencies(new AbortController().signal, start).codex;
    assert.equal(await run({ minutes: 5, prompt }, deps), 0);
    assert.deepEqual(spawned, [["codex", ["exec", "-s", "danger-full-access", "--", prompt], { stdio: "inherit" }]]);
    assert.deepEqual(codexArgs(prompt), spawned[0][1]);
  }
});
