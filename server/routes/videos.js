'use strict';
const express = require('express');
const config = require('../config');
const { q, tx, now } = require('../db');
const v = require('../lib/validate');
const { bad, notFound, forbidden } = require('../lib/errors');
const { requireAuth } = require('../lib/auth');
const { limit } = require('../lib/rateLimit');
const access = require('../lib/access');
const { videoUpload, store, discard, removeStored, imageUpload } = require('../lib/uploads');
const { notify, unnotify, notifyMentions } = require('../lib/notify');
const automod = require('../lib/automod');
const settings = require('../lib/settings');
const path = require('path');
const { onPublished } = require('../lib/publish');
const { transcribe } = require('../lib/stt');
const { VIDEO_COLUMNS, VIDEO_FROM, serializeVideo, getVideoRow } = require('../lib/serialize');

const router = express.Router();
const uploadLimit = limit({ windowMs: 60 * 60 * 1000, max: 30, key: (req) => `up:${req.user.id}`, message: 'Upload limit reached, try again later' });
const actionLimit = limit({ windowMs: 60 * 1000, max: 120, key: (req) => `act:${req.user ? req.user.id : req.ip}` });

const meId = (req) => (req.user ? req.user.id : 0);

/** Load a video the viewer is allowed to see (404 otherwise, to avoid leaking existence). */
function visibleVideo(req) {
  const id = v.int(req.params.id, 'video');
  const row = getVideoRow(id, meId(req));
  if (!row || !access.canViewVideo(req.user, row)) throw notFound('This video is unavailable');
  return row;
}

function ownVideo(req) {
  const id = v.int(req.params.id, 'video');
  const row = getVideoRow(id, meId(req));
  if (!row) throw notFound('Video not found');
  if (!req.user || (row.user_id !== req.user.id && req.user.role !== 'admin')) throw forbidden('You can only change your own videos');
  return row;
}

function setHashtags(videoId, text) {
  q.run('DELETE FROM video_hashtags WHERE video_id = ?', videoId);
  for (const tag of v.extractHashtags(text)) {
    q.run('INSERT OR IGNORE INTO hashtags (tag) VALUES (?)', tag);
    const h = q.get('SELECT id FROM hashtags WHERE tag = ?', tag);
    q.run('INSERT OR IGNORE INTO video_hashtags (video_id, hashtag_id) VALUES (?, ?)', videoId, h.id);
  }
}

// ---------- Feeds ----------

function score(r, t) {
  const hours = (t - r.created_at) / 3600000;
  const engagement = r.like_count * 2 + r.comment_count * 3 + r.share_count * 4 + r.save_count * 3 + r.views * 0.15 + 1;
  return engagement / Math.pow(hours + 2, 1.25);
}

const VIBES = {
  chill: ['relax', 'chill', 'lofi', 'aesthetic', 'ocean', 'mindfulness', 'cozy', 'plants', 'plantmom', 'houseplants', 'sunset', 'calm'],
  hype: ['dance', 'fitness', 'workout', 'homeworkout', 'challenge', 'music', 'beats', 'producer', 'hype', 'neon', 'party'],
  funny: ['comedy', 'funny', 'relatable', 'meme', 'skit', 'fyp', 'lol'],
  learn: ['coding', 'programming', 'techtips', 'recipe', 'cooking', 'foodtok', 'tutorial', 'learn', 'howto', 'diy'],
  explore: ['travel', 'adventure', 'wanderlust', 'nature', 'citylife', 'explore', 'art', 'pixelart', 'animation'],
};

router.get('/vibes', (_req, res) => res.json({ vibes: Object.keys(VIBES) }));

