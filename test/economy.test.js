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
    const r = await c.post('/api/auth/register', { email: `${n}@t.dev`, username: n, password: 'Test-pass-91', birthDate: '2000-01-01', acceptTerms: true });
    assert.equal(r.status, 201);
  }
  q.run("UPDATE users SET role = 'admin', is_owner = 1 WHERE username = 'boss'");
});

// ---- Stripe: a local stand-in for Stripe's API (same request/response shape) ----
const crypto = require('crypto');
const http = require('http');
const stripeCalls = [];
const stripeMock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; }).on('end', () => {
    stripeCalls.push({ url: req.url, headers: req.headers, form: new URLSearchParams(body) });
    const n = stripeCalls.length;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: `cs_test_${n}`, url: `https://checkout.stripe.test/c/${n}` }));
  });
});
const WHSEC = 'whsec_test_only';
const sign = (body, secret = WHSEC) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
};
const webhook = (event, secret) => {
  const body = JSON.stringify(event);
  return fetch(`${base}/api/coins/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sign(body, secret) }, body });
};
const paidEvent = (eventId, sessionId, orderId, amount, currency = 'gbp', pi = `pi_${sessionId}`) => ({
  id: eventId, type: 'checkout.session.completed',
  data: { object: { id: sessionId, payment_status: 'paid', amount_total: amount, currency, payment_intent: pi, metadata: { order_id: String(orderId) } } },
});

test('coins: packages and owner discount; buying is off until Stripe is configured', async () => {
  let r = await fan.get('/api/coins');
  assert.equal(r.body.paymentMode, 'disabled', 'no demo or test-credit mode exists');
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
  assert.equal(r.status, 503);
  assert.equal((await fan.get('/api/coins')).body.wallet.coins, 0, 'nothing credited');
});

test('Stripe: coins are credited only by a verified webhook with the right amount, once', async () => {
  await new Promise((res) => stripeMock.listen(0, '127.0.0.1', res));
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${stripeMock.address().port}`;
  process.env.STRIPE_SECRET_KEY = 'sk_test_local';
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
  assert.equal((await fan.get('/api/coins')).body.paymentMode, 'stripe');

  let r = await fan.post('/api/coins/checkout', { coins: 1000 });
  assert.equal(r.status, 200);
  assert.match(r.body.url, /^https:\/\/checkout\.stripe\.test\//);
  const order = r.body.orderId;
  const call = stripeCalls[stripeCalls.length - 1];
  assert.equal(call.headers.authorization, 'Bearer sk_test_local');
  assert.equal(call.headers['idempotency-key'], `clipzy-order-${order}`);
  assert.equal(call.form.get('line_items[0][price_data][unit_amount]'), '965', 'server-side price, not the client’s');
  assert.equal(call.form.get('metadata[order_id]'), String(order));
  assert.equal((await fan.get('/api/coins')).body.wallet.coins, 0, 'returning from checkout credits nothing by itself');
  assert.equal((await fan.get(`/api/coins/orders/${order}`)).body.order.status, 'pending');

  // forged signature, wrong amount, wrong session id: none credit coins
  assert.equal((await webhook(paidEvent('evt_forged', 'cs_test_1', order, 965), 'whsec_wrong')).status, 400);
  await webhook(paidEvent('evt_wrong_session', 'cs_test_999', order, 965));
  assert.equal((await fan.get('/api/coins')).body.wallet.coins, 0);

  // the real event, delivered three times at once and then again later
  const ev = paidEvent('evt_paid_1', 'cs_test_1', order, 965);
  const results = await Promise.all([webhook(ev), webhook(ev), webhook(ev)]);
  results.forEach((x) => assert.equal(x.status, 200));
  await webhook({ ...ev, id: 'evt_paid_1_again' });
  r = await fan.get('/api/coins');
  assert.equal(r.body.wallet.coins, 1000, 'credited exactly once');
  assert.equal((await fan.get(`/api/coins/orders/${order}`)).body.order.status, 'paid');
  r = await fan.get('/api/coins/transactions');
  assert.equal(r.body.transactions[0].type, 'purchase');
  assert.equal(r.body.transactions[0].coins, 1000);

  // an order whose charged amount doesn't match is never credited
  r = await fan.post('/api/coins/checkout', { coins: 100 });
  await webhook(paidEvent('evt_tampered', `cs_test_${stripeCalls.length}`, r.body.orderId, 1));
  assert.equal((await fan.get(`/api/coins/orders/${r.body.orderId}`)).body.order.status, 'failed');
  assert.equal((await fan.get('/api/coins')).body.wallet.coins, 1000);

  // cancelling at Stripe, and an expired checkout
  r = await fan.post('/api/coins/checkout', { coins: 100 });
  await fan.post(`/api/coins/orders/${r.body.orderId}/cancel`);
  assert.equal((await fan.get(`/api/coins/orders/${r.body.orderId}`)).body.order.status, 'cancelled');
  r = await fan.post('/api/coins/checkout', { coins: 100 });
  await webhook({ id: 'evt_exp', type: 'checkout.session.expired', data: { object: { id: `cs_test_${stripeCalls.length}`, metadata: { order_id: String(r.body.orderId) } } } });
  assert.equal((await fan.get(`/api/coins/orders/${r.body.orderId}`)).body.order.status, 'expired');
});

test('Stripe: a refund takes the coins back (never below zero)', async () => {
  let r = await fan.post('/api/coins/checkout', { coins: 100 });
  const orderId = r.body.orderId;
  const sid = `cs_test_${stripeCalls.length}`;
  await webhook(paidEvent('evt_paid_refundable', sid, orderId, 99, 'gbp', 'pi_refund_me'));
  assert.equal((await fan.get('/api/coins')).body.wallet.coins, 1100);
  await webhook({ id: 'evt_refund', type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: 'pi_refund_me', refunded: true } } });
  await webhook({ id: 'evt_refund_dup', type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: 'pi_refund_me', refunded: true } } });
  assert.equal((await fan.get('/api/coins')).body.wallet.coins, 1000, 'refunded once');
  assert.equal((await fan.get(`/api/coins/orders/${orderId}`)).body.order.status, 'refunded');
  const tx = (await fan.get('/api/coins/transactions')).body.transactions[0];
  assert.equal(tx.type, 'refunded');
  assert.equal(tx.coins, -100);
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

