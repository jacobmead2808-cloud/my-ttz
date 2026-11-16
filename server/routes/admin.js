'use strict';
const express = require('express');
const config = require('../config');
const { q, tx, now } = require('../db');
const v = require('../lib/validate');
const { bad, notFound, forbidden } = require('../lib/errors');
const { requireAdmin } = require('../lib/auth');
const { videoUpload, store, discard, removeStored } = require('../lib/uploads');
const { notify } = require('../lib/notify');
const hub = require('../realtime/hub');
const liveRt = require('../realtime/live');
const { VIDEO_COLUMNS, VIDEO_FROM, serializeVideo, getVideoRow } = require('../lib/serialize');
const { serializeLive } = require('./discover');
const settings = require('../lib/settings');
const automod = require('../lib/automod');
const aiMod = require('../lib/aiMod');
const eco = require('../lib/economy');
const { eligibility } = require('../lib/liveRules');
const VERIFY_KEY = () => process.env.VERIFY_KEY || 'weluvjj';

const router = express.Router();
router.use(requireAdmin); // every admin route is protected server-side

const DAY = 86400000;

/** Owner-only actions (verification badges, admin roles, platform switches). */
function requireOwner(req, _res, next) {
  if (!req.user.is_owner) return next(forbidden('Only the platform owner can do that'));
  next();
}

