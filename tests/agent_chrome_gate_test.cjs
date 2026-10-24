require("./lib/agent-chrome-test-env.cjs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const gate = require("../scripts/agent-chrome-gate");
const session = require("../scripts/agent-chrome-session");

const background = { foreground: false };
const foreground = { foreground: true };

test("the policy refuses new contexts, windows, focus, resizing and quitting, and backgrounds new tabs", () => {
  const command = (method, params) => ({ id: 7, method, params });
  assert.match(gate.policy(command("Target.createBrowserContext", {}), foreground).refuse, /chromium\.launch\(\{ headless: true \}\)/);
  assert.match(gate.policy(command("Target.createTarget", { url: "about:blank", newWindow: true }), background).refuse, /background tab/);
  assert.deepEqual(gate.policy(command("Target.createTarget", { url: "about:blank" }), background).rewrite,
    command("Target.createTarget", { url: "about:blank", background: true }));
  assert.deepEqual(gate.policy(command("Target.createTarget", { url: "a", background: true }), background), {});
  assert.deepEqual(gate.policy(command("Target.createTarget", { url: "a", newWindow: true }), foreground), {});
  for (const method of ["Target.activateTarget", "Page.bringToFront"]) {
    assert.match(gate.policy(command(method, {}), background).refuse, /--foreground/);
    assert.deepEqual(gate.policy(command(method, {}), foreground), {});
  }
  assert.match(gate.policy(command("Browser.setWindowBounds", {}), foreground).refuse, /setViewportSize/);
  assert.match(gate.policy(command("Browser.close", {}), foreground).refuse, /Disconnect instead/);
  assert.deepEqual(gate.policy(command("Runtime.evaluate", {}), background), {});
  assert.match(gate.policy(command("Target.sendMessageToTarget", { message: "{}" }), foreground).refuse, /sessionId/);
});

function decode(buffer) {
  const header = gate.frameHeader(buffer);
  assert.ok(header);
  assert.equal(buffer.length, header.size + header.length);
  return { ...header, text: gate.unmask(buffer.subarray(header.size), header.mask).toString() };
}

test("frames round-trip at every length boundary, masked and not", () => {
  const mask = Buffer.from([1, 2, 3, 4]);
  for (const length of [0, 1, 125, 126, 65535, 65536]) {
    for (const key of [null, mask]) {
      const text = "x".repeat(length);
      const frame = decode(gate.encodeFrame(text, key));
      assert.equal(frame.text, text);
      assert.equal(frame.fin, true);
      assert.equal(frame.opcode, 1);
      assert.equal(Boolean(frame.mask), Boolean(key));
    }
  }
  assert.equal(gate.frameHeader(Buffer.from([0x81])), null);
  assert.equal(gate.frameHeader(Buffer.from([0x81, 0xfe, 0x01])), null);
});

// A stream fed one byte at a time must write the same bytes it would whole.
function feed(stream, bytes, step) {
  for (let i = 0; i < bytes.length; i += step) stream.push(bytes.subarray(i, i + step));
}

test("the frame stream passes frames through untouched whatever the chunking", () => {
  const mask = Buffer.from([9, 8, 7, 6]);
  const binary = Buffer.from([0x82, 0x83, ...mask, ...gate.unmask(Buffer.from([1, 2, 3]), mask)]);
  const ping = Buffer.from([0x89, 0x80, ...mask]);
  const fragmentStart = Buffer.from([0x01, 0x82, ...mask, ...gate.unmask(Buffer.from("ab"), mask)]);
  const fragmentEnd = Buffer.from([0x80, 0x82, ...mask, ...gate.unmask(Buffer.from("cd"), mask)]);
  const input = Buffer.concat([gate.encodeFrame('{"id":1,"method":"Runtime.enable"}', mask), binary, ping, fragmentStart,
    fragmentEnd, gate.encodeFrame("y".repeat(70000), mask)]);
  for (const step of [1, 3, 7, input.length]) {
    const out = [];
    const seen = [];
    const stream = new gate.FrameStream((bytes) => out.push(Buffer.from(bytes)), (text) => { seen.push(text.length); return null; });
    feed(stream, input, step);
    assert.deepEqual(Buffer.concat(out), input, `step ${step}`);
    assert.deepEqual(seen, [34, 70000], `step ${step}`);
  }
});

test("a rewritten command replaces its frame, and injected bytes wait for a frame boundary", () => {
  const mask = Buffer.from([5, 6, 7, 8]);
  const out = [];
  const stream = new gate.FrameStream((bytes) => out.push(Buffer.from(bytes)), () => gate.encodeFrame("rewritten", mask));
  const frame = gate.encodeFrame("original", mask);
  stream.push(frame.subarray(0, 4));
  stream.inject(Buffer.from("REPLY"));
  assert.deepEqual(out, []);
  stream.push(frame.subarray(4));
  assert.equal(decode(out[0]).text, "rewritten");
  assert.equal(out[1].toString(), "REPLY");
  stream.inject(Buffer.from("NOW"));
  assert.equal(out[2].toString(), "NOW");
});

test("a refused command is answered to the client and never reaches Chrome", () => {
  const replies = [];
  const declaration = { what: "flow", current: () => background };
  const text = JSON.stringify({ id: 4, sessionId: "S", method: "Target.createBrowserContext", params: {} });
  const sent = gate.filterCommand(text, Buffer.from([1, 1, 1, 1]), declaration, (bytes) => replies.push(bytes), () => {});
  assert.equal(sent.length, 0);
  const answer = JSON.parse(decode(replies[0]).text);
  assert.equal(answer.id, 4);
  assert.equal(answer.sessionId, "S");
  assert.match(answer.error.message, /headless/);
  assert.equal(gate.filterCommand("not json", null, declaration, () => {}, () => {}), null);
  assert.equal(gate.filterCommand('{"id":1,"method":"Page.navigate"}', null, declaration, () => {}, () => {}), null);
});

test("the client is found by its port, and matched through its ancestors' pid or environment", async () => {
  const lsof = `p${process.pid}\nf10\nn127.0.0.1:9333->127.0.0.1:50000\np4242\nf20\nn127.0.0.1:50000->127.0.0.1:9333\n`;
  const table = "    1     0 /sbin/launchd\n 4100     1 /usr/bin/login\n 4200  4100 /bin/zsh\n 4242  4200 /usr/local/bin/node\n 9999  4242 /bin/sleep\n";
  const environments = {
    4242: "/usr/local/bin/node /tmp/pw-pr84.mjs TERM=xterm NODE_OPTIONS=--import=/x/axi-entry.mjs",
    4200: "/bin/zsh -c node pw-pr84.mjs AGENT_CHROME_SESSION=abc-123 HOME=/x",
    4100: "/usr/bin/login",
  };
  const calls = [];
  const run = async (file, args, options) => {
    calls.push([file, args, options]);
    if (file === "/usr/sbin/lsof") return { stdout: lsof };
    if (args[0] === "-A") return { stdout: table };
    if (args[0] === "-E") return { stdout: args.at(-1).split(",").map((pid) => `${pid} ${environments[pid]}`).join("\n") };
    return { stdout: "/usr/local/bin/node /tmp/pw-pr84.mjs\n" };
  };
  assert.equal(await gate.clientPid(50000, run), 4242);
  assert.equal(await gate.clientPid(50001, async () => { throw Object.assign(new Error("exit 1"), { stdout: "" }); }), null);
  const chain = await gate.chain(4242, run);
  assert.deepEqual(chain.map(({ pid, tokens, command, script }) => [pid, tokens, command, script]),
    [[4242, [], "node", "pw-pr84.mjs"], [4200, ["abc-123"], "zsh", undefined], [4100, [], "login", undefined]]);
  // One lsof and three ps calls whatever the depth, each with a timeout.
  assert.equal(calls.length, 4);
  assert.ok(calls.every(([, , options]) => options?.timeout > 0));
  assert.deepEqual(await gate.chain(4242, async () => { throw new Error("timed out"); }), []);
  const live = { id: "abc-123", what: "x", minutes: 1, started: 0, until: Date.now() + 60000 };
  assert.equal(gate.match(chain, [{ file: "f", declaration: live }]).declaration, live);
  assert.equal(gate.match(chain, [{ file: "f", declaration: { ...live, until: Date.now() - 1 } }]), null);
  assert.equal(gate.match(chain, [{ file: "f", declaration: { ...live, id: "other" } }]), null);
  assert.equal(gate.match(chain, [{ file: "f", declaration: { ...live, id: "other", until: undefined, pid: process.pid } }]), null);
  const owner = { id: "other", what: "x", minutes: 1, started: 0, pid: process.pid };
  assert.equal(gate.match([{ pid: process.pid, tokens: [] }], [{ file: "f", declaration: owner }]).declaration, owner);
  // An adopted declaration stands only until the migration window closes.
  const adopted = { id: `adopted-${process.pid}`, what: "node", pid: process.pid, adopted: true, started: 0 };
  assert.equal(gate.match([{ pid: process.pid, tokens: [] }], [{ file: "f", declaration: adopted }], 10, 20).declaration, adopted);
  assert.equal(gate.match([{ pid: process.pid, tokens: [] }], [{ file: "f", declaration: adopted }], 20, 20), null);
});

test("a connection's declaration is live while its file is, and an adopted one only inside the window", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "agent-chrome-gate-"));
  const file = join(dir, "s.json");
  const declaration = { id: "s", what: "flow", pid: process.pid, started: 0 };
  fs.writeFileSync(file, JSON.stringify(declaration));
  const view = gate.reader({ file, declaration }, Date.now() + 60000);
  assert.equal(view.live(), true);
  fs.writeFileSync(file, JSON.stringify({ ...declaration, foreground: true }));
  assert.equal(view.current().foreground, true);
  fs.rmSync(file);
  assert.equal(view.live(), false);
  assert.equal(view.current().foreground, true);
  fs.writeFileSync(file, JSON.stringify({ ...declaration, adopted: true }));
  assert.equal(gate.reader({ file, declaration }, Date.now() + 60000).live(), true);
  assert.equal(gate.reader({ file, declaration }, Date.now() - 1).live(), false);
});

