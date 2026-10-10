#!/usr/bin/env node
// Agent board: a read-only phone view of every open T3 thread - who is waiting on the owner, what is running, how full each
// context is, and which runs have gone quiet. It reads T3's statev2.sqlite (read-only, explicit columns only; never the
// scheduled_tasks webhook token or secret) and tails Claude Code logs for last activity, and writes nothing anywhere.
// Listens on 127.0.0.1 and this Mac's Tailscale address only, never all interfaces, and answers GET for allowlisted
// Host names only. Run by a Home Manager launchd agent (see nix/user.nix); logs go to ~/Library/Logs.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.AGENT_BOARD_PORT ?? 4790);
const T3_DB = process.env.AGENT_BOARD_T3_DB ?? path.join(os.homedir(), '.t3/userdata/statev2.sqlite');
const CLAUDE_PROJECTS = process.env.AGENT_BOARD_CLAUDE_PROJECTS ?? path.join(os.homedir(), '.claude/projects');
const QUIET_MS = 10 * 60_000; // a running thread with no log write for this long is flagged
const REFRESH_S = 15;
const TAIL_BYTES = 512 * 1024;
const IDLE_SHOWN = 12;
const ACTIVE_RUNS = ['running', 'starting', 'preparing', 'queued'];

// One row per open thread. The run subquery ranks an active run above later cancelled or queued entries, as
// ~/orchestrator/status.mjs does. Context comes from the thread's active provider thread, which T3 updates per turn.
const THREADS_SQL = `
  SELECT t.thread_id AS id, t.title, t.updated_at AS updatedAt, p.title AS project,
    json_extract(t.payload_json, '$.branch') AS branch,
    json_extract(t.payload_json, '$.modelSelection.model') AS model,
    json_extract(t.payload_json, '$.lineage.parentThreadId') AS parentId,
    (SELECT r.status FROM orchestration_v2_projection_runs r WHERE r.thread_id = t.thread_id
      ORDER BY r.status IN ('running', 'waiting', 'starting', 'preparing', 'queued') DESC, r.ordinal DESC
      LIMIT 1) AS run,
    (SELECT count(*) FROM projection_pending_approvals a
      WHERE a.thread_id = t.thread_id AND a.status = 'pending') AS approvals,
    (SELECT count(*) FROM orchestration_v2_projection_runtime_requests q
      WHERE q.thread_id = t.thread_id AND q.resolved_at IS NULL AND q.status NOT IN ('resolved', 'cancelled')) AS inputs,
    (SELECT min(q.created_at) FROM orchestration_v2_projection_runtime_requests q
      WHERE q.thread_id = t.thread_id AND q.resolved_at IS NULL AND q.status NOT IN ('resolved', 'cancelled')) AS askedAt,
    pt.provider AS provider,
    json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') AS sessionId,
    json_extract(pt.payload_json, '$.contextUsage.usedTokens') AS contextUsed,
    json_extract(pt.payload_json, '$.contextUsage.maxTokens') AS contextMax
  FROM orchestration_v2_projection_threads t
  LEFT JOIN projection_projects p ON p.project_id = t.project_id
  LEFT JOIN orchestration_v2_projection_provider_threads pt ON pt.provider_thread_id = t.active_provider_thread_id
  WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND json_extract(t.payload_json, '$.settledAt') IS NULL
  ORDER BY t.updated_at DESC`;

export function readThreads(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(THREADS_SQL).all();
  } finally {
    db.close();
  }
}

// Claude Code names each log after its session id; T3 records that id as the provider thread's nativeId.
function indexLogs(dir) {
  const logs = new Map();
  let projects = [];
  try { projects = fs.readdirSync(dir, { withFileTypes: true }); } catch { return logs; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    let files = [];
    try { files = fs.readdirSync(path.join(dir, project.name)); } catch { continue; }
    for (const file of files) if (file.endsWith('.jsonl')) logs.set(file.slice(0, -6), path.join(dir, project.name, file));
  }
  return logs;
}

