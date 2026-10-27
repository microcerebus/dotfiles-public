#!/usr/bin/env node
// Agent board: a read-only phone view of every open T3 thread - who is waiting on the owner, what is running, how full each
// context is, and which runs have gone quiet. It reads T3's statev2.sqlite (read-only, explicit columns only; never the
// scheduled_tasks webhook token or secret) and tails Claude Code logs for last activity. It writes nothing but its own
// `tailscale serve` handler.
// It also shows the dotfiles auto-updater's alarms, from that updater's own reader (scripts/dotfiles-autoupdate status).
// A second page, /map, shows each orchestrator lane's milestones, units, owners and what waits on the owner, read from the
// lane files under ~/orchestrator/lanes (design: docs/agent-observability/project-map.html), plus read-only local git
// to flag a row waiting on the owner whose branch already landed.
// Listens on 127.0.0.1 only and answers GET for allowlisted Host names only. Tailnet devices reach it through
// `tailscale serve`, which the board sets up for itself. Run by a Home Manager launchd agent (see nix/user.nix); logs go
// to ~/Library/Logs.
import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.AGENT_BOARD_PORT ?? 4790);
// The live board publishes itself on the tailnet; a board on a port of its own (tests, verify-agent-board) only when
// asked, because tailscaled keeps every handler it is given.
const PUBLISH = (process.env.AGENT_BOARD_PUBLISH ?? (process.env.AGENT_BOARD_PORT ? '0' : '1')) === '1';
// How often the board checks that its tailscale serve handler is still there, and puts it back if not.
const PUBLISH_CHECK_MS = Number(process.env.AGENT_BOARD_PUBLISH_CHECK_MS ?? 60_000);
const TAILSCALE = process.env.AGENT_BOARD_TAILSCALE ?? '/usr/local/bin/tailscale';
const T3_DB = process.env.AGENT_BOARD_T3_DB ?? path.join(os.homedir(), '.t3/userdata/statev2.sqlite');
const CLAUDE_PROJECTS = process.env.AGENT_BOARD_CLAUDE_PROJECTS ?? path.join(os.homedir(), '.claude/projects');
const LANES = process.env.AGENT_BOARD_LANES ?? path.join(os.homedir(), 'orchestrator/lanes');
const SELF = fileURLToPath(import.meta.url);
const AUTOUPDATE = path.join(path.dirname(SELF), '../../scripts/dotfiles-autoupdate');
const QUIET_MS = 10 * 60_000; // a running thread with no log write for this long is flagged
const REFRESH_S = 15;
// PR state comes from GitHub through gh, once per repo, refreshed in the background after this long, so a check that
// finishes shows on the next page refresh and a page never waits on the network.
const PR_TTL_MS = Number(process.env.AGENT_BOARD_PR_TTL_MS ?? 45_000);
// launchd gives the board no PATH beyond /usr/bin, so gh is looked for where Home Manager and Homebrew put it.
const GH = process.env.AGENT_BOARD_GH ?? [
  path.join('/etc/profiles/per-user', os.userInfo().username, 'bin/gh'), '/run/current-system/sw/bin/gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh',
].find((p) => fs.existsSync(p)) ?? 'gh';
const TAIL_BYTES = 512 * 1024;
const IDLE_SHOWN = 12;
const ACTIVE_RUNS = ['running', 'starting', 'preparing', 'queued'];

// One row per open thread, built from parts. T3 changes its schema without notice: its migration 063 dropped
// projection_pending_approvals (applied here 19 Oct 2026) and every board page became a 500. So each part names the
// columns it reads, a part whose table or column is gone is left out and named on the page as unavailable, and the rest
// still render. Without the thread table itself there is no thread list.
const THREADS = { orchestration_v2_projection_threads: ['thread_id', 'title', 'updated_at', 'payload_json', 'archived_at', 'deleted_at'] };
const PARTS = [
  // An active run ranks above later cancelled or queued entries, as ~/orchestrator/status.mjs does.
  {
    what: 'run states',
    reads: { orchestration_v2_projection_runs: ['thread_id', 'status', 'ordinal'] },
    select: `(SELECT r.status FROM orchestration_v2_projection_runs r WHERE r.thread_id = t.thread_id
      ORDER BY r.status IN ('running', 'waiting', 'starting', 'preparing', 'queued') DESC, r.ordinal DESC
      LIMIT 1) AS run`,
    fields: ['run'],
  },
  // Approvals and input cards are both runtime requests. T3's sidebar says "Pending Approval" for a pending request of
  // any kind but user_input and auth_refresh (command, file-read, file-change, mcp-elicitation, permission), and
  // "Awaiting Input" for a pending user_input. An auth_refresh is T3's own and asks nothing of the owner.
  {
    what: 'approvals and input cards',
    reads: { orchestration_v2_projection_runtime_requests: ['thread_id', 'kind', 'status', 'created_at'] },
    select: `(SELECT count(*) FROM orchestration_v2_projection_runtime_requests q
      WHERE q.thread_id = t.thread_id AND q.status = 'pending' AND q.kind NOT IN ('user_input', 'auth_refresh')) AS approvals,
    (SELECT count(*) FROM orchestration_v2_projection_runtime_requests q
      WHERE q.thread_id = t.thread_id AND q.status = 'pending' AND q.kind = 'user_input') AS inputs,
    (SELECT min(q.created_at) FROM orchestration_v2_projection_runtime_requests q
      WHERE q.thread_id = t.thread_id AND q.status = 'pending' AND q.kind != 'auth_refresh') AS askedAt`,
    fields: ['approvals', 'inputs', 'askedAt'],
  },
  {
    what: 'project names',
    reads: { orchestration_v2_projection_threads: ['project_id'], projection_projects: ['project_id', 'title'] },
    select: 'p.title AS project',
    join: 'LEFT JOIN projection_projects p ON p.project_id = t.project_id',
    fields: ['project'],
  },
  // Context comes from the thread's active provider thread, which T3 updates per turn.
  {
    what: 'context and session ids',
    reads: {
      orchestration_v2_projection_threads: ['active_provider_thread_id'],
      orchestration_v2_projection_provider_threads: ['provider_thread_id', 'payload_json'],
    },
    select: `json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') AS sessionId,
    json_extract(pt.payload_json, '$.contextUsage.usedTokens') AS contextUsed,
    json_extract(pt.payload_json, '$.contextUsage.maxTokens') AS contextMax`,
    join: 'LEFT JOIN orchestration_v2_projection_provider_threads pt ON pt.provider_thread_id = t.active_provider_thread_id',
    fields: ['sessionId', 'contextUsed', 'contextMax'],
  },
];

// What `reads` needs that the database lacks, as "no table x" or "no column x.y, x.z"; null when all of it is there.
function lacking(db, reads) {
  const gone = [];
  for (const [table, columns] of Object.entries(reads)) {
    const have = new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((c) => c.name));
    if (!have.size) gone.push(`no table ${table}`);
    else {
      const missing = columns.filter((c) => !have.has(c));
      if (missing.length) gone.push(`no column ${missing.map((c) => `${table}.${c}`).join(', ')}`);
    }
  }
  return gone.length ? gone.join('; ') : null;
}

// rows: the open threads, or null when there is no thread list. unavailable: one line per part of the page T3 no longer
// gives the board, with why.
export function readThreads(dbPath) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const missing = lacking(db, THREADS);
    if (missing) return { rows: null, unavailable: [`T3 threads unavailable: ${missing}`] };
    const unavailable = [];
    const parts = PARTS.map((part) => {
      const why = lacking(db, part.reads);
      if (why) unavailable.push(`${part.what} unavailable: ${why}`);
      return why ? { select: part.fields.map((f) => `NULL AS ${f}`).join(', '), join: '' } : part;
    });
    const rows = db.prepare(`
      SELECT t.thread_id AS id, t.title, t.updated_at AS updatedAt,
        json_extract(t.payload_json, '$.branch') AS branch,
        json_extract(t.payload_json, '$.modelSelection.model') AS model,
        json_extract(t.payload_json, '$.lineage.parentThreadId') AS parentId,
        ${parts.map((p) => p.select).join(',\n    ')}
      FROM orchestration_v2_projection_threads t
      ${parts.map((p) => p.join ?? '').join('\n  ')}
      WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND json_extract(t.payload_json, '$.settledAt') IS NULL
      ORDER BY t.updated_at DESC`).all();
    return { rows, unavailable };
  } catch (error) {
    return { rows: null, unavailable: [`T3 threads unavailable: ${error.message}`] };
  } finally {
    db?.close();
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

// The updater's reader decides what is an alarm; the board only sorts its lines. macOS's bash 3.2 runs it, as launchd
// gives this agent no other PATH.
export function readUpdates(script = AUTOUPDATE) {
  const run = spawnSync('/bin/bash', [script, 'status'], { encoding: 'utf8', timeout: 5000 });
  if (run.status !== 0) {
    const why = (run.stderr || run.error?.message || `exit ${run.status}`).trim().split('\n').pop();
    return { alarms: [`could not read the auto-update status: ${why}`], infos: [], oks: [] };
  }
  const updates = { alarms: [], infos: [], oks: [] };
  for (const line of run.stdout.split('\n')) {
    const match = /^(alarm|info|ok): (.*)$/.exec(line);
    if (match) updates[{ alarm: 'alarms', info: 'infos', ok: 'oks' }[match[1]]].push(match[2]);
  }
  return updates;
}

// autoupdate: null skips the updater, which only the thread page shows. prs: where PR state comes from (the gh cache).
export function snapshot({ dbPath = T3_DB, logsDir = CLAUDE_PROJECTS, lanesDir = LANES, now = Date.now(), autoupdate = AUTOUPDATE, prs = cachedPrs } = {}) {
  const { rows: read, unavailable } = readThreads(dbPath);
  const rows = read ?? [];
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
      approvals: r.approvals,
      inputs: r.inputs,
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
    // threads: false when there is no thread list, so a page never reads "no threads" or "no owner thread" into it.
    t3: { threads: read !== null, unavailable },
    updates: autoupdate === null ? null : readUpdates(autoupdate),
    needs: shown.filter((t) => t.state === 'needs'),
    running: shown.filter((t) => t.state === 'running'),
    idle: shown.filter((t) => t.state === 'idle'),
    // Unit owners and lane coordinators may be any open thread, including the idle children hidden above.
    threads: new Map(threads.map((t) => [t.id, t])),
    lanes: readLanes(lanesDir, now, prs),
  };
}

// ---- Lane files (the /map page's source) ----
// Each lane is ~/orchestrator/lanes/<lane>/ with lane.json, units.tsv and ledger.tsv, written by the orchestrator, the
// lane coordinator and the verifiers (templates/orchestrator-lane/README.md has the columns). Read on every request
// and never written. A bad file or row is reported on the page, never guessed at.

