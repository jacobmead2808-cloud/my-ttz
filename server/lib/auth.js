'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const config = require('../config');
const { q, now } = require('../db');
const { unauthorized, forbidden } = require('./errors');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const COOKIE = 'sid';

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(pw, stored) {
  try {
    const [algo, n, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(pw, Buffer.from(saltB64, 'base64'), expected.length, { ...SCRYPT, N: Number(n) });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ }
  }
  return out;
}

function cookieString(value, maxAgeSec) {
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (config.secureCookies) parts.push('Secure');
  return parts.join('; ');
}

function createSession(res, userId, userAgent) {
  const token = randomToken();
  const ttl = config.sessionDays * 86400 * 1000;
  q.run('INSERT INTO sessions (token_hash, user_id, user_agent, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    sha256(token), userId, String(userAgent || '').slice(0, 300), now(), now() + ttl);
  res.setHeader('Set-Cookie', cookieString(token, ttl / 1000));
}

function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) q.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  res.setHeader('Set-Cookie', cookieString('', 0));
}

/** Lift expired suspensions; returns the possibly-updated user. */
function refreshStatus(user) {
  if (user && user.status === 'suspended' && user.suspended_until && user.suspended_until <= now()) {
    q.run("UPDATE users SET status = 'active', suspended_until = NULL, status_reason = NULL WHERE id = ?", user.id);
    user.status = 'active';
    user.suspended_until = null;
  }
  return user;
}

/** Resolve the logged-in user from a raw request (used by HTTP and WebSocket). */
function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const hash = sha256(token);
  const s = q.get('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?', hash);
  if (!s) return null;
  if (s.expires_at < now()) {
    q.run('DELETE FROM sessions WHERE token_hash = ?', hash);
    return null;
  }
  const user = refreshStatus(q.get('SELECT * FROM users WHERE id = ?', s.user_id));
  if (!user || user.status !== 'active') return null;
  // Sliding expiry: extend when less than half the lifetime remains.
  const ttl = config.sessionDays * 86400 * 1000;
  if (s.expires_at - now() < ttl / 2) q.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', now() + ttl, hash);
  return user;
}

function loadUser(req, _res, next) {
  req.user = userFromRequest(req);
  next();
}

function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

function requireAdmin(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'admin') return next(forbidden('Administrator access required'));
  next();
}

/**
 * CSRF protection: state-changing API calls must carry a custom header. Browsers will not
 * send custom headers cross-site without a CORS preflight, which this server never approves.
 */
function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'fetch') return next(forbidden('Missing request header'));
  next();
}

module.exports = {
  hashPassword, verifyPassword, sha256, randomToken, createSession, destroySession,
  userFromRequest, loadUser, requireAuth, requireAdmin, csrfGuard, refreshStatus,
};
