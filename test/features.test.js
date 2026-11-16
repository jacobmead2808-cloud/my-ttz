'use strict';
// Tests for drafts/scheduling, duets & stitches, video replies, reposts, not-interested,
// collections, stories, analytics, editing options and captions.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipzy-feat-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.STT_PROVIDER = '';

const { server } = require('../server/index.js');
const { q } = require('../server/db');
const { tick } = require('../server/lib/publish');

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
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text };
  }
  return { get: (u) => call('GET', u), post: (u, b, f) => call('POST', u, b, f), patch: (u, b) => call('PATCH', u, b), del: (u, b) => call('DELETE', u, b) };
}

const webm = () => new Blob([Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(512, 2)])], { type: 'video/webm' });
const png = () => new Blob([Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])], { type: 'image/png' });
async function upload(c, fields = {}) {
  const fd = new FormData();
  fd.append('video', webm(), 'v.webm');
  fd.append('duration', '20');
  for (const [k, val] of Object.entries(fields)) fd.append(k, String(val));
  return c.post('/api/videos', undefined, fd);
}

const ana = client();
const ben = client();
const cat = client();
let original;

test('setup', async () => {
  for (const [c, n] of [[ana, 'ana'], [ben, 'ben'], [cat, 'cat']]) await c.post('/api/auth/register', { email: `${n}@t.dev`, username: n, password: 'password1', birthDate: '2000-01-01', acceptTerms: true });
  await ben.post('/api/users/ana/follow');
  await cat.post('/api/users/ben/follow');
  original = (await upload(ana, { caption: 'original #dance' })).body.video;
  assert.ok(original.id);
});

test('drafts are private until published; scheduled posts publish on time', async () => {
  let r = await upload(ana, { caption: 'draft post', draft: 1 });
  const draft = r.body.video;
  assert.equal(draft.draft, true);
  r = await ben.get(`/api/videos/${draft.id}`);
  assert.equal(r.status, 404);
  r = await ben.get('/api/users/ana/videos');
  assert.ok(!r.body.videos.some((v) => v.id === draft.id));
  r = await ana.get('/api/library/drafts');
  assert.ok(r.body.videos.some((v) => v.id === draft.id));
  r = await ana.patch(`/api/videos/${draft.id}`, { publish: true });
  assert.equal(r.body.video.draft, false);
  r = await ben.get(`/api/videos/${draft.id}`);
  assert.equal(r.status, 200);

  r = await upload(ana, { caption: 'later @ben', publishAt: Date.now() + 120000 });
  const sched = r.body.video;
  assert.ok(sched.publishAt);
  assert.equal((await ben.get(`/api/videos/${sched.id}`)).status, 404);
  r = await upload(ana, { caption: 'too soon', publishAt: Date.now() + 1000 });
  assert.equal(r.status, 400);
  q.run('UPDATE videos SET publish_at = ? WHERE id = ?', Date.now() - 1, sched.id);
  assert.equal(tick().published, 1);
  assert.equal((await ben.get(`/api/videos/${sched.id}`)).status, 200);
  r = await ben.get('/api/notifications');
  assert.ok(r.body.notifications.some((n) => n.type === 'mention' && n.videoId === sched.id), 'mentions fire when the schedule publishes');
});

