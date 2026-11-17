'use strict';
// Push notifications: Web Push (decrypted by a local mock push service) and FCM (local mock).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipzy-push-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

// ---- mock services (push endpoint, Google OAuth token endpoint, FCM) ----
const received = [];
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c)).on('end', () => {
    const body = Buffer.concat(chunks);
    received.push({ url: req.url, headers: req.headers, body });
    if (req.url === '/token') return res.end(JSON.stringify({ access_token: 'ya29.mock', expires_in: 3600 }));
    if (req.url.startsWith('/gone')) { res.statusCode = 410; return res.end(); }
    if (req.url.includes('messages:send')) {
      const msg = JSON.parse(body).message;
      if (msg.token === 'dead-token') { res.statusCode = 404; return res.end('{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}'); }
      return res.end('{"name":"projects/p/messages/1"}');
    }
    res.statusCode = 201; res.end();
  });
});
let mockBase;
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

let base;
let server;
let push;
let q;
test.before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  mockBase = `http://127.0.0.1:${mock.address().port}`;
  process.env.FCM_API_BASE = mockBase;
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: 'clipzy-test', client_email: 'push@clipzy-test.iam.gserviceaccount.com',
    private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `${mockBase}/token` });
  ({ server } = require('../server/index.js'));
  push = require('../server/lib/push');
  ({ q } = require('../server/db'));
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
});
test.after(() => { server.closeAllConnections?.(); server.close(); mock.close(); });

function client() {
  let cookie = '';
  async function call(method, url, body) {
    const headers = { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, body: json };
  }
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b) };
}

/** What a browser does: decrypt an aes128gcm push body with its private key + auth secret. */
function decrypt(body, ua, auth) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const shared = ua.computeSecret(asPublic);
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const d = crypto.createDecipheriv('aes-128-gcm', hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
  return JSON.parse(plain.subarray(0, -1).toString());
}

function verifyVapid(header, publicKey) {
  const [, token, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, publicKey);
  const [h, c, sig] = token.split('.');
  const raw = Buffer.from(k, 'base64url');
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), 'VAPID signature valid');
  return JSON.parse(Buffer.from(c, 'base64url'));
}

const alice = client();
const bob = client();

test('setup', async () => {
  for (const [c, n] of [[alice, 'alice'], [bob, 'bob']]) {
    const r = await c.post('/api/auth/register', { email: `${n}@t.dev`, username: n, password: 'Test-pass-91', birthDate: '2000-01-01', acceptTerms: true });
    assert.equal(r.status, 201);
  }
});

test('config exposes a stable VAPID public key and FCM availability', async () => {
  const a = (await client().get('/api/push/config')).body;
  assert.equal(Buffer.from(a.webPushKey, 'base64url').length, 65);
  assert.equal(a.fcm, true);
  push._reset();
  assert.equal((await client().get('/api/push/config')).body.webPushKey, a.webPushKey, 'key persisted in the database');
});

test('subscribe validates input and requires login', async () => {
  assert.equal((await client().post('/api/push/subscribe', { type: 'fcm', token: 'x' })).status, 401);
  assert.equal((await alice.post('/api/push/subscribe', { type: 'web', subscription: { endpoint: 'http://insecure.test/x', keys: { p256dh: 'a', auth: 'b' } } })).status, 400);
  assert.equal((await alice.post('/api/push/subscribe', { type: 'web', subscription: { endpoint: 'https://push.example.test/x', keys: { p256dh: 'short', auth: 'short' } } })).status, 400);
  assert.equal((await alice.post('/api/push/subscribe', { type: 'other' })).status, 400);
});

test('web push: a follow and a DM arrive encrypted and decryptable, with a valid VAPID signature', async () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  // Real browsers use https endpoints (checked above); the mock is local http, so register it directly.
  const aliceId = q.get("SELECT id FROM users WHERE username = 'alice'").id;
  push.subscribe(aliceId, { type: 'web', endpoint: `${mockBase}/push/alice`, ...keys });
  const pub = (await client().get('/api/push/config')).body.webPushKey;

  received.length = 0;
  assert.equal((await bob.post('/api/users/alice/follow')).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  const hit = received.find((x) => x.url === '/push/alice');
  assert.ok(hit, 'push service was called');
  assert.equal(hit.headers['content-encoding'], 'aes128gcm');
  const claims = verifyVapid(hit.headers.authorization, pub);
  assert.equal(claims.aud, mockBase);
  const msg = decrypt(hit.body, ua, auth);
  assert.match(msg.body, /bob started following you/);
  assert.equal(msg.url, '/@bob');

  received.length = 0;
  const conv = await bob.post('/api/conversations', { username: 'alice' });
  await bob.post(`/api/conversations/${conv.body.id}/messages`, { body: 'hey there' });
  await new Promise((r) => setTimeout(r, 300));
  const dm = decrypt(received.find((x) => x.url === '/push/alice').body, ua, auth);
  assert.equal(dm.body, 'hey there');
  assert.equal(dm.url, `/messages/${conv.body.id}`);
});

test('fcm: Android tokens get a signed OAuth exchange and an FCM v1 message; dead tokens are removed', async () => {
  received.length = 0;
  assert.equal((await bob.post('/api/push/subscribe', { type: 'fcm', token: 'device-token-1' })).status, 200);
  assert.equal((await bob.post('/api/push/subscribe', { type: 'fcm', token: 'dead-token' })).status, 200);
  const r = await bob.post('/api/push/test');
  assert.deepEqual(r.body, { devices: 2, delivered: 1 });
  const tok = received.find((x) => x.url === '/token');
  const assertion = new URLSearchParams(tok.body.toString()).get('assertion');
  const [h, c, s] = assertion.split('.');
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), rsa.publicKey, Buffer.from(s, 'base64url')), 'service-account JWT is RS256-signed');
  const send = received.find((x) => x.url === '/v1/projects/clipzy-test/messages:send' && JSON.parse(x.body).message.token === 'device-token-1');
  assert.equal(send.headers.authorization, 'Bearer ya29.mock');
  assert.equal(JSON.parse(send.body).message.notification.body, 'Push notifications are working.');
  const left = q.all("SELECT endpoint FROM push_subscriptions WHERE kind = 'fcm'").map((x) => x.endpoint);
  assert.deepEqual(left, ['device-token-1']);
});

test('unsubscribe only removes your own device', async () => {
  assert.equal((await alice.post('/api/push/unsubscribe', { token: 'device-token-1' })).body.removed, 0);
  assert.equal((await bob.post('/api/push/unsubscribe', { token: 'device-token-1' })).body.removed, 1);
});