router.get('/me', (req, res) => res.json({ isOwner: !!req.user.is_owner }));
function audit(req, action, targetType, targetId, note) {
  q.run('INSERT INTO audit_log (admin_id, action, target_type, target_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    req.user.id, action, targetType, targetId, note ? String(note).slice(0, 500) : null, now());
}

router.get('/stats', (_req, res) => {
  const t = now();
  const count = (sql, ...p) => q.get(sql, ...p).n;
  const signups = [];
  for (let i = 13; i >= 0; i--) {
    const start = new Date(t - i * DAY); start.setHours(0, 0, 0, 0);
    const s = start.getTime();
    signups.push({ day: s, users: count('SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?', s, s + DAY),
      videos: count('SELECT COUNT(*) AS n FROM videos WHERE created_at >= ? AND created_at < ?', s, s + DAY) });
  }
  res.json({
    totals: {
      users: count('SELECT COUNT(*) AS n FROM users'),
      activeUsers: count("SELECT COUNT(*) AS n FROM users WHERE status = 'active'"),
      suspended: count("SELECT COUNT(*) AS n FROM users WHERE status = 'suspended'"),
      banned: count("SELECT COUNT(*) AS n FROM users WHERE status = 'banned'"),
      videos: count("SELECT COUNT(*) AS n FROM videos WHERE status = 'active'"),
      removedVideos: count("SELECT COUNT(*) AS n FROM videos WHERE status = 'removed'"),
      comments: count("SELECT COUNT(*) AS n FROM comments WHERE status = 'active'"),
      likes: count('SELECT COUNT(*) AS n FROM likes'),
      views: q.get('SELECT COALESCE(SUM(views), 0) AS n FROM videos').n,
      messages: count('SELECT COUNT(*) AS n FROM messages'),
      openReports: count("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"),
      liveNow: count("SELECT COUNT(*) AS n FROM live_streams WHERE status = 'live'"),
      newUsers7d: count('SELECT COUNT(*) AS n FROM users WHERE created_at > ?', t - 7 * DAY),
      newVideos7d: count('SELECT COUNT(*) AS n FROM videos WHERE created_at > ?', t - 7 * DAY),
    },
    daily: signups,
  });
});

// ---------- Users ----------
function adminUser(r) {
  return {
    id: r.id, username: r.username, email: r.email, displayName: r.display_name, avatarUrl: r.avatar_url, role: r.role,
    status: r.status, suspendedUntil: r.suspended_until, statusReason: r.status_reason, verified: !!r.is_verified,
    isOwner: !!r.is_owner, commentBanned: !!r.comment_banned,
    isPrivate: !!r.is_private, liveBanned: !!r.live_banned, createdAt: r.created_at,
    videos: r.video_count, followers: r.follower_count, reports: r.report_count,
  };
}

router.get('/users', (req, res) => {
  const term = v.str(req.query.q, { name: 'Search', max: 100 });
  const status = ['active', 'suspended', 'banned'].includes(req.query.status) ? req.query.status : null;
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const rows = q.all(`SELECT u.*,
      (SELECT COUNT(*) FROM videos v WHERE v.user_id = u.id) AS video_count,
      (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id AND f.status = 'accepted') AS follower_count,
      (SELECT COUNT(*) FROM reports r WHERE r.target_type = 'user' AND r.target_id = u.id AND r.status = 'open') AS report_count
    FROM users u WHERE (:like IS NULL OR u.username LIKE :like ESCAPE '\\' OR u.email LIKE :like ESCAPE '\\' OR u.display_name LIKE :like ESCAPE '\\')
      AND (:status IS NULL OR u.status = :status)
    ORDER BY u.created_at DESC LIMIT 51 OFFSET :offset`, { like: term ? `%${v.likeEscape(term)}%` : null, status, offset });
  res.json({ users: rows.slice(0, 50).map(adminUser), hasMore: rows.length > 50 });
});

function targetUser(req) {
  const u = q.get('SELECT * FROM users WHERE id = ?', v.int(req.params.id, 'user'));
  if (!u) throw notFound('User not found');
  if (u.id === req.user.id) throw bad('You cannot moderate your own account');
  if (u.is_owner) throw forbidden('The platform owner cannot be moderated');
  return u;
}

function endUserActivity(u) {
  q.run('DELETE FROM sessions WHERE user_id = ?', u.id);
  hub.disconnectUser(u.id);
  for (const s of q.all("SELECT id FROM live_streams WHERE user_id = ? AND status = 'live'", u.id)) liveRt.endStream(s.id, 'account_restricted');
}

router.post('/users/:id/suspend', (req, res) => {
  const u = targetUser(req);
  if (u.role === 'admin') throw bad('Demote this administrator before suspending them');
  const days = Math.min(Math.max(Number(req.body.days) || 7, 1), 365);
  const reason = v.str(req.body.reason, { name: 'Reason', max: 300 });
  q.run("UPDATE users SET status = 'suspended', suspended_until = ?, status_reason = ? WHERE id = ?", now() + days * DAY, reason || null, u.id);
  aiMod.strike(u.id, 'suspension', `${days}d: ${reason || 'No reason given'}`, { byId: req.user.id, expiresAt: now() + days * DAY });
  endUserActivity(u);
  audit(req, 'user.suspend', 'user', u.id, `${days}d ${reason}`);
  res.json({ ok: true });
});

router.post('/users/:id/ban', (req, res) => {
  const u = targetUser(req);
  if (u.role === 'admin') throw bad('Demote this administrator before banning them');
  const reason = v.str(req.body.reason, { name: 'Reason', max: 300 });
  q.run("UPDATE users SET status = 'banned', suspended_until = NULL, status_reason = ? WHERE id = ?", reason || null, u.id);
  aiMod.strike(u.id, 'ban', reason || 'No reason given', { byId: req.user.id });
  endUserActivity(u);
  audit(req, 'user.ban', 'user', u.id, reason);
  res.json({ ok: true });
});

router.post('/users/:id/restore', (req, res) => {
  const u = targetUser(req);
  q.run("UPDATE users SET status = 'active', suspended_until = NULL, status_reason = NULL WHERE id = ?", u.id);
  aiMod.strike(u.id, 'restore', v.str(req.body.reason, { name: 'Reason', max: 300 }) || 'Restored by staff', { byId: req.user.id });
  audit(req, 'user.restore', 'user', u.id);
  res.json({ ok: true });
});

router.post('/users/:id/role', requireOwner, (req, res) => {
  const u = targetUser(req);
  const role = v.oneOf(req.body.role, ['user', 'admin'], 'Role');
  q.run('UPDATE users SET role = ? WHERE id = ?', role, u.id);
  audit(req, 'user.role', 'user', u.id, role);
  res.json({ ok: true });
});

router.post('/users/:id/flags', (req, res) => {
  const u = q.get('SELECT * FROM users WHERE id = ?', v.int(req.params.id, 'user'));
  if (!u) throw notFound('User not found');
  if (req.body.verified !== undefined) {
    if (!req.user.is_owner) throw forbidden('Only the platform owner can give or remove verified badges');
    if (String(req.body.key || '') !== VERIFY_KEY()) throw forbidden('Wrong verification key');
    const on = v.bool(req.body.verified);
    q.run('UPDATE users SET is_verified = ? WHERE id = ?', on ? 1 : 0, u.id);
    if (on) notify({ userId: u.id, actorId: null, type: 'verified', body: 'Your account is now verified' });
  }
  if (req.body.commentBanned !== undefined) {
    if (u.is_owner || (u.role === 'admin' && !req.user.is_owner)) throw forbidden('You cannot restrict this account');
    q.run('UPDATE users SET comment_banned = ? WHERE id = ?', v.bool(req.body.commentBanned) ? 1 : 0, u.id);
  }
  if (req.body.liveBanned !== undefined) {
    const on = v.bool(req.body.liveBanned);
    q.run('UPDATE users SET live_banned = ? WHERE id = ?', on ? 1 : 0, u.id);
    if (on) for (const s of q.all("SELECT id FROM live_streams WHERE user_id = ? AND status = 'live'", u.id)) liveRt.endStream(s.id, 'live_restricted');
  }
  audit(req, 'user.flags', 'user', u.id, JSON.stringify(req.body));
  res.json({ ok: true });
});

router.post('/users/:id/logout', (req, res) => {
  const u = targetUser(req);
  q.run('DELETE FROM sessions WHERE user_id = ?', u.id);
  hub.disconnectUser(u.id);
  audit(req, 'user.logout', 'user', u.id);
  res.json({ ok: true });
});

router.post('/users/:id/purge-comments', (req, res) => {
  const u = targetUser(req);
  const r = q.run("UPDATE comments SET status = 'removed' WHERE user_id = ? AND status = 'active'", u.id);
  q.run('UPDATE live_messages SET deleted = 1 WHERE user_id = ?', u.id);
  audit(req, 'user.purge_comments', 'user', u.id, `${r.changes} comments`);
  res.json({ removed: r.changes });
});

router.post('/users/:id/reset-profile', (req, res) => {
  const u = targetUser(req);
  q.run("UPDATE users SET display_name = username, bio = '', avatar_url = NULL WHERE id = ?", u.id);
  notify({ userId: u.id, actorId: null, type: 'moderation', body: 'Your profile was reset by a moderator for breaking community guidelines.' });
  audit(req, 'user.reset_profile', 'user', u.id);
  res.json({ ok: true });
});

// ---------- User dossier (moderation profile) ----------
router.get('/users/:id/dossier', (req, res) => {
  const u = q.get('SELECT * FROM users WHERE id = ?', v.int(req.params.id, 'user'));
  if (!u) throw notFound('User not found');
  const a = aiMod.assess(u.id);
  const c = (sql, ...p) => q.get(sql, ...p).n;
  const stats = {
    followers: c("SELECT COUNT(*) AS n FROM follows WHERE followee_id = ? AND status = 'accepted'", u.id),
    following: c("SELECT COUNT(*) AS n FROM follows WHERE follower_id = ? AND status = 'accepted'", u.id),
    videos: c("SELECT COUNT(*) AS n FROM videos WHERE user_id = ?", u.id),
    removedVideos: c("SELECT COUNT(*) AS n FROM videos WHERE user_id = ? AND status = 'removed'", u.id),
    comments: c('SELECT COUNT(*) AS n FROM comments WHERE user_id = ?', u.id),
    removedComments: c("SELECT COUNT(*) AS n FROM comments WHERE user_id = ? AND status = 'removed'", u.id),
    reportsAgainst: c("SELECT COUNT(*) AS n FROM reports WHERE (target_type = 'user' AND target_id = ?) OR (target_type = 'video' AND target_id IN (SELECT id FROM videos WHERE user_id = ?)) OR (target_type = 'comment' AND target_id IN (SELECT id FROM comments WHERE user_id = ?))", u.id, u.id, u.id),
    reportsFiled: c('SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ?', u.id),
    likesReceived: c('SELECT COUNT(*) AS n FROM likes l JOIN videos v ON v.id = l.video_id WHERE v.user_id = ?', u.id),
    lives: c('SELECT COUNT(*) AS n FROM live_streams WHERE user_id = ?', u.id),
    giftsReceivedCoins: c('SELECT COALESCE(SUM(coins), 0) AS n FROM gift_events WHERE receiver_id = ?', u.id),
    giftsSentCoins: c('SELECT COALESCE(SUM(coins), 0) AS n FROM gift_events WHERE sender_id = ?', u.id),
  };
  const videos = q.all(`SELECT ${VIDEO_COLUMNS} ${VIDEO_FROM} WHERE v.user_id = :uid ORDER BY v.created_at DESC LIMIT 12`, { uid: u.id, me: req.user.id })
    .map((r) => ({ ...serializeVideo(r, req.user), removedReason: r.removed_reason }));
  const comments = q.all('SELECT c.*, v.caption FROM comments c JOIN videos v ON v.id = c.video_id WHERE c.user_id = ? ORDER BY c.id DESC LIMIT 15', u.id)
    .map((x) => ({ id: x.id, body: x.body, status: x.status, held: !!x.held, videoId: x.video_id, videoCaption: x.caption, createdAt: x.created_at }));
  const reports = q.all(`SELECT r.*, rp.username AS reporter FROM reports r LEFT JOIN users rp ON rp.id = r.reporter_id
    WHERE (r.target_type = 'user' AND r.target_id = :u) OR (r.target_type = 'video' AND r.target_id IN (SELECT id FROM videos WHERE user_id = :u))
      OR (r.target_type = 'comment' AND r.target_id IN (SELECT id FROM comments WHERE user_id = :u)) OR (r.target_type = 'live' AND r.target_id IN (SELECT id FROM live_streams WHERE user_id = :u))
    ORDER BY r.id DESC LIMIT 20`, { u: u.id })
    .map((r) => ({ id: r.id, targetType: r.target_type, targetId: r.target_id, reason: r.reason, details: r.details, status: r.status, reporter: r.reporter, createdAt: r.created_at }));
  const strikes = q.all('SELECT s.*, b.username AS by_username FROM user_strikes s LEFT JOIN users b ON b.id = s.by_id WHERE s.user_id = ? ORDER BY s.id DESC LIMIT 50', u.id)
    .map((s) => ({ id: s.id, kind: s.kind, reason: s.reason, by: s.auto ? 'Guardian (auto)' : s.by_username ? `@${s.by_username}` : 'system', auto: !!s.auto, expiresAt: s.expires_at, createdAt: s.created_at }));
  const automodHits = q.all('SELECT * FROM automod_log WHERE user_id = ? ORDER BY id DESC LIMIT 20', u.id)
    .map((x) => ({ id: x.id, context: x.context, content: x.content, rule: x.rule, action: x.action, createdAt: x.created_at }));
  const cases = q.all('SELECT * FROM mod_cases WHERE user_id = ? ORDER BY id DESC LIMIT 10', u.id).map(serializeCase);
  const lives = q.all('SELECT * FROM live_streams WHERE user_id = ? ORDER BY id DESC LIMIT 10', u.id)
    .map((s) => ({ id: s.id, title: s.title, status: s.status, startedAt: s.started_at, endedAt: s.ended_at, peak: s.peak_viewers, likes: s.total_likes, diamonds: s.diamonds, isTrial: !!s.is_trial, endedReason: s.ended_reason }));
  const transactions = q.all('SELECT * FROM coin_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 20', u.id)
    .map((t) => ({ id: t.id, type: t.type, coins: t.coins, diamonds: t.diamonds, note: t.note, ref: t.ref, createdAt: t.created_at }));
  res.json({
    user: { ...adminUser({ ...u, video_count: stats.videos, follower_count: stats.followers, report_count: stats.reportsAgainst }), bio: u.bio, riskScore: u.risk_score, riskUpdatedAt: u.risk_updated_at,
      liveAccess: !!q.get('SELECT 1 FROM live_access WHERE user_id = ?', u.id) },
    risk: { score: a.score, signals: a.signals, summary: a.summary, protectedUser: a.protectedUser },
    stats, videos, comments, reports, strikes, automodHits, cases, lives, wallet: eco.wallet(u.id), transactions,
    liveEligibility: eligibility(u),
  });
});

router.post('/users/:id/warn', (req, res) => {
  const u = targetUser(req);
  const reason = v.str(req.body.reason, { name: 'Reason', required: true, max: 300 });
  aiMod.strike(u.id, 'warning', reason, { byId: req.user.id });
  notify({ userId: u.id, actorId: null, type: 'moderation', body: `Warning from the moderation team: ${reason}` });
  audit(req, 'user.warn', 'user', u.id, reason);
  res.json({ ok: true });
});

router.post('/users/:id/note', (req, res) => {
  const u = q.get('SELECT id FROM users WHERE id = ?', v.int(req.params.id, 'user'));
  if (!u) throw notFound('User not found');
  aiMod.strike(u.id, 'note', v.str(req.body.note, { name: 'Note', required: true, max: 500 }), { byId: req.user.id });
  res.json({ ok: true });
});

router.post('/users/:id/assess', async (req, res) => {
  const a = await aiMod.review(v.int(req.params.id, 'user'), { force: true });
  if (!a) throw notFound('User not found');
  audit(req, 'guardian.assess', 'user', a.user.id, `${a.score} → ${a.action}`);
  res.json({ score: a.score, signals: a.signals, summary: a.summary, action: a.action });
});

router.post('/users/:id/verify', (req, res) => {
  if (!req.user.is_owner) throw forbidden('Only the platform owner can give or remove verified badges');
  if (String(req.body.key || '') !== VERIFY_KEY()) throw forbidden('Wrong verification key');
  const u = q.get('SELECT * FROM users WHERE id = ?', v.int(req.params.id, 'user'));
  if (!u) throw notFound('User not found');
  const on = req.body.verified === undefined ? true : v.bool(req.body.verified);
  q.run('UPDATE users SET is_verified = ? WHERE id = ?', on ? 1 : 0, u.id);
  if (on) notify({ userId: u.id, actorId: null, type: 'verified', body: 'Your account is now verified' });
  aiMod.strike(u.id, 'note', on ? 'Verified by the owner' : 'Verification removed', { byId: req.user.id });
  audit(req, on ? 'user.verify' : 'user.unverify', 'user', u.id);
  res.json({ verified: on });
});

router.post('/users/:id/live-access', (req, res) => {
  const u = q.get('SELECT id FROM users WHERE id = ?', v.int(req.params.id, 'user'));
  if (!u) throw notFound('User not found');
  if (v.bool(req.body.grant)) q.run('INSERT OR IGNORE INTO live_access (user_id, granted_by, created_at) VALUES (?, ?, ?)', u.id, req.user.id, now());
  else q.run('DELETE FROM live_access WHERE user_id = ?', u.id);
  audit(req, 'user.live_access', 'user', u.id, String(v.bool(req.body.grant)));
  res.json({ ok: true });
});

router.post('/users/:id/coins', requireOwner, (req, res) => {
  const u = q.get('SELECT id FROM users WHERE id = ?', v.int(req.params.id, 'user'));
  if (!u) throw notFound('User not found');
  const amount = Number(req.body.coins);
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000000) throw bad('Enter a whole number of coins (negative to remove)');
  const wallet = eco.adjust(u.id, { coins: amount, type: amount > 0 ? 'admin_grant' : 'admin_remove', note: v.str(req.body.note, { name: 'Note', max: 200 }) || 'Adjusted by owner' });
  audit(req, 'user.coins', 'user', u.id, String(amount));
  res.json({ wallet });
});

