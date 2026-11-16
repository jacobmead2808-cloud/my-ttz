'use strict';
const express = require('express');
const config = require('../config');
const { q, now } = require('../db');
const v = require('../lib/validate');
const { bad, notFound, forbidden } = require('../lib/errors');
const { requireAuth } = require('../lib/auth');
const { limit } = require('../lib/rateLimit');
const access = require('../lib/access');
const { imageUpload, store, removeStored, discard } = require('../lib/uploads');
const { notify } = require('../lib/notify');
const liveRt = require('../realtime/live');
const { serializeLive, liveList } = require('./discover');
const automod = require('../lib/automod');
const eco = require('../lib/economy');
const { eligibility } = require('../lib/liveRules');

const GOAL_TYPES = ['likes', 'gifts', 'followers'];
function parseGoal(g) {
  if (!g || !g.type) return null;
  if (!GOAL_TYPES.includes(g.type)) throw bad('Unknown goal type');
  const target = v.int(g.target, 'goal target');
  if (target > 10000000) throw bad('Goal is too big');
  return { type: g.type, target, label: v.str(g.label, { name: 'Goal label', max: 40 }) };
}

const router = express.Router();
const startLimit = limit({ windowMs: 60 * 60 * 1000, max: 20, key: (req) => `live:${req.user.id}`, message: 'You have started too many LIVEs recently' });

function getStream(id) {
  return q.get(`SELECT ls.*, u.username, u.display_name, u.avatar_url, u.is_verified, u.is_private, u.status AS ustatus
    FROM live_streams ls JOIN users u ON u.id = ls.user_id WHERE ls.id = ?`, id);
}

function canWatch(viewer, s) {
  if (viewer && (viewer.id === s.user_id || viewer.role === 'admin')) return true;
  if (s.ustatus !== 'active') return false;
  if (viewer && access.isBlocked(viewer.id, s.user_id)) return false;
  if (!s.is_private) return true;
  return !!viewer && access.isFollowing(viewer.id, s.user_id);
}

router.get('/', (req, res) => {
  res.json({ streams: liveList(req.user ? req.user.id : 0, 60) });
});

router.get('/config', (_req, res) => res.json({ iceServers: config.iceServers }));

router.get('/eligibility', requireAuth, (req, res) => {
  res.json(eligibility(req.user));
});

router.get('/mine', requireAuth, (req, res) => {
  const s = q.get("SELECT id FROM live_streams WHERE user_id = ? AND status = 'live'", req.user.id);
  const past = q.all('SELECT * FROM live_streams WHERE user_id = ? ORDER BY started_at DESC LIMIT 10', req.user.id);
  res.json({ activeId: s ? s.id : null, history: past.map((p) => serializeLive({ ...p, username: req.user.username, display_name: req.user.display_name, avatar_url: req.user.avatar_url })) });
});

router.post('/', requireAuth, startLimit, (req, res) => {
  const me = req.user;
  if (!liveRt.liveAllowed() && me.role !== 'admin') throw forbidden('LIVE is temporarily disabled by the platform owner');
  if (me.live_banned) throw forbidden('Your LIVE access has been restricted by a moderator');
  automod.assertAllowed(String(req.body.title || ''), { user: me, context: 'caption' });
  const elig = eligibility(me);
  let isTrial = 0;
  if (!elig.eligible) {
    if (v.bool(req.body.trial) && elig.trial.available) isTrial = 1;
    else throw forbidden(elig.trial.available
      ? 'You can start a trial LIVE — accounts with 500+ followers, verification or good standing can go LIVE anytime.'
      : `You can’t go LIVE yet: you need 500+ followers, a verified account, or good standing. ${elig.trial.reason || ''}`.trim());
  }
  const goal = parseGoal(req.body.goal);
  const title = v.str(req.body.title, { name: 'Title', max: 80 }) || `${me.display_name || me.username}'s LIVE`;
  // One live stream per user: end any leftover one.
  for (const old of q.all("SELECT id FROM live_streams WHERE user_id = ? AND status = 'live'", me.id)) liveRt.endStream(old.id, 'replaced');
  const r = q.run('INSERT INTO live_streams (user_id, title, started_at, is_trial, goal_type, goal_target, goal_label) VALUES (?, ?, ?, ?, ?, ?, ?)',
    me.id, title, now(), isTrial, goal ? goal.type : null, goal ? goal.target : null, goal ? goal.label : null);
  const id = Number(r.lastInsertRowid);
  const followers = q.all("SELECT follower_id FROM follows WHERE followee_id = ? AND status = 'accepted' LIMIT 5000", me.id);
  for (const f of followers) notify({ userId: f.follower_id, actorId: me.id, type: 'live', streamId: id, body: title });
  res.status(201).json({ stream: { ...serializeLive(getStream(id)), isTrial: !!isTrial, trialEndsAt: isTrial ? now() + eligibility(me).trial.minutes * 60000 : null } });
});

