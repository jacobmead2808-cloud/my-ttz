'use strict';
// End-to-end API tests against a throwaway database. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipzy-test-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.MAIL_PROVIDER = '';

const { server } = require('../server/index.js');
const WebSocket = require('ws');
const { q } = require('../server/db');

let base;
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { server.closeAllConnections?.(); server.close(); });

/** Minimal cookie-keeping client. */
function client() {
  let cookie = '';
  async function call(method, url, body, { form } = {}) {
    const headers = { 'X-Requested-With': 'fetch' };
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text };
  }
  return {
    get: (u) => call('GET', u), post: (u, b, o) => call('POST', u, b, o), patch: (u, b) => call('PATCH', u, b), del: (u, b) => call('DELETE', u, b),
    get cookie() { return cookie; },
  };
}

const fakeWebm = () => new Blob([Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2048, 1)])], { type: 'video/webm' });
const fakePng = () => new Blob([Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(256)])], { type: 'image/png' });

const alice = client();
const bob = client();
const carol = client();
const admin = client();
let videoId;

test('registration validates input and creates sessions', async () => {
  let r = await alice.post('/api/auth/register', { email: 'bad', username: 'alice', password: 'password1' });
  assert.equal(r.status, 400);
  r = await alice.post('/api/auth/register', { email: 'alice@test.dev', username: 'alice', password: 'short' });
  assert.equal(r.status, 400);
  r = await alice.post('/api/auth/register', { email: 'alice@test.dev', username: 'alice', password: 'password1', displayName: 'Alice' });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.username, 'alice');
  assert.ok(!('password_hash' in r.body.user));
  r = await bob.post('/api/auth/register', { email: 'ALICE@test.dev', username: 'bob', password: 'password1' });
  assert.equal(r.status, 409, 'duplicate email (case-insensitive)');
  r = await bob.post('/api/auth/register', { email: 'bob@test.dev', username: 'bob', password: 'password1' });
  assert.equal(r.status, 201);
  r = await carol.post('/api/auth/register', { email: 'carol@test.dev', username: 'carol', password: 'password1' });
  assert.equal(r.status, 201);
  r = await admin.post('/api/auth/register', { email: 'root@test.dev', username: 'boss', password: 'password1' });
  q.run("UPDATE users SET role = 'admin' WHERE username = 'boss'");
  const me = await alice.get('/api/auth/me');
  assert.equal(me.body.user.email, 'alice@test.dev');
});

test('passwords are hashed, login/logout work, CSRF header required', async () => {
  const row = q.get("SELECT password_hash FROM users WHERE username = 'alice'");
  assert.match(row.password_hash, /^scrypt\$/);
  const c = client();
  let r = await c.post('/api/auth/login', { login: 'alice', password: 'wrong-pass1' });
  assert.equal(r.status, 401);
  r = await c.post('/api/auth/login', { login: 'ALICE@test.dev', password: 'password1' });
  assert.equal(r.status, 200);
  r = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Cookie: c.cookie } });
  assert.equal(r.status, 403, 'missing CSRF header is rejected');
  r = await c.post('/api/auth/logout');
  assert.equal(r.status, 200);
  r = await c.get('/api/auth/me');
  assert.equal(r.body.user, null);
});

test('password reset flow', async () => {
  const r = await client().post('/api/auth/forgot', { email: 'carol@test.dev' });
  assert.equal(r.status, 200);
  const outbox = path.join(process.env.DATA_DIR, 'outbox');
  const mail = fs.readdirSync(outbox).map((f) => fs.readFileSync(path.join(outbox, f), 'utf8')).find((t) => t.includes('carol@test.dev'));
  const token = decodeURIComponent(mail.match(/token=([^\s]+)/)[1]);
  let x = await client().post('/api/auth/reset', { token, password: 'newpassword2' });
  assert.equal(x.status, 200);
  x = await client().post('/api/auth/reset', { token, password: 'newpassword3' });
  assert.equal(x.status, 400, 'token is single-use');
  x = await carol.post('/api/auth/login', { login: 'carol', password: 'newpassword2' });
  assert.equal(x.status, 200);
});