// --- A gate in front of a stub Chrome ---------------------------------------

// Answers /json/version and accepts CDP WebSockets, recording every command
// and answering each with an empty result. Target.createTarget answers, after
// createDelay (ms, or a promise to wait for), with a targetId made from its
// url; /json/new opens "new-tab".
function stubChrome({ createDelay = 0 } = {}) {
  const commands = [];
  const paths = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    const body = req.url.startsWith("/json/new") ? { id: "new-tab" } : { path: req.url, host: req.headers.host };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    commands.push({ extensions: req.headers["sec-websocket-extensions"] });
    const stream = new gate.FrameStream(() => {}, (text) => {
      const message = JSON.parse(text);
      commands.push(message);
      const answer = () => socket.write(gate.encodeFrame(JSON.stringify(message.method === "Target.createTarget"
        ? { id: message.id, result: { targetId: `tab:${message.params.url}` } }
        : { id: message.id, result: {} }), null));
      if (message.method === "Target.createTarget" && createDelay?.then) createDelay.then(answer);
      else if (message.method === "Target.createTarget" && createDelay) setTimeout(answer, createDelay);
      else answer();
      return Buffer.alloc(0);
    });
    socket.on("data", (chunk) => stream.push(chunk));
    socket.on("error", () => {});
  });
  // Upgraded sockets leave the server's tracking, so they are destroyed here.
  return { server, commands, paths, destroy: () => { for (const socket of sockets) socket.destroy(); } };
}

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

