#!/usr/bin/env node
// Agent board: a read-only phone view of every open T3 thread - who is waiting on the owner, what is running, how full each
// context is, and which runs have gone quiet. It reads T3's statev2.sqlite (read-only, explicit columns only; never the
// scheduled_tasks webhook token or secret) and tails Claude Code logs for last activity, and writes nothing anywhere.
// It also shows the dotfiles auto-updater's alarms, from that updater's own reader (scripts/dotfiles-autoupdate status).
// A second page, /map, shows each orchestrator lane's milestones, units, owners and what waits on the owner, read from the
// lane files under ~/orchestrator/lanes (design: docs/agent-observability/project-map.html), plus read-only local git
// to flag a row waiting on the owner whose branch already landed.
// Listens on 127.0.0.1 and this Mac's Tailscale address only, never all interfaces, and answers GET for allowlisted
// Host names only. Run by a Home Manager launchd agent (see nix/user.nix); logs go to ~/Library/Logs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.AGENT_BOARD_PORT ?? 4790);
const T3_DB = process.env.AGENT_BOARD_T3_DB ?? path.join(os.homedir(), '.t3/userdata/statev2.sqlite');
const CLAUDE_PROJECTS = process.env.AGENT_BOARD_CLAUDE_PROJECTS ?? path.join(os.homedir(), '.claude/projects');
const LANES = process.env.AGENT_BOARD_LANES ?? path.join(os.homedir(), 'orchestrator/lanes');
const SELF = fileURLToPath(import.meta.url);
const AUTOUPDATE = path.join(path.dirname(SELF), '../../scripts/dotfiles-autoupdate');
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

// autoupdate: null skips the updater, which only the thread page shows.
export function snapshot({ dbPath = T3_DB, logsDir = CLAUDE_PROJECTS, lanesDir = LANES, now = Date.now(), autoupdate = AUTOUPDATE } = {}) {
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
    updates: autoupdate === null ? null : readUpdates(autoupdate),
    needs: shown.filter((t) => t.state === 'needs'),
    running: shown.filter((t) => t.state === 'running'),
    idle: shown.filter((t) => t.state === 'idle'),
    // Unit owners and lane coordinators may be any open thread, including the idle children hidden above.
    threads: new Map(threads.map((t) => [t.id, t])),
    lanes: readLanes(lanesDir, now),
  };
}

// ---- Lane files (the /map page's source) ----
// Each lane is ~/orchestrator/lanes/<lane>/ with lane.json, units.tsv and ledger.tsv, written by the orchestrator, the
// lane coordinator and the verifiers (templates/orchestrator-lane/README.md has the columns). Read on every request
// and never written. A bad file or row is reported on the page, never guessed at.

export const UNIT_STATES = ['done', 'in-flight', 'review', 'needs-myuser', 'blocked', 'paused', 'queued'];
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
      skipped.push({ line, why });
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

