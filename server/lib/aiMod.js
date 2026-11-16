'use strict';
/**
 * Clipzy Guardian — the automated moderation agent.
 *
 * Continuously scores every active account from behavioural signals (auto-mod hits, reports,
 * removed content, spam velocity, follow/DM bursts, strike history) and, optionally, an AI text
 * classifier (OpenAI moderation endpoint when AI_MODERATION=openai + OPENAI_API_KEY).
 *
 *   score >= suspendAt  → auto-suspend (24h) + open a HIGH case for human review
 *   score >= reviewAt   → open a case and alert staff ("needs a human")
 *   score >= warnAt     → automatic warning to the user (max once every 3 days)
 *
 * Verified users, admins and the owner are never auto-actioned — they are escalated instead.
 */
const { q, now } = require('../db');
const settings = require('./settings');
const hub = require('../realtime/hub');

settings.DEFAULTS.guardian = { enabled: true, warnAt: 30, reviewAt: 55, suspendAt: 85, suspendHours: 24, aiProvider: 'auto' };

const HOUR = 3600000;
const DAY = 24 * HOUR;
const pending = new Map();

function strike(userId, kind, reason, { byId = null, auto = false, expiresAt = null } = {}) {
  q.run('INSERT INTO user_strikes (user_id, kind, reason, by_id, auto, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    userId, kind, reason ? String(reason).slice(0, 500) : null, byId, auto ? 1 : 0, expiresAt, now());
}

function alertStaff(caseId, summary, userId) {
  const { notify } = require('./notify');
  for (const a of q.all("SELECT id FROM users WHERE role = 'admin' AND status = 'active'")) {
    notify({ userId: a.id, actorId: null, type: 'mod_case', body: `Guardian: ${summary}`.slice(0, 220) });
    hub.sendToUser(a.id, { type: 'mod:case', caseId });
  }
}

/** Compute the risk score and a human-readable breakdown for a user. */
function assess(userId) {
  const u = q.get('SELECT * FROM users WHERE id = ?', userId);
  if (!u) return null;
  const t = now();
  const c = (sql, ...p) => q.get(sql, ...p).n;
  const signals = [];
  const add = (key, label, value, points) => { if (value > 0 && points > 0) signals.push({ key, label, value, points: Math.round(points) }); };

  const blocks = c("SELECT COUNT(*) AS n FROM automod_log WHERE user_id = ? AND action = 'block' AND created_at > ?", userId, t - DAY);
  const holds = c("SELECT COUNT(*) AS n FROM automod_log WHERE user_id = ? AND action = 'hold' AND created_at > ?", userId, t - DAY);
  add('automod_block', 'Messages blocked by auto-mod (24h)', blocks, Math.min(blocks * 8, 40));
  add('automod_hold', 'Messages hidden by auto-mod (24h)', holds, Math.min(holds * 4, 24));

  const reporters = c(`SELECT COUNT(DISTINCT r.reporter_id) AS n FROM reports r WHERE r.created_at > ? AND r.status = 'open' AND (
      (r.target_type = 'user' AND r.target_id = :u) OR
      (r.target_type = 'video' AND r.target_id IN (SELECT id FROM videos WHERE user_id = :u)) OR
      (r.target_type = 'comment' AND r.target_id IN (SELECT id FROM comments WHERE user_id = :u)) OR
      (r.target_type = 'live' AND r.target_id IN (SELECT id FROM live_streams WHERE user_id = :u)))`.replace(/:u/g, '?'),
  t - 7 * DAY, userId, userId, userId, userId);
  add('reports', 'Different people reporting them (7d)', reporters, Math.min(reporters * 7, 42));

  const removed = c("SELECT COUNT(*) AS n FROM videos WHERE user_id = ? AND status = 'removed' AND updated_at > ?", userId, t - 30 * DAY)
    + c("SELECT COUNT(*) AS n FROM comments WHERE user_id = ? AND status = 'removed' AND created_at > ?", userId, t - 30 * DAY);
  add('removed', 'Content removed (30d)', removed, Math.min(removed * 8, 32));

  const warnings = c("SELECT COUNT(*) AS n FROM user_strikes WHERE user_id = ? AND kind = 'warning' AND created_at > ?", userId, t - 30 * DAY);
  const suspensions = c("SELECT COUNT(*) AS n FROM user_strikes WHERE user_id = ? AND kind = 'suspension' AND created_at > ?", userId, t - 90 * DAY);
  add('warnings', 'Warnings (30d)', warnings, warnings * 5);
  add('suspensions', 'Previous suspensions (90d)', suspensions, suspensions * 12);

  const follows = c('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ? AND created_at > ?', userId, t - HOUR);
  add('follow_burst', 'Follows in the last hour', follows, follows > 60 ? 25 : follows > 30 ? 10 : 0);
  const comments = c('SELECT COUNT(*) AS n FROM comments WHERE user_id = ? AND created_at > ?', userId, t - 10 * 60000);
  add('comment_burst', 'Comments in the last 10 minutes', comments, comments > 25 ? 25 : comments > 12 ? 10 : 0);
  const dmTargets = c(`SELECT COUNT(DISTINCT m.conversation_id) AS n FROM messages m WHERE m.sender_id = ? AND m.created_at > ?`, userId, t - HOUR);
  add('dm_burst', 'Different people messaged in the last hour', dmTargets, dmTargets > 25 ? 25 : dmTargets > 12 ? 10 : 0);

  let score = signals.reduce((s, x) => s + x.points, 0);
  const ageHours = (t - u.created_at) / HOUR;
  if (ageHours < 24 && score > 0) { score *= 1.3; signals.push({ key: 'new_account', label: 'Brand-new account (signals weighted ×1.3)', value: Math.round(ageHours), points: 0 }); }
  score = Math.min(100, Math.round(score));
  const protectedUser = !!(u.role === 'admin' || u.is_owner || u.is_verified);
  return { user: u, score, signals, protectedUser, summary: summarize(u, score, signals) };
}

function summarize(u, score, signals) {
  if (!signals.length) return `@${u.username} has no recent risk signals.`;
  const top = [...signals].sort((a, b) => b.points - a.points).slice(0, 3).map((s) => `${s.label.toLowerCase()}: ${s.value}`);
  const level = score >= 85 ? 'High risk' : score >= 55 ? 'Elevated risk' : score >= 30 ? 'Some risk' : 'Low risk';
  return `${level} (${score}/100) — ${top.join('; ')}.`;
}

/** Optional AI text check on the user's recent flagged messages. Adds points; never throws. */
async function aiCheck(userId) {
  const provider = (process.env.AI_MODERATION || '').toLowerCase();
  if (provider !== 'openai' || !process.env.OPENAI_API_KEY) return null;
  const texts = q.all('SELECT content FROM automod_log WHERE user_id = ? ORDER BY id DESC LIMIT 10', userId).map((r) => r.content);
  const recent = q.all("SELECT body FROM comments WHERE user_id = ? ORDER BY id DESC LIMIT 10", userId).map((r) => r.body);
  const input = [...texts, ...recent].filter(Boolean).slice(0, 20);
  if (!input.length) return null;
  try {
    const r = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.AI_MODERATION_MODEL || 'omni-moderation-latest', input }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const flagged = (data.results || []).filter((x) => x.flagged);
    const cats = new Set();
    flagged.forEach((x) => Object.entries(x.categories || {}).forEach(([k, on]) => on && cats.add(k)));
    return { flagged: flagged.length, categories: [...cats] };
  } catch { return null; }
}

