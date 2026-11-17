'use strict';
// Security: password storage, monitoring, access control (IDOR), data export, uploads, traversal,
// headers and data retention. These tests act like an attacker would.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipzy-sec-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const { server } = require('../server/index.js');
const { q } = require('../server/db');
const auth = require('../server/lib/auth');

let base;
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { server.closeAllConnections?.(); server.close(); });

function client() {
  let cookie = '';
  async function call(method, url, body, { form, raw, headers: extra } = {}) {
    const headers = { 'X-Requested-With': 'fetch', ...(extra || {}) };
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (form) payload = form; else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (raw) return res;
    let json = null; try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, body: json, headers: res.headers };
  }
  return { get: (u, o) => call('GET', u, undefined, o), post: (u, b, o) => call('POST', u, b, o), del: (u, b) => call('DELETE', u, b), patch: (u, b) => call('PATCH', u, b), get cookie() { return cookie; } };
}
const PW = 'Correct-Horse-7';
const reg = (c, n, extra = {}) => c.post('/api/auth/register', { email: `${n}@t.dev`, username: n, password: PW, birthDate: '1990-01-01', acceptTerms: true, ...extra });
const uid = (n) => q.get('SELECT id FROM users WHERE username = ?', n).id;

const alice = client(); const bob = client(); const mallory = client(); const staff = client();

test('setup', async () => {
  for (const [c, n] of [[alice, 'alice'], [bob, 'bob'], [mallory, 'mallory'], [staff, 'staff']]) assert.equal((await reg(c, n)).status, 201);
  q.run("UPDATE users SET role = 'admin' WHERE username = 'staff'");
});

