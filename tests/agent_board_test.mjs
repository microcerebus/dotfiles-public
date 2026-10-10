// Run: node --test tests/agent_board_test.mjs
// Builds a fixture copy of the T3 tables the board reads, plus Claude logs, and checks what the board shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hostAllowed, render, snapshot, tailnetAddress } from '../files/bin/agent-board.mjs';

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
  provider('A', 'sess-a', { usedTokens: 320_000, maxTokens: 1_000_000 });
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
  return { dbPath, logsDir };
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
  assert.equal(a.contextUsed, 320_000);
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
  assert.match(html, /Bash 30s<\/span> · 320k \/ 1M · Opus 5\.5 · job-tracker · ui-polish/);
  assert.match(html, /done 25 min ago/);
  assert.match(html, /class="warn" style="width:32\.0%"/);
  assert.match(html, /↳ UI owner/);
  assert.ok(html.includes('macOS update &lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('Settled thread') && !html.includes('Deleted thread') && !html.includes('Finished child'));
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
