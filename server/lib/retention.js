'use strict';
/**
 * Data retention: removes data Clipzy no longer needs.
 *   - expired sessions, email-confirmation and password-reset links
 *   - security events older than SECURITY_LOG_DAYS (default 30)
 *   - processed payment-webhook ids older than 90 days
 *   - expired stories (their files are removed too)
 */
const config = require('../config');
const { q, now } = require('../db');
const { removeStored } = require('./uploads');

const DAY = 86400000;
function sweep() {
  const t = now();
  const out = {};
  out.sessions = q.run('DELETE FROM sessions WHERE expires_at < ?', t).changes;
  out.verifications = q.run('DELETE FROM email_verifications WHERE expires_at < ?', t).changes;
  try { out.resets = q.run('DELETE FROM password_resets WHERE expires_at < ?', t).changes; } catch { /* table name differs */ }
  out.security = q.run('DELETE FROM security_events WHERE created_at < ?', t - (Number(process.env.SECURITY_LOG_DAYS) || 30) * DAY).changes;
  out.stripe = q.run('DELETE FROM stripe_events WHERE created_at < ?', t - 90 * DAY).changes;
  const stories = q.all('SELECT id, media_file FROM stories WHERE expires_at < ?', t - DAY);
  for (const s of stories) { q.run('DELETE FROM stories WHERE id = ?', s.id); removeStored(config.dirs.stories, s.media_file); }
  out.stories = stories.length;
  return out;
}

function startRetention() {
  const run = () => { try { const r = sweep(); if (Object.values(r).some(Boolean)) console.log('[retention]', JSON.stringify(r)); } catch (e) { console.error('[retention]', e.message); } };
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, 60 * 60 * 1000).unref();
}

module.exports = { sweep, startRetention };
