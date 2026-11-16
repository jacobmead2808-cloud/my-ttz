'use strict';
// Tests for owner-only powers, auto-moderation, creator comment filters and LIVE moderation.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipzy-mod-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const { server } = require('../server/index.js');
const WebSocket = require('ws');
const { q } = require('../server/db');

let base;
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { server.closeAllConnections?.(); server.close(); });

function client() {
  let cookie = '';
  async function call(method, url, body, form) {
    const headers = { 'X-Requested-With': 'fetch' };
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, body: json };
  }
  return { get: (u) => call('GET', u), post: (u, b, f) => call('POST', u, b, f), patch: (u, b) => call('PATCH', u, b), del: (u, b) => call('DELETE', u, b), get cookie() { return cookie; } };
}

const owner = client();
const admin = client();
const creator = client();
const fan = client();
const troll = client();
let videoId;
const id = (name) => q.get('SELECT id FROM users WHERE username = ?', name).id;

test('setup accounts', async () => {
  for (const [c, n] of [[owner, 'owner1'], [admin, 'admin2'], [creator, 'creator'], [fan, 'fan'], [troll, 'troll']]) {
    const r = await c.post('/api/auth/register', { email: `${n}@t.dev`, username: n, password: 'password1' });
    assert.equal(r.status, 201);
  }
  q.run("UPDATE users SET role = 'admin', is_owner = 1 WHERE username = 'owner1'");
  q.run("UPDATE users SET role = 'admin' WHERE username = 'admin2'");
  const fd = new FormData();
  fd.append('video', new Blob([Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(512)])], { type: 'video/webm' }), 'v.webm');
  fd.append('caption', 'hello');
  const r = await creator.post('/api/videos', undefined, fd);
  videoId = r.body.video.id;
});

test('only the owner can verify users and change admin roles', async () => {
  let r = await admin.post(`/api/admin/users/${id('creator')}/verify`, { key: 'weluvjj' });
  assert.equal(r.status, 403);
  r = await owner.post(`/api/admin/users/${id('creator')}/verify`, { key: 'wrong' });
  assert.equal(r.status, 403, 'verification needs the special key');
  r = await owner.post(`/api/admin/users/${id('creator')}/verify`, { key: 'weluvjj' });
  assert.equal(r.status, 200);
  r = await fan.get('/api/users/creator');
  assert.equal(r.body.user.verified, true);
  r = await admin.post(`/api/admin/users/${id('fan')}/role`, { role: 'admin' });
  assert.equal(r.status, 403);
  r = await admin.post(`/api/admin/users/${id('owner1')}/ban`, { reason: 'x' });
  assert.equal(r.status, 403, 'nobody can moderate the owner');
  r = await admin.patch('/api/admin/platform', { registrationsOpen: false });
  assert.equal(r.status, 403);
});

test('auto-mod blocks or holds banned words, spam and shouting', async () => {
  let r = await owner.patch('/api/admin/automod', { blockedWords: ['badword', 'scam*'], action: 'hold' });
  assert.deepEqual(r.body.config.blockedWords, ['badword', 'scam*']);
  r = await troll.post(`/api/videos/${videoId}/comments`, { body: 'this is a B4DW0RD lol' });
  assert.equal(r.status, 201);
  assert.equal(r.body.comment.held, true, 'leetspeak evasion is caught and held');
  r = await fan.get(`/api/videos/${videoId}/comments`);
  assert.equal(r.body.comments.length, 0, 'held comments are invisible to others');
  r = await troll.get(`/api/videos/${videoId}/comments`);
  assert.equal(r.body.comments.length, 1, 'author still sees their own held comment');
  r = await troll.post('/api/conversations', { username: 'fan' });
  r = await troll.post(`/api/conversations/${r.body.id}/messages`, { body: 'total scammer deal' });
  assert.equal(r.status, 400, 'DMs with blocked words are rejected');
  r = await troll.patch('/api/me', { bio: 'join my scam' });
  assert.equal(r.status, 400, 'profiles are checked');
  r = await troll.post(`/api/videos/${videoId}/comments`, { body: 'WHY IS NOBODY WATCHING THIS' });
  assert.equal(r.body.comment.held, true, 'shouting held');
  for (let i = 0; i < 3; i++) await troll.post(`/api/videos/${videoId}/comments`, { body: 'same spam text' });
  r = await troll.post(`/api/videos/${videoId}/comments`, { body: 'same spam text' });
  assert.equal(r.status, 400, 'repeat spam blocked');
  r = await owner.get('/api/admin/automod/log');
  assert.ok(r.body.entries.some((e) => e.rule === 'blocked_word'));
});

test('creator keyword filter and review queue', async () => {
  let r = await creator.patch('/api/me/settings', { filterKeywords: ['spoiler'] });
  assert.deepEqual(r.body.user.settings.filterKeywords, ['spoiler']);
  r = await fan.post(`/api/videos/${videoId}/comments`, { body: 'big spoiler ahead' });
  assert.equal(r.body.comment.held, true);
  r = await creator.get('/api/me/filtered-comments');
  const held = r.body.comments.find((c) => c.body === 'big spoiler ahead');
  assert.ok(held);
  r = await creator.post(`/api/me/filtered-comments/${held.id}/approve`);
  r = await fan.get(`/api/videos/${videoId}/comments`);
  assert.ok(r.body.comments.some((c) => c.body === 'big spoiler ahead'), 'approved comment becomes public');
});

