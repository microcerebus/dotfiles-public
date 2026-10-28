#!/usr/bin/env node
// Written flow: look at a board page as the owner sees it. Loads the URL in headless Google Chrome at each of the five
// viewports in viewports.mjs (desktop 1920, small desktop 1080, iPad mini portrait 744 and landscape 1133, phone
// 390), or at the one named by name or width; any other width is a custom size (under 600 a phone: 844 tall, 3x,
// touch; otherwise 900 tall). VERIFY_AGENT_BOARD_ENGINE=webkit loads it in Playwright's WebKit instead, for the
// iPad's layout engine. For each viewport it saves the first screen and the full page at the device scale (a full
// page taller than Chrome can capture at that scale is saved at CSS pixels), the page text with the horizontal
// overflow, and JSON with the overflow, the full-page scale, the bounds of the status strip and lane sections, every
// rendered line that starts with "·", every short parenthetical split across two lines and every count left at a
// line's end without its word (line-starts.mjs). With --open, every folded list (a PR's check list) is open on each
// load, as after a tap. For a run of your own; it refuses the live board on port 4790. Exits 1 unless every load
// answered 2xx, is not the board's error page (T3 unreadable answers 500), has no horizontal overflow, no line that
// starts with "·", no split short parenthetical and no count left at a line's end without its word.
//
// Run: [VERIFY_AGENT_BOARD_ENGINE=webkit] node .claude/skills/verify-agent-board/scripts/flows/look.mjs \
//        <url> <evidence-dir> <name> [<viewport>|<width>] [--open]
//   -> <evidence-dir>/<name>-<viewport>-first.png, -full.png, .txt and .json
import fs from 'node:fs';
import path from 'node:path';
import { drawnLines, faultLines, lineFaults } from './line-starts.mjs';
import { chrome, evaluateSettled, openFolds, playwright, withCleanUp } from './playwright.mjs';
import { VIEWPORTS, pageOptions, viewport } from './viewports.mjs';

// Chrome's largest full-page capture, in device pixels; a taller one repeats a tile of the page.
const MAX_CAPTURE_PX = 16384;
const open = process.argv.includes('--open');
const [url, dir, name, pick] = process.argv.slice(2).filter((a) => a !== '--open');
const custom = (width) => (width < 600
  ? { name: `custom-${width}`, width, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
  : { name: `custom-${width}`, width, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
const chosen = pick === undefined ? VIEWPORTS : [viewport(pick) ?? (/^\d+$/.test(pick) ? custom(Number(pick)) : null)];
if (!url || !dir || !name || chosen.includes(null)) {
  throw new Error(`usage: look.mjs <url> <evidence-dir> <name> [<viewport>|<width>] [--open] (viewports: ${VIEWPORTS.map((v) => v.name).join(', ')})`);
}
if (new URL(url).port === '4790') throw new Error('refusing the live board on port 4790');
fs.mkdirSync(dir, { recursive: true });
// Chrome is the default. An explicit WebKit pass checks the iPad's layout engine with its own temp profile.
const engine = process.env.VERIFY_AGENT_BOARD_ENGINE ?? 'chrome';
if (!['chrome', 'webkit'].includes(engine)) throw new Error(`unsupported look engine: ${engine}`);
const browser = engine === 'webkit' ? await playwright().webkit.launch({ headless: true }) : await chrome();
let failed = 0;
await withCleanUp(async () => {
  for (const v of chosen) {
    const page = await browser.newPage(pageOptions(v));
    if (open) await openFolds(page);
    const base = path.join(dir, `${name}-${v.name}`);
    const response = await page.goto(url);
    const title = await page.title();
    await page.screenshot({ path: `${base}-first.png` });
    // Chrome repeats part of a full-page image taller than 16384 device pixels. Such a page is saved at one pixel per
    // CSS pixel, with the layout still at the viewport's DPR; every other page keeps the device scale.
    const height = await evaluateSettled(page, () => document.documentElement.scrollHeight);
    const scale = height * v.deviceScaleFactor > MAX_CAPTURE_PX ? 'css' : 'device';
    await page.screenshot({ path: `${base}-full.png`, fullPage: true, scale });
    // Anything wider than the viewport is cut off or scrolls sideways, so the text file records the overflow.
    const overflow = await evaluateSettled(page, () => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const layout = await evaluateSettled(page, () => {
      const box = (e) => {
        const { x, y, width, height } = e.getBoundingClientRect();
        return { x, y, width, height };
      };
      return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
        strip: document.querySelector('.status-strip') ? box(document.querySelector('.status-strip')) : null,
        lanes: [...document.querySelectorAll('.cols section')].map((e) => ({ id: e.id, ...box(e), fragments: e.getClientRects().length })) };
    });
    const faults = lineFaults(await evaluateSettled(page, drawnLines));
    const { dotStarts, splitParens, bareCounts } = faults;
    fs.writeFileSync(`${base}.json`, `${JSON.stringify({ engine, viewport: v, open, overflow, fullScale: scale, ...layout, ...faults }, null, 2)}\n`);
    fs.writeFileSync(`${base}.txt`, `${response?.status()} ${title}\n${v.name} ${v.width}x${v.height} at ${v.deviceScaleFactor}x`
      + `${v.hasTouch ? ', touch' : ''}${open ? ', folds open' : ''}, horizontal overflow ${overflow}px, lines starting with "·" ${dotStarts.length}, split parentheticals ${splitParens.length}, bare counts ${bareCounts.length}\n`
      + `${faultLines(faults).map((l) => `  at y ${l.y}: ${l.text}\n`).join('')}${await page.innerText('body')}\n`);
    const ok = Boolean(response?.ok()) && title !== 'agent board error' && overflow === 0 && !faultLines(faults).length;
    failed += ok ? 0 : 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${response?.status()} ${title} at ${v.name} (overflow ${overflow}px, "·" line starts ${dotStarts.length}, split parentheticals ${splitParens.length}, bare counts ${bareCounts.length})`
      + `${faultLines(faults).slice(0, 3).map((l) => ` [${l.text}]`).join('')} -> ${base}-first.png, -full.png`);
    await page.close();
  }
}, () => browser.close());
process.exitCode = failed ? 1 : 0;
