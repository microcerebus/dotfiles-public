// Run: node --test tests/telegram_alert_test.mjs
// Runs scripts/telegram-alert against a fake Bot API and a fake keychain, under
// both macOS's /bin/bash 3.2 and the Nix bash, and checks on every path that the
// bot token and chat ID never reach its output or any command line it runs.
// TELEGRAM_ALERT_BIN points the suite at another copy of the script (to prove
// it fails on a broken sender).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = process.env.TELEGRAM_ALERT_BIN ?? path.join(import.meta.dirname, '../scripts/telegram-alert');
const TOKEN = '123456789:AAfake-token_for-tests-only0123456789';
const CHAT = '424242424242';
const SECRETS = [TOKEN.split(':')[1], CHAT];
const BOTH = { 'telegram-alert-bot': TOKEN, 'telegram-alert-chat': CHAT };
const LINKED = 'telegram-alert linked this chat. Agent alerts will arrive here.';
const which = (cmd) => execFileSync('/bin/sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).trim();
const BASHES = [...new Set(['/bin/bash', which('bash')])];
const REAL = { curl: which('curl'), jq: which('jq') };

// Fake macOS `security`: each generic password is a file named after its service.
// `security -i` reads commands from stdin and strips quotes, like the real one,
// which exits with the last command's status (the sender runs one per call).
// FAKE_LOCKED=all fails every command like a locked keychain; =write fails adds.
const FAKE_SECURITY = `#!/usr/bin/env bash
printf 'security %s\\n' "$*" >>"$FAKE_ARGV_LOG"
run() {
  local cmd="$1" service="" password="" update=0 has_password=0
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      -s) service="$2"; shift 2 ;;
      -a|-l|-c|-C|-D|-j|-r|-G|-T) shift 2 ;;
      -U) update=1; shift ;;
      -w) if [ "$cmd" = add-generic-password ] && [ $# -ge 2 ]; then password="$2"; has_password=1; shift 2; else shift; fi ;;
      *) shift ;;
    esac
  done
  case "$cmd" in
    find-generic-password)
      [ "\${FAKE_LOCKED-}" = all ] && { echo "security: SecKeychainSearchCopyNext: User interaction is not allowed." >&2; return 36; }
      [ -f "$FAKE_KEYCHAIN/$service" ] || {
        echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2
        return 44
      }
      cat "$FAKE_KEYCHAIN/$service"; echo ;;
    add-generic-password)
      [ -n "\${FAKE_LOCKED-}" ] && { echo "security: SecKeychainItemCreateFromContent (<default>): User interaction is not allowed." >&2; return 36; }
      [ "$has_password" = 1 ] || { echo "fake security: would prompt for a password" >&2; return 1; }
      if [ -f "$FAKE_KEYCHAIN/$service" ] && [ "$update" = 0 ]; then
        echo "security: SecKeychainItemCreateFromContent (<default>): The specified item already exists in the keychain." >&2
        return 45
      fi
      printf '%s' "$password" >"$FAKE_KEYCHAIN/$service" ;;
    *) echo "fake security: unsupported command $cmd" >&2; return 1 ;;
  esac
}
if [ "$1" = -i ]; then
  status=0
  while IFS= read -r line; do eval "set -- $line"; run "$@"; status=$?; done
  exit "$status"
fi
run "$@"
`;

// Telegram's reply to a good sendMessage quotes the chat back, so the sender must not print it.
const sent = ({ form }) => [200, {
  ok: true,
  result: { message_id: 7, chat: { id: Number(form.chat_id), type: 'private', first_name: 'Test' }, text: form.text },
}];
const update = (id, chat, text, type = 'private') => ({
  update_id: id, message: { message_id: id, chat: { id: chat, type, first_name: 'Test' }, text },
});
const updates = (...result) => () => [200, { ok: true, result }];

function fakeApi(handlers) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const match = new URL(req.url, 'http://fake').pathname.match(/^\/bot([^/]+)\/(\w+)$/);
      const request = {
        method: req.method, token: match?.[1], api: match?.[2],
        form: Object.fromEntries(new URLSearchParams(body)),
      };
      requests.push(request);
      const handler = request.token === TOKEN ? handlers[request.api] : null;
      const [status, payload] = handler?.(request) ?? [401, { ok: false, error_code: 401, description: 'Unauthorized' }];
      res.writeHead(status, { 'content-type': typeof payload === 'string' ? 'text/html' : 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close(),
  })));
}

