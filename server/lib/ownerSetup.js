'use strict';
/**
 * First-run owner setup. When a production server starts with no users and no ADMIN_PASSWORD, it
 * prints a one-time link in the server console. Only someone who can see that console (the person
 * running the server) can create the owner account. The token is stored only as a hash, expires after
 * 24 hours, and stops working as soon as any account exists.
 */
const crypto = require('crypto');
const { q, now } = require('../db');
const settings = require('./settings');

settings.DEFAULTS.ownerSetup = null;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function issue() {
  const token = crypto.randomBytes(24).toString('base64url');
  settings.set('ownerSetup', { hash: sha(token), expires: now() + 24 * 3600000 });
  return token;
}

const hasUsers = () => q.get('SELECT COUNT(*) AS n FROM users').n > 0;

function valid(token) {
  if (hasUsers()) return false;
  const s = settings.get('ownerSetup');
  if (!s || !s.hash || !token || s.expires < now()) return false;
  const a = Buffer.from(sha(token)); const b = Buffer.from(s.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function consume() { settings.set('ownerSetup', { hash: null, expires: 0 }); }

module.exports = { issue, valid, consume, hasUsers };