async function gateFor(declared, options = {}) {
  const chrome = stubChrome();
  const chromePort = await listen(chrome.server);
  const logs = [];
  const identify = async () => (declared
    ? { client: "node (pid 1)", declaration: { what: "flow", current: () => declared, live: options.live ?? (() => true) } }
    : { client: "node (pid 1)", ...options.found });
  const server = gate.createGate({ chromePort, identify, log: (line) => logs.push(line), ...options.gate });
  const port = await listen(server);
  return { port, chrome, logs, server, close: () => { chrome.destroy(); server.close(); chrome.server.close(); server.closeAllConnections(); chrome.server.closeAllConnections(); } };
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

// What a WebSocket client sees when the upgrade is refused: status and body.
// With hangUp, the client hangs up as soon as the request is sent.
function upgrade(port, { hangUp = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/devtools/browser/x", headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("upgrade", (res, socket) => { socket.destroy(); resolve({ status: res.statusCode }); });
    req.on("error", hangUp ? () => resolve({ status: 0 }) : reject);
    req.end();
    if (hangUp) req.on("finish", () => { req.destroy(); resolve({ status: 0 }); });
  });
}

function connect(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/x`);
  const replies = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    replies.get(message.id)?.(message);
  });
  const send = (message) => new Promise((resolve) => { replies.set(message.id, resolve); socket.send(JSON.stringify(message)); });
  const closed = new Promise((resolve) => socket.addEventListener("close", resolve));
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve({ send, close: () => socket.close(), closed }));
    socket.addEventListener("error", () => reject(new Error("WebSocket failed")));
  });
}

test("an undeclared client may probe the version but is refused the tab list and every WebSocket, with the fix named", async (t) => {
  const { port, logs, close } = await gateFor(null);
  t.after(close);
  const version = await get(port, "/json/version/", { Host: `127.0.0.1:${port}` });
  assert.equal(version.status, 200);
  assert.deepEqual(JSON.parse(version.body), { path: "/json/version/", host: `127.0.0.1:${port}` });
  for (const path of ["/json/list", "/json", "/json/new?about:blank"]) {
    const refused = await get(port, path);
    assert.equal(refused.status, 403, path);
    assert.match(refused.body, /agent-chrome-session --minutes N --what/);
  }
  const socket = await upgrade(port);
  assert.equal(socket.status, 403);
  assert.match(socket.body, /did not tell him[\s\S]*agent-chrome-session --minutes N --what "what it does" -- <your command>[\s\S]*Client: node \(pid 1\)/);
  assert.ok(logs.some((line) => /refused WebSocket from node \(pid 1\)/.test(line)));
});

test("in the migration window an undeclared client is let through once the owner is told, still without new contexts", async (t) => {
  const adopted = [];
  const home = fs.mkdtempSync(join(tmpdir(), "agent-chrome-gate-"));
  const adopt = async (spec) => {
    adopted.push(spec);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const declaration = { id: "adopted-4242", what: spec.what, foreground: false, adopted: true };
    fs.writeFileSync(join(home, "adopted.json"), JSON.stringify(declaration));
    return { file: join(home, "adopted.json"), declaration };
  };
  const { port, chrome, close } = await gateFor(null, { found: { pid: 4242, name: "node pw-pr84.mjs" }, gate: { adopt, graceUntil: Date.now() + 60000 } });
  t.after(close);
  const [a, b] = await Promise.all([connect(port), connect(port)]);
  t.after(() => { a.close(); b.close(); });
  assert.deepEqual(adopted, [{ pid: 4242, what: "node pw-pr84.mjs" }]);
  assert.match((await a.send({ id: 1, method: "Target.createBrowserContext" })).error.message, /headless/);
  await b.send({ id: 2, method: "Target.createTarget", params: { url: "about:blank" } });
  assert.deepEqual(chrome.commands.filter(({ method }) => method).map(({ method, params }) => [method, params.background]), [["Target.createTarget", true]]);
});

test("after the migration window, or when the declaration cannot be written, the undeclared client is refused", async (t) => {
  for (const options of [{ adopt: async () => ({}), graceUntil: Date.now() - 1 }, { adopt: async () => { throw new Error("disk full"); }, graceUntil: Date.now() + 60000 }]) {
    const { port, logs, close } = await gateFor(null, { found: { pid: 4242, name: "node" }, gate: options });
    t.after(close);
    assert.equal((await upgrade(port)).status, 403);
    assert.ok(logs.some((line) => /refused WebSocket/.test(line)));
  }
});

test("a declared session reaches Chrome, with new contexts refused and new tabs backgrounded", async (t) => {
  const { port, chrome, close } = await gateFor(background);
  t.after(close);
  assert.equal((await get(port, "/json/list")).status, 200);
  assert.equal((await get(port, "/json/new?about:blank")).status, 403);
  const cdp = await connect(port);
  t.after(cdp.close);
  assert.deepEqual(await cdp.send({ id: 1, method: "Target.getTargets" }), { id: 1, result: {} });
  const refused = await cdp.send({ id: 2, method: "Target.createBrowserContext", params: {} });
  assert.match(refused.error.message, /opens a new window there[\s\S]*headless/);
  await cdp.send({ id: 3, method: "Target.createTarget", params: { url: "about:blank" } });
  await cdp.send({ id: 4, method: "Runtime.evaluate", params: { expression: "z".repeat(100000) } });
  assert.equal(chrome.commands[0].extensions, undefined);
  assert.deepEqual(chrome.commands.slice(1).map(({ method, params }) => [method, params?.background]),
    [["Target.getTargets", undefined], ["Target.createTarget", true], ["Runtime.evaluate", undefined]]);
});

test("a foreground session may open a visible tab but still may not open a new context", async (t) => {
  const { port, chrome, close } = await gateFor(foreground);
  t.after(close);
  assert.equal((await get(port, "/json/new?about:blank")).status, 200);
  const cdp = await connect(port);
  t.after(cdp.close);
  await cdp.send({ id: 1, method: "Target.activateTarget", params: { targetId: "T" } });
  assert.ok((await cdp.send({ id: 2, method: "Target.createBrowserContext" })).error);
  assert.deepEqual(chrome.commands.slice(1).map(({ method }) => method), ["Target.activateTarget"]);
});

test("identify reads the real client process: an undeclared one is refused, the helper's child is let through", async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), "agent-chrome-gate-"));
  const dir = session.stateDir(home);
  const server = http.createServer((req, res) => {
    gate.identify(req.socket, { dir }).then((found) => res.end(JSON.stringify({ client: found.client, declared: Boolean(found.declaration) })));
  });
  const port = await listen(server);
  t.after(() => server.close());
  // Async, because a synchronous spawn would block the server it probes.
  const run = require("node:util").promisify(require("node:child_process").execFile);
  const probe = `fetch("http://127.0.0.1:${port}/").then((r) => r.text()).then((t) => process.stdout.write(t))`;
  const plain = await run(process.execPath, ["-e", probe], { env: { ...process.env, [session.ENV]: "" } });
  const undeclared = JSON.parse(plain.stdout);
  assert.equal(undeclared.declared, false);
  assert.match(undeclared.client, /^node \(pid \d+\)$/);
  const wrapped = await run(process.execPath, [join(__dirname, "../scripts/agent-chrome-session"), "--minutes", "1", "--what", "gate test", "--",
    process.execPath, "-e", probe], { env: { ...process.env, [session.ENV]: "", AGENT_CHROME_STATE_HOME: home, AGENT_CHROME_SESSION_TEST_NOTIFY_LOG: join(home, "notices") } });
  assert.equal(JSON.parse(wrapped.stdout).declared, true);
  assert.equal(fs.readFileSync(join(home, "notices"), "utf8").trim().split("\n").length, 2);
});

// A gate that connects anyway never goes idle; the test then times out.
test("a client that hangs up while it is being identified never gets a Chrome connection", { timeout: 60000 }, async (t) => {
  const chrome = stubChrome();
  const chromePort = await listen(chrome.server);
  let idle;
  const done = new Promise((resolve) => { idle = resolve; });
  // The gate's sockets stay half open, so the hang-up it sees is the client's
  // end. Identification finishes only after it, and the gate then goes idle.
  const identify = async (socket) => {
    await new Promise((resolve) => socket.once("end", resolve));
    server.whenIdle(idle);
    return { client: "node (pid 1)", declaration: { what: "flow", current: () => background, live: () => true } };
  };
  const server = gate.createGate({ chromePort, identify });
  const port = await listen(server);
  t.after(() => { chrome.destroy(); server.close(); chrome.server.close(); server.closeAllConnections(); });
  await upgrade(port, { hangUp: true });
  await done;
  assert.equal(chrome.commands.length, 0);
});

test("a connection closes when its session ends, idle or on its next command, and the gate then reports idle", async (t) => {
  let live = true;
  const { port, chrome, server, logs, close } = await gateFor(background, { live: () => live });
  t.after(close);
  const idle = await connect(port);
  const busy = await connect(port);
  await busy.send({ id: 1, method: "Target.getTargets" });
  let idled = false;
  server.whenIdle(() => { idled = true; });
  assert.equal(idled, false);
  live = false;
  busy.send({ id: 2, method: "Target.getTargets" });
  await busy.closed;
  assert.equal(idled, false);
  server.closeEnded();
  await idle.closed;
  assert.equal(idled, true);
  assert.deepEqual(chrome.commands.filter(({ method }) => method).map(({ id }) => id), [1]);
  assert.ok(logs.some((line) => /session "flow" has ended/.test(line)));
});

test("idle waits for WebSocket identification to finish and its resulting connection to close", async (t) => {
  let live = true;
  let release;
  let identifying;
  const started = new Promise((resolve) => { identifying = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  const { port, server, close } = await gateFor(background, { gate: { identify: async () => {
    identifying();
    await waiting;
    return { declaration: { what: "flow", current: () => background, live: () => live } };
  } } });
  t.after(close);
  const connecting = connect(port);
  await started;
  let idled = false;
  server.whenIdle(() => { idled = true; });
  const early = idled;
  server.closeEnded();
  const swept = idled;
  release();
  const cdp = await connecting;
  t.after(cdp.close);
  const connected = idled;
  live = false;
  server.closeEnded();
  await cdp.closed;
  assert.equal(early, false);
  assert.equal(swept, false);
  assert.equal(connected, false);
  assert.equal(idled, true);
});

test("idle waits for HTTP adoption in flight, including when it is refused", async (t) => {
  for (const adopted of [true, false]) {
    let release;
    let adopting;
    const started = new Promise((resolve) => { adopting = resolve; });
    const waiting = new Promise((resolve) => { release = resolve; });
    const dir = fs.mkdtempSync(join(tmpdir(), "agent-chrome-gate-"));
    const file = join(dir, "adopted.json");
    const declaration = { id: "adopted", adopted: true, pid: process.pid, what: "flow", started: Date.now() };
    fs.writeFileSync(file, JSON.stringify(declaration));
    const { port, server, close } = await gateFor(null, { found: { pid: process.pid, name: "node" }, gate: {
      graceUntil: Date.now() + 60000,
      adopt: async () => { adopting(); await waiting; return adopted ? { file, declaration } : null; },
    } });
    t.after(close);
    const response = get(port, "/json/new?about:blank");
    await started;
    let idled = false;
    server.whenIdle(() => { idled = true; });
    const early = idled;
    release();
    assert.equal((await response).status, 403);
    assert.equal(early, false);
    assert.equal(idled, true);
  }
});

test("a large ancestor environment still supplies its session token", async () => {
  const environment = `4242 node ${"X".repeat(2 << 20)} ${session.ENV}=large-chain\n`;
  const processes = await gate.chain(4242, async (file, args, options) => {
    if (args[0] === "-A") return { stdout: "4242 1 /usr/local/bin/node\n" };
    if (args[0] === "-E") {
      if (Buffer.byteLength(environment) > (options.maxBuffer ?? (1 << 20))) throw new Error("stdout maxBuffer length exceeded");
      return { stdout: environment };
    }
    return { stdout: "node flow.cjs\n" };
  });
  assert.deepEqual(processes[0].tokens, ["large-chain"]);
});

test("the gate notices its own code changing, once", { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), "agent-chrome-gate-"));
  const file = join(dir, "agent-chrome-gate");
  fs.writeFileSync(file, "one");
  let changes = 0;
  gate.onCodeChange([file], () => { changes += 1; }, 20);
  // A replacement, as an update installs one, until the watcher has seen it:
  // a change made before its first look is its starting point, not a change.
  let version = 0;
  const replace = (text) => {
    version += 1;
    fs.writeFileSync(`${file}.new`, text);
    fs.utimesSync(`${file}.new`, new Date(), new Date(Date.now() + 5000 * version));
    fs.renameSync(`${file}.new`, file);
  };
  // Each wait takes the test's signal, so a timeout ends the loop too.
  const tick = () => require("node:timers/promises").setTimeout(40, undefined, { signal: t.signal });
  while (changes === 0) { replace("two"); await tick(); }
  // A later change, seen by a watcher of the test's own on the same poll.
  let seen = false;
  const own = () => { seen = true; };
  fs.watchFile(file, { interval: 20, persistent: false }, own);
  while (!seen) { replace("three"); await tick(); }
  fs.unwatchFile(file, own);
  assert.equal(changes, 1);
});

test("chain reads a real process's session token from its environment, and names it from its arguments only", { timeout: 60000 }, async (t) => {
  const id = "real-ps-token-test";
  const child = require("node:child_process").spawn(process.execPath, ["-e", "process.stdout.write('up'); setInterval(() => {}, 1000)", "probe.cjs"], {
    env: { ...process.env, [session.ENV]: id, FLOW_HINT: "see /tmp/trap.cjs" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve) => child.stdout.once("data", resolve));
  const processes = await gate.chain(child.pid);
  assert.equal(processes[0].pid, child.pid);
  assert.deepEqual(processes[0].tokens, [id]);
  assert.equal(processes[0].command, "node");
  assert.equal(processes[0].script, "probe.cjs");
  assert.ok(processes.some(({ pid }) => pid === process.pid));
});

// --- Tabs a session leaves open ---------------------------------------------

// Two sessions, a and b, in front of one stub Chrome; each connection says
// which session it is with its first request's order.
async function twoSessions(t, chromeOptions = {}) {
  const chrome = stubChrome(chromeOptions);
  const chromePort = await listen(chrome.server);
  const live = { a: true, b: true };
  const declarations = {
    a: { id: "a", what: "flow a", current: () => foreground, live: () => live.a },
    b: { id: "b", what: "flow b", current: () => background, live: () => live.b },
  };
  const order = [];
  const logs = [];
  const server = gate.createGate({ chromePort, identify: async () => ({ client: "node (pid 1)", declaration: declarations[order.shift()] }), log: (line) => logs.push(line), answerGrace: 2000 });
  const port = await listen(server);
  t.after(() => { chrome.destroy(); server.close(); chrome.server.close(); server.closeAllConnections(); chrome.server.closeAllConnections(); });
  const as = (name) => { order.push(name); return connect(port); };
  // A client that sends one command and drops its socket, as a killed one does.
  const killedAfter = (name, message) => new Promise((resolve, reject) => {
    order.push(name);
    const req = http.request({ host: "127.0.0.1", port, path: "/devtools/browser/x", headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } });
    req.on("upgrade", (res, socket) => {
      socket.write(gate.encodeFrame(JSON.stringify(message), Buffer.from([1, 2, 3, 4])), () => setTimeout(() => { socket.destroy(); resolve(); }, 50));
    });
    req.on("error", reject);
    req.end();
  });
  const closed = () => chrome.paths.filter((path) => path.startsWith("/json/close/")).map((path) => decodeURIComponent(path.slice("/json/close/".length)));
  return { port, chrome, server, live, logs, as, killedAfter, closed, order };
}

// Follow-up of playwright-session-signals review r2: a run killed while its
// tab was opening left that tab open in the shared agent Chrome for good.
test("when a session ends the gate closes the tabs it opened, and no other session's", async (t) => {
  const { port, server, live, logs, as, closed, order } = await twoSessions(t);
  const a = await as("a");
  const b = await as("b");
  assert.equal((await a.send({ id: 1, method: "Target.createTarget", params: { url: "about:blank#a" } })).result.targetId, "tab:about:blank#a");
  await b.send({ id: 1, method: "Target.createTarget", params: { url: "about:blank#b" } });
  order.push("a");
  assert.equal((await get(port, "/json/new?about:blank")).status, 200);
  await server.closeEnded();
  assert.deepEqual(closed(), []);
  live.a = false;
  await server.closeEnded();
  assert.deepEqual(closed().sort(), ["new-tab", "tab:about:blank#a"]);
  assert.ok(logs.some((line) => line === 'closed 2 tabs that "flow a" left open'));
  // Once closed, a tab is not closed again.
  await server.closeEnded();
  assert.equal(closed().length, 2);
});

test("a tab whose createTarget answer comes after its client has gone is still closed when the session ends", { timeout: 60000 }, async (t) => {
  let answer;
  const answered = new Promise((resolve) => { answer = resolve; });
  const { chrome, server, live, killedAfter, closed } = await twoSessions(t, { createDelay: answered });
  await killedAfter("a", { id: 7, method: "Target.createTarget", params: { url: "about:blank#late" } });
  assert.equal(chrome.commands.filter(({ method }) => method === "Target.createTarget").length, 1);
  live.a = false;
  let idle = false;
  const idled = new Promise((resolve) => server.whenIdle(() => { idle = true; resolve(); }));
  await server.closeEnded();
  assert.deepEqual(closed(), []);
  assert.equal(idle, false, "Chrome's side stays open for the answer");
  answer();
  // "and closes once it is in": a gate that stays open fails by the test's timeout.
  await idled;
  await server.closeEnded();
  assert.deepEqual(closed(), ["tab:about:blank#late"]);
});

test("a restarted gate still closes the tabs of a session that ends after the restart", async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), "agent-chrome-gate-tabs-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = join(home, "tabs.json");
  const declarationFile = join(home, "s.json");
  fs.writeFileSync(declarationFile, JSON.stringify({ id: "s", what: "flow s", pid: process.pid, started: Date.now() }));
  const closedTabs = [];
  const close = async (port, targetId) => { closedTabs.push(targetId); return true; };
  const before = gate.tabTracker({ chromePort: 1, file, close });
  before.opened(gate.reader({ file: declarationFile, declaration: { id: "s", what: "flow s" } }), "tab-s");
  const after = gate.tabTracker({ chromePort: 1, file, close });
  await after.closeEnded();
  assert.deepEqual(closedTabs, []);
  fs.rmSync(declarationFile);
  await after.closeEnded();
  assert.deepEqual(closedTabs, ["tab-s"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { sessions: [], kept: [] });
});

function put(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "PUT" }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

// Review r1 of agent-chrome-session-orphans: apply workers leave tabs open for
// the owner on purpose, and the gate closed them when the session ended.
test("a session keeps a tab it opened for the owner; no other session can keep it, and the gate leaves it open", async (t) => {
  const { port, chrome, server, live, logs, as, closed, order } = await twoSessions(t);
  const a = await as("a");
  const b = await as("b");
  for (const url of ["about:blank#form", "about:blank#scratch"]) await a.send({ id: url.length, method: "Target.createTarget", params: { url } });
  await b.send({ id: 1, method: "Target.createTarget", params: { url: "about:blank#b" } });
  const keep = (name, targetId, what = "form%20to%20review") => { order.push(name); return put(port, `/agent-chrome/keep/${encodeURIComponent(targetId)}?what=${what}`); };
  // Another session's tab, and a tab no session opened, are refused with the rule.
  for (const refused of [await keep("b", "tab:about:blank#form"), await keep("a", "unknown-tab")]) {
    assert.equal(refused.status, 403);
    assert.match(refused.body, /may keep only a tab it opened itself/);
  }
  assert.equal((await keep("a", "tab:about:blank#form", "")).status, 400);
  order.push("a");
  assert.equal((await get(port, "/agent-chrome/keep/tab%3Aabout%3Ablank%23form?what=x")).status, 405);
  // The gate answers every /agent-chrome path itself, never with Chrome's 404,
  // so a 404 there can only come from a gate that predates keep.
  for (const path of ["/agent-chrome/keep", "/agent-chrome/keep/", "/agent-chrome/keep/a/b?what=x", "/agent-chrome/other"]) {
    order.push("a");
    const usage = await put(port, path);
    assert.equal(usage.status, 400, path);
    assert.match(usage.body, /PUT \/agent-chrome\/keep\/<targetId>\?what=<why>/);
  }
  const kept = await keep("a", "tab:about:blank#form");
  assert.equal(kept.status, 200, kept.body);
  assert.ok(logs.includes('kept a tab of "flow a" open for the owner: form to review'));
  // A retry after a lost answer is kept again; once kept, no other session takes it over.
  const again = await keep("a", "tab:about:blank#form");
  assert.equal(again.status, 200, again.body);
  assert.equal(logs.filter((line) => line.startsWith("kept a tab")).length, 1);
  const taken = await keep("b", "tab:about:blank#form");
  assert.equal(taken.status, 403);
  assert.match(taken.body, /one already kept/);
  assert.equal(chrome.paths.filter((path) => path.startsWith("/agent-chrome/")).length, 0, "keep never reaches Chrome");
  // b drives the kept tab and ends; its end closes only its own tab.
  await b.send({ id: 2, method: "Target.attachToTarget", params: { targetId: "tab:about:blank#form", flatten: true } });
  live.b = false;
  await server.closeEnded();
  assert.deepEqual(closed(), ["tab:about:blank#b"]);
  live.a = false;
  await server.closeEnded();
  assert.deepEqual(closed().sort(), ["tab:about:blank#b", "tab:about:blank#scratch"]);
});

// Review r2: a keep from a process in no live session was adopted first, so
// the owner got an "is using the agent Chrome without agent-chrome-session" notice
// for a keep the gate then refused.
test("a keep from a process in no live session is refused without adopting it; an adopted one keeps its own tab", async (t) => {
  const chrome = stubChrome();
  const chromePort = await listen(chrome.server);
  const home = fs.mkdtempSync(join(tmpdir(), "agent-chrome-gate-keep-"));
  const adopted = [];
  let adoptedFile = null;
  const adopt = async (spec) => {
    adopted.push(spec);
    // A live pid, so the adopted declaration stands.
    const declaration = { id: `adopted-${spec.pid}`, what: spec.what, pid: process.pid, foreground: false, adopted: true, started: Date.now() };
    adoptedFile = join(home, "adopted.json");
    fs.writeFileSync(adoptedFile, JSON.stringify(declaration));
    return { file: adoptedFile, declaration };
  };
  // Session a's command, then a child it left running after a ended, then an
  // undeclared script: the last two are in no live session.
  const callers = {
    a: { client: "node (pid 10)", pid: 10, name: "node", declaration: { id: "a", what: "flow a", current: () => background, live: () => live } },
    child: { client: "node (pid 11)", pid: 11, name: "node" },
    stray: { client: "curl (pid 12)", pid: 12, name: "curl" },
    adopted: { client: "node (pid 13)", pid: 13, name: "node" },
  };
  let live = true;
  const order = [];
  const identify = async () => {
    const caller = callers[order.shift()];
    if (caller.pid === 13 && adoptedFile) return { ...caller, declaration: gate.reader({ file: adoptedFile, declaration: JSON.parse(fs.readFileSync(adoptedFile, "utf8")) }) };
    return caller;
  };
  const logs = [];
  const server = gate.createGate({ chromePort, identify, adopt, graceUntil: Date.now() + 60000, log: (line) => logs.push(line) });
  const port = await listen(server);
  t.after(() => { chrome.destroy(); server.close(); chrome.server.close(); server.closeAllConnections(); chrome.server.closeAllConnections(); fs.rmSync(home, { recursive: true, force: true }); });
  order.push("a");
  const a = await connect(port);
  await a.send({ id: 1, method: "Target.createTarget", params: { url: "about:blank#a" } });
  live = false;
  for (const [name, path] of [["stray", "/agent-chrome/keep/tab%3Aabout%3Ablank%23a?what=x"], ["child", "/agent-chrome/keep/tab%3Aabout%3Ablank%23a?what=x"], ["stray", "/agent-chrome/keep"]]) {
    order.push(name);
    const refused = await put(port, path);
    assert.equal(refused.status, 403, `${name} ${path}`);
    assert.match(refused.body, /this process is in no live session/);
  }
  assert.deepEqual(adopted, [], "no adoption, so no notice to the owner");
  assert.ok(!logs.some((line) => /without a declaration/.test(line)));
  assert.equal(chrome.paths.filter((path) => path.startsWith("/agent-chrome")).length, 0, "keep never reaches Chrome");
  // A process adopted through CDP in the migration window opened its tab, so it may keep it.
  order.push("adopted");
  const b = await connect(port);
  await b.send({ id: 1, method: "Target.createTarget", params: { url: "about:blank#adopted" } });
  assert.equal(adopted.length, 1);
  order.push("adopted");
  const kept = await put(port, "/agent-chrome/keep/tab%3Aabout%3Ablank%23adopted?what=sign-in");
  assert.equal(kept.status, 200, kept.body);
  assert.equal(adopted.length, 1);
  a.close();
  b.close();
});

test("kept tabs survive a restarted gate, and their record goes once Chrome stops listing them", async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), "agent-chrome-gate-kept-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = join(home, "tabs.json");
  const declarationFile = join(home, "s.json");
  fs.writeFileSync(declarationFile, JSON.stringify({ id: "s", what: "flow s", pid: process.pid, started: Date.now() }));
  const declaration = gate.reader({ file: declarationFile, declaration: { id: "s", what: "flow s" } });
  const closedTabs = [];
  // The saved record while each close runs: a gate that dies mid-close must
  // still find the session's tabs after its restart.
  const savedDuringClose = [];
  const close = async (port, targetId) => {
    savedDuringClose.push(JSON.parse(fs.readFileSync(file, "utf8")).sessions.map(({ id }) => id));
    closedTabs.push(targetId);
    return true;
  };
  const open = new Set(["tab-kept", "tab-other"]);
  let answering = true;
  const list = async () => { if (!answering) throw new Error("connect ECONNREFUSED"); return new Set(open); };
  const before = gate.tabTracker({ chromePort: 1, file, close, list, now: () => 42 });
  before.opened(declaration, "tab-kept");
  before.opened(declaration, "tab-other");
  assert.equal(before.keep(declaration, "tab-kept", "sign-in for the owner"), true);
  assert.equal(before.keep({ id: "x", what: "flow x" }, "tab-other", "not mine"), false);
  assert.equal(before.keep(declaration, "tab-kept", "sign-in for the owner"), true, "a repeat keep by its session");
  assert.equal(before.keep({ id: "x", what: "flow x" }, "tab-kept", "not mine"), false);
  // A declaration without an id is its own key, and no other one's repeat.
  const anonymous = { what: "flow without id" };
  const bare = gate.tabTracker({ chromePort: 1, close, list });
  bare.opened(anonymous, "tab-anonymous");
  assert.equal(bare.keep(anonymous, "tab-anonymous", "form"), true);
  assert.equal(bare.keep({ what: "another without id" }, "tab-anonymous", "form"), false);
  const after = gate.tabTracker({ chromePort: 1, file, close, list });
  fs.rmSync(declarationFile);
  await after.closeEnded();
  assert.deepEqual(closedTabs, ["tab-other"]);
  assert.deepEqual(savedDuringClose, [["s"]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { sessions: [], kept: [{ targetId: "tab-kept", what: "sign-in for the owner", session: "s", at: 42 }] });
  // the owner closes the tab while Chrome does not answer the list: the record
  // stays until Chrome answers, and the next sweep then forgets it.
  open.delete("tab-kept");
  answering = false;
  await after.closeEnded();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).kept.map(({ targetId }) => targetId), ["tab-kept"]);
  answering = true;
  await after.closeEnded();
  assert.deepEqual(closedTabs, ["tab-other"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { sessions: [], kept: [] });
});

test("a tabs.json from before keeping, a bare list of sessions, still loads", async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), "agent-chrome-gate-old-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = join(home, "tabs.json");
  fs.writeFileSync(file, JSON.stringify([{ id: "old", file: join(home, "gone.json"), what: "old flow", targets: ["tab-old"] }]));
  const closedTabs = [];
  const tracker = gate.tabTracker({ chromePort: 1, file, close: async (port, targetId) => { closedTabs.push(targetId); return true; } });
  await tracker.closeEnded();
  assert.deepEqual(closedTabs, ["tab-old"]);
});
