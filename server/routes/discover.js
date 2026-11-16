'use strict';
const express = require('express');
const { q, now } = require('../db');
const v = require('../lib/validate');
const { notFound } = require('../lib/errors');
const access = require('../lib/access');
const { VIDEO_COLUMNS, VIDEO_FROM, serializeVideo, userBrief } = require('../lib/serialize');
const liveRt = require('../realtime/live');

const router = express.Router();
const meId = (req) => (req.user ? req.user.id : 0);
const WEEK = 7 * 86400000;

function searchUsers(term, me, limitN, offset = 0) {
  const like = `%${v.likeEscape(term)}%`;
  return q.all(`SELECT u.*, (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id AND f.status = 'accepted') AS followers,
      (SELECT status FROM follows x WHERE x.follower_id = :me AND x.followee_id = u.id) AS my_status
    FROM users u WHERE ${access.VISIBLE_USER} AND (u.username LIKE :like ESCAPE '\\' OR u.display_name LIKE :like ESCAPE '\\')
    ORDER BY (u.username = :term) DESC, followers DESC LIMIT :limit OFFSET :offset`, { me, like, term: term.toLowerCase(), limit: limitN, offset })
    .map((r) => ({ ...userBrief(r), bio: r.bio, followers: r.followers, followStatus: r.id === me ? 'self' : r.my_status || null }));
}

function searchVideos(term, req, limitN, offset = 0) {
  const like = `%${v.likeEscape(term.replace(/^#/, ''))}%`;
  return q.all(`SELECT ${VIDEO_COLUMNS} ${VIDEO_FROM} WHERE ${access.VISIBLE_VIDEO} AND (
      v.caption LIKE :like ESCAPE '\\' OR v.description LIKE :like ESCAPE '\\' OR u.username LIKE :like ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM video_hashtags vh JOIN hashtags h ON h.id = vh.hashtag_id WHERE vh.video_id = v.id AND h.tag LIKE :like ESCAPE '\\'))
    ORDER BY (v.views + 5 * (SELECT COUNT(*) FROM likes l WHERE l.video_id = v.id)) DESC LIMIT :limit OFFSET :offset`,
  { me: meId(req), like, limit: limitN, offset }).map((r) => serializeVideo(r, req.user));
}

function searchTags(term, me, limitN) {
  const like = `%${v.likeEscape(term.replace(/^#/, ''))}%`;
  return q.all(`SELECT h.tag, COUNT(v.id) AS videos, COALESCE(SUM(v.views), 0) AS views
    FROM hashtags h JOIN video_hashtags vh ON vh.hashtag_id = h.id JOIN videos v ON v.id = vh.video_id JOIN users u ON u.id = v.user_id
    WHERE h.tag LIKE :like ESCAPE '\\' AND ${access.VISIBLE_VIDEO}
    GROUP BY h.id ORDER BY videos DESC, views DESC LIMIT :limit`, { me, like, limit: limitN });
}

router.get('/search', (req, res) => {
  const term = v.str(req.query.q, { name: 'Search', max: 100 });
  const type = ['top', 'users', 'videos', 'hashtags'].includes(req.query.type) ? req.query.type : 'top';
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  if (!term) return res.json({ users: [], videos: [], hashtags: [] });
  const me = meId(req);
  if (type === 'users') return res.json({ users: searchUsers(term, me, 30, offset) });
  if (type === 'videos') return res.json({ videos: searchVideos(term, req, 30, offset) });
  if (type === 'hashtags') return res.json({ hashtags: searchTags(term, me, 40) });
  res.json({ users: searchUsers(term, me, 6), videos: searchVideos(term, req, 18), hashtags: searchTags(term, me, 8) });
});

router.get('/search/suggest', (req, res) => {
  const term = v.str(req.query.q, { name: 'Search', max: 100 });
  if (!term) return res.json({ users: [], hashtags: [] });
  res.json({ users: searchUsers(term, meId(req), 5), hashtags: searchTags(term, meId(req), 5) });
});

function trendingTags(me, limitN) {
  return q.all(`SELECT h.tag, COUNT(v.id) AS videos, COALESCE(SUM(v.views), 0) AS views,
      SUM((SELECT COUNT(*) FROM likes l WHERE l.video_id = v.id)) AS likes
    FROM hashtags h JOIN video_hashtags vh ON vh.hashtag_id = h.id JOIN videos v ON v.id = vh.video_id JOIN users u ON u.id = v.user_id
    WHERE ${access.VISIBLE_VIDEO} AND v.visibility = 'public'
    GROUP BY h.id ORDER BY (videos * 10 + likes * 2 + views) DESC LIMIT :limit`, { me, limit: limitN });
}

