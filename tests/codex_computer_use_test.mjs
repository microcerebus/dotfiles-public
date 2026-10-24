// Run: node --test tests/codex_computer_use_test.mjs
// The codex-computer-use skill's brief for browser checks (standing order 69): Codex drives the agent Chrome through
// computer use, brings it to the front without being able to start it, shares its one window politely, and is never
// handed chrome-devtools-axi as its driver. Coordinator 24 saw Codex reach for chrome-devtools-axi until told not to,
// and fail to act in Chrome Beta until it was brought to the front (2026-10-17).
// The sentences are matched exactly on purpose: job-tracker's control skill carries the same text, so rewording them
// here means updating this test and passing the new wording on.
import "./lib/agent-chrome-test-env.cjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = fs.readFileSync(path.join(REPO, 'files/.claude/skills/codex-computer-use/SKILL.md'), 'utf8');
const section = (text, title) => {
  const at = text.indexOf(`\n## ${title}\n`);
  return at < 0 ? '' : text.slice(at, text.indexOf('\n## ', at + 1) >>> 0);
};
const browser = section(skill, 'Browser checks');
// The sentences the skill tells the caller to paste into Codex's prompt, one per quoted paragraph.
const sentences = browser.split('\n').filter((l) => l.trim().startsWith('>')).map((l) => l.replace(/^\s*>\s?/, '')).filter(Boolean);
const SENTENCES = [
  "Drive the agent Chrome (Google Chrome Beta, its own profile on 127.0.0.1:9333) through computer use: click, type and screenshot in its window. Do not use chrome-devtools-axi, Playwright or any other browser tool, and never Brave or the owner's own Chrome.",
  "First bring Google Chrome Beta to the front with `osascript -e 'tell application \"System Events\" to set frontmost of process \"Google Chrome Beta\" to true'`, which cannot start it: its launchd agent is the only way Chrome Beta is ever started, so if it is not running, stop and report instead of starting it.",
  'Every agent shares this one window: open your own new tab and close it when done, never resize or move the window, and never touch other tabs.',
];

test('the Codex brief is the three shared sentences, as written', () => {
  assert.deepEqual(sentences, SENTENCES);
});

test('nothing in the skill starts Chrome Beta outside its launchd agent', () => {
  assert.doesNotMatch(skill, /^\s*open -a "?Google Chrome Beta/m, 'open -a would start Chrome Beta without its launch flags');
  assert.doesNotMatch(skill, /tell application "Google Chrome Beta" to activate/, 'activate would start Chrome Beta without its launch flags');
});

// The start-up check is a script, not shell lines in the Markdown: agents copied those lines out by hand, and twice
// on 2026-10-17 the copy took the Codex prompt next to them too and started a Codex run.
const READY = path.join(REPO, 'scripts/agent-chrome-ready');
const CURL_CHECK = /curl[^\n]*9333|launchctl kickstart/;

test('the skill puts readiness and screen permission in the launcher, with no inline check', () => {
  assert.match(browser, /launcher runs `agent-chrome-ready` before showing the warning/);
  assert.match(skill, /codex-computer-use --minutes 5 --/);
  assert.doesNotMatch(skill, /CODEX=|"\$CODEX" exec/);
  assert.doesNotMatch(skill, CURL_CHECK, 'the start-up check belongs in scripts/agent-chrome-ready');
});

test('agent-chrome-ready kickstarts the launchd agent, retries for 15 seconds with a 2-second cap per request, and stops', () => {
  const script = fs.readFileSync(READY, 'utf8');
  assert.match(script, /launchctl kickstart "gui\/\$\(id -u\)\/com\.myuser\.agent-chrome"/);
  // -m 2 caps each request: --retry-max-time only limits retries, so a port that accepts and never answers hung it.
  assert.match(script, /curl -sf -m 2 "\$url" /);
  assert.match(script, /curl -sf -m 2 --retry 15 --retry-delay 1 --retry-max-time 15 --retry-connrefused "\$url"/);
  assert.doesNotMatch(script, /curl (?!-sf -m 2 )/, 'every curl in the check needs a per-request time limit');
  assert.match(script, /the agent Chrome is not up on 127\.0\.0\.1:\$port after 15s; see ~\/Library\/Logs\/agent-chrome\.log/);
  assert.doesNotMatch(script, /open -a|\bactivate\b|Google Chrome Beta\.app/, 'only the launchd agent may start Chrome Beta');
});

// A free port on 127.0.0.1, released for the stub to take.
const freePort = () => new Promise((resolve) => {
  const server = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

// A python3 -I listener on port: 'answer' serves /json/version, 'hang' accepts and never replies. It is killed by its
// own pid, never by pattern, and signal.alarm ends it after 60 seconds anyway, so a killed test run leaves no listener.
const stub = async (port, mode) => {
  const code = 'import signal; signal.alarm(60)\n' + (mode === 'answer'
    ? `import http.server as h
class H(h.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
    def log_message(self, *a): pass
h.HTTPServer(('127.0.0.1', ${port}), H).serve_forever()`
    : `import socket, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('127.0.0.1', ${port})); s.listen(64)
held = []
while True: held.append(s.accept()[0])`);
  const child = spawn('python3', ['-I', '-c', code], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    const up = await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => { sock.destroy(); resolve(true); }).on('error', () => resolve(false));
    });
    if (up) return child;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`stub on ${port} never listened`);
};

