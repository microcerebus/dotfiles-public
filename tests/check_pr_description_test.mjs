import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validatePrDescription } from '../scripts/check-pr-description.mjs';

const cli = fileURLToPath(new URL('../scripts/check-pr-description.mjs', import.meta.url));
const base = `## Context / problem
Refreshing the map leaves the stale label visible after its row is completed.

## Solution
Refresh the label when a row changes state.
Added a regression for completing a stale row.

## Reproduce / test
1. Open the map with a stale row.
2. Complete the row and reload. Its stale label disappears.
`;
const images = `\n## Before / after
### Before
![Before: completed row retains its label](https://github.com/user-attachments/assets/before-image)
### After
![After: completed row has no stale label](https://github.com/user-attachments/assets/after-image)
`;
const check = (body, visualScope = false) => validatePrDescription(body, { visualScope });
const messages = (body, visualScope = false) => check(body, visualScope).map((finding) => finding.message).join('\n');

test('accepts concise nonvisual work without irrelevant evidence or follow-ups', () => {
  assert.deepEqual(check(base), []);
});

test('accepts meaningful detailed solutions without a length ceiling', () => {
  const details = Array.from({ length: 90 }, (_, i) => `Case ${i + 1} preserves the row state when its source reconnects.`).join('\n');
  assert.deepEqual(check(base.replace('Added a regression', `${details}\nAdded a regression`)), []);
});

test('accepts visible paired media and genuine follow-ups', () => {
  assert.deepEqual(check(`${base}${images}\n## Follow-ups\nTrack phone keyboard navigation in #123.\n`, true), []);
});

test('visual scope requires media even when the body has no evidence heading', () => {
  assert.match(messages(base, true), /before|after|evidence/i);
});

test('honest pending recordings fail visual readiness', () => {
  assert.match(messages(`${base}\n## Before / after\nBefore and after recordings are pending upload.\n`, true), /before|after|media|pending/i);
});

test('one-sided evidence does not satisfy before and after', () => {
  assert.ok(check(`${base}\n## Before / after\n![After](https://example.org/after.png)\n`, true).length);
});

test('private evidence bundle claim from the old PR does not count as visible media', () => {
  const oldClaim = 'Before and after screenshots at desktop and phone widths are in the private evidence bundle (`evidence/leads-m1/before-after`), with main\'s preferences page as "before".';
  assert.ok(check(`${base}\n## Before / after\n${oldClaim}\n`, true).length);
});

test('comments and fenced examples cannot supply missing evidence', () => {
  assert.ok(check(`${base}\n<!-- ${images} -->\n\n## Before / after\n\n\`\`\`md\n${images}\n\`\`\`\n`, true).length);
});

test('private paths and placeholder destinations are rejected', () => {
  for (const destination of ['file:///Users/example/before.png', '/tmp/before.png', 'https://example.com/TODO.png']) {
    const body = `${base}${images.replace('https://github.com/user-attachments/assets/before-image', destination)}`;
    assert.ok(check(body, true).length, destination);
  }
});

test('generic log links are not visible before and after media', () => {
  const body = `${base}\n## Before / after\nBefore: [logs](https://example.org/build/1)\nAfter: [logs](https://example.org/build/2)\n`;
  assert.ok(check(body, true).length);
});

test('requires meaningful context, solution and reproducible manual steps', () => {
  for (const heading of ['Context / problem', 'Solution', 'Reproduce / test']) {
    assert.ok(check(base.replace(`## ${heading}`, '## Unrelated')).length, heading);
  }
  assert.ok(check('## Context / problem\nTODO\n## Solution\nTBD\n## Reproduce / test\nFill in steps.\n').length);
});

test('rejects actual old PR CI-result inventory while allowing new coverage', () => {
  const oldResults = '- `pnpm test`: 620 unit tests pass, including 21 jsdom tests for the screen.\n- Full `pnpm test:e2e` locally, twice: 543 Chrome cases pass each time.';
  assert.match(messages(`${base}\n${oldResults}\n`), /CI|result|inventory|pass/i);
  assert.deepEqual(check(base.replace('Added a regression', 'Added unit and end-to-end coverage for offline rows.\nAdded a regression')), []);
});

