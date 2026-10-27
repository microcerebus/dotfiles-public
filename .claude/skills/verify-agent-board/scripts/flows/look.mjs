#!/usr/bin/env node
// Written flow: look at a board page as the owner sees it. Loads the URL in headless Google Chrome at each of the five
// viewports in viewports.mjs (desktop 1920, small desktop 1080, iPad mini portrait 744 and landscape 1133, phone
// 390), or at the one named by name or width; any other width is a custom size (under 600 a phone: 844 tall, 3x,
// touch; otherwise 900 tall). VERIFY_AGENT_BOARD_ENGINE=webkit loads it in Playwright's WebKit instead, for the
// iPad's layout engine. For each viewport it saves the first screen and the full page at the device scale (a full
// page taller than Chrome can capture at that scale is saved at CSS pixels), the page text with the horizontal
// overflow, and JSON with the overflow, the full-page scale and the bounds of the status strip and lane sections.
// For a run of your own; it refuses the live board on port 4790. Exits 1 unless every load answered 2xx, is not the
// board's error page (T3 unreadable answers 500) and has no horizontal overflow.
//
// Run: [VERIFY_AGENT_BOARD_ENGINE=webkit] node .claude/skills/verify-agent-board/scripts/flows/look.mjs \
//        <url> <evidence-dir> <name> [<viewport>|<width>]
//   -> <evidence-dir>/<name>-<viewport>-first.png, -full.png, .txt and .json
import fs from 'node:fs';
import path from 'node:path';
import { chrome, playwright } from './playwright.mjs';
import { VIEWPORTS, pageOptions, viewport } from './viewports.mjs';

// Chrome's largest full-page capture, in device pixels; a taller one repeats a tile of the page.
const MAX_CAPTURE_PX = 16384;
const [url, dir, name, pick] = process.argv.slice(2);
const custom = (width) => (width < 600
  ? { name: `custom-${width}`, width, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
  : { name: `custom-${width}`, width, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
const chosen = pick === undefined ? VIEWPORTS : [viewport(pick) ?? (/^\d+$/.test(pick) ? custom(Number(pick)) : null)];
if (!url || !dir || !name || chosen.includes(null)) {
  throw new Error(`usage: look.mjs <url> <evidence-dir> <name> [<viewport>|<width>] (viewports: ${VIEWPORTS.map((v) => v.name).join(', ')})`);
}
if (new URL(url).port === '4790') throw new Error('refusing the live board on port 4790');
fs.mkdirSync(dir, { recursive: true });
// Chrome is the default. An explicit WebKit pass checks the iPad's layout engine with its own temp profile.
const engine = process.env.VERIFY_AGENT_BOARD_ENGINE ?? 'chrome';
if (!['chrome', 'webkit'].includes(engine)) throw new Error(`unsupported look engine: ${engine}`);
const browser = engine === 'webkit' ? await playwright().webkit.launch({ headless: true }) : await chrome();
let failed = 0;
try {
  for (const v of chosen) {
    const page = await browser.newPage(pageOptions(v));
    const base = path.join(dir, `${name}-${v.name}`);
    const response = await page.goto(url);
    const title = await page.title();
    await page.screenshot({ path: `${base}-first.png` });
    // Chrome repeats part of a full-page image taller than 16384 device pixels. Such a page is saved at one pixel per
    // CSS pixel, with the layout still at the viewport's DPR; every other page keeps the device scale.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const scale = height * v.deviceScaleFactor > MAX_CAPTURE_PX ? 'css' : 'device';
    await page.screenshot({ path: `${base}-full.png`, fullPage: true, scale });
    // Anything wider than the viewport is cut off or scrolls sideways, so the text file records the overflow.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const layout = await page.evaluate(() => {
      const box = (e) => {
        const { x, y, width, height } = e.getBoundingClientRect();
        return { x, y, width, height };
      };
      return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
        strip: document.querySelector('.status-strip') ? box(document.querySelector('.status-strip')) : null,
        lanes: [...document.querySelectorAll('.cols section')].map((e) => ({ id: e.id, ...box(e), fragments: e.getClientRects().length })) };
    });
    fs.writeFileSync(`${base}.json`, `${JSON.stringify({ engine, viewport: v, overflow, fullScale: scale, ...layout }, null, 2)}\n`);
    fs.writeFileSync(`${base}.txt`, `${response?.status()} ${title}\n${v.name} ${v.width}x${v.height} at ${v.deviceScaleFactor}x`
      + `${v.hasTouch ? ', touch' : ''}, horizontal overflow ${overflow}px\n${await page.innerText('body')}\n`);
    const ok = Boolean(response?.ok()) && title !== 'agent board error' && overflow === 0;
    failed += ok ? 0 : 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${response?.status()} ${title} at ${v.name} (overflow ${overflow}px) -> ${base}-first.png, -full.png`);
    await page.close();
  }
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
