'use strict';
const express = require('express');
const { q, tx, now } = require('../db');
const v = require('../lib/validate');
const { bad, notFound, forbidden } = require('../lib/errors');
const { requireAuth } = require('../lib/auth');
const { limit } = require('../lib/rateLimit');
const access = require('../lib/access');
const { notify, unnotify } = require('../lib/notify');
const { VIDEO_COLUMNS, VIDEO_FROM, serializeVideo, userBrief } = require('../lib/serialize');

const router = express.Router();
const followLimit = limit({ windowMs: 60 * 1000, max: 60, key: (req) => `follow:${req.user ? req.user.id : req.ip}` });

/** Load a user by username, hiding inactive accounts and accounts that blocked the viewer. */
function findUser(req, { allowBlockedByMe = true } = {}) {
  const u = q.get('SELECT * FROM users WHERE username = ?', String(req.params.username || '').toLowerCase());
  if (!u) throw notFound('User not found');
  const me = req.user;
  const isAdmin = me && me.role === 'admin';
  if (u.status !== 'active' && !isAdmin && !(me && me.id === u.id)) throw notFound('This account is unavailable');
  if (me && !isAdmin && q.get('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?', u.id, me.id)) throw notFound('User not found');
  if (!allowBlockedByMe && me && q.get('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?', me.id, u.id)) throw forbidden('You have blocked this user');
  return u;
}

function counts(userId) {
  return q.get(`SELECT
    (SELECT COUNT(*) FROM follows WHERE followee_id = :id AND status = 'accepted') AS followers,
    (SELECT COUNT(*) FROM follows WHERE follower_id = :id AND status = 'accepted') AS following,
    (SELECT COUNT(*) FROM likes l JOIN videos v ON v.id = l.video_id WHERE v.user_id = :id AND v.status = 'active') AS likes,
    (SELECT COUNT(*) FROM videos WHERE user_id = :id AND status = 'active') AS videos`, { id: userId });
}

router.get('/suggested', (req, res) => {
  const me = req.user ? req.user.id : 0;
  const rows = q.all(`SELECT u.*, (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id AND f.status = 'accepted') AS followers
    FROM users u WHERE ${access.VISIBLE_USER} AND u.id <> :me
      AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = :me AND f.followee_id = u.id)
    ORDER BY followers DESC, u.created_at DESC LIMIT :limit`, { me, limit: Math.min(Number(req.query.limit) || 10, 30) });
  res.json({ users: rows.map((r) => ({ ...userBrief(r), followers: r.followers })) });
});

router.get('/:username', (req, res) => {
  const u = findUser(req);
  const me = req.user;
  const canView = access.canViewProfile(me, u);
  const rel = me && me.id !== u.id ? {
    followStatus: access.followStatus(me.id, u.id),
    followsYou: access.isFollowing(u.id, me.id),
    blockedByYou: !!q.get('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?', me.id, u.id),
    canMessage: access.canMessage(me, u).ok,
  } : null;
  res.json({
    user: {
      ...userBrief(u),
      bio: u.bio,
      isPrivate: !!u.is_private,
      showLiked: !!u.show_liked,
      status: me && me.role === 'admin' ? u.status : undefined,
      createdAt: u.created_at,
      isSelf: !!me && me.id === u.id,
      canView,
      relationship: rel,
      stats: counts(u.id),
    },
  });
});

function listVideos(req, res, mode) {
  const u = findUser(req);
  const me = req.user;
  if (!access.canViewProfile(me, u)) return res.json({ videos: [], private: true });
  const limitN = Math.min(Number(req.query.limit) || 24, 60);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const params = { me: me ? me.id : 0, uid: u.id, limit: limitN + 1, offset };
  let sql;
  if (mode === 'videos') {
    const order = req.query.sort === 'popular' ? 'v.views DESC, v.created_at DESC'
      : req.query.sort === 'oldest' ? 'v.created_at ASC'
        : '(v.pinned_at IS NOT NULL) DESC, v.pinned_at DESC, v.created_at DESC';
    sql = `SELECT ${VIDEO_COLUMNS} ${VIDEO_FROM} WHERE v.user_id = :uid AND ${access.VISIBLE_VIDEO}
      ORDER BY ${order} LIMIT :limit OFFSET :offset`;
  } else if (mode === 'reposts') {
    sql = `SELECT ${VIDEO_COLUMNS}, rp9.created_at AS rp_at ${VIDEO_FROM} JOIN reposts rp9 ON rp9.video_id = v.id AND rp9.user_id = :uid
      WHERE ${access.VISIBLE_VIDEO} ORDER BY rp9.created_at DESC LIMIT :limit OFFSET :offset`;
  } else if (mode === 'liked') {
    if (!u.show_liked && !(me && (me.id === u.id || me.role === 'admin'))) return res.json({ videos: [], hidden: true });
    sql = `SELECT ${VIDEO_COLUMNS}, lk.created_at AS lk_at ${VIDEO_FROM} JOIN likes lk ON lk.video_id = v.id AND lk.user_id = :uid
      WHERE ${access.VISIBLE_VIDEO} ORDER BY lk.created_at DESC LIMIT :limit OFFSET :offset`;
  } else {
    if (!me || me.id !== u.id) throw forbidden('Saved videos are private');
    sql = `SELECT ${VIDEO_COLUMNS}, sv2.created_at AS sv_at ${VIDEO_FROM} JOIN saves sv2 ON sv2.video_id = v.id AND sv2.user_id = :uid
      WHERE ${access.VISIBLE_VIDEO} ORDER BY sv2.created_at DESC LIMIT :limit OFFSET :offset`;
  }
  const rows = q.all(sql, params);
  res.json({ videos: rows.slice(0, limitN).map((r) => serializeVideo(r, me)), hasMore: rows.length > limitN });
}