// The lane rule (dotfiles standing order 7, job-tracker order 55) allows exactly these; templates/orchestrator-lane/README.md
// documents the same list, and tests/agent_board_test.mjs fails when the two drift apart.
export const UNIT_STATES = ['queued', 'in-flight', 'needs-myuser', 'paused', 'done'];
const UNIT_ID = /^[a-z0-9][a-z0-9-]*$/;
// T3 ids as stored: mcp:<uuid>, thread:<...> or a bare uuid. Owner text that looks like neither is prose.
const THREAD_ID = /^(?:[a-z]+:\S+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const SGT_MS = 8 * 3600_000; // Singapore has no daylight saving

// Header names lower-cased; rows keep their 1-based file line for error messages. Blank lines are not rows.
function readTsv(text) {
  const lines = text.split('\n').map((l, i) => ({ line: i + 1, text: l.replace(/\r$/, '') })).filter((l) => l.text.trim());
  if (!lines.length) return { header: [], rows: [] };
  const header = lines[0].text.split('\t').map((h) => h.trim().toLowerCase());
  return { header, rows: lines.slice(1).map((l) => ({ line: l.line, fields: l.text.split('\t').map((f) => f.trim()) })) };
}

// Columns are matched by header name, so order and extra columns do not matter. A row with the wrong field count, a
// bad or duplicate unit id, or a state outside UNIT_STATES is skipped and reported; the rest render.
export function parseUnits(text) {
  const { header, rows } = readTsv(text);
  const missing = ['unit', 'state'].filter((name) => !header.includes(name));
  if (missing.length) return { error: `no ${missing.join(' or ')} column`, units: [], skipped: [] };
  const units = [];
  const skipped = [];
  const seen = new Set();
  for (const { line, fields } of rows) {
    if (fields.length !== header.length) {
      skipped.push({ line, why: `${fields.length} fields, header has ${header.length}` });
      continue;
    }
    const get = (name) => (header.includes(name) ? fields[header.indexOf(name)] : '');
    const id = get('unit').replace(/^#/, '');
    const state = get('state');
    const why = !UNIT_ID.test(id) ? `bad unit id "${id}"`
      : !UNIT_STATES.includes(state) ? `unknown state "${state}"`
        : seen.has(id) ? `duplicate unit "${id}"` : null;
    if (why) {
      skipped.push({ line, why, id });
      continue;
    }
    seen.add(id);
    units.push({
      id, state, line,
      owner: get('owner'), branch: get('branch'), pr: get('pr').replace(/^#(?=\d+$)/, ''),
      milestone: get('milestone'), since: get('since'), note: get('note'),
      after: get('after').split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean),
    });
  }
  return { error: null, units, skipped };
}

// The ledger is append-only, so a PR's last row is its newest verdict. The head it was given on (head or head_sha)
// tells whether the verdict still applies to the PR's current head.
export function parseLedger(text) {
  const { header, rows } = readTsv(text);
  const missing = ['pr', 'verdict'].filter((name) => !header.includes(name));
  if (missing.length) return { error: `no ${missing.join(' or ')} column`, verdicts: new Map(), skipped: [] };
  const headColumn = ['head', 'head_sha'].find((name) => header.includes(name));
  const verdicts = new Map();
  const skipped = [];
  for (const { line, fields } of rows) {
    const pr = (fields[header.indexOf('pr')] ?? '').replace(/^#/, '');
    const verdict = fields[header.indexOf('verdict')] ?? '';
    const why = fields.length !== header.length ? `${fields.length} fields, header has ${header.length}`
      : !/^\d+$/.test(pr) ? `pr "${pr}" is not a number`
        : !verdict ? 'no verdict' : null;
    if (why) skipped.push({ line, why });
    else verdicts.set(Number(pr), { verdict, head: headColumn ? fields[header.indexOf(headColumn)] : '' });
  }
  return { error: null, verdicts, skipped };
}

// review-scope-ledger.json (job-tracker's review budgets): per PR, what still blocks its merge, the head an
// independent review approved, and the rounds used. Anything else in the file is the coordinator's business.
export function parseReviewScope(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { error: error.message.split('\n')[0], reviews: new Map() };
  }
  const reviews = new Map();
  for (const [key, entry] of Object.entries(json?.prs && typeof json.prs === 'object' ? json.prs : {})) {
    if (!/^\d+$/.test(key) || !entry || typeof entry !== 'object') continue;
    reviews.set(Number(key), {
      blockers: (Array.isArray(entry.mergeBlockers) ? entry.mergeBlockers : []).filter((b) => typeof b === 'string' && b.trim()).map((b) => b.trim()),
      approvedHead: typeof entry.independentApprovedHead === 'string' ? entry.independentApprovedHead : null,
      rounds: Number.isFinite(entry.priorIndependentRoundsUsed) ? entry.priorIndependentRoundsUsed
        : Number.isFinite(entry.ordinaryRoundsUsed) ? entry.ordinaryRoundsUsed : null,
      extra: Number.isFinite(entry.extraReviewAllowance) ? entry.extraReviewAllowance : null,
    });
  }
  return { error: null, reviews };
}

// since is HH:MM today in SGT (yesterday if that is still ahead of now) or an ISO timestamp. undefined = unreadable.
export function parseSince(text, now) {
  if (!text) return null;
  const hm = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (hm) {
    if (Number(hm[1]) > 23 || Number(hm[2]) > 59) return undefined;
    const midnight = Math.floor((now + SGT_MS) / 86_400_000) * 86_400_000 - SGT_MS;
    const at = midnight + (Number(hm[1]) * 60 + Number(hm[2])) * 60_000;
    return at > now ? at - 86_400_000 : at;
  }
  const at = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) ? Date.parse(text) : NaN;
  return Number.isNaN(at) ? undefined : at;
}

function readLaneFile(dir, file, lane) {
  const p = path.join(dir, file);
  try {
    const text = fs.readFileSync(p, 'utf8');
    lane.updatedAt = Math.max(lane.updatedAt ?? 0, fs.statSync(p).mtimeMs);
    return { text };
  } catch (error) {
    return { error: error.code === 'ENOENT' ? 'missing' : error.message.split(',')[0] };
  }
}

function readLane(dir, name, now) {
  const lane = {
    name, priority: Infinity, repo: null, checkout: null, base: 'main', head: null, headRole: null, milestones: new Map(), notes: [],
    metaError: null, units: [], skipped: [], badSince: [], verdicts: new Map(), ledgerSkipped: [], reviews: new Map(), updatedAt: null,
    prs: new Map(), prError: null, prsAt: null,
  };
  const meta = readLaneFile(dir, 'lane.json', lane);
  let json = null;
  try {
    if (meta.error) throw new Error(meta.error);
    json = JSON.parse(meta.text);
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not a JSON object');
  } catch (error) {
    json = null;
    lane.metaError = error.message;
    lane.notes.push(`lane.json: ${error.message}`);
  }
  if (json) {
    if (Number.isFinite(json.priority)) lane.priority = json.priority;
    if (typeof json.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(json.repo) && json.github !== false) lane.repo = json.repo;
    if (typeof json.checkout === 'string') lane.checkout = json.checkout.replace(/^~(?=\/|$)/, os.homedir());
    if (typeof json.base === 'string' && /^[\w][\w./-]*$/.test(json.base)) lane.base = json.base;
    lane.headRole = json.coordinator_thread ? 'coordinator' : json.orchestrator_thread ? 'orchestrator' : null;
    lane.head = json.coordinator_thread || json.orchestrator_thread || null;
    for (const m of Array.isArray(json.milestones) ? json.milestones : []) {
      if (typeof m?.id === 'string' && m.id) lane.milestones.set(m.id, typeof m.title === 'string' ? m.title : '');
    }
  }

  const units = readLaneFile(dir, 'units.tsv', lane);
  lane.unitsError = units.error ?? null;
  if (units.error === 'missing') {
    // D1: job-tracker keeps its old log under state/ until the approved phase 2 move converts it.
    lane.notes.push(fs.existsSync(path.join(dir, 'state/units.tsv')) ? 'legacy layout: state/units.tsv converts in phase 2' : 'no units file');
  } else if (units.error) {
    lane.notes.push(`units.tsv: ${units.error}`);
  } else {
    const parsed = parseUnits(units.text);
    lane.unitsError = parsed.error || (parsed.skipped.length ? `${parsed.skipped.length} row${parsed.skipped.length === 1 ? '' : 's'} skipped` : null);
    if (parsed.error) lane.notes.push(`units.tsv: ${parsed.error}`);
    else if (!parsed.units.length && !parsed.skipped.length) lane.notes.push('no units');
    lane.units = parsed.units;
    lane.skipped = parsed.skipped;
  }
  for (const u of lane.units) {
    u.lane = name;
    u.sinceAt = parseSince(u.since, now);
    if (u.sinceAt === undefined) lane.badSince.push({ line: u.line, why: `since "${u.since}" is not HH:MM or ISO` });
  }

  // The ledger lives at ledger.tsv, or under state/ where job-tracker keeps it (the phase-2 move never happened).
  const ledgerFile = ['ledger.tsv', 'state/ledger.tsv'].find((f) => fs.existsSync(path.join(dir, f))) ?? 'ledger.tsv';
  const ledger = readLaneFile(dir, ledgerFile, lane);
  if (ledger.error === 'missing') {
    if (lane.units.some((u) => /^\d+$/.test(u.pr) && u.state !== 'done')) lane.notes.push('no ledger: no ledger.tsv or state/ledger.tsv, so PRs have no verdict');
  } else if (ledger.error) {
    lane.notes.push(`${ledgerFile}: ${ledger.error}`);
  } else {
    const parsed = parseLedger(ledger.text);
    if (parsed.error) lane.notes.push(`${ledgerFile}: ${parsed.error}`);
    lane.verdicts = parsed.verdicts;
    lane.ledgerSkipped = parsed.skipped;
    lane.ledgerFile = ledgerFile;
  }
  const scopeFile = ['review-scope-ledger.json', 'state/review-scope-ledger.json'].find((f) => fs.existsSync(path.join(dir, f)));
  if (scopeFile) {
    const scope = readLaneFile(dir, scopeFile, lane);
    const parsed = scope.error ? { error: scope.error, reviews: new Map() } : parseReviewScope(scope.text);
    if (parsed.error) lane.notes.push(`${scopeFile}: ${parsed.error}`);
    lane.reviews = parsed.reviews;
  }
  return lane;
}

// Lanes in priority order, a lane without a readable lane.json last. Each unit's after list is resolved across lanes
// (lane/unit), and an edge whose target can reach the unit back is a cycle. A needs-myuser unit is the owner's turn ("you")
// once every unit it waits for is done and its branch has not already landed; until then its lane shows "then you" or
// "stale". lanes is null without a lanes directory.
export function readLanes(dir = LANES, now = Date.now(), prs = cachedPrs) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => !n.startsWith('.') && fs.statSync(path.join(dir, n), { throwIfNoEntry: false })?.isDirectory());
  } catch {
    return { dir, lanes: null };
  }
  const lanes = names.map((n) => readLane(path.join(dir, n), n, now))
    .sort((a, b) => (a.metaError ? 1 : 0) - (b.metaError ? 1 : 0) || a.priority - b.priority || a.name.localeCompare(b.name));
  // GitHub state for every open unit's PR, from the gh cache; a done unit's PR has landed and the ledger says so.
  // Lanes on one repo ask together: the cache is per repo, and two lanes asking apart would evict each other's PRs.
  const asking = new Map(lanes.map((lane) => [lane, lane.repo ? lane.units.filter((u) => u.state !== 'done' && /^\d+$/.test(u.pr)).map((u) => Number(u.pr)) : []]));
  const byRepo = new Map();
  for (const [lane, numbers] of asking) if (numbers.length) byRepo.set(lane.repo, [...new Set([...(byRepo.get(lane.repo) ?? []), ...numbers])]);
  const entries = new Map([...byRepo].map(([repo, numbers]) => [repo, prs(repo, numbers, now)]));
  for (const [lane, numbers] of asking) {
    if (!numbers.length) continue;
    const entry = entries.get(lane.repo);
    lane.prs = entry.prs;
    lane.prError = entry.error;
    lane.prsAt = entry.at;
  }
  const units = lanes.flatMap((lane) => lane.units);
  const byKey = new Map(units.map((u) => [`${u.lane}/${u.id}`, u]));
  for (const u of units) {
    u.deps = u.after.map((name) => ({ name, target: byKey.get(name.includes('/') ? name : `${u.lane}/${name}`) ?? null, cycle: false }));
  }
  const reaches = (from, to, seen) => from === to
    || (!seen.has(from) && seen.add(from) && from.deps.some((d) => d.target && reaches(d.target, to, seen)));
  const reads = new Map();
  for (const lane of lanes) {
    for (const u of lane.units) {
      u.stale = staleReason(lane, u, reads);
      u.github = /^\d+$/.test(u.pr) ? lane.prs.get(Number(u.pr)) ?? null : null;
      u.review = /^\d+$/.test(u.pr) ? lane.reviews.get(Number(u.pr)) ?? null : null;
    }
  }
  for (const u of units) {
    for (const d of u.deps) if (d.target) d.cycle = reaches(d.target, u, new Set());
    const ready = u.deps.every((d) => d.target && !d.cycle && d.target.state === 'done');
    // A needs-myuser row whose branch already landed asks for nothing: it shows as stale, the lane owner's cleanup.
    u.shown = u.state !== 'needs-myuser' ? u.state : u.stale ? 'stale' : ready ? 'you' : 'then you';
    // D3: a unit nests under the first unit it waits for in the same lane and milestone; other edges are written out.
    u.nest = u.deps.find((d) => d.target && !d.cycle && d.target.lane === u.lane && d.target.milestone === u.milestone) ?? null;
    u.parent = u.nest?.target ?? null;
  }
  return { dir, lanes };
}

