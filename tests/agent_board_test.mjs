// Run: node --test tests/agent_board_test.mjs
// Builds a fixture copy of the T3 tables the board reads, plus Claude logs, and checks what the board shows.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { UNIT_STATES, cachedPrs, fetchPrs, hostAllowed, parsePrs, parseReviewScope, parseSince, parseUnits, prQuery, prView, readUpdates, refreshPrs, render, renderMap, snapshot, summaryOf, tailnetAddress } from '../files/bin/agent-board.mjs';

const BOARD = new URL('../files/bin/agent-board.mjs', import.meta.url);
process.env.AGENT_BOARD_OWNER = 'the owner'; // the blockers below name the owner by given name, whatever this machine's username is

const NOW = Date.parse('2026-10-11T03:30:00Z');
const iso = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();

// No test reaches GitHub: the board gets PR state from this stub unless a test injects its own.
const noPrs = () => ({ prs: new Map(), error: null, at: null });

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
  return { dbPath, logsDir, lanesDir: path.join(dir, 'no-lanes'), autoupdate: updater(HEALTHY), prs: noPrs };
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
    ['review-me', 'in-flight', 'mcp:gone', '', '71', 'M0', 'ship', '2026-10-11T02:00:00+08:00', ''],
    ['ci', 'needs-myuser', '', '', 'push', 'M0', '', '10:45', 'push the runner fix'],
    ['sign', 'needs-myuser', 'mcp:ask', '', '', 'M0', 'old', '', 'review the design page'],
    ['old', 'done', '', '', '51', 'M0', '', '', ''],
    ['landed-row', 'landed', '', '', '', '', '', '', ''], // line 9
    ['ui', 'queued', '', '', '', '', '', '', ''], // line 10
    ['short', 'queued'], // line 11
    ['ghost', 'queued', '', '', '', 'M2', 'nope,beta/x', 'soon', ''], // line 12
    ['loop-a', 'queued', '', '', '', 'M2', 'loop-b', '', ''],
    ['loop-b', 'queued', '', '', '', 'M2', 'loop-a', '', ''],
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

test('map: the states the board accepts are the lane rule\'s, as the lane template documents them', () => {
  const readme = fs.readFileSync(new URL('../templates/orchestrator-lane/README.md', import.meta.url), 'utf8');
  const row = readme.split('\n').find((l) => l.startsWith('| `state` |'));
  assert.ok(row, 'the template documents the state column');
  const documented = [...row.slice(0, row.indexOf('(')).matchAll(/`([a-z-]+)`/g)].map((m) => m[1]).filter((w) => w !== 'state');
  assert.deepEqual(documented, UNIT_STATES);
  assert.deepEqual(UNIT_STATES, ['queued', 'in-flight', 'needs-myuser', 'paused', 'done'], 'standing order 7');
  assert.deepEqual(parseUnits(TSV([['unit', 'state'], ['a', 'review'], ['b', 'blocked'], ['c', 'in-flight']])).skipped.map((r) => r.why),
    ['unknown state "review"', 'unknown state "blocked"']);
});

test('map: missing, legacy and malformed units files say so and render no rows', () => {
  const html = mapHtml();
  assert.match(html, /<b>gamma<\/b><small>priority 2 · <span class="peach">no coordinator thread<\/span> · <span class="kept">updated 10 min ago<\/span><\/small><\/div><div class="note">no units file<\/div>/);
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
  // The same rows are warnings beside the lane, where their unit would be, so a lane never loses rows silently.
  const alpha = html.slice(html.indexOf('<b>alpha</b>'), html.indexOf('<div class="ms">'));
  assert.match(alpha, /<div class="u warn"><div class="row"><span class="id"><span class="state yellow">unreadable<\/span>units.tsv line 9<\/span><span class="pr">landed-row<\/span><\/div><div class="sub yellow">unknown state &quot;landed&quot;; states are queued, in-flight, needs-myuser, paused, done<\/div><\/div>/);
  assert.match(alpha, /unreadable<\/span>units.tsv line 11<\/span><\/div><div class="sub yellow">2 fields, header has 9<\/div>/);
  assert.equal((alpha.match(/class="u warn"/g) ?? []).length, 3);
});

test('map: milestones in file order with done counts, a bar filled by done only and a key in its title', () => {
  const html = mapHtml();
  const m1 = html.indexOf('<b>M1 Apply</b><span>0 of 3 done</span>');
  const m0 = html.indexOf('<b>M0</b><span>1 of 4 done</span>');
  const m2 = html.indexOf('<b>M2</b><span>0 of 3 done</span>');
  assert.ok(m1 > 0 && m0 > m1 && m2 > m0, `milestones at ${m1}, ${m0}, ${m2}`);
  assert.match(html.slice(m0), /^[^]*?<div class="bar" title="1 in-flight, 2 needs-myuser, 1 done"><i style="width:25\.0%"><\/i><\/div>/);
  assert.match(html.slice(m1), /^[^]*?<div class="bar" title="2 in-flight, 1 needs-myuser"><\/div>/, 'nothing done, nothing filled');
});

