require("./lib/agent-chrome-test-env.cjs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { statePath, fallbackUntil } = require("../scripts/codex-browser-fallback");

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, PATH: process.env.PATH };
  const helper = (...args) => spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/codex-browser-fallback"), ...args], { env, encoding: "utf8" });
  // Even an accidentally allowed command can only reach this harmless stub.
  const binary = path.join(home, "Library/pnpm/bin/chrome-devtools-axi");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, "#!/bin/sh\nprintf 'stub upstream: %s\\n' \"$*\"\n", { mode: 0o755 });
  const wrapper = (signal, args) => spawnSync(process.execPath, [
    path.resolve(__dirname, "../scripts/chrome-devtools-axi"), ...args,
  ], { env: { ...env, ...signal, CHROME_DEVTOOLS_AXI_BROWSER_URL: "" }, encoding: "utf8" });
  return { env, helper, wrapper };
}

test("helper sets, replaces and clears one private expiry file", (t) => {
  const { env, helper } = fixture(t);
  assert.equal(helper("status").status, 1);
  const until = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(helper("set", String(until)).status, 0);
  assert.equal(fallbackUntil(env), until);
  assert.equal(fs.statSync(statePath(env)).mode & 0o777, 0o600);
  assert.equal(helper("set", String(until + 60)).status, 0);
  assert.equal(fallbackUntil(env), until + 60);
  assert.equal(helper("clear").status, 0);
  assert.equal(helper("clear").status, 0);
  assert.equal(helper("status").status, 1);
});

test("invalid or past reset times fail without changing existing state", (t) => {
  const { env, helper } = fixture(t);
  const until = String(Math.floor(Date.now() / 1000) + 3600);
  helper("set", until);
  for (const args of [["set"], ["set", "1"], ["set", "-1"], ["set", "Infinity"], ["set", "999999999999999"],
    ["set", "123junk"], ["set", until, "extra"], ["clear", "extra"]]) {
    assert.equal(helper(...args).status, 2);
    assert.equal(fallbackUntil(env), Number(until));
  }
});

test("set refuses a reset time more than 7 days ahead", (t) => {
  const { env, helper } = fixture(t);
  const now = Math.floor(Date.now() / 1000);
  const until = String(now + 3600);
  helper("set", until);
  for (const ahead of [7 * 86400 + 60, 30 * 86400, 10 * 365 * 86400]) {
    const result = helper("set", String(now + ahead));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /7 days/);
    assert.equal(fallbackUntil(env), Number(until));
  }
  assert.equal(helper("set", String(now + 7 * 86400 - 60)).status, 0);
});

test("the helper records when it was set next to the reset time", (t) => {
  const { env, helper } = fixture(t);
  const before = Math.floor(Date.now() / 1000);
  const until = before + 3600;
  helper("set", String(until));
  const [set, stored] = fs.readFileSync(statePath(env), "utf8").trim().split(" ").map(Number);
  assert.ok(set >= before && set <= Math.floor(Date.now() / 1000), set);
  assert.equal(stored, until);
});

test("the 7-day ceiling counts from when the state was set, not from when it is read", (t) => {
  const { env, helper, wrapper } = fixture(t);
  const file = statePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const set = 2000000000;
  const now = set * 1000;
  const day = 86400;
  // A reset time 30 days after it was set stays inactive even 24 days later, inside a week of its time.
  fs.writeFileSync(file, `${set} ${set + 30 * day}\n`);
  for (const later of [0, 24, 29]) assert.equal(fallbackUntil(env, now + later * day * 1000), null, later);
  // A valid 3-day state is active until its reset time, and 7 days exactly is the ceiling.
  fs.writeFileSync(file, `${set} ${set + 3 * day}\n`);
  assert.equal(fallbackUntil(env, now), set + 3 * day);
  assert.equal(fallbackUntil(env, now + 2 * day * 1000), set + 3 * day);
  fs.writeFileSync(file, `${set} ${set + 7 * day}\n`);
  assert.equal(fallbackUntil(env, now + 6 * day * 1000), set + 7 * day);
  fs.writeFileSync(file, `${set} ${set + 7 * day + 1}\n`);
  assert.equal(fallbackUntil(env, now + 6 * day * 1000), null);
  // A set time in the future is a clock trick or a typo.
  fs.writeFileSync(file, `${set + 1} ${set + 3 * day}\n`);
  assert.equal(fallbackUntil(env, now), null);
  assert.equal(fallbackUntil(env, now + 1000), set + 3 * day);
  // A file written by hand far ahead, as with `echo 1 99999999999 > until`, never opens the gate.
  fs.writeFileSync(file, "1 99999999999\n");
  assert.equal(fallbackUntil(env), null);
  assert.equal(helper("status").status, 1);
  assert.equal(wrapper({ CLAUDECODE: "1" }, ["pages"]).status, 2);
});