// ---- PR state from GitHub ----
// One gh GraphQL call per repo and set of PR numbers gives each PR's state, its head, the checks and deployments on
// that head, and its description. The call runs in the background, never on a request: a page shows what the cache
// holds and schedules a refresh when that is older than PR_TTL_MS, so a finished check shows on the page's next
// self-refresh. gh's own credentials are used (the board runs as a launchd agent in the owner's session, where the
// keychain answers); nothing is written to GitHub.

const PR_FIELDS = `number title url isDraft state mergedAt mergeable mergeStateStatus reviewDecision headRefOid headRefName baseRefName
  updatedAt body commits(last: 1) { nodes { commit {
    statusCheckRollup { state contexts(first: 60) { nodes { __typename
      ... on CheckRun { name status conclusion detailsUrl }
      ... on StatusContext { context state targetUrl } } } }
    deployments(last: 5) { nodes { environment latestStatus { state environmentUrl } } } } } }`;

export function prQuery(numbers) {
  const fields = numbers.map((n) => `p${n}: pullRequest(number: ${n}) { ...F }`).join(' ');
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }\nfragment F on PullRequest { ${PR_FIELDS} }`;
}

const CHECK_FAILED = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE', 'ERROR']);

// Only https links from GitHub's answer are rendered; anything else (a javascript: or http: URL in a check's details)
// is dropped rather than put in an href.
const httpsOnly = (url) => (typeof url === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : null);

// One check per name, the newest wins (a rerun lists the cancelled run and the new one under the same name).
function checksOf(rollup) {
  const byName = new Map();
  for (const c of rollup?.contexts?.nodes ?? []) {
    const name = c.name ?? c.context ?? '';
    if (!name) continue;
    const verdict = c.__typename === 'CheckRun' ? (c.status === 'COMPLETED' ? c.conclusion : 'PENDING') : c.state;
    const result = verdict === 'SUCCESS' || verdict === 'NEUTRAL' ? 'pass' : verdict === 'SKIPPED' ? 'skip'
      : CHECK_FAILED.has(verdict) ? 'fail' : 'pending';
    byName.delete(name);
    byName.set(name, { name, result, url: httpsOnly(c.detailsUrl ?? c.targetUrl) });
  }
  return [...byName.values()];
}

// One sentence on what the PR does: the first sentence of its Solution section (the PR template's), or without one
// the first prose line that is not boilerplate (an issue or stacking line). Shown whole, never cut: the row wraps.
// Reads the markdown body: gh's bodyText is the body rendered to text, where "## Solution" arrives as "Solution".
const BOILERPLATE = /^(?:closes?|fixes|fixed|resolves?|part of|stacked on|stacks on|depends on|based on|follows|merge .* first)\b/i;
export function summaryOf(body) {
  const lines = (body ?? '').split('\n').map((l) => l.replace(/\r$/, ''));
  const heading = lines.findIndex((l) => /^#{1,6}\s*solution\b/i.test(l));
  const next = heading >= 0 ? lines.findIndex((l, i) => i > heading && /^#{1,6}\s/.test(l)) : -1;
  const section = heading >= 0 ? lines.slice(heading + 1, next >= 0 ? next : undefined) : lines;
  const prose = section.map((l) => l.replace(/^[\s#*>-]+/, '').trim()).filter((l) => l && /[a-z]/i.test(l) && !BOILERPLATE.test(l) && !/[:：]$/.test(l));
  const line = prose.find((l) => l.length >= 30) ?? prose[0] ?? null;
  if (!line) return null;
  return /^(.{20,}?[.!?])(\s|$)/.exec(line)?.[1] ?? line;
}

// What a PR is right now, and what stands between it and a merge: draft, open, ready, blocked (with why), merged or
// closed. Blocked means GitHub would not merge it as it is; "behind" and running checks are states, not blockers.
// A draft is not up for review, so its blockers are only the author's work: conflicts and failing checks.
export function prView(node) {
  const commit = node.commits?.nodes?.[0]?.commit ?? null;
  const checks = checksOf(commit?.statusCheckRollup);
  const failing = checks.filter((c) => c.result === 'fail');
  const pending = checks.filter((c) => c.result === 'pending');
  const blockers = [];
  if (node.mergeable === 'CONFLICTING') blockers.push(`conflicts with ${node.baseRefName ?? 'the base'}`);
  if (failing.length) blockers.push(`${failing.length} check${failing.length === 1 ? '' : 's'} failing: ${failing.map((c) => c.name).join(', ')}`);
  if (!node.isDraft) {
    if (node.reviewDecision === 'CHANGES_REQUESTED') blockers.push('changes requested');
    else if (node.reviewDecision === 'REVIEW_REQUIRED' && node.mergeStateStatus === 'BLOCKED') blockers.push('review required');
    if (!blockers.length && node.mergeStateStatus === 'BLOCKED' && !pending.length) blockers.push('a required check or review is missing');
  }
  const state = node.state === 'MERGED' ? 'merged' : node.state === 'CLOSED' ? 'closed' : node.isDraft ? 'draft'
    : blockers.length ? 'blocked' : node.mergeStateStatus === 'CLEAN' || node.mergeStateStatus === 'HAS_HOOKS' ? 'ready' : 'open';
  const deploy = (commit?.deployments?.nodes ?? []).findLast((d) => httpsOnly(d.latestStatus?.environmentUrl));
  return {
    number: node.number,
    title: node.title ?? '',
    url: httpsOnly(node.url),
    state,
    blockers,
    head: (node.headRefOid ?? '').slice(0, 7),
    branch: node.headRefName ?? null,
    base: node.baseRefName ?? null,
    behind: node.mergeStateStatus === 'BEHIND',
    checks,
    checksPending: pending.length,
    preview: deploy ? { url: deploy.latestStatus.environmentUrl, state: (deploy.latestStatus.state ?? '').toLowerCase(), environment: deploy.environment } : null,
    summary: summaryOf(node.body),
    mergedAt: node.mergedAt ? Date.parse(node.mergedAt) : null,
    updatedAt: node.updatedAt ? Date.parse(node.updatedAt) : null,
  };
}

// gh's JSON for prQuery -> number -> prView. A PR gh could not return (deleted, or an error on that alias) is absent;
// partial says whether GraphQL reported errors beside the data, so an absent PR may be a failed alias, not a gone PR.
export function parsePrs(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: 'gh returned no JSON', prs: new Map(), partial: false };
  }
  const prs = new Map();
  for (const node of Object.values(json?.data?.repository ?? {})) if (node?.number) prs.set(node.number, prView(node));
  const error = !json?.data?.repository && json?.errors?.[0]?.message ? json.errors[0].message
    : !json?.data?.repository ? 'gh returned no repository' : null;
  return { error, prs, partial: Array.isArray(json?.errors) && json.errors.length > 0 };
}

// Runs gh for one repo and PR set and resolves with what parsePrs made of it. Exported for the tests, which point gh
// at a stub.
export function fetchPrs(repo, numbers, { gh = GH, timeout = 20_000 } = {}) {
  const [owner, name] = repo.split('/');
  return new Promise((resolve) => {
    // -f sends every field as a string; -F would turn a numeric-looking owner or repo name into a number.
    const run = spawn(gh, ['api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `query=${prQuery(numbers)}`],
      { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'], timeout });
    let out = '';
    let err = '';
    run.stdout.setEncoding('utf8'); // a multibyte character split across two chunks decodes whole
    run.stderr.setEncoding('utf8');
    run.stdout.on('data', (chunk) => { out += chunk; });
    run.stderr.on('data', (chunk) => { err += chunk; });
    run.on('error', (error) => resolve({ error: `cannot run gh: ${error.message}`, prs: new Map(), partial: false }));
    run.on('close', (code, signal) => {
      // gh exits 1 on a partial GraphQL answer but still prints the data, so the output decides.
      const parsed = parsePrs(out);
      if (parsed.prs.size || !code) resolve(parsed);
      else resolve({ error: `gh ${signal ? `timed out (${signal})` : `exited ${code}`}: ${(err.trim().split('\n').pop() || parsed.error || '').slice(0, 200)}`, prs: new Map(), partial: false });
    });
  });
}

// One entry per repo: prs is number -> prView, asked the numbers of its last fetch, at when that fetch answered. Each
// PR keeps its last good value through an outage or a partial answer; a PR gh answers without is gone and leaves; a
// PR no unit asks for any more is evicted. So a unit added or finished never blanks the others' state for a cycle.
const prCache = new Map();
const prLogged = new Map(); // repo -> { message, at }: a broken gh is logged once per message per ten minutes
const PR_LOG_MS = 10 * 60_000;

function logPrError(repo, message, now = Date.now()) {
  const last = prLogged.get(repo);
  if (last && last.message === message && now - last.at < PR_LOG_MS) return;
  prLogged.set(repo, { message, at: now });
  console.error(`agent-board: GitHub PRs for ${repo}: ${message}`);
}

export async function refreshPrs(repo, numbers, options = {}) {
  const entry = prCache.get(repo) ?? { prs: new Map(), asked: new Set(), error: null, at: null, refreshing: null };
  prCache.set(repo, entry);
  if (!entry.refreshing) {
    const wanted = new Set(numbers);
    entry.refreshing = fetchPrs(repo, [...wanted], options).then((result) => {
      for (const n of wanted) {
        if (result.prs.has(n)) entry.prs.set(n, result.prs.get(n));
        else if (!result.error && !result.partial) entry.prs.delete(n);
      }
      for (const n of entry.prs.keys()) if (!wanted.has(n)) entry.prs.delete(n);
      entry.asked = wanted;
      entry.error = result.error;
      entry.at = Date.now();
      entry.refreshing = null;
      if (result.error) logPrError(repo, result.error);
    });
  }
  await entry.refreshing;
  return entry;
}

// What the cache holds for these PRs now, scheduling a refresh when it is stale or has never asked for one of them.
// options reach gh (the tests point it at a stub).
export function cachedPrs(repo, numbers, now = Date.now(), options = {}) {
  const entry = prCache.get(repo);
  const unasked = numbers.some((n) => !entry?.asked.has(n));
  if (!entry || (!entry.refreshing && (unasked || now - entry.at >= PR_TTL_MS))) refreshPrs(repo, numbers, options);
  const current = prCache.get(repo);
  return { prs: current.prs, error: current.at === null ? 'loading PR state from GitHub' : current.error, at: current.at };
}

// ---- Stale needs-myuser rows ----
// A needs-myuser row whose branch has already landed asks the owner for work that is done; on 16 Oct two such rows misled
// the orchestrator. The map keeps the row and its state, adds a yellow "looks stale" line saying why, and leaves the
// fix to the lane owner. It reads git in lane.json's checkout, against origin/<base> (what was pushed; <base> when
// there is no origin), with read-only local commands and never GitHub. A row is stale when:
//   - its PR number ends a commit subject on the base, as GitHub's squash and merge commits do (the branch may be gone);
//   - its branch tip is an ancestor of the base (merged);
//   - git cherry finds every commit of the branch on the base under another id (rebased, or a one-commit squash).
// Never flagged: a row whose pr is a word other than push (rebuild, docs), which names something still the owner's to do
// after the branch lands; a branch still at the commit it was created from, an ancestor only because it has no work
// yet, which only a local branch's reflog can tell from a merge; and anything git cannot resolve, logged once. git merge-tree would also catch a squash merge with no PR number, but it writes objects
// into the repo. Answers are cached per base and branch commit, so a refresh costs one for-each-ref per repo.
// launchd gives the board no PATH beyond /usr/bin, so git is Apple's, which Homebrew already requires.

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
const gitCache = new Map(); // checkout:base ref -> { baseSha, prs, tips: Map(ref@sha -> stale) }; reset when the base moves
const loggedSkips = new Set(); // cleared past 500 lines, so a long-running board relogs rather than grows

function git(dir, args) {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 5000, env: GIT_ENV, maxBuffer: 64 << 20 });
}

// Every local branch and origin branch, ref name -> commit, read once per request per checkout.
function readRefs(checkout) {
  const run = git(checkout, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes/origin']);
  if (run.status !== 0) return { error: `git cannot read ${tilde(checkout)}: ${(run.stderr || run.error?.message || '').trim().split('\n')[0]}` };
  return { refs: new Map(run.stdout.split('\n').filter(Boolean).map((l) => l.split(' ').reverse())) };
}

function staleReason(lane, u, reads) {
  const pr = /^\d+$/.test(u.pr) ? Number(u.pr) : null;
  if (u.state !== 'needs-myuser' || (u.pr && pr === null && u.pr !== 'push') || (!u.branch && pr === null)) return null;
  const skip = (why) => {
    const line = `agent-board: cannot check ${lane.name}/${u.id} for a stale row: ${why}`;
    if (loggedSkips.size > 500) loggedSkips.clear();
    if (!loggedSkips.has(line)) console.error(line);
    loggedSkips.add(line);
    return null;
  };
  if (!lane.checkout) return skip('lane.json has no checkout');
  if (!path.isAbsolute(lane.checkout)) return skip(`checkout ${lane.checkout} is not an absolute or ~/ path`);
  if (!reads.has(lane.checkout)) reads.set(lane.checkout, readRefs(lane.checkout));
  const { refs, error } = reads.get(lane.checkout);
  if (error) return skip(error);
  const baseRef = [`refs/remotes/origin/${lane.base}`, `refs/heads/${lane.base}`].find((r) => refs.has(r));
  if (!baseRef) return skip(`${tilde(lane.checkout)} has no ${lane.base} branch`);
  const repo = { checkout: lane.checkout, base: baseRef.replace(/^refs\/(?:remotes|heads)\//, ''), name: lane.base };
  const at = `${lane.checkout}:${baseRef}`;
  if (gitCache.get(at)?.baseSha !== refs.get(baseRef)) gitCache.set(at, { baseSha: refs.get(baseRef), prs: null, tips: new Map() });
  const cache = gitCache.get(at);
  repo.baseSha = cache.baseSha;

  if (pr !== null) {
    cache.prs ??= mergedPrs(repo);
    if (cache.prs.has(pr)) return { text: `PR #${pr} merged`, title: `${repo.base} has the squash or merge commit of #${pr}` };
  }
  if (!u.branch || u.branch === repo.name || u.branch === repo.base) return null;
  const ref = [`refs/heads/${u.branch}`, `refs/remotes/origin/${u.branch}`].find((r) => refs.has(r));
  if (!ref) return skip(`${tilde(lane.checkout)} has no branch ${u.branch}`);
  const key = `${ref}@${refs.get(ref)}`;
  if (!cache.tips.has(key)) cache.tips.set(key, branchLanded(repo, u.branch, ref, refs.get(ref), skip));
  return cache.tips.get(key);
}

