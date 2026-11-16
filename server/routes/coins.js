'use strict';
/**
 * Coins: wallet, recharge (Stripe Checkout when configured, demo credits in development),
 * transactions, diamonds → coins exchange, and gift galleries.
 *
 * Real payments need STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET (see README). Without them,
 * development builds credit coins instantly as clearly-labelled demo purchases.
 */
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { q, now } = require('../db');
const v = require('../lib/validate');
const { bad, notFound, HttpError } = require('../lib/errors');
const { requireAuth } = require('../lib/auth');
const { limit } = require('../lib/rateLimit');
const access = require('../lib/access');
const eco = require('../lib/economy');
const { userBrief } = require('../lib/serialize');
const hub = require('../realtime/hub');

const router = express.Router();
const buyLimit = limit({ windowMs: 60 * 60 * 1000, max: 30, key: (req) => `buy:${req.user.id}` });

function paymentMode() {
  if (process.env.STRIPE_SECRET_KEY) return 'stripe';
  if (process.env.COINS_DEMO_MODE === 'false' || (config.isProd && process.env.COINS_DEMO_MODE !== 'true')) return 'disabled';
  return 'demo';
}

router.get('/', (req, res) => {
  const cfg = eco.economy();
  res.json({
    wallet: req.user ? eco.wallet(req.user.id) : null,
    packages: eco.packages(),
    currency: cfg.currency,
    centsPerCoin: cfg.centsPerCoin,
    discount: cfg.discountPercent ? { percent: cfg.discountPercent, label: cfg.discountLabel } : null,
    gifts: eco.catalog(),
    paymentMode: paymentMode(),
  });
});

router.get('/transactions', requireAuth, (req, res) => {
  const rows = q.all('SELECT * FROM coin_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 60', req.user.id);
  res.json({ wallet: eco.wallet(req.user.id), transactions: rows.map((t) => ({ id: t.id, type: t.type, coins: t.coins, diamonds: t.diamonds, ref: t.ref, note: t.note, createdAt: t.created_at })) });
});

function credit(order) {
  if (order.status === 'paid') return;
  q.run("UPDATE coin_orders SET status = 'paid', paid_at = ? WHERE id = ? AND status <> 'paid'", now(), order.id);
  const w = eco.adjust(order.user_id, { coins: order.coins, type: 'purchase', ref: `order:${order.id}`, note: order.provider === 'demo' ? 'Demo purchase (no real money)' : null });
  hub.sendToUser(order.user_id, { type: 'wallet', wallet: w });
  return w;
}

router.post('/checkout', requireAuth, buyLimit, async (req, res) => {
  const coins = v.int(req.body.coins, 'coin amount');
  if (coins < 30 || coins > 250000) throw bad('Choose between 30 and 250,000 coins');
  const pkg = eco.packages().find((p) => p.coins === coins);
  const priceCents = pkg ? pkg.priceCents : eco.priceFor(coins);
  const cfg = eco.economy();
  const mode = paymentMode();
  if (mode === 'disabled') throw new HttpError(503, 'Coin purchases are not configured on this server yet.');
  const r = q.run('INSERT INTO coin_orders (user_id, coins, price_cents, currency, provider, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    req.user.id, coins, priceCents, cfg.currency, mode, now());
  const orderId = Number(r.lastInsertRowid);
  if (mode === 'demo') {
    const wallet = credit(q.get('SELECT * FROM coin_orders WHERE id = ?', orderId));
    return res.json({ demo: true, orderId, wallet, message: `${coins} demo coins added — no real money was charged.` });
  }
  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': cfg.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(priceCents),
    'line_items[0][price_data][product_data][name]': `${coins.toLocaleString()} ${config.appName} coins`,
    success_url: `${config.baseUrl}/coins?order=${orderId}`,
    cancel_url: `${config.baseUrl}/coins?cancelled=1`,
    client_reference_id: String(orderId),
    'metadata[order_id]': String(orderId),
    'metadata[user_id]': String(req.user.id),
  });
  const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    q.run("UPDATE coin_orders SET status = 'failed' WHERE id = ?", orderId);
    throw new HttpError(502, `Payment provider error: ${(data.error && data.error.message) || resp.status}`);
  }
  q.run('UPDATE coin_orders SET provider_ref = ? WHERE id = ?', data.id, orderId);
  res.json({ url: data.url, orderId });
});

router.get('/orders/:id', requireAuth, (req, res) => {
  const o = q.get('SELECT * FROM coin_orders WHERE id = ? AND user_id = ?', v.int(req.params.id, 'order'), req.user.id);
  if (!o) throw notFound('Order not found');
  res.json({ order: { id: o.id, coins: o.coins, status: o.status, priceCents: o.price_cents, currency: o.currency }, wallet: eco.wallet(req.user.id) });
});

/** Turn LIVE rewards (diamonds) into coins, 1:1. */
router.post('/exchange', requireAuth, (req, res) => {
  const diamonds = v.int(req.body.diamonds, 'diamond amount');
  eco.adjust(req.user.id, { diamonds: -diamonds, type: 'exchange', note: 'Diamonds → coins' });
  const wallet = eco.adjust(req.user.id, { coins: diamonds, type: 'exchange', note: 'Diamonds → coins' });
  res.json({ wallet });
});

/** Public gift gallery: which gifts a creator has received and their top supporters. */
router.get('/gallery/:username', (req, res) => {
  const u = q.get('SELECT * FROM users WHERE username = ?', String(req.params.username).toLowerCase());
  if (!u || u.status !== 'active' || (req.user && access.isBlocked(req.user.id, u.id))) throw notFound('User not found');
  const received = Object.fromEntries(q.all('SELECT gift_id, SUM(count) AS n FROM gift_events WHERE receiver_id = ? GROUP BY gift_id', u.id).map((r) => [r.gift_id, r.n]));
  const supporters = q.all(`SELECT s.*, SUM(g.coins) AS coins FROM gift_events g JOIN users s ON s.id = g.sender_id WHERE g.receiver_id = ?
    GROUP BY s.id ORDER BY coins DESC LIMIT 10`, u.id).map((r) => ({ ...userBrief(r), coins: r.coins }));
  res.json({
    user: userBrief(u),
    gifts: eco.catalog().map((g) => ({ ...g, received: received[g.id] || 0 })),
    collected: Object.keys(received).length,
    total: eco.GIFTS.length,
    supporters,
  });
});

/** Stripe webhook (mounted with a raw body parser in index.js). */
function stripeWebhook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(503).send('Webhook not configured');
  const sig = String(req.get('stripe-signature') || '');
  const parts = Object.fromEntries(sig.split(',').map((kv) => kv.split('=')));
  const payload = req.body instanceof Buffer ? req.body.toString('utf8') : '';
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${payload}`).digest('hex');
  const ok = parts.v1 && parts.v1.length === expected.length && crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
  if (!ok || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return res.status(400).send('Bad signature');
  let event;
  try { event = JSON.parse(payload); } catch { return res.status(400).send('Bad payload'); }
  if (event.type === 'checkout.session.completed' && event.data && event.data.object && event.data.object.payment_status === 'paid') {
    const orderId = Number(event.data.object.metadata && event.data.object.metadata.order_id);
    const order = q.get('SELECT * FROM coin_orders WHERE id = ? AND provider_ref = ?', orderId, event.data.object.id);
    if (order) credit(order);
  }
  res.json({ received: true });
}

module.exports = router;
module.exports.stripeWebhook = stripeWebhook;
module.exports.paymentMode = paymentMode;
