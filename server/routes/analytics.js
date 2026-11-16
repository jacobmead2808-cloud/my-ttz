'use strict';
// Creator analytics: views, engagement, followers and traffic sources over a time range.
const express = require('express');
const { q, now } = require('../db');
const { requireAuth } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);
const DAY = 86400000;

function dayStart(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }

router.get('/', (req, res) => {
  const days = [7, 28, 60].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
  const me = req.user.id;
  const end = now();
  const from = dayStart(end - (days - 1) * DAY);
  const prevFrom = from - days * DAY;
  const count = (sql, ...p) => q.get(sql, ...p).n;

  const range = (a, b) => ({
    views: count("SELECT COUNT(*) AS n FROM video_events e JOIN videos v ON v.id = e.video_id WHERE v.user_id = ? AND e.type = 'view' AND e.created_at >= ? AND e.created_at < ?", me, a, b),
    likes: count('SELECT COUNT(*) AS n FROM likes l JOIN videos v ON v.id = l.video_id WHERE v.user_id = ? AND l.created_at >= ? AND l.created_at < ?', me, a, b),
    comments: count("SELECT COUNT(*) AS n FROM comments c JOIN videos v ON v.id = c.video_id WHERE v.user_id = ? AND c.user_id <> ? AND c.status = 'active' AND c.created_at >= ? AND c.created_at < ?", me, me, a, b),
    shares: count("SELECT COUNT(*) AS n FROM video_events e JOIN videos v ON v.id = e.video_id WHERE v.user_id = ? AND e.type = 'share' AND e.created_at >= ? AND e.created_at < ?", me, a, b),
    followers: count("SELECT COUNT(*) AS n FROM follows WHERE followee_id = ? AND status = 'accepted' AND created_at >= ? AND created_at < ?", me, a, b),
    profileViews: count("SELECT COUNT(*) AS n FROM video_events e JOIN videos v ON v.id = e.video_id WHERE v.user_id = ? AND e.type = 'view' AND e.source = 'profile' AND e.created_at >= ? AND e.created_at < ?", me, a, b),
  });
  const current = range(from, end + 1);
  const previous = range(prevFrom, from);

  const daily = [];
  for (let t = from; t <= end; t += DAY) {
    const d = dayStart(t);
    daily.push({
      day: d,
      views: count("SELECT COUNT(*) AS n FROM video_events e JOIN videos v ON v.id = e.video_id WHERE v.user_id = ? AND e.type = 'view' AND e.created_at >= ? AND e.created_at < ?", me, d, d + DAY),
      likes: count('SELECT COUNT(*) AS n FROM likes l JOIN videos v ON v.id = l.video_id WHERE v.user_id = ? AND l.created_at >= ? AND l.created_at < ?', me, d, d + DAY),
      followers: count("SELECT COUNT(*) AS n FROM follows WHERE followee_id = ? AND status = 'accepted' AND created_at >= ? AND created_at < ?", me, d, d + DAY),
    });
  }

  const sources = q.all(`SELECT COALESCE(e.source, 'other') AS source, COUNT(*) AS n FROM video_events e JOIN videos v ON v.id = e.video_id
    WHERE v.user_id = ? AND e.type = 'view' AND e.created_at >= ? GROUP BY source ORDER BY n DESC`, me, from);

  const top = q.all(`SELECT v.id, v.caption, v.thumb_file, v.updated_at, v.views AS total_views, v.created_at,
      (SELECT COUNT(*) FROM video_events e WHERE e.video_id = v.id AND e.type = 'view' AND e.created_at >= :from) AS range_views,
      (SELECT COUNT(*) FROM likes l WHERE l.video_id = v.id) AS likes,
      (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id AND c.status = 'active' AND c.held = 0) AS comments,
      v.share_count AS shares
    FROM videos v WHERE v.user_id = :me AND v.status = 'active' AND v.is_draft = 0 AND v.publish_at IS NULL
    ORDER BY range_views DESC, total_views DESC LIMIT 10`, { me, from });

  const totals = q.get(`SELECT
      (SELECT COUNT(*) FROM follows WHERE followee_id = :me AND status = 'accepted') AS followers,
      (SELECT COALESCE(SUM(views), 0) FROM videos WHERE user_id = :me) AS views,
      (SELECT COUNT(*) FROM likes l JOIN videos v ON v.id = l.video_id WHERE v.user_id = :me) AS likes,
      (SELECT COUNT(*) FROM videos WHERE user_id = :me AND status = 'active' AND is_draft = 0 AND publish_at IS NULL) AS videos`, { me });

  res.json({
    days, current, previous, daily, totals,
    sources: sources.map((s) => ({ source: s.source, views: s.n })),
    topVideos: top.map((t) => ({
      id: t.id, caption: t.caption, thumbUrl: t.thumb_file ? `/media/t/${t.id}?t=${t.updated_at}` : null, createdAt: t.created_at,
      views: t.range_views, totalViews: t.total_views, likes: t.likes, comments: t.comments, shares: t.shares,
      engagement: t.total_views ? Math.round(((t.likes + t.comments + t.shares) / t.total_views) * 1000) / 10 : 0,
    })),
  });
});

module.exports = router;