async function closedPort() {
  const api = await fakeApi({});
  api.close();
  return api.url;
}

async function run(bash, args, { keychain = BOTH, handlers = { sendMessage: sent }, api, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-alert-'));
  const bin = path.join(dir, 'bin');
  const items = path.join(dir, 'keychain');
  const argvLog = path.join(dir, 'argv.log');
  fs.mkdirSync(bin);
  fs.mkdirSync(items);
  fs.writeFileSync(argvLog, '');
  for (const [service, value] of Object.entries(keychain)) fs.writeFileSync(path.join(items, service), value);
  fs.symlinkSync(bash, path.join(bin, 'bash'));
  fs.writeFileSync(path.join(bin, 'security'), FAKE_SECURITY, { mode: 0o755 });
  // Every command that touches a secret is logged, so a secret in argv shows up.
  for (const [cmd, real] of Object.entries(REAL)) {
    fs.writeFileSync(path.join(bin, cmd), `#!/bin/sh\nprintf '${cmd} %s\\n' "$*" >>"$FAKE_ARGV_LOG"\nexec ${real} "$@"\n`, { mode: 0o755 });
  }
  const fake = api ? null : await fakeApi(handlers);
  const child = spawn(SCRIPT, args, {
    env: {
      PATH: `${bin}:/usr/bin:/bin`, HOME: dir, USER: 'tester',
      FAKE_KEYCHAIN: items, FAKE_ARGV_LOG: argvLog, TELEGRAM_ALERT_API: api ?? fake.url, ...env,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => {
    child.on('error', (error) => { stderr += `${error.message}\n`; resolve(-1); });
    child.on('close', resolve);
  });
  fake?.close();
  const stored = Object.fromEntries(fs.readdirSync(items).map((f) => [f, fs.readFileSync(path.join(items, f), 'utf8')]));
  const argv = fs.readFileSync(argvLog, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return { code, stdout, stderr, argv, stored, requests: fake?.requests ?? [] };
}

function assertNoSecrets(result) {
  for (const secret of SECRETS) {
    for (const where of ['stdout', 'stderr', 'argv']) {
      assert.ok(!result[where].includes(secret), `a secret leaked into ${where}:\n${result[where]}`);
    }
  }
}

// cases(name, fn): one test per bash, each also checking that no secret leaked.
function cases(name, fn) {
  for (const bash of BASHES) {
    test(`${name} (${bash})`, async () => assertNoSecrets(await fn((args, options) => run(bash, args, options))));
  }
}

cases('sends the text once, as plain text, to the linked chat', async (send) => {
  const text = 'PR #12 "blocked" & 50% done = waiting\nsecond line \\ ✅ <b>not bold</b>';
  const result = await send([text]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'telegram-alert: sent\n');
  assert.equal(result.stderr, '');
  assert.deepEqual(result.requests, [
    { method: 'POST', token: TOKEN, api: 'sendMessage', form: { chat_id: CHAT, text } },
  ]);
  return result;
});

cases('fails loudly when the bot token is missing from the keychain', async (send) => {
  const result = await send(['hello'], { keychain: { 'telegram-alert-chat': CHAT } });
  assert.equal(result.code, 3);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /no bot token in the login keychain/);
  assert.match(result.stderr, /security add-generic-password -a "\$USER" -s telegram-alert-bot -w/);
  assert.equal(result.requests.length, 0);
  return result;
});

cases('fails loudly when no chat is linked', async (send) => {
  const result = await send(['hello'], { keychain: { 'telegram-alert-bot': TOKEN } });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /no chat linked/);
  assert.match(result.stderr, /telegram-alert --setup/);
  assert.equal(result.requests.length, 0);
  return result;
});

cases('refuses a malformed token without printing it', async (send) => {
  const bad = `not a token" url = "http://evil.example/${SECRETS[0]}`;
  const result = await send(['hello'], { keychain: { ...BOTH, 'telegram-alert-bot': bad } });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /telegram-alert-bot does not look like a bot token/);
  assert.ok(!result.stderr.includes('evil'), result.stderr);
  assert.equal(result.requests.length, 0);
  return result;
});

cases('fails loudly on an HTTP error and quotes the API description', async (send) => {
  const result = await send(['hello'], {
    handlers: { sendMessage: () => [400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }] },
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'telegram-alert: sendMessage failed: HTTP 400 (Bad Request: chat not found)\n');
  assert.equal(result.requests.length, 1);
  return result;
});

cases('redacts the token and chat when an error description quotes them', async (send) => {
  const result = await send(['hello'], {
    handlers: { sendMessage: () => [404, { ok: false, error_code: 404, description: `Not Found: /bot${TOKEN}/sendMessage chat ${CHAT}` }] },
  });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, 'telegram-alert: sendMessage failed: HTTP 404 (Not Found: /bot[redacted]/sendMessage chat [redacted])\n');
  return result;
});