// Last activity time, plus (when parse is set) the newest main-thread assistant line's tool call and the context
// tokens as of the last assistant turn: input plus cache reads and writes, as recall.py counts them.
export function readLog(file, { parse = true } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size, mtimeMs } = fs.fstatSync(fd);
    if (!parse) return { lastActivityAt: mtimeMs, tool: null, contextUsed: null };
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    let tool;
    let contextUsed = null;
    for (let i = lines.length - 1; i >= 0 && contextUsed === null; i--) {
      if (!lines[i].includes('"assistant"')) continue;
      let row;
      try { row = JSON.parse(lines[i]); } catch { continue; }
      if (row.type !== 'assistant' || row.isSidechain) continue;
      const content = Array.isArray(row.message?.content) ? row.message.content : [];
      if (tool === undefined) tool = content.findLast((c) => c.type === 'tool_use')?.name ?? null;
      const u = row.message?.usage;
      if (u) contextUsed = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    }
    return { lastActivityAt: mtimeMs, tool: tool ?? null, contextUsed };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function snapshot({ dbPath = T3_DB, logsDir = CLAUDE_PROJECTS, now = Date.now() } = {}) {
  const rows = readThreads(dbPath);
  const logs = indexLogs(logsDir);
  const titles = new Map(rows.map((r) => [r.id, r.title]));
  const threads = rows.map((r) => {
    const state = r.approvals > 0 || r.inputs > 0 || r.run === 'waiting' ? 'needs'
      : ACTIVE_RUNS.includes(r.run) ? 'running' : 'idle';
    const log = r.sessionId && logs.has(r.sessionId)
      ? readLog(logs.get(r.sessionId), { parse: state !== 'idle' || r.contextUsed === null })
      : null;
    const lastActivityAt = Math.max(log?.lastActivityAt ?? 0, Date.parse(r.updatedAt) || 0) || null;
    return {
      id: r.id,
      title: r.title || 'Untitled thread',
      project: r.project,
      branch: r.branch,
      model: r.model,
      parentTitle: r.parentId ? titles.get(r.parentId) ?? 'closed thread' : null,
      run: r.run,
      state,
      ask: r.inputs > 0 ? 'input card' : r.approvals > 0 ? 'approval' : r.run === 'waiting' ? 'waiting' : null,
      askedAt: r.askedAt ? Date.parse(r.askedAt) : null,
      tool: state === 'running' ? log?.tool ?? null : null,
      contextUsed: r.contextUsed ?? log?.contextUsed ?? null,
      contextMax: r.contextMax ?? null,
      lastActivityAt,
      quiet: state === 'running' && lastActivityAt !== null && now - lastActivityAt > QUIET_MS,
    };
  });
  // Child threads (delegated tasks) only earn a row while they are active.
  const shown = threads.filter((t) => !t.parentTitle || t.state !== 'idle');
  return {
    now,
    needs: shown.filter((t) => t.state === 'needs'),
    running: shown.filter((t) => t.state === 'running'),
    idle: shown.filter((t) => t.state === 'idle'),
  };
}

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

const tokens = (n) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

// claude-opus-5-5 -> Opus 5.5; other providers' ids stay as they are.
const modelName = (id) => {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id ?? '');
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
};

const RUN_LABELS = { completed: 'done', cancelled: 'stopped', interrupted: 'interrupted', failed: 'failed' };

