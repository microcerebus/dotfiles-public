// Run: node --test tests/verify_agent_board_test.mjs
// Tests the verify-agent-board helper (.claude/skills/verify-agent-board/scripts/board.mjs) on a copy of the files it
// runs, with its state in a temp dir, so nothing touches the live board, ~/.local/state or the real data.
// The helper comes first: doctor checks the agent Chrome, and must find a dead port, not the live gate on 9333.
import './lib/agent-chrome-test-env.cjs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = '.claude/skills/verify-agent-board/scripts';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-agent-board-'));
const STATE = path.join(tmp, 'state');

// A checkout with only the files a run needs, laid out as in the repo.
function checkout(name) {
  const root = path.join(tmp, name);
  for (const file of ['files/bin/agent-board.mjs', 'scripts/dotfiles-autoupdate', `${SKILL}/board.mjs`, `${SKILL}/fixture.mjs`, `${SKILL}/git-env.mjs`,
    ...['map-stuck', 'look', 'line-starts', 'playwright', 'viewports'].map((flow) => `${SKILL}/flows/${flow}.mjs`)]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(REPO, file), path.join(root, file));
  }
  return root;
}
const A = checkout('a');
const B = checkout('b');
// A stub tailscale, so no test reads or changes the tailnet's serve config. Its MagicDNS name is localhost, which the
// board allows, so the phone URL of a published run answers on loopback, standing in for tailscale's proxy.
const CALLS = path.join(tmp, 'tailscale-calls');
const TAILSCALE = path.join(tmp, 'tailscale');
fs.writeFileSync(TAILSCALE, `#!/bin/sh\necho "$*" >> '${CALLS}'\n[ "$1" = status ] && echo '{"Self":{"DNSName":"localhost."}}'\nexit 0\n`);
fs.chmodSync(TAILSCALE, 0o755);
const tailscaleCalls = () => { try { return fs.readFileSync(CALLS, 'utf8').trimEnd().split('\n'); } catch { return []; } };

const boardWithEnv = (extraEnv, root, ...args) => {
  const run = spawnSync(process.execPath, ['--no-warnings', path.join(root, SKILL, 'board.mjs'), ...args], {
    env: { ...process.env, VERIFY_AGENT_BOARD_TAILSCALE: TAILSCALE, ...extraEnv, VERIFY_AGENT_BOARD_STATE: STATE }, encoding: 'utf8', timeout: 60_000,
  });
  return { code: run.status, out: run.stdout + run.stderr };
};
const board = (root, ...args) => boardWithEnv({}, root, ...args);
const runs = () => fs.readdirSync(STATE).filter((id) => fs.existsSync(path.join(STATE, id, 'run.json')))
  .map((id) => JSON.parse(fs.readFileSync(path.join(STATE, id, 'run.json'), 'utf8')));
