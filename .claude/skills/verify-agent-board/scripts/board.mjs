#!/usr/bin/env -S node --no-warnings
// verify-agent-board helper: run a throwaway agent board from this checkout on a spare port, check that it is this
// run's and healthy, and stop it, keeping the evidence. It never touches the live board (launchd com.myuser.agent-board
// on port 4790, shared by every agent and the owner): it refuses that port, and it signals only processes it started.
//
//   board.mjs launch [--fixture | --lanes-copy] [--t3-db <copy>] [--publish] [--ttl <min>]
//                                                                   start a run (live data read-only by default)
//   board.mjs doctor [<run-id> | --port <n>]                        is this instance ours and worth driving?
//   board.mjs env [<run-id>]                                        shell exports: eval "$(board.mjs env)"
//   board.mjs stop [<run-id>]                                       stop this checkout's runs; evidence stays
//   board.mjs runs                                                  this checkout's runs, up and stopped
//   board.mjs verify-stuck [--json] [--dry-run]                     the Stuck list journeys (flows/map-stuck.mjs) on a fixture run
//
// Each run lives in $VERIFY_AGENT_BOARD_STATE/<run-id>/ (default ~/.local/state/verify-agent-board): run.json,
// board.log, evidence/ (kept) and scratch/ (fixture data or the lanes copy, removed when the run stops). A detached
// keeper process owns the board: it restarts it when the board exits 0 after a source change, as launchd does for the
// live board, and stops it when the TTL runs out or `stop` signals it. A run is on loopback only, like the live board;
// --publish has the board publish itself with `tailscale serve --http=<port>`, as the live board does on 4790, so a
// phone reaches it by MagicDNS name, and the run removes that handler when it stops.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKERS, seed } from './fixture.mjs';
import { gitEnv } from './git-env.mjs';

const LIVE_PORT = 4790;
const SELF = fileURLToPath(import.meta.url);
const CHECKOUT = path.resolve(path.dirname(SELF), '../../../..');
const BOARD = path.join(CHECKOUT, 'files/bin/agent-board.mjs');
const STATE = process.env.VERIFY_AGENT_BOARD_STATE ?? path.join(os.homedir(), '.local/state/verify-agent-board');
// Tests point this at a stub, so they never change the tailnet's serve config.
const TAILSCALE = process.env.VERIFY_AGENT_BOARD_TAILSCALE ?? '/usr/local/bin/tailscale';
// The agent Chrome gate; tests point it at a dead port with scripts/agent-chrome-session's test variable.
const AGENT_CHROME_GATE = process.env.AGENT_CHROME_SESSION_TEST_GATE_URL || 'http://127.0.0.1:9333';
const LIVE_DATA = {
  AGENT_BOARD_T3_DB: path.join(os.homedir(), '.t3/userdata/statev2.sqlite'),
  AGENT_BOARD_CLAUDE_PROJECTS: path.join(os.homedir(), '.claude/projects'),
  AGENT_BOARD_LANES: path.join(os.homedir(), 'orchestrator/lanes'),
};
// Variables the board or the updater it runs would read from the caller's shell; a run sets its own.
const INHERITED = /^(AGENT_BOARD_|AUTOUPDATE_)/;

const die = (message, code = 1) => {
  console.error(`board.mjs: ${message}`);
  process.exit(code);
};
const refuse = (message) => die(`refusing: ${message}`, 2);
const LIVE_REFUSAL = `port ${LIVE_PORT} is the live agent board (launchd com.myuser.agent-board), shared by every agent and the owner. `
  + 'Never drive, restart or stop it; start your own with: board.mjs launch';

// ---- Run records ----

const runFile = (dir) => path.join(dir, 'run.json');
const readRun = (dir) => JSON.parse(fs.readFileSync(runFile(dir), 'utf8'));
function writeRun(dir, run) {
  const tmp = `${runFile(dir)}.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(run, null, 2)}\n`);
  fs.renameSync(tmp, runFile(dir));
}
const updateRun = (dir, patch) => writeRun(dir, { ...readRun(dir), ...patch });

