'use strict';
// First-run owner setup link (production servers started without ADMIN_PASSWORD).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipzy-setup-'));
const env = { ...process.env, NODE_ENV: 'production', DATA_DIR: path.join(tmp, 'data'), UPLOAD_DIR: path.join(tmp, 'uploads'),
  BASE_URL: 'https://clipzy.example.test', REQUIRE_EMAIL_VERIFICATION: 'false', TRUST_PROXY: '1', ADMIN_PASSWORD: '', ADMIN_EMAIL: '', SEED_DEMO: '' };
Object.assign(process.env, env);

let token;
test('bootstrap prints a one-time setup link instead of failing', () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'server', 'scripts', 'bootstrap.js')], { env, encoding: 'utf8' });
  const m = out.match(/\/setup\?token=([A-Za-z0-9_-]+)/);
  assert.ok(m, out);
  token = m[1];
});

test('the link creates the owner exactly once; wrong or reused links are refused', async () => {
  const { server } = require('../server/index.js');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (u, b) => fetch(base + u, { method: 'POST', headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  const owner = { email: 'owner@site.test', username: 'siteowner', password: 'Owner-pass-2026', birthDate: '1990-05-05' };
  try {
    assert.equal((await post('/api/auth/setup', { ...owner, token: 'wrong-token-value' })).status, 401);
    assert.equal((await post('/api/auth/setup', { ...owner, token, birthDate: '2015-01-01' })).status, 400, 'owner must be an adult');
    const r = await post('/api/auth/setup', { ...owner, token });
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.equal(body.user.username, 'siteowner');
    assert.equal(body.user.isOwner ?? true, true);
    const { q } = require('../server/db');
    const u = q.get("SELECT role, is_owner, email_verified FROM users WHERE username = 'siteowner'");
    assert.deepEqual([u.role, u.is_owner, u.email_verified], ['admin', 1, 1]);
    assert.equal((await post('/api/auth/setup', { ...owner, username: 'second', email: 'x@site.test', token })).status, 401, 'link works once');
    assert.equal((await post('/api/auth/login', { login: 'siteowner', password: owner.password })).status, 200);
    const check = await fetch(`${base}/api/auth/setup?token=${token}`).then((x) => x.json());
    assert.equal(check.needed, false);
  } finally { server.closeAllConnections?.(); server.close(); }
});