test('map: unit rows show state, PR verdict, owner and its live state, and nest under the unit they wait for', () => {
  const html = mapHtml();
  const ui = unitRowOf(html, 'ui');
  assert.match(ui, /<span class="state green">in-flight<\/span>ui<\/span><span class="pr"><a href="https:\/\/github\.com\/o\/alpha\/pull\/20" rel="noreferrer"><b>#20<\/b> approve r2<\/a>/);
  assert.match(ui, /<div class="sub">Coordinator 13 · <span class="green">[^<]+<\/span> · feat\/ui · since 11:10<\/div><\/div><div class="kids">/);
  assert.match(unitRowOf(html, 'pickers'), /<div class="sub">worker \(opus high\)<\/div>/);
  assert.match(unitRowOf(html, 'ship'), /<span class="state peach">then you<\/span>ship<\/span><span class="pr">rebuild<\/span><\/div><div class="unit-note">run rebuild at the Mac<\/div><\/div>/);
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
  assert.match(unitRowOf(html, 'loop-b'), /<span class="state grey">queued<\/span>loop-b/);
});

test('map: Needs you merges input cards with units that are the owner\'s turn, oldest first, each once, as one line each', () => {
  const html = mapHtml();
  const needs = html.slice(html.indexOf('Needs you · 3'), html.indexOf('<div class="cols">'));
  const order = ['>ci</b>', '>sign</b>', '>macOS update &lt;script&gt;'].map((s) => needs.indexOf(s));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `needs order ${order}`);
  // The list is the to-do: the ask, the wait and where to act; the unit's detail stays in its lane, so a phone page
  // does not carry every row twice.
  assert.match(needs, /<div class="u needs todo"><span class="state peach">you<\/span><b class="id">ci<\/b><span class="ask">push the runner fix · since 10:45<\/span><span class="tag">alpha<\/span><\/div>/);
  assert.match(needs, /<b class="id">sign<\/b><span class="ask">review the design page · Design worker · input card · asked 11:10<\/span><span class="tag">alpha<\/span>/);
  assert.match(needs, /<b class="id">macOS update &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/b><span class="ask">input card · asked 11:24 · macos<\/span><span class="tag">dotfiles<\/span>/);
  assert.doesNotMatch(needs, /pr-block|unit-note|<div class="sub">/);
  assert.doesNotMatch(needs, />Design worker</);
  assert.doesNotMatch(needs, />ship</);
  const lane = html.slice(html.indexOf('<div class="cols">'));
  assert.match(unitRowOf(lane, 'ci'), /<div class="u needs"><div class="row"><span class="id"><span class="state peach">you<\/span>ci<\/span><span class="pr">push<\/span><\/div><div class="sub">since 10:45<\/div><div class="unit-note">push the runner fix<\/div>/);
});

test('map: the lane header shows its coordinator live and goes stale after two quiet hours', () => {
  const html = mapHtml();
  assert.match(html, /<b>alpha<\/b><small>priority 1 · Coordinator 13 <span class="kept"><span class="green">running<\/span><\/span> · <span class="yellow kept">stale, updated 3 h ago<\/span><\/small>/);
  assert.match(html, /<b>epsilon<\/b><small>priority 3 · Practice thread <span class="kept"><span class="grey">idle 30 min<\/span><\/span> · <span class="kept">updated 10 min ago<\/span><\/small>/);
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

// ---- Stale needs-myuser rows: a real repo with origin/main and one branch per case ----

function repoFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-repo-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { env, encoding: 'utf8' }).trim();
  const commit = (file, subject) => {
    fs.writeFileSync(path.join(dir, file), `${subject}\n`);
    git('add', file);
    git('commit', '-qm', subject);
  };
  git('init', '-qb', 'main');
  commit('a', 'init');
  // Rebased: the branch still holds its pre-rebase commit; main has the same patch under another id.
  git('checkout', '-qb', 'feat/rebased');
  commit('r', 'feat: rebased work');
  git('checkout', '-q', 'main');
  commit('m', 'chore: main moves on');
  git('cherry-pick', 'feat/rebased');
  // Squash-merged PR: two commits land as one, GitHub style, so no single patch matches.
  git('checkout', '-qb', 'feat/squash');
  commit('s1', 'wip one');
  commit('s2', 'wip two');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--squash', 'feat/squash');
  git('commit', '-qm', 'feat: squash work (#12)');
  // Merged by fast-forward.
  git('checkout', '-qb', 'feat/merged');
  commit('f', 'feat: merged work');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--ff-only', 'feat/merged');
  // Created from main with no commits yet: an ancestor of main that holds no work.
  git('branch', 'feat/empty');
  git('update-ref', 'refs/remotes/origin/main', 'main');
  // Pushed to origin at its creation point and never fetched into a local branch: no reflog shows whether it held work.
  git('update-ref', 'refs/remotes/origin/feat/remote-empty', 'main');
  // Unpushed: merged into the local main only, so the owner still has to say push.
  git('checkout', '-qb', 'feat/unpushed');
  commit('u', 'feat: unpushed work');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--ff-only', 'feat/unpushed');
  return { dir, git, commit };
}

function staleFixture() {
  const f = lanesFixture();
  const repo = repoFixture();
  fs.mkdirSync(path.join(f.lanesDir, 'repo'));
  fs.writeFileSync(path.join(f.lanesDir, 'repo/lane.json'), JSON.stringify({ priority: 5, checkout: repo.dir, base: 'main' }));
  fs.writeFileSync(path.join(f.lanesDir, 'repo/units.tsv'), TSV([
    UNIT_COLUMNS,
    ['rebased', 'needs-myuser', '', 'feat/rebased', 'push', '', '', '', 'say push'],
    ['squash', 'needs-myuser', '', 'feat/squash', '12', '', '', '', 'review the PR'],
    ['squash-gone', 'needs-myuser', '', 'feat/deleted-after-merge', '12', '', '', '', 'review the PR'],
    ['merged', 'needs-myuser', '', 'feat/merged', '', '', '', '', 'say push'],
    ['await-rebuild', 'needs-myuser', '', 'feat/merged', 'rebuild', '', '', '', 'run rebuild'],
    ['still-building', 'in-flight', '', 'feat/merged', '', '', '', '', ''],
    ['unpushed', 'needs-myuser', '', 'feat/unpushed', '13', '', '', '', 'say push'],
    ['empty', 'needs-myuser', '', 'feat/empty', '', '', '', '', 'pick a design'],
    ['no-branch', 'needs-myuser', '', '', 'push', '', '', '', 'say push'],
    ['typo', 'needs-myuser', '', 'feat/nope', '', '', '', '', 'say push'],
    ['merged-docs', 'needs-myuser', '', 'feat/merged', 'docs', '', '', '', 'read the page'],
    ['remote-empty', 'needs-myuser', '', 'feat/remote-empty', '', '', '', '', 'say push'],
  ]));
  return { ...f, repo };
}

