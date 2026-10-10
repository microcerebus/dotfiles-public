const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { run, AGENT_CHROME_URL, AGENT_CHROME_LABEL } = require("../scripts/chrome-devtools-axi");

function harness({ up = [true], installed = true } = {}) {
  const calls = { spawn: [], probe: 0, kickstart: 0, stderr: "" };
  const deps = {
    spawn: (command, args, options) => { calls.spawn.push({ command, args, env: options.env }); return { status: 0 }; },
    probe: () => { const ok = up[Math.min(calls.probe, up.length - 1)]; calls.probe += 1; return ok; },
    agentInstalled: () => installed,
    kickstart: () => { calls.kickstart += 1; },
    sleep: () => {},
  };
  const io = { stderr: { write: (s) => { calls.stderr += s; } } };
  return { calls, deps, io };
}

test("routes to the agent Chrome by default", () => {
  const { calls, deps, io } = harness();
  assert.equal(run(["open", "https://example.com"], {}, deps, io), 0);
  assert.equal(calls.spawn[0].env.CHROME_DEVTOOLS_AXI_BROWSER_URL, AGENT_CHROME_URL);
  assert.equal(calls.spawn[0].env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT, undefined);
  assert.equal(calls.kickstart, 0);
});

test("refuses autoConnect to the owner's own Chrome and names the opt-in", () => {
  for (const env of [
    { CHROME_DEVTOOLS_AXI_AUTO_CONNECT: "1" },
    { CHROME_DEVTOOLS_AXI_BROWSER_URL: "ws://127.0.0.1:9222/devtools/browser/abc" },
    { CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://localhost:9222" },
  ]) {
    const { calls, deps, io } = harness();
    assert.equal(run(["snapshot"], env, deps, io), 2);
    assert.equal(calls.spawn.length, 0);
    assert.match(calls.stderr, /CHROME_DEVTOOLS_AXI_MAIN_CHROME=1/);
  }
});

test("explicit opt-in attaches to the owner's own Chrome", () => {
  const { calls, deps, io } = harness();
  const env = { CHROME_DEVTOOLS_AXI_MAIN_CHROME: "1", CHROME_DEVTOOLS_AXI_BROWSER_URL: AGENT_CHROME_URL };
  assert.equal(run(["snapshot"], env, deps, io), 0);
  assert.equal(calls.spawn[0].env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT, "1");
  assert.equal(calls.spawn[0].env.CHROME_DEVTOOLS_AXI_BROWSER_URL, undefined);
  assert.equal(calls.probe, 0);
});

test("starts the agent Chrome through launchd when it is down", () => {
  const { calls, deps, io } = harness({ up: [false, false, true] });
  assert.equal(run(["open", "https://example.com"], { CHROME_DEVTOOLS_AXI_BROWSER_URL: AGENT_CHROME_URL }, deps, io), 0);
  assert.equal(calls.kickstart, 1);
  assert.equal(calls.spawn[0].env.CHROME_DEVTOOLS_AXI_BROWSER_URL, AGENT_CHROME_URL);
});

test("fails loudly when the agent Chrome never comes up", () => {
  const { calls, deps, io } = harness({ up: [false] });
  assert.equal(run(["open", "https://example.com"], {}, deps, io), 1);
  assert.equal(calls.spawn.length, 0);
  assert.match(calls.stderr, /agent-chrome\.log/);
});

test("before the agent Chrome is installed, uses a throwaway browser", () => {
  const { calls, deps, io } = harness({ up: [false], installed: false });
  assert.equal(run(["open", "https://example.com"], {}, deps, io), 0);
  assert.equal(calls.kickstart, 0);
  assert.equal(calls.spawn[0].env.CHROME_DEVTOOLS_AXI_BROWSER_URL, undefined);
  assert.equal(calls.spawn[0].env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT, undefined);
  assert.match(calls.stderr, /throwaway/);
});

test("commands that need no browser never start one", () => {
  for (const args of [[], ["--help"], ["-v"], ["open", "--help"], ["stop"], ["setup", "hooks"]]) {
    const { calls, deps, io } = harness({ up: [false] });
    assert.equal(run(args, {}, deps, io), 0);
    assert.equal(calls.probe, 0);
    assert.equal(calls.kickstart, 0);
  }
});

test("explicit other browsers pass through untouched", () => {
  for (const env of [
    { CHROME_DEVTOOLS_AXI_BROWSER_URL: "" },
    { CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:9555" },
    { CHROME_DEVTOOLS_AXI_USER_DATA_DIR: "/tmp/profile" },
  ]) {
    const { calls, deps, io } = harness({ up: [false] });
    assert.equal(run(["snapshot"], env, deps, io), 0);
    assert.equal(calls.spawn[0].env.CHROME_DEVTOOLS_AXI_BROWSER_URL, env.CHROME_DEVTOOLS_AXI_BROWSER_URL);
    assert.equal(calls.probe, 0);
  }
});

test("each Claude thread gets its own session, and idle bridges exit", () => {
  const { calls, deps, io } = harness();
  run(["snapshot"], { CLAUDE_CODE_SESSION_ID: "f1966707-fda6-48e2-8c1b-89d704b86cbc" }, deps, io);
  assert.equal(calls.spawn[0].env.CHROME_DEVTOOLS_AXI_SESSION, "claude-f1966707");
  assert.equal(calls.spawn[0].env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS, "1800000");
  const explicit = harness();
  run(["snapshot"], { CLAUDE_CODE_SESSION_ID: "f1966707", CHROME_DEVTOOLS_AXI_SESSION: "ui-owner",
    CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS: "0" }, explicit.deps, explicit.io);
  assert.equal(explicit.calls.spawn[0].env.CHROME_DEVTOOLS_AXI_SESSION, "ui-owner");
  assert.equal(explicit.calls.spawn[0].env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS, "0");
});

test("the launchd agent and session env match the wrapper", () => {
  const nix = readFileSync(join(__dirname, "../nix/user.nix"), "utf8");
  const port = new URL(AGENT_CHROME_URL).port;
  assert.match(nix, new RegExp(`"--remote-debugging-port=${port}"`));
  assert.match(nix, new RegExp(`Label = "${AGENT_CHROME_LABEL.replace(/\./g, "\\.")}";`));
  assert.match(nix, new RegExp(`CHROME_DEVTOOLS_AXI_BROWSER_URL = "${AGENT_CHROME_URL}";`));
});