test('profile editing and avatar upload', async () => {
  let r = await alice.patch('/api/me', { bio: 'Hello world', displayName: 'Alice A' });
  assert.equal(r.body.user.bio, 'Hello world');
  const form = new FormData();
  form.append('avatar', fakePng(), 'a.png');
  r = await alice.post('/api/me/avatar', undefined, { form });
  assert.equal(r.status, 200);
  assert.match(r.body.user.avatarUrl, /^\/media\/a\/.+\.png$/);
  const bad = new FormData();
  bad.append('avatar', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'x.png');
  r = await alice.post('/api/me/avatar', undefined, { form: bad });
  assert.equal(r.status, 400, 'magic-byte check rejects fake images');
});

test('video upload, edit, feed, like, save, share, view', async () => {
  const form = new FormData();
  form.append('video', fakeWebm(), 'clip.webm');
  form.append('thumbnail', fakePng(), 't.png');
  form.append('caption', 'My first clip #Hello #dance with @bob');
  form.append('visibility', 'public');
  form.append('duration', '5');
  let r = await alice.post('/api/videos', undefined, { form });
  assert.equal(r.status, 201, r.text);
  videoId = r.body.video.id;
  assert.deepEqual(r.body.video.hashtags.sort(), ['dance', 'hello']);
  r = await alice.patch(`/api/videos/${videoId}`, { caption: 'Edited #hello' });
  assert.deepEqual(r.body.video.hashtags, ['hello']);
  r = await bob.get('/api/videos/feed/foryou');
  assert.ok(r.body.videos.some((v) => v.id === videoId));
  r = await bob.post(`/api/videos/${videoId}/like`);
  assert.equal(r.body.likes, 1);
  r = await bob.post(`/api/videos/${videoId}/save`);
  assert.equal(r.body.saved, true);
  r = await bob.post(`/api/videos/${videoId}/share`);
  assert.equal(r.body.shares, 1);
  r = await bob.post(`/api/videos/${videoId}/view`);
  assert.equal(r.body.views, 1);
  r = await bob.get(`/api/videos/${videoId}`);
  assert.equal(r.body.video.liked, true);
  assert.equal(r.body.video.saved, true);
  const media = await fetch(base + `/media/v/${videoId}`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(media.status, 206, 'range requests supported for streaming');
  r = await bob.del(`/api/videos/${videoId}/like`);
  assert.equal(r.body.likes, 0);
  await bob.post(`/api/videos/${videoId}/like`);
  r = await bob.patch(`/api/videos/${videoId}`, { caption: 'hacked' });
  assert.equal(r.status, 403, 'cannot edit others videos');
});

test('mentions, comments, replies and notifications', async () => {
  let r = await bob.get('/api/notifications');
  assert.ok(r.body.notifications.some((n) => n.type === 'mention'), 'bob was mentioned in caption');
  r = await bob.post(`/api/videos/${videoId}/comments`, { body: 'Nice one @carol' });
  assert.equal(r.status, 201);
  const cid = r.body.comment.id;
  r = await alice.post(`/api/videos/${videoId}/comments`, { body: 'Thanks!', parentId: cid });
  assert.equal(r.body.comment.parentId, cid);
  r = await alice.get(`/api/videos/${videoId}/comments`);
  assert.equal(r.body.comments.length, 1);
  assert.equal(r.body.comments[0].replies, 1);
  r = await alice.get(`/api/videos/comments/${cid}/replies`);
  assert.equal(r.body.comments.length, 1);
  r = await alice.get('/api/notifications');
  const types = r.body.notifications.map((n) => n.type);
  assert.ok(types.includes('like') && types.includes('comment'), types.join(','));
  assert.ok(r.body.unread >= 2);
  r = await carol.get('/api/notifications?filter=mentions');
  assert.equal(r.body.notifications.length, 1);
  r = await alice.post('/api/notifications/read');
  assert.equal(r.body.unread, 0);
});

test('follow / unfollow, private accounts and follow requests', async () => {
  let r = await bob.post('/api/users/alice/follow');
  assert.equal(r.body.followStatus, 'accepted');
  assert.equal(r.body.stats.followers, 1);
  r = await bob.get('/api/videos/feed/following');
  assert.ok(r.body.videos.some((v) => v.id === videoId));
  r = await bob.del('/api/users/alice/follow');
  assert.equal(r.body.stats.followers, 0);
  await carol.patch('/api/me/settings', { isPrivate: true });
  r = await bob.post('/api/users/carol/follow');
  assert.equal(r.body.followStatus, 'pending');
  r = await bob.get('/api/users/carol/videos');
  assert.equal(r.body.private, true);
  r = await carol.get('/api/me/follow-requests');
  assert.equal(r.body.requests[0].user.username, 'bob');
  r = await carol.post(`/api/me/follow-requests/${r.body.requests[0].user.id}/accept`);
  assert.equal(r.status, 200);
  r = await bob.get('/api/users/carol');
  assert.equal(r.body.user.relationship.followStatus, 'accepted');
  assert.equal(r.body.user.canView, true);
});

test('direct messages with privacy controls and unread counts', async () => {
  let r = await bob.post('/api/conversations', { username: 'alice' });
  const cid = r.body.id;
  r = await bob.post(`/api/conversations/${cid}/messages`, { body: 'Hey Alice!' });
  assert.equal(r.status, 201);
  r = await bob.post(`/api/conversations/${cid}/messages`, { videoId });
  assert.equal(r.body.message.video.id, videoId);
  r = await alice.get('/api/conversations');
  assert.equal(r.body.conversations[0].unread, 2);
  assert.equal(r.body.unreadTotal, 2);
  r = await alice.post(`/api/conversations/${cid}/read`);
  assert.equal(r.body.unreadTotal, 0);
  r = await carol.get(`/api/conversations/${cid}/messages`);
  assert.equal(r.status, 404, 'non-participants cannot read');
  await alice.patch('/api/me/settings', { allowMessages: 'none' });
  r = await bob.post(`/api/conversations/${cid}/messages`, { body: 'still there?' });
  assert.equal(r.status, 403);
  await alice.patch('/api/me/settings', { allowMessages: 'everyone' });
});

test('real-time DM delivery over WebSocket', async () => {
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: alice.cookie, Origin: base } });
  const got = new Promise((resolve, reject) => {
    ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'dm:new') resolve(m); });
    setTimeout(() => reject(new Error('timeout')), 4000);
  });
  await new Promise((r) => ws.on('open', r));
  const c = await bob.post('/api/conversations', { username: 'alice' });
  await bob.post(`/api/conversations/${c.body.id}/messages`, { body: 'realtime!' });
  const m = await got;
  assert.equal(m.message.body, 'realtime!');
  ws.close();
  const evil = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: 'https://evil.example' } });
  await assert.rejects(new Promise((res, rej) => { evil.on('open', res); evil.on('error', rej); }));
});

