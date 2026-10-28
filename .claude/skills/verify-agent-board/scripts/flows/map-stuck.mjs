#!/usr/bin/env node
// Written flow: the Stuck list on /map, after Needs you and before the lanes (project-map: map-stuck).
// Runs against this checkout's fixture run (board.mjs launch --fixture), never the live board. Each scenario swaps the
// run's lanes for one of STUCK_SCENARIOS in scripts/fixture.mjs, which also names the rows it expects.
//
//   1. Put the initial scenario in the scratch lanes: one lane with a stalled unit whose PR fails lint, a paused one,
//      one in flight with no owner, a draft PR with a failing check, a queued unit whose owner thread is closed, and
//      units that are fine (one held by an open child thread hidden from the thread list).
//   2. Open $BOARD_URL/map at desktop-1920. Expect Stuck after Needs you, listing the five troubled units oldest first,
//      each linked to its row, and the status strip's "N stuck" equal to the heading's count. Follow the first link:
//      the page lands on that unit's row.
//   3. Look at the page at all five viewports and 900 px (look.mjs), and sweep every width from 320 to 1920
//      (line-sweep.mjs, map-stuck-initial-sweep.json): map-stuck-initial-<viewport>-first.png and -full.png. On
//      phone-390 the status strip, Needs you and the Stuck heading and its first row fit the first 844 px.
//   4. With the desktop page still open, fix the scratch data (the stall lands, the checks pass, the orphan gets an
//      owner). Wait for the page's own refresh until Stuck lists only paused-spike and lost-ref: map-stuck-resolved.
//   5. Shoot the recurring (old healthy standing work is not stuck; standing work with no owner, a closed owner thread
//      or a failing draft PR is), empty ("Nothing stuck"), degraded ("Could not check for stuck work: ...") and crowded
//      scenarios at all five viewports. Crowded lists 15: the oldest five show above "10 more stuck", which opens in
//      place to all 15 (map-stuck-crowded-open). In every scenario the strip's stuck figure matches the heading.
//   Every page read survives the page's own refresh (evaluateSettled in playwright.mjs).
//   6. Hash the scratch lanes before and after each scenario's reads: the board writes nothing.
//   7. Put the seeded lanes back, open every check list as a tap would, and look at map-polish's card (feat/polish, whose
//      check list holds a long name with a kept parenthetical) at all five viewports and 900 px, and sweep every width
//      with the lists open: map-stuck-checks-open-<viewport>-first.png and -full.png. The name reads in order.
//
// Run: node .claude/skills/verify-agent-board/scripts/flows/map-stuck.mjs [--json] [--dry-run]
//   --dry-run prints the plan and changes nothing; --json prints the results as one JSON object.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STUCK_SCENARIOS, seedStuck } from '../fixture.mjs';
import { faultLines, keptInOrder } from './line-starts.mjs';
import { SKILL_SCRIPTS, boardEnv, chrome, evaluateSettled, openFolds, withCleanUp } from './playwright.mjs';
import { pageOptions, viewport } from './viewports.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const env = boardEnv();
if (env.BOARD_MODE !== 'fixture') throw new Error(`needs a fixture run, not ${env.BOARD_MODE}: board.mjs launch --fixture`);
if (new URL(env.BOARD_URL).port === '4790') throw new Error('refusing the live board on port 4790');
const lanes = path.join(env.BOARD_SCRATCH, 'lanes');
const seeded = path.join(env.BOARD_SCRATCH, 'lanes-seeded');
const LOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'look.mjs');
const SWEEP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'line-sweep.mjs');
const order = ['initial', 'resolved', 'recurring', 'empty', 'degraded', 'crowded'];
// The seeded map-polish card, whose PR's check list holds a long check name with a kept parenthetical.
const CHECKS_AT = `#${encodeURIComponent('unit-fixture-board/map-polish')}`;
const LONG_CHECK = 'verify-agent-board / fixture flows and phone shots (390 and 1440)';
const { STUCK_SHOWN } = await import(pathToFileURL(path.join(SKILL_SCRIPTS, '../../../../files/bin/agent-board.mjs')));
// The rows a closed list shows, and the fold under them.
const shownOf = (name) => STUCK_SCENARIOS[name].stuck.slice(0, STUCK_SHOWN);
const foldOf = (name) => (STUCK_SCENARIOS[name].stuck.length > STUCK_SHOWN ? `${STUCK_SCENARIOS[name].stuck.length - STUCK_SHOWN} more stuck` : null);

