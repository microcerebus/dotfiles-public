// Test-only: refuses every connection to the live agent Chrome ports, so a test
// that falls through to a production default fails here instead of reaching
// the gate on 9333 (which notifies the owner), Chrome on 9334, or his own Chrome on
// 9222. On 24 Oct 2026, mutant runs reached the live gate seven times.
// http.request and net.createConnection hand Socket.connect a normalized
// [options, cb] array, so the port is read from inside it.
// Loaded by tests/lib/agent-chrome-test-env.cjs. Tests: tests/live_port_guard_test.cjs.
const net = require("node:net");

const LIVE_PORTS = [9333, 9222, 9334];
const FIX = "Point the test at a dead or stub port: load tests/lib/agent-chrome-test-env.cjs first and pass the script its test URL or port.";

function refusal(port) {
  return new Error(`live-port-guard: refused a connection to 127.0.0.1:${port}, a live agent Chrome port. ${FIX}`);
}

function portOf(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  return Number(typeof first === "object" && first !== null ? first.port : first);
}

if (!net.Socket.prototype.connect.liveGuarded) {
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const port = portOf(args);
    if (LIVE_PORTS.includes(port)) throw refusal(port);
    return connect.apply(this, args);
  };
  net.Socket.prototype.connect.liveGuarded = true;
}

if (typeof globalThis.fetch === "function" && !globalThis.fetch.liveGuarded) {
  const fetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    let url;
    // Real fetch rejects a target it cannot parse too, so refusing one breaks nothing.
    try { url = new URL(typeof input === "string" || input instanceof URL ? input : input.url); }
    catch { return Promise.reject(new Error(`live-port-guard: refused fetch(${String(input?.url ?? input)}), a target it cannot parse, so it cannot rule out a live agent Chrome port. ${FIX}`)); }
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (LIVE_PORTS.includes(port)) return Promise.reject(refusal(port));
    return fetch(input, init);
  };
  globalThis.fetch.liveGuarded = true;
}

module.exports = { LIVE_PORTS };
