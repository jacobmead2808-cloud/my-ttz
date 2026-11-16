'use strict';
// Stories: photos or short videos that disappear after 24 hours.
const express = require('express');
const config = require('../config');
const { q, now } = require('../db');
const v = require('../lib/validate');
const { bad, notFound, forbidden } = require('../lib/errors');
const { requireAuth } = require('../lib/auth');
const { limit } = require('../lib/rateLimit');
const access = require('../lib/access');
const automod = require('../lib/automod');
const { storyUpload, sniff, store, discard, removeStored } = require('../lib/uploads');
const { userBrief } = require('../lib/serialize');

const router = express.Router();
const DAY = 86400000;
const storyLimit = limit({ windowMs: DAY, max: 50, key: (req) => `story:${req.user.id}`, message: 'Daily story limit reached' });

function serializeStory(s, meId) {
  return {
    id: s.id,
    type: s.media_type,
    mediaUrl: `/media/st/${s.id}`,
    caption: s.caption,
    createdAt: s.created_at,
    expiresAt: s.expires_at,
    seen: !!s.seen,
    views: s.user_id === meId ? q.get('SELECT COUNT(*) AS n FROM story_views WHERE story_id = ?', s.id).n : undefined,
  };
}

/** Stories of `owner` that `viewer` may see. */
function storiesOf(owner, viewer) {
  if (!access.canViewProfile(viewer, owner)) return [];
  return q.all(`SELECT s.*, EXISTS (SELECT 1 FROM story_views sv WHERE sv.story_id = s.id AND sv.user_id = ?) AS seen
    FROM stories s WHERE s.user_id = ? AND s.expires_at > ? ORDER BY s.created_at ASC`, viewer ? viewer.id : 0, owner.id, now());
}

router.post('/', requireAuth, storyLimit, storyUpload, (req, res) => {
  const file = req.file;
  try {
    if (!file) throw bad('Choose a photo or video');
    const caption = v.str(req.body.caption, { name: 'Caption', max: 150 });
    if (caption) automod.assertAllowed(caption, { user: req.user, context: 'caption' });
    const info = sniff(file.path);
    if (!info) throw bad('Unsupported file type');
    if (info.kind === 'video' && file.size > 60 * 1024 * 1024) throw bad('Story videos can be at most 60 MB');
    const { name, mime } = store(file, info.kind, config.dirs.stories);
    const t = now();
    const r = q.run('INSERT INTO stories (user_id, media_file, media_type, mime, caption, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      req.user.id, name, info.kind, mime, caption, t, t + DAY);
    res.status(201).json({ story: serializeStory(q.get('SELECT * FROM stories WHERE id = ?', r.lastInsertRowid), req.user.id) });
  } catch (e) {
    discard(file);
    throw e;
  }
});

/** Story tray: you + accounts you follow that have active stories (unseen first). */
router.get('/feed', (req, res) => {
  const me = req.user;
  if (!me) return res.json({ users: [] });
  const owners = q.all(`SELECT DISTINCT u.* FROM stories s JOIN users u ON u.id = s.user_id
    WHERE s.expires_at > :now AND u.status = 'active' AND NOT ${access.blockedEither(':me', 'u.id')}
      AND (u.id = :me OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = :me AND f.followee_id = u.id AND f.status = 'accepted'))`,
  { now: now(), me: me.id });
  const users = owners.map((u) => {
    const stories = storiesOf(u, me).map((s) => serializeStory(s, me.id));
    return { user: userBrief(u), isSelf: u.id === me.id, stories, allSeen: stories.every((s) => s.seen), latest: stories.length ? stories[stories.length - 1].createdAt : 0 };
  }).filter((x) => x.stories.length);
  users.sort((a, b) => (b.isSelf - a.isSelf) || (a.allSeen - b.allSeen) || (b.latest - a.latest));
  res.json({ users });
});

router.get('/user/:username', (req, res) => {
  const u = q.get('SELECT * FROM users WHERE username = ?', String(req.params.username).toLowerCase());
  if (!u || u.status !== 'active') throw notFound('User not found');
  res.json({ user: userBrief(u), stories: storiesOf(u, req.user).map((s) => serializeStory(s, req.user ? req.user.id : 0)) });
});

function getStory(req) {
  const s = q.get('SELECT s.*, u.status AS ustatus, u.is_private FROM stories s JOIN users u ON u.id = s.user_id WHERE s.id = ?', v.int(req.params.id, 'story'));
  if (!s || s.expires_at <= now()) throw notFound('This story has expired');
  const owner = q.get('SELECT * FROM users WHERE id = ?', s.user_id);
  if (!access.canViewProfile(req.user, owner)) throw notFound('Story unavailable');
  return s;
}

router.post('/:id/view', requireAuth, (req, res) => {
  const s = getStory(req);
  if (s.user_id !== req.user.id) q.run('INSERT OR IGNORE INTO story_views (story_id, user_id, created_at) VALUES (?, ?, ?)', s.id, req.user.id, now());
  res.json({ ok: true });
});

router.get('/:id/viewers', requireAuth, (req, res) => {
  const s = getStory(req);
  if (s.user_id !== req.user.id) throw forbidden('Only the author can see viewers');
  const rows = q.all('SELECT u.*, sv.created_at AS seen_at FROM story_views sv JOIN users u ON u.id = sv.user_id WHERE sv.story_id = ? ORDER BY sv.created_at DESC', s.id);
  res.json({ viewers: rows.map((r) => ({ ...userBrief(r), seenAt: r.seen_at })) });
});

router.delete('/:id', requireAuth, (req, res) => {
  const s = q.get('SELECT * FROM stories WHERE id = ?', v.int(req.params.id, 'story'));
  if (!s) throw notFound('Story not found');
  if (s.user_id !== req.user.id && req.user.role !== 'admin') throw forbidden('You can only delete your own stories');
  q.run('DELETE FROM stories WHERE id = ?', s.id);
  removeStored(config.dirs.stories, s.media_file);
  res.json({ ok: true });
});

module.exports = router;
module.exports.getStoryForMedia = (req) => getStory(req);
