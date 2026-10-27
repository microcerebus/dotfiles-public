#!/usr/bin/env node
// Written flow: a PR's check status on /map updates by itself, without a reload, when GitHub's answer changes
// (project-map: map-pr-state, map-pr-checks, map-pr-live). Runs against this checkout's fixture run, whose gh is a
// stub that answers from scratch/gh/prs-board.json; never the live board.
//
//   1. Open $BOARD_URL/map at each of the five viewports in viewports.mjs (desktop 1920, small desktop 1080, iPad mini
//      portrait 744 and landscape 1133, phone 390). Read the preview-live row: its PR chip, the PR line, the checks.
//      Expect `#16 open`, `1 check running`, `1/2 checks` with e2e pending, and a preview link.
//   2. Screenshots project-map-pr-live-before-<viewport>.png, reads in project-map-pr-live-before.txt.
//   3. In scratch/gh/prs-board.json, let e2e finish green and the PR become mergeable. Nothing reloads the page.
//   4. Wait for the page's own 15-second refresh until the change shows, at most four reloads (the board asks gh
//      again after AGENT_BOARD_PR_TTL_MS, 3 s in the fixture).
//      Expect `#16 ready`, no running check, `2/2 checks` with e2e passed, the same preview link, a later clock.
//   5. Screenshots project-map-pr-live-after-<viewport>.png, reads in .txt, the page HTML in .html, the changed
//      gh answer in .json, and the width overflow of every page (0 means nothing is cut off).
//   6. Put the gh answer back.
//
// Run: node .claude/skills/verify-agent-board/scripts/flows/map-pr-live.mjs   (prints PASS or FAIL per step)
import fs from 'node:fs';
import path from 'node:path';
import { boardEnv, chrome } from './playwright.mjs';
import { VIEWPORTS, pageOptions } from './viewports.mjs';

const env = boardEnv();
if (env.BOARD_MODE !== 'fixture') throw new Error(`needs a fixture run, not ${env.BOARD_MODE}: board.mjs launch --fixture`);
if (new URL(env.BOARD_URL).port === '4790') throw new Error('refusing the live board on port 4790');
const answer = path.join(env.BOARD_SCRATCH, 'gh/prs-board.json');
const out = (name) => path.join(env.BOARD_EVIDENCE, `project-map-pr-live-${name}`);

const read = (page) => page.evaluate(() => {
  const row = [...document.querySelectorAll('section .u')].find((u) => u.querySelector('.id')?.lastChild.textContent === 'preview-live');
  return {
    title: document.title,
    clock: document.body.innerText.split('\n').find((l) => l.includes('refreshes every')) ?? '',
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    chip: row?.querySelector('.pr')?.textContent ?? null,
    meta: row?.querySelector('.pr-block .meta')?.textContent ?? null,
    checks: [...row?.querySelectorAll('.check') ?? []].map((c) => `${c.textContent}:${c.title}`),
    count: row?.querySelector('.more .count')?.textContent ?? null,
    preview: row?.querySelector('a.link')?.href ?? null,
  };
});
const save = (name, reads) => fs.writeFileSync(out(`${name}.txt`), `${JSON.stringify(reads, null, 2)}\n`);

let failed = 0;
const check = (step, ok, seen) => {
  failed += ok ? 0 : 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}: ${JSON.stringify(seen)}`);
};
const before = (r) => r.chip === '#16 open' && r.meta?.startsWith('1 check running') && r.count === '1/2 checks'
  && r.checks.includes('e2e:pending') && r.preview === 'https://board-git-feat-preview.example.app/' && r.overflow === 0;
const after = (r) => r.chip === '#16 ready' && !r.meta?.includes('running') && r.count === '2/2 checks'
  && r.checks.includes('e2e:pass') && r.preview === 'https://board-git-feat-preview.example.app/' && r.overflow === 0;

const original = fs.readFileSync(answer, 'utf8');
const browser = await chrome();
try {
  const pages = {};
  for (const v of VIEWPORTS) pages[v.name] = await browser.newPage(pageOptions(v));
  await Promise.all(Object.values(pages).map((page) => page.goto(`${env.BOARD_URL}/map`)));
  const readAll = async () => Object.fromEntries(await Promise.all(Object.entries(pages).map(async ([n, page]) => [n, await read(page)])));
  const shootAll = (when) => Promise.all(Object.entries(pages).map(([n, page]) => page.screenshot({ path: out(`${when}-${n}.png`), fullPage: true })));
  const first = await readAll();
  save('before', first);
  await shootAll('before');
  check('before', Object.values(first).every(before), first);

  const json = JSON.parse(original);
  const pr = json.data.repository.p16;
  const e2e = pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes.find((c) => c.name === 'e2e');
  if (!e2e || e2e.conclusion !== null) throw new Error(`${answer} has no running e2e check on PR 16; relaunch the fixture`);
  Object.assign(e2e, { status: 'COMPLETED', conclusion: 'SUCCESS' });
  pr.commits.nodes[0].commit.statusCheckRollup.state = 'SUCCESS';
  pr.mergeStateStatus = 'CLEAN';
  fs.writeFileSync(answer, `${JSON.stringify(json, null, 2)}\n`);

  let seen = first;
  let reloads = 0;
  // Each page refreshes on its own clock, so wait for every page to show the change, at most four reloads each.
  while (reloads < 4 && !Object.values(seen).every(after)) {
    await Promise.all(Object.entries(pages).filter(([n]) => !after(seen[n])).map(([, page]) => page.waitForEvent('load', { timeout: 20_000 })));
    reloads += 1;
    seen = await readAll();
  }
  save('after', { ...seen, reloads });
  await shootAll('after');
  const [desktop] = VIEWPORTS;
  fs.writeFileSync(out('after.html'), await pages[desktop.name].content());
  fs.writeFileSync(out('after.json'), fs.readFileSync(answer, 'utf8'));
  check('after', Object.values(seen).every(after) && seen[desktop.name].clock !== first[desktop.name].clock, { ...seen, reloads });
} finally {
  await browser.close();
  fs.writeFileSync(answer, original);
}
console.log(`evidence: ${env.BOARD_EVIDENCE}`);
process.exitCode = failed ? 1 : 0;
