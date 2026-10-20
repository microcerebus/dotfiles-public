const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { run, AGENT_CHROME_URL, AGENT_CHROME_LABEL, AGENT_CHROME_FLAGS } = require("../scripts/chrome-devtools-axi");

const CHROME_BETA = "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta";
const PROFILE = "--user-data-dir=/Users/myuser/Library/Application Support/AgentChrome";
// The agent Chrome as launchd started it on 2026-10-10 before the fix, when
// the owner's synced extensions (Dashlane included) loaded into agent sessions.
const UNFLAGGED = `${CHROME_BETA} ${PROFILE} --remote-debugging-port=9333 --no-first-run --no-default-browser-check`;
const FLAGGED = `${CHROME_BETA} ${PROFILE} --remote-debugging-port=9333 --disable-extensions --disable-sync --no-first-run --no-default-browser-check`;

// `chrome-devtools-axi pages` for a session that owns no tab, and for one that does.
const NO_OWN_TAB = "pages[2]{id,url,selected}:\n  1,chrome://new-tab-page/,false\n  2,https://example.com/other-agent,false\n";
const OWN_TAB = `${NO_OWN_TAB}  3,"https://example.com/mine?a=1,2",true\n`;
const PAGE = "https://test-machine.example.ts.net/packs/review/";