router.get('/discover', (req, res) => {
  const me = meId(req);
  const tags = trendingTags(me, 12);
  const creators = q.all(`SELECT u.*,
      (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id AND f.status = 'accepted') AS followers,
      (SELECT COUNT(*) FROM likes l JOIN videos vv ON vv.id = l.video_id WHERE vv.user_id = u.id) AS total_likes,
      (SELECT status FROM follows x WHERE x.follower_id = :me AND x.followee_id = u.id) AS my_status
    FROM users u WHERE ${access.VISIBLE_USER} AND u.id <> :me
      AND EXISTS (SELECT 1 FROM videos v WHERE v.user_id = u.id AND v.status = 'active' AND v.visibility = 'public')
    ORDER BY (followers * 3 + total_likes) DESC LIMIT 12`, { me })
    .map((r) => ({ ...userBrief(r), bio: r.bio, followers: r.followers, likes: r.total_likes, followStatus: r.my_status || null }));
  const trending = q.all(`SELECT ${VIDEO_COLUMNS} ${VIDEO_FROM} WHERE ${access.VISIBLE_VIDEO} AND v.visibility = 'public' AND v.created_at > :since
    ORDER BY (v.views + 4 * (SELECT COUNT(*) FROM likes l WHERE l.video_id = v.id) + 6 * (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id)) DESC
    LIMIT 24`, { me, since: now() - 4 * WEEK }).map((r) => serializeVideo(r, req.user));
  const recommended = q.all(`SELECT ${VIDEO_COLUMNS} ${VIDEO_FROM} WHERE ${access.VISIBLE_VIDEO} AND v.visibility = 'public' AND v.user_id <> :me
      AND NOT EXISTS (SELECT 1 FROM video_views vv WHERE vv.video_id = v.id AND vv.user_id = :me)
    ORDER BY RANDOM() LIMIT 12`, { me }).map((r) => serializeVideo(r, req.user));
  // Preview a few videos per top tag
  const tagPreviews = tags.slice(0, 4).map((t) => ({
    ...t,
    items: q.all(`SELECT ${VIDEO_COLUMNS} ${VIDEO_FROM} JOIN video_hashtags vh ON vh.video_id = v.id JOIN hashtags h ON h.id = vh.hashtag_id
      WHERE h.tag = :tag AND ${access.VISIBLE_VIDEO} AND v.visibility = 'public' ORDER BY v.views DESC LIMIT 6`, { me, tag: t.tag })
      .map((r) => serializeVideo(r, req.user)),
  }));
  res.json({ tags, creators, trending, recommended, tagPreviews, live: liveList(me, 8) });
});

function liveList(me, limitN) {
  return q.all(`SELECT ls.*, u.username, u.display_name, u.avatar_url, u.is_verified FROM live_streams ls JOIN users u ON u.id = ls.user_id
    WHERE ls.status = 'live' AND ${access.VISIBLE_USER} AND (u.is_private = 0 OR ls.user_id = :me OR EXISTS
      (SELECT 1 FROM follows f WHERE f.follower_id = :me AND f.followee_id = u.id AND f.status = 'accepted'))
    ORDER BY ls.started_at DESC LIMIT :limit`, { me, limit: limitN }).map((r) => serializeLive(r))
    .sort((a, b) => b.viewers - a.viewers);
}

function serializeLive(r) {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    viewers: liveRt.viewerCount(r.id),
    peakViewers: r.peak_viewers,
    likes: r.total_likes,
    diamonds: r.diamonds || 0,
    isTrial: !!r.is_trial,
    goal: r.goal_type ? { type: r.goal_type, target: r.goal_target, label: r.goal_label } : null,
    newFollowers: r.new_followers || 0,
    previewUrl: r.preview_file ? `/media/l/${r.preview_file}` : null,
    host: { id: r.user_id, username: r.username, displayName: r.display_name || r.username, avatarUrl: r.avatar_url, verified: !!r.is_verified },
  };
}

router.get('/tags/:tag', (req, res) => {
  const tag = String(req.params.tag).toLowerCase().replace(/^#/, '').slice(0, 50);
  const h = q.get('SELECT * FROM hashtags WHERE tag = ?', tag);
  const me = meId(req);
  if (!h) return res.json({ tag: { tag, videos: 0, views: 0 }, videos: [] });
  const limitN = Math.min(Number(req.query.limit) || 30, 60);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const stats = q.get(`SELECT COUNT(v.id) AS videos, COALESCE(SUM(v.views),0) AS views FROM video_hashtags vh JOIN videos v ON v.id = vh.video_id
    JOIN users u ON u.id = v.user_id WHERE vh.hashtag_id = :hid AND ${access.VISIBLE_VIDEO}`, { hid: h.id, me });
  const rows = q.all(`SELECT ${VIDEO_COLUMNS} ${VIDEO_FROM} JOIN video_hashtags vh2 ON vh2.video_id = v.id
    WHERE vh2.hashtag_id = :hid AND ${access.VISIBLE_VIDEO} ORDER BY v.views DESC, v.created_at DESC LIMIT :limit OFFSET :offset`,
  { hid: h.id, me, limit: limitN + 1, offset });
  res.json({ tag: { tag: h.tag, ...stats }, videos: rows.slice(0, limitN).map((r) => serializeVideo(r, req.user)), hasMore: rows.length > limitN });
});

router.get('/sounds', (_req, res) => {
  const rows = q.all('SELECT s.*, (SELECT COUNT(*) FROM videos v WHERE v.sound_id = s.id AND v.status = \'active\') AS uses FROM sounds s ORDER BY uses DESC, s.id');
  res.json({ sounds: rows.map((s) => ({ id: s.id, title: s.title, artist: s.artist, url: `/media/s/${s.file_name}`, duration: s.duration, uses: s.uses })) });
});

router.get('/sounds/:id', (req, res) => {
  const s = q.get('SELECT * FROM sounds WHERE id = ?', v.int(req.params.id, 'sound'));
  if (!s) throw notFound('Sound not found');
  const rows = q.all(`SELECT ${VIDEO_COLUMNS} ${VIDEO_FROM} WHERE v.sound_id = :sid AND ${access.VISIBLE_VIDEO} ORDER BY v.views DESC LIMIT 60`, { sid: s.id, me: meId(req) });
  res.json({ sound: { id: s.id, title: s.title, artist: s.artist, url: `/media/s/${s.file_name}`, duration: s.duration }, videos: rows.map((r) => serializeVideo(r, req.user)) });
});

module.exports = router;
module.exports.serializeLive = serializeLive;
module.exports.liveList = liveList;