// Runs the script against port with launchctl stubbed to fail first on PATH, so a fallback to the real launchctl can
// never kickstart the agent Chrome. The kickstart hook (default: count a line in a marker file) replaces the kickstart.
// Resolves to its exit code, stderr, seconds taken, and how many times each of the hook and launchctl ran.
const runReady = (port, { kickstart } = {}) => new Promise((resolve) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chrome-ready-'));
  const marker = path.join(dir, 'kickstarts');
  const launchctlMarker = path.join(dir, 'launchctl');
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin/launchctl'), `#!/bin/sh\necho "$*" >> '${launchctlMarker}'\nexit 1\n`, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
    AGENT_CHROME_READY_TEST_PORT: String(port),
    AGENT_CHROME_READY_TEST_KICKSTART: kickstart ?? `echo kickstart >> '${marker}'`,
  };
  if (kickstart === null) delete env.AGENT_CHROME_READY_TEST_KICKSTART;
  const started = Date.now();
  const child = spawn(READY, [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0);
  child.on('close', (code) => {
    const result = { code, stderr, seconds: (Date.now() - started) / 1000, kickstarts: lines(marker), launchctl: lines(launchctlMarker) };
    fs.rmSync(dir, { recursive: true, force: true });
    resolve(result);
  });
});

test('agent-chrome-ready exits 0 when the port answers', async () => {
  const port = await freePort();
  const child = await stub(port, 'answer');
  try {
    const { code, seconds, kickstarts, launchctl } = await runReady(port);
    assert.equal(code, 0);
    assert.ok(seconds < 3, `took ${seconds}s`);
    assert.equal(kickstarts, 0, 'a Chrome that answers needs no kickstart');
    assert.equal(launchctl, 0);
  } finally { child.kill(); }
});

test('agent-chrome-ready exits 1 within about 20 seconds when the port accepts and never answers', { timeout: 30_000 }, async () => {
  const port = await freePort();
  const child = await stub(port, 'hang');
  try {
    const { code, stderr, seconds, kickstarts, launchctl } = await runReady(port);
    assert.equal(code, 1);
    assert.match(stderr, new RegExp(`not up on 127\\.0\\.0\\.1:${port} after 15s; see ~/Library/Logs/agent-chrome\\.log`));
    assert.ok(seconds >= 14 && seconds < 22, `took ${seconds}s`);
    assert.equal(kickstarts, 1);
    assert.equal(launchctl, 0);
  } finally { child.kill(); }
});