// ---------- Guardian cases (AI escalations) ----------
function serializeCase(r) {
  let signals = [];
  try { signals = JSON.parse(r.signals || '[]'); } catch { /* ignore */ }
  return { id: r.id, userId: r.user_id, status: r.status, severity: r.severity, source: r.source, summary: r.summary, signals, autoAction: r.auto_action,
    resolution: r.resolution, createdAt: r.created_at, resolvedAt: r.resolved_at, username: r.username, avatarUrl: r.avatar_url, userStatus: r.ustatus, resolver: r.resolver };
}

router.get('/cases', (req, res) => {
  const status = req.query.status === 'resolved' ? 'resolved' : 'open';
  const rows = q.all(`SELECT c.*, u.username, u.avatar_url, u.status AS ustatus, r.username AS resolver FROM mod_cases c JOIN users u ON u.id = c.user_id
    LEFT JOIN users r ON r.id = c.resolved_by WHERE c.status = ? ORDER BY CASE c.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, c.id DESC LIMIT 100`, status);
  res.json({ cases: rows.map(serializeCase) });
});

router.post('/cases/:id/resolve', (req, res) => {
  const c = q.get('SELECT * FROM mod_cases WHERE id = ?', v.int(req.params.id, 'case'));
  if (!c) throw notFound('Case not found');
  const action = v.oneOf(req.body.action, ['uphold', 'lift', 'warn', 'suspend', 'ban', 'dismiss'], 'Action');
  const note = v.str(req.body.note, { name: 'Note', max: 500 });
  const u = q.get('SELECT * FROM users WHERE id = ?', c.user_id);
  if (u.is_owner && ['suspend', 'ban'].includes(action)) throw forbidden('The owner cannot be moderated');
  if (action === 'lift' || action === 'dismiss') {
    if (u.status === 'suspended') q.run("UPDATE users SET status = 'active', suspended_until = NULL, status_reason = NULL WHERE id = ?", u.id);
    if (action === 'dismiss') q.run('UPDATE users SET risk_score = 0 WHERE id = ?', u.id);
    aiMod.strike(u.id, 'restore', `Case #${c.id}: ${action === 'dismiss' ? 'false positive' : 'suspension lifted'}${note ? ' — ' + note : ''}`, { byId: req.user.id });
  } else if (action === 'warn') {
    aiMod.strike(u.id, 'warning', note || c.summary, { byId: req.user.id });
    notify({ userId: u.id, actorId: null, type: 'moderation', body: `Warning from the moderation team: ${note || 'please follow the community guidelines.'}` });
  } else if (action === 'suspend') {
    const days = Math.min(Math.max(Number(req.body.days) || 7, 1), 365);
    q.run("UPDATE users SET status = 'suspended', suspended_until = ?, status_reason = ? WHERE id = ?", now() + days * DAY, note || c.summary, u.id);
    aiMod.strike(u.id, 'suspension', `${days}d: ${note || c.summary}`, { byId: req.user.id, expiresAt: now() + days * DAY });
    endUserActivity(u);
  } else if (action === 'ban') {
    q.run("UPDATE users SET status = 'banned', status_reason = ? WHERE id = ?", note || c.summary, u.id);
    aiMod.strike(u.id, 'ban', note || c.summary, { byId: req.user.id });
    endUserActivity(u);
  }
  q.run("UPDATE mod_cases SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ?", `${action}${note ? ': ' + note : ''}`, req.user.id, now(), c.id);
  audit(req, `case.${action}`, 'user', u.id, `case #${c.id}`);
  res.json({ ok: true });
});

