'use strict';
const express = require('express');
const config = require('../config');
const { q, tx, now } = require('../db');
const v = require('../lib/validate');
const { bad, conflict, unauthorized } = require('../lib/errors');
const auth = require('../lib/auth');
const { imageUpload, store, removeStored, discard } = require('../lib/uploads');
const { notify } = require('../lib/notify');
const { userBrief } = require('../lib/serialize');
const automod = require('../lib/automod');
const accounts = require('../lib/accounts');

const router = express.Router();

function safeList(json) {
  try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

function meJson(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.display_name || u.username,
    bio: u.bio,
    avatarUrl: u.avatar_url || null,
    role: u.role,
    isOwner: !!u.is_owner,
    verified: !!u.is_verified,
    commentBanned: !!u.comment_banned,
    emailVerified: !!u.email_verified,
    birthDateSet: !!u.birth_date,
    isAdult: accounts.isAdult(u),
    liveBanned: !!u.live_banned,
    settings: {
      isPrivate: !!u.is_private,
      allowMessages: u.allow_messages,
      allowComments: u.allow_comments,
      showLiked: !!u.show_liked,
      filterKeywords: safeList(u.filter_keywords),
      filterLinks: !!u.filter_links,
    },
    createdAt: u.created_at,
  };
}

router.use(auth.requireAuth);

router.patch('/', (req, res) => {
  const u = req.user;
  const sets = {};
  if (req.body.displayName !== undefined) sets.display_name = v.str(req.body.displayName, { name: 'Display name', max: 40 }) || u.username;
  if (req.body.bio !== undefined) sets.bio = v.str(req.body.bio, { name: 'Bio', max: 160 });
  if (req.body.username !== undefined) {
    const name = v.username(req.body.username);
    if (name !== u.username.toLowerCase()) {
      if (q.get('SELECT 1 FROM users WHERE username = ? AND id <> ?', name, u.id)) throw conflict('That username is taken');
      sets.username = name;
    }
  }
  if (sets.username) v.assertNoEmail(sets.username, u.email, 'Username');
  if (sets.display_name) v.assertNoEmail(sets.display_name, u.email, 'Display name');
  automod.assertAllowed([sets.username, sets.display_name, sets.bio].filter(Boolean).join('\n'), { user: u, context: 'profile' });
  const keys = Object.keys(sets);
  if (keys.length) q.run(`UPDATE users SET ${keys.map((k) => `${k} = :${k}`).join(', ')} WHERE id = :id`, { ...sets, id: u.id });
  res.json({ user: meJson(q.get('SELECT * FROM users WHERE id = ?', u.id)) });
});

router.post('/avatar', imageUpload('avatar'), (req, res) => {
  if (!req.file) throw bad('Choose an image to upload');
  const { name } = store(req.file, 'image', config.dirs.avatars);
  const old = req.user.avatar_url;
  q.run('UPDATE users SET avatar_url = ? WHERE id = ?', `/media/a/${name}`, req.user.id);
  if (old && old.startsWith('/media/a/')) removeStored(config.dirs.avatars, old.slice(9));
  res.json({ user: meJson(q.get('SELECT * FROM users WHERE id = ?', req.user.id)) });
});

router.delete('/avatar', (req, res) => {
  const old = req.user.avatar_url;
  q.run('UPDATE users SET avatar_url = NULL WHERE id = ?', req.user.id);
  if (old && old.startsWith('/media/a/')) removeStored(config.dirs.avatars, old.slice(9));
  res.json({ user: meJson(q.get('SELECT * FROM users WHERE id = ?', req.user.id)) });
});

