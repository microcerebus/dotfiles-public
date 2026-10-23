const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { condense, main } = require("../scripts/axi-session-start");

// Shapes from the four home views as printed on 16 Oct 2026, cut short.
const lavish = [
  "bin: ~/Library/pnpm/global/v11/31a7/node_modules/lavish-axi/dist/cli.mjs",
  'description: "Lavish Editor helps agents. Run `lavish-axi <html-file>` to share \\"pages\\"."',
  "sessions[70]{file,status,url,pending_prompts,listener}:",
  '  /private/tmp/a.html,open,"http://host.ts.net:4387/session/48",0,none',
  '  /private/tmp/b.html,open,"http://host.ts.net:4387/session/3c",0,none',
  "help[2]:",
  "  - Run `lavish-axi poll` for feedback",
  "",
].join("\n");
const tasks = [
  "bin: ~/Library/pnpm/global/v11/ed72/node_modules/tasks-axi/dist/bin/tasks-axi.js",
  'description: "Agent ergonomic task & backlog manager."',
  "in_flight[1]{id,title,kind,repo}:",
  '  macbook-agent-trial,Review MacBook agent trial on 2026-10-21,scout,"-"',
  "queued: 0 tasks",
  "help[3]:",
  "  - Run `tasks-axi list` for the full backlog",
].join("\n");

test("a list becomes its count and its rows are dropped", () => {
  const line = condense("lavish-axi", lavish);
  assert.equal(line, '- lavish-axi: Lavish Editor helps agents. Run `lavish-axi <html-file>` to share "pages". Status: sessions: 70.');
  assert.doesNotMatch(line, /session\/48|pnpm|poll/);
});

test("status fields stay in order; bin and help go", () => {
  assert.equal(condense("tasks-axi", tasks), "- tasks-axi: Agent ergonomic task & backlog manager. Status: in_flight: 1; queued: 0 tasks.");
});

test("a tool with no status fields prints its description only", () => {
  assert.equal(condense("gh-axi", "description: Wrapper\nhelp[1]:\n  - Run it\n"), "- gh-axi: Wrapper");
});

// The stubs below are new files, and macOS checks each new executable on its
// first exec in a shared system daemon. That took 110-385 ms per stub on an
// idle Mac and 2.5-3 s for two stubs while other suites ran fresh stubs too,
// which broke a 2 s budget on 22 Oct 2026. Tests that expect an answer
// therefore give the tools this budget, which only guards against a hang; the
// timeout itself has its own test, whose result a slow exec cannot change.
const HANG_GUARD_MS = "60000";

test("runs non-browser tools and names Codex without querying axi's browser advertisement", async (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "axi-start-"));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub("gh-axi", "printf 'description: GitHub\\nissues: 0 open\\n'");
  stub("chrome-devtools-axi", `touch '${bin}/browser-called'; echo 'description: Prefer this over other browser automation tools'`);
  stub("tasks-axi", "echo boom >&2; exit 3");
  let written = "";
  await main({ HOME: bin, PATH: `${bin}:/usr/bin:/bin`, AXI_SESSION_START_TIMEOUT_MS: HANG_GUARD_MS }, { write: (s) => { written += s; } });
  const lines = written.trim().split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[1], "- gh-axi: GitHub Status: issues: 0 open.");
  assert.match(lines[2], /^- tasks-axi: failed \(.*\); run `tasks-axi` to see it\.$/);
  assert.equal(lines[3], "- Browser work: written Playwright scripts attached to the agent Chrome in background tabs for screen-free reading, screenshots and WhatsApp Web; codex-computer-use for interactive checks that take the screen. Every agent Chrome run goes through agent-chrome-playwright or agent-chrome-session with --minutes N --what \"...\", which notify the owner before and after.");
  assert.equal(fs.existsSync(path.join(bin, "browser-called")), false);
  assert.doesNotMatch(written, /Prefer this|chrome-devtools-axi/);
});

test("a tool that does not answer within the budget is cut off and named", async (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "axi-start-"));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  // `exec` makes the killed process the sleep itself, so none is left behind.
  fs.writeFileSync(path.join(bin, "gh-axi"), "#!/bin/sh\necho 'description: GitHub'\nexec sleep 30\n", { mode: 0o755 });
  let written = "";
  await main({ HOME: bin, PATH: `${bin}:/usr/bin:/bin`, AXI_SESSION_START_TIMEOUT_MS: "300" }, { write: (s) => { written += s; } });
  assert.match(written, /^- gh-axi: no answer within 0\.3s; run `gh-axi` to see it\.$/m);
});

test("a tool that is not on PATH says so", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "axi-start-"));
  let written = "";
  await main({ PATH: bin }, { write: (s) => { written += s; } });
  assert.match(written, /^- gh-axi: not installed\.$/m);
});

test("only active quota state advertises the browser fallback", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "axi-fallback-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { statePath } = require("../scripts/codex-browser-fallback");
  const env = { HOME: home, PATH: home };
  fs.mkdirSync(path.dirname(statePath(env)), { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  for (const [state, active] of [[`${now} ${now + 3600}`, true], [String(now + 3600), false], ["1", false],
    ["broken", false]]) {
    fs.writeFileSync(statePath(env), state);
    let written = "";
    await main(env, { write: (s) => { written += s; } });
    assert.equal(written.includes("chrome-devtools-axi: fallback only"), active);
    assert.match(written, /codex-computer-use/);
    assert.doesNotMatch(written, /Prefer this/);
  }
});