router.post('/guardian/sweep', async (req, res) => {
  const n = await aiMod.sweep();
  audit(req, 'guardian.sweep', null, null, `${n} accounts`);
  res.json({ reviewed: n });
});

router.get('/guardian', (_req, res) => {
  const t = now();
  res.json({
    config: settings.get('guardian'),
    aiProvider: process.env.AI_MODERATION === 'openai' && process.env.OPENAI_API_KEY ? 'openai' : 'rules',
    stats: {
      openCases: q.get("SELECT COUNT(*) AS n FROM mod_cases WHERE status = 'open'").n,
      autoSuspensions24h: q.get("SELECT COUNT(*) AS n FROM user_strikes WHERE auto = 1 AND kind = 'suspension' AND created_at > ?", t - DAY).n,
      autoWarnings24h: q.get("SELECT COUNT(*) AS n FROM user_strikes WHERE auto = 1 AND kind = 'warning' AND created_at > ?", t - DAY).n,
      riskyUsers: q.get('SELECT COUNT(*) AS n FROM users WHERE risk_score >= 30').n,
    },
    riskiest: q.all("SELECT id, username, avatar_url, risk_score, status FROM users WHERE risk_score > 0 ORDER BY risk_score DESC LIMIT 8")
      .map((r) => ({ id: r.id, username: r.username, avatarUrl: r.avatar_url, riskScore: r.risk_score, status: r.status })),
  });
});

