'use strict';
// Coins, gifts, LIVE eligibility & trials, Guardian auto-moderation, dossier, watch parties, vibes.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipzy-eco-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.STRIPE_SECRET_KEY = '';
process.env.AI_MODERATION = '';

const { server } = require('../server/index.js');
const WebSocket = require('ws');
const { q } = require('../server/db');
const aiMod = require('../server/lib/aiMod');

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
const id = (n) => q.get('SELECT id FROM users WHERE username = ?', n).id;

const owner = client();
const host = client();
const fan = client();
const spammer = client();

test('setup', async () => {
  for (const [c, n] of [[owner, 'boss'], [host, 'streamer'], [fan, 'fan1'], [spammer, 'spammy']]) {
    const r = await c.post('/api/auth/register', { email: `${n}@t.dev`, username: n, password: 'password1' });
    assert.equal(r.status, 201);
  }
  q.run("UPDATE users SET role = 'admin', is_owner = 1 WHERE username = 'boss'");
});

test('coins: packages, owner discount, demo purchase, transactions', async () => {
  let r = await fan.get('/api/coins');
  assert.equal(r.body.paymentMode, 'demo');
  assert.equal(r.body.wallet.coins, 0);
  const p350 = r.body.packages.find((p) => p.coins === 350);
  assert.equal(p350.priceCents, 339);
  r = await host.patch('/api/admin/economy', { discountPercent: 25 });
  assert.equal(r.status, 403, 'only the owner sets discounts');
  r = await owner.patch('/api/admin/economy', { discountPercent: 25, discountLabel: 'Launch sale' });
  assert.equal(r.status, 200);
  r = await fan.get('/api/coins');
  assert.equal(r.body.packages.find((p) => p.coins === 350).priceCents, Math.round(339 * 0.75));
  assert.equal(r.body.discount.percent, 25);
  await owner.patch('/api/admin/economy', { discountPercent: 0 });
  r = await fan.post('/api/coins/checkout', { coins: 1000 });
  assert.equal(r.body.demo, true);
  assert.equal(r.body.wallet.coins, 1000);
  r = await fan.get('/api/coins/transactions');
  assert.equal(r.body.transactions[0].type, 'purchase');
});

test('LIVE eligibility: blocked without followers/verification/standing; trial allowed once', async () => {
  let r = await host.get('/api/live/eligibility');
  assert.equal(r.body.eligible, false);
  assert.equal(r.body.trial.available, false, 'account must be a day old for a trial');
  q.run('UPDATE users SET created_at = ? WHERE username = ?', Date.now() - 2 * 86400000, 'streamer');
  r = await host.get('/api/live/eligibility');
  assert.equal(r.body.trial.available, true);
  r = await host.post('/api/live', { title: 'nope' });
  assert.equal(r.status, 403);
  r = await host.post('/api/live', { title: 'trial', trial: true, goal: { type: 'gifts', target: 100, label: 'New mic' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.stream.isTrial, true);
  const sid = r.body.stream.id;
  await host.post(`/api/live/${sid}/end`);
  r = await host.get('/api/live/eligibility');
  assert.equal(r.body.trial.available, false, 'one trial per week');
  q.run('UPDATE users SET is_verified = 1 WHERE username = ?', 'streamer');
  r = await host.get('/api/live/eligibility');
  assert.equal(r.body.eligible, true);
  assert.equal(r.body.via, 'verified');
});

test('gifts in LIVE: coins move, diamonds credited, broadcast + leaderboard + goal', async () => {
  const port = server.address().port;
  let r = await host.post('/api/live', { title: 'Gift test', goal: { type: 'gifts', target: 500 } });
  const sid = r.body.stream.id;
  const viewer = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: host.cookie, Origin: base } });
    ws.inbox = [];
    ws.on('message', (d) => ws.inbox.push(JSON.parse(d)));
    ws.on('open', () => resolve(ws));
  });
  viewer.send(JSON.stringify({ type: 'live:host', streamId: sid }));
  await new Promise((res) => setTimeout(res, 150));
  r = await fan.post(`/api/live/${sid}/gift`, { giftId: 'crown', count: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.body.wallet.coins, 1000 - 499);
  r = await fan.post(`/api/live/${sid}/gift`, { giftId: 'galaxy' });
  assert.equal(r.status, 400, 'not enough coins');
  await new Promise((res) => setTimeout(res, 150));
  const gift = viewer.inbox.find((m) => m.type === 'live:gift');
  assert.equal(gift.gift.id, 'crown');
  assert.equal(gift.leaders[0].username, 'fan1');
  const goal = viewer.inbox.filter((m) => m.type === 'live:settings').pop();
  assert.equal(goal.goal.progress, 499);
  r = await host.get('/api/coins');
  assert.equal(r.body.wallet.diamonds, Math.floor(499 * 0.5));
  r = await host.post('/api/coins/exchange', { diamonds: 100 });
  assert.equal(r.body.wallet.coins, 100);
  r = await fan.get('/api/coins/gallery/streamer');
  assert.equal(r.body.gifts.find((g) => g.id === 'crown').received, 1);
  assert.equal(r.body.supporters[0].username, 'fan1');
  viewer.close();
  await host.post(`/api/live/${sid}/end`);
});

