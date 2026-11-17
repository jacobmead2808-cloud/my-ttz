'use strict';
/**
 * Coins: wallet, recharge through Stripe Checkout, diamonds → coins exchange, and gift galleries.
 *
 * Coins are only ever credited from a Stripe webhook whose signature verifies, for an order this
 * server created, with the amount and currency Stripe actually charged. Nothing the browser says
 * (success URLs, query strings, request bodies) can credit coins. Without STRIPE_SECRET_KEY and
 * STRIPE_WEBHOOK_SECRET, buying coins is switched off; there is no demo or test-credit mode.
 */
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { q, tx, now } = require('../db');
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
const STRIPE_API = () => (process.env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/$/, '');

/** 'stripe' when Stripe is fully configured, otherwise 'disabled'. */
function paymentMode() {
  return process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET ? 'stripe' : 'disabled';
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

/** Mark an order paid and add its coins — exactly once, even if Stripe retries or events race. */
function credit(order, paymentIntent) {
  const w = tx(() => {
    const r = q.run("UPDATE coin_orders SET status = 'paid', paid_at = ?, payment_intent = COALESCE(?, payment_intent) WHERE id = ? AND status IN ('pending', 'processing')",
      now(), paymentIntent || null, order.id);
    if (r.changes !== 1) return null; // already credited, refunded or failed
    return eco.adjust(order.user_id, { coins: order.coins, type: 'purchase', ref: `order:${order.id}` });
  });
  if (w) hub.sendToUser(order.user_id, { type: 'wallet', wallet: w });
  return w;
}

/**
 * Take coins back for a refunded or disputed order. Coins already spent can't be recovered, so the
 * balance is reduced as far as possible and the shortfall is recorded for staff.
 */
function reverse(order, reason) {
  const out = tx(() => {
    const r = q.run("UPDATE coin_orders SET status = ?, refunded_at = ? WHERE id = ? AND status = 'paid'", reason, now(), order.id);
    if (r.changes !== 1) return null;
    const w = eco.wallet(order.user_id);
    const take = Math.min(w.coins, order.coins);
    const shortfall = order.coins - take;
    const wallet = take ? eco.adjust(order.user_id, { coins: -take, type: reason, ref: `order:${order.id}`, note: shortfall ? `${shortfall} coins already spent` : null }) : w;
    if (shortfall) q.run('UPDATE coin_orders SET failure_reason = ? WHERE id = ?', `${shortfall} coins already spent when ${reason}`, order.id);
    return { wallet, shortfall };
  });
  if (out) {
    hub.sendToUser(order.user_id, { type: 'wallet', wallet: out.wallet });
    if (out.shortfall) console.warn(`[coins] order ${order.id} ${reason}: ${out.shortfall} coins had already been spent (user ${order.user_id})`);
  }
  return out;
}

router.post('/checkout', requireAuth, require('../lib/accounts').requireVerified, buyLimit, async (req, res) => {
  require('../lib/accounts').requireAdult(req.user, 'buy coins');
  if (paymentMode() !== 'stripe') throw new HttpError(503, 'Buying coins isn’t available yet. Please check back soon.');
  const coins = v.int(req.body.coins, 'coin amount');
  if (coins < 30 || coins > 250000) throw bad('Choose between 30 and 250,000 coins');
  const pkg = eco.packages().find((p) => p.coins === coins);
  const priceCents = pkg ? pkg.priceCents : eco.priceFor(coins);
  const cfg = eco.economy();
  const r = q.run("INSERT INTO coin_orders (user_id, coins, price_cents, currency, provider, status, created_at) VALUES (?, ?, ?, ?, 'stripe', 'pending', ?)",
    req.user.id, coins, priceCents, cfg.currency, now());
  const orderId = Number(r.lastInsertRowid);
  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': cfg.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(priceCents),
    'line_items[0][price_data][product_data][name]': `${coins.toLocaleString('en-GB')} ${config.appName} coins`,
    success_url: `${config.baseUrl}/coins?order=${orderId}`,
    cancel_url: `${config.baseUrl}/coins?cancelled=${orderId}`,
    client_reference_id: String(orderId),
    'metadata[order_id]': String(orderId),
    'metadata[user_id]': String(req.user.id),
    'payment_intent_data[metadata][order_id]': String(orderId),
  });
  let resp;
  let data = {};
  try {
    resp = await fetch(`${STRIPE_API()}/v1/checkout/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `clipzy-order-${orderId}` },
      body: form,
      signal: AbortSignal.timeout(15000),
    });
    data = await resp.json().catch(() => ({}));
  } catch (e) {
    q.run("UPDATE coin_orders SET status = 'failed', failure_reason = ? WHERE id = ?", 'Could not reach the payment provider', orderId);
    console.error('[coins] Stripe unreachable:', e.message);
    throw new HttpError(502, 'The payment service is unavailable right now. You have not been charged. Please try again.');
  }
  if (!resp.ok || !data.id || !data.url) {
    q.run("UPDATE coin_orders SET status = 'failed', failure_reason = ? WHERE id = ?", String((data.error && data.error.message) || resp.status).slice(0, 200), orderId);
    console.error('[coins] Stripe checkout error:', resp.status, data.error && data.error.message);
    throw new HttpError(502, 'The payment couldn’t be started. You have not been charged. Please try again.');
  }
  q.run('UPDATE coin_orders SET provider_ref = ? WHERE id = ?', data.id, orderId);
  res.json({ url: data.url, orderId });
});

router.get('/orders/:id', requireAuth, (req, res) => {
  const o = q.get('SELECT * FROM coin_orders WHERE id = ? AND user_id = ?', v.int(req.params.id, 'order'), req.user.id);
  if (!o) throw notFound('Order not found');
  res.json({ order: { id: o.id, coins: o.coins, status: o.status, priceCents: o.price_cents, currency: o.currency }, wallet: eco.wallet(req.user.id) });
});

/** The buyer closed Stripe's page without paying. */
router.post('/orders/:id/cancel', requireAuth, (req, res) => {
  q.run("UPDATE coin_orders SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'", v.int(req.params.id, 'order'), req.user.id);
  res.json({ ok: true });
});

/** Turn LIVE rewards (diamonds) into coins, 1:1. */
router.post('/exchange', requireAuth, (req, res) => {
  const diamonds = v.int(req.body.diamonds, 'diamond amount');
  const wallet = tx(() => {
    eco.adjust(req.user.id, { diamonds: -diamonds, type: 'exchange', note: 'Diamonds → coins' });
    return eco.adjust(req.user.id, { coins: diamonds, type: 'exchange', note: 'Diamonds → coins' });
  });
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

/** Verify a Stripe-Signature header (any v1 signature may match; 5-minute tolerance). */
function verifyStripeSignature(header, payload, secret) {
  const items = String(header || '').split(',').map((kv) => kv.split('='));
  const t = Number((items.find(([k]) => k === 't') || [])[1]);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex'));
  return items.filter(([k]) => k === 'v1').some(([, sig]) => sig && sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), expected));
}

const orderForSession = (s) => q.get('SELECT * FROM coin_orders WHERE id = ? AND provider_ref = ?', Number(s.metadata && s.metadata.order_id), s.id);
const orderForPayment = (pi) => pi && q.get('SELECT * FROM coin_orders WHERE payment_intent = ?', pi);

/** Stripe webhook (mounted with a raw body parser in index.js). */
function stripeWebhook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(503).send('Webhook not configured');
  const payload = req.body instanceof Buffer ? req.body.toString('utf8') : '';
  if (!verifyStripeSignature(req.get('stripe-signature'), payload, secret)) {
    require('../lib/security').record('webhook.forged', req, 'Stripe signature did not verify');
    return res.status(400).send('Bad signature');
  }
  let event;
  try { event = JSON.parse(payload); } catch { return res.status(400).send('Bad payload'); }
  if (!event.id || !event.type) return res.status(400).send('Bad payload');
  // Each event is processed once, however many times Stripe delivers it.
  if (q.run('INSERT OR IGNORE INTO stripe_events (id, type, created_at) VALUES (?, ?, ?)', event.id, event.type, now()).changes === 0) return res.json({ received: true, duplicate: true });

  const obj = (event.data && event.data.object) || {};
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const order = orderForSession(obj);
      if (!order) break;
      if (obj.payment_status !== 'paid') { q.run("UPDATE coin_orders SET status = 'processing', payment_intent = ? WHERE id = ? AND status = 'pending'", obj.payment_intent || null, order.id); break; }
      if (Number(obj.amount_total) !== order.price_cents || String(obj.currency).toUpperCase() !== order.currency.toUpperCase()) {
        q.run("UPDATE coin_orders SET status = 'failed', failure_reason = ? WHERE id = ?", `Amount mismatch: charged ${obj.amount_total} ${obj.currency}`, order.id);
        console.error(`[security] Stripe order ${order.id} amount mismatch (${obj.amount_total} ${obj.currency} vs ${order.price_cents} ${order.currency}); not credited`);
        break;
      }
      credit(order, obj.payment_intent);
      break;
    }
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired': {
      const order = orderForSession(obj);
      if (order) q.run("UPDATE coin_orders SET status = ?, failure_reason = ? WHERE id = ? AND status IN ('pending', 'processing')",
        event.type.endsWith('expired') ? 'expired' : 'failed', event.type.endsWith('expired') ? 'Checkout expired' : 'Payment failed', order.id);
      break;
    }
    case 'charge.refunded': {
      const order = orderForPayment(obj.payment_intent);
      if (order && obj.refunded) reverse(order, 'refunded');
      break;
    }
    case 'charge.dispute.created': {
      const order = orderForPayment(obj.payment_intent);
      if (order) reverse(order, 'disputed');
      break;
    }
    default: break;
  }
  res.json({ received: true });
}

module.exports = router;
module.exports.stripeWebhook = stripeWebhook;
module.exports.paymentMode = paymentMode;