router.patch('/guardian', requireOwner, (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.enabled !== undefined) patch.enabled = v.bool(b.enabled);
  for (const k of ['warnAt', 'reviewAt', 'suspendAt', 'suspendHours']) if (b[k] !== undefined) {
    const n = Number(b[k]);
    if (!Number.isFinite(n) || n < 1 || n > (k === 'suspendHours' ? 720 : 100)) throw bad(`${k} is out of range`);
    patch[k] = n;
  }
  const config = settings.set('guardian', patch);
  audit(req, 'guardian.update', null, null, JSON.stringify(patch));
  res.json({ config });
});

// ---------- Economy (owner) ----------
router.get('/economy', (_req, res) => {
  const t = now();
  res.json({
    config: eco.economy(),
    gifts: eco.catalog(),
    packages: eco.packages(),
    paymentMode: require('./coins').paymentMode(),
    stats: {
      coinsSold: q.get("SELECT COALESCE(SUM(coins), 0) AS n FROM coin_orders WHERE status = 'paid'").n,
      revenueCents: q.get("SELECT COALESCE(SUM(price_cents), 0) AS n FROM coin_orders WHERE status = 'paid' AND provider = 'stripe'").n,
      giftsSent7d: q.get('SELECT COALESCE(SUM(count), 0) AS n FROM gift_events WHERE created_at > ?', t - 7 * DAY).n,
      coinsGifted7d: q.get('SELECT COALESCE(SUM(coins), 0) AS n FROM gift_events WHERE created_at > ?', t - 7 * DAY).n,
    },
  });
});

router.patch('/economy', requireOwner, (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.discountPercent !== undefined) {
    const d = Number(b.discountPercent);
    if (!Number.isFinite(d) || d < 0 || d > 90) throw bad('Discount must be 0–90%');
    patch.discountPercent = Math.round(d);
  }
  if (b.discountLabel !== undefined) patch.discountLabel = v.str(b.discountLabel, { name: 'Label', max: 60 });
  if (b.giftsEnabled !== undefined) patch.giftsEnabled = v.bool(b.giftsEnabled);
  if (b.disabledGifts !== undefined) {
    if (!Array.isArray(b.disabledGifts)) throw bad('disabledGifts must be a list');
    patch.disabledGifts = b.disabledGifts.filter((x) => eco.GIFTS.some((g) => g.id === x));
  }
  if (b.diamondRate !== undefined) {
    const r = Number(b.diamondRate);
    if (!Number.isFinite(r) || r < 0 || r > 1) throw bad('Diamond rate must be between 0 and 1');
    patch.diamondRate = r;
  }
  if (b.packages !== undefined) {
    if (!Array.isArray(b.packages) || !b.packages.length || b.packages.length > 12) throw bad('Provide 1–12 packages');
    patch.packages = b.packages.map((p) => ({ coins: v.int(p.coins, 'coins'), priceCents: v.int(p.priceCents, 'price') })).sort((a, z) => a.coins - z.coins);
  }
  const config = settings.set('economy', patch);
  audit(req, 'economy.update', null, null, JSON.stringify(patch).slice(0, 300));
  res.json({ config, packages: eco.packages() });
});