function allRuns() {
  let names = [];
  try { names = fs.readdirSync(STATE); } catch { return []; }
  return names.sort().flatMap((name) => {
    try { return [readRun(path.join(STATE, name))]; } catch { return []; }
  });
}
const ownRuns = () => allRuns().filter((r) => r.checkout === CHECKOUT);

// ---- Processes: only ever by recorded pid, confirmed by command line and listener ----

const command = (pid) => (pid ? spawnSync('/bin/ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim() : '');
function listeners(port) {
  const run = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' });
  return (run.stdout ?? '').split('\n').filter((l) => l.startsWith('p')).map((l) => Number(l.slice(1)));
}
const keeperOwned = (run) => command(run.keeperPid).includes(`${SELF} _keep ${run.dir}`);
const boardOwned = (run) => command(run.boardPid).includes(run.board);
const isUp = (run) => !run.stoppedAt && keeperOwned(run);
// A zombie has exited but its parent has not reaped it yet.
const running = (pid) => pid && Boolean(spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)],
  { encoding: 'utf8' }).stdout.trim().replace(/^Z\S*$/, ''));
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
async function waitForExit(pid, ms) {
  const deadline = Date.now() + ms;
  while (running(pid) && Date.now() < deadline) await pause();
  return !running(pid);
}
const git = (checkout, ...args) => spawnSync('git', ['-C', checkout, ...args], { env: gitEnv(), encoding: 'utf8' });

async function get(url, timeoutMs = 8000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, text: await res.text() };
  } catch (error) {
    return { status: 0, text: error.cause?.code ?? error.message };
  }
}

// Usable, not just answering: both pages render (not the T3 error page) and a fixture run shows its own data.
async function pagesReady(run) {
  const base = `http://127.0.0.1:${run.port}`;
  const threads = await get(`${base}/`);
  const map = await get(`${base}/map`);
  const problems = [];
  if (threads.status !== 200 || !/<title>(\(\d+\) )?agent board<\/title>/.test(threads.text)) {
    problems.push(`/ answered ${threads.status || threads.text}${/Could not render the board/.test(threads.text) ? ' (the board error page)' : ''}`);
  }
  if (map.status !== 200 || !/<title>(\(\d+\) )?project map<\/title>/.test(map.text)) problems.push(`/map answered ${map.status || map.text}`);
  // The markers are read as the page shows them: the board wraps a short parenthetical such as "(fixture)" in a span.
  const shown = (page) => page.text.replace(/<[^>]*>/g, '');
  if (run.mode === 'fixture' && !problems.length) {
    if (!shown(threads).includes(MARKERS.thread)) problems.push(`/ does not show the fixture thread "${MARKERS.thread}"`);
    if (!shown(map).includes(MARKERS.lane)) problems.push(`/map does not show the fixture lane "${MARKERS.lane}"`);
  }
  return problems;
}

function magicDns() {
  const run = spawnSync(TAILSCALE, ['status', '--json', '--peers=false'], { encoding: 'utf8', timeout: 3000 });
  try { return JSON.parse(run.stdout).Self.DNSName.replace(/\.$/, '').toLowerCase() || null; } catch { return null; }
}

// The board's own listening addresses, from its pid: only ever 127.0.0.1:<port>.
function boundAddresses(pid) {
  const run = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' });
  return (run.stdout ?? '').split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1));
}

// A GET with the Host a browser sends through tailscale serve; fetch cannot set Host.
function getWithHost(port, host, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', headers: { host }, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', () => resolve(0));
  });
}

// Removes a published run's tailscale serve handler, and only that run's. Never the live board's port.
function unpublish(run) {
  if (!run.published || run.port === LIVE_PORT) return null;
  const off = spawnSync(TAILSCALE, ['serve', `--http=${run.port}`, 'off'], { encoding: 'utf8', timeout: 30_000 });
  return off.status === 0 ? `removed the tailscale serve handler on port ${run.port}`
    : `could not remove the tailscale serve handler on port ${run.port}: ${(off.stderr || off.error?.message || '').trim()}`;
}

function sparePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    }).on('error', reject);
  });
}

const sgtStamp = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
const tail = (file, n = 8) => { try { return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n'); } catch { return ''; } };
const countFiles = (dir) => { try { return fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile()).length; } catch { return 0; } };

function exportsFor(run) {
  return [
    ['BOARD_RUN', run.runId], ['BOARD_URL', run.urls.local], ['BOARD_PHONE_URL', run.urls.phone ?? ''],
    ['BOARD_EVIDENCE', run.evidence], ['BOARD_SCRATCH', run.scratch], ['BOARD_MODE', run.mode],
  ].map(([k, v]) => `export ${k}='${String(v).replaceAll("'", "'\\''")}'`).join('\n');
}

// A copy with every symlink replaced by what it points to, timestamps kept. A lane file may be a link (job-tracker's
// units.tsv -> state/units.tsv), and a copied link sends a journey's edits to the live file. fs.cpSync's dereference
// does not reach nested links on Node 22. Left out: a broken link (the board would find it missing), a link back to a
// directory being copied (a loop such as up -> ..), and anything not a plain file or directory (a FIFO would hang).
// Returns what it left out, as [path, reason] relative to the top.
function copyResolved(src, dest, ancestors = new Set(), left = [], top = src) {
  const leave = (why) => (left.push([path.relative(top, src), why]), left);
  let st;
  let real;
  try {
    st = fs.statSync(src);
    real = fs.realpathSync(src);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ELOOP') return leave('broken link');
    throw error;
  }
  if (st.isDirectory()) {
    if (ancestors.has(real)) return leave('links back to a directory being copied');
    fs.mkdirSync(dest);
    const inside = new Set(ancestors).add(real);
    for (const name of fs.readdirSync(src)) copyResolved(path.join(src, name), path.join(dest, name), inside, left, top);
  } else if (st.isFile()) {
    fs.copyFileSync(src, dest);
  } else {
    return leave('not a file or directory');
  }
  fs.utimesSync(dest, st.atime, st.mtime);
  return left;
}

// ---- Commands ----

async function launch(args) {
  const fixture = args.includes('--fixture');
  const lanesCopy = args.includes('--lanes-copy');
  const publish = args.includes('--publish');
  const dbAt = args.indexOf('--t3-db');
  const t3Db = dbAt >= 0 ? path.resolve(args[dbAt + 1] ?? '') : null;
  const ttlAt = args.indexOf('--ttl');
  const ttl = ttlAt >= 0 ? Number(args[ttlAt + 1]) : 60;
  if (fixture && lanesCopy) die('--fixture already seeds its own lanes; pick one');
  if (fixture && t3Db) die('--fixture already seeds its own T3 database; pick one');
  // A copy of the T3 database, so a check against T3's real schema can run while T3 writes the live one.
  if (t3Db && !fs.statSync(t3Db, { throwIfNoEntry: false })?.isFile()) die(`--t3-db: ${t3Db} is not a file`);
  if (lanesCopy && !fs.statSync(LIVE_DATA.AGENT_BOARD_LANES, { throwIfNoEntry: false })?.isDirectory()) {
    die(`--lanes-copy: ${LIVE_DATA.AGENT_BOARD_LANES} is missing or not a directory; nothing to copy`);
  }
  if (!(ttl > 0)) die('--ttl takes a number of minutes');
  if (!fs.existsSync(BOARD)) die(`${BOARD} is missing; is this skill inside a dotfiles checkout?`);
  const up = ownRuns().find(isUp);
  if (up) die(`run ${up.runId} from this checkout is still up at ${up.urls.local}; drive it, or stop it first: board.mjs stop`);

  let port;
  do port = await sparePort(); while (port === LIVE_PORT);
  let runId = `${sgtStamp()}-${path.basename(CHECKOUT)}`;
  if (fs.existsSync(path.join(STATE, runId))) runId += `-${process.pid}`;
  const dir = path.join(STATE, runId);
  const scratch = path.join(dir, 'scratch');
  const evidence = path.join(dir, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  fs.mkdirSync(scratch);

  let env = { ...LIVE_DATA };
  let files = {};
  let lanesLeft = [];
  if (fixture) ({ env, files } = seed(scratch));
  if (lanesCopy) {
    env.AGENT_BOARD_LANES = path.join(scratch, 'lanes');
    lanesLeft = copyResolved(LIVE_DATA.AGENT_BOARD_LANES, env.AGENT_BOARD_LANES);
    files = { lanes: env.AGENT_BOARD_LANES };
  }
  if (t3Db) env.AGENT_BOARD_T3_DB = t3Db;
  env.AGENT_BOARD_PORT = String(port);
  if (publish) Object.assign(env, { AGENT_BOARD_PUBLISH: '1', AGENT_BOARD_TAILSCALE: TAILSCALE });
  const head = git(CHECKOUT, 'rev-parse', '--short', 'HEAD').stdout?.trim() || null;
  const run = {
    runId, checkout: CHECKOUT, board: BOARD, head, mode: fixture ? 'fixture' : lanesCopy ? 'lanes-copy' : 'live',
    port, published: publish, keeperPid: null, boardPid: null, startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttl * 60_000).toISOString(), stoppedAt: null, stopReason: null,
    dir, evidence, scratch, log: path.join(dir, 'board.log'), env, files,
    urls: { local: `http://127.0.0.1:${port}`, phone: null },
  };
  writeRun(dir, run);
  const keeper = spawn(process.execPath, ['--no-warnings', SELF, '_keep', dir], { detached: true, stdio: 'ignore' });
  keeper.unref();
  updateRun(dir, { keeperPid: keeper.pid });

  const deadline = Date.now() + 15_000;
  const listening = (host) => tail(run.log, 50).includes(`listening on ${host}:${port}`);
  while (!listening('127.0.0.1')) {
    if (readRun(dir).stoppedAt || Date.now() > deadline) {
      if (!readRun(dir).stoppedAt) process.kill(keeper.pid, 'SIGTERM');
      die(`the board did not start; ${run.log} ends:\n${tail(run.log)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const problems = await pagesReady(run);
  if (problems.length) {
    process.kill(keeper.pid, 'SIGTERM');
    die(`the board started but is not usable, so the run was stopped: ${problems.join('; ')}\n${tail(run.log)}`);
  }
  // A published board says so once tailscale serve took the handler; a phone reaches it there by MagicDNS name.
  if (publish) {
    while (!tail(run.log, 50).includes('published on the tailnet')) {
      if (readRun(dir).stoppedAt || Date.now() > deadline + 30_000) {
        if (!readRun(dir).stoppedAt) process.kill(keeper.pid, 'SIGTERM');
        die(`the board did not publish itself with tailscale serve, so the run was stopped; ${run.log} ends:\n${tail(run.log)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const name = magicDns();
    if (name) updateRun(dir, { urls: { ...run.urls, phone: `http://${name}:${port}` } });
  }
  const done = readRun(dir);
  console.log(`launched ${runId} (${done.mode} data${done.mode === 'live' ? ', read-only' : ''}), stops itself at ${new Date(done.expiresAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Singapore' })} SGT`);
  if (t3Db) console.log(`T3 database read from the copy ${t3Db}`);
  if (lanesLeft.length) console.log(`left out of the lanes copy: ${lanesLeft.map(([p, why]) => `${p} (${why})`).join(', ')}`);
  console.log(`  board     ${done.urls.local}/  and  ${done.urls.local}/map`);
  if (done.urls.phone) console.log(`  phone     ${done.urls.phone}/map`);
  console.log(`  evidence  ${evidence}`);
  for (const [name, file] of Object.entries(done.files)) console.log(`  ${name.padEnd(9)} ${file}`);
  console.log('next: board.mjs doctor');
}

// The keeper: detached, owns the board process for the run's lifetime, cleans the scratch data when it ends.
function keep(dir) {
  const run = readRun(dir);
  const log = fs.openSync(run.log, 'a');
  const note = (text) => fs.writeSync(log, `verify-agent-board: ${new Date().toISOString()} ${text}\n`);
  const env = Object.fromEntries(Object.entries(gitEnv()).filter(([k]) => !INHERITED.test(k)));
  let board;
  let stopping = null;
  const start = () => {
    board = spawn(process.execPath, ['--no-warnings', run.board], { env: { ...env, ...run.env }, stdio: ['ignore', log, log] });
    updateRun(dir, { boardPid: board.pid });
    board.on('exit', (code, signal) => {
      if (!stopping && code === 0) {
        note('board exited 0 after a source change; restarting it on the new code, as launchd does for the live board');
        start();
        return;
      }
      const why = stopping ?? `board exited ${signal ?? code}`;
      const unpublished = unpublish(run);
      if (unpublished) note(unpublished);
      note(`stopped: ${why}`);
      fs.rmSync(run.scratch, { recursive: true, force: true });
      updateRun(dir, { stoppedAt: new Date().toISOString(), stopReason: why, boardPid: null });
      process.exit(0);
    });
  };
  const stop = (why) => {
    if (stopping) return;
    stopping = why;
    board.kill('SIGTERM');
    setTimeout(() => board.kill('SIGKILL'), 5000).unref();
  };
  process.on('SIGTERM', () => stop('stopped by board.mjs stop'));
  process.on('SIGINT', () => stop('interrupted'));
  setTimeout(() => stop('its TTL ran out'), Math.min(2 ** 31 - 1, Math.max(0, Date.parse(run.expiresAt) - Date.now())));
  start();
}

function pickRun(args) {
  const portAt = args.indexOf('--port');
  if (portAt >= 0) {
    const port = Number(args[portAt + 1]);
    if (port === LIVE_PORT) refuse(LIVE_REFUSAL);
    const run = ownRuns().reverse().find((r) => r.port === port && isUp(r));
    if (run) return run;
    const who = listeners(port).map((pid) => `pid ${pid}: ${command(pid)}`).join('; ');
    refuse(`no run from this checkout listens on ${port}${who ? ` (${who})` : ''}; drive only a run you launched`);
  }
  const id = args.find((a) => !a.startsWith('--'));
  if (id) {
    const run = allRuns().find((r) => r.runId === id);
    if (!run) die(`no run ${id} in ${STATE}`);
    if (run.checkout !== CHECKOUT) refuse(`run ${id} was started from ${run.checkout}, not this checkout`);
    return run;
  }
  const runs = ownRuns();
  return runs.findLast(isUp) ?? runs.at(-1) ?? die('this checkout has no runs; start one with: board.mjs launch');
}

async function doctor(args) {
  const run = pickRun(args);
  if (run.port === LIVE_PORT) refuse(LIVE_REFUSAL);
  console.log(`run ${run.runId} (${run.mode}), port ${run.port}`);
  let failed = false;
  const check = (ok, name, detail) => {
    console.log(`${ok === 'warn' ? 'warn' : ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
    if (!ok) failed = true;
  };
  if (run.stoppedAt) {
    check(false, 'keeper', `the run stopped at ${run.stoppedAt}: ${run.stopReason}`);
    console.log(`board.log ends:\n${tail(run.log)}\nevidence kept at ${run.evidence}; start a new run with: board.mjs launch`);
    process.exit(1);
  }
  check(keeperOwned(run), 'keeper', `pid ${run.keeperPid}${keeperOwned(run) ? ' is this run\'s keeper' : ' is gone or is not this run\'s keeper'}`);
  check(boardOwned(run), 'board process', `pid ${run.boardPid} runs ${boardOwned(run) ? run.board : `"${command(run.boardPid) || 'nothing'}"`}`);
  const pids = listeners(run.port);
  if (pids.length && !pids.includes(run.boardPid)) {
    refuse(`port ${run.port} is held by pid ${pids.join(', ')} (${command(pids[0])}), which this run did not start`);
  }
  check(pids.includes(run.boardPid), 'listener', `127.0.0.1:${run.port} ${pids.length ? 'is held by the board' : 'has no listener'}`);
  const bound = boundAddresses(run.boardPid);
  check(bound.length > 0 && bound.every((a) => a === `127.0.0.1:${run.port}`), 'bind',
    `the board listens on ${bound.join(', ') || 'nothing'}${bound.every((a) => a.startsWith('127.0.0.1:')) ? ', loopback only' : '; it must be loopback only'}`);
  const name = magicDns();
  if (name) {
    const status = await getWithHost(run.port, `${name}:${run.port}`);
    check(status === 200, 'magicdns host', `/ with Host ${name}:${run.port}, as tailscale serve forwards it, answered ${status || 'nothing'}`);
  } else {
    check('warn', 'magicdns host', 'tailscale gave no MagicDNS name; the Host check for the phone path is not verified');
  }
  if (run.published) {
    const phone = run.urls.phone ? await get(`${run.urls.phone}/`) : { status: 0, text: 'no phone URL' };
    check(phone.status === 200, 'tailnet', `${run.urls.phone ?? 'the phone URL'}/ through tailscale serve answered ${phone.status || phone.text}`);
  }
  const problems = await pagesReady(run);
  check(!problems.length, 'pages', problems.length ? problems.join('; ') : `/ and /map render${run.mode === 'fixture' ? ' the fixture data' : ''}`);
  const dirty = git(run.checkout, 'status', '--porcelain', '--', run.board).stdout?.trim();
  const currentHead = git(run.checkout, 'rev-parse', '--short', 'HEAD').stdout?.trim();
  check(true, 'code', `${run.board}; launch HEAD ${run.head ?? 'unavailable'}; current HEAD ${currentHead || 'unavailable'}${dirty ? ', with uncommitted edits' : ''}`);
  for (const [k, v] of Object.entries(run.env)) if (k !== 'AGENT_BOARD_PORT') console.log(`     ${k}=${v}`);
  const left = Math.round((Date.parse(run.expiresAt) - Date.now()) / 60_000);
  check(left > 5 ? true : 'warn', 'ttl', `${left} min left${left > 5 ? '' : '; finish up, or stop and relaunch with a longer --ttl'}`);
  // Parsed here, so a bad test URL fails this check only, not every subcommand.
  const agentChrome = URL.parse('/json/version', AGENT_CHROME_GATE);
  if (!agentChrome) {
    check(false, 'agent Chrome', `AGENT_CHROME_SESSION_TEST_GATE_URL=${AGENT_CHROME_GATE} is not a URL; unset it, or set a test gate such as http://127.0.0.1:9`);
  } else {
    const chrome = await get(agentChrome, 2000);
    check(chrome.status === 200 ? true : 'warn', 'agent Chrome',
      `${agentChrome.host} ${chrome.status === 200 ? 'answers' : 'does not answer; curl evidence still works, screenshots do not'}`);
  }
  console.log(`evidence: ${run.evidence}`);
  console.log(failed ? 'not worth driving: fix the FAIL lines or stop and relaunch' : `ready: ${run.urls.local}/ and ${run.urls.local}/map`);
  process.exit(failed ? 1 : 0);
}

async function stop(args) {
  const id = args.find((a) => !a.startsWith('--'));
  const runs = id ? [pickRun(args)] : ownRuns().filter((r) => !r.stoppedAt);
  if (!runs.length) console.log('this checkout has no runs that are up');
  for (const run of runs) {
    if (run.port === LIVE_PORT) refuse(LIVE_REFUSAL);
    if (!run.stoppedAt && keeperOwned(run)) {
      process.kill(run.keeperPid, 'SIGTERM');
      const deadline = Date.now() + 10_000;
      while (!readRun(run.dir).stoppedAt && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!readRun(run.dir).stoppedAt) {
      // Never remove a live board's data or discard the PID needed to retry a failed stop.
      if (keeperOwned(run)) refuse(`keeper for ${run.runId} did not finish stopping; PID and scratch retained`);
      const owned = () => boardOwned(run) && listeners(run.port).includes(run.boardPid);
      const signal = (name) => {
        if (!owned()) refuse(`cannot confirm board ownership for ${run.runId}; PID and scratch retained`);
        try { process.kill(run.boardPid, name); } catch (error) {
          if (error.code !== 'ESRCH') die(`could not send ${name}: ${error.message}; PID and scratch retained`);
        }
      };
      if (running(run.boardPid)) {
        signal('SIGTERM');
        if (!await waitForExit(run.boardPid, 2000)) {
          signal('SIGKILL'); // Recheck command and listener immediately before escalation.
          if (!await waitForExit(run.boardPid, 2000)) die(`board for ${run.runId} did not exit; PID and scratch retained`);
        }
      }
      const unpublished = unpublish(run);
      if (unpublished) console.log(unpublished);
      fs.rmSync(run.scratch, { recursive: true, force: true });
      updateRun(run.dir, { stoppedAt: new Date().toISOString(), stopReason: 'stopped by board.mjs stop after its keeper died', boardPid: null });
    }
    const after = readRun(run.dir);
    console.log(`stopped ${run.runId} (${after.stopReason}); evidence kept at ${run.evidence} (${countFiles(run.evidence)} files)`);
  }
}

function list() {
  const runs = ownRuns();
  if (!runs.length) console.log(`no runs from ${CHECKOUT} in ${STATE}`);
  for (const r of runs) {
    const state = isUp(r) ? `up at ${r.urls.local}` : `stopped (${r.stopReason ?? 'keeper gone'})`;
    console.log(`${r.runId}  ${r.mode}  ${state}  evidence: ${countFiles(r.evidence)} files in ${r.evidence}`);
  }
}

// The Stuck journeys swap the run's scratch lanes, so they run only on an up fixture run of this checkout. The flow
// itself needs Playwright; --dry-run only prints its plan.
function verifyStuck(args) {
  const run = pickRun([]);
  if (run.port === LIVE_PORT) refuse(LIVE_REFUSAL);
  if (run.mode !== 'fixture') refuse(`run ${run.runId} reads ${run.mode} data; the Stuck journeys need: board.mjs launch --fixture`);
  if (!isUp(run)) die(`run ${run.runId} is not up; launch one with: board.mjs launch --fixture`);
  const flow = spawnSync(process.execPath, [path.join(path.dirname(SELF), 'flows/map-stuck.mjs'), ...args.filter((a) => ['--json', '--dry-run'].includes(a))],
    { stdio: 'inherit', env: { ...process.env, VERIFY_AGENT_BOARD_STATE: STATE } });
  process.exit(flow.status ?? 1);
}

const [cmd, ...args] = process.argv.slice(2);
const commands = {
  launch: () => launch(args),
  doctor: () => doctor(args),
  env: () => console.log(exportsFor(pickRun(args))),
  stop: () => stop(args),
  runs: list,
  'verify-stuck': () => verifyStuck(args),
  _keep: () => keep(args[0]),
};
if (!commands[cmd]) {
  console.error(fs.readFileSync(SELF, 'utf8').split('\n').filter((l) => l.startsWith('//   board.mjs')).map((l) => l.slice(3)).join('\n'));
  process.exit(cmd ? 1 : 0);
}
await commands[cmd]();
