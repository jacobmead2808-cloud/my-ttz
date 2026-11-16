'use strict';
const express = require('express');
const { q, now } = require('../db');
const v = require('../lib/validate');
const { bad, notFound } = require('../lib/errors');
const { requireAuth } = require('../lib/auth');
const { limit } = require('../lib/rateLimit');
const { unreadCount } = require('../lib/notify');
const hub = require('../realtime/hub');
const settings = require('../lib/settings');
const automod = require('../lib/automod');

const router = express.Router();

const FILTERS = {
  all: null,
  likes: ['like', 'comment_like', 'repost'],
  comments: ['comment', 'reply', 'video_reply'],
  mentions: ['mention', 'duet', 'stitch'],
  followers: ['follow', 'follow_request', 'follow_accept'],
  live: ['live'],
};

router.get('/notifications', requireAuth, (req, res) => {
  const filter = FILTERS[req.query.filter] !== undefined ? req.query.filter : 'all';
  const types = FILTERS[filter];
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const typeSql = types ? `AND n.type IN (${types.map((t) => `'${t}'`).join(',')})` : '';
  const rows = q.all(`SELECT n.*, a.username, a.display_name, a.avatar_url, a.is_verified,
      v.thumb_file, v.updated_at AS v_updated, c.body AS comment_body,
      (SELECT status FROM follows f WHERE f.follower_id = n.user_id AND f.followee_id = n.actor_id) AS my_follow
    FROM notifications n LEFT JOIN users a ON a.id = n.actor_id LEFT JOIN videos v ON v.id = n.video_id LEFT JOIN comments c ON c.id = n.comment_id
    WHERE n.user_id = :me AND n.id < :before ${typeSql} AND (a.id IS NULL OR a.status = 'active')
    ORDER BY n.created_at DESC, n.id DESC LIMIT 40`, { me: req.user.id, before });
  res.json({
    notifications: rows.map((r) => ({
      id: r.id,
      type: r.type,
      read: !!r.is_read,
      createdAt: r.created_at,
      body: r.body || r.comment_body || null,
      videoId: r.video_id,
      commentId: r.comment_id,
      streamId: r.stream_id,
      thumbUrl: r.thumb_file ? `/media/t/${r.video_id}?t=${r.v_updated}` : null,
      actor: r.actor_id ? { id: r.actor_id, username: r.username, displayName: r.display_name || r.username, avatarUrl: r.avatar_url, verified: !!r.is_verified, followStatus: r.my_follow || null } : null,
    })),
    unread: unreadCount(req.user.id),
  });
});

router.post('/notifications/read', requireAuth, (req, res) => {
  q.run('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', req.user.id);
  hub.sendToUser(req.user.id, { type: 'notification', unread: 0 });
  res.json({ unread: 0 });
});

// ---------- Reports ----------
const REASONS = ['spam', 'harassment', 'hate', 'violence', 'nudity', 'self_harm', 'misinformation', 'impersonation', 'intellectual_property', 'minor_safety', 'other'];
const reportLimit = limit({ windowMs: 60 * 60 * 1000, max: 30, key: (req) => `rep:${req.user.id}`, message: 'You have sent many reports. Please try again later.' });

router.post('/reports', requireAuth, reportLimit, (req, res) => {
  const targetType = v.oneOf(req.body.targetType, ['user', 'video', 'comment', 'live'], 'Report type');
  const targetId = v.int(req.body.targetId, 'target');
  const reason = v.oneOf(req.body.reason, REASONS, 'Reason');
  const details = v.str(req.body.details, { name: 'Details', max: 1000 });
  const table = { user: 'users', video: 'videos', comment: 'comments', live: 'live_streams' }[targetType];
  if (!q.get(`SELECT 1 FROM ${table} WHERE id = ?`, targetId)) throw notFound('That content no longer exists');
  if (targetType === 'user' && targetId === req.user.id) throw bad('You cannot report yourself');
  const dup = q.get("SELECT 1 FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'open'", req.user.id, targetType, targetId);
  if (!dup) q.run('INSERT INTO reports (reporter_id, target_type, target_id, reason, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    req.user.id, targetType, targetId, reason, details, now());
  autoHide(targetType, targetId);
  const ownerOf = { user: () => targetId, video: () => (q.get('SELECT user_id FROM videos WHERE id = ?', targetId) || {}).user_id,
    comment: () => (q.get('SELECT user_id FROM comments WHERE id = ?', targetId) || {}).user_id, live: () => (q.get('SELECT user_id FROM live_streams WHERE id = ?', targetId) || {}).user_id };
  require('../lib/aiMod').observe(ownerOf[targetType](), 'report');
  res.status(201).json({ ok: true, message: 'Thanks for reporting. Our moderators will review it.' });
});

/** Auto-moderation: hide a video/comment once enough distinct users have reported it. */
function autoHide(type, id) {
  const cfg = settings.get('automod');
  if (!cfg.enabled || !cfg.autoHideReports || !['video', 'comment'].includes(type)) return;
  const n = q.get("SELECT COUNT(DISTINCT reporter_id) AS n FROM reports WHERE target_type = ? AND target_id = ? AND status = 'open'", type, id).n;
  if (n < cfg.autoHideReports) return;
  const table = type === 'video' ? 'videos' : 'comments';
  const row = q.get(`SELECT * FROM ${table} WHERE id = ? AND status = 'active'`, id);
  if (!row) return;
  if (type === 'video') q.run("UPDATE videos SET status = 'removed', removed_reason = ? WHERE id = ?", `Auto-hidden after ${n} reports (pending review)`, id);
  else q.run("UPDATE comments SET status = 'removed' WHERE id = ?", id);
  automod.log({ id: row.user_id }, type, type === 'video' ? row.caption : row.body, 'report_threshold', 'auto_hide', row.user_id);
}

router.get('/reports/reasons', (_req, res) => res.json({ reasons: REASONS }));

module.exports = router;