test('agent-chrome-ready exits 1 when nothing listens', { timeout: 30_000 }, async () => {
  const { code, stderr, seconds, kickstarts, launchctl } = await runReady(await freePort());
  assert.equal(code, 1);
  assert.match(stderr, /the agent Chrome is not up/);
  assert.ok(seconds < 22, `took ${seconds}s`);
  assert.equal(kickstarts, 1, 'a port that is down gets exactly one kickstart');
  assert.equal(launchctl, 0);
});

// A test that sets the stub port but forgets the kickstart hook must not reach the real launchctl.
for (const [name, kickstart] of [['unset', null], ['empty', '']]) {
  test(`agent-chrome-ready refuses to run launchctl under a test port when the kickstart hook is ${name}`, { timeout: 30_000 }, async () => {
    const { code, stderr, seconds, launchctl } = await runReady(await freePort(), { kickstart });
    assert.equal(code, 1);
    assert.equal(launchctl, 0, 'launchctl ran under a test port');
    assert.match(stderr, /AGENT_CHROME_READY_TEST_PORT is set but AGENT_CHROME_READY_TEST_KICKSTART is not/);
    assert.ok(seconds < 3, `took ${seconds}s`);
  });
}

test('the skill never offers chrome-devtools-axi as the browser driver', () => {
  const offers = skill.split('\n').filter((l) => /\b(prefer|use)( the)? chrome-devtools-axi/i.test(l.replace(/Do not use chrome-devtools-axi/g, '')));
  assert.deepEqual(offers, []);
});

test('browser discovery routes Codex to computer use and axi to the expiring quota fallback', () => {
  const axi = fs.readFileSync(path.join(REPO, 'files/.claude/skills/chrome-devtools-axi/SKILL.md'), 'utf8');
  assert.match(axi, /description: "Fallback-only Chrome CLI/);
  assert.match(axi, /Use written Playwright scripts attached to the agent Chrome in background tabs for screen-free work/);
  assert.match(axi, /Use `codex-computer-use` for interactive checks that need the screen/);
  assert.match(axi, /codex-browser-fallback status/);
  assert.doesNotMatch(axi, /Prefer this over other browser automation tools|Use whenever a task needs a real browser|Use chrome-devtools-axi whenever/);
  const device = fs.readFileSync(path.join(REPO, 'files/.claude/skills/agent-device/SKILL.md'), 'utf8');
  assert.match(device, /For screen-free web work use written Playwright scripts/);
  const agents = fs.readFileSync(path.join(REPO, 'files/AGENTS.md'), 'utf8');
  assert.match(agents, /Screen-free browser work.*written Playwright script attached to the agent Chrome in background tabs/);
  assert.doesNotMatch(agents, /which `chrome-devtools-axi` uses by default/);
});

test('verify-agent-board uses the screen-warning launcher and opens its prompt with the brief', () => {
  const board = fs.readFileSync(path.join(REPO, '.claude/skills/verify-agent-board/SKILL.md'), 'utf8');
  assert.match(board, /Run every interactive check through the `codex-computer-use` launcher/);
  assert.doesNotMatch(board, CURL_CHECK, 'the start-up check belongs in scripts/agent-chrome-ready');
  const block = /A Codex prompt[\s\S]*?```sh\n([\s\S]*?)```/.exec(board)?.[1] ?? '';
  assert.doesNotMatch(block, /agent-chrome-ready|"\$CODEX" exec/, 'the launcher owns readiness and the Codex binary');
  const prompt = (/codex-computer-use --minutes 5 -- "([\s\S]*)"\s*$/.exec(block)?.[1] ?? '')
    .replace(/ \\\n/g, ' ').replaceAll('\\`', '`').replaceAll('\\"', '"');
  assert.ok(prompt.startsWith(SENTENCES.join(' ')), `the board prompt does not open with the brief: ${prompt.slice(0, 120)}`);
});