function card(t, now) {
  let label;
  let tone;
  if (t.state === 'needs') {
    label = `${t.ask}${t.askedAt ? ` ${ago(now - t.askedAt)}` : ''}`;
    tone = 'peach';
  } else if (t.state === 'running') {
    const since = t.lastActivityAt ? ago(now - t.lastActivityAt) : '';
    label = t.quiet ? `no activity ${since}` : [t.tool, since].filter(Boolean).join(' ') || 'running';
    tone = t.quiet ? 'red' : 'green';
  } else {
    label = `${RUN_LABELS[t.run] ?? 'new'}${t.lastActivityAt ? ` ${ago(now - t.lastActivityAt)} ago` : ''}`;
    tone = t.run === 'failed' ? 'red' : 'muted';
  }
  const context = t.contextUsed === null ? null
    : t.contextMax ? `${tokens(t.contextUsed)} / ${tokens(t.contextMax)}` : tokens(t.contextUsed);
  const meta = [context, modelName(t.model), t.project, t.branch].filter(Boolean).map(escape).join(' · ');
  const share = t.contextUsed !== null && t.contextMax ? Math.min(1, t.contextUsed / t.contextMax) : null;
  // Context bands follow the pause-safely rule: past 300k pause at the next boundary, past 450k now.
  const band = t.contextUsed >= 450_000 ? 'hot' : t.contextUsed >= 300_000 ? 'warn' : '';
  const bar = share !== null && t.state !== 'idle'
    ? `<div class="ctx"><i class="${band}" style="width:${(share * 100).toFixed(1)}%"></i></div>` : '';
  return `<div class="t ${t.state}"><div class="name">${escape(t.title)}</div>`
    + (t.parentTitle ? `<div class="sub">↳ ${escape(t.parentTitle)}</div>` : '')
    + `<div class="sub"><span class="state ${tone}">${escape(label)}</span>${meta ? ` · ${meta}` : ''}</div>${bar}</div>`;
}

export function render(snap) {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(snap.now);
  const section = (title, list, cls = '', limit = Infinity) => (list.length
    ? `<h2 class="${cls}">${title} · ${list.length}</h2>${list.slice(0, limit).map((t) => card(t, snap.now)).join('')}`
      + (list.length > limit ? `<p class="more">+${list.length - limit} more</p>` : '')
    : '');
  const body = section('Needs you', snap.needs, 'attn') + section('Running', snap.running)
    + section('Idle', snap.idle, '', IDLE_SHOWN);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="${REFRESH_S}">
<title>${snap.needs.length ? `(${snap.needs.length}) ` : ''}agent board</title><style>${STYLE}</style></head><body><main>
<header><h1>agent board</h1><span>${time} SGT · refreshes every ${REFRESH_S}s</span></header>
${body || '<p class="more">No open T3 threads.</p>'}
<footer>Read-only view of T3 state. Nothing here can change an agent.</footer></main></body></html>`;
}

function errorPage(message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${REFRESH_S}"><title>agent board error</title><style>${STYLE}</style></head><body><main>
<header><h1>agent board</h1></header><div class="t needs"><div class="name">Could not read T3 state</div>
<div class="sub">${escape(message)}</div><div class="sub">If T3 just updated, its database schema may have changed; update files/bin/agent-board.mjs.</div></div>
</main></body></html>`;
}

// Catppuccin Mocha and JetBrains Mono (AGENTS.md theme rule). No external assets.
const STYLE = `:root{--base:#1e1e2e;--mantle:#181825;--crust:#11111b;--surface0:#313244;--surface1:#45475a;--overlay1:#7f849c;
--text:#cdd6f4;--subtext:#a6adc8;--teal:#94e2d5;--green:#a6e3a1;--yellow:#f9e2af;--peach:#fab387;--red:#f38ba8;--lavender:#b4befe;
--mono:'JetBrains Mono','JetBrainsMono Nerd Font',ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--crust);color:var(--text);font-family:var(--mono);font-size:14px;line-height:1.5;padding:0 12px 40px}
main{max-width:720px;margin:0 auto;min-width:0}
header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:4px 12px;padding:18px 4px 6px}
h1{font-size:17px;color:var(--lavender)}header span{font-size:12px;color:var(--overlay1)}
h2{font-size:11.5px;letter-spacing:.6px;text-transform:uppercase;color:var(--overlay1);margin:16px 4px 7px;font-weight:500}
h2.attn{color:var(--peach)}
.t{background:var(--base);border:1px solid var(--surface0);border-radius:10px;padding:10px 12px;margin-bottom:8px;min-width:0}
.t.needs{background:#2b2530;border-color:#5a4652}
.name{font-weight:700;font-size:13.5px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere}
.sub{font-size:12px;color:var(--subtext);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}
.green{color:var(--green)}.red{color:var(--red)}.peach{color:var(--peach)}.muted{color:var(--overlay1)}
.ctx{height:5px;background:var(--surface0);border-radius:3px;margin-top:8px;overflow:hidden}
.ctx i{display:block;height:100%;background:var(--teal)}.ctx i.warn{background:var(--yellow)}.ctx i.hot{background:var(--red)}
.more{color:var(--overlay1);font-size:12px;margin:4px}
footer{color:var(--overlay1);font-size:11px;margin:20px 4px 0}`;