const latest = () => runs().sort((x, y) => x.startedAt.localeCompare(y.startedAt)).at(-1);
// The pids come from run.json, so each must be one the test may signal:
// kill(0) or a negative pid would reach a whole process group.
const realPid = (pid) => Number.isInteger(pid) && pid > 1;
const alive = (pid) => { if (!realPid(pid)) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const signal = (pid, name) => { assert.ok(realPid(pid), `pid ${pid}`); process.kill(pid, name); };
const until = async (what, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!what()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

after(() => {
  for (const r of fs.existsSync(STATE) ? runs() : []) for (const pid of [r.keeperPid, r.boardPid]) if (alive(pid)) process.kill(pid);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('fixture launch and documented Git mutations leave an external repo untouched under hostile Git env', async () => {
  const external = path.join(tmp, 'external');
  fs.mkdirSync(external);
  const git = (...args) => {
    const result = spawnSync('git', ['-C', external, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-qb', 'main');
  fs.writeFileSync(path.join(external, 'a'), 'external content\n');
  git('add', 'a');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'external baseline');
  fs.writeFileSync(path.join(external, 'b'), 'second external commit\n');
  git('add', 'b');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'external second commit');
  git('update-ref', 'refs/remotes/origin/main', 'main~1');
  fs.appendFileSync(path.join(external, 'a'), 'unstaged work\n');
  const snapshot = () => Object.fromEntries(fs.readdirSync(external, { recursive: true }).sort()
    .filter((file) => fs.statSync(path.join(external, file)).isFile())
    .map((file) => [file, createHash('sha256').update(fs.readFileSync(path.join(external, file))).digest('hex')]));
  const before = snapshot();
  const hostileEnv = { GIT_DIR: path.join(external, '.git'), GIT_WORK_TREE: external,
    GIT_INDEX_FILE: path.join(external, '.git/index'), GIT_COMMON_DIR: path.join(external, '.git') };
  try {
    const launched = boardWithEnv(hostileEnv, A, 'launch', '--fixture', '--ttl', '5');
    assert.deepEqual(snapshot(), before, 'fixture launch changed external refs, index or worktree');
    assert.equal(launched.code, 0, launched.out);
    assert.equal(latest().head, null, 'launch revision came from the external repo');
    const map = await (await fetch(`${latest().urls.local}/map`)).text();
    assert.equal(map.match(/class="stale"/g)?.length, 2, 'board Git calls used the external repo');
    const recipe = fs.readFileSync(path.join(REPO, '.claude/skills/verify-agent-board/features/stale-rows.md'), 'utf8');
    for (const [step, count] of [['Branch lands', 3], ['Undo', 2]]) {
      const line = recipe.split('\n').find((text) => text.startsWith(`- **${step}.**`));
      const command = line?.match(/Run `([^`]+)`/)?.[1];
      assert.ok(command, `missing actual recipe command for ${step}`);
      const result = spawnSync('/bin/sh', ['-c', command], { cwd: A, encoding: 'utf8',
        env: { ...process.env, ...hostileEnv, BOARD_SCRATCH: latest().scratch } });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(snapshot(), before, `${step} recipe changed external refs, index or worktree`);
      const changedMap = await (await fetch(`${latest().urls.local}/map`)).text();
      assert.equal(changedMap.match(/class="stale"/g)?.length, count, `${step} did not change fixture refs`);
    }
  } finally {
    board(A, 'stop');
  }
  assert.deepEqual(snapshot(), before, 'board children or cleanup changed the external repo');
});

test('orphan stop waits for a suspended owned board to exit before deleting scratch', async () => {
  assert.equal(board(A, 'launch', '--fixture', '--ttl', '5').code, 0);
  const run = latest();
  let stopping;
  try {
    signal(run.keeperPid, 'SIGKILL');
    await until(() => !alive(run.keeperPid));
    signal(run.boardPid, 'SIGSTOP');
    stopping = spawn(process.execPath, ['--no-warnings', path.join(A, SKILL, 'board.mjs'), 'stop', run.runId], {
      env: { ...process.env, VERIFY_AGENT_BOARD_STATE: STATE }, stdio: 'pipe',
    });
    const done = once(stopping, 'exit');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(latest().boardPid, run.boardPid, 'cleared PID before the suspended board exited');
    assert.equal(latest().stoppedAt, null);
    assert.equal(fs.existsSync(run.scratch), true, 'deleted scratch before the board exited');
    assert.deepEqual(await done, [0, null]);
    await until(() => !alive(run.boardPid));
    assert.equal(latest().boardPid, null);
    assert.equal(fs.existsSync(run.scratch), false);
  } finally {
    if (alive(run.boardPid)) signal(run.boardPid, 'SIGKILL');
    if (stopping && stopping.exitCode === null) stopping.kill('SIGKILL');
  }
});

test('orphan stop preserves PID and scratch when listener ownership is lost before escalation', async () => {
  const root = checkout('loses-listener');
  // A TERM-resistant board that drops its listener but remains alive.
  fs.writeFileSync(path.join(root, 'files/bin/agent-board.mjs'), `
    import http from 'node:http';
    const port = Number(process.env.AGENT_BOARD_PORT);
    const server = http.createServer((req, res) => res.end(req.url === '/map'
      ? '<title>project map</title>fixture-board'
      : '<title>agent board</title>Coordinator 3 (fixture)'));
    server.listen(port, '127.0.0.1', () => console.log('listening on 127.0.0.1:' + port));
    process.on('SIGTERM', () => { server.close(); server.closeAllConnections(); });
    setInterval(() => {}, 1000);
  `);
  assert.equal(board(root, 'launch', '--fixture', '--ttl', '5').code, 0);
  const run = latest();
  try {
    signal(run.keeperPid, 'SIGKILL');
    await until(() => !alive(run.keeperPid));
    const stopped = board(root, 'stop', run.runId);
    assert.equal(stopped.code, 2, stopped.out);
    assert.match(stopped.out, /cannot confirm board ownership.*PID and scratch retained/);
    assert.ok(alive(run.boardPid));
    assert.equal(latest().boardPid, run.boardPid);
    assert.equal(latest().stoppedAt, null);
    assert.equal(fs.existsSync(run.scratch), true);
  } finally {
    signal(run.boardPid, 'SIGKILL');
    await until(() => !alive(run.boardPid));
    assert.equal(board(root, 'stop', run.runId).code, 0);
  }
});

test('a fixture run launches, passes doctor, survives a board edit, and stops keeping its evidence', async () => {
  const git = (...args) => {
    const result = spawnSync('git', ['-C', A, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-qb', 'main');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'launch revision');
  const launchHead = git('rev-parse', '--short', 'HEAD');
  const launched = board(A, 'launch', '--fixture', '--ttl', '5');
  assert.equal(launched.code, 0, launched.out);
  assert.match(launched.out, /launched \S+ \(fixture data\)/);
  const run = latest();
  assert.notEqual(run.port, 4790);

  const doctor = board(A, 'doctor');
  assert.equal(doctor.code, 0, doctor.out);
  assert.match(doctor.out, /ok {3}pages: \/ and \/map render the fixture data/);
  assert.match(doctor.out, new RegExp(`ok {3}bind: the board listens on 127\\.0\\.0\\.1:${run.port}, loopback only`));
  assert.match(doctor.out, new RegExp(`ok {3}magicdns host: / with Host localhost:${run.port}, as tailscale serve forwards it, answered 200`));
  assert.equal(run.urls.phone, null, 'a run that was not published has no phone URL');
  assert.ok(tailscaleCalls().every((c) => !c.startsWith('serve')), 'an unpublished run never calls tailscale serve');
  const map = await (await fetch(`${run.urls.local}/map`)).text();
  assert.equal(map.match(/class="stale"/g).length, 2, "the two stale rows, in their lane only");

  // The Stuck journeys' dry run prints the plan and changes nothing in the scratch data.
  const lanes = path.join(run.scratch, 'lanes');
  const lanesHash = () => createHash('sha256').update(fs.readdirSync(lanes, { recursive: true }).sort()
    .map((f) => (fs.statSync(path.join(lanes, f)).isFile() ? `${f}\0${fs.readFileSync(path.join(lanes, f), 'utf8')}` : f)).join('\0')).digest('hex');
  const lanesBefore = lanesHash();
  const plan = board(A, 'verify-stuck', '--dry-run', '--json');
  assert.equal(plan.code, 0, plan.out);
  assert.deepEqual(JSON.parse(plan.out).scenarios.map((s) => s.name), ['initial', 'resolved', 'recurring', 'empty', 'degraded', 'crowded']);
  assert.equal(lanesHash(), lanesBefore);
  assert.equal(fs.existsSync(path.join(run.scratch, 'lanes-seeded')), false);

  // One run per checkout.
  const again = board(A, 'launch');
  assert.equal(again.code, 1);
  assert.match(again.out, /still up/);

  // An edit makes the board exit; the keeper restarts it on the new code, on the same port.
  fs.appendFileSync(path.join(A, 'files/bin/agent-board.mjs'), '// edited\n');
  await until(() => latest().boardPid && latest().boardPid !== run.boardPid && alive(latest().boardPid));
  await until(() => fs.readFileSync(run.log, 'utf8').split(`listening on 127.0.0.1:${run.port}`).length === 3);
  const edited = board(A, 'doctor');
  assert.equal(edited.code, 0, edited.out);
  assert.match(edited.out, /with uncommitted edits/);
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'current revision');
  const currentHead = git('rev-parse', '--short', 'HEAD');
  assert.notEqual(currentHead, launchHead);
  const changed = boardWithEnv({ GIT_DIR: path.join(tmp, 'external/.git'), GIT_WORK_TREE: path.join(tmp, 'external'),
    GIT_INDEX_FILE: path.join(tmp, 'external/.git/index') }, A, 'doctor');
  assert.equal(changed.code, 0, changed.out);
  assert.match(changed.out, new RegExp(`launch HEAD ${launchHead}; current HEAD ${currentHead}`));
  assert.doesNotMatch(changed.out, /with uncommitted edits/);

  fs.writeFileSync(path.join(run.evidence, 'proof.txt'), 'kept\n');
  const stopped = board(A, 'stop');
  assert.equal(stopped.code, 0, stopped.out);
  assert.match(stopped.out, /evidence kept at .* \(1 files\)/);
  assert.equal(fs.existsSync(run.scratch), false);
  assert.equal(fs.readFileSync(path.join(run.evidence, 'proof.txt'), 'utf8'), 'kept\n');
  assert.equal(alive(latest().keeperPid), false);
  await assert.rejects(fetch(`${run.urls.local}/`));
  const afterStop = board(A, 'doctor');
  assert.equal(afterStop.code, 1);
  assert.match(afterStop.out, /the run stopped .*: stopped by board\.mjs stop/);
});

test('a published run has the board publish itself with tailscale serve, and stopping it removes that handler', async () => {
  const C = checkout('c');
  const launched = board(C, 'launch', '--fixture', '--publish', '--ttl', '5');
  assert.equal(launched.code, 0, launched.out);
  const run = latest();
  assert.equal(run.published, true);
  assert.equal(run.urls.phone, `http://localhost:${run.port}`);
  assert.match(launched.out, new RegExp(`phone {5}http://localhost:${run.port}/map`));
  assert.ok(tailscaleCalls().includes(`serve --bg --http=${run.port} http://127.0.0.1:${run.port}`), tailscaleCalls().join('\n'));
  const doctor = board(C, 'doctor');
  assert.equal(doctor.code, 0, doctor.out);
  assert.match(doctor.out, new RegExp(`ok {3}bind: the board listens on 127\\.0\\.0\\.1:${run.port}, loopback only`));
  assert.match(doctor.out, new RegExp(`ok {3}tailnet: http://localhost:${run.port}/ through tailscale serve answered 200`));
  const stopped = board(C, 'stop');
  assert.equal(stopped.code, 0, stopped.out);
  assert.ok(tailscaleCalls().includes(`serve --http=${run.port} off`), tailscaleCalls().join('\n'));
  assert.match(fs.readFileSync(run.log, 'utf8'), new RegExp(`removed the tailscale serve handler on port ${run.port}`));
  assert.ok(tailscaleCalls().every((c) => !c.includes('4790')), 'never the live board\'s port');
});

test('doctor refuses the live board, a port this checkout did not launch, and another checkout\'s run', async () => {
  const live = board(A, 'doctor', '--port', '4790');
  assert.equal(live.code, 2);
  assert.match(live.out, /refusing: port 4790 is the live agent board/);

  const other = net.createServer().listen(0, '127.0.0.1');
  await once(other, 'listening');
  try {
    const foreign = board(A, 'doctor', '--port', String(other.address().port));
    assert.equal(foreign.code, 2);
    assert.match(foreign.out, new RegExp(`refusing: no run from this checkout listens on ${other.address().port} \\(pid ${process.pid}: `));
  } finally {
    other.close();
  }

  assert.equal(board(A, 'launch', '--fixture', '--ttl', '5').code, 0);
  const run = latest();
  try {
    const fromB = board(B, 'doctor', run.runId);
    assert.equal(fromB.code, 2);
    assert.match(fromB.out, /refusing: run \S+ was started from .*\/a, not this checkout/);
    assert.equal(board(B, 'stop', run.runId).code, 2);
    assert.ok(alive(run.keeperPid));
  } finally {
    assert.equal(board(A, 'stop').code, 0);
  }
});

test('stop signals only processes the run started', async () => {
  assert.equal(board(A, 'launch', '--fixture', '--ttl', '5').code, 0);
  const run = latest();
  // The keeper and board are gone and their pids now belong to someone else.
  const stranger = spawn('/bin/sleep', ['30']);
  try {
    signal(run.keeperPid, 'SIGKILL');
    signal(run.boardPid, 'SIGKILL');
    await until(() => !alive(run.boardPid));
    const file = path.join(run.dir, 'run.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), keeperPid: stranger.pid, boardPid: stranger.pid }));
    const stopped = board(A, 'stop');
    assert.equal(stopped.code, 2, stopped.out);
    assert.match(stopped.out, /cannot confirm board ownership/);
    await new Promise((resolve) => setTimeout(resolve, 300)); // a killed child is reaped, and reports it, asynchronously
    assert.deepEqual([stranger.exitCode, stranger.signalCode], [null, null], 'stop killed a process the run did not start');
    assert.equal(fs.existsSync(run.scratch), true);
    assert.equal(latest().boardPid, stranger.pid);
    assert.equal(latest().stoppedAt, null);
  } finally {
    stranger.kill();
  }
});

test('a run stops itself when its TTL runs out', async () => {
  assert.equal(board(A, 'launch', '--fixture', '--ttl', '0.05').code, 0);
  const run = latest();
  await until(() => latest().stoppedAt, 20_000);
  assert.equal(latest().stopReason, 'its TTL ran out');
  assert.equal(fs.existsSync(run.scratch), false);
  await until(() => !alive(run.keeperPid), 5_000); // the keeper records the stop, then exits
});

// Live data under a temp HOME, laid out like job-tracker: fixture-board/units.tsv links to state/units.tsv.
async function liveHome(name) {
  const home = path.join(tmp, name);
  const { seed } = await import(path.join(REPO, SKILL, 'fixture.mjs'));
  const { env } = seed(path.join(tmp, `${name}-seed`));
  fs.mkdirSync(path.join(home, '.t3/userdata'), { recursive: true });
  fs.copyFileSync(env.AGENT_BOARD_T3_DB, path.join(home, '.t3/userdata/statev2.sqlite'));
  fs.cpSync(env.AGENT_BOARD_CLAUDE_PROJECTS, path.join(home, '.claude/projects'), { recursive: true });
  const lanes = path.join(home, 'orchestrator/lanes');
  fs.cpSync(env.AGENT_BOARD_LANES, lanes, { recursive: true });
  const live = path.join(lanes, 'fixture-board/state/units.tsv');
  fs.mkdirSync(path.dirname(live));
  fs.renameSync(path.join(lanes, 'fixture-board/units.tsv'), live);
  fs.symlinkSync('state/units.tsv', path.join(lanes, 'fixture-board/units.tsv'));
  return { home, lanes, live };
}

test('a lanes copy holds real files, so editing it never writes through a symlink to the live lanes', async () => {
  const { home, live } = await liveHome('home-link');
  const before = fs.readFileSync(live, 'utf8');
  const launched = boardWithEnv({ HOME: home }, A, 'launch', '--lanes-copy', '--ttl', '5');
  try {
    assert.equal(launched.code, 0, launched.out);
    const copy = path.join(latest().scratch, 'lanes/fixture-board/units.tsv');
    assert.equal(fs.lstatSync(copy).isSymbolicLink(), false, 'the copy links back into the live lanes');
    assert.equal(fs.readFileSync(copy, 'utf8'), before);
    fs.writeFileSync(copy, before.replace(/\tin-flight\t/g, '\tdone\t'));
    assert.equal(fs.readFileSync(live, 'utf8'), before, 'editing the copy changed the live file');
  } finally {
    board(A, 'stop');
  }
});

test('verify-stuck and its flow refuse a lanes-copy run before they touch its scratch', async () => {
  const { home } = await liveHome('home-stuck');
  const launched = boardWithEnv({ HOME: home }, A, 'launch', '--lanes-copy', '--ttl', '5');
  try {
    assert.equal(launched.code, 0, launched.out);
    const { scratch } = latest();
    const lanes = path.join(scratch, 'lanes');
    const snapshotOf = () => fs.readdirSync(lanes, { recursive: true }).sort()
      .map((f) => (fs.statSync(path.join(lanes, f)).isFile() ? `${f}\0${fs.readFileSync(path.join(lanes, f), 'utf8')}` : f)).join('\0');
    const before = snapshotOf();
    for (const args of [[], ['--json'], ['--dry-run', '--json']]) {
      const refused = boardWithEnv({ HOME: home }, A, 'verify-stuck', ...args);
      assert.notEqual(refused.code, 0, refused.out);
      assert.match(refused.out, /reads lanes-copy data; the Stuck journeys need: board\.mjs launch --fixture/);
    }
    // The flow keeps its own guard for a run started without board.mjs.
    const flow = spawnSync(process.execPath, [path.join(A, SKILL, 'flows/map-stuck.mjs'), '--json'],
      { env: { ...process.env, HOME: home, VERIFY_AGENT_BOARD_STATE: STATE }, encoding: 'utf8', timeout: 60_000 });
    assert.notEqual(flow.status, 0);
    assert.match(flow.stderr, /needs a fixture run, not lanes-copy/);
    assert.equal(snapshotOf(), before, 'the lanes copy changed');
    assert.deepEqual(fs.readdirSync(scratch).filter((f) => f.startsWith('lanes')), ['lanes']);
  } finally {
    board(A, 'stop');
  }
});

test('a flow runs every cleanup step in order even when one fails, and a failed body keeps its own error', async () => {
  const { withCleanUp } = await import(pathToFileURL(path.join(REPO, SKILL, 'flows/playwright.mjs')));
  const ran = [];
  const step = (name, fail) => async () => { ran.push(name); if (fail) throw new Error(`${name} failed`); };
  assert.equal(await withCleanUp(async () => 'value', step('restore')), 'value');
  ran.length = 0;
  await assert.rejects(withCleanUp(step('body'), step('restore'), step('close', true), step('tidy')), /^Error: close failed$/);
  assert.deepEqual(ran, ['body', 'restore', 'close', 'tidy']);
  ran.length = 0;
  await assert.rejects(withCleanUp(step('body', true), step('restore')), (error) => error.message === 'body failed' && !(error instanceof AggregateError));
  assert.deepEqual(ran, ['body', 'restore']);
  // A body that fails and a browser that will not close: the body's error comes first, the close failure beside it.
  ran.length = 0;
  await assert.rejects(withCleanUp(step('body', true), step('restore'), step('close', true)), (error) => error instanceof AggregateError
    && error.message === 'body failed (then: close failed)' && error.errors.map((e) => e.message).join() === 'body failed,close failed');
  assert.deepEqual(ran, ['body', 'restore', 'close']);
  // Every flow cleans up through it, and map-stuck restores the lanes before the browser closes.
  const flows = path.join(REPO, SKILL, 'flows');
  for (const flow of fs.readdirSync(flows).filter((f) => /\bchrome\(\)/.test(fs.readFileSync(path.join(flows, f), 'utf8')) && f !== 'playwright.mjs')) {
    const code = fs.readFileSync(path.join(flows, flow), 'utf8');
    assert.doesNotMatch(code, /\bfinally\b/, `${flow} cleans up in a finally, where a cleanup error replaces the body's`);
    assert.match(code, /\}, [^\n]*\(\) => browser\.close\(\)\);\n/, `${flow} closes its browser last through withCleanUp`);
  }
  assert.match(fs.readFileSync(path.join(flows, 'map-stuck.mjs'), 'utf8'), /\n\}, restoreLanes, [^\n]*\(\) => browser\.close\(\)\);\n/);
});

test('a page read that a reload interrupts is asked again on the new page; any other error stands', async (t) => {
  const { evaluateSettled } = await import(pathToFileURL(path.join(REPO, SKILL, 'flows/playwright.mjs')));
  const calls = [];
  const fake = (errors) => ({
    evaluate: async () => { calls.push('evaluate'); const e = errors.shift(); if (e) throw new Error(e); return 'read'; },
    waitForLoadState: async (state) => { calls.push(`wait ${state}`); },
  });
  assert.equal(await evaluateSettled(fake(['page.evaluate: Execution context was destroyed, most likely because of a navigation']), () => 0), 'read');
  assert.deepEqual(calls, ['evaluate', 'wait load', 'evaluate']);
  await assert.rejects(evaluateSettled(fake(['page.evaluate: ReferenceError: x is not defined']), () => 0), /ReferenceError/);
  await assert.rejects(evaluateSettled(fake(Array(3).fill('Execution context was destroyed')), () => 0), /destroyed/);
  // Every flow reads the self-refreshing board through it.
  for (const flow of fs.readdirSync(path.join(REPO, SKILL, 'flows')).filter((f) => f !== 'playwright.mjs')) {
    assert.doesNotMatch(fs.readFileSync(path.join(REPO, SKILL, 'flows', flow), 'utf8'), /\.evaluate\(/, flow);
  }

  // The real race in headless Chrome: a page that reloads once while a read is still running.
  const listed = spawnSync('pnpm', ['ls', '-g', '--depth', '0', '--json'], { encoding: 'utf8' }).stdout ?? '';
  if (!listed.includes('"playwright-core"')) return t.skip('playwright-core is not installed');
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(request.url === '/first' ? '<title>first</title><script>addEventListener("load", () => setTimeout(() => location.replace("/second"), 400))</script>' : '<title>second</title>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { chrome } = await import(pathToFileURL(path.join(REPO, SKILL, 'flows/playwright.mjs')));
  const browser = await chrome();
  try {
    const slowRead = () => new Promise((resolve) => setTimeout(() => resolve(document.title), 1500));
    const bare = await browser.newPage();
    await bare.goto(`http://127.0.0.1:${server.address().port}/first`);
    await assert.rejects(bare.evaluate(slowRead), /Execution context was destroyed/, 'the race reproduces with a bare evaluate');
    const settled = await browser.newPage();
    await settled.goto(`http://127.0.0.1:${server.address().port}/first`);
    assert.equal(await evaluateSettled(settled, slowRead), 'second');
  } finally {
    await browser.close();
    server.close();
  }
});

test('a lanes copy leaves out a directory link that loops back and anything not a file or directory', async () => {
  const { home, lanes } = await liveHome('home-loop');
  fs.symlinkSync('..', path.join(lanes, 'fixture-board/up'));
  assert.equal(spawnSync('mkfifo', [path.join(lanes, 'fixture-board/pipe')]).status, 0);
  const launched = boardWithEnv({ HOME: home }, A, 'launch', '--lanes-copy', '--ttl', '5');
  try {
    assert.equal(launched.code, 0, launched.out);
    const copied = path.join(latest().scratch, 'lanes/fixture-board');
    assert.equal(fs.existsSync(path.join(copied, 'units.tsv')), true);
    assert.equal(fs.existsSync(path.join(copied, 'up')), false, 'the loop was copied');
    assert.equal(fs.existsSync(path.join(copied, 'pipe')), false, 'the FIFO was copied');
    assert.match(launched.out, /left out of the lanes copy: fixture-board\/pipe \(not a file or directory\), fixture-board\/up \(links back to a directory being copied\)/);
  } finally {
    board(A, 'stop');
  }
});

test('look refuses the live board, a viewport it does not know, and fails on a page that did not answer 2xx', async (t) => {
  const look = (...args) => spawnSync(process.execPath, [path.join(REPO, SKILL, 'flows/look.mjs'), ...args],
    { encoding: 'utf8', timeout: 60_000 });
  const live = look('http://127.0.0.1:4790/map', path.join(tmp, 'look'), 'live', '390');
  assert.notEqual(live.status, 0);
  assert.match(live.stderr, /refusing the live board on port 4790/);
  const phoneFlag = look('http://127.0.0.1:1/map', path.join(tmp, 'look'), 'flag', '--phone');
  assert.notEqual(phoneFlag.status, 0);
  assert.match(phoneFlag.stderr, /usage: look.mjs <url> <evidence-dir> <name> \[<viewport>\|<width>\]/);
  const unknown = look('http://127.0.0.1:1/map', path.join(tmp, 'look'), 'unknown', 'ipad-pro');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /viewports: desktop-1920, small-desktop-1080, ipad-portrait-744, ipad-landscape-1133, phone-390/);

  const listed = spawnSync('pnpm', ['ls', '-g', '--depth', '0', '--json'], { encoding: 'utf8' }).stdout ?? '';
  if (!listed.includes('"playwright-core"')) return t.skip('playwright-core is not installed');
  const server = http.createServer((_, response) => {
    response.writeHead(500, { 'content-type': 'text/html' });
    response.end('<title>agent board error</title>Could not read T3 state');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const run = spawn(process.execPath, [path.join(REPO, SKILL, 'flows/look.mjs'), `http://127.0.0.1:${server.address().port}/map`,
      path.join(tmp, 'look'), 'broken'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    run.stdout.on('data', (d) => { out += d; });
    const [code] = await once(run, 'exit');
    assert.equal(code, 1, out);
    // With no viewport named, look shoots all five.
    assert.deepEqual([...out.matchAll(/^FAIL 500 .* at ([\w-]+) /gm)].map((m) => m[1]),
      ['desktop-1920', 'small-desktop-1080', 'ipad-portrait-744', 'ipad-landscape-1133', 'phone-390']);
    const layout = JSON.parse(fs.readFileSync(path.join(tmp, 'look/broken-desktop-1920.json'), 'utf8'));
    assert.equal(layout.engine, 'chrome');
    assert.equal(layout.scrollWidth, layout.clientWidth);
    assert.equal(layout.overflow, 0);
    assert.deepEqual(layout.lanes, []);
  } finally {
    server.close();
  }
});

test('look saves full pages at the device scale, and at CSS pixels only past what Chrome can capture', async (t) => {
  const listed = spawnSync('pnpm', ['ls', '-g', '--depth', '0', '--json'], { encoding: 'utf8' }).stdout ?? '';
  if (!listed.includes('"playwright-core"')) return t.skip('playwright-core is not installed');
  // 64 rows of 104 CSS px is 6656 px: 19968 device px on the 3x phone (past 16384), 13312 on the 2x iPad.
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    const rows = request.url === '/tall' ? 64 : 20;
    response.end(`<meta name="viewport" content="width=device-width"><title>rows</title><style>body{margin:0}div{height:100px;border-bottom:4px solid}</style>${'<div></div>'.repeat(rows)}`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  // A PNG's width is the first field of its IHDR chunk.
  const pngWidth = (file) => fs.readFileSync(file).readUInt32BE(16);
  try {
    const shots = [['short', 'phone-390', 1170, 'device'], ['tall', 'phone-390', 390, 'css'], ['tall', 'ipad-portrait-744', 1488, 'device'],
      ['tall', 'desktop-1920', 1920, 'device']];
    for (const [page, view, width, scale] of shots) {
      const run = spawn(process.execPath, [path.join(REPO, SKILL, 'flows/look.mjs'), `http://127.0.0.1:${server.address().port}/${page}`,
        path.join(tmp, 'look-scale'), page, view], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      run.stdout.on('data', (d) => { out += d; });
      const [code] = await once(run, 'exit');
      assert.equal(code, 0, out);
      const base = path.join(tmp, 'look-scale', `${page}-${view}`);
      assert.equal(pngWidth(`${base}-full.png`), width, `${page} at ${view}`);
      assert.equal(JSON.parse(fs.readFileSync(`${base}.json`, 'utf8')).fullScale, scale, `${page} at ${view}`);
    }
  } finally {
    server.close();
  }
});

test('look and line-sweep fail on a rendered line that starts with "·", a split short parenthetical or a count left without its word, which the markup alone cannot show', async (t) => {
  const listed = spawnSync('pnpm', ['ls', '-g', '--depth', '0', '--json'], { encoding: 'utf8' }).stdout ?? '';
  if (!listed.includes('"playwright-core"')) return t.skip('playwright-core is not installed');
  // /box is the board's old markup: a no-break space before the dot, and Chrome still breaks after the inline-block.
  // /carried puts the dot inside the box, as the board does now. /block starts a paragraph with "·"; /columns has a
  // second column and a wrapped line, neither starting with "·". /paren wraps "(opus high)" after "(opus"; /kept keeps it
  // whole, as the board does; /prose wraps a parenthetical too long to keep. /count ends a line on "1" with "check" on the
  // next; /counted keeps "1 check" whole, as the board does; /heading ends a heading on "15" above a paragraph.
  const pages = {
    box: '<div style="width:200px"><span style="display:inline-block;width:198px">feat/x</span>&nbsp;· since 17:50</div>',
    carried: '<div style="width:200px"><span style="display:inline-block;max-width:100%">feat/x&nbsp;·</span> since 17:50</div>',
    block: '<p>one</p><p>· two</p>',
    columns: '<div style="display:flex;gap:20px"><div style="width:60px">one two three</div><div>four&nbsp;· five</div></div>',
    paren: '<div style="width:13ch;font-family:monospace">worker (opus high)</div>',
    kept: '<div style="width:12ch;font-family:monospace">worker <span style="white-space:nowrap">(opus high)</span></div>',
    prose: '<div style="width:12ch;font-family:monospace">worker (held until the design review lands)</div>',
    count: '<div style="width:14ch;font-family:monospace">blocked on: 1 check failing</div>',
    counted: '<div style="width:14ch;font-family:monospace">blocked on: <span style="white-space:nowrap">1 check</span> failing</div>',
    heading: '<h2>Stuck · 15</h2><p>stalled since 17:50</p>',
  };
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<meta name="viewport" content="width=device-width"><title>lines</title><body style="font:16px sans-serif">${pages[request.url.slice(1)]}</body>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const run = async (script, ...args) => {
    const child = spawn(process.execPath, [path.join(REPO, SKILL, 'flows', script), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const [code] = await once(child, 'exit');
    return { code, out };
  };
  const url = (page) => `http://127.0.0.1:${server.address().port}/${page}`;
  try {
    const starts = {};
    for (const page of Object.keys(pages)) {
      const { code, out } = await run('look.mjs', url(page), path.join(tmp, 'look-lines'), page, 'phone-390');
      const seen = JSON.parse(fs.readFileSync(path.join(tmp, 'look-lines', `${page}-phone-390.json`), 'utf8'));
      starts[page] = { code, lines: [...seen.dotStarts, ...seen.splitParens, ...seen.bareCounts].map((l) => l.text) };
      assert.match(out, /"·" line starts \d/);
    }
    assert.deepEqual(starts, { box: { code: 1, lines: ['· since 17:50'] }, carried: { code: 0, lines: [] },
      block: { code: 1, lines: ['· two'] }, columns: { code: 0, lines: [] }, paren: { code: 1, lines: ['(opus / high)'] },
      kept: { code: 0, lines: [] }, prose: { code: 0, lines: [] }, count: { code: 1, lines: ['1 / check'] },
      counted: { code: 0, lines: [] }, heading: { code: 0, lines: [] } });
    const bare = await run('line-sweep.mjs', url('count'), '320-321', '1', '--json');
    assert.deepEqual([bare.code, JSON.parse(bare.out).failures.map((f) => [f.width, f.bareCounts.map((l) => l.text)])],
      [1, [[320, ['1 / check']], [321, ['1 / check']]]]);
    const split = await run('line-sweep.mjs', url('paren'), '320-321', '1', '--json');
    assert.deepEqual([split.code, JSON.parse(split.out).failures.map((f) => [f.width, f.splitParens.map((l) => l.text)])],
      [1, [[320, ['(opus / high)']], [321, ['(opus / high)']]]]);
    const swept = await run('line-sweep.mjs', url('box'), '320-324', '2', '--json');
    assert.equal(swept.code, 1);
    const report = JSON.parse(swept.out);
    assert.deepEqual([report.widths, report.failures.map((f) => [f.width, f.dotStarts.map((l) => l.text)])],
      [3, [[320, ['· since 17:50']], [322, ['· since 17:50']], [324, ['· since 17:50']]]]);
    const clean = await run('line-sweep.mjs', url('carried'), '320-330');
    assert.equal(clean.code, 0, clean.out);
    assert.match(clean.out, /PASS 200 .*: 11 widths from 320 to 330, 0 failing/);
  } finally {
    server.close();
  }
});

test('the uneven map fixture has three lanes with the counts that exposed the wide-layout bug', async () => {
  const { seedMapShape } = await import(pathToFileURL(path.join(REPO, SKILL, 'fixture.mjs')));
  const { parseUnits } = await import(pathToFileURL(path.join(REPO, 'files/bin/agent-board.mjs')));
  const dir = path.join(tmp, 'map-shape');
  seedMapShape(dir);
  const counts = fs.readdirSync(dir).map((name) => {
    const lane = path.join(dir, name);
    const { units, skipped } = parseUnits(fs.readFileSync(path.join(lane, 'units.tsv'), 'utf8'));
    assert.deepEqual(skipped, []);
    return [JSON.parse(fs.readFileSync(path.join(lane, 'lane.json'))).priority, units.length,
      units.filter((u) => u.state !== 'done').length];
  }).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(counts, [[1, 51, 22], [2, 17, 8], [3, 106, 35]]);
});

test('each Stuck scenario renders the Stuck rows and Needs you count the flow expects', async () => {
  const { STUCK_SCENARIOS, seed, seedStuck } = await import(pathToFileURL(path.join(REPO, SKILL, 'fixture.mjs')));
  const { STUCK_SHOWN, parsePrs, renderMap, snapshot } = await import(pathToFileURL(path.join(REPO, 'files/bin/agent-board.mjs')));
  const now = Date.now();
  const dir = path.join(tmp, 'stuck');
  const { env } = seed(dir, now);
  // The stub gh's answer, read as the board's own fetch would parse it; a repo without one is a GitHub error.
  const prs = (repo) => {
    const file = path.join(dir, 'gh', `prs-${repo.split('/')[1]}.json`);
    return fs.existsSync(file) ? { ...parsePrs(fs.readFileSync(file, 'utf8')), at: now } : { prs: new Map(), error: 'no repo', at: now };
  };
  const render = (params) => renderMap(snapshot({ dbPath: env.AGENT_BOARD_T3_DB, logsDir: env.AGENT_BOARD_CLAUDE_PROJECTS,
    lanesDir: path.join(dir, 'lanes'), now, autoupdate: null, prs }), params);
  const stuckOf = (html) => html.slice(html.indexOf('id="stuck"'), html.indexOf('<div class="cols">'));
  const ids = (part) => [...part.matchAll(/<a class="id" href="[^"]+">([^<]+)<\/a>/g)].map((m) => m[1]);
  assert.ok(STUCK_SCENARIOS.crowded.stuck.length >= 15, 'crowded holds enough to fold');
  for (const [name, expected] of Object.entries(STUCK_SCENARIOS)) {
    seedStuck(dir, name, now);
    const html = render();
    const part = stuckOf(html);
    // A closed list shows the oldest STUCK_SHOWN; opened, every row in the same order.
    assert.deepEqual(ids(part), expected.stuck.slice(0, STUCK_SHOWN), name);
    assert.deepEqual(ids(stuckOf(render(new URLSearchParams('stuck=all')))), expected.stuck, name);
    const more = expected.stuck.length - STUCK_SHOWN;
    assert.equal(/>(\d+ more stuck)</.exec(part)?.[1] ?? null, more > 0 ? `${more} more stuck` : null, name);
    assert.match(html, new RegExp(`Needs you · ${expected.needs}<`), name);
    // The line is what a reader sees, so it is matched with the markup gone.
    if (expected.line) assert.ok(part.replace(/<[^>]*>/g, '').includes(expected.line), `${name}: ${part}`);
    // The strip's stuck figure is the heading's: a count, or unknown when the list could not check.
    const strip = /<nav class="status-strip"[^]*?<(?:a href="#stuck"|span(?: class="yellow")?)>(\d+ stuck|stuck unknown)</.exec(html)?.[1];
    const heading = /id="stuck">Stuck · (\d+)</.exec(part)?.[1];
    assert.equal(strip, heading ? `${heading} stuck` : part.includes('Could not check') ? 'stuck unknown' : '0 stuck', name);
    if (heading) assert.equal(Number(heading), expected.stuck.length, name);
  }
});

test('the skill drives with Playwright written flows first and names chrome-devtools-axi only as the fallback', () => {
  const skill = fs.readFileSync(path.join(REPO, '.claude/skills/verify-agent-board/SKILL.md'), 'utf8');
  const drive = skill.slice(skill.indexOf('\n## Drive\n'), skill.indexOf('\n## Evidence\n'));
  const drivers = [...drive.matchAll(/^\d+\. \*\*(.+?)\*\*/gm)].map((m) => m[1]);
  assert.match(drivers[0] ?? '', /^Playwright/, `first driver is ${drivers[0]}`);
  assert.deepEqual(drivers.filter((d) => /chrome-devtools-axi/.test(d)), ['chrome-devtools-axi, fallback only']);
  assert.doesNotMatch(drive, /or when you are Codex/);
  assert.match(drive, /Codex is out of quota, and `codex-browser-fallback status` exits 0/);
  for (const flow of [...drive.matchAll(/`flows\/([\w-]+\.mjs)/g)].map((m) => m[1])) {
    assert.ok(fs.existsSync(path.join(REPO, SKILL, 'flows', flow)), `Drive names a missing flow ${flow}`);
  }
  const readme = fs.readFileSync(path.join(REPO, '.claude/skills/verify-agent-board/features/README.md'), 'utf8');
  assert.match(readme, /Run the feature's Playwright written flow/);
  assert.match(readme, /Do not give Codex the axi commands as its driver/);
  for (const feature of ['threads', 'auto-update', 'project-map', 'stale-rows', 'phone-and-access']) {
    const recipe = fs.readFileSync(path.join(REPO, '.claude/skills/verify-agent-board/features', `${feature}.md`), 'utf8');
    assert.match(recipe, /These commands are quota fallback only and require active `codex-browser-fallback status`/);
  }
});

test('visual checks default to the five viewports the owner reads the board on, defined once for every flow', async () => {
  const { VIEWPORTS, viewport, pageOptions } = await import(pathToFileURL(path.join(REPO, SKILL, 'flows/viewports.mjs')));
  const describe = (v) => `${v.name} ${v.width}x${v.height} ${v.deviceScaleFactor}x${v.isMobile ? ' mobile' : ''}${v.hasTouch ? ' touch' : ''}`;
  assert.deepEqual(VIEWPORTS.map(describe), ['desktop-1920 1920x1440 1x', 'small-desktop-1080 1080x1800 1x',
    'ipad-portrait-744 744x1133 2x touch', 'ipad-landscape-1133 1133x744 2x touch', 'phone-390 390x844 3x mobile touch']);
  assert.equal(viewport('744').name, 'ipad-portrait-744');
  assert.equal(viewport('phone-390').width, 390);
  assert.equal(viewport('1440'), undefined);
  assert.deepEqual(pageOptions(viewport('phone-390')),
    { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const flows = path.join(REPO, SKILL, 'flows');
  for (const flow of fs.readdirSync(flows).filter((f) => f !== 'viewports.mjs')) {
    const code = fs.readFileSync(path.join(flows, flow), 'utf8');
    assert.doesNotMatch(code, /\.new(?:Page|Context)\((?!pageOptions\()/, `${flow} opens a page without pageOptions(), so it sizes the page itself`);
    // line-sweep exists to try every width on one page.
    if (flow !== 'line-sweep.mjs') assert.doesNotMatch(code, /setViewportSize|\bresize\b/, `${flow} resizes a page instead of opening it at a viewport`);
  }
  const skill = fs.readFileSync(path.join(REPO, '.claude/skills/verify-agent-board/SKILL.md'), 'utf8');
  for (const v of VIEWPORTS) assert.ok(skill.includes(`\`${v.name}\``), `SKILL.md names ${v.name}`);
  const docs = ['SKILL.md', ...fs.readdirSync(path.join(REPO, '.claude/skills/verify-agent-board/features')).map((f) => `features/${f}`)];
  const axiSizes = VIEWPORTS.map((v) => `${v.width}x${v.height}x${v.deviceScaleFactor}${v.isMobile ? ',mobile' : ''}${v.hasTouch ? ',touch' : ''}`);
  for (const doc of docs) {
    const text = fs.readFileSync(path.join(REPO, '.claude/skills/verify-agent-board', doc), 'utf8');
    assert.doesNotMatch(text, /\b1440\b|1280x900/, `${doc} keeps an old default`);
    for (const [, size] of text.matchAll(/"(\d+x\d+x\d[^"]*)"/g)) assert.ok(axiSizes.includes(size), `${doc}: axi size ${size} is not one of viewports.mjs`);
  }
});

test('the written flows use the playwright-core version the daily sync pins', () => {
  const pins = /^pins="([^"]*)"/m.exec(fs.readFileSync(path.join(REPO, 'scripts/dotfiles-autoupdate'), 'utf8'))[1].split(' ');
  const pin = /const PIN = '([^']+)'/.exec(fs.readFileSync(path.join(REPO, SKILL, 'flows/playwright.mjs'), 'utf8'))[1];
  assert.ok(pins.includes(pin), `${pin} is not in the autoupdate pins (${pins.join(' ')})`);
  for (const flow of fs.readdirSync(path.join(REPO, SKILL, 'flows'))) {
    const check = spawnSync(process.execPath, ['--check', path.join(REPO, SKILL, 'flows', flow)], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
  }
});

test('--t3-db runs the board on a copy of the T3 database, and refuses a missing file or a fixture run', () => {
  const home = path.join(tmp, 'home-t3copy');
  fs.mkdirSync(home);
  const copy = path.join(tmp, 't3-copy.sqlite');
  const db = new DatabaseSync(copy);
  db.exec(`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, title TEXT, updated_at TEXT, payload_json TEXT,
    archived_at TEXT, deleted_at TEXT)`);
  db.close();
  const before = fs.existsSync(STATE) ? runs().length : 0;
  const missing = boardWithEnv({ HOME: home }, A, 'launch', '--t3-db', path.join(tmp, 'nope.sqlite'), '--ttl', '5');
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.out, /--t3-db: .*nope\.sqlite is not a file/);
  const both = boardWithEnv({ HOME: home }, A, 'launch', '--fixture', '--t3-db', copy, '--ttl', '5');
  assert.equal(both.code, 1, both.out);
  assert.match(both.out, /--fixture already seeds its own T3 database; pick one/);
  assert.equal(fs.existsSync(STATE) ? runs().length : 0, before, 'a run was recorded');

  const launched = boardWithEnv({ HOME: home }, A, 'launch', '--t3-db', copy, '--ttl', '5');
  try {
    assert.equal(launched.code, 0, launched.out);
    assert.match(launched.out, /T3 database read from the copy .*t3-copy\.sqlite/);
    assert.equal(latest().env.AGENT_BOARD_T3_DB, copy);
  } finally {
    board(A, 'stop');
  }
});

test('a lanes copy refuses to launch when the live lanes directory is missing', () => {
  const home = path.join(tmp, 'home-nolanes');
  fs.mkdirSync(home);
  const before = fs.existsSync(STATE) ? runs().length : 0;
  const launched = boardWithEnv({ HOME: home }, A, 'launch', '--lanes-copy', '--ttl', '5');
  assert.equal(launched.code, 1, launched.out);
  assert.match(launched.out, /--lanes-copy: .*orchestrator\/lanes is missing or not a directory; nothing to copy/);
  assert.equal(fs.existsSync(STATE) ? runs().length : 0, before, 'a run was recorded');
});