/** Assess and act. Returns the assessment with the action taken. */
async function review(userId, { force = false } = {}) {
  const cfg = settings.get('guardian');
  const a = assess(userId);
  if (!a) return null;
  const ai = await aiCheck(userId);
  if (ai && ai.flagged) {
    const pts = Math.min(ai.flagged * 10, 40);
    a.signals.push({ key: 'ai', label: `AI flagged messages (${ai.categories.join(', ') || 'unsafe'})`, value: ai.flagged, points: pts });
    a.score = Math.min(100, a.score + pts);
    a.summary = summarize(a.user, a.score, a.signals);
  }
  q.run('UPDATE users SET risk_score = ?, risk_updated_at = ? WHERE id = ?', a.score, now(), userId);
  a.action = 'none';
  if (!cfg.enabled && !force) return a;
  const u = a.user;
  if (u.status !== 'active') return a;
  const openCase = q.get("SELECT id FROM mod_cases WHERE user_id = ? AND status = 'open'", userId);

  if (a.score >= cfg.suspendAt && !a.protectedUser) {
    const until = now() + cfg.suspendHours * HOUR;
    q.run("UPDATE users SET status = 'suspended', suspended_until = ?, status_reason = ? WHERE id = ?", until, `Automatic safety suspension: ${a.summary}`, userId);
    q.run('DELETE FROM sessions WHERE user_id = ?', userId);
    hub.disconnectUser(userId);
    for (const s of q.all("SELECT id FROM live_streams WHERE user_id = ? AND status = 'live'", userId)) require('../realtime/live').endStream(s.id, 'account_restricted');
    strike(userId, 'suspension', a.summary, { auto: true, expiresAt: until });
    const id = openCase ? openCase.id : Number(q.run("INSERT INTO mod_cases (user_id, severity, source, summary, signals, auto_action, created_at) VALUES (?, 'high', 'auto', ?, ?, ?, ?)",
      userId, a.summary, JSON.stringify(a.signals), `Auto-suspended for ${cfg.suspendHours}h`, now()).lastInsertRowid);
    if (openCase) q.run("UPDATE mod_cases SET severity = 'high', summary = ?, signals = ?, auto_action = ? WHERE id = ?", a.summary, JSON.stringify(a.signals), `Auto-suspended for ${cfg.suspendHours}h`, id);
    alertStaff(id, `@${u.username} was auto-suspended. ${a.summary}`, userId);
    a.action = 'suspended';
  } else if (a.score >= cfg.reviewAt || (a.score >= cfg.suspendAt && a.protectedUser)) {
    if (!openCase) {
      const sev = a.score >= cfg.suspendAt ? 'high' : 'medium';
      const id = Number(q.run("INSERT INTO mod_cases (user_id, severity, source, summary, signals, auto_action, created_at) VALUES (?, ?, 'auto', ?, ?, ?, ?)",
        userId, sev, a.summary, JSON.stringify(a.signals), a.protectedUser ? 'Protected account — human decision required' : 'Escalated for human review', now()).lastInsertRowid);
      alertStaff(id, `@${u.username}: ${a.summary}`, userId);
    } else q.run('UPDATE mod_cases SET summary = ?, signals = ? WHERE id = ?', a.summary, JSON.stringify(a.signals), openCase.id);
    a.action = 'escalated';
  } else if (a.score >= cfg.warnAt && !a.protectedUser) {
    const recentWarn = q.get("SELECT 1 FROM user_strikes WHERE user_id = ? AND kind = 'warning' AND auto = 1 AND created_at > ?", userId, now() - 3 * DAY);
    if (!recentWarn) {
      strike(userId, 'warning', a.summary, { auto: true });
      const { notify } = require('./notify');
      notify({ userId, actorId: null, type: 'moderation', body: 'Automatic warning: some of your recent activity breaks our community guidelines. Repeated issues can lead to a suspension.' });
      a.action = 'warned';
    }
  }
  return a;
}

/** Debounced trigger for events (auto-mod hit, report, follow, comment…). */
function observe(userId, _reason) {
  if (!userId || pending.has(userId)) return;
  pending.set(userId, setTimeout(() => { pending.delete(userId); review(userId).catch((e) => console.error('[guardian]', e)); }, 1500).unref());
}

/** Background sweep of recently active accounts. */
async function sweep() {
  const ids = q.all(`SELECT DISTINCT user_id AS id FROM (
      SELECT user_id FROM automod_log WHERE created_at > :t UNION SELECT user_id FROM comments WHERE created_at > :t
      UNION SELECT follower_id FROM follows WHERE created_at > :t UNION SELECT sender_id FROM messages WHERE created_at > :t)`, { t: now() - HOUR });
  for (const { id } of ids) if (id) await review(id).catch(() => {});
  return ids.length;
}

function startGuardian() {
  setInterval(() => sweep().catch((e) => console.error('[guardian]', e)), 10 * 60000).unref();
}

module.exports = { assess, review, observe, sweep, strike, startGuardian };