router.get('/feed/foryou', (req, res) => {
  const me = meId(req);
  const mood = VIBES[req.query.vibe] ? req.query.vibe : null;
  const moodSql = mood ? `AND EXISTS (SELECT 1 FROM video_hashtags vhm JOIN hashtags hm ON hm.id = vhm.hashtag_id WHERE vhm.video_id = v.id AND hm.tag IN (${VIBES[mood].map((t) => `'${t}'`).join(',')}))` : '';
  const limitN = Math.min(Number(req.query.limit) || 8, 20);
  const exclude = new Set(String(req.query.exclude || '').split(',').map(Number).filter(Boolean).slice(0, 500));
  const rows = q.all(`SELECT ${VIDEO_COLUMNS},
      EXISTS (SELECT 1 FROM video_views vv WHERE vv.video_id = v.id AND vv.user_id = :me) AS seen,
      (SELECT COUNT(*) FROM not_interested ni WHERE ni.user_id = :me AND ni.author_id = v.user_id) AS author_dislikes
    ${VIDEO_FROM} WHERE ${access.VISIBLE_VIDEO} AND v.visibility = 'public' AND v.user_id <> :me
      AND NOT EXISTS (SELECT 1 FROM not_interested ni WHERE ni.user_id = :me AND ni.video_id = v.id)
      ${moodSql}
    ORDER BY v.created_at DESC LIMIT 1500`, { me });
  const t = now();
  const ranked = rows
    .filter((r) => !exclude.has(r.id))
    .map((r) => ({ r, s: score(r, t) * (r.seen ? 0.15 : 1) * Math.pow(0.25, Math.min(r.author_dislikes, 3)) * (0.85 + Math.random() * 0.3) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limitN)
    .map((x) => serializeVideo(x.r, req.user));
  res.json({ videos: ranked, hasMore: rows.length - exclude.size > limitN });
});

/** Following feed: videos from people you follow + videos they reposted, newest first. */
router.get('/feed/following', requireAuth, (req, res) => {
  const limitN = Math.min(Number(req.query.limit) || 8, 20);
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = q.all(`SELECT * FROM (
      SELECT ${VIDEO_COLUMNS},
        (SELECT ru.username FROM reposts rp2 JOIN users ru ON ru.id = rp2.user_id JOIN follows f3 ON f3.followee_id = rp2.user_id AND f3.follower_id = :me AND f3.status = 'accepted'
          WHERE rp2.video_id = v.id ORDER BY rp2.created_at DESC LIMIT 1) AS reposted_by,
        (SELECT ru.display_name FROM reposts rp2 JOIN users ru ON ru.id = rp2.user_id JOIN follows f3 ON f3.followee_id = rp2.user_id AND f3.follower_id = :me AND f3.status = 'accepted'
          WHERE rp2.video_id = v.id ORDER BY rp2.created_at DESC LIMIT 1) AS reposted_by_name,
        MAX(
          CASE WHEN EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id = :me AND f2.followee_id = v.user_id AND f2.status = 'accepted') THEN v.created_at ELSE 0 END,
          COALESCE((SELECT MAX(rp3.created_at) FROM reposts rp3 JOIN follows f4 ON f4.followee_id = rp3.user_id AND f4.follower_id = :me AND f4.status = 'accepted' WHERE rp3.video_id = v.id), 0)
        ) AS feed_at
      ${VIDEO_FROM} WHERE ${access.VISIBLE_VIDEO} AND v.user_id <> :me
    ) WHERE feed_at > 0 AND feed_at < :before ORDER BY feed_at DESC LIMIT :limit`, { me: req.user.id, before, limit: limitN + 1 });
  const page = rows.slice(0, limitN);
  const videos = page.map((r) => {
    const out = serializeVideo(r, req.user);
    if (r.feed_at === r.created_at) out.repostedBy = null; // shown because you follow the author
    return out;
  });
  res.json({ videos, hasMore: rows.length > limitN, next: page.length ? page[page.length - 1].feed_at : null });
});

// ---------- CRUD ----------

function uploadsOpen(req, _res, next) {
  if (!settings.get('platform').uploadsEnabled && req.user.role !== 'admin') return next(forbidden('Uploads are temporarily disabled by the platform owner.'));
  next();
}

const FILTERS = ['vivid', 'warm', 'cool', 'mono', 'vintage', 'fade', 'drama', 'dream'];

function parseVtt(text) {
  const vtt = v.str(text, { name: 'Captions', max: 20000, trim: true });
  if (!vtt) return null;
  if (!vtt.startsWith('WEBVTT')) throw bad('Captions must be in WebVTT format');
  return vtt;
}

/** Shared validation for editing options that both upload and PATCH accept. */
function editOptions(b, duration) {
  const out = {};
  if (b.trimStart !== undefined || b.trimEnd !== undefined) {
    const ts = Math.max(0, Number(b.trimStart) || 0);
    let te = b.trimEnd === '' || b.trimEnd === null || b.trimEnd === undefined ? null : Number(b.trimEnd);
    if (te !== null && (!Number.isFinite(te) || te <= ts + 0.5)) throw bad('Trim end must be after the start');
    if (duration && te !== null && te >= duration - 0.05) te = null;
    if (duration && ts >= duration) throw bad('Trim start is past the end of the video');
    out.trim_start = Math.round(ts * 100) / 100;
    out.trim_end = te === null ? null : Math.round(te * 100) / 100;
  }
  if (b.filter !== undefined) out.filter = b.filter ? v.oneOf(b.filter, FILTERS, 'Filter') : null;
  if (b.allowRemix !== undefined) out.allow_remix = v.bool(b.allowRemix) ? 1 : 0;
  if (b.captions !== undefined) out.captions = parseVtt(b.captions);
  return out;
}

function parseSchedule(b) {
  if (!b.publishAt) return null;
  const at = Number(b.publishAt);
  if (!Number.isFinite(at) || at < now() + 60000) throw bad('Schedule a time at least 1 minute from now');
  if (at > now() + 30 * 86400000) throw bad('You can schedule up to 30 days ahead');
  return at;
}

router.post('/', requireAuth, uploadsOpen, uploadLimit, videoUpload, (req, res) => {
  const files = req.files || {};
  const videoFile = files.video && files.video[0];
  const thumbFile = files.thumbnail && files.thumbnail[0];
  try {
    if (!videoFile) throw bad('Please choose a video to upload');
    const b = req.body;
    const caption = v.str(b.caption, { name: 'Caption', max: 300 });
    const description = v.str(b.description, { name: 'Description', max: 2000 });
    automod.assertAllowed(`${caption}\n${description}`, { user: req.user, context: 'caption' });
    const visibility = v.oneOf(b.visibility || 'public', ['public', 'followers', 'private'], 'Visibility');
    const allowComments = b.allowComments === undefined ? 1 : v.bool(b.allowComments) ? 1 : 0;
    const duration = Math.max(0, Math.min(Number(b.duration) || 0, 3600));
    if (duration > 600) throw bad('Videos can be at most 10 minutes long');
    const width = Number(b.width) || null;
    const height = Number(b.height) || null;
    let soundId = b.soundId ? v.int(b.soundId, 'sound') : null;
    if (soundId && !q.get('SELECT 1 FROM sounds WHERE id = ?', soundId)) soundId = null;
    const isDraft = v.bool(b.draft) ? 1 : 0;
    const publishAt = isDraft ? null : parseSchedule(b);
    const opts = editOptions(b, duration);

    let remixOf = null;
    let remixType = null;
    if (b.remixOf) {
      remixType = v.oneOf(b.remixType, ['duet', 'stitch'], 'Remix type');
      const orig = getVideoRow(v.int(b.remixOf, 'video'), req.user.id);
      if (!orig || !access.canViewVideo(req.user, orig)) throw bad('The original video is unavailable');
      if (!orig.allow_remix && orig.user_id !== req.user.id) throw forbidden(`The creator turned off ${remixType}s for this video`);
      remixOf = orig.id;
    }
    let replyCommentId = null;
    if (b.replyCommentId) {
      const c = q.get("SELECT c.id, v.user_id AS owner FROM comments c JOIN videos v ON v.id = c.video_id WHERE c.id = ? AND c.status = 'active'", v.int(b.replyCommentId, 'comment'));
      if (!c) throw bad('That comment no longer exists');
      if (c.owner !== req.user.id) throw forbidden('You can only reply with a video to comments on your own videos');
      replyCommentId = c.id;
    }

    const vid = store(videoFile, 'video', config.dirs.videos);
    let thumb = null;
    if (thumbFile) {
      try { thumb = store(thumbFile, 'image', config.dirs.thumbs); } catch (e) { removeStored(config.dirs.videos, vid.name); throw e; }
    }
    const t = now();
    const id = tx(() => {
      const r = q.run(`INSERT INTO videos (user_id, caption, description, video_file, video_mime, thumb_file, sound_id, duration, width, height,
        visibility, allow_comments, is_draft, publish_at, remix_of, remix_type, reply_comment_id, trim_start, trim_end, filter, allow_remix, captions, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      req.user.id, caption, description, vid.name, vid.mime, thumb ? thumb.name : null, soundId, duration, width, height, visibility, allowComments,
      isDraft, publishAt, remixOf, remixType, replyCommentId, opts.trim_start || 0, opts.trim_end ?? null, opts.filter ?? null,
      opts.allow_remix ?? 1, opts.captions ?? null, t, t);
      const newId = Number(r.lastInsertRowid);
      setHashtags(newId, `${caption} ${description}`);
      return newId;
    });
    onPublished(id);
    res.status(201).json({ video: serializeVideo(getVideoRow(id, req.user.id), req.user) });
  } catch (e) {
    discard(videoFile, thumbFile);
    throw e;
  }
});

/** Look up a comment for the "reply with video" sticker. */
router.get('/comment-info/:cid', requireAuth, (req, res) => {
  const c = q.get(`SELECT c.id, c.body, c.video_id, u.username, u.avatar_url, v.user_id AS owner FROM comments c JOIN users u ON u.id = c.user_id
    JOIN videos v ON v.id = c.video_id WHERE c.id = ? AND c.status = 'active'`, v.int(req.params.cid, 'comment'));
  if (!c || c.owner !== req.user.id) throw notFound('Comment not found');
  res.json({ comment: { id: c.id, body: c.body, videoId: c.video_id, username: c.username, avatarUrl: c.avatar_url } });
});

router.get('/:id', (req, res) => {
  res.json({ video: serializeVideo(visibleVideo(req), req.user) });
});

router.patch('/:id', requireAuth, (req, res) => {
  const row = ownVideo(req);
  const b = req.body || {};
  const sets = editOptions(b, row.duration);
  if (b.caption !== undefined) sets.caption = v.str(b.caption, { name: 'Caption', max: 300 });
  if (b.description !== undefined) sets.description = v.str(b.description, { name: 'Description', max: 2000 });
  if (b.visibility !== undefined) sets.visibility = v.oneOf(b.visibility, ['public', 'followers', 'private'], 'Visibility');
  if (b.allowComments !== undefined) sets.allow_comments = v.bool(b.allowComments) ? 1 : 0;
  if (sets.caption !== undefined || sets.description !== undefined)
    automod.assertAllowed(`${sets.caption ?? ''}\n${sets.description ?? ''}`, { user: req.user, context: 'caption' });
  if (b.pinned !== undefined) {
    if (v.bool(b.pinned)) {
      if (row.is_draft || row.publish_at) throw bad('Publish the video before pinning it');
      const n = q.get('SELECT COUNT(*) AS n FROM videos WHERE user_id = ? AND pinned_at IS NOT NULL AND id <> ?', row.user_id, row.id).n;
      if (n >= 3) throw bad('You can pin up to 3 videos. Unpin one first.');
      sets.pinned_at = now();
    } else sets.pinned_at = null;
  }
  let publishNow = false;
  if (b.publish !== undefined && v.bool(b.publish) && (row.is_draft || row.publish_at)) {
    sets.is_draft = 0; sets.publish_at = null; sets.created_at = now(); publishNow = true;
  } else if (b.publishAt !== undefined && (row.is_draft || row.publish_at)) {
    sets.publish_at = parseSchedule(b); sets.is_draft = 0;
  } else if (b.draft !== undefined && v.bool(b.draft) && row.publish_at) {
    sets.is_draft = 1; sets.publish_at = null;
  }
  sets.updated_at = now();
  tx(() => {
    q.run(`UPDATE videos SET ${Object.keys(sets).map((k) => `${k} = :${k}`).join(', ')} WHERE id = :id`, { ...sets, id: row.id });
    if (sets.caption !== undefined || sets.description !== undefined)
      setHashtags(row.id, `${sets.caption ?? row.caption} ${sets.description ?? row.description}`);
  });
  if (publishNow) onPublished(row.id);
  res.json({ video: serializeVideo(getVideoRow(row.id, req.user.id), req.user) });
});

/** Auto-generate captions with a speech-to-text provider (needs STT_PROVIDER + API key). */
router.post('/:id/captions/auto', requireAuth, limit({ windowMs: 3600000, max: 20, key: (req) => `stt:${req.user.id}` }), async (req, res) => {
  const row = ownVideo(req);
  const vtt = await transcribe(path.join(config.dirs.videos, row.video_file), row.video_mime);
  q.run('UPDATE videos SET captions = ?, updated_at = ? WHERE id = ?', vtt, now(), row.id);
  res.json({ captions: vtt, video: serializeVideo(getVideoRow(row.id, req.user.id), req.user) });
});

router.post('/:id/thumbnail', requireAuth, imageUpload('thumbnail'), (req, res) => {
  let row;
  try { row = ownVideo(req); } catch (e) { discard(req.file); throw e; }
  if (!req.file) throw bad('Choose an image');
  const { name } = store(req.file, 'image', config.dirs.thumbs);
  q.run('UPDATE videos SET thumb_file = ?, updated_at = ? WHERE id = ?', name, now(), row.id);
  removeStored(config.dirs.thumbs, row.thumb_file);
  res.json({ video: serializeVideo(getVideoRow(row.id, req.user.id), req.user) });
});

router.delete('/:id', requireAuth, (req, res) => {
  const row = ownVideo(req);
  q.run('DELETE FROM videos WHERE id = ?', row.id);
  removeStored(config.dirs.videos, row.video_file);
  removeStored(config.dirs.thumbs, row.thumb_file);
  if (req.user.role === 'admin' && row.user_id !== req.user.id)
    q.run('INSERT INTO audit_log (admin_id, action, target_type, target_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      req.user.id, 'video.delete', 'video', row.id, row.caption.slice(0, 100), now());
  res.json({ ok: true });
});

// ---------- Interactions ----------

const likeCount = (id) => q.get('SELECT COUNT(*) AS n FROM likes WHERE video_id = ?', id).n;

router.post('/:id/like', requireAuth, actionLimit, (req, res) => {
  const row = visibleVideo(req);
  const r = q.run('INSERT OR IGNORE INTO likes (user_id, video_id, created_at) VALUES (?, ?, ?)', req.user.id, row.id, now());
  if (r.changes) notify({ userId: row.user_id, actorId: req.user.id, type: 'like', videoId: row.id });
  res.json({ liked: true, likes: likeCount(row.id) });
});

router.delete('/:id/like', requireAuth, (req, res) => {
  const row = visibleVideo(req);
  q.run('DELETE FROM likes WHERE user_id = ? AND video_id = ?', req.user.id, row.id);
  unnotify({ userId: row.user_id, actorId: req.user.id, type: 'like', videoId: row.id });
  res.json({ liked: false, likes: likeCount(row.id) });
});

const saveCount = (id) => q.get('SELECT COUNT(*) AS n FROM saves WHERE video_id = ?', id).n;

router.post('/:id/save', requireAuth, actionLimit, (req, res) => {
  const row = visibleVideo(req);
  q.run('INSERT OR IGNORE INTO saves (user_id, video_id, created_at) VALUES (?, ?, ?)', req.user.id, row.id, now());
  res.json({ saved: true, saves: saveCount(row.id) });
});

router.delete('/:id/save', requireAuth, (req, res) => {
  const row = visibleVideo(req);
  q.run('DELETE FROM saves WHERE user_id = ? AND video_id = ?', req.user.id, row.id);
  res.json({ saved: false, saves: saveCount(row.id) });
});

router.post('/:id/share', actionLimit, (req, res) => {
  const row = visibleVideo(req);
  q.run('UPDATE videos SET share_count = share_count + 1 WHERE id = ?', row.id);
  q.run("INSERT INTO video_events (video_id, user_id, type, source, created_at) VALUES (?, ?, 'share', ?, ?)", row.id, meId(req) || null, null, now());
  res.json({ shares: row.share_count + 1, url: `${config.baseUrl}/video/${row.id}` });
});

router.post('/:id/view', (req, res) => {
  const row = visibleVideo(req);
  q.run('UPDATE videos SET views = views + 1 WHERE id = ?', row.id);
  if (req.user) q.run('INSERT OR IGNORE INTO video_views (user_id, video_id, created_at) VALUES (?, ?, ?)', req.user.id, row.id, now());
  const source = ['foryou', 'following', 'profile', 'search', 'share', 'other'].includes(req.body.source) ? req.body.source : 'other';
  if (!req.user || req.user.id !== row.user_id)
    q.run("INSERT INTO video_events (video_id, user_id, type, source, created_at) VALUES (?, ?, 'view', ?, ?)", row.id, meId(req) || null, source, now());
  res.json({ views: row.views + 1 });
});

// ---------- Reposts & "Not interested" ----------
router.post('/:id/repost', requireAuth, actionLimit, (req, res) => {
  const row = visibleVideo(req);
  if (row.user_id === req.user.id) throw bad('You can’t repost your own video');
  if (row.visibility !== 'public') throw bad('Only public videos can be reposted');
  const r = q.run('INSERT OR IGNORE INTO reposts (user_id, video_id, created_at) VALUES (?, ?, ?)', req.user.id, row.id, now());
  if (r.changes) notify({ userId: row.user_id, actorId: req.user.id, type: 'repost', videoId: row.id });
  res.json({ reposted: true, reposts: q.get('SELECT COUNT(*) AS n FROM reposts WHERE video_id = ?', row.id).n });
});

router.delete('/:id/repost', requireAuth, (req, res) => {
  const row = visibleVideo(req);
  q.run('DELETE FROM reposts WHERE user_id = ? AND video_id = ?', req.user.id, row.id);
  unnotify({ userId: row.user_id, actorId: req.user.id, type: 'repost', videoId: row.id });
  res.json({ reposted: false, reposts: q.get('SELECT COUNT(*) AS n FROM reposts WHERE video_id = ?', row.id).n });
});

router.post('/:id/not-interested', requireAuth, (req, res) => {
  const row = visibleVideo(req);
  q.run('INSERT OR IGNORE INTO not_interested (user_id, video_id, author_id, created_at) VALUES (?, ?, ?, ?)', req.user.id, row.id, row.user_id, now());
  res.json({ ok: true });
});

router.delete('/:id/not-interested', requireAuth, (req, res) => {
  q.run('DELETE FROM not_interested WHERE user_id = ? AND video_id = ?', req.user.id, v.int(req.params.id, 'video'));
  res.json({ ok: true });
});

// ---------- Comments ----------

const COMMENT_COLUMNS = `c.*, u.username, u.display_name, u.avatar_url, u.is_verified,
  (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id) AS like_count,
  EXISTS (SELECT 1 FROM comment_likes cl WHERE cl.comment_id = c.id AND cl.user_id = :me) AS liked,
  (SELECT COUNT(*) FROM comments r WHERE r.parent_id = c.id AND r.status = 'active' AND (r.held = 0 OR r.user_id = :me)) AS reply_count`;

function serializeComment(r, me, videoOwnerId) {
  return {
    id: r.id,
    videoId: r.video_id,
    parentId: r.parent_id,
    body: r.body,
    createdAt: r.created_at,
    likes: r.like_count,
    liked: !!r.liked,
    replies: r.reply_count,
    byCreator: r.user_id === videoOwnerId,
    held: !!r.held,
    canDelete: !!me && (me.id === r.user_id || me.id === videoOwnerId || me.role === 'admin'),
    author: { id: r.user_id, username: r.username, displayName: r.display_name || r.username, avatarUrl: r.avatar_url, verified: !!r.is_verified },
  };
}

const HIDE_BLOCKED_AUTHORS = `AND (c.held = 0 OR c.user_id = :me) AND u.status = 'active' AND NOT ${access.blockedEither(':me', 'c.user_id')}`;

router.get('/:id/comments', (req, res) => {
  const row = visibleVideo(req);
  const me = meId(req);
  const limitN = Math.min(Number(req.query.limit) || 20, 50);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const order = req.query.sort === 'new' ? 'c.created_at DESC' : '(c.user_id = :me) DESC, like_count DESC, reply_count DESC, c.created_at DESC';
  const rows = q.all(`SELECT ${COMMENT_COLUMNS} FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.video_id = :vid AND c.parent_id IS NULL AND c.status = 'active' ${HIDE_BLOCKED_AUTHORS}
    ORDER BY ${order} LIMIT :limit OFFSET :offset`, { vid: row.id, me, limit: limitN + 1, offset });
  res.json({
    comments: rows.slice(0, limitN).map((r) => serializeComment(r, req.user, row.user_id)),
    hasMore: rows.length > limitN,
    total: row.comment_count,
    canComment: access.canComment(req.user, row),
    commentsDisabled: !row.allow_comments || row.u_allow_comments === 'none',
  });
});

router.get('/comments/:cid/replies', (req, res) => {
  const cid = v.int(req.params.cid, 'comment');
  const parent = q.get('SELECT * FROM comments WHERE id = ?', cid);
  if (!parent) throw notFound('Comment not found');
  req.params.id = String(parent.video_id);
  const row = visibleVideo(req);
  const rows = q.all(`SELECT ${COMMENT_COLUMNS} FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.parent_id = :cid AND c.status = 'active' ${HIDE_BLOCKED_AUTHORS} ORDER BY c.created_at ASC LIMIT 200`, { cid, me: meId(req) });
  res.json({ comments: rows.map((r) => serializeComment(r, req.user, row.user_id)) });
});

const commentLimit = limit({ windowMs: 60 * 1000, max: 20, key: (req) => `cm:${req.user.id}`, message: 'You are commenting too fast' });

router.post('/:id/comments', requireAuth, commentLimit, (req, res) => {
  const row = visibleVideo(req);
  if (!access.canComment(req.user, row)) throw forbidden('Comments are turned off or restricted for this video');
  const body = v.str(req.body.body, { name: 'Comment', required: true, max: 500 });
  let parentId = null;
  let parent = null;
  if (req.body.parentId) {
    parent = q.get("SELECT * FROM comments WHERE id = ? AND video_id = ? AND status = 'active'", v.int(req.body.parentId, 'comment'), row.id);
    if (!parent) throw bad('The comment you are replying to no longer exists');
    parentId = parent.parent_id || parent.id; // keep threads one level deep
  }
  const owner = q.get('SELECT * FROM users WHERE id = ?', row.user_id);
  const mod = automod.check(body, { user: req.user, context: 'comment', owner });
  if (mod.action === 'block') throw bad(mod.message);
  const held = mod.action === 'hold' ? 1 : 0;
  const r = q.run('INSERT INTO comments (video_id, user_id, parent_id, body, held, held_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    row.id, req.user.id, parentId, body, held, held ? mod.rule : null, now());
  const cid = Number(r.lastInsertRowid);
  if (held) {
    const c = q.get(`SELECT ${COMMENT_COLUMNS} FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = :id`, { id: cid, me: req.user.id });
    return res.status(201).json({ comment: serializeComment(c, req.user, row.user_id), notice: mod.message });
  }
  require('../lib/aiMod').observe(req.user.id, 'comment');
  const notified = [req.user.id];
  if (parent && parent.user_id !== req.user.id) {
    notify({ userId: parent.user_id, actorId: req.user.id, type: 'reply', videoId: row.id, commentId: cid, body: body.slice(0, 140) });
    notified.push(parent.user_id);
  }
  if (!notified.includes(row.user_id)) {
    notify({ userId: row.user_id, actorId: req.user.id, type: 'comment', videoId: row.id, commentId: cid, body: body.slice(0, 140) });
    notified.push(row.user_id);
  }
  notifyMentions(body, { actorId: req.user.id, videoId: row.id, commentId: cid, exclude: notified });
  const c = q.get(`SELECT ${COMMENT_COLUMNS} FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = :id`, { id: cid, me: req.user.id });
  res.status(201).json({ comment: serializeComment(c, req.user, row.user_id) });
});

router.delete('/comments/:cid', requireAuth, (req, res) => {
  const c = q.get('SELECT c.*, v.user_id AS owner_id FROM comments c JOIN videos v ON v.id = c.video_id WHERE c.id = ?', v.int(req.params.cid, 'comment'));
  if (!c) throw notFound('Comment not found');
  if (c.user_id !== req.user.id && c.owner_id !== req.user.id && req.user.role !== 'admin') throw forbidden('You cannot delete this comment');
  q.run('DELETE FROM comments WHERE id = ?', c.id);
  res.json({ ok: true });
});

router.post('/comments/:cid/like', requireAuth, actionLimit, (req, res) => {
  const c = q.get("SELECT * FROM comments WHERE id = ? AND status = 'active'", v.int(req.params.cid, 'comment'));
  if (!c) throw notFound('Comment not found');
  req.params.id = String(c.video_id);
  visibleVideo(req);
  const r = q.run('INSERT OR IGNORE INTO comment_likes (user_id, comment_id) VALUES (?, ?)', req.user.id, c.id);
  if (r.changes) notify({ userId: c.user_id, actorId: req.user.id, type: 'comment_like', videoId: c.video_id, commentId: c.id, body: c.body.slice(0, 140) });
  res.json({ liked: true, likes: q.get('SELECT COUNT(*) AS n FROM comment_likes WHERE comment_id = ?', c.id).n });
});

router.delete('/comments/:cid/like', requireAuth, (req, res) => {
  const cid = v.int(req.params.cid, 'comment');
  q.run('DELETE FROM comment_likes WHERE user_id = ? AND comment_id = ?', req.user.id, cid);
  res.json({ liked: false, likes: q.get('SELECT COUNT(*) AS n FROM comment_likes WHERE comment_id = ?', cid).n });
});

module.exports = router;