// The tailnet address is the CGNAT range Tailscale assigns (100.64.0.0/10).
export function tailnetAddress(interfaces = os.networkInterfaces()) {
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [first, second] = a.address.split('.').map(Number);
      if (first === 100 && second >= 64 && second <= 127) return a.address;
    }
  }
  return null;
}

// Allow loopback, the tailnet IP and this Mac's MagicDNS names, on our port only. Anything else is a DNS rebinding
// attempt or a misrouted request.
export function hostAllowed(hostHeader, { port = PORT, short = os.hostname().split('.')[0].toLowerCase(), tailnetIp = null } = {}) {
  const match = /^([a-z0-9.-]+):(\d+)$/i.exec(hostHeader ?? '');
  if (!match || Number(match[2]) !== port) return false;
  const host = match[1].toLowerCase();
  if (host === '127.0.0.1' || host === 'localhost' || host === short || (tailnetIp && host === tailnetIp)) return true;
  return host.startsWith(`${short}.`) && host.endsWith('.ts.net') && /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(host);
}

const HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

function handle(req, res, tailnetIp) {
  if (!hostAllowed(req.headers.host, { tailnetIp })) {
    res.writeHead(403, { ...HEADERS, 'content-type': 'text/plain' }).end('Host not allowed.\n');
  } else if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...HEADERS, allow: 'GET, HEAD', 'content-type': 'text/plain' }).end('Read-only.\n');
  } else if (req.url !== '/' && !req.url.startsWith('/?')) {
    res.writeHead(404, { ...HEADERS, 'content-type': 'text/plain' }).end('Not found.\n');
  } else {
    let status = 200;
    let html;
    try {
      html = render(snapshot());
    } catch (error) {
      status = 500;
      html = errorPage(error.message);
      console.error(`agent-board: ${error.message}`);
    }
    res.writeHead(status, { ...HEADERS, 'content-type': 'text/html; charset=utf-8' }).end(req.method === 'HEAD' ? undefined : html);
  }
}

function serve() {
  const listeners = new Map(); // host -> server
  const listen = (host) => {
    const server = http.createServer((req, res) => handle(req, res, tailnetAddress()));
    server.on('error', (error) => {
      console.error(`agent-board: cannot listen on ${host}:${PORT}: ${error.message}`);
      listeners.delete(host);
      // Without loopback the process is useless; exit so launchd's KeepAlive retries. The tailnet bind retries itself.
      if (host === '127.0.0.1') process.exit(1);
    });
    server.listen(PORT, host, () => console.log(`agent-board: listening on ${host}:${PORT}`));
    listeners.set(host, server);
  };
  listen('127.0.0.1');
  // Tailscale may come up after login, and its address can change; follow it without ever binding 0.0.0.0.
  const syncTailnet = () => {
    const ip = tailnetAddress();
    for (const [host, server] of listeners) {
      if (host !== '127.0.0.1' && host !== ip) {
        server.close();
        listeners.delete(host);
        console.log(`agent-board: stopped listening on ${host}:${PORT}`);
      }
    }
    if (ip && !listeners.has(ip)) listen(ip);
  };
  syncTailnet();
  setInterval(syncTailnet, 15_000);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) serve();
