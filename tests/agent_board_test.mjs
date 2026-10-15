// Run: node --test tests/agent_board_test.mjs
// Builds a fixture copy of the T3 tables the board reads, plus Claude logs, and checks what the board shows.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { hostAllowed, parseSince, readUpdates, render, renderMap, snapshot, tailnetAddress } from '../files/bin/agent-board.mjs';

const BOARD = new URL('../files/bin/agent-board.mjs', import.meta.url);

const NOW = Date.parse('2026-10-11T03:30:00Z');
const iso = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-'));
  const dbPath = path.join(dir, 'statev2.sqlite');
  const logsDir = path.join(dir, 'projects');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, title TEXT,
      active_provider_thread_id TEXT, updated_at TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT);
    CREATE TABLE projection_projects (project_id TEXT, title TEXT);
    CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, ordinal INTEGER, status TEXT);
    CREATE TABLE projection_pending_approvals (thread_id TEXT, status TEXT);
    CREATE TABLE orchestration_v2_projection_runtime_requests (thread_id TEXT, kind TEXT, status TEXT,
      created_at TEXT, resolved_at TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT, provider TEXT, payload_json TEXT);
    INSERT INTO projection_projects VALUES ('p1', 'job-tracker'), ('p2', 'dotfiles');`);
  const thread = (id, project, title, minutesAgo, payload = {}, deleted = null) =>
    db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
      .run(id, project, title, `pt-${id}`, iso(minutesAgo), deleted, JSON.stringify(payload));
  const provider = (id, sessionId, contextUsage = null) =>
    db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?)')
      .run(`pt-${id}`, 'claudeAgent', JSON.stringify({ nativeThreadRef: { nativeId: sessionId }, contextUsage }));
  const run = (id, ordinal, status) => db.prepare('INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?)').run(id, ordinal, status);

  // A: running, busy, context from T3. B: waiting on an input card. C: idle. D: running but its log went quiet,
  // context only in the log. E: a running child of A. F: an idle child (hidden). G: settled. H: deleted.
  thread('A', 'p1', 'UI owner', 1, { branch: 'ui-polish', modelSelection: { model: 'claude-opus-5-5' } });
  provider('A', 'sess-a', { usedTokens: 210_000, maxTokens: 1_000_000 });
  run('A', 1, 'completed'); run('A', 2, 'running'); run('A', 3, 'cancelled');
  thread('B', 'p2', 'macOS update <script>alert(1)</script>', 3, { branch: 'macos' });
  provider('B', 'sess-b', { usedTokens: 90_000, maxTokens: 1_000_000 });
  run('B', 1, 'running');
  db.prepare('INSERT INTO orchestration_v2_projection_runtime_requests VALUES (?, ?, ?, ?, NULL)').run('B', 'user_input', 'pending', iso(6));
  db.prepare('INSERT INTO orchestration_v2_projection_runtime_requests VALUES (?, ?, ?, ?, ?)').run('C', 'user_input', 'resolved', iso(90), iso(80));
  thread('C', 'p1', 'Coordinator', 25);
  provider('C', 'sess-c', { usedTokens: 240_000, maxTokens: 1_000_000 });
  run('C', 1, 'completed');
  thread('D', 'p1', 'Reviewer', 30);
  provider('D', 'sess-d');
  run('D', 1, 'running');
  thread('E', 'p1', 'Delegated check', 2, { lineage: { parentThreadId: 'A' } });
  run('E', 1, 'running');
  thread('F', 'p1', 'Finished child', 40, { lineage: { parentThreadId: 'A' } });
  run('F', 1, 'completed');
  thread('G', 'p1', 'Settled thread', 50, { settledAt: iso(45) });
  thread('H', 'p1', 'Deleted thread', 60, {}, iso(55));
  db.close();

  const log = (sessionId, rows, minutesAgo) => {
    const file = path.join(logsDir, '-Users-x--t3-worktrees-repo', `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const at = new Date(NOW - minutesAgo * 60_000);
    fs.utimesSync(file, at, at);
  };
  const assistant = (content, usage, extra = {}) => ({ type: 'assistant', message: { content, usage }, ...extra });
  log('sess-a', [
    assistant([{ type: 'tool_use', name: 'Read' }], { input_tokens: 1 }),
    assistant([{ type: 'tool_use', name: 'Bash' }], { input_tokens: 1 }),
    assistant([{ type: 'tool_use', name: 'Grep' }], { input_tokens: 1 }, { isSidechain: true }),
  ], 0.5);
  log('sess-d', [
    assistant([{ type: 'text', text: 'checking' }], { input_tokens: 10, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 150_000 }),
    assistant([{ type: 'tool_use', name: 'Edit' }], { input_tokens: 5, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 160_000 }),
  ], 14);
  return { dbPath, logsDir, lanesDir: path.join(dir, 'no-lanes'), autoupdate: updater(HEALTHY) };
}