test('duets and stitches link to the original and respect the creator setting', async () => {
  let r = await upload(ben, { caption: 'my duet', remixOf: original.id, remixType: 'duet' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.video.remix, { type: 'duet', videoId: original.id, username: 'ana' });
  r = await ana.get('/api/notifications');
  assert.ok(r.body.notifications.some((n) => n.type === 'duet'));
  await ana.patch(`/api/videos/${original.id}`, { allowRemix: false });
  r = await upload(ben, { remixOf: original.id, remixType: 'stitch' });
  assert.equal(r.status, 403);
  await ana.patch(`/api/videos/${original.id}`, { allowRemix: true });
});

test('creators can reply to a comment with a video', async () => {
  const c = await ben.post(`/api/videos/${original.id}/comments`, { body: 'Tutorial please!' });
  let r = await ana.get(`/api/videos/comment-info/${c.body.comment.id}`);
  assert.equal(r.body.comment.username, 'ben');
  r = await upload(ana, { caption: 'here you go', replyCommentId: c.body.comment.id });
  assert.equal(r.body.video.replyTo.body, 'Tutorial please!');
  r = await ben.get('/api/notifications');
  assert.ok(r.body.notifications.some((n) => n.type === 'video_reply'));
  r = await upload(cat, { replyCommentId: c.body.comment.id });
  assert.equal(r.status, 403, 'only the video owner can reply with a video');
});

test('reposts appear in followers’ Following feed and on the profile', async () => {
  let r = await ana.post(`/api/videos/${original.id}/repost`);
  assert.equal(r.status, 400, 'cannot repost own video');
  r = await ben.post(`/api/videos/${original.id}/repost`);
  assert.equal(r.body.reposts, 1);
  r = await cat.get('/api/videos/feed/following');
  const item = r.body.videos.find((v) => v.id === original.id);
  assert.ok(item, 'cat follows ben, sees ben’s repost of ana’s video');
  assert.equal(item.repostedBy.username, 'ben');
  r = await cat.get('/api/users/ben/reposts');
  assert.equal(r.body.videos[0].id, original.id);
  r = await ben.del(`/api/videos/${original.id}/repost`);
  assert.equal(r.body.reposted, false);
});

test('not interested removes a video from For You', async () => {
  let r = await cat.get('/api/videos/feed/foryou?limit=20');
  assert.ok(r.body.videos.some((v) => v.id === original.id));
  await cat.post(`/api/videos/${original.id}/not-interested`);
  r = await cat.get('/api/videos/feed/foryou?limit=20');
  assert.ok(!r.body.videos.some((v) => v.id === original.id));
  await cat.del(`/api/videos/${original.id}/not-interested`);
});

test('favourites collections', async () => {
  let r = await cat.post('/api/library/collections', { name: 'Dance ideas', videoId: original.id });
  const cid = r.body.collection.id;
  r = await cat.get(`/api/library/collections/${cid}/videos`);
  assert.equal(r.body.videos[0].id, original.id);
  r = await cat.get(`/api/library/video/${original.id}/collections`);
  assert.equal(r.body.collections[0].contains, true);
  r = await cat.get('/api/library/collections');
  assert.equal(r.body.favorites, 1, 'adding to a collection also saves');
  assert.equal((await ben.get(`/api/library/collections/${cid}/videos`)).status, 404, 'collections are private');
  await cat.del(`/api/library/collections/${cid}/videos/${original.id}`);
  r = await cat.patch(`/api/library/collections/${cid}`, { name: 'Renamed' });
  assert.equal(r.body.collection.name, 'Renamed');
  assert.equal((await cat.del(`/api/library/collections/${cid}`)).status, 200);
});

test('stories: post, tray, view tracking, privacy, expiry', async () => {
  const fd = new FormData();
  fd.append('media', png(), 's.png');
  fd.append('caption', 'hello story');
  let r = await ana.post('/api/stories', undefined, fd);
  assert.equal(r.status, 201);
  const sid = r.body.story.id;
  r = await ben.get('/api/stories/feed');
  const entry = r.body.users.find((u) => u.user.username === 'ana');
  assert.ok(entry && entry.stories.length === 1 && !entry.allSeen);
  const media = await fetch(base + `/media/st/${sid}`);
  assert.equal(media.status, 200);
  await ben.post(`/api/stories/${sid}/view`);
  r = await ben.get('/api/stories/feed');
  assert.equal(r.body.users.find((u) => u.user.username === 'ana').allSeen, true);
  r = await ana.get(`/api/stories/${sid}/viewers`);
  assert.equal(r.body.viewers[0].username, 'ben');
  assert.equal((await ben.get(`/api/stories/${sid}/viewers`)).status, 403);
  await ana.patch('/api/me/settings', { isPrivate: true });
  r = await cat.get('/api/stories/user/ana');
  assert.equal(r.body.stories.length, 0, 'private accounts hide stories from non-followers');
  await ana.patch('/api/me/settings', { isPrivate: false });
  q.run('UPDATE stories SET expires_at = ? WHERE id = ?', Date.now() - 1, sid);
  assert.equal(tick().expired, 1);
  assert.equal((await fetch(base + `/media/st/${sid}`)).status, 404);
});

test('trim, filter and manual captions; auto-captions explain missing config', async () => {
  let r = await ana.patch(`/api/videos/${original.id}`, { trimStart: 2, trimEnd: 10, filter: 'warm', captions: 'WEBVTT\n\n00:00.000 --> 00:02.000\nHello there' });
  assert.equal(r.body.video.trimStart, 2);
  assert.equal(r.body.video.trimEnd, 10);
  assert.equal(r.body.video.filter, 'warm');
  const cc = await fetch(base + r.body.video.captionsUrl);
  assert.match(await cc.text(), /Hello there/);
  r = await ana.patch(`/api/videos/${original.id}`, { trimStart: 5, trimEnd: 4 });
  assert.equal(r.status, 400);
  r = await ana.patch(`/api/videos/${original.id}`, { filter: 'neon-rainbow' });
  assert.equal(r.status, 400);
  r = await ana.patch(`/api/videos/${original.id}`, { captions: 'not vtt' });
  assert.equal(r.status, 400);
  r = await ana.post(`/api/videos/${original.id}/captions/auto`);
  assert.equal(r.status, 501);
  assert.match(r.body.error, /STT_PROVIDER/);
});

test('analytics summarise views, likes, followers and sources', async () => {
  await cat.post(`/api/videos/${original.id}/view`, { source: 'foryou' });
  await cat.post(`/api/videos/${original.id}/view`, { source: 'profile' });
  await cat.post(`/api/videos/${original.id}/like`);
  await cat.post(`/api/videos/${original.id}/share`);
  const r = await ana.get('/api/analytics?days=7');
  assert.equal(r.body.current.views, 2);
  assert.equal(r.body.current.likes, 1);
  assert.equal(r.body.current.shares, 1);
  assert.ok(r.body.current.followers >= 1);
  assert.equal(r.body.daily.length, 7);
  assert.ok(r.body.sources.some((s) => s.source === 'foryou'));
  assert.equal(r.body.topVideos[0].id, original.id);
});