router.get('/live-rules', (_req, res) => res.json({ rules: settings.get('liveRules') }));
router.patch('/live-rules', requireOwner, (req, res) => {
  const patch = {};
  for (const k of Object.keys(settings.DEFAULTS.liveRules)) if (req.body[k] !== undefined) {
    const n = Number(req.body[k]);
    if (!Number.isFinite(n) || n < 0 || n > 1000000) throw bad(`${k} is out of range`);
    patch[k] = n;
  }
  const rules = settings.set('liveRules', patch);
  audit(req, 'live_rules.update', null, null, JSON.stringify(patch));
  res.json({ rules });
});

// ---------- Auto-moderation ----------
router.get('/automod', (_req, res) => {
  const counts = q.all('SELECT rule, COUNT(*) AS n FROM automod_log WHERE created_at > ? GROUP BY rule', now() - 7 * DAY);
  res.json({ config: settings.get('automod'), last7d: counts });
});

router.patch('/automod', (req, res) => {
  const b = req.body || {};
  const patch = {};
  const num = (k, min, max) => { if (b[k] !== undefined) { const n = Number(b[k]); if (!Number.isFinite(n) || n < min || n > max) throw bad(`${k} must be between ${min} and ${max}`); patch[k] = n; } };
  for (const k of ['enabled', 'blockLinks', 'capsFilter']) if (b[k] !== undefined) patch[k] = v.bool(b[k]);
  if (b.action !== undefined) patch.action = v.oneOf(b.action, ['hold', 'block'], 'Action');
  num('maxMentions', 0, 50); num('repeatLimit', 0, 20); num('autoHideReports', 0, 100); num('newAccountMinutes', 0, 10080); num('linkMinAgeHours', 0, 8760);
  if (b.blockedWords !== undefined) {
    if (!Array.isArray(b.blockedWords)) throw bad('blockedWords must be a list');
    patch.blockedWords = [...new Set(b.blockedWords.map((w) => v.str(w, { name: 'Word', max: 60 }).toLowerCase()).filter(Boolean))].slice(0, 1000);
  }
  const config = settings.set('automod', patch);
  audit(req, 'automod.update', null, null, Object.keys(patch).join(', '));
  res.json({ config });
});

router.get('/automod/log', (req, res) => {
  const rows = q.all(`SELECT a.*, u.username, o.username AS owner_username FROM automod_log a LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN users o ON o.id = a.target_owner_id ORDER BY a.id DESC LIMIT 200`);
  res.json({ entries: rows.map((r) => ({ id: r.id, username: r.username, userId: r.user_id, context: r.context, content: r.content, rule: r.rule, action: r.action, owner: r.owner_username, createdAt: r.created_at })) });
});

router.post('/automod/test', (req, res) => {
  const text = v.str(req.body.text, { name: 'Text', required: true, max: 500 });
  const cfg = settings.get('automod');
  const word = automod.findWord(text, cfg.blockedWords);
  res.json({ normalized: automod.normalize(text), matched: word });
});

// ---------- Platform (owner) ----------
router.get('/platform', (_req, res) => res.json({ platform: settings.get('platform') }));

router.patch('/platform', requireOwner, (req, res) => {
  const b = req.body || {};
  const patch = {};
  for (const k of ['registrationsOpen', 'uploadsEnabled', 'liveEnabled']) if (b[k] !== undefined) patch[k] = v.bool(b[k]);
  if (b.announcement !== undefined) patch.announcement = v.str(b.announcement, { name: 'Announcement', max: 280 });
  const platform = settings.set('platform', patch);
  audit(req, 'platform.update', null, null, JSON.stringify(patch).slice(0, 300));
  res.json({ platform });
});

router.post('/announce', (req, res) => {
  const message = v.str(req.body.message, { name: 'Message', required: true, max: 280 });
  const users = q.all("SELECT id FROM users WHERE status = 'active' AND id <> ?", req.user.id);
  for (const u of users) notify({ userId: u.id, actorId: req.user.id, type: 'announcement', body: message });
  audit(req, 'announce', null, null, message);
  res.json({ sent: users.length });
});

// ---------- Videos ----------
router.get('/videos', (req, res) => {
  const term = v.str(req.query.q, { name: 'Search', max: 100 });
  const status = ['active', 'removed'].includes(req.query.status) ? req.query.status : null;
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const rows = q.all(`SELECT ${VIDEO_COLUMNS},
      (SELECT COUNT(*) FROM reports r WHERE r.target_type = 'video' AND r.target_id = v.id AND r.status = 'open') AS report_count
    ${VIDEO_FROM} WHERE (:like IS NULL OR v.caption LIKE :like ESCAPE '\\' OR u.username LIKE :like ESCAPE '\\')
      AND (:status IS NULL OR v.status = :status)
    ORDER BY v.created_at DESC LIMIT 41 OFFSET :offset`, { me: req.user.id, like: term ? `%${v.likeEscape(term)}%` : null, status, offset });
  res.json({ videos: rows.slice(0, 40).map((r) => ({ ...serializeVideo(r, req.user), reports: r.report_count, removedReason: r.removed_reason })), hasMore: rows.length > 40 });
});