test('gifts: server prices, strict quantities, retried requests are never charged twice', async () => {
  const r0 = await fan.post('/api/live', { title: 'nope' });
  void r0;
  const { body } = await host.post('/api/live', { title: 'gift test' });
  const sid = body.stream && body.stream.id;
  assert.ok(sid, 'stream started');
  const before = (await fan.get('/api/coins')).body.wallet.coins;
  for (const count of [0, -5, 100, 2.5, 'x']) {
    const r = await fan.post(`/api/live/${sid}/gift`, { giftId: 'rose', count });
    assert.equal(r.status, 400, `count ${count} rejected`);
  }
  let r = await fan.post(`/api/live/${sid}/gift`, { giftId: 'rose', count: 1, coins: 0, price: 0 });
  assert.equal(r.body.sent.coins, 1, 'client-sent price is ignored');
  const ref = 'retry-test-0001';
  const a = await fan.post(`/api/live/${sid}/gift`, { giftId: 'donut', count: 2, clientRef: ref });
  const b = await fan.post(`/api/live/${sid}/gift`, { giftId: 'donut', count: 2, clientRef: ref });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal((await fan.get('/api/coins')).body.wallet.coins, before - 1 - 60, 'same request id charged once');
  r = await fan.post(`/api/live/${sid}/gift`, { giftId: 'galaxy', count: 99 });
  assert.equal(r.status, 400, 'not enough coins');
  assert.equal((await fan.get('/api/coins')).body.wallet.coins, before - 61, 'balance unchanged after a failed gift');
  await host.post(`/api/live/${sid}/end`);
  stripeMock.close();
  for (const k of ['STRIPE_API_BASE', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) delete process.env[k];
});

test('gift catalogue: original artwork exists, tiers match prices, displayed price is what is charged', async () => {
  const eco = require('../server/lib/economy');
  const ids = new Set();
  for (const g of eco.GIFTS) {
    assert.ok(!ids.has(g.id), `duplicate id ${g.id}`); ids.add(g.id);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', g.art)), `artwork for ${g.id}`);
    assert.ok(Number.isInteger(g.coins) && g.coins > 0);
    assert.equal(g.tier, g.coins <= 10 ? 1 : g.coins <= 199 ? 2 : g.coins <= 999 ? 3 : g.coins <= 4999 ? 4 : 5);
    assert.ok(['float', 'pop', 'burst', 'takeover', 'legendary'].includes(g.effect));
  }
  const shown = (await fan.get('/api/coins')).body.gifts;
  const host2 = client();
  await host2.post('/api/auth/register', { email: 'host2@t.dev', username: 'host2', password: 'Test-pass-91', birthDate: '1990-01-01', acceptTerms: true });
  q.run("UPDATE users SET is_verified = 1 WHERE username = 'host2'");
  const s = (await host2.post('/api/live', { title: 'price check' })).body.stream;
  const uid = id('fan1');
  q.run('UPDATE wallets SET coins = 50000 WHERE user_id = ?', uid);
  for (const g of shown.filter((x) => [1, 2, 3, 4].includes(x.tier)).slice(0, 6)) {
    const before = (await fan.get('/api/coins')).body.wallet.coins;
    const r = await fan.post(`/api/live/${s.id}/gift`, { giftId: g.id, count: 2 });
    assert.equal(r.status, 200, g.id);
    assert.equal(r.body.sent.coins, g.coins * 2);
    assert.equal((await fan.get('/api/coins')).body.wallet.coins, before - g.coins * 2, `charged exactly the shown price for ${g.id}`);
  }
  await host2.post(`/api/live/${s.id}/end`);
});
