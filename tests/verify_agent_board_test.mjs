// Run: node --test tests/verify_agent_board_test.mjs
// Tests the verify-agent-board helper (.claude/skills/verify-agent-board/scripts/board.mjs) on a copy of the files it
// runs, with its state in a temp dir, so nothing touches the live board, ~/.local/state or the real data.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = '.claude/skills/verify-agent-board/scripts';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-agent-board-'));
const STATE = path.join(tmp, 'state');

// A checkout with only the files a run needs, laid out as in the repo.
function checkout(name) {
  const root = path.join(tmp, name);
  for (const file of ['files/bin/agent-board.mjs', 'scripts/dotfiles-autoupdate', `${SKILL}/board.mjs`, `${SKILL}/fixture.mjs`, `${SKILL}/git-env.mjs`]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(REPO, file), path.join(root, file));
  }
  return root;
}
const A = checkout('a');
const B = checkout('b');

const boardWithEnv = (extraEnv, root, ...args) => {
  const run = spawnSync(process.execPath, ['--no-warnings', path.join(root, SKILL, 'board.mjs'), ...args], {
    env: { ...process.env, ...extraEnv, VERIFY_AGENT_BOARD_STATE: STATE }, encoding: 'utf8', timeout: 60_000,
  });
  return { code: run.status, out: run.stdout + run.stderr };
};
const board = (root, ...args) => boardWithEnv({}, root, ...args);
const runs = () => fs.readdirSync(STATE).filter((id) => fs.existsSync(path.join(STATE, id, 'run.json')))
  .map((id) => JSON.parse(fs.readFileSync(path.join(STATE, id, 'run.json'), 'utf8')));
const latest = () => runs().sort((x, y) => x.startedAt.localeCompare(y.startedAt)).at(-1);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (what, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!what()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

after(() => {
  for (const r of fs.existsSync(STATE) ? runs() : []) for (const pid of [r.keeperPid, r.boardPid]) if (pid && alive(pid)) process.kill(pid);
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
    process.kill(run.keeperPid, 'SIGKILL');
    await until(() => !alive(run.keeperPid));
    process.kill(run.boardPid, 'SIGSTOP');
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
    if (alive(run.boardPid)) process.kill(run.boardPid, 'SIGKILL');
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
    process.kill(run.keeperPid, 'SIGKILL');
    await until(() => !alive(run.keeperPid));
    const stopped = board(root, 'stop', run.runId);
    assert.equal(stopped.code, 2, stopped.out);
    assert.match(stopped.out, /cannot confirm board ownership.*PID and scratch retained/);
    assert.ok(alive(run.boardPid));
    assert.equal(latest().boardPid, run.boardPid);
    assert.equal(latest().stoppedAt, null);
    assert.equal(fs.existsSync(run.scratch), true);
  } finally {
    process.kill(run.boardPid, 'SIGKILL');
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
  const map = await (await fetch(`${run.urls.local}/map`)).text();
  assert.equal(map.match(/class="stale"/g).length, 2, "the two stale rows, in their lane only");

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
    process.kill(run.keeperPid, 'SIGKILL');
    process.kill(run.boardPid, 'SIGKILL');
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

test('look refuses the live board, a width that is not a number, and fails on a page that did not answer 2xx', async (t) => {
  const look = (...args) => spawnSync(process.execPath, [path.join(REPO, SKILL, 'flows/look.mjs'), ...args],
    { encoding: 'utf8', timeout: 60_000 });
  const live = look('http://127.0.0.1:4790/map', path.join(tmp, 'look'), 'live', '390');
  assert.notEqual(live.status, 0);
  assert.match(live.stderr, /refusing the live board on port 4790/);
  const phoneFlag = look('http://127.0.0.1:1/map', path.join(tmp, 'look'), 'flag', '--phone');
  assert.notEqual(phoneFlag.status, 0);
  assert.match(phoneFlag.stderr, /usage: look.mjs <url> <evidence-dir> <name> \[<width>\]/);

  const listed = spawnSync('pnpm', ['ls', '-g', '--depth', '0', '--json'], { encoding: 'utf8' }).stdout ?? '';
  if (!listed.includes('"playwright-core"')) return t.skip('playwright-core is not installed');
  const server = net.createServer((socket) => socket.end('HTTP/1.1 500 Internal Server Error\r\ncontent-type: text/html\r\n'
    + 'connection: close\r\n\r\n<title>agent board error</title>Could not read T3 state'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const run = spawn(process.execPath, [path.join(REPO, SKILL, 'flows/look.mjs'), `http://127.0.0.1:${server.address().port}/map`,
      path.join(tmp, 'look'), 'broken'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    run.stdout.on('data', (d) => { out += d; });
    const [code] = await once(run, 'exit');
    assert.equal(code, 1, out);
    assert.match(out, /^FAIL 500/);
  } finally {
    server.close();
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

test('the written flows use the playwright-core version the daily sync pins', () => {
  const pins = /^pins="([^"]*)"/m.exec(fs.readFileSync(path.join(REPO, 'scripts/dotfiles-autoupdate'), 'utf8'))[1].split(' ');
  const pin = /const PIN = '([^']+)'/.exec(fs.readFileSync(path.join(REPO, SKILL, 'flows/playwright.mjs'), 'utf8'))[1];
  assert.ok(pins.includes(pin), `${pin} is not in the autoupdate pins (${pins.join(' ')})`);
  for (const flow of fs.readdirSync(path.join(REPO, SKILL, 'flows'))) {
    const check = spawnSync(process.execPath, ['--check', path.join(REPO, SKILL, 'flows', flow)], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
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