// PR numbers merged into the base, from GitHub's subjects: "title (#12)" for a squash, "Merge pull request #12 from".
function mergedPrs({ checkout, baseSha }) {
  const run = git(checkout, ['log', '--format=%s', baseSha]);
  const prs = new Set();
  for (const s of run.status === 0 ? run.stdout.split('\n') : []) {
    const match = /\(#(\d+)\)$/.exec(s) ?? /^Merge pull request #(\d+) /.exec(s);
    if (match) prs.add(Number(match[1]));
  }
  return prs;
}

function branchLanded({ checkout, base, name, baseSha }, branch, ref, tip, skip) {
  const landed = (how) => ({ text: `branch already on ${name}`, title: how });
  const ancestor = git(checkout, ['merge-base', '--is-ancestor', tip, baseSha]);
  if (ancestor.status === 0) {
    // A merged branch or one with no commits yet. The oldest reflog entry of a local branch is its creation, and a tip
    // still there has no commits of its own; an origin-only branch has no such record, so it is not flagged.
    if (!ref.startsWith('refs/heads/')) return skip(`${branch} is only on origin and its tip is on ${base}, which an empty branch also is`);
    const reflog = git(checkout, ['log', '-g', '--format=%H %gs', ref]).stdout?.trim();
    if (!reflog) return skip(`${branch} has no reflog to tell a merge from an empty branch`);
    if (reflog.split('\n').pop().startsWith(`${tip} branch: Created from`)) return null;
    return landed(`${branch} is merged into ${base}`);
  }
  if (ancestor.status !== 1) return skip(`git merge-base failed on ${branch}`);
  const cherry = git(checkout, ['cherry', baseSha, tip]);
  if (cherry.status !== 0) return skip(`git cherry failed on ${branch}`);
  const lines = cherry.stdout.split('\n').filter(Boolean);
  if (!lines.length || lines.some((l) => !l.startsWith('- '))) return null;
  return landed(`every commit on ${branch} is on ${base} under another id, as after a rebase`);
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
    label = t.quiet ? `no activity ${since}` : [t.tool ?? 'running', since].filter(Boolean).join(' ');
    tone = t.quiet ? 'red' : 'green';
  } else {
    label = `${RUN_LABELS[t.run] ?? 'new'}${t.lastActivityAt ? ` ${ago(now - t.lastActivityAt)} ago` : ''}`;
    tone = t.run === 'failed' ? 'red' : 'muted';
  }
  const context = t.contextUsed === null ? null
    : t.contextMax ? `${tokens(t.contextUsed)} / ${tokens(t.contextMax)}` : tokens(t.contextUsed);
  const meta = [context, modelName(t.model), t.project, t.branch].filter(Boolean).map(escape).join(' · ');
  const share = t.contextUsed !== null && t.contextMax ? Math.min(1, t.contextUsed / t.contextMax) : null;
  // Context bands follow the pause-safely rule: past 200k pause at the next boundary, past 230k now.
  const band = t.contextUsed >= 230_000 ? 'hot' : t.contextUsed >= 200_000 ? 'warn' : '';
  const bar = share !== null && t.state !== 'idle'
    ? `<div class="ctx"><i class="${band}" style="width:${(share * 100).toFixed(1)}%"></i></div>` : '';
  return `<div class="t ${t.state}"><div class="name">${escape(t.title)}</div>`
    + (t.parentTitle ? `<div class="sub">↳ ${escape(t.parentTitle)}</div>` : '')
    + `<div class="sub"><span class="state ${tone}">${escape(label)}</span>${meta ? ` · ${meta}` : ''}</div>${bar}</div>`;
}

// What T3 no longer gives the board, above everything it does: Needs you may be short while approvals are unavailable,
// so a gap counts as one item for the owner, as an updater alarm does.
const t3Gaps = (snap) => (snap.t3.unavailable.length ? 1 : 0);
function t3Section(snap) {
  if (!t3Gaps(snap)) return '';
  return '<h2 class="attn">T3 state</h2><div class="t needs"><div class="name">Part of T3 state is unavailable</div>'
    + snap.t3.unavailable.map((line) => `<div class="line red">${escape(line)}</div>`).join('')
    + '<div class="line">If T3 just updated, its database schema may have changed; update files/bin/agent-board.mjs.</div></div>';
}

// Alarms go above the threads with the needs-you colours; a healthy updater is one quiet card below them.
function updatesSection(u) {
  const lines = [...u.alarms.map((t) => ['red', t]), ...u.infos.map((t) => ['', t]), ...u.oks.map((t) => ['muted', t])];
  // No count in the heading: every other heading counts cards, and this section is one card.
  return `<h2 class="${u.alarms.length ? 'attn' : ''}">Auto-update</h2>`
    + `<div class="t${u.alarms.length ? ' needs' : ''}"><div class="name">dotfiles auto-update</div>`
    + lines.map(([tone, text]) => `<div class="line ${tone}">${escape(text)}</div>`).join('') + '</div>';
}

