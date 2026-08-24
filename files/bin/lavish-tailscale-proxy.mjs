#!/usr/bin/env node
// Reverse proxy so Lavish sessions (127.0.0.1:4387, localhost-only Host check) can be reached from the phone over
// Tailscale. Listens on 127.0.0.1:4389 as the backend for `tailscale serve --bg http://127.0.0.1:4389`, rewrites the
// Host header to what Lavish accepts, strips every X-Forwarded-* header, and forwards WebSocket upgrades so the live
// review loop works. Run by a Home Manager launchd agent (see nix/user.nix); logs go to ~/Library/Logs.
import http from 'node:http';
import net from 'node:net';

const LISTEN_HOST = process.env.LAVISH_PROXY_HOST ?? '127.0.0.1';
const LISTEN_PORT = Number(process.env.LAVISH_PROXY_PORT ?? 4389);
const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = Number(process.env.LAVISH_PORT ?? 4387);

function cleanHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (key.startsWith('x-forwarded-') || key === 'forwarded' || key === 'host') continue;
    out[k] = v;
  }
  out.host = `${TARGET_HOST}:${TARGET_PORT}`;
  return out;
}

const server = http.createServer((req, res) => {
  const upstream = http.request(
    { host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers: cleanHeaders(req.headers) },
    (up) => { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res); },
  );
  upstream.on('error', (err) => { res.writeHead(502, { 'content-type': 'text/plain' }); res.end(`lavish upstream error: ${err.message}`); });
  req.pipe(upstream);
});

server.on('upgrade', (req, socket, head) => {
  const target = net.connect(TARGET_PORT, TARGET_HOST, () => {
    const headers = cleanHeaders(req.headers);
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    target.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) target.write(head);
    socket.pipe(target).pipe(socket);
  });
  target.on('error', () => socket.destroy());
  socket.on('error', () => target.destroy());
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`lavish-tailscale-proxy: ${LISTEN_HOST}:${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`);
});
