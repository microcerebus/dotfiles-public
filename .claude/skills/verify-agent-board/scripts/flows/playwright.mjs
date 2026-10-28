// Shared setup for the written flows: Playwright from the pinned pnpm global, driving a headless Google Chrome with a
// throwaway profile, so a flow never touches the shared agent Chrome window or anyone's tabs.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Keep in step with the pin in scripts/dotfiles-autoupdate.
const PIN = 'playwright-core@1.64.1';

// pnpm 12 gives each global its own directory, so ask pnpm where the package is instead of guessing from `root -g`.
export function playwright() {
  try {
    const listed = JSON.parse(spawnSync('pnpm', ['ls', '-g', '--depth', '0', '--json'], { encoding: 'utf8' }).stdout);
    const dir = listed.map((g) => g.dependencies?.['playwright-core']?.path).find(Boolean);
    return createRequire(path.join(dir, 'noop.js'))(dir);
  } catch {
    throw new Error(`playwright-core is missing from the pnpm globals; the daily sync installs the pin, or run: pnpm add -g -E ${PIN}`);
  }
}

// Google Chrome only (never Brave or a bundled Chromium), headless with its own temp profile. On macOS Chrome puts its
// singleton socket in the user temp dir, not TMPDIR, unless MAC_CHROMIUM_TMPDIR says otherwise; under
// scripts/test-sandbox that dir is not writable and Chrome exits 21, so it gets the sandbox's TMPDIR.
export async function chrome() {
  const env = process.env.TEST_SANDBOX && process.env.TMPDIR ? { ...process.env, MAC_CHROMIUM_TMPDIR: process.env.TMPDIR } : undefined;
  return playwright().chromium.launch({ channel: 'chrome', headless: true, env });
}

// page.evaluate on a page that reloads itself (the board's 15-second meta refresh) fails with "Execution context was
// destroyed" when the reload lands mid-call. Wait for the new document and ask it again; any other error is real.
export async function evaluateSettled(page, fn, arg, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await page.evaluate(fn, arg);
    } catch (error) {
      if (attempt >= tries || !/Execution context was destroyed|Cannot find context with specified id/.test(error.message)) throw error;
      await page.waitForLoadState('load');
    }
  }
}

// Open every folded list (<details>, such as a PR's check list) on each load of the page, its meta refresh's included,
// as a tap on each summary would. An init script runs outside the page's CSP, which forbids the page's own scripts.
export async function openFolds(page) {
  await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
    for (const fold of document.querySelectorAll('details')) fold.open = true;
  }));
}

// A flow's body, then its cleanup: every cleanup step runs in order even when the body or an earlier step fails, so a
// browser that will not close never stops the steps that put the fixture back. Every failure is reported, the first
// one first: a lone failure is rethrown as it is, and several become one AggregateError, so a cleanup failure after a
// failed body is reported beside the body's error, never instead of it.
export async function withCleanUp(body, ...steps) {
  const errors = [];
  let value;
  for (const step of [async () => { value = await body(); }, ...steps]) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 1) throw new AggregateError(errors, `${errors[0].message} (then: ${errors.slice(1).map((e) => e.message).join('; ')})`);
  if (errors.length) throw errors[0];
  return value;
}

// The run's values, as `board.mjs env` prints them for the shell.
export function boardEnv() {
  const run = spawnSync(process.execPath, [path.join(SKILL_SCRIPTS, 'board.mjs'), 'env'], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`board.mjs env failed: ${(run.stderr || run.stdout).trim()}`);
  return Object.fromEntries([...run.stdout.matchAll(/^export (\w+)='((?:[^']|'\\'')*)'$/gm)]
    .map(([, k, v]) => [k, v.replaceAll("'\\''", "'")]));
}