const SGT = (options) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', ...options });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; // en-GB says "Sept"

// 14:05 today, 9 Oct 14:05 any day before: one form for every past day, so two dates side by side compare at a glance.
// A date from about a year back carries its year, 9 Oct 2025 14:05, so it never passes for this October.
function when(at, now) {
  const day = (ms) => Math.floor((ms + SGT_MS) / 86_400_000);
  const hm = SGT({ hour: '2-digit', minute: '2-digit' }).format(at);
  if (day(at) === day(now)) return hm;
  const p = Object.fromEntries(SGT({ day: 'numeric', month: 'numeric', year: 'numeric' }).formatToParts(at).map((x) => [x.type, x.value]));
  return `${Number(p.day)} ${MONTHS[p.month - 1]}${day(now) - day(at) > 300 ? ` ${p.year}` : ''} ${hm}`;
}

const tone = (cls, text) => `<span class="${cls}">${escape(text)}</span>`;
// A date with the word before it, "since 9 Oct 14:05", kept on one line: a phone never leaves "since" or "14:05" alone.
// Ordinary spaces, so a copied date still matches a search for "9 Oct".
const stamp = (word, at, now) => tone('kept', `${word} ${when(at, now)}`);

// Both pages share the header, so threads and map are one tap apart. The clock stays on a phone too: it is how
// the owner sees that the page is current.
function pageHeader(page, now) {
  const link = (name, href) => (name === page ? `<u>${name}</u>` : `<a href="${href}">${name}</a>`);
  return `<header><h1><span>agent board ·</span> ${link('threads', '/')} · ${link('map', '/map')}</h1>`
    + `<small><span class="clock">${SGT({ hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(now)} SGT</span> · `
    + `refreshes every ${REFRESH_S}s</small></header>`;
}

function page(title, attention, body, wide = false) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="${REFRESH_S}">
<title>${attention ? `(${attention}) ` : ''}${title}</title><style>${STYLE}</style></head><body><main${wide ? ' class="wide"' : ''}>
${body}</main></body></html>`;
}

// Needs you, on both pages: pending T3 input cards and approvals, plus every lane unit that is the owner's turn. A unit
// whose owner thread is itself waiting on him takes that thread's place, so nothing is listed twice. Oldest first.
// Only his actions are listed: a done unit asks for nothing, a stale row is the lane owner's cleanup, and a review
// ledger blocker counts only when he is its subject (ownerActs), once per PR however many units share the PR.
function needsYou(snap) {
  const lanes = snap.lanes?.lanes ?? [];
  const open = lanes.flatMap((lane) => lane.units.filter((u) => u.state !== 'done'));
  const units = open.filter((u) => u.shown === 'you');
  const owned = new Set(units.map((u) => u.owner));
  const prs = new Set(units.filter((u) => /^\d+$/.test(u.pr)).map((u) => `${u.lane}#${u.pr}`));
  const blocked = [];
  for (const u of open) {
    const acts = u.review?.blockers.filter(ownerActs) ?? [];
    if (u.shown === 'you' || !acts.length || prs.has(`${u.lane}#${u.pr}`)) continue;
    prs.add(`${u.lane}#${u.pr}`);
    blocked.push({ unit: u, blocker: acts.join('; '), at: u.github?.updatedAt ?? u.sinceAt ?? null });
  }
  const items = [
    ...units.map((u) => {
      const ask = snap.needs.find((t) => t.id === u.owner);
      return { unit: u, thread: ask, at: ask?.askedAt ?? u.sinceAt ?? null };
    }),
    ...snap.needs.filter((t) => !owned.has(t.id)).map((t) => ({ thread: t, at: t.askedAt })),
    ...blocked,
  ];
  return items.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
}