function removeVideo(req, id, reason) {
  const row = getVideoRow(id, req.user.id);
  if (!row) throw notFound('Video not found');
  q.run("UPDATE videos SET status = 'removed', removed_reason = ?, updated_at = ? WHERE id = ?", reason || 'Community guidelines violation', now(), id);
  notify({ userId: row.user_id, actorId: null, type: 'moderation', videoId: id, body: `Your video was removed: ${reason || 'Community guidelines violation'}` });
  audit(req, 'video.remove', 'video', id, reason);
}

router.post('/videos/:id/remove', (req, res) => {
  removeVideo(req, v.int(req.params.id, 'video'), v.str(req.body.reason, { name: 'Reason', max: 300 }));
  res.json({ ok: true });
});

router.post('/videos/:id/restore', (req, res) => {
  const id = v.int(req.params.id, 'video');
  q.run("UPDATE videos SET status = 'active', removed_reason = NULL, updated_at = ? WHERE id = ?", now(), id);
  audit(req, 'video.restore', 'video', id);
  res.json({ ok: true });
});

router.delete('/videos/:id', (req, res) => {
  const row = getVideoRow(v.int(req.params.id, 'video'), req.user.id);
  if (!row) throw notFound('Video not found');
  q.run('DELETE FROM videos WHERE id = ?', row.id);
  removeStored(config.dirs.videos, row.video_file);
  removeStored(config.dirs.thumbs, row.thumb_file);
  audit(req, 'video.delete', 'video', row.id, row.caption.slice(0, 100));
  res.json({ ok: true });
});