router.get('/:username/videos', (req, res) => listVideos(req, res, 'videos'));
router.get('/:username/liked', (req, res) => listVideos(req, res, 'liked'));
router.get('/:username/reposts', (req, res) => listVideos(req, res, 'reposts'));
router.get('/:username/saved', requireAuth, (req, res) => listVideos(req, res, 'saved'));

function listFollows(req, res, which) {
  const u = findUser(req);
  const me = req.user;
  if (!access.canViewProfile(me, u)) throw forbidden('This account is private');
  const limitN = Math.min(Number(req.query.limit) || 50, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const join = which === 'followers' ? 'f.follower_id = u.id AND f.followee_id = :uid' : 'f.followee_id = u.id AND f.follower_id = :uid';
  const rows = q.all(`SELECT u.*, (SELECT status FROM follows x WHERE x.follower_id = :me AND x.followee_id = u.id) AS my_status
    FROM follows f JOIN users u ON ${join}
    WHERE f.status = 'accepted' AND ${access.VISIBLE_USER} ORDER BY f.created_at DESC LIMIT :limit OFFSET :offset`,
  { uid: u.id, me: me ? me.id : 0, limit: limitN, offset });
  res.json({ users: rows.map((r) => ({ ...userBrief(r), bio: r.bio, followStatus: me && me.id === r.id ? 'self' : r.my_status || null })) });
}

router.get('/:username/followers', (req, res) => listFollows(req, res, 'followers'));
router.get('/:username/following', (req, res) => listFollows(req, res, 'following'));

router.post('/:username/follow', requireAuth, followLimit, (req, res) => {
  const u = findUser(req, { allowBlockedByMe: false });
  const me = req.user;
  if (u.id === me.id) throw bad('You cannot follow yourself');
  const existing = access.followStatus(me.id, u.id);
  if (existing) return res.json({ followStatus: existing });
  const status = u.is_private ? 'pending' : 'accepted';
  q.run('INSERT INTO follows (follower_id, followee_id, status, created_at) VALUES (?, ?, ?, ?)', me.id, u.id, status, now());
  notify({ userId: u.id, actorId: me.id, type: status === 'pending' ? 'follow_request' : 'follow' });
  if (status === 'accepted') require('../realtime/live').onFollow(u.id, me);
  require('../lib/aiMod').observe(me.id, 'follow');
  res.json({ followStatus: status, stats: counts(u.id) });
});

router.delete('/:username/follow', requireAuth, (req, res) => {
  const u = findUser(req);
  const me = req.user;
  q.run('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?', me.id, u.id);
  unnotify({ userId: u.id, actorId: me.id, type: 'follow' });
  unnotify({ userId: u.id, actorId: me.id, type: 'follow_request' });
  res.json({ followStatus: null, stats: counts(u.id) });
});

/** Remove someone from your followers. */
router.delete('/:username/follower', requireAuth, (req, res) => {
  const u = findUser(req);
  q.run('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?', u.id, req.user.id);
  res.json({ ok: true });
});

router.post('/:username/block', requireAuth, (req, res) => {
  const u = findUser(req);
  const me = req.user;
  if (u.id === me.id) throw bad('You cannot block yourself');
  if (u.role === 'admin') throw bad('Administrators cannot be blocked');
  tx(() => {
    q.run('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)', me.id, u.id, now());
    q.run('DELETE FROM follows WHERE (follower_id = ? AND followee_id = ?) OR (follower_id = ? AND followee_id = ?)', me.id, u.id, u.id, me.id);
    q.run('DELETE FROM notifications WHERE (user_id = ? AND actor_id = ?) OR (user_id = ? AND actor_id = ?)', me.id, u.id, u.id, me.id);
  });
  res.json({ blocked: true });
});

router.delete('/:username/block', requireAuth, (req, res) => {
  const u = q.get('SELECT id FROM users WHERE username = ?', String(req.params.username).toLowerCase());
  if (!u) throw notFound('User not found');
  q.run('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', req.user.id, u.id);
  res.json({ blocked: false });
});

module.exports = router;
module.exports.counts = counts;
