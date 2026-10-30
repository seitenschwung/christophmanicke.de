import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import nodemailer from 'nodemailer';
import { readConfig, createLimiter, createHandler } from './lib.mjs';

const env = {
  SMTP_HOST: 'mail.your-server.de', SMTP_PORT: '587', SMTP_USER: 'booking@example.com', SMTP_PASS: 'secret',
  MAIL_FROM: 'booking@example.com', MAIL_TO: 'band@example.com', ALLOWED_ORIGINS: 'https://christophmanicke.de',
};
const ORIGIN = 'https://christophmanicke.de';
const good = { name: 'Lea Müller', email: 'lea@example.de', anliegen: 'Zweitmeinung vor einer Operation', zeitraum: 'Ich bin flexibel', nachricht: 'Hallo!\r\nGrüße', einwilligung: 'ja', website: '' };

async function start({ config = readConfig(env), transport, limit = 10 } = {}) {
  const sent = [];
  const t = transport ?? { sendMail: async (m) => { sent.push(m); return { messageId: 'x' }; } };
  const logs = [];
  const handler = createHandler({ config, transport: t, limiter: createLimiter({ max: limit, windowMs: 3600_000 }), log: (line) => logs.push(line), readTimeoutMs: 300 });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, sent, logs, close: () => new Promise((r) => server.close(r)) };
}

const post = (base, body, headers = {}) => fetch(`${base}/api/anfrage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-Real-IP': '1.2.3.4', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('healthz answers 200', async () => {
  const s = await start();
  assert.equal((await fetch(`${s.base}/healthz`)).status, 200);
  await s.close();
});

test('a valid request sends exactly one mail with fixed from/to and the visitor as reply-to', async () => {
  const s = await start();
  const res = await post(s.base, good);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].from, 'booking@example.com');
  assert.equal(s.sent[0].to, 'band@example.com');
  assert.equal(s.sent[0].replyTo, 'lea@example.de');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  await s.close();
});

test('real nodemailer (json transport) builds the mail without injected headers', async () => {
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const out = [];
  const s = await start({ transport: { sendMail: async (m) => { const info = await transport.sendMail(m); out.push(JSON.parse(info.message)); return info; } } });
  assert.equal((await post(s.base, good)).status, 200);
  assert.deepEqual(out[0].to, [{ address: 'band@example.com', name: '' }]);
  assert.equal(out[0].html, undefined);
  assert.equal((await post(s.base, { ...good, name: 'x\r\nBcc: evil@example.com' })).status, 400);
  assert.equal(out.length, 1);
  await s.close();
});

test('only POST on /api/anfrage; other paths 404', async () => {
  const s = await start();
  assert.equal((await fetch(`${s.base}/api/anfrage`)).status, 405);
  assert.equal((await fetch(`${s.base}/etc/passwd`)).status, 404);
  await s.close();
});

test('foreign or missing Origin is rejected with 403 and nothing is sent', async () => {
  const s = await start();
  assert.equal((await post(s.base, good, { Origin: 'https://evil.example' })).status, 403);
  const res = await fetch(`${s.base}/api/anfrage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(good) });
  assert.equal(res.status, 403);
  assert.equal(s.sent.length, 0);
  await s.close();
});

test('wrong content type 415, oversized body 413, broken JSON 400', async () => {
  const s = await start();
  assert.equal((await post(s.base, JSON.stringify(good), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(s.base, { ...good, nachricht: 'a'.repeat(17_000) })).status, 413);
  assert.equal((await post(s.base, '{"name":')).status, 400);
  assert.equal(s.sent.length, 0);
  await s.close();
});

test('invalid input answers 400 with the field name and never echoes input', async () => {
  const s = await start();
  const res = await post(s.base, { ...good, email: '<script>alert(1)</script>@x.de' });
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { ok: false, field: 'email' });
  assert.doesNotMatch(text, /script/);
  await s.close();
});

test('a filled honeypot gets 200 but no mail', async () => {
  const s = await start();
  const res = await post(s.base, { ...good, website: 'http://spam.example' });
  assert.equal(res.status, 200);
  assert.equal(s.sent.length, 0);
  await s.close();
});

test('rate limit per X-Real-IP answers 429', async () => {
  const s = await start({ limit: 2 });
  assert.equal((await post(s.base, good)).status, 200);
  assert.equal((await post(s.base, good)).status, 200);
  assert.equal((await post(s.base, good)).status, 429);
  assert.equal((await post(s.base, good, { 'X-Real-IP': '9.9.9.9' })).status, 200);
  await s.close();
});

test('SMTP failure answers 502, logs no content, and frees the slot', async () => {
  let fail = true;
  const s = await start({ transport: { sendMail: async () => { if (fail) { const e = new Error('535 auth failed for booking@example.com pass=secret'); e.code = 'EAUTH'; throw e; } return {}; } } });
  assert.equal((await post(s.base, good)).status, 502);
  fail = false;
  assert.equal((await post(s.base, good)).status, 200);
  const logged = s.logs.join('\n');
  assert.match(logged, /EAUTH/);
  assert.doesNotMatch(logged, /secret|lea@example|Lea|booking@example/);
  await s.close();
});

test('more than two sends at once answer 503', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = await start({ transport: { sendMail: () => gate } });
  const first = [post(s.base, good), post(s.base, good, { 'X-Real-IP': '2.2.2.2' })];
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await post(s.base, good, { 'X-Real-IP': '3.3.3.3' })).status, 503);
  release({});
  assert.deepEqual((await Promise.all(first)).map((r) => r.status), [200, 200]);
  await s.close();
});

test('disabled config answers 503 without sending', async () => {
  const s = await start({ config: readConfig({ ...env, SMTP_PASS: '' }) });
  assert.equal((await post(s.base, good)).status, 503);
  assert.equal(s.sent.length, 0);
  await s.close();
});

test('a body sent in chunks is assembled; a stalled body times out with 408', async () => {
  const s = await start();
  const { port } = new URL(s.base);
  const body = JSON.stringify(good);
  const send = (stall) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/anfrage', method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-Real-IP': '4.4.4.4', 'Content-Length': Buffer.byteLength(body) } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write(body.slice(0, 10));
    if (stall) return;
    setTimeout(() => req.end(body.slice(10)), 30);
  });
  assert.equal(await send(false), 200);
  assert.equal(await send(true), 408);
  await s.close();
});