test('LIVE: start, signaling relay, chat, likes, viewer count, end permissions', async () => {
  const port = server.address().port;
  q.run("UPDATE users SET is_verified = 1 WHERE username = 'alice'"); // LIVE needs 500+ followers, verification or good standing
  let r = await alice.post('/api/live', { title: 'Test stream' });
  assert.equal(r.status, 201);
  const sid = r.body.stream.id;
  r = await bob.post(`/api/live/${sid}/end`);
  assert.equal(r.status, 403, 'viewers cannot end a stream');

  const open = (cookie) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie, Origin: base } });
    ws.inbox = [];
    ws.on('message', (d) => ws.inbox.push(JSON.parse(d)));
    ws.on('open', () => resolve(ws));
  });
  const waitFor = (ws, type, pred = () => true) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      const m = ws.inbox.find((x) => x.type === type && pred(x));
      if (m) return resolve(m);
      if (Date.now() - t0 > 3000) return reject(new Error('timeout waiting for ' + type));
      setTimeout(poll, 20);
    })();
  });
  const host = await open(alice.cookie);
  const viewer = await open(bob.cookie);
  host.send(JSON.stringify({ type: 'live:host', streamId: sid }));
  await waitFor(host, 'live:state');
  viewer.send(JSON.stringify({ type: 'live:join', streamId: sid }));
  const join = await waitFor(host, 'live:peer-join');
  host.send(JSON.stringify({ type: 'live:signal', streamId: sid, to: join.peerId, data: { type: 'offer', sdp: 'x' } }));
  const offer = await waitFor(viewer, 'live:signal');
  assert.equal(offer.data.type, 'offer');
  viewer.send(JSON.stringify({ type: 'live:signal', streamId: sid, data: { type: 'answer', sdp: 'y' } }));
  const answer = await waitFor(host, 'live:signal');
  assert.equal(answer.from, join.peerId);
  const vc = await waitFor(host, 'live:viewers', (m) => m.count === 1);
  assert.equal(vc.count, 1);
  viewer.send(JSON.stringify({ type: 'live:chat', streamId: sid, text: 'hello live' }));
  const chat = await waitFor(host, 'live:chat');
  assert.equal(chat.message.text, 'hello live');
  viewer.send(JSON.stringify({ type: 'live:like', streamId: sid, count: 5 }));
  const like = await waitFor(host, 'live:like');
  assert.equal(like.total, 5);
  r = await carol.get('/api/live');
  assert.equal(r.body.streams[0].viewers, 1);
  r = await alice.post(`/api/live/${sid}/end`);
  assert.equal(r.body.stream.status, 'ended');
  await waitFor(viewer, 'live:ended');
  host.close(); viewer.close();
  r = await bob.get(`/api/live/${sid}/chat`);
  assert.equal(r.body.messages[0].text, 'hello live', 'chat persisted');
});