if (args.includes('--dry-run')) {
  const plan = { url: `${env.BOARD_URL}/map`, evidence: env.BOARD_EVIDENCE, moves: `${lanes} -> ${seeded}, restored at the end`,
    scenarios: order.map((name) => ({ name, stuck: STUCK_SCENARIOS[name].stuck, needs: STUCK_SCENARIOS[name].needs,
      shots: `map-stuck-${name}-<viewport>-first.png, -full.png` })),
    checksOpen: { url: `${env.BOARD_URL}/map${CHECKS_AT}`, shots: 'map-stuck-checks-open-<viewport>-first.png, -full.png' } };
  console.log(json ? JSON.stringify(plan, null, 2) : plan.scenarios.map((s) => `${s.name}: Stuck ${s.stuck.join(', ') || 'none'}; Needs you ${s.needs}`).join('\n'));
  process.exit(0);
}
if (fs.existsSync(seeded)) throw new Error(`${seeded} is left from an earlier run that did not finish; relaunch the fixture`);

const steps = [];
const scenarios = {};
let failed = 0;
const check = (step, ok, seen) => {
  failed += ok ? 0 : 1;
  steps.push({ step, ok, seen });
  if (!json) console.log(`${ok ? 'PASS' : 'FAIL'} ${step}: ${JSON.stringify(seen)}`);
};
const hash = (dir) => createHash('sha256').update(fs.readdirSync(dir, { recursive: true }).sort()
  .filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => `${f}\0${fs.readFileSync(path.join(dir, f), 'utf8')}`).join('\0')).digest('hex');
