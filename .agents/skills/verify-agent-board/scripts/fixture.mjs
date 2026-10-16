// Seed data for a fixture run of the agent board (board.mjs launch --fixture). It writes, under one scratch directory:
// a T3 database with the tables and columns files/bin/agent-board.mjs reads, Claude Code logs, three orchestrator lanes
// with a small git checkout for the stale-row check, and dotfiles-autoupdate state with one alarm. Every time is
// relative to now, so the pages read like a live board. Names carry "fixture" so a screenshot cannot pass for live data.
// The columns follow tests/agent_board_test.mjs; when T3 changes its schema, a live run catches it and this does not.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gitEnv } from './git-env.mjs';

// The titles the doctor looks for to tell a fixture instance from one reading the real T3 database.
export const MARKERS = { thread: 'Coordinator 3 (fixture)', lane: 'fixture-board' };

const TSV = (rows) => rows.map((r) => r.join('\t')).join('\n') + '\n';

export function seed(dir, now = Date.now()) {
  const iso = (min) => new Date(now - min * 60_000).toISOString();
  const epoch = (min) => String(Math.floor((now - min * 60_000) / 1000));
  fs.mkdirSync(dir, { recursive: true });

  // ---- T3: who waits on the owner, what runs, what is idle ----
  const t3 = path.join(dir, 'statev2.sqlite');
  const db = new DatabaseSync(t3);
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, title TEXT,
      active_provider_thread_id TEXT, updated_at TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT);
    CREATE TABLE projection_projects (project_id TEXT, title TEXT);
    CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, ordinal INTEGER, status TEXT);
    CREATE TABLE projection_pending_approvals (thread_id TEXT, status TEXT);
    CREATE TABLE orchestration_v2_projection_runtime_requests (thread_id TEXT, kind TEXT, status TEXT,
      created_at TEXT, resolved_at TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT, provider TEXT, payload_json TEXT);
    INSERT INTO projection_projects VALUES ('dot', 'dotfiles (fixture)'), ('jt', 'job-tracker (fixture)');`);
  const logs = path.join(dir, 'projects');
  const thread = (id, { title, project = 'dot', minutes, run, payload = {}, archived = null, context = null, log = null }) => {
    db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
      .run(id, project, title, `pt-${id}`, iso(minutes), archived, JSON.stringify(payload));
    db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?)')
      .run(`pt-${id}`, 'claudeAgent', JSON.stringify({ nativeThreadRef: { nativeId: `sess-${id.slice(4)}` }, contextUsage: context }));
    if (run) db.prepare('INSERT INTO orchestration_v2_projection_runs VALUES (?, 1, ?)').run(id, run);
    if (log) {
      const file = path.join(logs, '-fixture', `sess-${id.slice(4)}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const usage = { input_tokens: 12, cache_creation_input_tokens: 1_500, cache_read_input_tokens: log.contextFromLog ?? 0 };
      fs.writeFileSync(file, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: log.tool }], usage } })}\n`);
      const at = new Date(now - log.minutes * 60_000);
      fs.utimesSync(file, at, at);
    }
  };
  const opus = { modelSelection: { model: 'claude-opus-5-5' } };
  const ctx = (used) => ({ usedTokens: used, maxTokens: 1_000_000 });

  // Needs you: a pending input card and a pending approval.
  thread('mcp:fx-design', { title: 'Design worker (fixture)', minutes: 12, run: 'running', context: ctx(182_000),
    payload: { branch: 'feat/lane-wait', modelSelection: { model: 'claude-fable-5-1' } } });
  db.prepare("INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('mcp:fx-design', 'user_input', 'pending', ?, NULL)").run(iso(12));
  thread('mcp:fx-release', { title: 'Release check (fixture)', project: 'jt', minutes: 4, run: 'running', context: ctx(64_000), payload: opus });
  db.prepare("INSERT INTO projection_pending_approvals VALUES ('mcp:fx-release', 'pending')").run();
  // Running: busy, near the pause line, past it, quiet for 14 minutes, and a delegated child.
  thread('mcp:fx-coord', { title: MARKERS.thread, minutes: 1, run: 'running', context: ctx(96_000),
    payload: { branch: 'chore/pstack', ...opus }, log: { tool: 'Bash', minutes: 0.3 } });
  thread('mcp:fx-warn', { title: 'Board polish worker (fixture)', minutes: 2, run: 'running', context: ctx(205_000),
    payload: { branch: 'feat/board-polish', ...opus }, log: { tool: 'Read', minutes: 1 } });
  thread('mcp:fx-hot', { title: 'Long refactor worker (fixture)', project: 'jt', minutes: 3, run: 'running', context: ctx(238_000),
    payload: { branch: 'refactor/sync', ...opus }, log: { tool: 'Edit', minutes: 2 } });
  thread('mcp:fx-quiet', { title: 'Map reviewer (fixture)', minutes: 30, run: 'running',
    payload: opus, log: { tool: 'Grep', minutes: 14, contextFromLog: 161_000 } });
  thread('mcp:fx-child', { title: 'Delegated lint pass (fixture)', minutes: 2, run: 'running',
    payload: { lineage: { parentThreadId: 'mcp:fx-coord' }, modelSelection: { model: 'gpt-5.5' } } });
  // Idle: done, failed and stopped, one long title, and enough threads to pass the 12 shown.
  thread('mcp:fx-failed', { title: 'Failed build (fixture)', project: 'jt', minutes: 40, run: 'failed' });
  thread('mcp:fx-stopped', { title: 'Stopped spike (fixture)', minutes: 180, run: 'cancelled' });
  thread('mcp:fx-long', { title: 'A deliberately long fixture thread title that should wrap onto a second line and stop there on a phone',
    minutes: 90, run: 'completed', payload: { branch: 'docs/a-very-long-branch-name-that-must-not-push-the-card-wider' } });
  for (let i = 1; i <= 11; i++) thread(`mcp:fx-idle-${i}`, { title: `Idle thread ${i} (fixture)`, minutes: 60 * i, run: 'completed' });
  // Never shown: an idle child, a settled thread and an archived one.
  thread('mcp:fx-idle-child', { title: 'Finished child (fixture)', minutes: 5, run: 'completed', payload: { lineage: { parentThreadId: 'mcp:fx-coord' } } });
  thread('mcp:fx-settled', { title: 'Settled thread (fixture)', minutes: 50, run: 'completed', payload: { settledAt: iso(45) } });
  thread('mcp:fx-archived', { title: 'Archived thread (fixture)', minutes: 50, run: 'completed', archived: iso(45) });
  db.close();

  // ---- A git checkout whose branches landed in each way the stale-row check knows ----
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const env = { ...gitEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const commit = (file, subject) => {
    fs.writeFileSync(path.join(repo, file), `${subject}\n`);
    git('add', file);
    git('commit', '-qm', subject);
  };
  git('init', '-qb', 'main');
  commit('a', 'init');
  git('checkout', '-qb', 'feat/squash'); // two commits that land as one squash commit naming PR 12
  commit('s1', 'wip one');
  commit('s2', 'wip two');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--squash', 'feat/squash');
  git('commit', '-qm', 'feat: squash work (#12)');
  git('checkout', '-qb', 'feat/merged'); // fast-forwarded into main
  commit('m', 'feat: merged work');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--ff-only', 'feat/merged');
  git('checkout', '-qb', 'feat/polish'); // still open
  commit('p', 'feat: polish in progress');
  git('checkout', '-q', 'main');
  git('update-ref', 'refs/remotes/origin/main', 'main');
  git('checkout', '-qb', 'feat/unpushed'); // merged into the local main only, so still waiting for "push"
  commit('u', 'feat: unpushed work');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--ff-only', 'feat/unpushed');

  // ---- Lanes ----
  const lanes = path.join(dir, 'lanes');
  const write = (file, text, minutesAgo = 5) => {
    const p = path.join(lanes, file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    const at = new Date(now - minutesAgo * 60_000);
    fs.utimesSync(p, at, at);
  };
  write('fixture-board/lane.json', JSON.stringify({
    priority: 1, repo: 'example/board', github: true, checkout: repo, base: 'main', coordinator_thread: 'mcp:fx-coord',
    milestones: [{ id: 'M1', title: 'Project map' }, { id: 'M2', title: 'Phone polish' }],
  }, null, 2));
  write('fixture-board/units.tsv', TSV([
    ['unit', 'state', 'owner', 'branch', 'pr', 'milestone', 'after', 'since', 'note'],
    ['stale-merged', 'needs-myuser', '', 'feat/merged', 'push', 'M1', '', iso(50), 'say push'],
    ['stale-squash', 'needs-myuser', '', 'feat/squash', '12', 'M1', '', iso(45), 'review PR 12'],
    ['waiting-push', 'needs-myuser', '', 'feat/unpushed', 'push', 'M1', '', iso(35), 'say push'],
    ['await-rebuild', 'needs-myuser', '', 'feat/merged', 'rebuild', 'M1', '', iso(30), 'run rebuild at the Mac'],
    ['shipped', 'done', '', '', '11', 'M1', '', '', ''],
    ['map-polish', 'in-flight', 'mcp:fx-coord', 'feat/polish', '14', 'M2', '', iso(30), ''],
    ['phone-check', 'needs-myuser', '', '', '', 'M2', 'map-polish', '', 'look at the phone shots'],
    ['old-stall', 'in-flight', 'worker (opus high)', 'feat/old', '', 'M2', '', iso(600), ''],
    ['ghost', 'queued', '', '', '', 'M2', 'nope', '', ''],
    ['Bad Row', 'queued', '', '', '', 'M2', '', '', ''],
    ['short', 'queued'],
  ]));
  write('fixture-board/ledger.tsv', TSV([
    ['ts', 'unit', 'pr', 'head_sha', 'verdict', 'verifier', 'evidence'],
    [epoch(90), 'shipped', '11', 'aaa', 'merged', 'coordinator', ''],
    [epoch(20), 'map-polish', '14', 'bbb', 'approve r1', 'opus', ''],
  ]));
  write('fixture-docs/lane.json', JSON.stringify({ priority: 2, orchestrator_thread: 'mcp:fx-gone' }, null, 2));
  write('fixture-docs/units.tsv', TSV([
    ['unit', 'state', 'owner', 'branch', 'pr', 'milestone', 'after', 'since', 'note'],
    ['docs-pass', 'review', 'mcp:fx-quiet', 'docs/pass', '', '', '', iso(20), ''],
    ['research', 'queued', '', '', '', '', 'docs-pass', '', ''],
  ]));
  write('fixture-legacy/state/units.tsv', TSV([['unit', 'owner', 'status', 'branch', 'notes']]));

  // ---- dotfiles-autoupdate state: a healthy sync and a failed switch (the alarm) ----
  const home = path.join(dir, 'home');
  const daemon = path.join(dir, 'daemon');
  fs.mkdirSync(path.join(home, '.local/state/dotfiles-autoupdate'), { recursive: true });
  fs.mkdirSync(daemon);
  fs.writeFileSync(path.join(home, '.local/state/dotfiles-autoupdate/sync.status'),
    `installed\t${epoch(20_000)}\nok\t${epoch(120)}\nran\t${epoch(120)}\n`);
  fs.writeFileSync(path.join(daemon, 'status'), `installed\t${epoch(20_000)}\nok\t${epoch(1_500)}\nran\t${epoch(60)}\n`
    + 'fail\tswitch to 1a2b3c4d5e6f exited 1 (fixture)\n'
    + `note\tmacos\t${epoch(300)}\t0\tmacOS 27.0.1 is available (fixture)\n`);

  return {
    env: {
      AGENT_BOARD_T3_DB: t3,
      AGENT_BOARD_CLAUDE_PROJECTS: logs,
      AGENT_BOARD_LANES: lanes,
      AUTOUPDATE_HOME: home,
      AUTOUPDATE_DAEMON_DIR: daemon,
      AUTOUPDATE_LAVISH_URL: 'http://127.0.0.1:9', // nothing listens there, so the Lavish check stays quiet
      AUTOUPDATE_SILL_APP: path.join(dir, 'no-sill.app'),
    },
    files: { units: path.join(lanes, 'fixture-board/units.tsv'), updater: path.join(daemon, 'status') },
  };
}