router.patch('/settings', (req, res) => {
  const b = req.body || {};
  const u = req.user;
  const sets = {};
  if (b.isPrivate !== undefined) sets.is_private = v.bool(b.isPrivate) ? 1 : 0;
  if (b.allowMessages !== undefined) sets.allow_messages = v.oneOf(b.allowMessages, ['everyone', 'friends', 'none'], 'Messages setting');
  if (b.allowComments !== undefined) sets.allow_comments = v.oneOf(b.allowComments, ['everyone', 'followers', 'none'], 'Comments setting');
  if (b.showLiked !== undefined) sets.show_liked = v.bool(b.showLiked) ? 1 : 0;
  if (b.birthDate !== undefined) {
    if (u.birth_date) throw bad('Your date of birth is already set. Contact support to change it.');
    sets.birth_date = accounts.parseBirthDate(b.birthDate);
    const age = accounts.ageOn(sets.birth_date);
    if (age < accounts.MIN_AGE) throw bad(`You must be at least ${accounts.MIN_AGE} to use this app.`);
    if (age < accounts.ADULT_AGE) { sets.is_private = 1; if (u.allow_messages === 'everyone') sets.allow_messages = 'friends'; }
  }
  const effectiveBirth = sets.birth_date || u.birth_date;
  if (sets.allow_messages === 'everyone' && effectiveBirth && accounts.ageOn(effectiveBirth) < accounts.ADULT_AGE)
    throw bad('Accounts under 18 can only receive messages from friends.');
  if (b.filterLinks !== undefined) sets.filter_links = v.bool(b.filterLinks) ? 1 : 0;
  if (b.filterKeywords !== undefined) {
    if (!Array.isArray(b.filterKeywords)) throw bad('Keywords must be a list');
    const list = [...new Set(b.filterKeywords.map((k) => v.str(k, { name: 'Keyword', max: 40 }).toLowerCase()).filter(Boolean))];
    if (list.length > 200) throw bad('You can filter at most 200 keywords');
    sets.filter_keywords = JSON.stringify(list);
  }
  const keys = Object.keys(sets);
  if (keys.length) q.run(`UPDATE users SET ${keys.map((k) => `${k} = :${k}`).join(', ')} WHERE id = :id`, { ...sets, id: u.id });
  // Switching to public auto-approves pending follow requests.
  if (sets.is_private === 0 && u.is_private) {
    const pending = q.all("SELECT follower_id FROM follows WHERE followee_id = ? AND status = 'pending'", u.id);
    q.run("UPDATE follows SET status = 'accepted' WHERE followee_id = ? AND status = 'pending'", u.id);
    q.run("DELETE FROM notifications WHERE user_id = ? AND type = 'follow_request'", u.id);
    for (const p of pending) notify({ userId: u.id, actorId: p.follower_id, type: 'follow' });
  }
  res.json({ user: meJson(q.get('SELECT * FROM users WHERE id = ?', u.id)) });
});

router.post('/password', async (req, res) => {
  const ok = await auth.verifyPassword(String(req.body.currentPassword || ''), req.user.password_hash);
  if (!ok) throw unauthorized('Current password is incorrect');
  const pw = v.password(req.body.newPassword);
  q.run('UPDATE users SET password_hash = ? WHERE id = ?', await auth.hashPassword(pw), req.user.id);
  // Keep this session, end all others.
  q.run('DELETE FROM sessions WHERE user_id = ?', req.user.id);
  auth.createSession(res, req.user.id, req.get('user-agent'));
  res.json({ ok: true });
});

router.post('/email', async (req, res) => {
  const ok = await auth.verifyPassword(String(req.body.password || ''), req.user.password_hash);
  if (!ok) throw unauthorized('Password is incorrect');
  const email = v.email(req.body.email);
  if (q.get('SELECT 1 FROM users WHERE email = ? AND id <> ?', email, req.user.id)) throw conflict('That email is already in use');
  q.run('UPDATE users SET email = ?, email_verified = ? WHERE id = ?', email, config.requireEmailVerification ? 0 : 1, req.user.id);
  const updated = q.get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (config.requireEmailVerification) await accounts.sendVerification(updated);
  res.json({ user: meJson(updated) });
});

router.post('/logout-all', (req, res) => {
  q.run('DELETE FROM sessions WHERE user_id = ?', req.user.id);
  auth.destroySession(req, res);
  res.json({ ok: true });
});

router.get('/sessions', (req, res) => {
  const rows = q.all('SELECT user_agent, created_at, expires_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC', req.user.id);
  res.json({ sessions: rows.map((r) => ({ userAgent: r.user_agent, createdAt: r.created_at, expiresAt: r.expires_at })) });
});

