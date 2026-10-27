#!/usr/bin/env node
// Written flow: /map updates by itself after a units.tsv change (project-map: map-then-you, map-rows).
// Runs against this checkout's fixture run (board.mjs launch --fixture), never the live board.
//
//   1. Open $BOARD_URL/map at the owner's desktop viewport (desktop-1920 in viewports.mjs). Read the title, the clock
//      and Needs you.
//      Expect `(5) project map`, and phone-check waiting as `then you` behind map-polish.
//   2. Screenshot project-map-refresh-before-desktop-1920.png, reads in project-map-refresh-before.txt.
//   3. In the scratch lane file, mark map-polish done (in-flight -> done). Nothing reloads the page.
//   4. Wait for the page's own 15-second refresh until the change shows, at most three reloads.
//      Expect `(6) project map`, phone-check under Needs you as `you`, and a later clock.
//   5. Screenshot project-map-refresh-after-desktop-1920.png, reads in .txt, the page HTML in .html, the changed file in .tsv.
//   6. Put the scratch file back.
//
// Run: node .claude/skills/verify-agent-board/scripts/flows/map-refresh.mjs   (prints PASS or FAIL per step)
import fs from 'node:fs';
import path from 'node:path';
import { boardEnv, chrome } from './playwright.mjs';
import { pageOptions, viewport } from './viewports.mjs';

const env = boardEnv();
if (env.BOARD_MODE !== 'fixture') throw new Error(`needs a fixture run, not ${env.BOARD_MODE}: board.mjs launch --fixture`);
if (new URL(env.BOARD_URL).port === '4790') throw new Error('refusing the live board on port 4790');
const units = path.join(env.BOARD_SCRATCH, 'lanes/fixture-board/units.tsv');
const out = (name) => path.join(env.BOARD_EVIDENCE, `project-map-refresh-${name}`);

const read = (page) => page.evaluate(() => ({
  title: document.title,
  clock: document.body.innerText.split('\n').find((l) => l.includes('refreshes every')) ?? '',
  needs: [...document.querySelectorAll('.u.needs .id')].map((i) => i.lastChild.textContent),
  phoneCheck: [...document.querySelectorAll('section .u')]
    .find((u) => u.querySelector('.id')?.lastChild.textContent === 'phone-check')?.querySelector('.state').textContent ?? null,
}));
const save = (name, reads) => fs.writeFileSync(out(`${name}.txt`), `${JSON.stringify(reads, null, 2)}\n`);

let failed = 0;
const check = (step, ok, seen) => {
  failed += ok ? 0 : 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}: ${JSON.stringify(seen)}`);
};

const original = fs.readFileSync(units, 'utf8');
const browser = await chrome();
try {
  const page = await browser.newPage(pageOptions(viewport('desktop-1920')));
  await page.goto(`${env.BOARD_URL}/map`);
  const before = await read(page);
  save('before', before);
  await page.screenshot({ path: out('before-desktop-1920.png'), fullPage: true });
  check('before', before.title === '(5) project map' && before.phoneCheck === 'then you' && !before.needs.includes('phone-check'), before);

  if (!/^map-polish\tin-flight\t/m.test(original)) throw new Error(`${units} has no in-flight map-polish row; relaunch the fixture`);
  fs.writeFileSync(units, original.replace(/^map-polish\tin-flight\t/m, 'map-polish\tdone\t'));

  let after = before;
  let reloads = 0;
  while (reloads < 3 && !after.needs.includes('phone-check')) {
    await page.waitForEvent('load', { timeout: 20_000 }); // the page's meta refresh, not a reload of ours
    reloads += 1;
    after = await read(page);
  }
  save('after', { ...after, reloads });
  await page.screenshot({ path: out('after-desktop-1920.png'), fullPage: true });
  fs.writeFileSync(out('after.html'), await page.content());
  fs.writeFileSync(out('after.tsv'), fs.readFileSync(units, 'utf8'));
  check('after', after.title === '(6) project map' && after.needs.includes('phone-check') && after.phoneCheck === 'you'
    && after.clock !== before.clock, { ...after, reloads });
} finally {
  await browser.close();
  fs.writeFileSync(units, original);
}
console.log(`evidence: ${env.BOARD_EVIDENCE}`);
process.exitCode = failed ? 1 : 0;