test('does not ban ordinary expected behavior or discussion of CI changes', () => {
  assert.deepEqual(check(base.replace('Refresh the label when a row changes state.', 'The CI metadata workflow now checks body edits without restarting heavy verification.')), []);
});

test('manual testing cannot be only executable command lists', () => {
  const commands = base.replace(/1\. Open the map[\s\S]*/, '1. `pnpm typecheck`\n2. `pnpm test`\n');
  assert.ok(check(commands).length);
  assert.ok(check(base.replace(/1\. Open the map[\s\S]*/, '```sh\npnpm test\n```\n')).length);
});

test('a short observable-flow summary may link detailed ticket scenarios', () => {
  const linked = base.replace(/1\. Open the map[\s\S]*/, 'Complete a stale row and confirm its label disappears after reload.\n[Detailed user flows](https://github.com/example/product/issues/123#user-flows)\n');
  assert.deepEqual(check(linked), []);
});

test('evidence follows the manual flow summary in the canonical order', () => {
  assert.ok(check(base.replace('## Reproduce / test', `${images}\n## Reproduce / test`), true).length);
});

test('collapsed media is not visible readiness evidence', () => {
  assert.ok(check(`${base}\n## Before / after\n<details>\n<summary>Evidence</summary>\n${images.replace('## Before / after', '')}\n</details>\n`, true).length);
});

test('before screenshots can describe a missing UI element without claiming evidence is missing', () => {
  assert.deepEqual(check(`${base}${images.replace('Before: completed row retains its label', 'Before: tooltip missing from the completed row')}`, true), []);
});

test('leading evidence labels survive ordinary captions containing the other side word', () => {
  assert.deepEqual(check(`${base}${images.replace('Before: completed row retains its label', 'Before: empty editor after reload')}`, true), []);
});

test('bare URLs or generic scenario links are not a user-flow summary', () => {
  for (const content of ['https://github.com/example/product/issues/123', '[Full scenarios](https://github.com/example/product/issues/123)']) {
    assert.ok(check(base.replace(/1\. Open the map[\s\S]*/, `${content}\n`)).length);
  }
});