router.delete('/', async (req, res) => {
  const ok = await auth.verifyPassword(String(req.body.password || ''), req.user.password_hash);
  if (!ok) throw unauthorized('Password is incorrect');
  if (req.user.is_owner) throw bad('The platform owner account can’t be deleted. Make another admin the owner first.');
  if (req.user.role === 'admin' && q.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").n <= 1)
    throw bad('You are the only administrator. Promote someone else before deleting your account.');
  const videos = q.all('SELECT video_file, thumb_file FROM videos WHERE user_id = ?', req.user.id);
  const avatar = req.user.avatar_url;
  const stories = q.all('SELECT media_file FROM stories WHERE user_id = ?', req.user.id);
  const previews = q.all('SELECT preview_file FROM live_streams WHERE user_id = ? AND preview_file IS NOT NULL', req.user.id);
  tx(() => {
    q.run('DELETE FROM notifications WHERE actor_id = ?', req.user.id);
    q.run('DELETE FROM users WHERE id = ?', req.user.id);
  });
  for (const vid of videos) {
    removeStored(config.dirs.videos, vid.video_file);
    removeStored(config.dirs.thumbs, vid.thumb_file);
  }
  for (const s of stories) removeStored(config.dirs.stories, s.media_file);
  for (const p of previews) removeStored(config.dirs.live, p.preview_file);
  if (avatar && avatar.startsWith('/media/a/')) removeStored(config.dirs.avatars, avatar.slice(9));
  auth.destroySession(req, res);
  res.json({ ok: true });
});

router.get('/blocks', (req, res) => {
  const rows = q.all('SELECT u.* FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC', req.user.id);
  res.json({ users: rows.map(userBrief) });
});

router.get('/follow-requests', (req, res) => {
  const rows = q.all(`SELECT u.*, f.created_at AS requested_at FROM follows f JOIN users u ON u.id = f.follower_id
    WHERE f.followee_id = ? AND f.status = 'pending' ORDER BY f.created_at DESC`, req.user.id);
  res.json({ requests: rows.map((r) => ({ user: userBrief(r), requestedAt: r.requested_at })) });
});

router.post('/follow-requests/:userId/:action', (req, res) => {
  const fid = v.int(req.params.userId, 'user');
  const action = v.oneOf(req.params.action, ['accept', 'decline'], 'Action');
  const row = q.get("SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ? AND status = 'pending'", fid, req.user.id);
  if (!row) throw bad('No pending request from this user');
  if (action === 'accept') {
    q.run("UPDATE follows SET status = 'accepted' WHERE follower_id = ? AND followee_id = ?", fid, req.user.id);
    notify({ userId: fid, actorId: req.user.id, type: 'follow_accept' });
  } else {
    q.run('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?', fid, req.user.id);
  }
  q.run("DELETE FROM notifications WHERE user_id = ? AND actor_id = ? AND type = 'follow_request'", req.user.id, fid);
  res.json({ ok: true });
});

// ---------- Creator moderation: filtered comments ----------
router.get('/filtered-comments', (req, res) => {
  const rows = q.all(`SELECT c.*, u.username, u.display_name, u.avatar_url, v.caption, v.thumb_file, v.updated_at AS v_updated
    FROM comments c JOIN videos v ON v.id = c.video_id JOIN users u ON u.id = c.user_id
    WHERE v.user_id = ? AND c.held = 1 AND c.status = 'active' ORDER BY c.created_at DESC LIMIT 200`, req.user.id);
  res.json({ comments: rows.map((r) => ({
    id: r.id, body: r.body, reason: r.held_reason, createdAt: r.created_at, videoId: r.video_id, videoCaption: r.caption,
    thumbUrl: r.thumb_file ? `/media/t/${r.video_id}?t=${r.v_updated}` : null,
    author: { id: r.user_id, username: r.username, displayName: r.display_name || r.username, avatarUrl: r.avatar_url },
  })) });
});

router.post('/filtered-comments/:id/:action', (req, res) => {
  const action = v.oneOf(req.params.action, ['approve', 'delete'], 'Action');
  const c = q.get('SELECT c.* FROM comments c JOIN videos v ON v.id = c.video_id WHERE c.id = ? AND v.user_id = ? AND c.held = 1', v.int(req.params.id, 'comment'), req.user.id);
  if (!c) throw bad('Comment not found in your review queue');
  if (action === 'approve') {
    q.run('UPDATE comments SET held = 0, held_reason = NULL WHERE id = ?', c.id);
    notify({ userId: req.user.id, actorId: c.user_id, type: 'comment', videoId: c.video_id, commentId: c.id, body: c.body.slice(0, 140) });
  } else q.run('DELETE FROM comments WHERE id = ?', c.id);
  res.json({ ok: true });
});

// ---------- Creator moderation: LIVE moderators & removed viewers ----------
router.get('/live-moderators', (req, res) => {
  const mods = q.all('SELECT u.* FROM live_moderators m JOIN users u ON u.id = m.mod_id WHERE m.host_id = ? ORDER BY m.created_at DESC', req.user.id);
  const banned = q.all('SELECT u.* FROM live_bans b JOIN users u ON u.id = b.user_id WHERE b.host_id = ? ORDER BY b.created_at DESC', req.user.id);
  res.json({ moderators: mods.map(userBrief), banned: banned.map(userBrief) });
});

router.post('/live-moderators', (req, res) => {
  const u = q.get("SELECT * FROM users WHERE username = ? AND status = 'active'", String(req.body.username || '').toLowerCase().replace(/^@/, ''));
  if (!u) throw bad('User not found');
  if (u.id === req.user.id) throw bad('You are already the host');
  const n = q.get('SELECT COUNT(*) AS n FROM live_moderators WHERE host_id = ?', req.user.id).n;
  if (n >= 20) throw bad('You can have up to 20 LIVE moderators');
  q.run('INSERT OR IGNORE INTO live_moderators (host_id, mod_id, created_at) VALUES (?, ?, ?)', req.user.id, u.id, now());
  notify({ userId: u.id, actorId: req.user.id, type: 'live_mod', body: 'made you a LIVE moderator' });
  res.json({ user: userBrief(u) });
});

router.delete('/live-moderators/:userId', (req, res) => {
  q.run('DELETE FROM live_moderators WHERE host_id = ? AND mod_id = ?', req.user.id, v.int(req.params.userId, 'user'));
  res.json({ ok: true });
});

router.delete('/live-bans/:userId', (req, res) => {
  q.run('DELETE FROM live_bans WHERE host_id = ? AND user_id = ?', req.user.id, v.int(req.params.userId, 'user'));
  res.json({ ok: true });
});

module.exports = router;
/**
 * Download everything Clipzy holds about you (UK GDPR Article 15 / 20). Passwords, session tokens
 * and other people's private data are never included.
 */
const exportLimit = require('../lib/rateLimit').limit({ windowMs: 86400000, max: 5, key: (req) => `export:${req.user.id}`, message: 'You can download your data 5 times a day.' });
router.get('/export', exportLimit, (req, res) => {
  const id = req.user.id;
  const u = q.get('SELECT * FROM users WHERE id = ?', id);
  const pick = (row, keys) => Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k]]));
  const data = {
    exportedAt: new Date().toISOString(),
    service: config.appName,
    account: pick(u, ['id', 'username', 'email', 'email_verified', 'display_name', 'bio', 'birth_date', 'avatar_url', 'role', 'is_private', 'allow_messages', 'allow_comments', 'show_liked', 'status', 'created_at', 'terms_accepted_at']),
    videos: q.all('SELECT id, caption, description, visibility, status, is_draft, views, share_count, created_at FROM videos WHERE user_id = ?', id),
    comments: q.all('SELECT id, video_id, body, created_at FROM comments WHERE user_id = ?', id),
    likes: q.all('SELECT video_id, created_at FROM likes WHERE user_id = ?', id),
    following: q.all('SELECT u.username, f.status, f.created_at FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ?', id),
    followers: q.all('SELECT u.username, f.status, f.created_at FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.followee_id = ?', id),
    messagesSent: q.all('SELECT conversation_id, body, video_id, created_at FROM messages WHERE sender_id = ?', id),
    wallet: q.get('SELECT coins, diamonds FROM wallets WHERE user_id = ?', id) || { coins: 0, diamonds: 0 },
    coinTransactions: q.all('SELECT type, coins, diamonds, ref, note, created_at FROM coin_transactions WHERE user_id = ?', id),
    coinOrders: q.all('SELECT id, coins, price_cents, currency, status, created_at, paid_at FROM coin_orders WHERE user_id = ?', id),
    giftsSent: q.all('SELECT receiver_id, stream_id, gift_id, count, coins, created_at FROM gift_events WHERE sender_id = ?', id),
    giftsReceived: q.all('SELECT stream_id, gift_id, count, coins, diamonds, created_at FROM gift_events WHERE receiver_id = ?', id),
    liveStreams: q.all('SELECT id, title, status, started_at, ended_at, peak_viewers, total_likes, diamonds FROM live_streams WHERE user_id = ?', id),
    reportsMade: q.all('SELECT target_type, target_id, reason, status, created_at FROM reports WHERE reporter_id = ?', id),
    sessions: q.all('SELECT user_agent, created_at, expires_at FROM sessions WHERE user_id = ?', id),
    notifications: q.all('SELECT type, actor_id, video_id, body, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1000', id),
  };
  res.setHeader('Content-Disposition', `attachment; filename="clipzy-data-${u.username}.json"`);
  res.type('application/json').send(JSON.stringify(data, null, 2));
});

module.exports.meJson = meJson;
