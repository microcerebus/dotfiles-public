// Tests for the server checks in scripts/lavish-axi.
// On 16 Oct 2026 a pnpm update deleted the package directory a running Lavish
// server read its page assets from, so /chrome.css and /chrome-client.js
// answered 500 and every Lavish page was blank. The first test reproduces
// that with a real server started from a copy of the installed lavish-axi,
// then deletes the copy and checks the restart. Later that day the server
// stopped itself after 30 idle minutes and every link was dead; the second
// test reproduces that with a one-second timeout and checks the launchd
// job's run starts a server with no timeout. Both need lavish-axi as a pnpm
// global and skip without it. Their servers bind 127.0.0.1 only, on a free
// port, with their own state dir.
// Run: node --test tests/lavish_server_test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const lavish = require("../scripts/lavish-axi");

function installedPackage() {
  const listed = spawnSync("pnpm", ["ls", "-g", "--depth", "0", "--json"], { encoding: "utf8" });
  try { return JSON.parse(listed.stdout)[0].dependencies["lavish-axi"].path; } catch { return null; }
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// A fresh connection each time: fetch would reuse a keep-alive socket to the
// server the restart just stopped.
function status(url) {
  return new Promise((resolve) => {
    http.get(url, { agent: false }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", () => resolve(0));
  });
}

async function waitFor(check, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const quiet = { stdout: { write() {} }, stderr: { write() {} } };
const pkg = installedPackage();

test("a server whose package an update deleted is restarted from the current install", { skip: !pkg && "lavish-axi is not a pnpm global here" }, async (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lavish-stale-")));
  const install = path.dirname(path.dirname(pkg));
  for (const copy of ["old", "new"]) spawnSync("cp", ["-R", install, path.join(tmp, copy)]);
  const oldPkg = fs.realpathSync(path.join(tmp, "old/node_modules/lavish-axi"));
  const newPkg = fs.realpathSync(path.join(tmp, "new/node_modules/lavish-axi"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, LAVISH_AXI_STATE_DIR: path.join(tmp, "state"), LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_PORT: String(port), LAVISH_AXI_TELEMETRY: "0", LAVISH_AXI_NO_OPEN: "1",
  };
  const deps = { ...lavish.defaultDeps(), packageDir: () => newPkg, lockDir: path.join(tmp, "lock") };
  const servers = () => lavish.lavishServers(env, deps);
  t.after(() => {
    spawnSync(process.execPath, [path.join(newPkg, "dist/cli.mjs"), "stop", "--port", String(port)], { env });
    for (const server of servers()) { try { process.kill(server.pid, "SIGKILL"); } catch {} }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Started as upstream's startServer does, by a process that then exits, so
  // the server is not this test's child (a killed child would linger as a
  // zombie this blocked test cannot reap).
  spawnSync("/bin/sh", ["-c", '"$0" "$1" server --port "$2" </dev/null >/dev/null 2>&1 &',
    process.execPath, path.join(oldPkg, "dist/server.mjs"), String(port)], { env });
  assert.ok(await waitFor(async () => await status(`${base}/chrome.css`) === 200), "the server came up");
  const artifact = path.join(tmp, "review.html");
  fs.writeFileSync(artifact, "<!doctype html><title>stale check</title><h1>stale check</h1>");
  const opened = spawnSync(process.execPath, [path.join(oldPkg, "dist/cli.mjs"), artifact, "--no-open"], { env, encoding: "utf8" });
  const session = opened.stdout.match(/url:\s*"([^"]+)"/)?.[1];
  assert.ok(session, `the old CLI opened a session: ${opened.stdout}${opened.stderr}`);
  const [old] = servers();
  assert.equal(old.entry, path.join(oldPkg, "dist/server.mjs"));

  assert.equal(lavish.restartStaleServer(env, deps, quiet), 0);
  assert.deepEqual(servers().map((s) => s.pid), [old.pid], "a server whose package is still there is left alone");

  fs.rmSync(path.join(tmp, "old"), { recursive: true, force: true });
  assert.equal(await status(`${base}/chrome.css`), 500, "reproduces the blank pages: assets fail once the package is gone");
  assert.equal(await status(`${base}/chrome-client.js`), 500);

  assert.equal(lavish.restartStaleServer(env, deps, quiet), 0);
  const now = servers();
  assert.equal(now.length, 1, `one server is running: ${JSON.stringify(now)}`);
  assert.notEqual(now[0].pid, old.pid);
  assert.equal(now[0].entry, path.join(newPkg, "dist/server.mjs"));
  assert.deepEqual(now[0].args, old.args, "the new server keeps the old one's arguments");
  assert.equal(await status(`${base}/chrome.css`), 200);
  assert.equal(await status(`${base}/chrome-client.js`), 200);
  assert.equal(await status(session), 200, "the session opened before the update still loads");
  spawnSync(process.execPath, [path.join(newPkg, "dist/cli.mjs"), "stop", "--port", String(port)], { env });
  assert.match(fs.readFileSync(path.join(tmp, "state/server.log"), "utf8"), /^\d{4}-\d\d-\d\dT[\d:.]+Z \[lavish\] shutting down/m,
    "the new server logs where upstream's does, with upstream's timestamps");
});

test("the launchd job starts a server that stopped itself, with no idle timeout", { skip: !pkg && "lavish-axi is not a pnpm global here" }, async (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lavish-down-")));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, LAVISH_AXI_STATE_DIR: path.join(tmp, "state"), LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_PORT: String(port), LAVISH_AXI_TELEMETRY: "0", LAVISH_AXI_NO_OPEN: "1",
  };
  delete env.LAVISH_AXI_IDLE_TIMEOUT_MS;
  const deps = { ...lavish.defaultDeps(), packageDir: () => pkg, lockDir: path.join(tmp, "lock") };
  const servers = () => lavish.lavishServers(env, deps);
  const log = () => fs.readFileSync(path.join(tmp, "state/server.log"), "utf8");
  t.after(() => {
    for (const server of servers()) { try { process.kill(server.pid, "SIGKILL"); } catch {} }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // A timeout the caller sets is kept. This server stops itself a second
  // after the job's check disconnects, as the real one did after 30 minutes.
  assert.equal(lavish.main(["--restart-stale-server"], { ...env, LAVISH_AXI_IDLE_TIMEOUT_MS: "1000" }, deps, quiet), 0);
  assert.ok(await waitFor(() => servers().length === 0), "the server stopped itself");
  assert.match(log(), /idle-timeout after 1000ms with no connections/);
  assert.equal(await status(`${base}/chrome.css`), 0, "reproduces the dead links: nothing answers");

  assert.equal(lavish.main(["--restart-stale-server"], env, deps, quiet), 0);
  const [started, ...extra] = servers();
  assert.ok(started && extra.length === 0, "one server is running");
  assert.equal(started.entry, path.join(pkg, "dist/server.mjs"));
  assert.deepEqual(started.args, ["server", "--port", String(port)], "started with upstream's own arguments");
  assert.equal(await status(`${base}/chrome.css`), 200);
  const environment = spawnSync("/bin/ps", ["-E", "-ww", "-o", "command=", "-p", String(started.pid)], { encoding: "utf8" }).stdout;
  assert.match(environment, / LAVISH_AXI_IDLE_TIMEOUT_MS=off( |$)/m, "the wrapper turned the idle timeout off");
  await new Promise((r) => setTimeout(r, 2500));
  assert.deepEqual(servers().map((s) => s.pid), [started.pid], "it outlives the timeout that stopped the first one");
  assert.equal(await status(`${base}/chrome.css`), 200);
});

// ── Unit tests with a fake process table ──────────────────────────────────
const pnpm = "/Users/me/Library/pnpm/global/v11";
const table = [
  `  101 /nix/store/n-nodejs-22/bin/node ${pnpm}/aaaa-1/node_modules/.pnpm/lavish-axi@0.1.87/node_modules/lavish-axi/dist/server.mjs server --port 4387`,
  `  102 node ${pnpm}/aaaa-1/node_modules/.pnpm/lavish-axi@0.1.87/node_modules/lavish-axi/dist/cli.mjs poll /tmp/review.html`,
  `  103 node ${pnpm}/bbbb-2/node_modules/.pnpm/lavish-axi@0.1.88/node_modules/lavish-axi/dist/cli.mjs server --port 4390 --also-listen 100.64.0.1`,
  `  105 vim /tmp/lavish-axi/dist/server.mjs server`,
].join("\n");
function fakeDeps(present = []) {
  return { ps: () => table, exists: (file) => present.some((p) => file.startsWith(p)) };
}

test("finds Lavish servers on the CLI's port, never a poll or an editor", () => {
  const all = lavish.lavishServers({ LAVISH_AXI_PORT: "4390" }, fakeDeps());
  assert.deepEqual(all.map((s) => s.pid), [103]);
  assert.deepEqual(all[0].args, ["server", "--port", "4390", "--also-listen", "100.64.0.1"]);
  assert.deepEqual(lavish.lavishServers({}, fakeDeps()).map((s) => s.pid), [101], "port 4387 by default");
});

test("a server is stale only when its package file is gone", () => {
  assert.deepEqual(lavish.staleServers({}, fakeDeps()).map((s) => s.pid), [101]);
  assert.deepEqual(lavish.staleServers({}, fakeDeps([`${pnpm}/aaaa-1/`])), []);
});

test("a healthy server means no stop, no start and no output, for a command or the launchd job", () => {
  for (const startIfDown of [false, true]) {
    const calls = [];
    const out = [];
    const deps = { ...fakeDeps([`${pnpm}/aaaa-1/`]), spawnSync: (...a) => { calls.push(a); return { status: 0 }; }, spawn: (...a) => calls.push(a) };
    assert.equal(lavish.restartStaleServer({}, deps, { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) } }, { startIfDown }), 0);
    assert.deepEqual(calls, []);
    assert.deepEqual(out, []);
  }
});

test("only the launchd job starts a server when none runs, with upstream's arguments", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lavish-fake-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ version: "9.9.9", bin: { "lavish-axi": "dist/cli.mjs" } }));
  const started = [];
  const deps = {
    ps: () => "", exists: () => true, packageDir: () => tmp, lockDir: path.join(tmp, "lock"),
    spawn: (_node, args) => { started.push(args); return { pid: 4242, unref() {} }; },
    spawnSync: () => ({ status: 0 }),
  };
  const env = { LAVISH_AXI_STATE_DIR: path.join(tmp, "state"), LAVISH_AXI_PORT: "4390" };
  assert.equal(lavish.restartStaleServer(env, deps, quiet), 0);
  assert.deepEqual(started, [], "a command leaves a down server to upstream, which starts one when it needs it");
  const out = [];
  assert.equal(lavish.restartStaleServer(env, deps, { stderr: { write: (s) => out.push(s) } }, { startIfDown: true }), 0);
  assert.deepEqual(started, [[path.join(tmp, "dist/server.mjs"), "server", "--port", "4390"]]);
  assert.match(out.join(""), /started the Lavish server on :4390, as none was running: pid 4242 runs lavish-axi 9\.9\.9/);
});

