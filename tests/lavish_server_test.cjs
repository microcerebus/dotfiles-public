// Tests for the stale-server restart in scripts/lavish-axi.
// On 16 Oct 2026 a pnpm update deleted the package directory a running Lavish
// server read its page assets from, so /chrome.css and /chrome-client.js
// answered 500 and every Lavish page was blank. The first test reproduces
// that with a real server started from a copy of the installed lavish-axi,
// then deletes the copy and checks the restart. It needs lavish-axi as a pnpm
// global and skips without it. The server binds 127.0.0.1 only, on a free
// port, with its own state dir.
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

test("nothing stale means no stop, no start and no output", () => {
  const calls = [];
  const out = [];
  const deps = { ...fakeDeps([`${pnpm}/aaaa-1/`]), spawnSync: (...a) => { calls.push(a); return { status: 0 }; }, spawn: (...a) => calls.push(a) };
  assert.equal(lavish.restartStaleServer({}, deps, { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) } }), 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(out, []);
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

test("--restart-stale-server only restarts, and returns its result", () => {
  const order = [];
  const deps = { restartStaleServer: () => { order.push("check"); return 1; }, spawnSync: () => order.push("lavish") };
  assert.equal(lavish.main(["--restart-stale-server"], {}, deps, quiet), 1);
  assert.deepEqual(order, ["check"]);
});
