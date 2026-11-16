'use strict';
// Register / remove this device for push notifications.
const express = require('express');
const v = require('../lib/validate');
const { bad } = require('../lib/errors');
const { requireAuth } = require('../lib/auth');
const { limit } = require('../lib/rateLimit');
const push = require('../lib/push');

const router = express.Router();
const subLimit = limit({ windowMs: 60 * 60 * 1000, max: 30, key: (req) => `push:${req.user.id}`, message: 'Too many requests' });

router.get('/config', (_req, res) => res.json(push.publicConfig()));

router.post('/subscribe', requireAuth, subLimit, (req, res) => {
  const type = v.oneOf(req.body.type, ['web', 'fcm'], 'Push type');
  const ua = String(req.get('user-agent') || '').slice(0, 200);
  if (type === 'web') {
    const s = req.body.subscription || {};
    const endpoint = v.str(s.endpoint, { name: 'Endpoint', required: true, max: 1000 });
    let u;
    try { u = new URL(endpoint); } catch { throw bad('Invalid push endpoint'); }
    if (u.protocol !== 'https:') throw bad('Invalid push endpoint');
    const p256dh = v.str(s.keys && s.keys.p256dh, { name: 'Key', required: true, max: 200 });
    const auth = v.str(s.keys && s.keys.auth, { name: 'Key', required: true, max: 100 });
    if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16) throw bad('Invalid push keys');
    push.subscribe(req.user.id, { type, endpoint, p256dh, auth, userAgent: ua });
  } else {
    const token = v.str(req.body.token, { name: 'Token', required: true, max: 4096 });
    push.subscribe(req.user.id, { type, endpoint: token, userAgent: ua });
  }
  res.json({ ok: true });
});

router.post('/unsubscribe', requireAuth, (req, res) => {
  const endpoint = v.str(req.body.endpoint || req.body.token, { name: 'Endpoint', required: true, max: 4096 });
  res.json({ ok: true, removed: push.unsubscribe(req.user.id, endpoint) });
});

/** Sends a test notification to all of your own devices. */
router.post('/test', requireAuth, subLimit, async (req, res) => {
  const results = await push.sendToUser(req.user.id, { title: 'Clipzy', body: 'Push notifications are working.', url: '/inbox', tag: 'test' });
  res.json({ devices: results.length, delivered: results.filter((r) => r === 'ok').length });
});

module.exports = router;