test('reports auto-hide content at the threshold', async () => {
  await owner.patch('/api/admin/automod', { autoHideReports: 2 });
  await fan.post('/api/reports', { targetType: 'video', targetId: videoId, reason: 'spam' });
  let r = await fan.get(`/api/videos/${videoId}`);
  assert.equal(r.status, 200);
  await troll.post('/api/reports', { targetType: 'video', targetId: videoId, reason: 'spam' });
  r = await fan.get(`/api/videos/${videoId}`);
  assert.equal(r.status, 404, 'hidden after 2 reports');
  await owner.post(`/api/admin/videos/${videoId}/restore`);
});

test('LIVE moderation: mods, mute, slow mode, delete, kick', async () => {
  const port = server.address().port;
  let r = await creator.post('/api/live', { title: 'Mod test' });
  const sid = r.body.stream.id;
  r = await creator.post('/api/me/live-moderators', { username: 'fan' });
  assert.equal(r.status, 200);
  const open = (c) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: c.cookie, Origin: base } });
    ws.inbox = [];
    ws.on('message', (d) => ws.inbox.push(JSON.parse(d)));
    ws.on('open', () => resolve(ws));
  });
  const waitFor = (ws, type, pred = () => true) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      const i = ws.inbox.findIndex((x) => x.type === type && pred(x));
      if (i >= 0) return resolve(ws.inbox.splice(i, 1)[0]);
      if (Date.now() - t0 > 3000) return reject(new Error('timeout ' + type));
      setTimeout(poll, 20);
    })();
  });
  const send = (ws, m) => ws.send(JSON.stringify({ streamId: sid, ...m }));
  const host = await open(creator);
  const mod = await open(fan);
  const bad = await open(troll);
  send(host, { type: 'live:host' });
  send(mod, { type: 'live:join' });
  const st = await waitFor(mod, 'live:state');
  assert.equal(st.role, 'mod');
  send(bad, { type: 'live:join' });
  await waitFor(bad, 'live:state');

  send(bad, { type: 'live:chat', text: 'hi all' });
  const chat = await waitFor(host, 'live:chat');
  send(mod, { type: 'live:mod', action: 'delete', messageId: chat.message.id });
  await waitFor(bad, 'live:chat-deleted');

  send(mod, { type: 'live:mod', action: 'mute', userId: id('troll'), minutes: 5 });
  await waitFor(bad, 'live:muted');
  send(bad, { type: 'live:chat', text: 'can you hear me' });
  const e = await waitFor(bad, 'live:error');
  assert.match(e.message, /muted/);
  send(mod, { type: 'live:mod', action: 'unmute', userId: id('troll') });
  await waitFor(bad, 'live:unmuted');

  send(host, { type: 'live:mod', action: 'slow', seconds: 30 });
  await waitFor(bad, 'live:settings', (m) => m.slowMode === 30);
  send(bad, { type: 'live:chat', text: 'one' });
  await waitFor(bad, 'live:chat');
  send(bad, { type: 'live:chat', text: 'two' });
  assert.match((await waitFor(bad, 'live:error')).message, /Slow mode/);

  send(mod, { type: 'live:mod', action: 'kick', userId: id('creator') });
  assert.match((await waitFor(mod, 'live:error')).message, /cannot remove/);
  send(mod, { type: 'live:mod', action: 'kick', userId: id('troll') });
  await waitFor(bad, 'live:kicked');
  send(bad, { type: 'live:join' });
  await waitFor(bad, 'live:kicked');

  send(bad, { type: 'live:mod', action: 'slow', seconds: 0 });
  await waitFor(bad, 'live:error', (m) => /Only the host/.test(m.message));
  [host, mod, bad].forEach((w) => w.close());
  await creator.post(`/api/live/${sid}/end`);
});

test('admin extras: restrict commenting, announcements, platform switches', async () => {
  let r = await admin.post(`/api/admin/users/${id('troll')}/flags`, { commentBanned: true });
  assert.equal(r.status, 200);
  r = await troll.post(`/api/videos/${videoId}/comments`, { body: 'nice' });
  assert.equal(r.status, 400);
  r = await admin.post('/api/admin/announce', { message: 'Welcome to the beta!' });
  assert.ok(r.body.sent >= 4);
  r = await fan.get('/api/notifications');
  assert.ok(r.body.notifications.some((n) => n.type === 'announcement'));
  r = await owner.patch('/api/admin/platform', { registrationsOpen: false });
  assert.equal(r.body.platform.registrationsOpen, false);
  r = await client().post('/api/auth/register', { email: 'x@t.dev', username: 'newbie', password: 'password1' });
  assert.equal(r.status, 403);
  await owner.patch('/api/admin/platform', { registrationsOpen: true });
});