// The owner is whoever runs the board (AGENT_BOARD_OWNER names them for a fixture). A blocker is their action when it
// names them as its subject ("the owner picks the batch") or says it needs or waits for them; one that only mentions them
// ("rebase after the owner's PR lands") is someone else's work. Matched as a whole word in any case.
const ownerActs = (text) => {
  const owner = (process.env.AGENT_BOARD_OWNER ?? os.userInfo().username).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\W*${owner}\\b|\\b(?:needs?|waits? (?:for|on)|asks?|blocked on) ${owner}\\b`, 'i').test(text);
};

// Where the owner acts on a unit's PR: the PR itself, and its preview when the head has one.
function actLinks(u, lane) {
  if (!/^\d+$/.test(u.pr)) return [];
  const links = [prChip(u, lane)];
  if (u.github?.preview) links.push(`<a class="link" href="${escape(u.github.preview.url)}" rel="noreferrer">preview ↗</a>`);
  return links;
}

// What a waiting unit's line says about the wait: its owner's input card if it has one, else how long it has waited.
// HTML: the date phrase is kept whole.
function unitWait(item, now) {
  if (item.thread) return `${escape(item.thread.ask)}${item.thread.askedAt ? ` · ${stamp('asked', item.thread.askedAt, now)}` : ''}`;
  return item.unit.sinceAt ? stamp('since', item.unit.sinceAt, now) : null;
}

function unitCard(item, snap) {
  const u = item.unit;
  const meta = [...[u.lane, item.blocker ?? u.note, item.thread?.title].filter(Boolean).map(escape), unitWait(item, snap.now)].filter(Boolean);
  const lane = snap.lanes.lanes.find((l) => l.name === u.lane);
  return `<div class="t needs"><div class="name">${escape(u.id)}</div><div class="sub"><span class="state peach">you</span> · ${[...meta, ...actLinks(u, lane)].join(' · ')}</div></div>`;
}

// The row and its state stay as written; the lane owner fixes the file (see staleReason).
const staleLine = (u) => (u.stale ? `<div class="stale" title="${escape(u.stale.title)}">looks stale: ${escape(u.stale.text)} · lane owner&#39;s cleanup</div>` : '');

export function render(snap) {
  const section = (title, list, cls = '', limit = Infinity) => (list.length
    ? `<h2 class="${cls}">${title} · ${list.length}</h2>${list.slice(0, limit).map((t) => card(t, snap.now)).join('')}`
      + (list.length > limit ? `<p class="more">+${list.length - limit} more</p>` : '')
    : '');
  const needs = needsYou(snap);
  const threads = (needs.length ? `<h2 class="attn">Needs you · ${needs.length}</h2>`
      + needs.map((item) => (item.unit ? unitCard(item, snap) : card(item.thread, snap.now))).join('') : '')
    + section('Running', snap.running) + section('Idle', snap.idle, '', IDLE_SHOWN);
  const alarmed = snap.updates.alarms.length > 0;
  const updates = updatesSection(snap.updates);
  const none = snap.t3.threads ? '<p class="more">No open T3 threads.</p>' : '';
  return page('agent board', needs.length + (alarmed ? 1 : 0) + t3Gaps(snap), `${pageHeader('threads', snap.now)}
${alarmed ? updates : ''}${t3Section(snap)}${threads || none}${alarmed ? '' : updates}
<footer>Read-only view of T3 state. Nothing here can change an agent.</footer>`);
}

// ---- /map ----

// The map's flags each say what they measured, so none reads like the row state "stale" (a landed needs-myuser row).
const STALL_MS = 8 * 3600_000; // review rule, 10 Oct: a unit in flight over 8 hours turns yellow, "in flight 2 d, since <date>"
const STALE_MS = 2 * 3600_000; // a running coordinator with no lane file change for this long: "no update for 3 h"
const LANE_STALE_MS = 24 * 3600_000; // no lane file change for a day: "no update since <date>" whoever runs it
const SHOWN = { queued: 'grey', 'in-flight': 'green', you: 'peach', 'then you': 'peach', stale: 'yellow', paused: 'yellow', done: 'grey' };
const PR_TONE = { merged: 'grey', closed: 'grey', draft: 'overlay', open: 'subtext', ready: 'green', blocked: 'red' };
const mapId = (kind, ...parts) => `${kind}-${parts.map(encodeURIComponent).join('/')}`;
const jumpTo = (id) => `#${encodeURIComponent(id)}`;
const milestoneGroups = (lane) => [...Map.groupBy(lane.units, (u) => u.milestone)]
  .sort(([a], [b]) => !a ? 1 : !b ? -1 : a.localeCompare(b, 'en', { numeric: true }));
const isStalled = (u, now) => u.state === 'in-flight' && Number.isFinite(u.sinceAt) && now - u.sinceAt > STALL_MS;
const landedAt = (u) => u.github?.mergedAt ?? u.sinceAt;
const isRecentDone = (u, now) => u.state === 'done' && Number.isFinite(landedAt(u))
  && landedAt(u) <= now && now - landedAt(u) < 24 * 3600_000;
const liveGroups = (units) => ['needs-myuser', 'in-flight', 'paused', 'queued'].map((state) => units.filter((u) => u.state === state));
const childrenOf = (units, parent) => units.filter((u) => (units.includes(u.parent) ? u.parent : null) === parent);
const treeOrder = (units, parent = null) => childrenOf(units, parent).flatMap((u) => [u, ...treeOrder(units, u)]);

const tilde = (p) => (p.startsWith(`${os.homedir()}/`) ? `~${p.slice(os.homedir().length)}` : p);

// A thread's live state as the map shows it: what it is doing now, or how long it has been quiet.
function live(t, now, brief = false) {
  if (t.state === 'needs') return tone('peach', t.ask);
  const quiet = t.lastActivityAt ? ago(now - t.lastActivityAt) : '';
  if (t.state === 'running') {
    if (t.quiet) return tone('red', `no activity ${quiet}`);
    return tone('green', brief || !t.tool ? `running${brief || !quiet ? '' : ` ${quiet}`}` : `${t.tool} ${quiet}`);
  }
  return tone('grey', `idle${quiet ? ` ${quiet}` : ''}`);
}

function ownerLine(u, snap) {
  if (!u.owner) return u.state === 'needs-myuser' ? [] : ['unassigned'];
  const t = snap.threads.get(u.owner);
  if (t) return [escape(t.title), live(t, snap.now)];
  if (!snap.t3.threads && THREAD_ID.test(u.owner)) return [tone('yellow', 'owner state unavailable')];
  // A settled, archived or deleted owner reads the same as a wrong id: nobody holds the unit.
  return THREAD_ID.test(u.owner) ? [tone('peach', 'no owner thread')] : [escape(u.owner)];
}

function sinceLine(u, now) {
  if (u.sinceAt === undefined) return tone('yellow', `since "${u.since}" unreadable`);
  if (!u.sinceAt || !['in-flight', 'needs-myuser'].includes(u.state)) return null;
  // Two phrases, each kept whole: a phone may break between them but never inside "in flight 2 d".
  if (u.state !== 'needs-myuser' && now - u.sinceAt > STALL_MS) return `<span class="yellow">${tone('kept', `in flight ${ago(now - u.sinceAt)}`)}, ${stamp('since', u.sinceAt, now)}</span>`;
  return stamp('since', u.sinceAt, now);
}

// The chip at the row's right: the PR number, linked, with its GitHub state when the board has it, else the ledger's
// verdict; a word such as push or rebuild names what the owner still does after the branch lands.
function prChip(u, lane) {
  if (!/^\d+$/.test(u.pr)) return escape(u.pr || (u.state === 'done' ? '' : 'no PR'));
  const verdict = lane.verdicts.get(Number(u.pr))?.verdict;
  const g = u.github;
  // A done unit's PR has landed: its number, with the ledger's word when there is one, says enough.
  const word = g ? tone(PR_TONE[g.state], g.state) : verdict ? escape(verdict) : u.state === 'done' ? '' : escape(lane.prError ? 'state unknown' : 'no verdict');
  const text = `<b>#${u.pr}</b>${word ? ` ${word}` : ''}`;
  const href = g?.url ?? (lane.repo ? `https://github.com/${lane.repo}/pull/${u.pr}` : null);
  return href ? `<a href="${escape(href)}" rel="noreferrer">${text}</a>` : `<span>${text}</span>`;
}

// What the ledger's newest verdict means against the PR's current head.
function verdictLine(u, lane) {
  const entry = lane.verdicts.get(Number(u.pr));
  if (!entry) return null;
  const head = u.github?.head;
  const onHead = head && entry.head && (head.startsWith(entry.head) || entry.head.startsWith(head));
  const where = !head || !entry.head ? '' : onHead ? ' on this head' : ` on an older head ${escape(entry.head.slice(0, 7))}`;
  return `verdict ${escape(entry.verdict)}${where}`;
}

// The PR block under a unit: one status line (what blocks it or what runs, the head, the preview, the ledger's
// verdict), a review-ledger blocker that is the owner's own action, then the check list and the rest of the review budget
// folded under a summary that counts them. Plain <details>: no script runs on this page (the CSP forbids it).
function prBlock(u, lane, now) {
  const g = u.github;
  const r = u.review;
  if (!g && !r) return '';
  const lines = [];
  if (g) {
    const facts = [];
    if (g.blockers.length && (g.state === 'blocked' || g.state === 'draft')) facts.push(tone('red', `blocked on: ${g.blockers.join('; ')}`));
    else if (g.state === 'merged') facts.push(g.mergedAt ? stamp('merged', g.mergedAt, now) : 'merged');
    else if (g.checksPending) facts.push(tone('yellow', `${g.checksPending} check${g.checksPending === 1 ? '' : 's'} running`));
    if (g.behind && g.state !== 'merged') facts.push(`behind ${escape(g.base)}`);
    facts.push(`head <code>${escape(g.head)}</code>`);
    if (g.preview) {
      const live = g.preview.state === 'success';
      facts.push(`<a class="link" href="${escape(g.preview.url)}" rel="noreferrer">preview ↗</a>${live ? '' : tone('yellow', ` ${g.preview.state || 'not ready'}`)}`);
    } else if (g.state !== 'merged') facts.push(tone('overlay', 'no preview'));
    const verdict = verdictLine(u, lane);
    if (verdict) facts.push(verdict);
    lines.push(`<div class="meta">${facts.join(' · ')}</div>`);
  }
  const mine = r?.blockers.filter(ownerActs) ?? [];
  if (mine.length) lines.push(`<div class="meta peach">review ledger: ${escape(mine.join('; '))}</div>`);
  const folded = [];
  if (g?.checks.length) {
    const chips = g.checks.map((c) => {
      const chip = `<i class="dot ${c.result}"></i>${escape(c.name)}`;
      return c.url ? `<a class="check" href="${escape(c.url)}" rel="noreferrer" title="${c.result}">${chip}</a>` : `<span class="check" title="${c.result}">${chip}</span>`;
    });
    folded.push(`<div class="checks">${chips.join('')}</div>`);
  }
  const review = [];
  const rest = r?.blockers.filter((b) => !ownerActs(b)) ?? [];
  if (rest.length) review.push(`review ledger: ${escape(rest.join('; '))}`);
  if (r?.approvedHead) {
    const current = g?.head && r.approvedHead.startsWith(g.head);
    review.push(current ? tone('green', 'approved at this head') : `approved at ${escape(r.approvedHead.slice(0, 7))}${g ? ', not the current head' : ''}`);
  }
  if (r && r.rounds !== null) review.push(`${r.rounds} review round${r.rounds === 1 ? '' : 's'}${r.extra ? `, ${r.extra} extra allowed` : ''}`);
  if (review.length) folded.push(`<div class="meta">${review.join(' · ')}</div>`);
  if (folded.length) {
    const passed = g?.checks.filter((c) => c.result === 'pass').length ?? 0;
    const label = [g?.checks.length ? `<span class="count">${passed}/${g.checks.length} checks</span>` : '', review.length ? 'review ledger' : ''].filter(Boolean).join(' · ');
    lines.push(`<details class="more"><summary>${label}</summary>${folded.join('')}</details>`);
  }
  return `<div class="pr-block">${lines.join('')}</div>`;
}

function depLine(d) {
  if (!d.target) return tone('yellow', `? ${d.name}`);
  if (d.cycle) return tone('yellow', `${d.name} (cycle)`);
  return `<b>${escape(d.name)}</b>${d.target.state === 'needs-myuser' ? ' (then you)' : ''}`;
}

// A unit row: state and id with the PR chip; the PR's title as the headline and one sentence from its description;
// who holds it, its branch and since; the note in full; the PR block; the stale flag; what it waits for. Nothing is
// clipped: every line wraps, on the phone and the desktop alike.
function unitRow(u, lane, snap, nest = u.nest, next = false) {
  const cls = u.shown === 'you' ? ' needs' : u.state === 'done' ? ' done' : u.github?.state === 'blocked' ? ' blocked' : '';
  let html = `<div class="u${cls}" id="${escape(mapId('unit', lane.name, u.id))}"><div class="row"><span class="id"><span class="state ${SHOWN[u.shown]}">${u.shown}</span>`
    + `${escape(u.id)}</span>${next ? '<span class="next">next up</span>' : ''}<span class="pr">${prChip(u, lane)}</span></div>`;
  if (isRecentDone(u, snap.now)) html += `<div class="sub">${stamp('landed', landedAt(u), snap.now)}</div>`;
  if (u.state !== 'done') {
    const g = u.github;
    if (g?.title) html += `<div class="title">${escape(g.title)}</div>`;
    if (g?.summary && g.summary !== g.title) html += `<div class="summary">${escape(g.summary)}</div>`;
    const sub = [...ownerLine(u, snap), u.branch && escape(u.branch), sinceLine(u, snap.now)].filter(Boolean);
    if (sub.length) html += `<div class="sub">${sub.join(' · ')}</div>`;
    if (u.note) html += `<div class="unit-note">${escape(u.note)}</div>`;
    html += prBlock(u, lane, snap.now);
    html += staleLine(u);
    const deps = u.deps.filter((d) => d !== nest);
    if (deps.length) html += `<div class="after">${nest ? 'also after' : 'after'} ${deps.map(depLine).join(', ')}</div>`;
  }
  return `${html}</div>`;
}

// A row the board could not read, beside the lane where its unit would be, so a lane never silently loses rows.
function warningRow(skipped) {
  return `<div class="u warn"><div class="row"><span class="id"><span class="state yellow">unreadable</span>units.tsv line ${skipped.line}</span>`
    + `${skipped.id ? `<span class="pr">${escape(skipped.id)}</span>` : ''}</div><div class="sub yellow">${escape(skipped.why)}`
    + `${skipped.why.startsWith('unknown state') ? `; states are ${UNIT_STATES.join(', ')}` : ''}</div></div>`;
}

// Preserve nesting within a state group; a dependency in another group is written as an after line.
function unitTree(units, lane, snap, next = null, parent = null) {
  return childrenOf(units, parent).map((u) => {
    const kids = unitTree(units, lane, snap, next, u);
    return unitRow(u, lane, snap, units.includes(u.parent) ? u.nest : null, u === next) + (kids ? `<div class="kids">${kids}</div>` : '');
  }).join('');
}

function milestoneRows(id, units, lane, snap, params) {
  const next = units.find((u) => u.state === 'queued' && u.deps.every((d) => d.target?.state === 'done' && !d.cycle));
  const live = liveGroups(units).map((group) => unitTree(group, lane, snap, next)).join('');
  const recent = units.filter((u) => isRecentDone(u, snap.now));
  const closed = units.filter((u) => u.state === 'done' && !recent.includes(u));
  if (!closed.length) return live + unitTree(recent, lane, snap);
  const key = `${lane.name}/${id}`;
  const open = params.getAll('done').includes(key);
  const toggled = new URLSearchParams(params);
  toggled.delete('done', key);
  if (!open) toggled.append('done', key);
  const href = `?${toggled}${jumpTo(mapId('milestone', lane.name, id))}`;
  return live + unitTree(recent, lane, snap)
    + `<div class="done-group"><a href="${escape(href)}" aria-expanded="${open}">${closed.length} done${open ? ' · hide' : ''}</a></div>`
    + (open ? unitTree(closed, lane, snap) : '');
}

function milestoneHead(id, units, lane) {
  const title = id ? [id, lane.milestones.get(id)].filter(Boolean).join(' ') : 'No milestone';
  const done = units.filter((u) => u.state === 'done').length;
  // The bar fills with done only, so it reads as the count beside it; the hover title breaks the rest down by state.
  const counts = UNIT_STATES.map((state) => [state, units.filter((u) => u.state === state).length]).filter(([, n]) => n);
  const key = counts.map(([state, n]) => `${n} ${state}`).join(', ');
  return `<div class="ms" id="${escape(mapId('milestone', lane.name, id))}"><b>${escape(title)}</b><span>${done} of ${units.length} done</span></div>`
    + (id ? `<div class="bar" title="${escape(key)}">${done ? `<i style="width:${((done / units.length) * 100).toFixed(1)}%"></i>` : ''}</div>` : '');
}

function laneSection(lane, snap, params) {
  const head = [];
  if (Number.isFinite(lane.priority)) head.push(`priority ${lane.priority}`);
  const t = lane.head ? snap.threads.get(lane.head) : null;
  if (!lane.head) head.push('no coordinator');
  else if (!t) head.push(snap.t3.threads ? tone('peach', `no ${lane.headRole} thread`) : tone('yellow', `${lane.headRole} state unavailable`));
  else head.push(`${escape(t.title)} <span class="kept">${live(t, snap.now, true)}</span>`);
  // Short time phrases are kept on one line, so "ago" never wraps alone.
  if (lane.updatedAt) {
    const quiet = snap.now - lane.updatedAt;
    if (quiet > LANE_STALE_MS) head.push(tone('yellow kept', `no update since ${when(lane.updatedAt, snap.now)}`));
    else head.push(t?.state === 'running' && quiet > STALE_MS ? tone('yellow kept', `no update for ${ago(quiet)}`) : tone('kept', `updated ${ago(quiet)} ago`));
  }
  if (lane.prs.size || lane.prError) head.push(lane.prError ? tone('yellow', `GitHub: ${lane.prError}`) : tone('kept', `PRs ${ago(snap.now - lane.prsAt)} ago`));
  const groups = milestoneGroups(lane);
  const ledgerNotes = lane.ledgerSkipped.length
    ? [`${lane.ledgerFile}: ${lane.ledgerSkipped.length} row${lane.ledgerSkipped.length === 1 ? '' : 's'} skipped (${lane.ledgerSkipped.slice(0, 2).map((s) => `line ${s.line}: ${s.why}`).join('; ')}${lane.ledgerSkipped.length > 2 ? '; more' : ''})`]
    : [];
  return `<section id="${escape(mapId('lane', lane.name))}"><div class="lane"><b>${escape(lane.name)}</b><small>${head.join(' · ')}</small></div>`
    + [...lane.notes, ...ledgerNotes].map((n) => `<div class="note">${escape(n)}</div>`).join('')
    + lane.skipped.map(warningRow).join('')
    + groups.map(([id, units]) => milestoneHead(id, units, lane) + milestoneRows(id, units, lane, snap, params)).join('')
    + '</section>';
}

// One footer sentence per lane with anything skipped: counts, then the first few lines and why.
function laneIssues(lane) {
  const deps = lane.units.flatMap((u) => u.deps.filter((d) => !d.target || d.cycle)
    .map((d) => ({ line: u.line, why: d.target ? `after ${d.name} (cycle)` : `after ? ${d.name}` })));
  const kinds = [
    [lane.skipped, (n) => `${n} row${n === 1 ? '' : 's'} skipped`, ''],
    [deps, (n) => `${n} ${n === 1 ? 'dependency' : 'dependencies'} unresolved`, ''],
    [lane.badSince, (n) => `${n} since unreadable`, ''],
    [lane.ledgerSkipped, (n) => `${n} ledger row${n === 1 ? '' : 's'} skipped`, 'ledger.tsv '],
  ].filter(([list]) => list.length);
  if (!kinds.length) return '';
  const details = kinds.flatMap(([list, , file]) => list.map((i) => `${i.why}, ${file}line ${i.line}`));
  const shown = details.slice(0, 3).join('; ') + (details.length > 3 ? `; ${details.length - 3} more` : '');
  return ` ${escape(lane.name)}: <b>${kinds.map(([list, count]) => count(list.length)).join(', ')}</b> (${escape(shown)}).`;
}

// Partition whole lanes in priority order into three columns, weighing a lane by its rows not done plus two for its
// header. The two cuts are the ones whose tallest column is shortest (ties: the shorter two-column page, then the
// earlier cuts). At middling widths the grid has two columns, so the adjacent pair of groups that makes the shorter
// tallest column shares a .pair wrapper; from 1280 px that wrapper is display:contents. Phones stack all three.
function columns(sections, lanes) {
  const div = (html) => `<div>${html}</div>`;
  if (lanes.length < 3) return `<div class="cols">${sections.map(div).join('')}</div>`;
  const weights = lanes.map((lane) => lane.units.filter((u) => u.state !== 'done').length + 2);
  const sum = (from, to) => weights.slice(from, to).reduce((a, b) => a + b, 0);
  let best;
  for (let i = 1; i < lanes.length - 1; i++) {
    for (let j = i + 1; j < lanes.length; j++) {
      const [a, b, c] = [sum(0, i), sum(i, j), sum(j, lanes.length)];
      const left = Math.max(a + b, c);
      const right = Math.max(a, b + c);
      const score = [Math.max(a, b, c), Math.min(left, right)];
      if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) {
        best = { i, j, score, pairLeft: left < right };
      }
    }
  }
  const [first, second, third] = [sections.slice(0, best.i), sections.slice(best.i, best.j), sections.slice(best.j)]
    .map((group) => div(group.join('')));
  return `<div class="cols">${best.pairLeft
    ? `<div class="pair">${first}${second}</div>${third}` : `${first}<div class="pair">${second}${third}</div>`}</div>`;
}

