'use strict';
// Personal library: drafts & scheduled posts, and favourites collections.
const express = require('express');
const { q, now } = require('../db');
const v = require('../lib/validate');
const { bad, notFound } = require('../lib/errors');
const { requireAuth } = require('../lib/auth');
const access = require('../lib/access');
const { VIDEO_COLUMNS, VIDEO_FROM, serializeVideo, getVideoRow } = require('../lib/serialize');

const router = express.Router();
router.use(requireAuth);

router.get('/drafts', (req, res) => {
  const rows = q.all(`SELECT ${VIDEO_COLUMNS} ${VIDEO_FROM} WHERE v.user_id = :me AND v.status = 'active' AND (v.is_draft = 1 OR v.publish_at IS NOT NULL)
    ORDER BY COALESCE(v.publish_at, v.updated_at) DESC`, { me: req.user.id });
  res.json({ videos: rows.map((r) => serializeVideo(r, req.user)) });
});

function ownCollection(req) {
  const c = q.get('SELECT * FROM collections WHERE id = ? AND user_id = ?', v.int(req.params.id, 'collection'), req.user.id);
  if (!c) throw notFound('Collection not found');
  return c;
}

router.get('/collections', (req, res) => {
  const rows = q.all(`SELECT c.*, (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id) AS n,
      (SELECT ci.video_id FROM collection_items ci WHERE ci.collection_id = c.id ORDER BY ci.created_at DESC LIMIT 1) AS cover_id
    FROM collections c WHERE c.user_id = ? ORDER BY c.created_at DESC`, req.user.id);
  const saved = q.get('SELECT COUNT(*) AS n FROM saves WHERE user_id = ?', req.user.id).n;
  res.json({
    favorites: saved,
    collections: rows.map((c) => ({ id: c.id, name: c.name, count: c.n, coverUrl: c.cover_id ? `/media/t/${c.cover_id}` : null, createdAt: c.created_at })),
  });
});

router.post('/collections', (req, res) => {
  const name = v.str(req.body.name, { name: 'Name', required: true, max: 40 });
  if (q.get('SELECT COUNT(*) AS n FROM collections WHERE user_id = ?', req.user.id).n >= 50) throw bad('You can have up to 50 collections');
  const r = q.run('INSERT INTO collections (user_id, name, created_at) VALUES (?, ?, ?)', req.user.id, name, now());
  const id = Number(r.lastInsertRowid);
  if (req.body.videoId) addToCollection(req, id, v.int(req.body.videoId, 'video'));
  res.status(201).json({ collection: { id, name, count: req.body.videoId ? 1 : 0 } });
});

router.patch('/collections/:id', (req, res) => {
  const c = ownCollection(req);
  const name = v.str(req.body.name, { name: 'Name', required: true, max: 40 });
  q.run('UPDATE collections SET name = ? WHERE id = ?', name, c.id);
  res.json({ collection: { id: c.id, name } });
});

router.delete('/collections/:id', (req, res) => {
  const c = ownCollection(req);
  q.run('DELETE FROM collections WHERE id = ?', c.id);
  res.json({ ok: true });
});

function addToCollection(req, collectionId, videoId) {
  const row = getVideoRow(videoId, req.user.id);
  if (!row || !access.canViewVideo(req.user, row)) throw notFound('Video unavailable');
  q.run('INSERT OR IGNORE INTO collection_items (collection_id, video_id, created_at) VALUES (?, ?, ?)', collectionId, videoId, now());
  q.run('INSERT OR IGNORE INTO saves (user_id, video_id, created_at) VALUES (?, ?, ?)', req.user.id, videoId, now());
}

router.post('/collections/:id/videos', (req, res) => {
  const c = ownCollection(req);
  addToCollection(req, c.id, v.int(req.body.videoId, 'video'));
  res.json({ ok: true });
});

router.delete('/collections/:id/videos/:videoId', (req, res) => {
  const c = ownCollection(req);
  q.run('DELETE FROM collection_items WHERE collection_id = ? AND video_id = ?', c.id, v.int(req.params.videoId, 'video'));
  res.json({ ok: true });
});

router.get('/collections/:id/videos', (req, res) => {
  const c = ownCollection(req);
  const rows = q.all(`SELECT ${VIDEO_COLUMNS} ${VIDEO_FROM} JOIN collection_items ci ON ci.video_id = v.id AND ci.collection_id = :cid
    WHERE ${access.VISIBLE_VIDEO} ORDER BY ci.created_at DESC LIMIT 200`, { cid: c.id, me: req.user.id });
  res.json({ collection: { id: c.id, name: c.name }, videos: rows.map((r) => serializeVideo(r, req.user)), hasMore: false });
});

router.get('/video/:videoId/collections', (req, res) => {
  const rows = q.all(`SELECT c.id, c.name, EXISTS (SELECT 1 FROM collection_items ci WHERE ci.collection_id = c.id AND ci.video_id = ?) AS has
    FROM collections c WHERE c.user_id = ? ORDER BY c.created_at DESC`, v.int(req.params.videoId, 'video'), req.user.id);
  res.json({ collections: rows.map((r) => ({ id: r.id, name: r.name, contains: !!r.has })) });
});

module.exports = router;