// unitRowOf, cut before the next row, so a check that a row has no flag cannot read its neighbour's.
const ownRowOf = (html, id) => {
  const row = unitRowOf(html, id);
  const next = row.indexOf('<div class="u', 1);
  return next > 0 ? row.slice(0, next) : row;
};
const staleOf = (snap) => Object.fromEntries(snap.lanes.lanes.find((l) => l.name === 'repo').units.map((u) => [u.id, u.stale?.text ?? null]));

test('map: a needs-myuser row whose branch already landed on origin/main is flagged with why; its state is kept', () => {
  const error = mock.method(console, 'error', () => {});
  try {
    const f = staleFixture();
    const snap = snapshot({ ...f, now: NOW });
    assert.deepEqual(staleOf(snap), {
      rebased: 'branch already on main', squash: 'PR #12 merged', 'squash-gone': 'PR #12 merged', merged: 'branch already on main',
      'await-rebuild': null, 'still-building': null, unpushed: null, empty: null, 'no-branch': null, typo: null,
      'merged-docs': null, 'remote-empty': null,
    });
    const html = renderMap(snap);
    const lanes = html.slice(html.indexOf('<div class="cols">'));
    const rebased = unitRowOf(lanes, 'rebased');
    // A stale row is the lane owner's cleanup, not the owner's turn: it reads stale, not you, and leaves Needs you.
    assert.match(rebased, /^<div class="u"><div class="row"><span class="id"><span class="state yellow">stale<\/span>rebased<\/span>/);
    assert.match(rebased, /<div class="sub">feat\/rebased<\/div><div class="unit-note">say push<\/div><div class="stale" title="every commit on feat\/rebased is on origin\/main under another id, as after a rebase">looks stale: branch already on main · lane owner&#39;s cleanup<\/div>/);
    assert.match(unitRowOf(lanes, 'merged'), /<div class="stale" title="feat\/merged is merged into origin\/main">looks stale: branch already on main · lane owner&#39;s cleanup<\/div>/);
    assert.match(unitRowOf(lanes, 'squash'), /<div class="stale" title="origin\/main has the squash or merge commit of #12">looks stale: PR #12 merged · lane owner&#39;s cleanup<\/div>/);
    for (const id of ['unpushed', 'empty', 'no-branch', 'typo', 'await-rebuild', 'merged-docs', 'remote-empty']) assert.doesNotMatch(ownRowOf(lanes, id), /class="stale"/, id);
    assert.match(unitRowOf(lanes, 'unpushed'), /<span class="state peach">you<\/span>unpushed<\/span>/, 'a row whose work is not on main is still his turn');
    const needs = html.slice(html.indexOf('Needs you'), html.indexOf('<div class="cols">'));
    for (const id of ['rebased', 'squash', 'squash-gone', 'merged']) assert.doesNotMatch(needs, new RegExp(`>${id}<`), `${id} asks for nothing`);
    assert.match(needs, />unpushed</);
    const threads = render(snapshot({ ...f, now: NOW, autoupdate: updater(HEALTHY) }));
    assert.doesNotMatch(threads, /<div class="name">squash<\/div>/);
    assert.match(threads, /<div class="name">unpushed<\/div>/);
    // A branch git cannot find, or one only on origin whose tip is on main, is not flagged; the reason is logged once,
    // not on every refresh.
    const logged = error.mock.calls.map((c) => c.arguments[0]);
    assert.deepEqual(logged, [
      `agent-board: cannot check repo/typo for a stale row: ${f.repo.dir} has no branch feat/nope`,
      'agent-board: cannot check repo/remote-empty for a stale row: feat/remote-empty is only on origin and its tip is on origin/main, which an empty branch also is',
    ]);
  } finally {
    error.mock.restore();
  }
});

test('map: the stale flag follows new commits on the branch and pushes to origin/main', () => {
  const error = mock.method(console, 'error', () => {});
  try {
    const f = staleFixture();
    assert.equal(staleOf(snapshot({ ...f, now: NOW })).rebased, 'branch already on main');
    f.repo.git('checkout', '-q', 'feat/rebased');
    f.repo.commit('r2', 'feat: more work after the rebase');
    f.repo.git('update-ref', 'refs/remotes/origin/main', 'main');
    const after = staleOf(snapshot({ ...f, now: NOW }));
    assert.equal(after.rebased, null, 'new work on the branch is not on main');
    assert.equal(after.unpushed, 'branch already on main', 'pushed to origin/main');
  } finally {
    error.mock.restore();
  }
});

test('map: a lane without a usable checkout flags nothing and logs why', () => {
  const error = mock.method(console, 'error', () => {});
  try {
    const f = staleFixture();
    fs.writeFileSync(path.join(f.lanesDir, 'repo/lane.json'), JSON.stringify({ priority: 5 }));
    const snap = snapshot({ ...f, now: NOW });
    assert.ok(Object.values(staleOf(snap)).every((v) => v === null));
    assert.ok(error.mock.calls.some((c) => c.arguments[0] === 'agent-board: cannot check repo/rebased for a stale row: lane.json has no checkout'));
    fs.writeFileSync(path.join(f.lanesDir, 'repo/lane.json'), JSON.stringify({ priority: 5, checkout: path.join(f.repo.dir, 'missing') }));
    assert.ok(Object.values(staleOf(snapshot({ ...f, now: NOW }))).every((v) => v === null));
    assert.ok(error.mock.calls.some((c) => /^agent-board: cannot check repo\/rebased for a stale row: git cannot read /.test(c.arguments[0])));
  } finally {
    error.mock.restore();
  }
});

// ---- /map: PR state from GitHub, the ledger under state/, warnings beside the lane, stale lanes ----

// What gh's GraphQL answer holds for one PR, as prQuery asks for it.
function prNode(number, overrides = {}, { checks = [], preview = null } = {}) {
  return {
    number, title: `PR ${number}`, url: `https://github.com/o/jobs/pull/${number}`, isDraft: false, state: 'OPEN', mergedAt: null,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '', headRefOid: 'abc1234abc1234abc1234abc1234abc1234abc12345',
    headRefName: `feat/${number}`, baseRefName: 'main', updatedAt: iso(15), body: '## Context\n\nThe private workspace needs a usable list of roles.\n\n## Solution\n\nLeads.',
    commits: { nodes: [{ commit: {
      statusCheckRollup: checks.length ? { state: 'PENDING', contexts: { nodes: checks } } : null,
      deployments: { nodes: preview ? [{ environment: 'Preview', latestStatus: { state: 'SUCCESS', environmentUrl: preview } }] : [] },
    } }] },
    ...overrides,
  };
}
const run = (name, conclusion, status = 'COMPLETED') => ({ __typename: 'CheckRun', name, status, conclusion, detailsUrl: `https://ci/${name}` });
const context = (name, state) => ({ __typename: 'StatusContext', context: name, state, targetUrl: `https://ctx/${name}` });

test('prView: draft, open, ready, blocked with why, merged; checks newest per name; the preview on the head', () => {
  const blocked = prView(prNode(1, { mergeStateStatus: 'BLOCKED' }, {
    checks: [run('build', 'SUCCESS'), run('lint', 'CANCELLED'), run('lint', 'FAILURE'), run('e2e', null, 'IN_PROGRESS'), context('Vercel', 'SUCCESS')],
    preview: 'https://jobs-git-feat-1.example.app',
  }));
  assert.equal(blocked.state, 'blocked');
  assert.deepEqual(blocked.blockers, ['1 check failing: lint']);
  assert.deepEqual(blocked.checks.map((c) => `${c.name}:${c.result}`), ['build:pass', 'lint:fail', 'e2e:pending', 'Vercel:pass']);
  assert.equal(blocked.checksPending, 1);
  assert.deepEqual(blocked.preview, { url: 'https://jobs-git-feat-1.example.app', state: 'success', environment: 'Preview' });
  assert.equal(blocked.head, 'abc1234');
  assert.equal(blocked.summary, 'Leads.', 'the Solution section, not the Context');
  assert.equal(prView(prNode(2, { isDraft: true, mergeStateStatus: 'BEHIND' })).state, 'draft');
  const draft = prView(prNode(10, { isDraft: true, mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }, { checks: [run('lint', 'FAILURE')] }));
  assert.equal(draft.state, 'draft');
  assert.deepEqual(draft.blockers, ['1 check failing: lint'], 'a draft is not up for review: its failing checks and conflicts are the author\'s to fix');
  assert.equal(prView(prNode(3)).state, 'ready');
  const running = prView(prNode(4, { mergeStateStatus: 'BLOCKED' }, { checks: [run('e2e', null, 'QUEUED')] }));
  assert.equal(running.state, 'open', 'a required check still running is not a blocker');
  assert.deepEqual(prView(prNode(5, { mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'DIRTY' })).blockers,
    ['conflicts with main', 'changes requested']);
  assert.deepEqual(prView(prNode(6, { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' })).blockers, ['review required']);
  assert.deepEqual(prView(prNode(7, { mergeStateStatus: 'BLOCKED' })).blockers, ['a required check or review is missing']);
  const merged = prView(prNode(8, { state: 'MERGED', mergedAt: iso(60), mergeStateStatus: 'UNKNOWN' }));
  assert.equal(merged.state, 'merged');
  assert.equal(merged.mergedAt, NOW - 3600_000);
  assert.equal(prView(prNode(9, { body: '', commits: { nodes: [] } })).summary, null);
  assert.equal(summaryOf('## Heading\n- bullet\nA short one.\nThis line is the first long enough to be a sentence. And then more.'),
    'This line is the first long enough to be a sentence.', 'without a Solution section, the first prose sentence');
  assert.equal(summaryOf('Closes #12\nStacked on #11, merge that first.\nPart of the map redesign.\n\nShows each check as it finishes, so the map reads like the PR page.'),
    'Shows each check as it finishes, so the map reads like the PR page.', 'issue and stacking lines are boilerplate');
  assert.equal(summaryOf('## Context and problem\n\nThe rows clip.\n\n## Solution\n\nWrap every line, keep the PR title as the headline and read the summary from here. Then more.\n\n## Reproduce and test\n\nRun it.'),
    'Wrap every line, keep the PR title as the headline and read the summary from here.');
  assert.equal(summaryOf(`## Solution\n\n${'word '.repeat(50).trim()}.`), `${'word '.repeat(50).trim()}.`, 'a long sentence is shown whole, never cut with an ellipsis');
  assert.equal(summaryOf('## Solution\n\n'), null);
  // gh's bodyText is the markdown rendered to text ("## Solution" arrives as "Solution"), so the query asks for the body.
  assert.match(prQuery([1]), /\bbody\b/, 'the markdown body');
  assert.doesNotMatch(prQuery([1]), /bodyText/, 'not the rendered text, whose headings are gone');
  assert.equal(summaryOf('## Solution\n\nLeads.\n\n## Reproduce and test the whole flow end to end\n\nRun it.'), 'Leads.',
    'a short Solution is not passed over for the heading that follows it');
});

test('parsePrs reads gh\'s JSON by alias and reports what gh could not answer', () => {
  const good = parsePrs(JSON.stringify({ data: { repository: { p7: prNode(7), p8: null } } }));
  assert.equal(good.error, null);
  assert.deepEqual([...good.prs.keys()], [7]);
  assert.equal(parsePrs('not json').error, 'gh returned no JSON');
  assert.equal(parsePrs(JSON.stringify({ errors: [{ message: 'Bad credentials' }] })).error, 'Bad credentials');
  const scope = parseReviewScope(JSON.stringify({ prs: { 7: { mergeBlockers: ['CI', ' '], independentApprovedHead: 'abc', priorIndependentRoundsUsed: 2, extraReviewAllowance: 1 }, x: {} } }));
  assert.deepEqual([...scope.reviews], [[7, { blockers: ['CI'], approvedHead: 'abc', rounds: 2, extra: 1 }]]);
  assert.match(parseReviewScope('{').error, /JSON/);
});

test('fetchPrs runs gh once per repo and keeps going when gh fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-gh-'));
  const answer = path.join(dir, 'answer.json');
  fs.writeFileSync(answer, JSON.stringify({ data: { repository: { p7: prNode(7) } } }));
  const gh = path.join(dir, 'gh');
  fs.writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\ncat "${answer}"\n`, { mode: 0o755 });
  const got = await fetchPrs('o/jobs', [7, 9], { gh });
  assert.equal(got.error, null);
  assert.equal(got.prs.get(7).title, 'PR 7');
  const args = fs.readFileSync(path.join(dir, 'args'), 'utf8').split('\n');
  assert.deepEqual(args.slice(0, 6), ['api', 'graphql', '-f', 'owner=o', '-f', 'name=jobs'], 'string fields go through -f, which never coerces them');
  assert.match(args[7], /p7: pullRequest\(number: 7\) \{ \.\.\.F \} p9: pullRequest\(number: 9\)/);
  fs.writeFileSync(gh, '#!/bin/sh\necho "gh: Bad credentials" >&2\nexit 1\n');
  const failed = await fetchPrs('o/jobs', [7], { gh });
  assert.equal(failed.error, 'gh exited 1: gh: Bad credentials');
  assert.equal(failed.prs.size, 0);
  assert.match((await fetchPrs('o/jobs', [7], { gh: path.join(dir, 'missing') })).error, /^cannot run gh: /);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A stub gh whose answer is a JSON file the test rewrites between calls, as the fixture's is.
function stubGh(prs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-gh-'));
  const answer = path.join(dir, 'answer.json');
  const gh = path.join(dir, 'gh');
  const script = `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\ncat "${answer}"\n`;
  // set answers (and heals a stub that fail broke); fail makes gh exit 1 with why on stderr.
  const set = (nodes, extra = {}) => {
    fs.writeFileSync(answer, JSON.stringify({ data: { repository: Object.fromEntries(nodes.map((n) => [`p${n.number}`, n])) }, ...extra }));
    fs.writeFileSync(gh, script, { mode: 0o755 });
  };
  set(prs);
  return { gh, dir, set, args: () => fs.readFileSync(path.join(dir, 'args'), 'utf8').split('\n'), fail: (why) => fs.writeFileSync(gh, `#!/bin/sh\necho "${why}" >&2\nexit 1\n`) };
}

test('the PR cache is per repo and PR: a new unit keeps the known PRs, an outage keeps the last good answer, a dropped unit is evicted', async () => {
  const stub = stubGh([prNode(7), prNode(8)]);
  const repo = 'cache/test';
  await refreshPrs(repo, [7, 8], { gh: stub.gh });
  assert.deepEqual([...cachedPrs(repo, [7, 8], NOW, { gh: stub.gh }).prs.keys()], [7, 8]);
  // A third unit appears: the two known PRs stay on the page while the union is fetched.
  stub.set([prNode(7), prNode(8), prNode(9)]);
  const widened = cachedPrs(repo, [7, 8, 9], NOW, { gh: stub.gh });
  assert.deepEqual([...widened.prs.keys()], [7, 8], 'known PRs are not dropped while the new one loads');
  assert.equal(widened.error, null, 'and the lane header does not turn yellow');
  assert.deepEqual([...(await refreshPrs(repo, [7, 8, 9], { gh: stub.gh })).prs.keys()], [7, 8, 9]);
  assert.match(stub.args()[7], /p7: pullRequest\(number: 7\)[^]*p9: pullRequest\(number: 9\)/, 'the union was asked for');
  // gh breaks: every PR keeps its last good state and the error is reported once.
  stub.fail('gh: Bad credentials');
  const errors = mock.method(console, 'error', () => {});
  await refreshPrs(repo, [7, 8, 9], { gh: stub.gh });
  await refreshPrs(repo, [7, 8, 9], { gh: stub.gh });
  const down = cachedPrs(repo, [7, 8, 9], NOW, { gh: stub.gh });
  assert.deepEqual([...down.prs.keys()], [7, 8, 9]);
  assert.equal(down.error, 'gh exited 1: gh: Bad credentials');
  assert.equal(errors.mock.callCount(), 1, 'the same gh failure is logged once, not every refresh');
  errors.mock.restore();
  // A unit finishes: its PR leaves the cache on the next successful fetch, and a PR gh no longer returns leaves too.
  stub.set([prNode(8)]);
  const after = await refreshPrs(repo, [8, 9], { gh: stub.gh });
  assert.deepEqual([...after.prs.keys()], [8], 'evicted 7 (no unit asks) and 9 (gh has no such PR)');
  // A partial GraphQL answer (errors beside data) does not evict the PR it could not answer.
  stub.set([prNode(8)], { errors: [{ message: 'timeout on p9' }] });
  await refreshPrs(repo, [8, 9], { gh: stub.gh });
  stub.set([prNode(8), prNode(9)]);
  await refreshPrs(repo, [8, 9], { gh: stub.gh });
  stub.set([prNode(8)], { errors: [{ message: 'timeout on p9' }] });
  assert.deepEqual([...(await refreshPrs(repo, [8, 9], { gh: stub.gh })).prs.keys()], [8, 9]);
  fs.rmSync(stub.dir, { recursive: true, force: true });
});

test('prView keeps only https links from GitHub\'s answer', () => {
  const view = prView(prNode(1, { url: 'javascript:alert(1)' }, {
    checks: [{ __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'http://ci/lint' }, run('build', 'SUCCESS')],
    preview: 'ftp://preview.example',
  }));
  assert.equal(view.url, null);
  assert.deepEqual(view.checks.map((c) => c.url), [null, 'https://ci/build']);
  assert.equal(view.preview, null);
});

// A lane laid out as job-tracker keeps its files: the ledger and review budgets under state/, a row in a state the
// board does not know, and nothing touched for two days.
function jobsFixture({ prs, days = 2 } = {}) {
  const f = fixture();
  const dir = path.join(path.dirname(f.dbPath), 'lanes');
  const old = new Date(NOW - days * 86_400_000);
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
    fs.utimesSync(path.join(dir, file), old, old);
  };
  write('jobs/lane.json', JSON.stringify({ priority: 1, repo: 'o/jobs', github: true, milestones: [{ id: 'J1', title: 'Leads' }] }));
  write('jobs/units.tsv', TSV([
    UNIT_COLUMNS,
    ['leads', 'in-flight', 'worker', 'feat/leads', '7', 'J1', '', iso(30), 'hosted walkthrough next'],
    ['exports', 'in-progress', 'worker', 'feat/exports', '', 'J1', '', iso(30), ''], // line 3
    ['apply', 'paused', '', 'feat/apply', '8', 'J1', 'leads', iso(30), 'waits for the batch'],
    ['old', 'done', '', '', '5', 'J1', '', '', ''],
  ]));
  write('jobs/state/ledger.tsv', TSV([
    ['pr', 'head', 'verdict', 'by', 'at', 'notes'],
    ['7', 'abc1234', 'approve r1', 'fable', '09:10', ''],
    ['8', 'ddd0000', 'changes r1', 'opus', '09:40', ''],
    ['5', 'eee0000', 'merged', 'coordinator', '08:00', ''],
    ['x', '', 'approve', 'opus', '', ''], // line 5
  ]));
  write('jobs/state/review-scope-ledger.json', JSON.stringify({ prs: {
    7: { priorIndependentRoundsUsed: 2, extraReviewAllowance: 1, independentApprovedHead: 'abc1234abc1234abc1234abc1234abc1234abc12345', mergeBlockers: ['hosted walkthrough on abc1234'] },
    8: { priorIndependentRoundsUsed: 1, extraReviewAllowance: 0, mergeBlockers: ['the owner picks the job batch (order 56)', 'rebase after #7'] },
  } }));
  const asked = [];
  const source = prs ?? ((repo, numbers) => {
    asked.push([repo, numbers]);
    return { at: NOW - 20_000, error: null, prs: new Map([
      [7, prView(prNode(7, { mergeStateStatus: 'BLOCKED' }, { checks: [run('verify', 'SUCCESS'), run('preview', null, 'IN_PROGRESS')], preview: 'https://jobs-git-feat-leads.example.app' }))],
      [8, prView(prNode(8, { isDraft: true, mergeStateStatus: 'BEHIND', headRefOid: 'ccc3333ccc3333ccc3333ccc3333ccc3333ccc33333' }, { checks: [run('verify', 'SUCCESS')] }))],
    ]) };
  });
  return { ...f, lanesDir: dir, autoupdate: null, prs: source, asked };
}

// The whole rendered row of one unit, up to the next row or the end of its lane.
const fullRowOf = (html, id) => {
  const start = html.lastIndexOf('<div class="u', html.indexOf(`</span>${id}</span>`));
  const rest = html.slice(start + 1);
  const end = Math.min(...['<div class="u"', '<div class="u ', '</section>'].map((m) => rest.indexOf(m)).filter((i) => i >= 0));
  return html.slice(start, start + 1 + end);
};

test('map: a unit\'s PR shows its GitHub state, head, preview, checks and summary, with the ledger read from state/', () => {
  const f = jobsFixture();
  const html = renderMap(snapshot({ ...f, now: NOW }));
  assert.deepEqual(f.asked, [['o/jobs', [7, 8]]], 'asks GitHub for the open units\' PRs only, once per repo');
  const leads = fullRowOf(html, 'leads');
  assert.match(leads, /<span class="pr"><a href="https:\/\/github\.com\/o\/jobs\/pull\/7" rel="noreferrer"><b>#7<\/b> <span class="subtext">open<\/span><\/a><\/span>/);
  // The PR title is the headline and the summary comes from its Solution section.
  assert.match(leads, /<\/div><div class="title">PR 7<\/div><div class="summary">Leads\.<\/div><div class="sub">/);
  assert.match(leads, /<div class="unit-note">hosted walkthrough next<\/div>/);
  // One status line per PR; the check list and the review budget fold under it, and the summary names what is folded.
  assert.match(leads, /<div class="pr-block"><div class="meta"><span class="yellow">1 check running<\/span> · head <code>abc1234<\/code> · <a class="link" href="https:\/\/jobs-git-feat-leads\.example\.app" rel="noreferrer">preview ↗<\/a> · verdict approve r1 on this head<\/div><details class="more"><summary><span class="count">1\/2 checks<\/span> · review ledger<\/summary>/);
  assert.match(leads, /<div class="checks"><a class="check" href="https:\/\/ci\/verify" rel="noreferrer" title="pass"><i class="dot pass"><\/i>verify<\/a><a class="check" href="https:\/\/ci\/preview" rel="noreferrer" title="pending"><i class="dot pending"><\/i>preview<\/a><\/div>/);
  assert.match(leads, /<div class="meta">review ledger: hosted walkthrough on abc1234 · <span class="green">approved at this head<\/span> · 2 review rounds, 1 extra allowed<\/div><\/details><\/div>/);
  const apply = fullRowOf(html.slice(html.indexOf('<section>')), 'apply'); // the lane's row, not the Needs you one
  assert.match(apply, /<b>#8<\/b> <span class="overlay">draft<\/span>/);
  assert.match(apply, /<div class="meta">behind main · head <code>ccc3333<\/code> · <span class="overlay">no preview<\/span> · verdict changes r1 on an older head ddd0000<\/div>/);
  // A blocker that is the owner's action stays inline; the rest of the ledger folds.
  assert.match(apply, /<div class="meta peach">review ledger: the owner picks the job batch \(order 56\)<\/div><details class="more"><summary><span class="count">1\/1 checks<\/span> · review ledger<\/summary><div class="checks">[^]*?<\/div><div class="meta">review ledger: rebase after #7 · 1 review round<\/div><\/details>/);
  // A done unit's PR is not asked for; its chip keeps the ledger's verdict.
  assert.match(unitRowOf(html, 'old'), /<b>#5<\/b> merged<\/a>/);
});

test('map: a draft PR\'s failing check reaches its status line', () => {
  const f = jobsFixture({ prs: () => ({ at: NOW - 20_000, error: null, prs: new Map([
    [8, prView(prNode(8, { isDraft: true, mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }, { checks: [run('verify', 'SUCCESS'), run('lint', 'FAILURE')] }))],
  ]) }) });
  const html = renderMap(snapshot({ ...f, now: NOW }));
  const apply = fullRowOf(html.slice(html.indexOf('<section>')), 'apply');
  assert.match(apply, /<b>#8<\/b> <span class="overlay">draft<\/span>/);
  assert.match(apply, /<div class="meta"><span class="red">blocked on: 1 check failing: lint<\/span> · head <code>abc1234<\/code>/);
});

test('map: lanes on one repo share one gh call, so neither evicts the other\'s PRs', () => {
  const f = jobsFixture();
  const dir = path.join(f.lanesDir, 'jobs-docs');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'lane.json'), JSON.stringify({ priority: 2, repo: 'o/jobs', github: true, milestones: [{ id: 'D1', title: 'Docs' }] }));
  fs.writeFileSync(path.join(dir, 'units.tsv'), TSV([UNIT_COLUMNS, ['guide', 'in-flight', 'worker', 'docs/guide', '9', 'D1', '', iso(30), '']]));
  const html = renderMap(snapshot({ ...f, now: NOW }));
  assert.deepEqual(f.asked, [['o/jobs', [7, 8, 9]]], 'one call per repo with every lane\'s open PRs');
  assert.match(fullRowOf(html, 'leads'), /<b>#7<\/b> <span class="subtext">open<\/span>/);
  assert.match(fullRowOf(html, 'guide'), /<b>#9<\/b>/);
});

test('fetchPrs decodes gh\'s output as UTF-8 across chunk boundaries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-gh-'));
  const bytes = Buffer.from(JSON.stringify({ data: { repository: { p7: prNode(7, { title: 'café on the map' }) } } }), 'utf8');
  const cut = bytes.indexOf(Buffer.from('é', 'utf8')) + 1; // between the two bytes of é
  fs.writeFileSync(path.join(dir, 'part1'), bytes.subarray(0, cut));
  fs.writeFileSync(path.join(dir, 'part2'), bytes.subarray(cut));
  const gh = path.join(dir, 'gh');
  fs.writeFileSync(gh, `#!/bin/sh\ncat "${dir}/part1"\nsleep 0.3\ncat "${dir}/part2"\n`, { mode: 0o755 });
  const got = await fetchPrs('o/jobs', [7], { gh });
  assert.equal(got.prs.get(7)?.title, 'café on the map', 'a multibyte character split across two stdout chunks');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('map: a PR blocker that names the owner is in Needs you; GitHub trouble shows on the lane, not as a crash', () => {
  const f = jobsFixture();
  const html = renderMap(snapshot({ ...f, now: NOW }));
  assert.match(html, /<title>\(2\) project map<\/title>/);
  // The row links where he acts: the PR, and the preview when there is one.
  assert.match(html, /<h2 class="attn">Needs you · 2<\/h2>[^]*?<b class="id">apply<\/b><span class="ask">the owner picks the job batch \(order 56\) · since 11:00 · <a href="https:\/\/github\.com\/o\/jobs\/pull\/8" rel="noreferrer"><b>#8<\/b> <span class="overlay">draft<\/span><\/a><\/span><span class="tag">jobs<\/span><\/div>/);
  assert.match(render(snapshot({ ...f, now: NOW, autoupdate: updater(HEALTHY) })), /<div class="name">apply<\/div><div class="sub"><span class="state peach">you<\/span> · jobs · the owner picks the job batch \(order 56\) · since 11:00 · <a href="https:\/\/github\.com\/o\/jobs\/pull\/8" rel="noreferrer"><b>#8<\/b> <span class="overlay">draft<\/span><\/a><\/div>/);
  const blocked = jobsFixture({ prs: () => ({ at: NOW - 1000, error: null, prs: new Map([[7, prView(prNode(7, { mergeStateStatus: 'BLOCKED' }, { checks: [run('lint', 'FAILURE')] }))]]) }) });
  const row = fullRowOf(renderMap(snapshot({ ...blocked, now: NOW })), 'leads');
  assert.match(row, /^<div class="u blocked">/);
  assert.match(row, /<b>#7<\/b> <span class="red">blocked<\/span>/);
  assert.match(row, /<div class="meta"><span class="red">blocked on: 1 check failing: lint<\/span> · head <code>abc1234<\/code> · <span class="overlay">no preview<\/span> · verdict approve r1 on this head<\/div>/);
  assert.match(row, /<summary><span class="count">0\/1 checks<\/span> · review ledger<\/summary>/);
  const down = jobsFixture({ prs: () => ({ at: NOW - 1000, error: 'gh exited 1: gh: Bad credentials', prs: new Map() }) });
  const downHtml = renderMap(snapshot({ ...down, now: NOW }));
  assert.match(downHtml, /<b>jobs<\/b><small>priority 1 · no coordinator · <span class="yellow kept">stale since 9 Oct<\/span> · <span class="yellow">GitHub: gh exited 1: gh: Bad credentials<\/span><\/small>/);
  assert.match(unitRowOf(downHtml, 'leads'), /<b>#7<\/b> approve r1<\/a>/, 'the ledger verdict stands in while GitHub is unreachable');
  const loading = jobsFixture({ prs: () => ({ at: null, error: 'loading PR state from GitHub', prs: new Map() }) });
  assert.match(renderMap(snapshot({ ...loading, now: NOW })), /<span class="yellow">GitHub: loading PR state from GitHub<\/span>/);
});

test('map: Needs you skips done units, lists one item per PR, and only blockers whose action is the owner\'s, each linked', () => {
  const f = fixture();
  const dir = path.join(path.dirname(f.dbPath), 'lanes');
  fs.mkdirSync(path.join(dir, 'acts/state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'acts/lane.json'), JSON.stringify({ priority: 1, repo: 'o/acts', github: true }));
  fs.writeFileSync(path.join(dir, 'acts/units.tsv'), TSV([
    UNIT_COLUMNS,
    ['shipped', 'done', '', '', '5', '', '', '', ''],
    ['front', 'in-flight', 'w1', 'feat/front', '7', '', '', iso(30), ''],
    ['back', 'in-flight', 'w2', 'feat/back', '7', '', '', iso(20), 'same PR as front'],
    ['later', 'paused', '', 'feat/later', '8', '', '', iso(10), ''],
    ['budget', 'in-flight', 'w3', 'feat/budget', '9', '', '', iso(5), ''],
    ['waiting', 'needs-myuser', '', 'feat/waiting', '9', '', '', iso(2), 'approve the budget'],
  ]));
  fs.writeFileSync(path.join(dir, 'acts/state/review-scope-ledger.json'), JSON.stringify({ prs: {
    5: { mergeBlockers: ['the owner signs off'] }, // done: his sign-off happened
    7: { mergeBlockers: ['the owner picks the job batch (order 56)'] }, // his, once
    8: { mergeBlockers: ["rebase after the owner's PR lands", 'CI must pass'] }, // names him, not his action
    9: { mergeBlockers: ['needs the owner to approve the budget'] }, // his, but the needs-myuser unit on the same PR already asks
  } }));
  const prs = () => ({ at: NOW - 1000, error: null, prs: new Map([
    [7, prView(prNode(7, {}, { preview: 'https://acts-git-feat-front.example.app' }))], [8, prView(prNode(8))], [9, prView(prNode(9))],
  ]) });
  const html = renderMap(snapshot({ ...f, lanesDir: dir, autoupdate: null, prs, now: NOW }));
  assert.match(html, /<title>\(3\) project map<\/title>/, 'two units and the fixture thread with an input card');
  const needs = html.slice(html.indexOf('Needs you · 3'), html.indexOf('<div class="cols">'));
  assert.match(needs, /<b class="id">waiting<\/b><span class="ask">approve the budget · since 11:28 · <a href="https:\/\/github\.com\/o\/jobs\/pull\/9" rel="noreferrer"><b>#9<\/b> <span class="green">ready<\/span><\/a><\/span>/);
  assert.match(needs, /<b class="id">front<\/b><span class="ask">the owner picks the job batch \(order 56\) · since 11:00 · <a href="https:\/\/github\.com\/o\/jobs\/pull\/7" rel="noreferrer"><b>#7<\/b> <span class="green">ready<\/span><\/a> · <a class="link" href="https:\/\/acts-git-feat-front\.example\.app" rel="noreferrer">preview ↗<\/a><\/span>/);
  for (const id of ['shipped', 'back', 'later', 'budget']) assert.doesNotMatch(needs, new RegExp(`>${id}<`), id);
  // A done unit without a ledger verdict shows its PR number alone, not "no verdict".
  assert.match(unitRowOf(html, 'shipped'), /<span class="pr"><a href="https:\/\/github\.com\/o\/acts\/pull\/5" rel="noreferrer"><b>#5<\/b><\/a><\/span><\/div><\/div>/);
});

test('map: a row the board cannot read is a warning beside its lane, a stale lane says since when, and ledger problems are named', () => {
  const f = jobsFixture();
  const html = renderMap(snapshot({ ...f, now: NOW }));
  const lane = html.slice(html.indexOf('<b>jobs</b>'), html.indexOf('<div class="ms">'));
  assert.match(lane, /<span class="yellow kept">stale since 9 Oct<\/span> · <span class="kept">PRs 20s ago<\/span><\/small><\/div>/);
  assert.match(lane, /<div class="note">state\/ledger\.tsv: 1 row skipped \(line 5: pr &quot;x&quot; is not a number\)<\/div>/);
  assert.match(lane, /<div class="u warn"><div class="row"><span class="id"><span class="state yellow">unreadable<\/span>units\.tsv line 3<\/span><span class="pr">exports<\/span><\/div><div class="sub yellow">unknown state &quot;in-progress&quot;; states are queued, in-flight, needs-myuser, paused, done<\/div><\/div>/);
  assert.match(html, /<footer>[^]*jobs: <b>1 row skipped, 1 ledger row skipped<\/b>/);
  const fresh = jobsFixture({ days: 0.5 });
  assert.match(renderMap(snapshot({ ...fresh, now: NOW })), /<b>jobs<\/b><small>priority 1 · no coordinator · <span class="kept">updated 12 h ago<\/span> · <span class="kept">PRs 20s ago<\/span><\/small>/);
  // No ledger at all is said once, since the lane has open PRs.
  fs.rmSync(path.join(f.lanesDir, 'jobs/state/ledger.tsv'));
  assert.match(renderMap(snapshot({ ...f, now: NOW })), /<div class="note">no ledger: no ledger\.tsv or state\/ledger\.tsv, so PRs have no verdict<\/div>/);
});

test('map: nothing is clipped: no line is kept to one row with an ellipsis, on the phone or the desktop', () => {
  const html = renderMap(snapshot({ ...jobsFixture(), now: NOW }));
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.doesNotMatch(style, /text-overflow|line-clamp/);
  // The clock stays on a phone, and a short time phrase ("updated 5 min ago") never breaks with "ago" on its own line.
  assert.doesNotMatch(style, /\.clock\{display:none\}/);
  assert.match(style, /\.kept\{white-space:nowrap\}/);
  assert.match(html, /<small><span class="clock">\d\d:\d\d:\d\d SGT<\/span> · refreshes every 15s<\/small>/);
  for (const cls of ['.sub', '.id', '.pr', '.after', '.title', '.summary', '.unit-note', '.meta', '.note', '.ask', '.check']) {
    const rule = style.slice(style.indexOf(`\n${cls}{`) + 1 || style.indexOf(`}${cls}{`) + 1);
    assert.match(rule.slice(0, rule.indexOf('}')), /overflow-wrap:anywhere/, cls);
    assert.doesNotMatch(rule.slice(0, rule.indexOf('}')), /white-space:nowrap/, cls);
  }
});
