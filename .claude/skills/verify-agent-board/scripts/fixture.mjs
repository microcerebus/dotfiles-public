// Seed data for a fixture run of the agent board (board.mjs launch --fixture). It writes, under one scratch directory:
// a T3 database with the tables and columns files/bin/agent-board.mjs reads, Claude Code logs, three orchestrator lanes
// with a small git checkout for the stale-row check, a stub gh whose PR answers live in editable JSON files, and
// dotfiles-autoupdate state with one alarm. Every time is
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

// A counts-only copy of the three-lane map shape that exposed the wide-layout bug.
// Pass a fresh directory, separate from the normal fixture lanes. No real unit titles or lane identifiers.
export function seedMapShape(dir, now = Date.now()) {
  const names = ['fixture-board', 'fixture-spruce', 'fixture-willow'];
  for (const [i, [total, active]] of [[51, 22], [17, 8], [106, 35]].entries()) {
    const lane = path.join(dir, names[i]);
    fs.mkdirSync(lane, { recursive: true });
    fs.writeFileSync(path.join(lane, 'lane.json'), JSON.stringify({ priority: i + 1,
      milestones: [{ id: 'M1', title: 'Fixture work' }] }));
    const rows = [['unit', 'state', 'owner', 'branch', 'pr', 'milestone', 'after', 'since', 'note']];
    for (let j = 0; j < total; j++) rows.push([`sample-${j + 1}`, j < active ? 'queued' : 'done',
      '', '', '', 'M1', '', '', '']);
    fs.writeFileSync(path.join(lane, 'units.tsv'), TSV(rows));
    const at = new Date(now);
    fs.utimesSync(path.join(lane, 'units.tsv'), at, at);
  }
}