test('passwords: common ones refused; strong hashing; old hashes upgraded at next login', async () => {
  const r = await reg(client(), 'weakling', { password: 'password123' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /too common/);
  assert.match(q.get('SELECT password_hash FROM users WHERE id = ?', uid('alice')).password_hash, /^scrypt\$32768\$8\$3\$/);
  // an account still holding the older hash format (N=16384, r=8, p=1)
  const salt = crypto.randomBytes(16);
  const legacy = `scrypt$16384$${salt.toString('base64')}$${crypto.scryptSync('Legacy-pass-4', salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
  q.run('UPDATE users SET password_hash = ? WHERE id = ?', legacy, uid('bob'));
  assert.equal((await client().post('/api/auth/login', { login: 'bob', password: 'Legacy-pass-4' })).status, 200);
  assert.match(q.get('SELECT password_hash FROM users WHERE id = ?', uid('bob')).password_hash, /^scrypt\$32768\$8\$3\$/, 'upgraded on login');
  assert.equal(await auth.verifyPassword('Legacy-pass-4', q.get('SELECT password_hash FROM users WHERE id = ?', uid('bob')).password_hash), true);
});

test('monitoring: failed logins, forged requests and refused staff access are logged; only staff can read the log', async () => {
  await client().post('/api/auth/login', { login: 'alice', password: 'wrong-guess-1' });
  await fetch(`${base}/api/auth/logout`, { method: 'POST' }); // no app header = forged request
  assert.equal((await mallory.get('/api/admin/security')).status, 403);
  const r = await staff.get('/api/admin/security');
  assert.equal(r.status, 200);
  const types = r.body.events.map((e) => e.type);
  for (const t of ['login.failed', 'csrf.blocked', 'access.denied']) assert.ok(types.includes(t), `${t} recorded`);
  const raw = JSON.stringify(r.body);
  assert.doesNotMatch(raw, /wrong-guess-1|127\.0\.0\.1|@t\.dev|sid=/, 'no passwords, raw IPs, emails or cookies in the log');
});

test('access control: other people’s conversations, orders, drafts and admin actions are off limits', async () => {
  const conv = await alice.post('/api/conversations', { username: 'bob' });
  assert.ok(conv.body.id);
  await alice.post(`/api/conversations/${conv.body.id}/messages`, { body: 'private hello' });
  for (const u of [`/api/conversations/${conv.body.id}`, `/api/conversations/${conv.body.id}/messages`]) {
    const r = await mallory.get(u);
    assert.ok([403, 404].includes(r.status), `mallory blocked from ${u} (${r.status})`);
    assert.doesNotMatch(JSON.stringify(r.body), /private hello/);
  }
  assert.ok([403, 404].includes((await mallory.post(`/api/conversations/${conv.body.id}/messages`, { body: 'injected' })).status));
  q.run("INSERT INTO coin_orders (user_id, coins, price_cents, currency, provider, status, created_at) VALUES (?, 100, 99, 'GBP', 'stripe', 'pending', ?)", uid('alice'), Date.now());
  const order = q.get('SELECT id FROM coin_orders WHERE user_id = ? ORDER BY id DESC', uid('alice')).id;
  assert.equal((await mallory.get(`/api/coins/orders/${order}`)).status, 404);
  await mallory.post(`/api/coins/orders/${order}/cancel`);
  assert.equal(q.get('SELECT status FROM coin_orders WHERE id = ?', order).status, 'pending', 'cannot cancel someone else’s order');
  for (const [m, u, b] of [['post', `/api/admin/users/${uid('alice')}/suspend`, { days: 7, reason: 'x' }], ['post', `/api/admin/users/${uid('alice')}/coins`, { coins: 1000 }], ['patch', '/api/admin/economy', { discountPercent: 90 }]]) {
    assert.equal((await mallory[m](u, b)).status, 403, `${u} refused`);
  }
  assert.equal(q.get('SELECT status FROM users WHERE id = ?', uid('alice')).status, 'active');
  const r = await mallory.patch('/api/me', { role: 'admin', is_owner: 1, isVerified: true });
  void r;
  const m = q.get('SELECT role, is_owner, is_verified FROM users WHERE id = ?', uid('mallory'));
  assert.deepEqual([m.role, m.is_owner, m.is_verified], ['user', 0, 0], 'profile edits cannot grant privileges');
});

test('uploads: disguised files and traversal paths are rejected', async () => {
  const fake = new FormData();
  fake.append('video', new Blob(['<html><script>alert(1)</script></html>'], { type: 'video/mp4' }), 'clip.mp4');
  fake.append('caption', 'x');
  const r = await alice.post('/api/videos', undefined, { form: fake });
  assert.equal(r.status, 400, 'HTML pretending to be an mp4 is refused');
  const svg = new FormData();
  svg.append('avatar', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'], { type: 'image/png' }), 'a.png');
  assert.equal((await alice.post('/api/me/avatar', undefined, { form: svg })).status, 400, 'SVG/script images are refused');
  for (const p of ['/media/a/..%2f..%2fdata%2fapp.db', '/media/a/../../data/app.db', '/media/a/%2e%2e/%2e%2e/data/app.db', '/media/s/..%5c..%5cdata%5capp.db']) {
    const res = await fetch(base + p);
    const text = await res.text();
    // Unencoded ../ is normalised by the client and lands on the app page; encoded forms are refused.
    if (/%2f|%5c/i.test(p)) assert.ok(res.status >= 400, `${p} -> ${res.status}`);
    assert.doesNotMatch(text, /SQLite format/, `${p} must never return the database`);
  }
  assert.equal(fs.readdirSync(path.join(process.env.UPLOAD_DIR, 'tmp')).length, 0, 'rejected uploads are deleted');
});

test('headers: CSP, no sniffing, no framing; errors never leak internals', async () => {
  const res = await fetch(`${base}/`);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-powered-by'), null);
  const bad = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: '{"login":' });
  const body = await bad.text();
  assert.equal(bad.status, 400);
  assert.doesNotMatch(body, /at .*\.js:\d+|SyntaxError|node_modules/);
});

test('your data: export has your information and no secrets or other people’s private data', async () => {
  const res = await alice.get('/api/me/export', { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  const text = await res.text();
  const data = JSON.parse(text);
  assert.equal(data.account.username, 'alice');
  assert.equal(data.account.email, 'alice@t.dev');
  assert.ok(Array.isArray(data.messagesSent) && data.messagesSent.some((m) => m.body === 'private hello'));
  assert.doesNotMatch(text, /password_hash|scrypt\$|token_hash|bob@t\.dev|mallory@t\.dev/);
  assert.equal((await client().get('/api/me/export')).status, 401);
});

test('retention: expired sessions and old security events are removed', async () => {
  q.run('INSERT INTO sessions (token_hash, user_id, user_agent, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', 'old-session-hash', uid('alice'), 'x', 1, 2);
  q.run("INSERT INTO security_events (type, severity, created_at) VALUES ('login.failed', 'warn', 1)");
  const out = require('../server/lib/retention').sweep();
  assert.ok(out.sessions >= 1 && out.security >= 1);
  assert.equal(q.get("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = 'old-session-hash'").n, 0);
});