/** Upload generated demo content on behalf of a (random or given) non-admin user. */
router.post('/demo-videos', videoUpload, (req, res) => {
  const files = req.files || {};
  const videoFile = files.video && files.video[0];
  const thumbFile = files.thumbnail && files.thumbnail[0];
  try {
    if (!videoFile) throw bad('Missing video');
    const owner = req.body.username
      ? q.get('SELECT * FROM users WHERE username = ?', String(req.body.username).toLowerCase())
      : q.get("SELECT * FROM users WHERE role = 'user' AND status = 'active' AND is_private = 0 ORDER BY RANDOM() LIMIT 1");
    if (!owner) throw bad('No demo users exist. Run `npm run seed` first.');
    const caption = v.str(req.body.caption, { name: 'Caption', max: 300 });
    const soundId = req.body.soundId && q.get('SELECT id FROM sounds WHERE id = ?', Number(req.body.soundId)) ? Number(req.body.soundId) : null;
    const vid = store(videoFile, 'video', config.dirs.videos);
    const thumb = thumbFile ? store(thumbFile, 'image', config.dirs.thumbs) : null;
    const t = now() - Math.floor(Math.random() * 5 * DAY);
    const id = tx(() => {
      const r = q.run(`INSERT INTO videos (user_id, caption, video_file, video_mime, thumb_file, sound_id, duration, width, height, views, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, owner.id, caption, vid.name, vid.mime, thumb ? thumb.name : null, soundId,
      Number(req.body.duration) || 0, Number(req.body.width) || null, Number(req.body.height) || null, Math.floor(Math.random() * 5000), t, t);
      const newId = Number(r.lastInsertRowid);
      for (const tag of v.extractHashtags(caption)) {
        q.run('INSERT OR IGNORE INTO hashtags (tag) VALUES (?)', tag);
        q.run('INSERT OR IGNORE INTO video_hashtags (video_id, hashtag_id) SELECT ?, id FROM hashtags WHERE tag = ?', newId, tag);
      }
      // sprinkle some likes from other demo users
      const likers = q.all("SELECT id FROM users WHERE id <> ? AND role = 'user' ORDER BY RANDOM() LIMIT ?", owner.id, Math.floor(Math.random() * 8));
      for (const l of likers) q.run('INSERT OR IGNORE INTO likes (user_id, video_id, created_at) VALUES (?, ?, ?)', l.id, newId, t + 1000);
      return newId;
    });
    audit(req, 'demo.upload', 'video', id, owner.username);
    res.status(201).json({ video: serializeVideo(getVideoRow(id, req.user.id), req.user), file: vid.name, thumb: thumb ? thumb.name : null });
  } catch (e) {
    discard(videoFile, thumbFile);
    throw e;
  }
});

// ---------- Comments ----------
router.get('/comments', (req, res) => {
  const term = v.str(req.query.q, { name: 'Search', max: 100 });
  const rows = q.all(`SELECT c.*, u.username, v.caption,
      (SELECT COUNT(*) FROM reports r WHERE r.target_type = 'comment' AND r.target_id = c.id AND r.status = 'open') AS report_count
    FROM comments c JOIN users u ON u.id = c.user_id JOIN videos v ON v.id = c.video_id
    WHERE (:like IS NULL OR c.body LIKE :like ESCAPE '\\' OR u.username LIKE :like ESCAPE '\\')
    ORDER BY c.created_at DESC LIMIT 60`, { like: term ? `%${v.likeEscape(term)}%` : null });
  res.json({ comments: rows.map((r) => ({ id: r.id, body: r.body, status: r.status, videoId: r.video_id, videoCaption: r.caption, username: r.username, createdAt: r.created_at, reports: r.report_count })) });
});

router.post('/comments/:id/remove', (req, res) => {
  const id = v.int(req.params.id, 'comment');
  q.run("UPDATE comments SET status = 'removed' WHERE id = ?", id);
  audit(req, 'comment.remove', 'comment', id);
  res.json({ ok: true });
});

router.post('/comments/:id/restore', (req, res) => {
  const id = v.int(req.params.id, 'comment');
  q.run("UPDATE comments SET status = 'active' WHERE id = ?", id);
  audit(req, 'comment.restore', 'comment', id);
  res.json({ ok: true });
});

// ---------- Reports ----------
function describeTarget(r) {
  switch (r.target_type) {
    case 'user': {
      const u = q.get('SELECT id, username, status FROM users WHERE id = ?', r.target_id);
      return u ? { label: `@${u.username}`, link: `/@${u.username}`, status: u.status, ownerId: u.id } : null;
    }
    case 'video': {
      const vv = q.get('SELECT v.id, v.caption, v.status, v.user_id, u.username FROM videos v JOIN users u ON u.id = v.user_id WHERE v.id = ?', r.target_id);
      return vv ? { label: vv.caption || `Video #${vv.id}`, link: `/video/${vv.id}`, status: vv.status, ownerId: vv.user_id, owner: vv.username, thumbUrl: `/media/t/${vv.id}` } : null;
    }
    case 'comment': {
      const c = q.get('SELECT c.id, c.body, c.status, c.user_id, c.video_id, u.username FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?', r.target_id);
      return c ? { label: c.body, link: `/video/${c.video_id}`, status: c.status, ownerId: c.user_id, owner: c.username } : null;
    }
    case 'live': {
      const s = q.get('SELECT ls.id, ls.title, ls.status, ls.user_id, u.username FROM live_streams ls JOIN users u ON u.id = ls.user_id WHERE ls.id = ?', r.target_id);
      return s ? { label: s.title, link: `/live/${s.id}`, status: s.status, ownerId: s.user_id, owner: s.username } : null;
    }
  }
  return null;
}

router.get('/reports', (req, res) => {
  const status = ['open', 'resolved', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
  const rows = q.all(`SELECT r.*, u.username AS reporter, a.username AS resolver FROM reports r
    LEFT JOIN users u ON u.id = r.reporter_id LEFT JOIN users a ON a.id = r.resolved_by
    WHERE r.status = ? ORDER BY r.created_at DESC LIMIT 100`, status);
  res.json({
    reports: rows.map((r) => ({
      id: r.id, targetType: r.target_type, targetId: r.target_id, reason: r.reason, details: r.details, status: r.status,
      reporter: r.reporter, resolver: r.resolver, resolution: r.resolution, createdAt: r.created_at, resolvedAt: r.resolved_at,
      target: describeTarget(r),
    })),
  });
});

router.post('/reports/:id/resolve', (req, res) => {
  const r = q.get('SELECT * FROM reports WHERE id = ?', v.int(req.params.id, 'report'));
  if (!r) throw notFound('Report not found');
  const action = v.oneOf(req.body.action, ['dismiss', 'remove_content', 'suspend_user', 'ban_user', 'no_action'], 'Action');
  const note = v.str(req.body.note, { name: 'Note', max: 500 });
  const target = describeTarget(r);
  tx(() => {
    if (action === 'remove_content') {
      if (r.target_type === 'video') removeVideo(req, r.target_id, note || `Removed after report: ${r.reason}`);
      else if (r.target_type === 'comment') q.run("UPDATE comments SET status = 'removed' WHERE id = ?", r.target_id);
      else if (r.target_type === 'live') liveRt.endStream(r.target_id, 'ended_by_admin');
      else throw bad('Use suspend or ban for user reports');
    }
    if ((action === 'suspend_user' || action === 'ban_user') && target && target.ownerId) {
      const u = q.get('SELECT * FROM users WHERE id = ?', target.ownerId);
      if (u.role === 'admin') throw forbidden('Cannot restrict an administrator');
      if (action === 'ban_user') q.run("UPDATE users SET status = 'banned', status_reason = ? WHERE id = ?", note || r.reason, u.id);
      else q.run("UPDATE users SET status = 'suspended', suspended_until = ?, status_reason = ? WHERE id = ?", now() + 7 * DAY, note || r.reason, u.id);
      endUserActivity(u);
    }
    const status = action === 'dismiss' ? 'dismissed' : 'resolved';
    // Resolve every open report on the same target together.
    q.run("UPDATE reports SET status = ?, resolved_by = ?, resolution = ?, resolved_at = ? WHERE target_type = ? AND target_id = ? AND status = 'open'",
      status, req.user.id, `${action}${note ? ': ' + note : ''}`, now(), r.target_type, r.target_id);
    audit(req, `report.${action}`, r.target_type, r.target_id, note);
  });
  res.json({ ok: true });
});

// ---------- LIVE ----------
router.get('/live', (_req, res) => {
  const rows = q.all(`SELECT ls.*, u.username, u.display_name, u.avatar_url, u.is_verified FROM live_streams ls JOIN users u ON u.id = ls.user_id
    ORDER BY ls.status = 'live' DESC, ls.started_at DESC LIMIT 50`);
  res.json({ streams: rows.map(serializeLive) });
});

router.post('/live/:id/end', (req, res) => {
  const id = v.int(req.params.id, 'stream');
  liveRt.endStream(id, 'ended_by_admin');
  audit(req, 'live.end', 'live', id);
  res.json({ ok: true });
});

router.get('/audit', (_req, res) => {
  const rows = q.all('SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.id DESC LIMIT 200');
  res.json({ entries: rows.map((r) => ({ id: r.id, admin: r.username, action: r.action, targetType: r.target_type, targetId: r.target_id, note: r.note, createdAt: r.created_at })) });
});

module.exports = router;