// One line per item at the top of the map, the to-do: the ask, the wait and the links where he acts. The unit's
// detail stays in its lane, so the phone page does not carry every row twice.
function needsRow(item, snap) {
  const todo = (name, ask, tag) => `<div class="u needs todo"><span class="state peach">you</span><b class="id">${escape(name)}</b>`
    + `${ask.length ? `<span class="ask">${ask.join(' · ')}</span>` : ''}${tag ? `<span class="tag">${escape(tag)}</span>` : ''}</div>`;
  if (!item.unit) {
    const t = item.thread;
    return todo(t.title, [t.ask && escape(t.ask), t.askedAt && stamp('asked', t.askedAt, snap.now), t.branch && escape(t.branch)].filter(Boolean), t.project);
  }
  const u = item.unit;
  const lane = snap.lanes.lanes.find((l) => l.name === u.lane);
  const ask = [...[item.blocker ?? u.note, item.thread?.title].filter(Boolean).map(escape), unitWait(item, snap.now)].filter(Boolean);
  return todo(u.id, [...ask, ...actLinks(u, lane)], u.lane);
}

function statusStrip(snap, needs) {
  const lanes = snap.lanes.lanes ?? [];
  const units = lanes.flatMap((lane) => milestoneGroups(lane).flatMap(([, rows]) => liveGroups(rows).flatMap((group) => treeOrder(group))));
  const problems = [snap.t3.unavailable.length ? 'T3 state unavailable' : '',
    !snap.lanes.lanes ? 'lanes unavailable' : '',
    ...lanes.filter((lane) => lane.unitsError).map((lane) => `${lane.name} units.tsv ${lane.skipped.length ? 'incomplete' : 'unavailable'} (${lane.unitsError})`)].filter(Boolean);
  const count = (rows, label) => rows.length
    ? `<a href="${jumpTo(mapId('unit', rows[0].lane, rows[0].id))}">${rows.length} ${label}</a>` : `<span>0 ${label}</span>`;
  const attention = needs.length ? `<a href="#needs-you">${needs.length} need you</a>`
    : problems.length ? '<span class="yellow">needs you unknown</span>' : '<span class="green">nothing needs you</span>';
  const stats = [attention, count(units.filter((u) => u.state === 'in-flight'), 'in flight'),
    count(units.filter((u) => isStalled(u, snap.now)), 'stalled'), count(units.filter((u) => u.state === 'paused'), 'paused'),
    count(units.filter((u) => u.state === 'queued'), 'queued')];
  const links = lanes.map((lane) => `<a href="${jumpTo(mapId('lane', lane.name))}">${escape(lane.name)}</a>`);
  // Each item keeps its trailing "·" in one box, so a narrow strip wraps between items and no line starts with a "·";
  // the no-break space keeps the "·" on the item's last line when a long warning wraps inside its box.
  const items = (list) => list.map((item, i) => `<span class="strip-item">${item}${i < list.length - 1 ? '&nbsp;·' : ''}</span>`).join(' ');
  return `<nav class="status-strip" aria-label="Map status">${items([...stats, ...links])}${problems.length ? ` <span class="source-warning yellow">${items(problems.map(escape))}</span>` : ''}</nav>`;
}

export function renderMap(snap, params = new URLSearchParams()) {
  const needs = needsYou(snap);
  const { dir, lanes } = snap.lanes;
  let body;
  if (!lanes) body = `<p class="more">No lanes at ${escape(tilde(dir))}</p>`;
  else if (!lanes.length) body = `<p class="more">No lanes in ${escape(tilde(dir))}</p>`;
  else body = columns(lanes.map((lane) => laneSection(lane, snap, params)), lanes);
  const issues = (lanes ?? []).map(laneIssues).join('');
  return page('project map', needs.length + t3Gaps(snap), `${pageHeader('map', snap.now)}
${statusStrip(snap, needs)}${t3Section(snap)}${needs.length ? `<h2 class="attn">Needs you · ${needs.length}</h2>${needs.map((item, i) => i ? needsRow(item, snap) : `<div id="needs-you">${needsRow(item, snap)}</div>`).join('')}` : ''}
${body}
<footer>Read-only view of ${escape(tilde(path.dirname(dir)))} lanes and T3 state.${issues}</footer>`, true);
}

// The board refreshes every few seconds on every open phone, so a problem is logged when it starts or changes, and once
// when it clears, never per request.
const logged = new Map();
function logChange(what, problem, cleared) {
  if (problem === (logged.get(what) ?? '')) return;
  console.error(`agent-board: ${problem || cleared}`);
  logged.set(what, problem);
}