cases('does not print a non-JSON error page', async (send) => {
  const result = await send(['hello'], { handlers: { sendMessage: () => [502, `<html>Bad Gateway /bot${TOKEN}/sendMessage</html>`] } });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, 'telegram-alert: sendMessage failed: HTTP 502\n');
  return result;
});

cases('fails loudly when HTTP 200 carries ok: false', async (send) => {
  const result = await send(['hello'], { handlers: { sendMessage: () => [200, { ok: false, description: 'unexpected' }] } });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, 'telegram-alert: sendMessage failed: HTTP 200 (unexpected)\n');
  return result;
});

cases('fails loudly on a network error', async (send) => {
  const api = await closedPort();
  const result = await send(['hello'], { api });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^telegram-alert: could not reach the Bot API: curl: \(7\) .+\n$/);
  return result;
});

cases('rejects bad usage before reading the keychain', async (send) => {
  for (const args of [[], [''], ['one', 'two'], ['--nope']]) {
    const result = await send(args);
    assert.equal(result.code, 2, `args ${JSON.stringify(args)}`);
    assert.match(result.stderr, /Usage: telegram-alert/);
    assert.equal(result.argv, '');
    assert.equal(result.requests.length, 0);
  }
  const dashed = await send(['--', '-1 failing check']);
  assert.equal(dashed.code, 0, dashed.stderr);
  assert.equal(dashed.requests[0].form.text, '-1 failing check');
  return dashed;
});