test('search and discovery', async () => {
  let r = await bob.get('/api/search?q=ali');
  assert.ok(r.body.users.some((u) => u.username === 'alice'));
  r = await bob.get('/api/search?q=%23hello&type=hashtags');
  assert.equal(r.body.hashtags[0].tag, 'hello');
  r = await bob.get('/api/search?q=edited&type=videos');
  assert.equal(r.body.videos[0].id, videoId);
  r = await bob.get('/api/tags/hello');
  assert.equal(r.body.videos.length, 1);
  r = await bob.get('/api/discover');
  assert.ok(Array.isArray(r.body.tags) && Array.isArray(r.body.creators));
});

test('block hides content and prevents interaction', async () => {
  let r = await alice.post('/api/users/carol/block');
  assert.equal(r.body.blocked, true);
  r = await carol.get(`/api/videos/${videoId}`);
  assert.equal(r.status, 404);
  r = await carol.get('/api/users/alice');
  assert.equal(r.status, 404);
  r = await carol.post('/api/conversations', { username: 'alice' });
  assert.equal(r.status, 403);
  r = await alice.del('/api/users/carol/block');
  assert.equal(r.body.blocked, false);
});

test('reports and admin moderation are server-side protected', async () => {
  let r = await bob.get('/api/admin/stats');
  assert.equal(r.status, 403);
  r = await bob.post('/api/reports', { targetType: 'video', targetId: videoId, reason: 'spam', details: 'test' });
  assert.equal(r.status, 201);
  r = await admin.get('/api/admin/stats');
  assert.equal(r.body.totals.openReports, 1);
  r = await admin.get('/api/admin/reports');
  const rep = r.body.reports[0];
  r = await admin.post(`/api/admin/reports/${rep.id}/resolve`, { action: 'remove_content', note: 'spam' });
  assert.equal(r.status, 200);
  r = await bob.get(`/api/videos/${videoId}`);
  assert.equal(r.status, 404, 'removed video hidden');
  r = await admin.post(`/api/admin/videos/${videoId}/restore`);
  r = await bob.get(`/api/videos/${videoId}`);
  assert.equal(r.status, 200);
  const carolId = q.get("SELECT id FROM users WHERE username = 'carol'").id;
  r = await admin.post(`/api/admin/users/${carolId}/suspend`, { days: 3, reason: 'testing' });
  assert.equal(r.status, 200);
  r = await carol.get('/api/auth/me');
  assert.equal(r.body.user, null, 'suspended user is logged out');
  r = await client().post('/api/auth/login', { login: 'carol', password: 'newpassword2' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /suspended/);
  await admin.post(`/api/admin/users/${carolId}/restore`);
  r = await admin.post(`/api/admin/users/${carolId}/ban`, { reason: 'x' });
  r = await client().post('/api/auth/login', { login: 'carol', password: 'newpassword2' });
  assert.match(r.body.error, /banned/);
  r = await admin.get('/api/admin/audit');
  assert.ok(r.body.entries.length >= 3);
});

test('owner can delete their video; data persists in SQLite', async () => {
  let r = await bob.del(`/api/videos/${videoId}`);
  assert.equal(r.status, 403);
  r = await alice.del(`/api/videos/${videoId}`);
  assert.equal(r.status, 200);
  assert.equal(q.get('SELECT COUNT(*) AS n FROM videos WHERE id = ?', videoId).n, 0);
  assert.ok(q.get('SELECT COUNT(*) AS n FROM messages').n >= 3);
  assert.ok(q.get('SELECT COUNT(*) AS n FROM users').n === 4);
});