router.get('/:id', (req, res) => {
  const s = getStream(v.int(req.params.id, 'stream'));
  if (!s || !canWatch(req.user, s)) throw notFound('This LIVE is unavailable');
  const isHost = !!req.user && req.user.id === s.user_id;
  const isMod = !!req.user && !!q.get('SELECT 1 FROM live_moderators WHERE host_id = ? AND mod_id = ?', s.user_id, req.user.id);
  res.json({
    role: isHost ? 'host' : isMod ? 'mod' : req.user && req.user.role === 'admin' ? 'admin' : 'viewer',
    gifts: eco.catalog().filter((g) => g.enabled),
    leaders: eco.topGifters(s.id),
    slowOptions: liveRt.SLOW_OPTIONS,
    stream: {
      ...serializeLive(s),
      isHost,
      followStatus: req.user && !isHost ? access.followStatus(req.user.id, s.user_id) : null,
    },
    reactions: liveRt.REACTIONS,
  });
});

router.get('/:id/chat', (req, res) => {
  const s = getStream(v.int(req.params.id, 'stream'));
  if (!s || !canWatch(req.user, s)) throw notFound('This LIVE is unavailable');
  const rows = q.all(`SELECT m.*, u.username, u.display_name, u.avatar_url FROM live_messages m JOIN users u ON u.id = m.user_id
    WHERE m.stream_id = ? AND m.deleted = 0 ORDER BY m.id DESC LIMIT 50`, s.id).reverse();
  const mods = new Set(q.all('SELECT mod_id FROM live_moderators WHERE host_id = ?', s.user_id).map((r) => r.mod_id));
  res.json({ messages: rows.map((m) => ({ id: m.id, text: m.body, createdAt: m.created_at,
    user: { id: m.user_id, username: m.username, displayName: m.display_name, avatarUrl: m.avatar_url, role: m.user_id === s.user_id ? 'host' : mods.has(m.user_id) ? 'mod' : 'viewer' } })) });
});

/** Host updates the title or goal while LIVE. */
router.patch('/:id', requireAuth, (req, res) => {
  const s = getStream(v.int(req.params.id, 'stream'));
  if (!s || s.user_id !== req.user.id || s.status !== 'live') throw forbidden('Not your active stream');
  if (req.body.goal !== undefined) {
    const goal = parseGoal(req.body.goal);
    q.run('UPDATE live_streams SET goal_type = ?, goal_target = ?, goal_label = ? WHERE id = ?', goal ? goal.type : null, goal ? goal.target : null, goal ? goal.label : null, s.id);
    liveRt.setGoal(s.id, goal);
  }
  if (req.body.title !== undefined) {
    const title = v.str(req.body.title, { name: 'Title', max: 80 });
    automod.assertAllowed(title, { user: req.user, context: 'caption' });
    q.run('UPDATE live_streams SET title = ? WHERE id = ?', title, s.id);
  }
  res.json({ stream: serializeLive(getStream(s.id)) });
});

const giftLimit = limit({ windowMs: 10000, max: 30, key: (req) => `gift:${req.user.id}` });
router.post('/:id/gift', requireAuth, giftLimit, (req, res) => {
  const s = getStream(v.int(req.params.id, 'stream'));
  if (!s || s.status !== 'live' || !canWatch(req.user, s)) throw notFound('This LIVE has ended');
  const out = eco.sendGift({ senderId: req.user.id, receiverId: s.user_id, giftId: String(req.body.giftId || ''), count: req.body.count, streamId: s.id });
  const leaders = eco.topGifters(s.id);
  liveRt.onGift(s.id, { sender: req.user, gift: out.gift, count: out.count, coins: out.totalCoins, leaders });
  res.json({ wallet: out.senderWallet, sent: { giftId: out.gift.id, count: out.count, coins: out.totalCoins } });
});

router.get('/:id/leaders', (req, res) => {
  res.json({ leaders: eco.topGifters(v.int(req.params.id, 'stream'), 10) });
});

router.post('/:id/end', requireAuth, (req, res) => {
  const s = getStream(v.int(req.params.id, 'stream'));
  if (!s) throw notFound('Stream not found');
  if (s.user_id !== req.user.id && req.user.role !== 'admin') throw forbidden('Only the host or an administrator can end this LIVE');
  if (s.status === 'live') {
    liveRt.endStream(s.id, s.user_id === req.user.id ? 'ended' : 'ended_by_admin');
    if (s.user_id !== req.user.id)
      q.run('INSERT INTO audit_log (admin_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?)', req.user.id, 'live.end', 'live', s.id, now());
  }
  res.json({ stream: serializeLive(getStream(s.id)) });
});

/** Host uploads a periodic still frame used as the LIVE preview on discovery pages. */
router.post('/:id/preview', requireAuth, imageUpload('preview'), (req, res) => {
  const s = getStream(v.int(req.params.id, 'stream'));
  if (!s || s.user_id !== req.user.id || s.status !== 'live') { discard(req.file); throw forbidden('Not your active stream'); }
  if (!req.file) throw bad('Missing image');
  const { name } = store(req.file, 'image', config.dirs.live);
  q.run('UPDATE live_streams SET preview_file = ? WHERE id = ?', name, s.id);
  removeStored(config.dirs.live, s.preview_file);
  res.json({ previewUrl: `/media/l/${name}` });
});

module.exports = router;
