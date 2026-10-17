#!/usr/bin/env node
// Written flow: look at a board page as the owner sees it. Loads the URL once in headless Google Chrome at 1440x900, or at
// the width given (a width under 600 is a phone: 844 tall, 3x, touch; 390 is the phone the brief names), saves a
// full-page screenshot and the page text with the horizontal overflow measured. For a run of your own; it refuses the
// live board on port 4790. Exits 1 unless the page answered 2xx and is not the board's error page (T3 unreadable
// answers 500).
//
// Run: node .claude/skills/verify-agent-board/scripts/flows/look.mjs <url> <evidence-dir> <name> [<width>]
//   -> <evidence-dir>/<name>-desktop.png and <name>-desktop.txt (a width under 600 names them -phone)
import fs from 'node:fs';
import path from 'node:path';
import { chrome } from './playwright.mjs';

const [url, dir, name, widthArg = '1440'] = process.argv.slice(2);
if (!url || !dir || !name || !/^\d+$/.test(widthArg)) throw new Error('usage: look.mjs <url> <evidence-dir> <name> [<width>]');
if (new URL(url).port === '4790') throw new Error('refusing the live board on port 4790');
const width = Number(widthArg);
const phone = width < 600;
const kind = phone ? 'phone' : 'desktop';
fs.mkdirSync(dir, { recursive: true });
const browser = await chrome();
try {
  const page = await browser.newPage(phone
    ? { viewport: { width, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
    : { viewport: { width, height: 900 } });
  const shot = path.join(dir, `${name}-${kind}.png`);
  const response = await page.goto(url);
  const title = await page.title();
  await page.screenshot({ path: shot, fullPage: true });
  // Anything wider than the viewport is cut off or scrolls sideways on a phone, so the text file records the overflow.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  fs.writeFileSync(path.join(dir, `${name}-${kind}.txt`),
    `${response?.status()} ${title}\nwidth ${width}, horizontal overflow ${overflow}px\n${await page.innerText('body')}\n`);
  const ok = Boolean(response?.ok()) && title !== 'agent board error';
  console.log(`${ok ? 'PASS' : 'FAIL'} ${response?.status()} ${title} at ${width} (overflow ${overflow}px) -> ${shot}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