// The ledger is append-only, so a PR's last row is its newest verdict.
export function parseLedger(text) {
  const { header, rows } = readTsv(text);
  const missing = ['pr', 'verdict'].filter((name) => !header.includes(name));
  if (missing.length) return { error: `no ${missing.join(' or ')} column`, verdicts: new Map(), skipped: [] };
  const verdicts = new Map();
  const skipped = [];
  for (const { line, fields } of rows) {
    const pr = (fields[header.indexOf('pr')] ?? '').replace(/^#/, '');
    const verdict = fields[header.indexOf('verdict')] ?? '';
    const why = fields.length !== header.length ? `${fields.length} fields, header has ${header.length}`
      : !/^\d+$/.test(pr) ? `pr "${pr}" is not a number`
        : !verdict ? 'no verdict' : null;
    if (why) skipped.push({ line, why });
    else verdicts.set(Number(pr), verdict);
  }
  return { error: null, verdicts, skipped };
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
    metaError: null, units: [], skipped: [], badSince: [], verdicts: new Map(), ledgerSkipped: [], updatedAt: null,
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
  if (units.error === 'missing') {
    // D1: job-tracker keeps its old log under state/ until the approved phase 2 move converts it.
    lane.notes.push(fs.existsSync(path.join(dir, 'state/units.tsv')) ? 'legacy layout: state/units.tsv converts in phase 2' : 'no units file');
  } else if (units.error) {
    lane.notes.push(`units.tsv: ${units.error}`);
  } else {
    const parsed = parseUnits(units.text);
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

  const ledger = readLaneFile(dir, 'ledger.tsv', lane);
  if (ledger.error && ledger.error !== 'missing') lane.notes.push(`ledger.tsv: ${ledger.error}`);
  if (ledger.text !== undefined) {
    const parsed = parseLedger(ledger.text);
    if (parsed.error) lane.notes.push(`ledger.tsv: ${parsed.error}`);
    lane.verdicts = parsed.verdicts;
    lane.ledgerSkipped = parsed.skipped;
  }
  return lane;
}

// Lanes in priority order, a lane without a readable lane.json last. Each unit's after list is resolved across lanes
// (lane/unit), and an edge whose target can reach the unit back is a cycle. A needs-myuser unit is the owner's turn ("you")
// once every unit it waits for is done; until then its lane shows "then you". lanes is null without a lanes directory.
export function readLanes(dir = LANES, now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => !n.startsWith('.') && fs.statSync(path.join(dir, n), { throwIfNoEntry: false })?.isDirectory());
  } catch {
    return { dir, lanes: null };
  }
  const lanes = names.map((n) => readLane(path.join(dir, n), n, now))
    .sort((a, b) => (a.metaError ? 1 : 0) - (b.metaError ? 1 : 0) || a.priority - b.priority || a.name.localeCompare(b.name));
  const units = lanes.flatMap((lane) => lane.units);
  const byKey = new Map(units.map((u) => [`${u.lane}/${u.id}`, u]));
  for (const u of units) {
    u.deps = u.after.map((name) => ({ name, target: byKey.get(name.includes('/') ? name : `${u.lane}/${name}`) ?? null, cycle: false }));
  }
  const reaches = (from, to, seen) => from === to
    || (!seen.has(from) && seen.add(from) && from.deps.some((d) => d.target && reaches(d.target, to, seen)));
  for (const u of units) {
    for (const d of u.deps) if (d.target) d.cycle = reaches(d.target, u, new Set());
    const ready = u.deps.every((d) => d.target && !d.cycle && d.target.state === 'done');
    u.shown = u.state !== 'needs-myuser' ? u.state : ready ? 'you' : 'then you';
    // D3: a unit nests under the first unit it waits for in the same lane and milestone; other edges are written out.
    u.nest = u.deps.find((d) => d.target && !d.cycle && d.target.lane === u.lane && d.target.milestone === u.milestone) ?? null;
    u.parent = u.nest?.target ?? null;
  }
  const reads = new Map();
  for (const lane of lanes) for (const u of lane.units) u.stale = staleReason(lane, u, reads);
  return { dir, lanes };
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

// Alarms go above the threads with the needs-you colours; a healthy updater is one quiet card below them.
function updatesSection(u) {
  const lines = [...u.alarms.map((t) => ['red', t]), ...u.infos.map((t) => ['', t]), ...u.oks.map((t) => ['muted', t])];
  // No count in the heading: every other heading counts cards, and this section is one card.
  return `<h2 class="${u.alarms.length ? 'attn' : ''}">Auto-update</h2>`
    + `<div class="t${u.alarms.length ? ' needs' : ''}"><div class="name">dotfiles auto-update</div>`
    + lines.map(([tone, text]) => `<div class="line ${tone}">${escape(text)}</div>`).join('') + '</div>';
}

const SGT = (options) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', ...options });

// 14:05 today, Tue 14:05 this week, 9 Oct before that.
function when(at, now) {
  const day = (ms) => Math.floor((ms + SGT_MS) / 86_400_000);
  const hm = SGT({ hour: '2-digit', minute: '2-digit' }).format(at);
  if (day(at) === day(now)) return hm;
  if (day(now) - day(at) < 7) return `${SGT({ weekday: 'short' }).format(at)} ${hm}`;
  return SGT({ day: 'numeric', month: 'short' }).format(at);
}

const tone = (cls, text) => `<span class="${cls}">${escape(text)}</span>`;

// Both pages share the header, so threads and map are one tap apart. The clock gives way on a phone.
function pageHeader(page, now) {
  const link = (name, href) => (name === page ? `<u>${name}</u>` : `<a href="${href}">${name}</a>`);
  return `<header><h1><span>agent board ·</span> ${link('threads', '/')} · ${link('map', '/map')}</h1>`
    + `<small><span class="clock">${SGT({ hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(now)} SGT · </span>`
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
function needsYou(snap) {
  const units = (snap.lanes?.lanes ?? []).flatMap((lane) => lane.units.filter((u) => u.shown === 'you'));
  const owned = new Set(units.map((u) => u.owner));
  const items = [
    ...units.map((u) => {
      const ask = snap.needs.find((t) => t.id === u.owner);
      return { unit: u, thread: ask, at: ask?.askedAt ?? u.sinceAt ?? null };
    }),
    ...snap.needs.filter((t) => !owned.has(t.id)).map((t) => ({ thread: t, at: t.askedAt })),
  ];
  return items.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
}

// What a waiting unit's line says about the wait: its owner's input card if it has one, else how long it has waited.
function unitWait(item, now) {
  if (item.thread) return `${item.thread.ask}${item.thread.askedAt ? ` · asked ${when(item.thread.askedAt, now)}` : ''}`;
  return item.unit.sinceAt ? `since ${when(item.unit.sinceAt, now)}` : null;
}

function unitCard(item, now) {
  const u = item.unit;
  const meta = [u.lane, u.note, item.thread?.title, unitWait(item, now)].filter(Boolean).map(escape).join(' · ');
  return `<div class="t needs"><div class="name">${escape(u.id)}</div><div class="sub"><span class="state peach">you</span> · ${meta}</div>${staleLine(u)}</div>`;
}

// The row and its state stay as written; the lane owner fixes the file (see staleReason).
const staleLine = (u) => (u.stale ? `<div class="stale" title="${escape(u.stale.title)}">looks stale: ${escape(u.stale.text)}</div>` : '');

export function render(snap) {
  const section = (title, list, cls = '', limit = Infinity) => (list.length
    ? `<h2 class="${cls}">${title} · ${list.length}</h2>${list.slice(0, limit).map((t) => card(t, snap.now)).join('')}`
      + (list.length > limit ? `<p class="more">+${list.length - limit} more</p>` : '')
    : '');
  const needs = needsYou(snap);
  const threads = (needs.length ? `<h2 class="attn">Needs you · ${needs.length}</h2>`
      + needs.map((item) => (item.unit ? unitCard(item, snap.now) : card(item.thread, snap.now))).join('') : '')
    + section('Running', snap.running) + section('Idle', snap.idle, '', IDLE_SHOWN);
  const alarmed = snap.updates.alarms.length > 0;
  const updates = updatesSection(snap.updates);
  return page('agent board', needs.length + (alarmed ? 1 : 0), `${pageHeader('threads', snap.now)}
${alarmed ? updates : ''}${threads || '<p class="more">No open T3 threads.</p>'}${alarmed ? '' : updates}
<footer>Read-only view of T3 state. Nothing here can change an agent.</footer>`);
}

// ---- /map ----

const STALL_MS = 8 * 3600_000; // review rule, 10 Oct: open 8 hours of work is stalled
const STALE_MS = 2 * 3600_000; // a running coordinator with no lane file change for this long
const SHOWN = {
  queued: 'grey', 'in-flight': 'green', review: 'sapphire', you: 'peach', 'then you': 'peach', blocked: 'red', paused: 'yellow', done: 'grey',
};
// The milestone bar, in this order; queued is the empty track.
const BAR = { done: 'green', 'in-flight': 'teal', review: 'sapphire', 'needs-myuser': 'peach', blocked: 'red', paused: 'yellow' };

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
  // A settled, archived or deleted owner reads the same as a wrong id: nobody holds the unit.
  return THREAD_ID.test(u.owner) ? [tone('peach', 'no owner thread')] : [escape(u.owner)];
}

function sinceLine(u, now) {
  if (!u.sinceAt || !['in-flight', 'review', 'blocked', 'needs-myuser'].includes(u.state)) return null;
  if (u.state !== 'needs-myuser' && now - u.sinceAt > STALL_MS) return tone('yellow', `stalled since ${when(u.sinceAt, now)}`);
  return `since ${when(u.sinceAt, now)}`;
}

function prChip(u, lane) {
  if (!/^\d+$/.test(u.pr)) return escape(u.pr || (u.state === 'done' ? '' : 'no PR'));
  const verdict = lane.verdicts.get(Number(u.pr)) ?? 'no verdict';
  const text = `<b>#${u.pr}</b> ${escape(verdict)}`;
  return lane.repo
    ? `<a href="https://github.com/${escape(lane.repo)}/pull/${u.pr}" title="${escape(verdict)}" rel="noreferrer">${text}</a>`
    : `<span title="${escape(verdict)}">${text}</span>`;
}

function depLine(d) {
  if (!d.target) return tone('yellow', `? ${d.name}`);
  if (d.cycle) return tone('yellow', `${d.name} (cycle)`);
  return `<b>${escape(d.name)}</b>${d.target.state === 'needs-myuser' ? ' (then you)' : ''}`;
}

function unitRow(u, lane, snap) {
  const cls = u.shown === 'you' ? ' needs' : u.state === 'done' ? ' done' : '';
  let html = `<div class="u${cls}"><div class="row"><span class="id"><span class="state ${SHOWN[u.shown]}">${u.shown}</span>`
    + `${escape(u.id)}</span><span class="pr">${prChip(u, lane)}</span></div>`;
  if (u.state !== 'done') {
    const sub = [...ownerLine(u, snap), u.note && escape(u.note), u.branch && escape(u.branch), sinceLine(u, snap.now)].filter(Boolean);
    if (sub.length) html += `<div class="sub">${sub.join(' · ')}</div>`;
    html += staleLine(u);
    const deps = u.deps.filter((d) => d !== u.nest);
    if (deps.length) html += `<div class="after">${u.nest ? 'also after' : 'after'} ${deps.map(depLine).join(', ')}</div>`;
  }
  return `${html}</div>`;
}

// Units in file order, each nested under the unit it waits for (D3). Nesting edges never form a cycle.
function unitTree(units, lane, snap, parent = null) {
  return units.filter((u) => u.parent === parent).map((u) => {
    const kids = unitTree(units, lane, snap, u);
    return unitRow(u, lane, snap) + (kids ? `<div class="kids">${kids}</div>` : '');
  }).join('');
}

function milestoneHead(id, units, lane) {
  const title = id ? [id, lane.milestones.get(id)].filter(Boolean).join(' ') : 'No milestone';
  const done = units.filter((u) => u.state === 'done').length;
  const bar = Object.entries(BAR).map(([state, colour]) => {
    const n = units.filter((u) => u.state === state).length;
    return n ? `<i style="width:${((n / units.length) * 100).toFixed(1)}%;background:var(--${colour})"></i>` : '';
  }).join('');
  return `<div class="ms"><b>${escape(title)}</b><span>${done} of ${units.length} done</span></div><div class="bar">${bar}</div>`;
}

function laneSection(lane, snap) {
  const head = [];
  if (Number.isFinite(lane.priority)) head.push(`priority ${lane.priority}`);
  const t = lane.head ? snap.threads.get(lane.head) : null;
  if (!lane.head) head.push('no coordinator');
  else if (!t) head.push(tone('peach', `no ${lane.headRole} thread`));
  else head.push(`${escape(t.title)} ${live(t, snap.now, true)}`);
  if (lane.updatedAt) {
    const updated = `updated ${ago(snap.now - lane.updatedAt)} ago`;
    head.push(t?.state === 'running' && snap.now - lane.updatedAt > STALE_MS ? tone('yellow', `stale, ${updated}`) : updated);
  }
  // Milestones in the order of their first unit, so the coordinator orders them by writing them.
  const groups = Map.groupBy(lane.units, (u) => u.milestone);
  const titled = lane.units.some((u) => u.milestone);
  return `<section><div class="lane"><b>${escape(lane.name)}</b><small>${head.join(' · ')}</small></div>`
    + lane.notes.map((n) => `<div class="note">${escape(n)}</div>`).join('')
    + [...groups].map(([id, units]) => (titled ? milestoneHead(id, units, lane) : '') + unitTree(units, lane, snap)).join('')
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

// Desktop: lanes fill the left column in priority order until it holds about half the rows; one column on a phone.
function columns(sections, lanes) {
  const weight = (lane) => lane.units.length + 2;
  const total = lanes.reduce((n, lane) => n + weight(lane), 0);
  let split = 1;
  let left = weight(lanes[0]);
  while (split < lanes.length - 1 && left + weight(lanes[split]) / 2 <= total / 2) left += weight(lanes[split++]);
  return `<div class="cols"><div>${sections.slice(0, split).join('')}</div><div>${sections.slice(split).join('')}</div></div>`;
}

function needsRow(item, now) {
  if (!item.unit) {
    const t = item.thread;
    const sub = [t.ask, t.askedAt && `asked ${when(t.askedAt, now)}`, t.branch].filter(Boolean).map(escape).join(' · ');
    return `<div class="u needs"><div class="row"><span class="id"><span class="state peach">you</span>${escape(t.title)}</span>`
      + `<span class="pr">${escape(t.project ?? '')}</span></div><div class="sub">${sub}</div></div>`;
  }
  const u = item.unit;
  const sub = [u.note, item.thread?.title, unitWait(item, now)].filter(Boolean).map(escape).join(' · ');
  return `<div class="u needs"><div class="row"><span class="id"><span class="state peach">you</span>${escape(u.id)}</span>`
    + `<span class="pr">${escape(u.lane)}</span></div>${sub ? `<div class="sub">${sub}</div>` : ''}${staleLine(u)}</div>`;
}

export function renderMap(snap) {
  const needs = needsYou(snap);
  const { dir, lanes } = snap.lanes;
  let body;
  if (!lanes) body = `<p class="more">No lanes at ${escape(tilde(dir))}</p>`;
  else if (!lanes.length) body = `<p class="more">No lanes in ${escape(tilde(dir))}</p>`;
  else body = columns(lanes.map((lane) => laneSection(lane, snap)), lanes);
  const issues = (lanes ?? []).map(laneIssues).join('');
  return page('project map', needs.length, `${pageHeader('map', snap.now)}
${needs.length ? `<h2 class="attn">Needs you · ${needs.length}</h2>${needs.map((item) => needsRow(item, snap.now)).join('')}` : ''}
${body}
<footer>Read-only view of ${escape(tilde(path.dirname(dir)))} lanes and T3 state.${issues}</footer>`, true);
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
--overlay2:#9399b2;--text:#cdd6f4;--subtext:#a6adc8;--blue:#89b4fa;--sapphire:#74c7ec;--teal:#94e2d5;--green:#a6e3a1;--yellow:#f9e2af;
--peach:#fab387;--red:#f38ba8;--lavender:#b4befe;--mono:'JetBrains Mono','JetBrainsMono Nerd Font',ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--crust);color:var(--text);font-family:var(--mono);font-size:14px;line-height:1.5;padding:0 12px 40px}
main{max-width:720px;margin:0 auto;min-width:0}main.wide{max-width:1040px}
header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:4px 12px;padding:18px 4px 6px}
h1{font-size:17px;color:var(--lavender)}h1 span{color:var(--overlay1);font-weight:400}
h1 a{color:inherit;text-decoration:none}h1 u{color:var(--text);text-decoration-color:var(--lavender);text-underline-offset:4px}
header small{font-size:12px;color:var(--overlay1)}
@media (max-width:480px){.clock{display:none}.u .sub,.t.needs .sub{white-space:normal;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow-wrap:anywhere}}
h2{font-size:11.5px;letter-spacing:.6px;text-transform:uppercase;color:var(--overlay1);margin:16px 4px 7px;font-weight:500}
h2.attn{color:var(--peach)}
.t{background:var(--base);border:1px solid var(--surface0);border-radius:10px;padding:10px 12px;margin-bottom:8px;min-width:0}
.t.needs,.u.needs{background:#2b2530;border-color:#5a4652}
.name{font-weight:700;font-size:13.5px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere}
.sub{font-size:12px;color:var(--subtext);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}
.line{font-size:12px;color:var(--subtext);margin-top:3px;overflow-wrap:break-word}
.green{color:var(--green)}.red{color:var(--red)}.peach{color:var(--peach)}.muted{color:var(--overlay1)}
.grey{color:var(--overlay2)}.sapphire{color:var(--sapphire)}.yellow{color:var(--yellow)}
.ctx{height:5px;background:var(--surface0);border-radius:3px;margin-top:8px;overflow:hidden}
.ctx i{display:block;height:100%;background:var(--teal)}.ctx i.warn{background:var(--yellow)}.ctx i.hot{background:var(--red)}
.more{color:var(--overlay1);font-size:12px;margin:4px}
.lane{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:2px 10px;margin:20px 4px 6px}
.lane b{font-size:13.5px;color:var(--lavender)}.lane small{font-size:12px;color:var(--overlay1)}
.note{font-size:12px;color:var(--overlay2);margin:0 4px 7px}
.ms{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin:12px 4px 5px;font-size:12px;color:var(--subtext)}
.ms b{font-weight:500;color:var(--text)}
.bar{display:flex;height:4px;background:var(--surface0);border-radius:3px;overflow:hidden;margin:0 4px 8px}.bar i{display:block;height:100%}
.u{background:var(--base);border:1px solid var(--surface0);border-radius:10px;padding:8px 12px;margin-bottom:7px;min-width:0}
.u.done{opacity:.62}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:8px;min-width:0}
.id{font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.id .state{font-weight:500;margin-right:7px}
.pr{flex-shrink:0;max-width:55%;font-size:12px;color:var(--subtext);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pr b{font-weight:500}.pr a{color:inherit;text-decoration:none}.pr a b{color:var(--blue)}
.after{font-size:12px;color:var(--overlay2);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.after b{font-weight:500;color:var(--subtext)}
.stale{font-size:12px;color:var(--yellow);margin-top:3px}
.kids{margin-left:12px;padding-left:10px;border-left:1px solid var(--surface1)}
@media (min-width:900px){.cols{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:0 22px;align-items:start}}
footer{color:var(--overlay1);font-size:11px;margin:20px 4px 0}footer b{font-weight:500;color:var(--yellow)}`;

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

const ROUTES = new Map([['/', 'threads'], ['/map', 'map']]);

function handle(req, res, tailnetIp) {
  const route = ROUTES.get(req.url.split('?')[0]);
  if (!hostAllowed(req.headers.host, { tailnetIp })) {
    res.writeHead(403, { ...HEADERS, 'content-type': 'text/plain' }).end('Host not allowed.\n');
  } else if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...HEADERS, allow: 'GET, HEAD', 'content-type': 'text/plain' }).end('Read-only.\n');
  } else if (!route) {
    res.writeHead(404, { ...HEADERS, 'content-type': 'text/plain' }).end('Not found.\n');
  } else {
    let status = 200;
    let html;
    try {
      html = route === 'map' ? renderMap(snapshot({ autoupdate: null })) : render(snapshot());
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
  // launchd runs this file from the live checkout, which merges and the daily sync change under it while the plist
  // stays the same. Exit on a change so KeepAlive restarts the board on the new code.
  fs.watchFile(SELF, { interval: 2_000 }, (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs) return;
    console.log('agent-board: source changed, restarting');
    process.exit(0);
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SELF) serve();
