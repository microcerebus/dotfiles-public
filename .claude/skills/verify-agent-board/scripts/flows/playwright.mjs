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

// Google Chrome only (never Brave or a bundled Chromium), headless with its own temp profile.
export async function chrome() {
  return playwright().chromium.launch({ channel: 'chrome', headless: true });
}

// The run's values, as `board.mjs env` prints them for the shell.
export function boardEnv() {
  const run = spawnSync(process.execPath, [path.join(SKILL_SCRIPTS, 'board.mjs'), 'env'], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`board.mjs env failed: ${(run.stderr || run.stdout).trim()}`);
  return Object.fromEntries([...run.stdout.matchAll(/^export (\w+)='((?:[^']|'\\'')*)'$/gm)]
    .map(([, k, v]) => [k, v.replaceAll("'\\''", "'")]));
}