function harness({ up = [true], installed = true, browser = [FLAGGED], pages = NO_OWN_TAB, until = null } = {}) {
  const calls = { spawn: [], probe: 0, kickstart: 0, stderr: "", leases: [], ended: [] };
  const deps = {
    fallbackUntil: () => until,
    spawn: (command, args, options) => {
      calls.spawn.push({ command, args, env: options.env });
      return args[0] === "pages" ? { status: 0, stdout: pages } : { status: 0 };
    },
    probe: () => { const ok = up[Math.min(calls.probe, up.length - 1)]; calls.probe += 1; return ok; },
    agentInstalled: () => installed,
    kickstart: () => { calls.kickstart += 1; },
    sleep: () => {},
    lease: (spec) => { calls.leases.push(spec); },
    endLease: (id) => { calls.ended.push(id); },
    browserCommandLines: () => { calls.browserChecks = (calls.browserChecks ?? 0) + 1; return browser; },
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

test("the agent Chrome bridge runs under one notified lease that stop ends", () => {
  const env = { CHROME_DEVTOOLS_AXI_SESSION: "claude-1234abcd" };
  const { calls, deps, io } = harness();
  assert.equal(run(["open", "https://example.com"], env, deps, io), 0);
  assert.deepEqual(calls.leases.map(({ id, minutes, foreground }) => ({ id, minutes, foreground })), [{ id: "axi-claude-1234abcd", minutes: 35, foreground: false }]);
  assert.ok(calls.spawn.every((call) => call.env.AGENT_CHROME_SESSION === "axi-claude-1234abcd"));
  assert.equal(run(["newpage", PAGE, "--foreground"], env, deps, io), 0);
  assert.equal(calls.leases[1].foreground, true);
  assert.equal(run(["stop"], env, deps, io), 0);
  assert.deepEqual(calls.ended, ["axi-claude-1234abcd"]);
});

test("the axi lease outlasts the configured bridge idle timeout by five minutes", () => {
  for (const idle of [1000, 60000, 45 * 60000, 180 * 60000]) {
    const { calls, deps, io } = harness();
    assert.equal(run(["snapshot"], { CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS: String(idle) }, deps, io), 0);
    assert.equal(calls.leases[0].minutes * 60000, idle + 5 * 60000);
    let declaration;
    const session = require("../scripts/agent-chrome-session");
    const fs = require("node:fs");
    const dir = fs.mkdtempSync(join(require("node:os").tmpdir(), "axi-lease-"));
    try {
      declaration = session.lease(calls.leases[0], { dir: () => dir, now: () => 1000, notify: () => {}, log: () => {} });
      assert.equal(declaration.until, 1000 + idle + 5 * 60000);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test("the ungated Chrome port is refused with the gate URL before any browser work", () => {
  for (const url of ["http://127.0.0.1:9334", "ws://localhost:9334/devtools/browser/fixture"]) {
    const { calls, deps, io } = harness();
    assert.equal(run(["snapshot"], { CHROME_DEVTOOLS_AXI_BROWSER_URL: url }, deps, io), 2);
    assert.equal(calls.spawn.length, 0);
    assert.equal(calls.probe, 0);
    assert.deepEqual(calls.leases, []);
    assert.match(calls.stderr, /9334/);
    assert.ok(calls.stderr.includes(AGENT_CHROME_URL));
  }
});

test("a throwaway or other browser takes no agent Chrome lease", () => {
  for (const [options, env] of [[{ installed: false, up: [false] }, {}], [{}, { CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:9555" }]]) {
    const { calls, deps, io } = harness(options);
    run(["snapshot"], env, deps, io);
    assert.deepEqual(calls.leases, []);
  }
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
  // Chrome listens behind the gate, so the kickstart starts both launchd agents.
  const started = [];
  require("../scripts/chrome-devtools-axi").defaultDeps.kickstart((file, args) => started.push([file, args[1].replace(/^gui\/\d+\//, "")]));
  assert.deepEqual(started, [["/bin/launchctl", "com.myuser.agent-chrome"], ["/bin/launchctl", "com.myuser.agent-chrome-gate"]]);
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
  const { calls, deps, io } = harness({ until: 2000000000 });
  run(["snapshot"], { CLAUDE_CODE_SESSION_ID: "f1966707-fda6-48e2-8c1b-89d704b86cbc" }, deps, io);
  assert.equal(calls.spawn[0].env.CHROME_DEVTOOLS_AXI_SESSION, "claude-f1966707");
  assert.equal(calls.spawn[0].env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS, "1800000");
  const explicit = harness({ until: 2000000000 });
  run(["snapshot"], { CLAUDE_CODE_SESSION_ID: "f1966707", CHROME_DEVTOOLS_AXI_SESSION: "ui-owner",
    CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS: "0" }, explicit.deps, explicit.io);
  assert.equal(explicit.calls.spawn[0].env.CHROME_DEVTOOLS_AXI_SESSION, "ui-owner");
  assert.equal(explicit.calls.spawn[0].env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS, "0");
});

test("refuses an agent Chrome started without the no-extensions flags", () => {
  for (const [browser, env] of [
    [[UNFLAGGED], {}],
    [[`${CHROME_BETA} ${PROFILE} --remote-debugging-port=9333 --disable-sync`], {}],
    [[], {}],
    [[UNFLAGGED], { CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://localhost:9333" }],
  ]) {
    const { calls, deps, io } = harness({ browser });
    assert.equal(run(["open", "https://example.com"], env, deps, io), 1);
    assert.equal(calls.spawn.length, 0);
    assert.match(calls.stderr, /--disable-extensions/);
    assert.match(calls.stderr, /launchctl kickstart -k/);
  }
});

test("the flag check only runs for the agent Chrome", () => {
  const fallback = harness({ up: [false], installed: false, browser: [UNFLAGGED] });
  assert.equal(run(["open", "https://example.com"], {}, fallback.deps, fallback.io), 0);
  const other = harness({ browser: [UNFLAGGED] });
  assert.equal(run(["snapshot"], { CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:9555" }, other.deps, other.io), 0);
  const noBrowser = harness({ browser: [UNFLAGGED] });
  assert.equal(run(["stop"], {}, noBrowser.deps, noBrowser.io), 0);
  for (const h of [fallback, other, noBrowser]) assert.equal(h.calls.browserChecks, undefined);
});

// The design reviewer's phone check on 2026-10-11 (18:32 UTC). It shrank the
// window every agent shares, and its "390" shot came out 500px wide.
test("refuses resize and names the per-tab emulate command", () => {
  for (const env of [{}, { CHROME_DEVTOOLS_AXI_MAIN_CHROME: "1" }]) {
    const { calls, deps, io } = harness();
    assert.equal(run(["resize", "390", "844"], env, deps, io), 2);
    assert.equal(calls.spawn.length, 0);
    assert.match(calls.stderr, /emulate --viewport "390x844x3,mobile,touch"/);
    assert.match(calls.stderr, /--viewport "390x844x1"/);
  }
  const other = harness();
  assert.equal(run(["resize", "1440", "900"], { CHROME_DEVTOOLS_AXI_BROWSER_URL: "" }, other.deps, other.io), 0);
  assert.deepEqual(other.calls.spawn[0].args, ["resize", "1440", "900"]);
  const help = harness();
  assert.equal(run(["resize", "--help"], {}, help.deps, help.io), 0);
});

test("newpage opens in the background unless the owner has to see it", () => {
  const { calls, deps, io } = harness();
  run(["newpage", "https://example.com", "--full"], {}, deps, io);
  assert.deepEqual(calls.spawn.at(-1).args, ["newpage", "https://example.com", "--full", "--background"]);
  for (const command of ["newpage", "open"]) {
    const front = harness();
    run([command, "https://example.com", "--foreground"], {}, front.deps, front.io);
    assert.deepEqual(front.calls.spawn.map((c) => c.args), [["newpage", "https://example.com"]]);
  }
});

// The agenttrail thread's first command on its review page, 2026-10-11 19:02
// UTC. With no tab of its own, axi opened it in front of the owner's windows.
test("open gives a session without a tab a background one first", () => {
  const { calls, deps, io } = harness();
  const env = { CHROME_DEVTOOLS_AXI_SESSION: "claude-f1966707" };
  assert.equal(run(["open", PAGE], env, deps, io), 0);
  const [pages, blank, open] = calls.spawn.map((c) => c.args);
  assert.deepEqual(pages, ["pages"]);
  assert.match(blank[1], /^about:blank#claude-f1966707-[0-9a-f]{8}$/);
  assert.deepEqual(blank, ["newpage", blank[1], "--background"]);
  assert.deepEqual(open, ["open", PAGE]);
  for (const call of calls.spawn) assert.equal(call.env.CHROME_DEVTOOLS_AXI_BROWSER_URL, AGENT_CHROME_URL);
  const script = harness();
  run(["run"], env, script.deps, script.io);
  assert.equal(script.calls.spawn[1].args[0], "newpage");
});

test("open navigates the session's own tab in place", () => {
  const { calls, deps, io } = harness({ pages: OWN_TAB });
  run(["open", PAGE], {}, deps, io);
  assert.deepEqual(calls.spawn.map((c) => c.args), [["pages"], ["open", PAGE]]);
});

test("the launchd agent and session env match the wrapper", () => {
  const nix = readFileSync(join(__dirname, "../nix/user.nix"), "utf8");
  // Agents use the gate's port; Chrome itself listens behind it.
  const gate = require("../scripts/agent-chrome-gate");
  assert.equal(Number(new URL(AGENT_CHROME_URL).port), gate.LISTEN_PORT);
  assert.match(nix, new RegExp(`"--remote-debugging-port=${gate.CHROME_PORT}"`));
  assert.match(nix, /Label = "com\.myuser\.agent-chrome-gate";\n\s+ProgramArguments = \[ "\$\{pkgs\.nodejs_22\}\/bin\/node" "\$\{config\.home\.homeDirectory\}\/dotfiles\/scripts\/agent-chrome-gate" \];/);
  assert.match(nix, new RegExp(`Label = "${AGENT_CHROME_LABEL.replace(/\./g, "\\.")}";`));
  assert.match(nix, new RegExp(`CHROME_DEVTOOLS_AXI_BROWSER_URL = "${AGENT_CHROME_URL}";`));
  assert.deepEqual(AGENT_CHROME_FLAGS, ["--disable-extensions", "--disable-sync"]);
  for (const flag of AGENT_CHROME_FLAGS) assert.match(nix, new RegExp(`^\\s+"${flag}"$`, "m"));
});

// Replay the Phase C command without contacting or starting a browser.
test("Phase C phone command refuses both agent harnesses before any browser work", () => {
  for (const env of [{ CLAUDECODE: "1" }, { CODEX_THREAD_ID: "fixture-thread" }, { CODEX_CI: "1" }]) {
    const { calls, deps, io } = harness();
    assert.equal(run(["emulate", "--viewport", "390x844x3,mobile,touch"], env, deps, io), 2);
    assert.equal(calls.spawn.length, 0);
    assert.equal(calls.probe, 0);
    assert.match(calls.stderr, /codex-computer-use/);
  }
});
