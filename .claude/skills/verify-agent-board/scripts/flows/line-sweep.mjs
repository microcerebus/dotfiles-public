#!/usr/bin/env node
// Written flow: sweep one board page across a range of widths and check every width for the layout rules look.mjs
// checks at five: no horizontal overflow, no rendered line that starts with "·", no short parenthetical split across
// two lines and no count left at a line's end without its word (line-starts.mjs). No screenshots, so a sweep of every
// width from 320 to 1920 takes 9 to 16 s on a map page. One headless Chrome page, resized for each width (844 tall
// under 600, 900 otherwise, 1x). With --open, every folded list (a PR's check list) is open, as after a tap. For a run
// of your own; it refuses the live board on port 4790. Exits 1 if any width breaks a rule or the page did not answer
// 2xx.
//
// Run: node .claude/skills/verify-agent-board/scripts/flows/line-sweep.mjs \
//        <url> [<from>-<to>] [<step>] [--json] [--open]
//   defaults: 320-1920, step 1. Prints each failing width with its first offending lines.
import { drawnLines, faultLines, lineFaults } from './line-starts.mjs';
import { chrome, evaluateSettled, openFolds, withCleanUp } from './playwright.mjs';
import { pageOptions } from './viewports.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const open = args.includes('--open');
const [url, span = '320-1920', step = '1'] = args.filter((a) => a !== '--json' && a !== '--open');
const [from, to] = span.split('-').map(Number);
if (!url || !(from > 0 && to >= from) || !(Number(step) > 0)) throw new Error('usage: line-sweep.mjs <url> [<from>-<to>] [<step>] [--json] [--open]');
if (new URL(url).port === '4790') throw new Error('refusing the live board on port 4790');

// The one flow that resizes a page: it exists to try every width, and a fresh page per width would reload 1600 times.
const size = (width) => ({ width, height: width < 600 ? 844 : 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
const browser = await chrome();
const failures = [];
let widths = 0;
let status = null;
await withCleanUp(async () => {
  const page = await browser.newPage(pageOptions(size(from)));
  if (open) await openFolds(page);
  const response = await page.goto(url);
  status = response?.status() ?? null;
  for (let width = from; width <= to; width += Number(step)) {
    await page.setViewportSize(pageOptions(size(width)).viewport);
    const seen = { overflow: await evaluateSettled(page, () => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      ...lineFaults(await evaluateSettled(page, drawnLines)) };
    widths += 1;
    if (seen.overflow || faultLines(seen).length) failures.push({ width, ...seen });
  }
}, () => browser.close());
const ok = Boolean(status && status >= 200 && status < 300) && !failures.length;
if (json) console.log(JSON.stringify({ ok, url, open, status, from, to, step: Number(step), widths, failures }, null, 2));
else {
  for (const f of failures) {
    console.log(`FAIL ${f.width}px: overflow ${f.overflow}px, "·" line starts ${f.dotStarts.length}, split parentheticals ${f.splitParens.length}, bare counts ${f.bareCounts.length}${faultLines(f).slice(0, 3).map((l) => ` [${l.text}]`).join('')}`);
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${status} ${url}: ${widths} widths from ${from} to ${to}, ${failures.length} failing`);
}
process.exitCode = ok ? 0 : 1;