test('private and reserved-placeholder hosts do not count as shared media', () => {
  for (const host of ['localhost', '127.0.0.1', '10.0.0.2', '192.168.1.2', 'example.invalid']) {
    assert.ok(check(`${base}${images.replace('https://github.com/user-attachments/assets/before-image', `https://${host}/before.png`)}`, true).length, host);
  }
});

test('JSON stdin checks actual submitted body and requires an explicit boolean', () => {
  const run = (value) => spawnSync(process.execPath, [cli, '--body-json-stdin'], { input: JSON.stringify(value), encoding: 'utf8' });
  assert.equal(run({ body: base, visualScope: false }).status, 0);
  assert.equal(run({ body: base, visualScope: true }).status, 1);
  for (const value of [{ body: base }, { body: base, visualScope: 'false' }, { body: null, visualScope: false }]) {
    assert.equal(run(value).status, 2);
  }
});

test('file CLI is portable and distinguishes findings from invalid usage', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-description-'));
  try {
    const bodyFile = path.join(dir, 'submitted.md');
    writeFileSync(bodyFile, base);
    const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: dir } });
    assert.equal(run(['--body-file', bodyFile, '--visual-scope', 'false']).status, 0);
    const missingEvidence = run(['--body-file', bodyFile, '--visual-scope', 'true']);
    assert.equal(missingEvidence.status, 1);
    assert.match(missingEvidence.stderr, /before|after|evidence/i);
    assert.equal(run(['--body-file', bodyFile]).status, 2);
    assert.equal(run(['--body-file', bodyFile, '--visual-scope', 'guess']).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const codes = (body, visualScope = false) => check(body, visualScope).map((finding) => finding.code);
const withContext = (text) => base.replace('Refreshing the map leaves the stale label visible after its row is completed.', text);
const withTest = (text) => base.replace(/1\. Open the map[\s\S]*/, `${text}\n`);

test('placeholder words inside real prose are not placeholders', () => {
  assert.deepEqual(codes(withContext('Pending cards vanish after a reload.')), []);
  assert.deepEqual(codes(withContext('The todo list loses its placeholder text after a reload.')), []);
  for (const text of ['Pending.', 'TODO: fill in', '<pending>', '[TODO]', 'Describe the problem.']) {
    assert.ok(codes(withContext(text)).includes('empty-section'), text);
  }
});

test('product outcomes with a count are not CI results', () => {
  assert.deepEqual(codes(withContext('The card shows 2 failed attempts and a Retry button.')), []);
  for (const line of ['Playwright: 543 passed.', '5 passed, 1 failed', '3 tests failed']) {
    assert.ok(codes(`${base}\n${line}\n`).includes('ci-inventory'), line);
  }
});

const table = (cells, header = '| Before | After |') => `${base}\n## Before / after\n${header}\n| --- | --- |\n${cells}\n`;

test('table header columns decide the side of generic GitHub media', () => {
  const dragged = '| <img alt="Image" src="https://github.com/user-attachments/assets/aaa"> | <img alt="Image" src="https://github.com/user-attachments/assets/bbb"> |';
  assert.deepEqual(codes(table(dragged), true), []);
  const markdown = '| ![Image](https://github.com/user-attachments/assets/aaa) | ![Image](https://github.com/user-attachments/assets/bbb) |';
  assert.deepEqual(codes(table(markdown), true), []);
  assert.ok(codes(table(markdown, '| Old | New |'), true).includes('missing-media'));
  assert.ok(codes(table('| ![Image](https://github.com/user-attachments/assets/aaa) | |'), true).includes('missing-media'));
});

test('common CI-result patterns without counts are rejected', () => {
  const oldLine = '- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `check:boundaries`, `check-secrets`, `check-tests`, `check-public-inventory` pass.';
  for (const line of [oldLine, 'All tests pass.', 'Lint passes.', '| Typecheck | ✅ |']) {
    assert.ok(codes(`${base}\n${line}\n`).includes('ci-inventory'), line);
  }
  assert.deepEqual(codes(withContext('The card passes validation and the lint rule passes the new case through.')), []);
  assert.deepEqual(codes(withContext('`save()` passes validation before the card is stored.')), []);
});

test('prose that starts with a command-like word is a user flow', () => {
  assert.deepEqual(codes(withTest('1. Make a new card and reload the page.')), []);
  assert.deepEqual(codes(withTest('1. Node details open after you click the card.')), []);
  assert.ok(codes(withTest('$ make test')).includes('test-flow'));
  assert.ok(codes(withTest('1. `make test`')).includes('test-flow'));
});

test('capitalized tool names in prose are not a command inventory', () => {
  assert.deepEqual(codes(withTest('Nix rebuild now finishes without the warning.')), []);
  assert.ok(codes(withTest('Run pnpm test')).includes('test-flow'));
  assert.ok(codes(withTest('nix flake check')).includes('test-flow'));
});

test('the word todo inside a media label is not pending evidence', () => {
  const todoImages = images.replace('After: completed row has no stale label', 'After todo list');
  assert.deepEqual(codes(`${base}${todoImages}`, true), []);
  assert.ok(codes(`${base}${images.replace('![After: completed row has no stale label](https://github.com/user-attachments/assets/after-image)', 'TODO')}`, true).includes('evidence-not-ready'));
});

test('the same media URL cannot be both before and after', () => {
  const same = images.replace('https://github.com/user-attachments/assets/after-image', 'https://github.com/user-attachments/assets/before-image');
  assert.ok(codes(`${base}${same}`, true).includes('duplicate-media'));
});
