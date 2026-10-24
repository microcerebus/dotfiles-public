// The test-only live-port guard (tests/lib/live-port-guard.cjs) must refuse
// every way node opens a connection to a live agent Chrome port. The real
// connect is stubbed before the guard loads, so nothing leaves the process:
// a connection the guard lets through shows up as "reached", never as traffic.
// The keep guard of 24 Oct 2026 missed http.get: http.request and
// net.createConnection hand Socket.connect a normalized [options, cb] array.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const GUARD = join(__dirname, "lib/live-port-guard.cjs");

const STUB = `
const net = require("node:net");
globalThis.reached = [];
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  globalThis.reached.push(Number(typeof first === "object" && first !== null ? first.port : first));
  return this;
};
`;

const PROBE = `
const http = require("node:http");
const net = require("node:net");
const quiet = (emitter) => emitter.on("error", () => {});
const ways = {
  "http.get url": (port) => quiet(http.get(\`http://127.0.0.1:\${port}/json/version\`)),
  "http.request options": (port) => quiet(http.request({ host: "127.0.0.1", port, path: "/" })).end(),
  "net.connect(port)": (port) => quiet(net.connect(port, "127.0.0.1")),
  "net.createConnection(options)": (port) => quiet(net.createConnection({ port, host: "127.0.0.1" })),
  "socket.connect(port)": (port) => quiet(new net.Socket().connect(port, "127.0.0.1")),
  "socket.connect(options)": (port) => quiet(new net.Socket().connect({ port, host: "127.0.0.1" })),
  "fetch": (port) => fetch(\`http://127.0.0.1:\${port}/json/version\`, { signal: AbortSignal.timeout(300) }),
  "fetch URL object": (port) => fetch(new URL(\`http://127.0.0.1:\${port}/json/version\`), { signal: AbortSignal.timeout(300) }),
};
(async () => {
  const results = [];
  for (const port of [9333, 9222, 9334, 9999]) {
    for (const [way, open] of Object.entries(ways)) {
      const before = globalThis.reached.length;
      let refused = false;
      try { await Promise.race([Promise.resolve(open(port)).catch((e) => { if (/live-port-guard/.test(e.message)) refused = true; }), new Promise((r) => setTimeout(r, 400))]); }
      catch (error) { refused = /live-port-guard/.test(error.message); }
      results.push({ port, way, refused, reached: globalThis.reached.slice(before).includes(port) });
    }
  }
  const unparsable = await fetch("http://[not a host/json/version").then(() => "fetched", (error) => error.message);
  process.stdout.write(JSON.stringify({ results, unparsable }));
  process.exit(0);
})();
`;

test("the guard refuses every way to open 9333, 9222 and 9334, and still lets 9999 through", (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), "live-port-guard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(join(dir, "stub.cjs"), STUB);
  // Only the stub and the guard: no inherited preloads, so the result is this guard's alone.
  const out = execFileSync(process.execPath, ["--require", join(dir, "stub.cjs"), "--require", GUARD, "-e", PROBE],
    { env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 30000 });
  const { results, unparsable } = JSON.parse(out);
  assert.equal(results.length, 32);
  for (const { port, way, refused, reached } of results) {
    if (port === 9999) assert.ok(reached && !refused, `${way} to 9999 must go through to the (stubbed) connect`);
    else assert.ok(refused && !reached, `${way} to ${port} was ${reached ? "let through to connect" : "not refused"}; tests/lib/live-port-guard.cjs must refuse it (${way.startsWith("fetch") ? "its globalThis.fetch wrapper rejects a live port before undici connects" : "read the port from inside Socket.connect's [options, cb] array"}).`);
  }
  assert.match(unparsable, /^live-port-guard: refused fetch\(http:\/\/\[not a host\/json\/version\), a target it cannot parse/,
    "tests/lib/live-port-guard.cjs must refuse a fetch target it cannot parse instead of handing it to the real fetch.");
});