// The stub gh's answer for one repo: the PRs as GitHub's GraphQL returns them, in gh/prs-<name>.json.
const check = (name, result, url = `https://ci.example/${name}`) => ({
  __typename: 'CheckRun', name, status: result === 'PENDING' ? 'IN_PROGRESS' : 'COMPLETED', conclusion: result === 'PENDING' ? null : result, detailsUrl: url,
});
function ghPr(now, repo, number, title, body, { draft = false, state = 'OPEN', mergeState = 'CLEAN', mergeable = 'MERGEABLE', review = '', checks = [], preview = null, head = 'c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1', branch = 'feat/x', mergedAt = null } = {}) {
  return {
    number, title, url: `https://github.com/example/${repo}/pull/${number}`, isDraft: draft, state, mergedAt, mergeable, mergeStateStatus: mergeState,
    reviewDecision: review, headRefOid: head, headRefName: branch, baseRefName: 'main', updatedAt: new Date(now - 15 * 60_000).toISOString(), body,
    commits: { nodes: [{ commit: {
      statusCheckRollup: checks.length ? { state: checks.some((c) => c.conclusion === 'FAILURE') ? 'FAILURE' : checks.some((c) => !c.conclusion) ? 'PENDING' : 'SUCCESS', contexts: { nodes: checks } } : null,
      deployments: { nodes: preview ? [{ environment: 'Preview', latestStatus: { state: 'SUCCESS', environmentUrl: preview } }] : [] },
    } }] },
  };
}
const ghAnswer = (gh, name, prs) => fs.writeFileSync(path.join(gh, `prs-${name}.json`),
  `${JSON.stringify({ data: { repository: Object.fromEntries(prs.map((p) => [`p${p.number}`, p])) } }, null, 2)}\n`);

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
  db.prepare("INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('mcp:fx-release', 'command', 'pending', ?, NULL)").run(iso(4));
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
    ['preview-live', 'in-flight', 'mcp:fx-warn', 'feat/preview', '16', 'M2', '', iso(10), 'one check still running; flip it in gh/prs-board.json'],
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
    ['docs-pass', 'in-flight', 'mcp:fx-quiet', 'docs/pass', '', '', '', iso(20), 'in review'],
    ['research', 'queued', '', '', '', '', 'docs-pass', '', ''],
  ]));
  write('fixture-legacy/state/units.tsv', TSV([['unit', 'owner', 'status', 'branch', 'notes']]));
  // A job-tracker-shaped lane: the ledger and review budgets under state/, one row in a state the board does not
  // know, a PR blocker that names the owner, and lane files untouched for two days.
  const days = (n) => n * 24 * 60;
  write('fixture-jobs/lane.json', JSON.stringify({
    priority: 3, repo: 'example/jobs', github: true, orchestrator_thread: 'mcp:fx-hot', milestones: [{ id: 'J1', title: 'Leads' }],
  }, null, 2), days(2));
  write('fixture-jobs/units.tsv', TSV([
    ['unit', 'state', 'owner', 'branch', 'pr', 'milestone', 'after', 'since', 'note'],
    ['leads', 'in-flight', 'mcp:fx-hot', 'feat/leads', '7', 'J1', '', iso(days(2)), 'hosted walkthrough next'],
    ['exports', 'in-progress', '', 'feat/exports', '', 'J1', '', iso(days(2)), 'a state the board does not know'],
    ['apply', 'paused', '', 'feat/apply', '8', 'J1', 'leads', iso(days(2)), 'waits for the batch'],
  ]), days(2));
  write('fixture-jobs/state/ledger.tsv', TSV([
    ['pr', 'head', 'verdict', 'by', 'at', 'notes'],
    ['7', 'aaa1111', 'approve r1', 'fable', '09:10', 'reviews/pr7.md'],
    ['8', 'bbb2222', 'changes r1', 'opus', '09:40', 'reviews/pr8.md'],
  ]), days(2));
  write('fixture-jobs/state/review-scope-ledger.json', JSON.stringify({
    prs: {
      7: { priorIndependentRoundsUsed: 2, extraReviewAllowance: 1, independentApprovedHead: 'aaa1111aaa1111aaa1111aaa1111aaa1111aaa11111', mergeBlockers: ['hosted walkthrough on aaa1111'] },
      8: { priorIndependentRoundsUsed: 1, extraReviewAllowance: 0, independentApprovedHead: null, mergeBlockers: ['the owner picks the job batch (order 56)', 'rebase after #7'] },
    },
  }, null, 2), days(2));

  // ---- gh: a stub that answers the board's one GraphQL query per repo from gh/prs-<repo>.json ----
  const gh = path.join(dir, 'gh');
  fs.mkdirSync(gh, { recursive: true });
  fs.writeFileSync(path.join(gh, 'gh'), '#!/bin/sh\n# Stub gh for the agent board fixture: prints gh/prs-<name>.json for the -f name=<name> argument.\n'
    + 'for a in "$@"; do case "$a" in name=*) exec cat "$(dirname "$0")/prs-${a#name=}.json";; esac; done\necho "no repo" >&2; exit 1\n', { mode: 0o755 });
  const pr = (...args) => ghPr(now, 'board', ...args);
  const answer = (name, prs) => ghAnswer(gh, name, prs);
  answer('board', [
    pr(12, 'feat: squash work (fixture)', '## Summary\n\nSquashed into main already; the row that names it is stale.', { state: 'MERGED', mergedAt: iso(45), head: 'd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1', branch: 'feat/squash' }),
    pr(14, 'feat(map): polish the unit rows (fixture)', '## Context\n\nThe unit rows clip their notes on a phone, so the owner cannot read what a unit waits for.\n\n## Solution\n\nWrap every line.',
      { mergeState: 'BLOCKED', checks: [check('build', 'SUCCESS'), check('lint', 'FAILURE'), check('e2e', 'SUCCESS'), check('verify-agent-board / fixture flows and phone shots (390 and 1440)', 'SUCCESS')], preview: 'https://board-git-feat-polish.example.app', head: 'bbb0000bbb0000bbb0000bbb0000bbb0000bbb00000', branch: 'feat/polish' }),
    pr(16, 'feat(map): live check status (fixture)', 'Shows each check as it finishes, so the map reads like the PR page.',
      { mergeState: 'BLOCKED', checks: [check('build', 'SUCCESS'), check('e2e', 'PENDING')], preview: 'https://board-git-feat-preview.example.app', head: 'eee1111eee1111eee1111eee1111eee1111eee11111', branch: 'feat/preview' }),
  ]);
  answer('jobs', [
    pr(7, 'feat(leads): add the Leads screen (fixture)', '## Context / problem\n\nThe private workspace needs a usable list of roles to open and track.\n\n## Solution\n\nLeads and Applied tabs.',
      { mergeState: 'BLOCKED', checks: [check('verify', 'SUCCESS'), check('preview', 'PENDING')], preview: 'https://jobs-git-feat-leads.example.app', head: 'aaa1111aaa1111aaa1111aaa1111aaa1111aaa11111', branch: 'feat/leads' }),
    pr(8, 'feat(apply): prototype the form helper (fixture)', 'Merges after the leads screen.', { draft: true, mergeState: 'BEHIND', checks: [check('verify', 'SUCCESS'), check('typecheck', 'FAILURE')], head: 'ccc3333ccc3333ccc3333ccc3333ccc3333ccc33333', branch: 'feat/apply' }),
  ]);

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
      AUTOUPDATE_SILL_APP: path.join(dir, 'no-sill.app'),
      AGENT_BOARD_GH: path.join(gh, 'gh'),
      AGENT_BOARD_OWNER: 'the owner', // the fixture's review ledger names the owner by given name
      AGENT_BOARD_PR_TTL_MS: '3000', // so an edited gh answer shows on the page's next self-refresh
    },
    files: { units: path.join(lanes, 'fixture-board/units.tsv'), updater: path.join(daemon, 'status'), prs: path.join(gh, 'prs-board.json') },
  };
}