// updater(output, exit): a stand-in for `dotfiles-autoupdate status` that prints `output`.
const HEALTHY = 'info: sync: macOS 27.0.1 is available (a major upgrade, not planned)\nok: sync: last good run 2 h ago\n';
function updater(output, exit = 0) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-updater-')), 'status');
  fs.writeFileSync(file, `printf '%s' '${output.replaceAll("'", "'\\''")}'\nexit ${exit}\n`);
  return file;
}

test('groups open threads into needs-you, running and idle', () => {
  const s = snapshot({ ...fixture(), now: NOW });
  assert.deepEqual(s.needs.map((t) => t.id), ['B']);
  assert.deepEqual(s.running.map((t) => t.id), ['A', 'E', 'D']);
  assert.deepEqual(s.idle.map((t) => t.id), ['C']);
});

test('shows what each thread is doing and how full its context is', () => {
  const s = snapshot({ ...fixture(), now: NOW });
  const [a, e, d] = s.running;
  assert.equal(a.tool, 'Bash'); // newest main-thread tool call; the sidechain Grep is a subagent
  assert.equal(a.run, 'running'); // a later cancelled run does not hide the active one
  assert.equal(a.contextUsed, 210_000);
  assert.equal(a.contextMax, 1_000_000);
  assert.equal(a.quiet, false);
  assert.equal(e.parentTitle, 'UI owner');
  assert.equal(d.contextUsed, 161_005); // T3 had no context, so it comes from the log's last assistant turn
  assert.equal(d.tool, 'Edit');
  assert.equal(d.quiet, true); // running, no log write for 14 minutes
  const [b] = s.needs;
  assert.equal(b.ask, 'input card');
  assert.equal(b.askedAt, NOW - 6 * 60_000);
});