test('Guardian: escalates, auto-suspends spammers, opens a case, staff resolve it', async () => {
  const sid = id('spammy');
  for (let i = 0; i < 8; i++) q.run("INSERT INTO automod_log (user_id, context, content, rule, action, created_at) VALUES (?, 'comment', 'spam', 'blocked_word', 'block', ?)", sid, Date.now());
  for (const c of [fan, host, owner]) await c.post('/api/reports', { targetType: 'user', targetId: sid, reason: 'spam' });
  const vidId = q.get('SELECT id FROM videos LIMIT 1') ? q.get('SELECT id FROM videos LIMIT 1').id : null;
  if (!vidId) q.run("INSERT INTO videos (user_id, video_file, video_mime, created_at, updated_at) VALUES (?, 'x.webm', 'video/webm', ?, ?)", id('streamer'), Date.now(), Date.now());
  const anyVid = q.get('SELECT id FROM videos LIMIT 1').id;
  for (let i = 0; i < 2; i++) q.run("INSERT INTO comments (video_id, user_id, body, status, created_at) VALUES (?, ?, 'removed spam', 'removed', ?)", anyVid, sid, Date.now());
  const a = await aiMod.review(sid);
  assert.ok(a.score >= 85, `score ${a.score}`);
  assert.equal(a.action, 'suspended');
  assert.equal(q.get('SELECT status FROM users WHERE id = ?', sid).status, 'suspended');
  let r = await owner.get('/api/admin/cases');
  const c = r.body.cases.find((x) => x.userId === sid);
  assert.equal(c.severity, 'high');
  r = await owner.get('/api/notifications');
  assert.ok(r.body.notifications.some((n) => n.type === 'mod_case'), 'staff alerted');
  r = await owner.get(`/api/admin/users/${sid}/dossier`);
  assert.ok(r.body.risk.score >= 85);
  assert.ok(r.body.strikes.some((s) => s.kind === 'suspension' && s.auto));
  r = await owner.post(`/api/admin/cases/${c.id}/resolve`, { action: 'lift', note: 'false alarm' });
  assert.equal(q.get('SELECT status FROM users WHERE id = ?', sid).status, 'active');
  const v = q.get('SELECT * FROM users WHERE username = ?', 'streamer');
  q.run('UPDATE users SET is_verified = 1 WHERE id = ?', v.id);
  for (let i = 0; i < 12; i++) q.run("INSERT INTO automod_log (user_id, context, content, rule, action, created_at) VALUES (?, 'comment', 'x', 'blocked_word', 'block', ?)", v.id, Date.now());
  for (const c of [fan, owner]) await c.post('/api/reports', { targetType: 'user', targetId: v.id, reason: 'harassment' });
  q.run("INSERT INTO reports (reporter_id, target_type, target_id, reason, created_at) VALUES (?, 'user', ?, 'spam', ?)", sid, v.id, Date.now()); // spammer's session ended when suspended
  await new Promise((res) => setTimeout(res, 50));
  const b = await aiMod.review(v.id);
  assert.equal(b.action, 'escalated', `verified accounts are escalated to humans, never auto-suspended (score ${b.score}, ${JSON.stringify(b.signals.map((s) => s.key))})`);
});

test('watch party: create, join, synced control, chat', async () => {
  const port = server.address().port;
  const fd = new FormData();
  fd.append('video', new Blob([Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(256)])], { type: 'video/webm' }), 'v.webm');
  fd.append('caption', 'party time #dance');
  const vid = (await host.post('/api/videos', undefined, fd)).body.video.id;
  let r = await host.post('/api/party', { videoId: vid });
  const code = r.body.code;
  const open = (c) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: c.cookie, Origin: base } });
    ws.inbox = [];
    ws.on('message', (d) => ws.inbox.push(JSON.parse(d)));
    ws.on('open', () => resolve(ws));
  });
  const a = await open(host);
  const b = await open(fan);
  a.send(JSON.stringify({ type: 'party:join', code }));
  b.send(JSON.stringify({ type: 'party:join', code }));
  await new Promise((res) => setTimeout(res, 150));
  b.send(JSON.stringify({ type: 'party:control', code, action: 'play', position: 0 }));
  await new Promise((res) => setTimeout(res, 100));
  assert.ok(b.inbox.some((m) => m.type === 'party:error'), 'guests cannot control by default');
  a.send(JSON.stringify({ type: 'party:control', code, action: 'seek', position: 12 }));
  a.send(JSON.stringify({ type: 'party:chat', code, text: 'hi party' }));
  await new Promise((res) => setTimeout(res, 150));
  const st = b.inbox.filter((m) => m.type === 'party:state').pop();
  assert.ok(st.position >= 12 && st.members.length === 2);
  assert.ok(b.inbox.some((m) => m.type === 'party:chat' && m.message.text === 'hi party'));
  r = await fan.get(`/api/party/${code}`);
  assert.equal(r.body.videos[0].id, vid);
  r = await fan.get('/api/videos/feed/foryou?vibe=hype');
  assert.ok(r.body.videos.some((x) => x.id === vid), 'Vibes feed filters by mood');
  r = await fan.get('/api/videos/feed/foryou?vibe=learn');
  assert.ok(!r.body.videos.some((x) => x.id === vid));
  a.close(); b.close();
});