// ---- The map's Stuck journeys (flows/map-stuck.mjs) ----
// Each scenario is a whole lanes directory for a fixture run, with the stub gh's answer for its repo, and the Stuck
// rows (oldest first) and Needs you count /map must show for it. The owners are the seeded T3 threads: fx-settled is
// closed, so a reference to it has no owner thread, and fx-idle-child is open but hidden from the thread list. The short
// owner notes, "(opus high)" and "(c25 queue prep)", stay whole on a phone; child-owned's note is longer than a phone
// line and wraps as prose.
const STUCK_ROWS = {
  'sign-off': ['needs-myuser', 'mcp:fx-design', '', 25, 'approve the Stuck list wording'],
  'old-stall': ['in-flight', 'mcp:fx-coord', '21', 600, 'the lint fix keeps slipping'],
  'paused-spike': ['paused', 'worker (opus high)', '', 180, 'waits for a design call'],
  orphan: ['in-flight', '', '', 40, 'its worker hit a usage limit'],
  'draft-fail': ['in-flight', 'mcp:fx-warn', '22', 20, ''],
  'lost-ref': ['queued', 'mcp:fx-settled (c25 queue prep)', '', null, ''],
  'child-owned': ['in-flight', 'mcp:fx-idle-child (kept by the c24 review until its coordinator picks the next unit up)', '', 30, 'held by a finished child, still open'],
  healthy: ['in-flight', 'mcp:fx-quiet', '23', 15, ''],
};
const fixed = {
  'old-stall': ['done', 'mcp:fx-coord', '21', 2, ''],
  orphan: ['in-flight', 'mcp:fx-warn', '', 40, 'picked up again'],
};
const calm = {
  ...fixed,
  'paused-spike': ['in-flight', 'worker (opus high)', '', 60, 'design call made'],
  'lost-ref': ['queued', 'mcp:fx-coord', '', null, ''],
};
export const STUCK_SCENARIOS = {
  initial: { rows: STUCK_ROWS, checks: 'failing', stuck: ['old-stall', 'paused-spike', 'orphan', 'draft-fail', 'lost-ref'], needs: 2 },
  resolved: { rows: { ...STUCK_ROWS, ...fixed }, checks: 'passing', stuck: ['paused-spike', 'lost-ref'], needs: 2 },
  // Standing work: a healthy recurring unit days old is not stuck; one without an owner, one whose owner thread closed
  // and one whose draft PR fails a check are.
  recurring: { rows: { ...STUCK_ROWS, ...calm, 'nightly-sweep': ['recurring', 'mcp:fx-coord', '', 4320, 'runs every night'],
    'weekly-digest': ['recurring', '', '', 2880, 'its scheduler thread was archived'], 'queue-prep': ['recurring', 'mcp:fx-settled (c25 queue prep)', '', 1440, ''],
    'dep-bumps': ['recurring', 'mcp:fx-warn', '24', 180, ''] }, checks: 'passing', stuck: ['weekly-digest', 'queue-prep', 'dep-bumps'], needs: 2 },
  empty: { rows: { ...STUCK_ROWS, ...calm }, checks: 'passing', stuck: [], needs: 2, line: 'Nothing stuck' },
  // The same calm lane with one unreadable row and no answer from GitHub: the list says what it could not check.
  degraded: { rows: { ...STUCK_ROWS, ...calm, 'Bad Row': ['queued', '', '', null, ''] }, checks: 'missing', stuck: [], needs: 2,
    line: 'Could not check for stuck work: fixture-stuck has 1 unreadable row; GitHub did not answer for fixture-stuck.' },
  // Three lanes of trouble, 15 stuck units: the first five show and the rest fold under "10 more stuck".
  crowded: { rows: STUCK_ROWS, checks: 'failing', copies: 3, needs: 4,
    stuck: ['old-stall', 'paused-spike', 'orphan', 'draft-fail', 'lost-ref'].flatMap((id) => [id, `${id}-2`, `${id}-3`]) },
};