// Only a bug in the board itself gets here; a T3 schema change shows on the page instead (readThreads).
function errorPage(message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${REFRESH_S}"><title>agent board error</title><style>${STYLE}</style></head><body><main>
<header><h1>agent board</h1></header><div class="t needs"><div class="name">Could not render the board</div>
<div class="sub">${escape(message)}</div><div class="sub">See ~/Library/Logs/agent-board.log and fix files/bin/agent-board.mjs.</div></div>
</main></body></html>`;
}

// Catppuccin Mocha and JetBrains Mono (AGENTS.md theme rule). No external assets.
const STYLE = `:root{color-scheme:dark;--base:#1e1e2e;--mantle:#181825;--crust:#11111b;--surface0:#313244;--surface1:#45475a;--overlay1:#7f849c;
--overlay2:#9399b2;--text:#cdd6f4;--subtext:#a6adc8;--blue:#89b4fa;--sapphire:#74c7ec;--teal:#94e2d5;--green:#a6e3a1;--yellow:#f9e2af;
--peach:#fab387;--red:#f38ba8;--lavender:#b4befe;--mono:'JetBrains Mono','JetBrainsMono Nerd Font',ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--crust);color:var(--text);font-family:var(--mono);font-size:14px;line-height:1.5;padding:0 12px 40px}
main{max-width:720px;margin:0 auto;min-width:0}main.wide{max-width:1400px}
header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:4px 12px;padding:18px 4px 6px}
h1{font-size:17px;color:var(--lavender)}h1 span{color:var(--overlay1);font-weight:400}
::selection{background:var(--surface1);color:var(--text)}a:focus-visible,.check:focus-visible{outline:2px solid var(--lavender);outline-offset:2px;border-radius:3px}
a{color:inherit;text-decoration:none}a b{font-weight:500;color:var(--blue)}h1 u{color:var(--text);text-decoration-color:var(--lavender);text-underline-offset:4px}
header small{font-size:12px;color:var(--overlay1)}
.kept{white-space:nowrap}
h2{font-size:11.5px;letter-spacing:.6px;text-transform:uppercase;color:var(--overlay1);margin:16px 4px 7px;font-weight:500}
h2.attn{color:var(--peach)}
.t{background:var(--base);border:1px solid var(--surface0);border-radius:10px;padding:10px 12px;margin-bottom:8px;min-width:0}
.t.needs,.u.needs{background:#2b2530;border-color:#5a4652}
.name{font-weight:700;font-size:13.5px;overflow-wrap:anywhere}
.sub{font-size:12px;color:var(--subtext);margin-top:3px;overflow-wrap:anywhere}
.line{font-size:12px;color:var(--subtext);margin-top:3px;overflow-wrap:break-word}
.green{color:var(--green)}.red{color:var(--red)}.peach{color:var(--peach)}.muted{color:var(--overlay1)}
.grey{color:var(--overlay2)}.sapphire{color:var(--sapphire)}.yellow{color:var(--yellow)}.overlay{color:var(--overlay1)}.subtext{color:var(--subtext)}
.ctx{height:5px;background:var(--surface0);border-radius:3px;margin-top:8px;overflow:hidden}
.ctx i{display:block;height:100%;background:var(--teal)}.ctx i.warn{background:var(--yellow)}.ctx i.hot{background:var(--red)}
.more{color:var(--overlay1);font-size:12px;margin:4px}
.lane{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:2px 10px;margin:20px 4px 6px}
.lane b{font-size:13.5px;color:var(--lavender)}.lane small{font-size:12px;color:var(--overlay1);min-width:0;overflow-wrap:anywhere}
.note{font-size:12px;color:var(--overlay2);margin:0 4px 7px;overflow-wrap:anywhere}
.ms{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin:12px 4px 5px;font-size:12px;color:var(--subtext)}
.ms b{font-weight:500;color:var(--text)}
.ms{flex-wrap:wrap;overflow-wrap:anywhere}.ms span{white-space:nowrap}
.status-strip{font-size:12px;color:var(--subtext);margin:6px 4px 12px;overflow-wrap:anywhere}
.status-strip a{display:inline-block;padding:3px 0}.status-strip a:hover,.done-group a:hover{text-decoration:underline}
.strip-item{display:inline-block;max-width:100%}.source-warning{display:block;margin-top:4px}
:target{outline:2px solid var(--lavender);outline-offset:3px;border-radius:8px;scroll-margin-top:12px}
.done-group{font-size:12px;color:var(--overlay2);margin:5px 4px 12px}.done-group a{display:inline-block;padding:4px 0}
.next{font-size:12px;color:var(--teal);white-space:nowrap}
.bar{display:flex;height:4px;background:var(--surface0);border-radius:3px;overflow:hidden;margin:0 4px 8px}.bar i{display:block;height:100%;background:var(--green)}
.u{background:var(--base);border:1px solid var(--surface0);border-radius:10px;padding:8px 12px;margin-bottom:7px;min-width:0}
.u.done{opacity:.62}.u.blocked{border-color:#5a3a48}.u.warn{background:#2a2a28;border-color:#5a5340}
.todo{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;padding:6px 12px;margin-bottom:5px;font-size:12px;color:var(--subtext)}
.todo .state{font-weight:500}.todo .id{font-size:13px;color:var(--text);overflow-wrap:anywhere}.todo .tag{margin-left:auto;color:var(--overlay1)}
.ask{min-width:0;overflow-wrap:anywhere}
.row{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:2px 10px;min-width:0}
.id{font-weight:700;font-size:13px;min-width:0;overflow-wrap:anywhere}
.id .state{font-weight:500;margin-right:7px;white-space:nowrap}
.pr{font-size:12px;color:var(--subtext);min-width:0;overflow-wrap:anywhere;margin-left:auto}
.pr b{font-weight:500}
.title{font-size:13px;color:var(--text);margin-top:3px;overflow-wrap:anywhere}
.summary{font-size:12px;color:var(--subtext);margin-top:2px;overflow-wrap:anywhere}
.unit-note{font-size:12px;color:var(--overlay2);margin-top:3px;overflow-wrap:anywhere}
.pr-block{margin-top:5px;padding-top:5px;border-top:1px solid var(--surface0)}
.meta{font-size:12px;color:var(--subtext);overflow-wrap:anywhere}.meta+.meta{margin-top:2px}
.meta code{font-family:inherit;color:var(--lavender)}
.link{color:var(--blue);text-decoration:none;text-underline-offset:3px;padding:6px 0;margin:-6px 0}.link:hover{text-decoration:underline}
.more{margin-top:3px;font-size:11.5px;color:var(--overlay2)}.more summary{cursor:pointer;padding:4px 0;list-style-position:inside}
.more summary:focus-visible{outline:2px solid var(--lavender);outline-offset:2px;border-radius:3px}.more .count{color:var(--subtext)}
.more .meta{margin-top:3px}
.checks{display:flex;flex-wrap:wrap;gap:3px 10px;margin-top:3px;font-size:11.5px;color:var(--subtext)}
.check{display:inline-flex;align-items:baseline;gap:5px;color:inherit;text-decoration:none;overflow-wrap:anywhere;padding:5px 0;margin:-5px 0}
.dot{display:inline-block;flex-shrink:0;width:7px;height:7px;border-radius:50%;background:var(--overlay1)}
.dot.pass{background:var(--green)}.dot.fail{background:var(--red)}.dot.pending{background:var(--yellow)}.dot.skip{background:var(--surface1)}
.after{font-size:12px;color:var(--overlay2);margin-top:3px;overflow-wrap:anywhere}
.after b{font-weight:500;color:var(--subtext)}
.stale{font-size:12px;color:var(--yellow);margin-top:3px;overflow-wrap:anywhere}
.kids{margin-left:12px;padding-left:10px;border-left:1px solid var(--surface1)}
.cols>div,.pair>div{min-width:0}
.cols>div:only-child{grid-column:1/-1}
@media (min-width:900px){.cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 22px;align-items:start}
.todo .tag{margin-left:0}.todo .tag::before{content:'· '}}
@media (min-width:1280px){.cols:has(>.pair){grid-template-columns:repeat(3,minmax(0,1fr))}.pair{display:contents}}
footer{color:var(--overlay1);font-size:11px;margin:20px 4px 0}footer b{font-weight:500;color:var(--yellow)}`;

// Allow loopback and this Mac's MagicDNS names, on our port only. Anything else is a DNS rebinding attempt or a
// misrouted request. No tailnet-IP Host: tailscale serve answers 404 for one before the board sees it.
export function hostAllowed(hostHeader, { port = PORT, short = os.hostname().split('.')[0].toLowerCase() } = {}) {
  const match = /^([a-z0-9.-]+):(\d+)$/i.exec(hostHeader ?? '');
  if (!match || Number(match[2]) !== port) return false;
  const host = match[1].toLowerCase();
  if (host === '127.0.0.1' || host === 'localhost' || host === short) return true;
  return host.startsWith(`${short}.`) && host.endsWith('.ts.net') && /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(host);
}

const HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

const ROUTES = new Map([['/', 'threads'], ['/map', 'map']]);

function handle(req, res) {
  const route = ROUTES.get(req.url.split('?')[0]);
  if (!hostAllowed(req.headers.host)) {
    res.writeHead(403, { ...HEADERS, 'content-type': 'text/plain' }).end('Host not allowed.\n');
  } else if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...HEADERS, allow: 'GET, HEAD', 'content-type': 'text/plain' }).end('Read-only.\n');
  } else if (!route) {
    res.writeHead(404, { ...HEADERS, 'content-type': 'text/plain' }).end('Not found.\n');
  } else {
    let status = 200;
    let html;
    try {
      const snap = route === 'map' ? snapshot({ autoupdate: null }) : snapshot();
      logChange('t3', snap.t3.unavailable.join('; '), 'T3 state readable again');
      html = route === 'map' ? renderMap(snap, new URL(req.url, 'http://board').searchParams) : render(snap);
      logChange('page', '', 'pages render again');
    } catch (error) {
      status = 500;
      html = errorPage(error.message);
      logChange('page', error.message);
    }
    res.writeHead(status, { ...HEADERS, 'content-type': 'text/html; charset=utf-8' }).end(req.method === 'HEAD' ? undefined : html);
  }
}

// Tailnet devices reach the board through `tailscale serve`, which proxies plain HTTP on the same port of this Mac's
// tailnet address to loopback, as packs-server.py does for /packs, so the phone's URL stays http://<MagicDNS>:4790.
// Tailscale is Developer ID signed and the application firewall lets its listener in, while the board's ad-hoc signed
// nix-store node never needs an inbound rule (nix/host.nix).
// The same port works only from 1024 up: below that, Tailscale's sandboxed macOS app binds the serve port on every
// address as root, and macOS then refuses the board's 127.0.0.1 bind with EADDRINUSE. A serve port under 1024 needs
// a different loopback port.
// Every PUBLISH_CHECK_MS the board reads `tailscale serve status` and sets the handler again if it is gone (`tailscale
// serve reset`, a Tailscale log-out); setting it is idempotent. One check at a time, and a line only when the state
// changes, so a weekend with Tailscale logged out is two lines, not one per check.
const TARGET = `http://127.0.0.1:${PORT}`;
const PUBLISHED = `published on the tailnet with tailscale serve on port ${PORT}`;
const served = (status) => {
  try {
    return Object.entries(JSON.parse(status || '{}').Web ?? {})
      .some(([site, config]) => site.endsWith(`:${PORT}`) && config?.Handlers?.['/']?.Proxy === TARGET);
  } catch {
    return false;
  }
};
const publishing = { state: null, justSet: false, busy: false }; // state: the last one logged
function report(state, line) {
  if (state === publishing.state) return;
  publishing.state = state;
  (state === 'published' ? console.log : console.error)(`agent-board: ${line}`);
}
function publish() {
  if (publishing.busy) return;
  publishing.busy = true;
  execFile(TAILSCALE, ['serve', 'status', '--json'], { timeout: 30_000 }, (statusError, status) => {
    if (!statusError && served(status)) {
      publishing.busy = publishing.justSet = false;
      return report('published', PUBLISHED);
    }
    if (!statusError && publishing.justSet) {
      // Set without error but not listed: setting it on every check is harmless, logging it every time is not.
      report('unlisted', `tailscale serve status does not list the handler on port ${PORT} that was just set; setting it on every check`);
    } else if (!statusError && publishing.state === 'published') {
      console.log(`agent-board: the tailscale serve handler on port ${PORT} was gone; setting it again`);
      publishing.state = null;
    }
    const args = ['serve', '--bg', `--http=${PORT}`, TARGET];
    execFile(TAILSCALE, args, { timeout: 30_000 }, (error, _stdout, stderr) => {
      publishing.busy = false;
      publishing.justSet = !error;
      if (!error) {
        if (publishing.state !== 'unlisted') report('published', PUBLISHED);
        return;
      }
      const why = String(stderr).trim() || error.message;
      report(why, `tailscale ${args.join(' ')} failed: ${why}; checking again every ${PUBLISH_CHECK_MS / 1000} s`);
    });
  });
}

function serve() {
  const server = http.createServer(handle);
  server.on('error', (error) => {
    // Without its listener the process is useless; exit so launchd's KeepAlive retries.
    console.error(`agent-board: cannot listen on 127.0.0.1:${PORT}: ${error.message}`);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`agent-board: listening on 127.0.0.1:${PORT}`);
    if (!PUBLISH) return;
    publish();
    setInterval(publish, PUBLISH_CHECK_MS);
  });
  // launchd runs this file from the live checkout, which merges and the daily sync change under it while the plist
  // stays the same. Exit on a change so KeepAlive restarts the board on the new code.
  fs.watchFile(SELF, { interval: 2_000 }, (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs) return;
    console.log('agent-board: source changed, restarting');
    process.exit(0);
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SELF) serve();