cases('--setup links the one private chat that sent /start', async (send) => {
  const result = await send(['--setup'], {
    keychain: { 'telegram-alert-bot': TOKEN },
    handlers: {
      getUpdates: updates(
        update(1, Number(CHAT), '/start'),
        update(2, Number(CHAT), 'hello'),
        update(3, -1001234567890, '/start', 'supergroup'),
        update(4, Number(CHAT), '/start@my_alert_bot'),
        update(5, 5550001, '/started'),
      ),
      sendMessage: sent,
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout,
    'telegram-alert: linked the chat that sent /start and sent it a confirmation (keychain item telegram-alert-chat)\n');
  assert.deepEqual(result.stored, BOTH);
  assert.deepEqual(result.requests.map((r) => r.api), ['getUpdates', 'sendMessage']);
  assert.deepEqual(result.requests[1].form, { chat_id: CHAT, text: LINKED });
  return result;
});

cases('--setup replaces a previously linked chat', async (send) => {
  const result = await send(['--setup'], {
    keychain: { ...BOTH, 'telegram-alert-chat': '1111' },
    handlers: { getUpdates: updates(update(1, Number(CHAT), '/start')), sendMessage: sent },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stored, BOTH);
  return result;
});

cases('--setup fails loudly when nobody sent /start', async (send) => {
  const result = await send(['--setup'], {
    keychain: { 'telegram-alert-bot': TOKEN },
    handlers: { getUpdates: updates(update(1, Number(CHAT), 'hi')) },
  });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /no \/start in the bot's recent updates/);
  assert.deepEqual(result.stored, { 'telegram-alert-bot': TOKEN });
  return result;
});

cases('--setup refuses to guess between two chats', async (send) => {
  const result = await send(['--setup'], {
    keychain: { 'telegram-alert-bot': TOKEN },
    handlers: { getUpdates: updates(update(1, Number(CHAT), '/start'), update(2, 5550001, '/start')) },
  });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /2 chats sent \/start/);
  assert.deepEqual(result.stored, { 'telegram-alert-bot': TOKEN });
  return result;
});

cases('--setup stores nothing when the confirmation cannot be sent', async (send) => {
  const result = await send(['--setup'], {
    keychain: { 'telegram-alert-bot': TOKEN },
    handlers: {
      getUpdates: updates(update(1, Number(CHAT), '/start')),
      sendMessage: () => [403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }],
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, 'telegram-alert: sendMessage failed: HTTP 403 (Forbidden: bot was blocked by the user)\n');
  assert.deepEqual(result.stored, { 'telegram-alert-bot': TOKEN });
  return result;
});

cases('--setup fails loudly when the keychain refuses the write', async (send) => {
  const result = await send(['--setup'], {
    keychain: { 'telegram-alert-bot': TOKEN },
    handlers: { getUpdates: updates(update(1, Number(CHAT), '/start')), sendMessage: sent },
    env: { FAKE_LOCKED: 'write' },
  });
  assert.equal(result.code, 3);
  assert.equal(result.stderr,
    'telegram-alert: could not store keychain item telegram-alert-chat: security: SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.\n');
  assert.deepEqual(result.stored, { 'telegram-alert-bot': TOKEN });
  return result;
});

cases('fails loudly when the keychain is locked', async (send) => {
  const result = await send(['hello'], { env: { FAKE_LOCKED: 'all' } });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /^telegram-alert: could not read keychain item telegram-alert-bot \(security exit 36\)\. Unlock the login keychain/);
  assert.equal(result.requests.length, 0);
  return result;
});

cases('fails loudly when the chat item is not a chat ID', async (send) => {
  const result = await send(['hello'], { keychain: { ...BOTH, 'telegram-alert-chat': 'my chat' } });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /keychain item telegram-alert-chat does not hold a chat ID/);
  assert.equal(result.requests.length, 0);
  return result;
});

cases('refuses to send the token to any host but Telegram or loopback', async (send) => {
  for (const api of ['https://evil.example', 'http://api.telegram.org', 'https://api.telegram.org.evil.example',
    'http://127.0.0.1:1/x', 'http://127.0.0.1:1" output = "/tmp/x']) {
    const result = await send(['hello'], { api });
    assert.equal(result.code, 2, api);
    assert.equal(result.stderr, 'telegram-alert: TELEGRAM_ALERT_API must be https://api.telegram.org or a loopback http:// URL\n');
    assert.equal(result.argv, '');
  }
  return { stdout: '', stderr: '', argv: '' };
});

cases('stays quiet about secrets under an inherited xtrace', async (send) => {
  const result = await send(['hello'], { env: { SHELLOPTS: 'xtrace' } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'telegram-alert: sent\n');
  assert.equal(result.requests.length, 1);
  return result;
});
