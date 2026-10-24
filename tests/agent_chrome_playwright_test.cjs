require("./lib/agent-chrome-test-env.cjs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { run } = require("../scripts/agent-chrome-playwright");

function harness({ ready = true, identityError = null, attach = true, windowless = false } = {}) {
  const calls = [];
  let marker;
  const listeners = {};
  const page = { url: () => marker, on: (event, listener) => { listeners[event] = listener; }, emit: (event, value) => listeners[event]?.(value) };
  const deps = {
    ready: () => { calls.push("ready"); return ready; },
    identityError: () => identityError,
    openTab: async (url) => {
      calls.push(["Target.createTarget", { url, background: true }]);
      marker = url;
      return {
        targetId: "own-target",
        close: async () => { calls.push(["Target.closeTarget", { targetId: "own-target" }]); },
        release: async () => { calls.push("release"); },
      };
    },
    connect: async () => {
      calls.push("connect");
      // Chrome unloads its profile when its last window closes; until a tab
      // loads it again, Playwright's attach fails with Chrome's own error.
      if (windowless && !marker) throw new Error("browserType.connectOverCDP: Protocol error (Browser.setDownloadBehavior): Browser context management is not supported.");
      return {
        contexts: () => [{ pages: () => attach ? [{ url: () => "https://other-tab.example" }, page] : [] }],
        close: async () => { calls.push("disconnect"); },
      };
    },
    targetId: async (tab) => (tab === page ? "own-target" : tab.targetId),
    keepTab: async (targetId, why) => { calls.push(["keep", targetId, why]); },
    sleep: async () => {},
    log: (message) => calls.push(["log", message]),
  };
  return { calls, page, deps };
}

test("a written flow gets only its own background tab and closes that target before disconnecting", async () => {
  const { calls, page, deps } = harness();
  assert.equal(await run(async (actual) => { assert.equal(actual, page); return "read"; }, deps), "read");
  assert.equal(calls[0], "ready");
  assert.equal(calls[1][0], "Target.createTarget");
  assert.equal(calls[1][1].background, true);
  assert.equal(calls[2], "connect");
  assert.deepEqual(calls.slice(-2), [["Target.closeTarget", { targetId: "own-target" }], "disconnect"]);
});

test("failed flows and attachment timeouts still clean up only the owned tab", async () => {
  for (const attach of [true, false]) {
    const { calls, deps } = harness({ attach });
    await assert.rejects(run(async () => { throw new Error("failed flow"); }, deps), attach ? /failed flow/ : /did not attach/);
    assert.deepEqual(calls.slice(-2), [["Target.closeTarget", { targetId: "own-target" }], "disconnect"]);
  }
});

test("a windowless agent Chrome: the flow's tab is opened before Playwright attaches, so the attach finds a browser context", async () => {
  const { calls, page, deps } = harness({ windowless: true });
  assert.equal(await run(async (actual) => { assert.equal(actual, page); return "read"; }, deps), "read");
  assert.deepEqual(calls.map((call) => (Array.isArray(call) ? call[0] : call)).slice(0, 3), ["ready", "Target.createTarget", "connect"]);
  assert.deepEqual(calls.slice(-2), [["Target.closeTarget", { targetId: "own-target" }], "disconnect"]);
});

test("a failed attach still closes the tab the runner opened", async () => {
  const { calls, deps } = harness();
  await assert.rejects(run(async () => assert.fail("must not run"), { ...deps, connect: async () => { calls.push("connect"); throw new Error("attach failed"); } }), /attach failed/);
  assert.deepEqual(calls.slice(-2), ["connect", ["Target.closeTarget", { targetId: "own-target" }]]);
});

test("a Chrome or gate that never answers fails the tab opening instead of hanging the run", async (t) => {
  const http = require("node:http");
  const { openBackgroundTab } = require("../scripts/agent-chrome-playwright");
  const server = http.createServer(() => {}).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  server.on("connection", (socket) => t.after(() => socket.destroy()));
  await assert.rejects(openBackgroundTab("about:blank#x", `http://127.0.0.1:${server.address().port}`, 200), /did not answer within 0\.2s/);
});

// A CDP deadline longer than any test's timeout: a test that passes it fails
// by timing out if the runner waits instead of acting on what it was sent.
const NEVER = 120000;

// A local stand-in for the agent Chrome behind the gate. By default it answers
// /json/version and accepts the WebSocket; `command` gets each CDP command
// and a reply function, and answers nothing unless it calls it.
async function fakeChrome(t, { version, upgrade, command = () => {} } = {}) {
  const http = require("node:http");
  const { createHash } = require("node:crypto");
  const { frameHeader, unmask, encodeFrame } = require("../scripts/agent-chrome-gate");
  const sockets = new Set();
  const closed = [];
  const server = http.createServer((req, res) => {
    if (version) return version(req, res);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake` }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
  });
  server.on("upgrade", (req, socket) => {
    // The runner hanging up shows as the end of what it sends.
    closed.push(new Promise((resolve) => { socket.once("end", resolve); socket.once("close", resolve); }));
    if (upgrade) return upgrade(req, socket);
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (let header = frameHeader(buffered); header && buffered.length >= header.size + header.length; header = frameHeader(buffered)) {
        const payload = unmask(buffered.subarray(header.size, header.size + header.length), header.mask);
        buffered = buffered.subarray(header.size + header.length);
        if (header.opcode !== 1) continue;
        const message = JSON.parse(payload.toString("utf8"));
        command(message, (result) => socket.write(encodeFrame(JSON.stringify({ id: message.id, result }))), socket);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}`, closed };
}

test("a WebSocket upgrade that is never answered fails the tab opening", async (t) => {
  const { openBackgroundTab } = require("../scripts/agent-chrome-playwright");
  const chrome = await fakeChrome(t, { upgrade: () => {} });
  await assert.rejects(openBackgroundTab("about:blank#x", chrome.url, { default: NEVER, "Opening a CDP connection": 200 }), /Opening a CDP connection: the agent Chrome did not answer within 0\.2s/);
});

test("the CLI exits once it has reported, whatever the flow left open", { timeout: 60000 }, async (t) => {
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const dir = fs.mkdtempSync(join(tmpdir(), "agent-chrome-playwright-flow-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Fails before any session or browser work, with a timer still running.
  // Its 4 MiB on stderr is still queued when the runner reports: pipes on
  // macOS are written asynchronously, so an exit that does not wait for the
  // flush loses the rest, the runner's own error line included.
  const flow = join(dir, "flow.cjs");
  const printed = "x".repeat(1 << 22) + "\n";
  fs.writeFileSync(flow, `process.stderr.write(${JSON.stringify(printed)});\nsetInterval(() => {}, 1000);\nmodule.exports = 'not a function';\n`);
  const child = spawn(require.resolve("../scripts/agent-chrome-playwright"), ["--minutes", "1", "--what", "test", flow], { stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  // The interval keeps a runner that does not exit alive until the test times out.
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 1);
  assert.ok(stderr.startsWith(printed), `stderr has ${stderr.length} of the flow's ${printed.length} characters`);
  assert.match(stderr.slice(printed.length), /must export a function/);
});

test("a second signal exits through the session's stop, after its notice and with 128 + the second signal", { timeout: 60000 }, async (t) => {
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const session = require("../scripts/agent-chrome-session");
  const home = fs.mkdtempSync(join(tmpdir(), "agent-chrome-playwright-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const log = join(home, "notices");
  // The flow is still running at the second signal and ends while the
  // stopped notice is going out: the notice fails it, then waits for the
  // runner's output to flush. The log records the flow's end, the notice and
  // the exit in the order they happen, so an exit before the notice fails.
  // The second signal is a SIGTERM after a SIGINT: the session's stop exits
  // 143 for it, where the CLI's own exit would give 130 for the first.
  const flow = join(home, "flow.cjs");
  fs.writeFileSync(flow, `module.exports = () => new Promise((_, failed) => {
  process.once("SIGINT", () => process.kill(process.pid, "SIGTERM"));
  global.failFlow = () => { require("node:fs").appendFileSync(${JSON.stringify(log)}, "flow ended\\n"); failed(new Error("Target page, context or browser has been closed")); };
  process.kill(process.pid, "SIGINT");
});\n`);
  const script = `
    const fs = require('node:fs');
    const { cli } = require(${JSON.stringify(require.resolve("../scripts/agent-chrome-playwright"))});
    const session = require(${JSON.stringify(require.resolve("../scripts/agent-chrome-session"))});
    let marker;
    // The notice waits on the runner's output, which holds no handle.
    setInterval(() => {}, 1000);
    process.on('exit', (code) => fs.appendFileSync(${JSON.stringify(log)}, 'exit ' + code + '\\n'));
    cli(['--minutes', '1', '--what', 'flow', ${JSON.stringify(flow)}], {
      ready: () => true, identityError: () => null, sleep: async () => {}, log: () => {},
      openTab: async (url) => { marker = url; return { targetId: 'own-target', close: async () => {} }; },
      connect: async () => ({ contexts: () => [{ pages: () => [{ url: () => marker, on: () => {} }] }], close: async () => {} }),
    }, {
      dir: () => session.stateDir(${JSON.stringify(home)}), now: Date.now, log: () => {},
      notify: async (message) => {
        if (global.failFlow) {
          global.failFlow();
          // The run ends meanwhile; the notice waits for its output to flush.
          await new Promise((resolve) => process.stdout.write('', () => process.stderr.write('', () => setImmediate(resolve))));
        }
        fs.appendFileSync(${JSON.stringify(log)}, message + '\\n');
      },
    });
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: "ignore", env: { ...process.env, [session.ENV]: "" } });
  t.after(() => child.kill("SIGKILL"));
  const code = await new Promise((resolve) => child.once("exit", (exitCode, signal) => resolve(exitCode ?? signal)));
  assert.equal(code, 143);
  const events = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => line.replace(/ after .*/, " after"));
  assert.deepEqual(events, ["flow. About 1 min, background tabs only.", "flow ended", "flow: stopped after", "exit 143"]);
  assert.deepEqual(fs.readdirSync(session.stateDir(home)), []);
});

test("a malformed CDP message from the peer fails the pending command instead of the process", { timeout: 60000 }, async (t) => {
  const { randomBytes } = require("node:crypto");
  const { encodeFrame } = require("../scripts/agent-chrome-gate");
  const { openBackgroundTab } = require("../scripts/agent-chrome-playwright");
  // Not JSON, JSON that is not an object, and a masked frame, which a server must never send.
  for (const frame of [encodeFrame("not json"), encodeFrame("null"), encodeFrame(JSON.stringify({ id: 1, result: { targetId: "own-target" } }), randomBytes(4))]) {
    const chrome = await fakeChrome(t, { command: (message, reply, socket) => socket.write(frame) });
    await assert.rejects(openBackgroundTab("about:blank#x", chrome.url, NEVER), /Target\.createTarget: the agent Chrome sent a malformed CDP message/);
  }
});

test("a 101 without the right Sec-WebSocket-Accept fails the handshake at once", { timeout: 60000 }, async (t) => {
  const { openBackgroundTab } = require("../scripts/agent-chrome-playwright");
  for (const accept of ["", "Sec-WebSocket-Accept: d3Jvbmc=\r\n"]) {
    const chrome = await fakeChrome(t, { upgrade: (req, socket) => socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${accept}\r\n`) });
    // "At once": with no deadline before the test's own, waiting fails the test.
    await assert.rejects(openBackgroundTab("about:blank#x", chrome.url, NEVER), /did not complete the WebSocket handshake/);
  }
});

test("a /json/version body that never ends fails the tab opening", { timeout: 60000 }, async (t) => {
  const { openBackgroundTab } = require("../scripts/agent-chrome-playwright");
  const chrome = await fakeChrome(t, { version: (req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.write("{"); } });
  await assert.rejects(openBackgroundTab("about:blank#x", chrome.url, 200), /Reading \/json\/version: the agent Chrome did not answer within 0\.2s/);
});

test("a peer that takes the WebSocket but never answers: createTarget times out and the connection is let go", { timeout: 60000 }, async (t) => {
  const { openBackgroundTab } = require("../scripts/agent-chrome-playwright");
  const chrome = await fakeChrome(t);
  await assert.rejects(openBackgroundTab("about:blank#x", chrome.url, { default: NEVER, "Target.createTarget": 200, "Target.getTargets": 200 }), /Target\.createTarget: the agent Chrome did not answer within 0\.2s/);
  // Waiting on the closing handshake kept the process alive for good.
  // A runner that waits for the handshake never closes it; the test times out.
  await chrome.closed[0];
});

test("a runner that cannot reach the agent Chrome exits instead of hanging", { timeout: 60000 }, async (t) => {
  const { spawn } = require("node:child_process");
  const chrome = await fakeChrome(t);
  const child = spawn(process.execPath, ["-e", `require(${JSON.stringify(require.resolve("../scripts/agent-chrome-playwright"))}).openBackgroundTab("about:blank#x", ${JSON.stringify(chrome.url)}, { default: ${NEVER}, "Target.createTarget": 200, "Target.getTargets": 200 }).catch(() => {})`], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  // A runner kept alive by its socket never exits; the test times out.
  await new Promise((resolve) => child.once("exit", resolve));
});

test("closing the tab after the agent Chrome dropped the connection fails at once", { timeout: 60000 }, async (t) => {
  const { openBackgroundTab } = require("../scripts/agent-chrome-playwright");
  const chrome = await fakeChrome(t, {
    command: (message, reply, socket) => {
      reply({ targetId: "own-target" });
      setTimeout(() => socket.destroy(), 50);
    },
  });
  const tab = await openBackgroundTab("about:blank#x", chrome.url, NEVER);
  await chrome.closed[0];
  // "At once": with no deadline before the test's own, waiting fails the test.
  await assert.rejects(tab.close(), /Target\.closeTarget: the agent Chrome closed the connection/);
});

test("a tab whose createTarget answer comes too late is found by its marker and closed", { timeout: 60000 }, async (t) => {
  const { openBackgroundTab } = require("../scripts/agent-chrome-playwright");
  const closedTargets = [];
  const marker = "about:blank#screen-free-late";
  const chrome = await fakeChrome(t, {
    command: (message, reply) => {
      if (message.method === "Target.getTargets") reply({ targetInfos: [{ targetId: "other", url: "https://other.example" }, { targetId: "late", url: marker }] });
      if (message.method === "Target.closeTarget") {
        closedTargets.push(message.params.targetId);
        reply({ success: true });
      }
    },
  });
  await assert.rejects(openBackgroundTab(marker, chrome.url, { default: NEVER, "Target.createTarget": 200 }), /Target\.createTarget: the agent Chrome did not answer/);
  assert.deepEqual(closedTargets, ["late"]);
});

test("the gate's refusal text reaches the runner's error", async (t) => {
  const { openBackgroundTab } = require("../scripts/agent-chrome-playwright");
  const refusal = "agent-chrome-gate: refused. the owner is told before any agent uses the agent Chrome, and this process did not tell him.";
  const ws = await fakeChrome(t, {
    upgrade: (req, socket) => socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(refusal)}\r\nConnection: close\r\n\r\n${refusal}`),
  });
  await assert.rejects(openBackgroundTab("about:blank#x", ws.url, 2000), (error) => error.message.includes(refusal));
  const version = await fakeChrome(t, { version: (req, res) => res.writeHead(403, { "Content-Type": "text/plain" }).end(refusal) });
  await assert.rejects(openBackgroundTab("about:blank#x", version.url, 2000), (error) => error.message.includes("403") && error.message.includes(refusal));
});

function stubPnpm(t, script) {
  const fs = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const bin = fs.mkdtempSync(join(tmpdir(), "agent-chrome-pnpm-"));
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
    fs.rmSync(bin, { recursive: true, force: true });
  });
  const write = (body) => fs.writeFileSync(join(bin, "pnpm"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  write(script);
  return { bin, write };
}

const PNPM_LISTING = JSON.stringify([{ path: "/pnpm/global", dependencies: { "playwright-core": { version: "1.0.0", path: "/pnpm/global/node_modules/playwright-core" } } }], null, 2);

test("pnpm output around the global listing does not break finding playwright-core", (t) => {
  const { playwrightDirectory } = require("../scripts/agent-chrome-playwright");
  // pnpm 12 prints warnings on stdout, such as this one inside a project that
  // pins packageManager (job-tracker, 2026-10-22).
  const pnpm = stubPnpm(t, `echo "[WARN] Using --global skips the package manager check for this project"
cat <<'JSON'
${PNPM_LISTING}
JSON
echo "WARN  a trailing notice"`);
  assert.equal(playwrightDirectory(), "/pnpm/global/node_modules/playwright-core");
  // Lines after the listing that end in "]", or are an array of their own,
  // are not part of it.
  for (const after of ['echo "WARN  see the docs [https://pnpm.io]"', "echo '[]'", "printf '[WARN] crlf\\r\\n'"]) {
    pnpm.write(`cat <<'JSON'\n${PNPM_LISTING}\nJSON\n${after}`);
    assert.equal(playwrightDirectory(), "/pnpm/global/node_modules/playwright-core", after);
  }
  // An empty global listing is one line; the runner then names the missing package.
  pnpm.write("echo '[]'");
  assert.throws(() => playwrightDirectory(), /playwright-core is missing/);
});

test("pnpm runs from the home directory, outside any project that pins packageManager", (t) => {
  const fs = require("node:fs");
  const { join } = require("node:path");
  const { homedir } = require("node:os");
  const { playwrightDirectory } = require("../scripts/agent-chrome-playwright");
  const pnpm = stubPnpm(t, "");
  const where = join(pnpm.bin, "cwd");
  pnpm.write(`pwd -P > '${where}'\ncat <<'JSON'\n${PNPM_LISTING}\nJSON`);
  playwrightDirectory();
  assert.equal(fs.readFileSync(where, "utf8").trim(), fs.realpathSync(homedir()));
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

test("a stop while the tab opens closes it without attaching Playwright", async () => {
  const { calls, deps } = harness();
  const stopping = new AbortController();
  const openTab = deps.openTab;
  deps.openTab = async (url) => { const tab = await openTab(url); stopping.abort(); return tab; };
  await assert.rejects(run(async () => assert.fail("must not run"), { ...deps, signal: stopping.signal }), /Stopped before/);
  assert.deepEqual(calls.map((call) => (Array.isArray(call) ? call[0] : call)), ["ready", "Target.createTarget", "Target.closeTarget"]);
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

test("a stop during blocking readiness opens no tab and reports stopped", { timeout: 60000 }, async (t) => {
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
  // No deadline: a readiness child that never starts fails by the test's timeout.
  while (!fs.existsSync(marker) && child.exitCode === null) await sleep(25);
  assert.ok(fs.existsSync(marker), "readiness child started");
  process.kill(-child.pid, "SIGINT");
  assert.equal(await gone, 1);
  assert.equal(fs.existsSync(join(home, "connected")), false);
  assert.match(fs.readFileSync(log, "utf8"), /flow: stopped after/);
});

// Runs a flow through the agent-chrome-session CLI (twice when nested), as the
// rules require, waits for the runner to reach `phase`, then signals the
// session's process group as a terminal's Ctrl-C does, or only its pid.
// Attaching (the connect phase) and opening the tab (the create phase) last
// until the runner has had the signal, so the stop always lands mid-step.
// Attaching then ends 1s later, and in the create phase the tab opens
// `createDelay` ms later; "stderr" waits
// for the runner's stopping line instead, "never" never opens it, and
// "release" opens it only once the test has seen the run end.
// direct runs the runner without agent-chrome-session around it; second sends
// the signal again that many ms later; kill SIGKILLs the group that many ms
// after the signal, as a harness does after its grace period.
// How long a second signal waits for the tab is recorded in `patience`.
async function stopUnderSession(t, { phase, nested = false, direct = false, group = true, signal = "SIGINT", createDelay = 1000, second, kill }) {
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const session = require("../scripts/agent-chrome-session");
  const home = fs.mkdtempSync(join(tmpdir(), "agent-chrome-playwright-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const events = join(home, "events");
  const log = join(home, "notices");
  // Like a Playwright page, the flow ends when its tab closes, and its
  // connection keeps the process alive until then.
  const flow = join(home, "flow.cjs");
  fs.writeFileSync(flow, `module.exports = () => new Promise((_, failed) => {
  setInterval(() => {}, 1000);
  global.tabClosed = () => failed(new Error("Target page, context or browser has been closed"));
  require("node:fs").appendFileSync(${JSON.stringify(events)}, "flow started\\n");
});\n`);
  // Attaching and closing take a while, as they do through the gate.
  const runner = join(home, "runner.cjs");
  fs.writeFileSync(runner, `
    const fs = require("node:fs");
    const { setTimeout: sleep } = require("node:timers/promises");
    const { cli } = require(${JSON.stringify(require.resolve("../scripts/agent-chrome-playwright"))});
    const event = (name) => fs.appendFileSync(${JSON.stringify(events)}, name + "\\n");
    fs.writeFileSync(${JSON.stringify(join(home, "runner.pid"))}, String(process.pid));
    // Waiting on a signal holds no handle; this keeps the runner up meanwhile.
    setInterval(() => {}, 1000);
    const signalled = new Promise((resolve) => { for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(name, resolve); });
    const said = new Promise((resolve) => {
      const write = process.stderr.write.bind(process.stderr);
      process.stderr.write = (text, ...rest) => { if (String(text).includes("stopping:")) resolve(); return write(text, ...rest); };
    });
    const released = async () => { while (!fs.existsSync(${JSON.stringify(join(home, "release"))})) await sleep(25); };
    const opened = { stderr: () => said, never: () => new Promise(() => {}), release: released }[${JSON.stringify(String(createDelay))}] ?? (() => sleep(${Number(createDelay) || 0}));
    let marker;
    cli(["--minutes", "1", "--what", "flow", ${JSON.stringify(flow)}], {
      ready: () => true, identityError: () => null, sleep: async () => {}, log: () => {},
      patience: (ms) => { fs.appendFileSync(${JSON.stringify(join(home, "patience"))}, ms + "\\n"); return sleep(ms); },
      openTab: async (url) => { marker = url; ${phase === "create" ? `event("opening"); await signalled; await opened();` : ""} return { targetId: "own-target", close: async () => { await sleep(200); event("tab closed"); global.tabClosed?.(); } }; },
      connect: async () => {
        event("connecting");
        ${phase === "connect" ? "await signalled; await sleep(1000);" : ""}
        return { contexts: () => [{ pages: () => [{ url: () => marker, on: () => {} }] }], close: async () => {} };
      },
    });
  `);
  const wrap = [require.resolve("../scripts/agent-chrome-session"), "--minutes", "1", "--what", "flow", "--"];
  const command = direct ? [runner] : [...wrap, ...(nested ? [process.execPath, ...wrap] : []), process.execPath, runner];
  // Its own process group, so the test can signal it as a terminal's Ctrl-C does.
  const child = spawn(process.execPath, command, {
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
    env: { ...process.env, AGENT_CHROME_STATE_HOME: home, AGENT_CHROME_SESSION_TEST_NOTIFY_LOG: log, [session.ENV]: "" },
  });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve(code ?? signal)));
  const reached = { connect: "connecting", create: "opening" }[phase] ?? "flow started";
  const seen = () => fs.existsSync(events) && fs.readFileSync(events, "utf8").includes(reached);
  // No deadline: a runner that never gets there fails by the test's timeout.
  while (!seen() && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(child.exitCode, null, `the runner reached "${reached}" and is still running`);
  const target = group ? -child.pid : child.pid;
  process.kill(target, signal);
  if (second !== undefined) setTimeout(() => process.kill(target, signal), second);
  if (kill !== undefined) setTimeout(() => process.kill(target, "SIGKILL"), kill);
  const code = await exit;
  const read = (name) => (fs.existsSync(join(home, name)) ? fs.readFileSync(join(home, name), "utf8").trim().split("\n").filter(Boolean) : []);
  return { code, stderr, home, log, events: read("events"), patience: read("patience"), runner: Number(read("runner.pid")[0]), notices: fs.readFileSync(log, "utf8"), left: fs.readdirSync(session.stateDir(home)) };
}

// Review r3 of agent-chrome-playwright-attach: under agent-chrome-session, the
// route the rules require, the runner had no signal handling of its own, so a
// Ctrl-C killed it before it closed its tab.
test("one Ctrl-C under agent-chrome-session closes the flow's tab and the session still says done", { timeout: 60000 }, async (t) => {
  const result = await stopUnderSession(t, { phase: "flow" });
  assert.deepEqual(result.events, ["connecting", "flow started", "tab closed"]);
  assert.equal(result.code, 130);
  assert.match(result.notices, /flow: stopped after/);
  assert.deepEqual(result.left, []);
});

// Review r1 of playwright-session-signals: the session forwards the Ctrl-C the
// runner already got, and that second copy exited before anything closed the
// tab opened for the attach.
test("one Ctrl-C while Playwright attaches still closes the flow's tab", { timeout: 60000 }, async (t) => {
  const result = await stopUnderSession(t, { phase: "connect" });
  assert.deepEqual(result.events, ["connecting", "tab closed"]);
  assert.equal(result.code, 130);
  assert.match(result.notices, /flow: stopped after/);
  assert.deepEqual(result.left, []);
});

// Review r2 of playwright-session-signals: a stop while the tab was still
// opening did not wait for it, so the tab opened after the runner had gone.
for (const nested of [false, true]) {
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    test(`${signal} under ${nested ? "a nested session" : "agent-chrome-session"} while the tab opens still closes it`, { timeout: 60000 }, async (t) => {
      const result = await stopUnderSession(t, { phase: "create", nested, signal });
      assert.deepEqual(result.events, ["opening", "tab closed"]);
      assert.equal(result.code, code);
      assert.match(result.notices, /flow: stopped after/);
      assert.deepEqual(result.left, []);
    });
  }
}

// Review r2 of playwright-session-signals: the runner waited 3s for the tab
// and then exited, but a createTarget may take up to its 15s deadline.
test("one Ctrl-C under agent-chrome-session waits for a slow tab to open and closes it", { timeout: 60000 }, async (t) => {
  const result = await stopUnderSession(t, { phase: "create", createDelay: 4500 });
  assert.deepEqual(result.events, ["opening", "tab closed"]);
  assert.equal(result.code, 130);
  assert.match(result.notices, /flow: stopped after/);
  assert.deepEqual(result.left, []);
});

// Review r1 of playwright-session-signals: the inner session took the outer
// one's forward as a second Ctrl-C and SIGKILLed the runner.
test("one Ctrl-C under a nested session closes the flow's tab", { timeout: 60000 }, async (t) => {
  const result = await stopUnderSession(t, { phase: "flow", nested: true });
  assert.deepEqual(result.events, ["connecting", "flow started", "tab closed"]);
  assert.equal(result.code, 130);
  assert.match(result.notices, /flow: stopped after/);
  assert.deepEqual(result.left, []);
});

// Review r1 of playwright-session-signals: a runner stopped by one signal
// exited 1, and the owner was told the flow failed.
test("a signal sent only to the session is reported stopped, not failed", { timeout: 60000 }, async (t) => {
  const result = await stopUnderSession(t, { phase: "flow", group: false });
  assert.deepEqual(result.events, ["connecting", "flow started", "tab closed"]);
  assert.equal(result.code, 130);
  assert.match(result.notices, /flow: stopped after/);
  assert.deepEqual(result.left, []);
});

// Review r3 of agent-chrome-playwright-attach: a flow that closed its own tab
// made the runner's Target.closeTarget fail, and the run exited 1.
test("a flow that ends with page.close() succeeds, and the runner still closes a tab that is open", { timeout: 60000 }, async (t) => {
  const { encodeFrame } = require("../scripts/agent-chrome-gate");
  const { openBackgroundTab } = require("../scripts/agent-chrome-playwright");
  const open = new Set();
  const chrome = await fakeChrome(t, {
    command: (message, reply, socket) => {
      if (message.method === "Target.createTarget") {
        open.add("own-target");
        reply({ targetId: "own-target" });
      }
      if (message.method !== "Target.closeTarget") return;
      // What Chrome answers for a target that is gone.
      if (!open.delete(message.params.targetId)) socket.write(encodeFrame(JSON.stringify({ id: message.id, error: { code: -32602, message: "No target with given id found" } })));
      else reply({ success: true });
    },
  });
  for (const closesItself of [true, false]) {
    const { calls, page, deps } = harness();
    page.close = async () => { open.delete("own-target"); };
    // The harness's openTab only records the marker; the tab is the fake Chrome's.
    const openTab = async (marker) => { await deps.openTab(marker); return openBackgroundTab(marker, chrome.url, NEVER); };
    assert.equal(await run(async (own) => { if (closesItself) await own.close(); return "read"; }, { ...deps, openTab }), "read");
    assert.equal(open.size, 0);
    assert.equal(calls.at(-1), "disconnect");
  }
});

// Review r3 of playwright-session-signals: nothing pinned the 3s wait for a
// second Ctrl-C when the runner runs directly; at 15s it waited for the tab.
// The tab never opens, so only the 3s wait can end the run.
test("run directly, a second Ctrl-C while the tab opens exits after 3s", { timeout: 60000 }, async (t) => {
  const result = await stopUnderSession(t, { phase: "create", direct: true, createDelay: "never", second: 100 });
  assert.equal(result.code, 130);
  assert.deepEqual(result.patience, ["3000"]);
  assert.deepEqual(result.events, ["opening"]);
  assert.match(result.notices, /flow: stopped after/);
});

// Review r3 of playwright-session-signals: one Ctrl-C against a slow Chrome
// waited up to 15s under a session and printed nothing meanwhile.
test("one Ctrl-C that waits for the agent Chrome says so on stderr", { timeout: 60000 }, async (t) => {
  // The tab opens only once the runner has said it is waiting for it.
  const result = await stopUnderSession(t, { phase: "create", createDelay: "stderr" });
  assert.equal(result.code, 130);
  assert.deepEqual(result.events, ["opening", "tab closed"]);
  assert.match(result.stderr, /^agent-chrome-playwright: stopping: closing the flow's tab once the agent Chrome answers \(it has 15s per step\)\. Ctrl-C again stops now, and the gate closes the tab when the run ends\.$/m);
  const quick = await stopUnderSession(t, { phase: "flow" });
  assert.equal(quick.code, 130);
  assert.doesNotMatch(quick.stderr, /stopping:/);
});

// Review r3 of playwright-session-signals: a harness that sends SIGTERM and
// SIGKILLs the group before a slow createTarget answers kills the session
// before its notice. The gate's sweep must then say done, and nothing may run on.
test("a harness SIGTERM then SIGKILL during a slow tab opening leaves the done notice to the gate's sweep", { timeout: 60000 }, async (t) => {
  const result = await stopUnderSession(t, { phase: "create", signal: "SIGTERM", createDelay: "release", kill: 500 });
  assert.equal(result.code, "SIGKILL");
  assert.deepEqual(result.events, ["opening"]);
  assert.doesNotMatch(result.notices, /stopped after/);
  assert.equal(result.left.length, 1);
  // The watchdog takes the runner down with the session, so the tab's late
  // opening never comes: a runner still alive opens and closes it once
  // released, then exits.
  const fs = require("node:fs");
  fs.writeFileSync(require("node:path").join(result.home, "release"), "");
  assert.ok(Number.isInteger(result.runner) && result.runner > 1, `runner pid ${result.runner}`);
  const alive = () => { try { process.kill(result.runner, 0); return true; } catch { return false; } };
  // The runner has its own group, out of the t.after kill's reach; the signal ends the poll.
  while (alive()) await require("node:timers/promises").setTimeout(25, undefined, { signal: t.signal });
  assert.deepEqual(fs.readFileSync(require("node:path").join(result.home, "events"), "utf8").trim().split("\n"), ["opening"]);
  const session = require("../scripts/agent-chrome-session");
  const notices = [];
  await session.sweep({ dir: () => session.stateDir(result.home), notify: async (message) => { notices.push(message); }, log: () => {}, now: Date.now });
  assert.equal(notices.length, 1);
  assert.match(notices[0], /^flow: stopped without saying so after/);
  assert.deepEqual(require("node:fs").readdirSync(session.stateDir(result.home)), []);
});

// Review r1 of agent-chrome-session-orphans: a flow had no way to leave a tab
// open for the owner once the gate closed a session's tabs.
test("keep(tab, why) asks the gate to keep that tab, and the runner still closes its own tab unless it was kept", async () => {
  const other = { targetId: "form-target" };
  const { calls, deps } = harness();
  await run(async (page, { keep }) => { await keep(other, "form for the owner"); }, deps);
  assert.deepEqual(calls.filter((call) => call[0] === "keep"), [["keep", "form-target", "form for the owner"]]);
  assert.deepEqual(calls.slice(-2), [["Target.closeTarget", { targetId: "own-target" }], "disconnect"]);
  const own = harness();
  await run(async (page, { keep }) => { await keep(page, "sign-in for the owner"); }, own.deps);
  assert.deepEqual(own.calls.slice(-3), [["keep", "own-target", "sign-in for the owner"], "release", "disconnect"]);
  // A refusal fails the flow, and the tab it asked about is not treated as kept.
  const refused = harness();
  refused.deps.keepTab = async () => { throw new Error("agent-chrome-gate: refused to keep tab own-target"); };
  await assert.rejects(run(async (page, { keep }) => { await keep(page, "x"); }, refused.deps), /refused to keep/);
  assert.deepEqual(refused.calls.slice(-2), [["Target.closeTarget", { targetId: "own-target" }], "disconnect"]);
});

test("the default keep reads the page's own target id over a CDP session it then detaches", async () => {
  const { targetIdOf } = require("../scripts/agent-chrome-playwright");
  const sent = [];
  const page = { context: () => ({ newCDPSession: async (target) => {
    assert.equal(target, page);
    return { send: async (method) => { sent.push(method); return { targetInfo: { targetId: "T1" } }; }, detach: async () => { sent.push("detach"); } };
  } }) };
  assert.equal(await targetIdOf(page), "T1");
  assert.deepEqual(sent, ["Target.getTargetInfo", "detach"]);
});