export function seedStuck(dir, name, now = Date.now()) {
  const scenario = STUCK_SCENARIOS[name];
  if (!scenario) throw new Error(`no Stuck scenario ${name}; scenarios: ${Object.keys(STUCK_SCENARIOS).join(', ')}`);
  const iso = (min) => (min === null ? '' : new Date(now - min * 60_000).toISOString());
  const lanes = path.join(dir, 'lanes');
  fs.rmSync(lanes, { recursive: true, force: true });
  for (let copy = 1; copy <= (scenario.copies ?? 1); copy++) {
    const suffix = copy === 1 ? '' : `-${copy}`;
    const lane = path.join(lanes, `fixture-stuck${suffix}`);
    fs.mkdirSync(lane, { recursive: true });
    fs.writeFileSync(path.join(lane, 'lane.json'), JSON.stringify({ priority: copy, repo: `example/${scenario.checks === 'missing' ? 'missing' : 'stuck'}`,
      github: true, coordinator_thread: 'mcp:fx-coord', milestones: [{ id: 'S1', title: 'Stuck list' }] }, null, 2));
    // Only the first lane's sign-off takes the design thread's place; the copies' sign-offs are their own items.
    fs.writeFileSync(path.join(lane, 'units.tsv'), TSV([['unit', 'state', 'owner', 'branch', 'pr', 'milestone', 'after', 'since', 'note'],
      ...Object.entries(scenario.rows).map(([id, [state, owner, pr, min, note]]) => [`${id}${id === 'Bad Row' ? '' : suffix}`, state,
        id === 'sign-off' && copy > 1 ? '' : owner, `feat/${id.replace(' ', '-').toLowerCase()}`, pr, 'S1', '', iso(min), note])]));
  }
  const result = scenario.checks === 'failing' ? 'FAILURE' : 'SUCCESS';
  const gh = path.join(dir, 'gh');
  ghAnswer(gh, 'stuck', [
    ghPr(now, 'stuck', 21, 'fix(map): the long-running lint fix (fixture)', 'Keeps failing lint.', { mergeState: 'BLOCKED',
      checks: [check('build', 'SUCCESS'), check('lint', result)], preview: 'https://stuck-git-old-stall.example.app', branch: 'feat/old-stall' }),
    ghPr(now, 'stuck', 22, 'feat(map): draft with a failing typecheck (fixture)', 'Still a draft.', { draft: true,
      checks: [check('typecheck', result)], branch: 'feat/draft-fail' }),
    ghPr(now, 'stuck', 23, 'feat(map): healthy work in review (fixture)', 'Checks still running.', { mergeState: 'BLOCKED',
      checks: [check('build', 'SUCCESS'), check('e2e', 'PENDING')], branch: 'feat/healthy' }),
    ghPr(now, 'stuck', 24, 'chore(deps): this week\'s bumps (fixture)', 'Opened by the recurring dependency job.', { draft: true,
      checks: [check('typecheck', 'FAILURE')], branch: 'feat/dep-bumps' }),
  ]);
  return { lanes, prs: path.join(gh, 'prs-stuck.json') };
}
