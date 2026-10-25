// tests/lib/sandbox-env.cjs hands scripts/test-sandbox's temp settings to a
// child whose env a test built by hand. Such an env is scrubbed on purpose: it
// leaves out live Chrome URLs, real keychain paths and the like. So the helper
// must add the sandbox's settings and nothing else, and nothing at all outside
// the sandbox. The helper reads the sandbox once, as it loads, so each case
// loads it in a fresh node process with the parent env the case gives. That
// checks the same thing inside test-sandbox and out.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { DEFAULT_PATH } = require("./lib/sandbox-env.cjs");

const HELPER = join(__dirname, "lib/sandbox-env.cjs");
// The parent env test-sandbox gives its command: TEST_SANDBOX/bin first on PATH.
const SANDBOX = { TEST_SANDBOX: "/tmp/sbx", TMPDIR: "/tmp/sbx/tmp/", XDG_CACHE_HOME: "/tmp/sbx/cache", PATH: "/tmp/sbx/bin:/usr/bin:/bin" };

// withSandbox(env) as a process started with the parent env `parent` computes
// it, as the exact JSON text it hands on. `script` replaces the default print.
function childOf(parent, env, script = "process.stdout.write(JSON.stringify(withSandbox(JSON.parse(process.argv[1]))))") {
  const guard = process.env.NODE_OPTIONS === undefined ? {} : { NODE_OPTIONS: process.env.NODE_OPTIONS };
  const run = spawnSync(process.execPath, ["-e", `const { withSandbox } = require(${JSON.stringify(HELPER)}); ${script}`, JSON.stringify(env)],
    { env: { ...guard, ...parent }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

test("outside test-sandbox a hand-built env goes to the child as it is", () => {
  const env = { PATH: "/usr/bin", USER: "tester" };
  assert.equal(childOf({ TMPDIR: "/tmp/elsewhere/", PATH: "/usr/bin:/bin" }, env), JSON.stringify(env));
});

test("a stray TEST_SANDBOX, without its bin dir on PATH, changes nothing", () => {
  const env = { PATH: "/fake/bin:/usr/bin", USER: "tester" };
  const unset = childOf({ TMPDIR: "/tmp/elsewhere/", PATH: "/usr/bin:/bin" }, env);
  // An export left over in a shell, and one beside another sandbox's bin dir.
  for (const PATH of ["/usr/bin:/bin", "/tmp/other/bin:/usr/bin:/bin:/tmp/sbx/binx"]) {
    assert.equal(childOf({ ...SANDBOX, PATH, TMPDIR: "/tmp/elsewhere/" }, env), unset,
      `TEST_SANDBOX=/tmp/sbx with PATH=${PATH} is not test-sandbox, which starts its command with /tmp/sbx/bin on PATH; the child env must be what it is with TEST_SANDBOX unset`);
  }
});

test("under test-sandbox a child's own children get the settings too", () => {
  // A child's PATH has its stubs, or the live-port helper's curl guard, ahead of the shim dir.
  const parent = { ...SANDBOX, PATH: "/guard:/stubs:/tmp/sbx/bin:/usr/bin" };
  assert.equal(JSON.parse(childOf(parent, { PATH: "/usr/bin" })).TMPDIR, "/tmp/sbx/tmp/");
});

test("under test-sandbox only the sandbox's temp settings and its bin dir are added", () => {
  // Live settings in the parent env stand in for anything a scrubbed env leaves out on purpose.
  const live = { CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:9333", AGENT_CHROME_SESSION_TEST_GATE_URL: "http://127.0.0.1:9333", HOME: "/Users/someone" };
  const env = { PATH: "/fake/bin:/usr/bin", USER: "tester" };
  assert.deepEqual(JSON.parse(childOf({ ...SANDBOX, ...live }, env)), {
    PATH: "/fake/bin:/tmp/sbx/bin:/usr/bin", USER: "tester",
    TEST_SANDBOX: "/tmp/sbx", TMPDIR: "/tmp/sbx/tmp/", XDG_CACHE_HOME: "/tmp/sbx/cache", MAC_CHROMIUM_TMPDIR: "/tmp/sbx/tmp/",
  }, "withSandbox must add exactly TEST_SANDBOX, TMPDIR, XDG_CACHE_HOME, MAC_CHROMIUM_TMPDIR and the shim dir on PATH; anything more defeats a test's scrubbed env");
  assert.equal(childOf(SANDBOX, env, "const env = JSON.parse(process.argv[1]); withSandbox(env); process.stdout.write(JSON.stringify(env))"),
    JSON.stringify(env), "withSandbox must not change the env it is given");
});

test("under test-sandbox the shim dir goes after the test's own dirs and before the system dirs", () => {
  for (const [path, want] of [
    ["/fake/bin:/stubs:/usr/bin:/bin", "/fake/bin:/stubs:/tmp/sbx/bin:/usr/bin:/bin"],
    ["/fake/bin", "/fake/bin:/tmp/sbx/bin"],
    ["/bin:/fake/bin", "/tmp/sbx/bin:/bin:/fake/bin"],
  ]) assert.equal(JSON.parse(childOf(SANDBOX, { PATH: path })).PATH, want);
});

test("under test-sandbox a test's stub wins over a same-named file in the shim dir", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "sandbox-env-stub-"));
  try {
    for (const [sub, says] of [["sbx/bin", "shim"], ["stubs", "stub"]]) {
      fs.mkdirSync(join(dir, sub), { recursive: true });
      fs.writeFileSync(join(dir, sub, "tool"), `#!/bin/sh\necho ${says}\n`, { mode: 0o755 });
    }
    const parent = { TEST_SANDBOX: join(dir, "sbx"), TMPDIR: tmpdir(), PATH: `${join(dir, "sbx/bin")}:/usr/bin:/bin` };
    const ran = childOf(parent, { PATH: `${join(dir, "stubs")}:/usr/bin:/bin` },
      "process.stdout.write(require('node:child_process').execFileSync('tool', { env: withSandbox(JSON.parse(process.argv[1])), encoding: 'utf8' }))");
    assert.equal(ran, "stub\n", "the shim dir went ahead of the test's stubs on PATH");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("under test-sandbox a value the test set is kept, and an empty one is filled in", () => {
  const out = JSON.parse(childOf(SANDBOX, { PATH: "/usr/bin:/tmp/sbx/bin", TMPDIR: "/tmp/sbx/tmp/own/", XDG_CACHE_HOME: "" }));
  assert.equal(out.TMPDIR, "/tmp/sbx/tmp/own/");
  assert.equal(out.XDG_CACHE_HOME, "/tmp/sbx/cache");
  assert.equal(out.PATH, "/usr/bin:/tmp/sbx/bin", "a PATH that already has the shim dir stays as the test wrote it");
});

test("under test-sandbox an env with no PATH gets the shim dir before the shell's default PATH", () => {
  assert.equal(JSON.parse(childOf(SANDBOX, {})).PATH, `/tmp/sbx/bin:${DEFAULT_PATH}`);
});
