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

test("runs every tool; a missing, hung or failing tool gets one line", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "axi-start-"));
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub("gh-axi", "printf 'description: GitHub\\nissues: 0 open\\n'");
  stub("lavish-axi", "exec sleep 5");
  stub("tasks-axi", "echo boom >&2; exit 3");
  let written = "";
  await main({ PATH: `${bin}:/usr/bin:/bin`, AXI_SESSION_START_TIMEOUT_MS: "2000" }, { write: (s) => { written += s; } });
  const lines = written.trim().split("\n");
  assert.equal(lines.length, 5);
  assert.equal(lines[1], "- gh-axi: GitHub Status: issues: 0 open.");
  assert.equal(lines[2], "- chrome-devtools-axi: not installed.");
  assert.match(lines[3], /^- lavish-axi: no answer within 2s; run `lavish-axi` to see it\.$/);
  assert.match(lines[4], /^- tasks-axi: failed \(.*\); run `tasks-axi` to see it\.$/);
});