test('renders escaped titles, states and context bands', () => {
  const html = render(snapshot({ ...fixture(), now: NOW }));
  assert.match(html, /<title>\(1\) agent board<\/title>/);
  assert.match(html, /Needs you · 1/);
  assert.match(html, /Running · 3/);
  assert.match(html, /input card 6 min/);
  assert.match(html, /no activity 14 min/);
  assert.match(html, /Bash 30s<\/span> · 210k \/ 1M · Opus 5\.5 · job-tracker · ui-polish/);
  assert.match(html, /done 25 min ago/);
  assert.match(html, /class="warn" style="width:21\.0%"/);
  assert.match(html, /↳ UI owner/);
  assert.ok(html.includes('macOS update &lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('Settled thread') && !html.includes('Deleted thread') && !html.includes('Finished child'));
});

test('shows auto-update alarms above the threads and counts them as needing the owner', () => {
  const autoupdate = updater('alarm: sync: git fetch from origin failed: <stderr>\nalarm: switch: no successful run for 2 d\n'
    + 'info: sync: local main is 1 commits ahead of origin/main, waiting for push\nok: switch: last good run 2 d ago\n');
  const html = render(snapshot({ ...fixture(), now: NOW, autoupdate }));
  assert.match(html, /<title>\(2\) agent board<\/title>/);
  // The heading counts no lines: every other heading counts cards, and this section is one card.
  const heading = html.indexOf('<h2 class="attn">Auto-update</h2>');
  assert.ok(heading >= 0 && heading < html.indexOf('Needs you · 1'));
  assert.match(html, /<div class="t needs"><div class="name">dotfiles auto-update<\/div><div class="line red">sync: git fetch from origin failed: &lt;stderr&gt;<\/div>/);
  assert.match(html, /<div class="line ">sync: local main is 1 commits ahead/);
  assert.match(html, /<div class="line muted">switch: last good run 2 d ago<\/div>/);
});

test('a healthy updater is one quiet card below the threads', () => {
  const html = render(snapshot({ ...fixture(), now: NOW }));
  assert.ok(html.indexOf('<h2 class="">Auto-update</h2>') > html.indexOf('Idle · 1'));
  assert.match(html, /<div class="t"><div class="name">dotfiles auto-update<\/div><div class="line ">sync: macOS 27\.0\.1 is available/);
});

test('an auto-update status that cannot be read is an alarm', () => {
  assert.deepEqual(readUpdates(updater('', 3)), { alarms: ['could not read the auto-update status: exit 3'], infos: [], oks: [] });
  assert.match(readUpdates('/nonexistent/status').alarms[0], /^could not read the auto-update status: .*No such file/);
});

test('accepts only loopback, the tailnet IP and this Mac\'s MagicDNS names on its port', () => {
  const opts = { port: 4790, short: 'myhost', tailnetIp: '100.99.1.2' };
  for (const host of ['127.0.0.1:4790', 'localhost:4790', '100.99.1.2:4790', 'myhost:4790', 'myhost.tail0000.ts.net:4790']) {
    assert.equal(hostAllowed(host, opts), true, host);
  }
  for (const host of ['evil.example:4790', 'myhost.tail0000.ts.net:4387', 'other.tail0000.ts.net:4790',
    'myhost.evil.example.ts.net:4790', 'myhost.ts.net.evil.example:4790', '100.99.1.3:4790', undefined, '']) {
    assert.equal(hostAllowed(host, opts), false, String(host));
  }
});

test('finds the Tailscale address and never a LAN or loopback one', () => {
  const iface = (address, internal = false) => ({ family: 'IPv4', address, internal });
  assert.equal(tailnetAddress({ lo0: [iface('127.0.0.1', true)], en0: [iface('192.168.1.5')], utun4: [iface('100.99.1.2')] }), '100.99.1.2');
  assert.equal(tailnetAddress({ en0: [iface('100.20.1.1')], lo0: [iface('127.0.0.1', true)] }), null);
});

// launchd starts the board once, from the live checkout. A merge or the daily sync's fast-forward changes the file
// under it, and the plist stays the same, so nothing restarts it: it must exit itself for KeepAlive to restart it.
test('exits when its own source changes, so launchd restarts it on the new code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-self-'));
  const copy = path.join(dir, 'agent-board.mjs');
  fs.copyFileSync(BOARD, copy);
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  probe.close();
  const board = spawn(process.execPath, ['--no-warnings', copy], {
    env: { ...process.env, AGENT_BOARD_PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    let out = '';
    board.stdout.on('data', (chunk) => { out += chunk; });
    const exited = once(board, 'exit');
    while (!out.includes(`listening on 127.0.0.1:${port}`)) await new Promise((resolve) => setTimeout(resolve, 50));
    fs.appendFileSync(copy, '// changed\n');
    const timeout = new Promise((resolve) => setTimeout(resolve, 10_000, 'still running'));
    assert.deepEqual(await Promise.race([exited, timeout]), [0, null]);
    assert.match(out, /source changed, restarting/);
  } finally {
    board.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- /map: a fixture lanes directory with one case per row of the design's failure table ----

const TSV = (rows) => rows.map((r) => r.join('\t')).join('\n') + '\n';
const UNIT_COLUMNS = ['unit', 'state', 'owner', 'branch', 'pr', 'milestone', 'after', 'since', 'note'];

function lanesFixture() {
  const f = fixture();
  const db = new DatabaseSync(f.dbPath);
  const thread = (id, title, minutesAgo) => db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?)')
    .run(id, 'p1', title, iso(minutesAgo), '{}');
  thread('mcp:run', 'Coordinator 13', 1);
  db.prepare('INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?)').run('mcp:run', 1, 'running');
  thread('mcp:ask', 'Design worker', 5);
  db.prepare('INSERT INTO orchestration_v2_projection_runtime_requests VALUES (?, ?, ?, ?, NULL)').run('mcp:ask', 'user_input', 'pending', iso(20));
  thread('mcp:idle', 'Practice thread', 30);
  db.close();

  const dir = path.join(path.dirname(f.dbPath), 'lanes');
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
    const at = new Date(NOW - 10 * 60_000);
    fs.utimesSync(path.join(dir, file), at, at);
  };
  write('alpha/lane.json', JSON.stringify({ priority: 1, repo: 'o/alpha', github: true, coordinator_thread: 'mcp:run',
    milestones: [{ id: 'M1', title: 'Apply' }] }));
  write('alpha/units.tsv', TSV([
    UNIT_COLUMNS,
    ['#ui', 'in-flight', 'mcp:run', 'feat/ui', '20', 'M1', '', '11:10', ''], // line 2
    ['pickers', 'in-flight', 'worker (opus high)', '', '', 'M1', 'ui', '', ''],
    ['ship', 'needs-myuser', '', '', 'rebuild', 'M1', 'ui', '', 'run rebuild at the Mac'],
    ['review-me', 'review', 'mcp:gone', '', '71', 'M0', 'ship', '2026-10-11T02:00:00+08:00', ''],
    ['ci', 'needs-myuser', '', '', 'push', 'M0', '', '10:45', 'push the runner fix'],
    ['sign', 'needs-myuser', 'mcp:ask', '', '', 'M0', 'old', '', 'review the design page'],
    ['old', 'done', '', '', '51', 'M0', '', '', ''],
    ['landed-row', 'landed', '', '', '', '', '', '', ''], // line 9
    ['ui', 'queued', '', '', '', '', '', '', ''], // line 10
    ['short', 'queued'], // line 11
    ['ghost', 'queued', '', '', '', 'M2', 'nope,beta/x', 'soon', ''], // line 12
    ['loop-a', 'blocked', '', '', '', 'M2', 'loop-b', '', ''],
    ['loop-b', 'blocked', '', '', '', 'M2', 'loop-a', '', ''],
  ]));
  write('alpha/ledger.tsv', TSV([
    ['ts', 'unit', 'pr', 'head_sha', 'verdict', 'verifier', 'evidence'],
    ['1', 'ui', '20', 'aaa', 'approve r1', 'opus', ''],
    ['2', 'ui', '20', 'bbb', 'approve r2', 'fable', ''],
    ['3', 'old', '51', 'ccc', 'merged', 'coordinator', ''],
    ['4', 'x', 'x', 'ddd', 'approve', 'opus', ''], // line 5
  ]));
  write('beta/units.tsv', TSV([['unit', 'state'], ['x', 'queued']])); // no lane.json
  write('gamma/lane.json', JSON.stringify({ priority: 2, coordinator_thread: 'mcp:closed' }));
  write('delta/lane.json', '{ "priority": 4,');
  write('delta/units.tsv', TSV([['unit', 'owner', 'status', 'branch', 'notes'], ['#20', 'worker', 'landed', 'main', '']]));
  write('epsilon/lane.json', JSON.stringify({ priority: 3, orchestrator_thread: 'mcp:idle' }));
  write('epsilon/state/units.tsv', TSV([['unit', 'owner', 'status', 'branch', 'notes']]));
  // NOW is 11:30 SGT. Lane files last changed 3 h ago, so the running coordinator's lane is stale.
  const old = new Date(NOW - 3 * 3600_000);
  for (const file of ['alpha/lane.json', 'alpha/units.tsv', 'alpha/ledger.tsv']) fs.utimesSync(path.join(dir, file), old, old);
  return { ...f, lanesDir: dir, autoupdate: null };
}

const mapHtml = () => renderMap(snapshot({ ...lanesFixture(), now: NOW }));
// The rendered row for one unit, from its opening div to the next row.
const unitRowOf = (html, id) => html.slice(html.lastIndexOf('<div class="u', html.indexOf(`</span>${id}</span>`)), html.indexOf(`</span>${id}</span>`) + 600);

test('map: lanes in priority order, a lane without a readable lane.json last', () => {
  const html = mapHtml();
  const order = ['alpha', 'gamma', 'epsilon', 'beta', 'delta'].map((name) => html.indexOf(`<div class="lane"><b>${name}</b>`));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `lane order ${order}`);
  assert.match(html, /<div class="note">lane\.json: missing<\/div>/);
  assert.match(html, /<div class="note">lane\.json: [^<]*JSON[^<]*<\/div>/);
  assert.match(html, /<title>\(3\) project map<\/title>/);
  assert.match(html, /<h1><span>agent board ·<\/span> <a href="\/">threads<\/a> · <u>map<\/u><\/h1>/);
});

test('map: missing, legacy and malformed units files say so and render no rows', () => {
  const html = mapHtml();
  assert.match(html, /<b>gamma<\/b><small>priority 2 · <span class="peach">no coordinator thread<\/span> · updated 10 min ago<\/small><\/div><div class="note">no units file<\/div>/);
  assert.match(html, /<div class="note">legacy layout: state\/units\.tsv converts in phase 2<\/div>/);
  assert.match(html, /<div class="note">units\.tsv: no state column<\/div>/);
  assert.doesNotMatch(html, /<\/span>#?20<\/span>/);
});

test('map: skipped rows, bad dependencies and bad ledger rows are counted in the footer with line and reason', () => {
  const html = mapHtml();
  const footer = html.slice(html.indexOf('<footer>'));
  assert.match(footer, /^<footer>Read-only view of .* lanes and T3 state\. alpha: <b>3 rows skipped, 3 dependencies unresolved, 1 since unreadable, 1 ledger row skipped<\/b> /);
  assert.match(footer, /\(unknown state &quot;landed&quot;, line 9; duplicate unit &quot;ui&quot;, line 10; 2 fields, header has 9, line 11; 5 more\)/);
  for (const id of ['landed-row', 'short']) assert.doesNotMatch(html, new RegExp(`</span>${id}</span>`));
});

test('map: milestones in file order with done counts and a bar in state order', () => {
  const html = mapHtml();
  const m1 = html.indexOf('<b>M1 Apply</b><span>0 of 3 done</span>');
  const m0 = html.indexOf('<b>M0</b><span>1 of 4 done</span>');
  const m2 = html.indexOf('<b>M2</b><span>0 of 3 done</span>');
  assert.ok(m1 > 0 && m0 > m1 && m2 > m0, `milestones at ${m1}, ${m0}, ${m2}`);
  assert.match(html.slice(m0), /^[^]*?<div class="bar"><i style="width:25\.0%;background:var\(--green\)"><\/i><i style="width:25\.0%;background:var\(--sapphire\)"><\/i><i style="width:50\.0%;background:var\(--peach\)"><\/i><\/div>/);
});

test('map: unit rows show state, PR verdict, owner and its live state, and nest under the unit they wait for', () => {
  const html = mapHtml();
  const ui = unitRowOf(html, 'ui');
  assert.match(ui, /<span class="state green">in-flight<\/span>ui<\/span><span class="pr"><a href="https:\/\/github\.com\/o\/alpha\/pull\/20" title="approve r2" rel="noreferrer"><b>#20<\/b> approve r2<\/a>/);
  assert.match(ui, /<div class="sub">Coordinator 13 · <span class="green">[^<]+<\/span> · feat\/ui · since 11:10<\/div><\/div><div class="kids">/);
  assert.match(unitRowOf(html, 'pickers'), /<div class="sub">worker \(opus high\)<\/div>/);
  assert.match(unitRowOf(html, 'ship'), /<span class="state peach">then you<\/span>ship<\/span><span class="pr">rebuild<\/span><\/div><div class="sub">run rebuild at the Mac<\/div><\/div>/);
  const review = unitRowOf(html, 'review-me');
  assert.match(review, /<b>#71<\/b> no verdict/);
  assert.match(review, /<span class="peach">no owner thread<\/span> · <span class="yellow">stalled since 02:00<\/span>/);
  assert.match(review, /<div class="after">after <b>ship<\/b> \(then you\)<\/div>/);
  assert.match(unitRowOf(html, 'old'), /^<div class="u done"><div class="row"><span class="id"><span class="state grey">done<\/span>old<\/span><span class="pr"><a [^>]+><b>#51<\/b> merged<\/a><\/span><\/div><\/div>/);
  assert.match(unitRowOf(html, 'sign'), /^<div class="kids"><div class="u needs">|^<div class="u needs">/);
});

test('map: a missing or cyclic dependency is drawn in yellow and the units still render', () => {
  const html = mapHtml();
  assert.match(unitRowOf(html, 'ghost'), /<div class="after">after <span class="yellow">\? nope<\/span>, <b>beta\/x<\/b><\/div>/);
  assert.match(unitRowOf(html, 'loop-a'), /<div class="after">after <span class="yellow">loop-b \(cycle\)<\/span><\/div>/);
  assert.match(unitRowOf(html, 'loop-b'), /<span class="state red">blocked<\/span>loop-b/);
});

test('map: Needs you merges input cards with units that are the owner\'s turn, oldest first, each once', () => {
  const html = mapHtml();
  const needs = html.slice(html.indexOf('Needs you · 3'), html.indexOf('<div class="cols">'));
  const order = ['>ci</span>', '>sign</span>', '>macOS update &lt;script&gt;'].map((s) => needs.indexOf(s));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `needs order ${order}`);
  assert.match(needs, /<span class="pr">alpha<\/span><\/div><div class="sub">push the runner fix · since 10:45<\/div>/);
  assert.match(needs, /<div class="sub">review the design page · Design worker · input card · asked 11:10<\/div>/);
  assert.doesNotMatch(needs, />Design worker</);
  assert.doesNotMatch(needs, />ship</);
});

test('map: the lane header shows its coordinator live and goes stale after two quiet hours', () => {
  const html = mapHtml();
  assert.match(html, /<b>alpha<\/b><small>priority 1 · Coordinator 13 <span class="green">running<\/span> · <span class="yellow">stale, updated 3 h ago<\/span><\/small>/);
  assert.match(html, /<b>epsilon<\/b><small>priority 3 · Practice thread <span class="grey">idle 30 min<\/span> · updated 10 min ago<\/small>/);
});

test('the thread page links the map and lists lane units that wait on the owner', () => {
  const html = render(snapshot({ ...lanesFixture(), now: NOW, autoupdate: updater(HEALTHY) }));
  assert.match(html, /<h1><span>agent board ·<\/span> <u>threads<\/u> · <a href="\/map">map<\/a><\/h1>/);
  assert.match(html, /<title>\(3\) agent board<\/title>/);
  assert.match(html, /<div class="t needs"><div class="name">ci<\/div><div class="sub"><span class="state peach">you<\/span> · alpha · push the runner fix · since 10:45<\/div><\/div>/);
});

test('map: no lanes directory is one line, and the thread page is unchanged', () => {
  const s = snapshot({ ...fixture(), now: NOW, autoupdate: null });
  assert.match(renderMap(s), /<p class="more">No lanes at [^<]*no-lanes<\/p>/);
  assert.match(render({ ...s, updates: { alarms: [], infos: [], oks: [] } }), /Needs you · 1/);
});

test('since reads HH:MM as today in SGT, or yesterday when that is still ahead', () => {
  assert.equal(parseSince('11:10', NOW), NOW - 20 * 60_000);
  assert.equal(parseSince('23:50', NOW), NOW - (11 * 60 + 40) * 60_000);
  assert.equal(parseSince('2026-10-11T02:00:00+08:00', NOW), NOW - 9.5 * 3600_000);
  assert.equal(parseSince('25:00', NOW), undefined);
  assert.equal(parseSince('', NOW), null);
});

test('serves /map, and both pages show the T3 error page when its database is unreadable', async () => {
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  probe.close();
  const { lanesDir } = lanesFixture();
  const serve = (db) => spawn(process.execPath, ['--no-warnings', fileURLToPath(BOARD)], {
    env: { ...process.env, AGENT_BOARD_PORT: String(port), AGENT_BOARD_T3_DB: db, AGENT_BOARD_LANES: lanesDir }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const board = serve(path.join(lanesDir, 'missing.sqlite'));
  try {
    let out = '';
    board.stdout.on('data', (chunk) => { out += chunk; });
    while (!out.includes(`listening on 127.0.0.1:${port}`)) await new Promise((resolve) => setTimeout(resolve, 50));
    for (const route of ['/', '/map', '/map?x=1']) {
      const res = await fetch(`http://127.0.0.1:${port}${route}`);
      assert.equal(res.status, 500, route);
      assert.match(await res.text(), /Could not read T3 state/);
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/mapx`)).status, 404);
  } finally {
    board.kill();
  }
});

test('map: an owner given as a bare uuid resolves to its thread; an unknown one has no owner thread', () => {
  const f = lanesFixture();
  const id = '0b6f1a2e-1111-4222-8333-444455556666';
  const db = new DatabaseSync(f.dbPath);
  db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?)').run(id, 'p1', 'Uuid owner', iso(2), '{}');
  db.close();
  fs.mkdirSync(path.join(f.lanesDir, 'zeta'));
  fs.writeFileSync(path.join(f.lanesDir, 'zeta/units.tsv'), TSV([['unit', 'state', 'owner'], ['u1', 'paused', id], ['u2', 'paused', id.replace('1111', '0000')]]));
  const html = renderMap(snapshot({ ...f, now: NOW }));
  assert.match(unitRowOf(html, 'u1'), /<div class="sub">Uuid owner · <span class="grey">idle 2 min<\/span><\/div>/);
  assert.match(unitRowOf(html, 'u2'), /<div class="sub"><span class="peach">no owner thread<\/span><\/div>/);
});