test("the old one-number state reads as inactive, even when its time is near", (t) => {
  const { env, helper, wrapper } = fixture(t);
  const file = statePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${Math.floor(Date.now() / 1000) + 3600}\n`);
  assert.equal(fallbackUntil(env), null);
  assert.equal(helper("status").status, 1);
  assert.equal(wrapper({ CLAUDECODE: "1" }, ["pages"]).status, 2);
});

test("the expiry boundary, malformed and unreadable state all fail closed", (t) => {
  const { env } = fixture(t);
  const file = statePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const state of ["", "1", "NaN", "999999999999999", "2000000000", "1999990000 2000000000 trailing",
    "1999990000  2000000000", "1999990000\n2000000000", "0 2000000000", "1999990000 999999999999999",
    "2000000000 1999990000"]) {
    fs.writeFileSync(file, state);
    assert.equal(fallbackUntil(env, 1999999999000), null, state);
  }
  fs.writeFileSync(file, "1999990000 2000000000\n");
  assert.equal(fallbackUntil(env, 1999999999999), 2000000000);
  assert.equal(fallbackUntil(env, 2000000000000), null);
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.equal(fallbackUntil(env), null);
});

test("CLI replay refuses missing and expired fallback, permits active fallback, then refuses after clear", (t) => {
  const { env, helper, wrapper } = fixture(t);
  const signals = [{ CLAUDECODE: "1" }, { CODEX_THREAD_ID: "fixture" }, { CODEX_SESSION_ID: "fixture" },
    { CODEX_CI: "1" }, { CLAUDE_CODE_SESSION_ID: "fixture" }];
  const commands = [["emulate", "--viewport", "390x844x3,mobile,touch"],
    ["open", "https://example.com/packs/replace-lavish/"],
    ["newpage", "https://web.whatsapp.com/"], ["eval", "document.title"], ["pages"], ["closepage", "1"],
    [], ["--help"], ["stop"]];
  const now = Math.floor(Date.now() / 1000);
  for (const state of [null, "1", "garbage", `${now - 7200} ${now - 3600}`, String(now + 3600)]) {
    if (state !== null) {
      fs.mkdirSync(path.dirname(statePath(env)), { recursive: true });
      fs.writeFileSync(statePath(env), state);
    }
    for (const signal of signals) {
      for (const args of commands) {
        const result = wrapper(signal, args);
        assert.equal(result.status, 2);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /codex-computer-use/);
        assert.match(result.stderr, /model-routing\.md/);
      }
    }
  }
  helper("set", String(Math.floor(Date.now() / 1000) + 3600));
  for (const signal of signals) {
    const allowed = wrapper(signal, commands[0]);
    assert.equal(allowed.status, 0);
    assert.match(allowed.stderr, /Codex quota fallback active until/);
    assert.match(allowed.stdout, /stub upstream: emulate --viewport 390x844x3,mobile,touch/);
  }
  helper("clear");
  assert.equal(wrapper(signals[0], commands[0]).status, 2);
  assert.equal(wrapper({}, commands[0]).status, 0);
});
