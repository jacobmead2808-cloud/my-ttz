'use strict';
// Sign-up rules: age, terms, email verification, teen safeguards.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipzy-acct-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.REQUIRE_EMAIL_VERIFICATION = 'true';
process.env.STRIPE_SECRET_KEY = '';

const { server } = require('../server/index.js');
const config = require('../server/config');

let base;
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { server.closeAllConnections?.(); server.close(); });

function client() {
  let cookie = '';
  async function call(method, url, body) {
    const headers = { 'X-Requested-With': 'fetch' };
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, body: json };
  }
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b), patch: (u, b) => call('PATCH', u, b) };
}

/** Latest verification link token sent to `email` (dev outbox). */
function latestToken(email) {
  const files = fs.readdirSync(config.outboxDir).filter((f) => f.includes(email.replace(/[^a-z0-9@._-]/gi, '_'))).sort();
  const text = fs.readFileSync(path.join(config.outboxDir, files[files.length - 1]), 'utf8');
  return decodeURIComponent(text.match(/verify-email\?token=([^\s]+)/)[1]);
}

const yearsAgo = (n) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - n); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

test('sign-up requires a real date of birth, minimum age and accepted terms', async () => {
  const c = client();
  let r = await c.post('/api/auth/register', { email: 'a@t.dev', username: 'nodob', password: 'password1', acceptTerms: true });
  assert.equal(r.status, 400);
  r = await c.post('/api/auth/register', { email: 'a@t.dev', username: 'baddob', password: 'password1', birthDate: '2001-02-30', acceptTerms: true });
  assert.equal(r.status, 400);
  r = await c.post('/api/auth/register', { email: 'a@t.dev', username: 'kiddo', password: 'password1', birthDate: yearsAgo(12), acceptTerms: true });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /13/);
  r = await c.post('/api/auth/register', { email: 'a@t.dev', username: 'noterms', password: 'password1', birthDate: '2000-01-01' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Terms/);
});

test('unverified accounts can browse but not post until the email link is used', async () => {
  const c = client();
  let r = await c.post('/api/auth/register', { email: 'adult@t.dev', username: 'adult', password: 'password1', birthDate: '1995-05-05', acceptTerms: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.emailVerified, false);
  assert.equal(r.body.user.isAdult, true);
  assert.equal((await c.get('/api/videos/feed/foryou')).status, 200);
  r = await c.post('/api/conversations', { username: 'adult' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /verify your email/);
  r = await c.post('/api/live', { title: 'hi' });
  assert.equal(r.status, 403);

  const first = latestToken('adult@t.dev');
  r = await c.post('/api/auth/resend-verification', {});
  assert.equal(r.status, 200);
  const second = latestToken('adult@t.dev');
  assert.notEqual(first, second);
  r = await client().post('/api/auth/verify-email', { token: first });
  assert.equal(r.status, 400, 'older links stop working after a resend');
  r = await client().post('/api/auth/verify-email', { token: second });
  assert.equal(r.status, 200);
  r = await c.get('/api/auth/me');
  assert.equal(r.body.user.emailVerified, true);
  r = await client().post('/api/auth/verify-email', { token: second });
  assert.equal(r.status, 400, 'links are single-use');

  // Changing email requires verifying the new address.
  r = await c.post('/api/me/email', { email: 'adult2@t.dev', password: 'password1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.emailVerified, false);
  r = await client().post('/api/auth/verify-email', { token: latestToken('adult2@t.dev') });
  assert.equal(r.status, 200);
});

test('teens start private, DMs limited to friends, no LIVE, coins or gifts', async () => {
  const c = client();
  let r = await c.post('/api/auth/register', { email: 'teen@t.dev', username: 'teen', password: 'password1', birthDate: yearsAgo(15), acceptTerms: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.isAdult, false);
  r = await client().post('/api/auth/verify-email', { token: latestToken('teen@t.dev') });
  assert.equal(r.status, 200);
  r = await c.get('/api/auth/me');
  assert.equal(r.body.user.settings.isPrivate, true);
  assert.equal(r.body.user.settings.allowMessages, 'friends');
  r = await c.patch('/api/me/settings', { allowMessages: 'everyone' });
  assert.equal(r.status, 400);
  r = await c.patch('/api/me/settings', { birthDate: '1990-01-01' });
  assert.equal(r.status, 400, 'date of birth cannot be changed once set');
  r = await c.post('/api/coins/checkout', { coins: 100 });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /18/);
  r = await c.get('/api/live/eligibility');
  assert.equal(r.body.eligible, false);
  assert.equal(r.body.trial.available, false);
  r = await c.post('/api/live', { title: 'hi' });
  assert.equal(r.status, 403);
});
