'use strict';
/**
 * Security monitoring: a small log of suspicious events (failed logins, blocked requests, rate-limit
 * hits, forged webhooks, unusual gifting, socket floods) for staff to review in the moderation centre.
 *
 * Privacy: no passwords, tokens, cookies, emails or request bodies are ever recorded. IP addresses are
 * stored only as a keyed hash (enough to see "same source" patterns, not who it is). Events are deleted
 * after SECURITY_LOG_DAYS (default 30).
 */
const crypto = require('crypto');
const { q, now } = require('../db');
const settings = require('./settings');

settings.DEFAULTS.securitySalt = null;
let salt = null;
function ipKey(ip) {
  if (!ip) return null;
  if (!salt) {
    const stored = settings.get('securitySalt');
    salt = stored && stored.value;
    if (!salt) { salt = crypto.randomBytes(16).toString('hex'); settings.set('securitySalt', { value: salt }); }
  }
  return crypto.createHmac('sha256', salt).update(String(ip)).digest('hex').slice(0, 16);
}

const clean = (s, n = 200) => (s == null ? null : String(s).replace(/[\r\n\t]+/g, ' ').slice(0, n));
// Throttle identical events so an attack can't flood the log or the console.
const recent = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of recent) if (v < t) recent.delete(k); }, 60000).unref();

/**
 * Record an event. `req` may be an Express request or { ip, path, userId }.
 * type examples: login.failed, login.locked, csrf.blocked, ratelimit.hit, access.denied,
 * webhook.forged, gift.velocity, ws.flood, upload.rejected
 */
function record(type, req, detail = null, { severity = 'warn' } = {}) {
  try {
    const ip = req && (req.ip || (req.socket && req.socket.remoteAddress));
    const path = req && (req.originalUrl || req.path || req.url) ? String(req.originalUrl || req.path || req.url).split('?')[0] : null;
    const userId = req && (req.userId || (req.user && req.user.id)) || null;
    const key = ipKey(ip);
    const dedupe = `${type}|${key}|${userId}|${path}`;
    if (recent.has(dedupe)) return;
    recent.set(dedupe, Date.now() + 10000);
    q.run('INSERT INTO security_events (type, severity, user_id, ip_key, path, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      clean(type, 40), severity, userId, key, clean(path, 160), clean(detail), now());
    console.warn(`[security] ${type}${path ? ` ${path}` : ''}${userId ? ` u${userId}` : ''}${key ? ` src:${key}` : ''}${detail ? ` - ${clean(detail, 120)}` : ''}`);
  } catch (e) { console.error('[security] could not record event', e.message); }
}

function list({ limit = 200, type = null } = {}) {
  const rows = type
    ? q.all('SELECT * FROM security_events WHERE type = ? ORDER BY id DESC LIMIT ?', type, limit)
    : q.all('SELECT * FROM security_events ORDER BY id DESC LIMIT ?', limit);
  const since = now() - 86400000;
  const counts = q.all('SELECT type, COUNT(*) AS n FROM security_events WHERE created_at > ? GROUP BY type ORDER BY n DESC', since);
  return { events: rows.map((r) => ({ id: r.id, type: r.type, severity: r.severity, userId: r.user_id, source: r.ip_key, path: r.path, detail: r.detail, createdAt: r.created_at })), last24h: counts };
}

module.exports = { record, list, ipKey };