const stuckOf = (html) => [...html.slice(html.indexOf('id="stuck"'), html.indexOf('<div class="cols">'))
  .matchAll(/<a class="id" href="[^"]+">([^<]+)<\/a>/g)].map((m) => m[1]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// The board answers PR state from its cache and refreshes it in the background, so poll until the page agrees: every
// row with the fold open, since the rows after the fold are the ones a late PR answer adds, and the expected line.
async function settle(name) {
  const deadline = Date.now() + 30_000;
  const { stuck, line } = STUCK_SCENARIOS[name];
  for (;;) {
    const html = await (await fetch(`${env.BOARD_URL}/map?stuck=all`)).text();
    if ((same(stuckOf(html), stuck) && (!line || html.replace(/<[^>]*>/g, '').includes(line))) || Date.now() > deadline) return html;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
// What a page shows: the Stuck rows and fold, the Needs you count, the quiet line, the strip's and the heading's stuck
// figures, and where each section sits.
const read = (page) => evaluateSettled(page, () => {
  const box = (e) => (e ? { top: e.getBoundingClientRect().top + scrollY, bottom: e.getBoundingClientRect().bottom + scrollY } : null);
  const stuck = document.querySelector('#stuck');
  const line = stuck?.tagName === 'DIV' ? stuck.innerText : null;
  const strip = /(\d+) stuck|stuck (unknown)/.exec(document.querySelector('.status-strip')?.innerText ?? '');
  return { title: document.title, stuck: [...document.querySelectorAll('.stuck .id')].map((a) => a.textContent),
    fold: document.querySelector('#stuck-more a')?.textContent ?? null,
    stripStuck: strip ? strip[1] ?? strip[2] : null,
    headingStuck: /Stuck · (\d+)/.exec(stuck?.textContent ?? '')?.[1] ?? (line?.startsWith('Could not check') ? 'unknown' : line ? '0' : null),
    needs: document.querySelector('h2.attn')?.textContent ?? null, line,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bounds: { strip: box(document.querySelector('.status-strip')), needs: box(document.querySelector('h2.attn')),
      stuck: box(stuck), firstStuck: box(document.querySelector('.stuck')) } };
});
const expectOk = (name, seen) => same(seen.stuck, shownOf(name)) && seen.fold === foldOf(name) && seen.needs === `Needs you · ${STUCK_SCENARIOS[name].needs}`
  && (!STUCK_SCENARIOS[name].line || seen.line?.includes(STUCK_SCENARIOS[name].line)) && seen.overflow === 0
  && seen.stripStuck !== null && seen.stripStuck === seen.headingStuck;
const save = (name, data) => fs.writeFileSync(path.join(env.BOARD_EVIDENCE, `map-stuck-${name}.txt`), `${JSON.stringify(data, null, 2)}\n`);

// The five viewports, then 900 px, the narrowest two-column map, where a row has the least room beside its lane, then
// every width from 320 to 1920 for overflow, a line that starts with "·" and a split short parenthetical. With open,
// every folded list on the page is open.
function look(name, query = '', open = false) {
  const folds = open ? ['--open'] : [];
  for (const [label, size] of [['five viewports', []], ['900 px', ['900']]]) {
    const run = spawnSync(process.execPath, [LOOK, `${env.BOARD_URL}/map${query}`, env.BOARD_EVIDENCE, `map-stuck-${name}`, ...size, ...folds], { encoding: 'utf8' });
    check(`${name} at ${label}`, run.status === 0, run.stdout.trim().split('\n').map((l) => l.split(' -> ')[0]));
  }
  const sweep = spawnSync(process.execPath, [SWEEP, `${env.BOARD_URL}/map${query}`, '320-1920', '1', '--json', ...folds], { encoding: 'utf8' });
  const swept = sweep.status === null ? null : JSON.parse(sweep.stdout || 'null');
  fs.writeFileSync(path.join(env.BOARD_EVIDENCE, `map-stuck-${name}-sweep.json`), `${JSON.stringify(swept, null, 2)}\n`);
  check(`${name} at every width from 320 to 1920`, sweep.status === 0, swept
    ? { widths: swept.widths, failing: swept.failures.map((f) => `${f.width}: ${faultLines(f)[0]?.text ?? `overflow ${f.overflow}px`}`).slice(0, 5) }
    : sweep.stderr.trim());
}

// The browser starts before the lanes move, and the move sits inside the body, so a browser that fails to start leaves
// the lanes in place and any later failure puts them back. The lanes go back before the browser closes, and every step
// runs, so a close that rejects cannot strand them in lanes-seeded.
const browser = await chrome();
const restoreLanes = () => {
  if (!fs.existsSync(seeded)) return;
  fs.rmSync(lanes, { recursive: true, force: true });
  fs.renameSync(seeded, lanes);
};
await withCleanUp(async () => {
  fs.renameSync(lanes, seeded);
  const desk = await browser.newPage(pageOptions(viewport('desktop-1920')));
  const phone = await browser.newPage(pageOptions(viewport('phone-390')));
  for (const name of order) {
    if (name !== 'resolved') {
      seedStuck(env.BOARD_SCRATCH, name, Date.now());
      fs.writeFileSync(path.join(env.BOARD_EVIDENCE, `map-stuck-${name}.html`), await settle(name));
      await desk.goto(`${env.BOARD_URL}/map`);
    } else {
      // The fix lands while the page is open; only its own meta refresh may show it.
      seedStuck(env.BOARD_SCRATCH, name, Date.now());
      let seen = await read(desk);
      let reloads = 0;
      while (reloads < 4 && !same(seen.stuck, shownOf(name))) {
        await desk.waitForEvent('load', { timeout: 20_000 });
        reloads += 1;
        seen = await read(desk);
      }
      check('resolved by the page\'s own refresh', reloads > 0 && same(seen.stuck, shownOf(name)), { reloads, stuck: seen.stuck });
      fs.writeFileSync(path.join(env.BOARD_EVIDENCE, 'map-stuck-resolved.html'), await desk.content());
    }
    const before = hash(lanes);
    const seen = await read(desk);
    check(`${name} on desktop-1920`, expectOk(name, seen), { stuck: seen.stuck, fold: seen.fold, strip: seen.stripStuck, heading: seen.headingStuck,
      needs: seen.needs, line: seen.line, overflow: seen.overflow });
    if (name === 'initial') {
      // The first Stuck row links to its unit's row in the lane.
      await desk.click('.stuck .id');
      const target = await evaluateSettled(desk, () => ({ hash: location.hash, id: document.querySelector(':target')?.id ?? null }));
      check('initial: first Stuck link lands on its row', target.id === `unit-fixture-stuck/${seen.stuck[0]}`, target);
    }
    let opened = null;
    if (foldOf(name)) {
      // The fold opens in place: every row, oldest first, with the link now offering to hide them.
      await desk.click('#stuck-more a');
      await desk.waitForURL(/[?&]stuck=all/);
      opened = await read(desk);
      // The page's separator has a no-break space before its dot.
      check(`${name}: the fold opens to every Stuck row`, same(opened.stuck, STUCK_SCENARIOS[name].stuck) && opened.fold === `${foldOf(name)}\u00a0· hide`
        && opened.overflow === 0, { stuck: opened.stuck, fold: opened.fold });
    }
    await phone.goto(`${env.BOARD_URL}/map`);
    const small = await read(phone);
    const first = viewport('phone-390').height;
    const onFirst = ['strip', 'needs', 'stuck', 'firstStuck'].filter((k) => small.bounds[k]).every((k) => small.bounds[k].bottom <= first);
    if (['initial', 'resolved', 'empty', 'degraded'].includes(name)) check(`${name}: phone-390 first screen holds the strip, Needs you and Stuck`, onFirst, small.bounds);
    save(name, { desktop: seen, opened, phone: { ...small, firstScreenHoldsStuck: onFirst } });
    look(name);
    if (opened) look(`${name}-open`, '?stuck=all#stuck-more');
    check(`${name}: page reads left the lanes unchanged`, hash(lanes) === before, { before: before.slice(0, 12) });
    scenarios[name] = { stuck: seen.stuck, fold: seen.fold, opened: opened?.stuck ?? null, strip: seen.stripStuck, heading: seen.headingStuck,
      needs: seen.needs, line: seen.line, phoneFirstScreen: onFirst, phoneBounds: small.bounds };
  }
  restoreLanes();
  // On a phone, the long check name reads in order: its kept parenthetical comes after the words before it.
  const open = await browser.newPage(pageOptions(viewport('phone-390')));
  await openFolds(open);
  await open.goto(`${env.BOARD_URL}/map${CHECKS_AT}`);
  const reading = await evaluateSettled(open, keptInOrder, LONG_CHECK);
  check('checks-open: a long check name reads in order on phone-390', reading.found && reading.inOrder, reading);
  await open.close();
  look('checks-open', CHECKS_AT, true);
}, restoreLanes, () => fs.rmSync(path.join(env.BOARD_SCRATCH, 'gh/prs-stuck.json'), { force: true }), () => browser.close());
if (json) console.log(JSON.stringify({ ok: !failed, evidence: env.BOARD_EVIDENCE, scenarios, steps }, null, 2));
else console.log(`evidence: ${env.BOARD_EVIDENCE}`);
process.exitCode = failed ? 1 : 0;