test("the wrapper turns upstream's idle timeout off unless the caller sets one", () => {
  for (const [given, expected] of [[undefined, "off"], ["", "off"], [" ", "off"], ["600000", "600000"], ["0", "0"]]) {
    const seen = [];
    const deps = {
      restartStaleServer: (env) => { seen.push(env.LAVISH_AXI_IDLE_TIMEOUT_MS); return 0; },
      spawnSync: (_bin, _args, { env }) => { seen.push(env.LAVISH_AXI_IDLE_TIMEOUT_MS); return { status: 0, stdout: "", stderr: "" }; },
    };
    const env = { LAVISH_AXI_NO_OPEN: "1", ...(given === undefined ? {} : { LAVISH_AXI_IDLE_TIMEOUT_MS: given }) };
    lavish.main(["sessions"], env, deps, quiet);
    assert.deepEqual(seen, [expected, expected], `given ${JSON.stringify(given)}: the check and upstream's CLI both see it`);
  }
});

test("every server-bound command checks for a stale server first; server and --version do not", () => {
  for (const [args, checked] of [[["review.html"], true], [["poll", "review.html"], true], [[], true],
    [["stop"], true], [["server", "--port", "4387"], false], [["--version"], false]]) {
    const order = [];
    const deps = {
      restartStaleServer: () => { order.push("check"); return 0; },
      spawnSync: () => { order.push("lavish"); return { status: 0, stdout: "", stderr: "" }; },
    };
    lavish.main(args, { LAVISH_AXI_NO_OPEN: "1" }, deps, quiet);
    assert.deepEqual(order, checked ? ["check", "lavish"] : ["lavish"], args.join(" "));
  }
});

test("--restart-stale-server only checks, starts a down server too, and returns its result", () => {
  const order = [];
  const deps = {
    restartStaleServer: (env, _deps, _io, options) => { order.push(["check", env.LAVISH_AXI_IDLE_TIMEOUT_MS, options]); return 1; },
    spawnSync: () => order.push("lavish"),
  };
  assert.equal(lavish.main(["--restart-stale-server"], {}, deps, quiet), 1);
  assert.deepEqual(order, [["check", "off", { startIfDown: true }]]);
});
