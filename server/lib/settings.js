'use strict';
// Platform-wide settings stored in the app_settings table (JSON values), with defaults.
const { q } = require('../db');

const DEFAULTS = {
  platform: {
    registrationsOpen: true,
    uploadsEnabled: true,
    liveEnabled: true,
    announcement: '',
  },
  automod: {
    enabled: true,
    // Words/phrases blocked everywhere. A trailing * matches any ending (e.g. "scam*").
    blockedWords: ['free followers', 'buy followers', 'follow4follow', 'click my link', 'crypto giveaway', 'onlyfans', 'scam*'],
    action: 'hold', // 'hold' = hide pending review (only author sees it), 'block' = reject outright
    blockLinks: true, // links in comments / LIVE chat from accounts younger than linkMinAgeHours
    linkMinAgeHours: 24,
    maxMentions: 5,
    repeatLimit: 3, // identical messages within 2 minutes
    capsFilter: true, // mostly-uppercase shouting (>= 12 letters, >= 80% caps)
    autoHideReports: 3, // distinct open reports before a video/comment is auto-hidden
    newAccountMinutes: 0, // brand-new accounts must wait this long before commenting / chatting
  },
};

const cache = new Map();

function get(key) {
  if (cache.has(key)) return cache.get(key);
  const row = q.get('SELECT value FROM app_settings WHERE key = ?', key);
  let val = DEFAULTS[key];
  if (row) {
    try { val = { ...DEFAULTS[key], ...JSON.parse(row.value) }; } catch { /* keep defaults */ }
  }
  cache.set(key, val);
  return val;
}

function set(key, patch) {
  const next = { ...get(key), ...patch };
  q.run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(next));
  cache.set(key, next);
  return next;
}

module.exports = { get, set, DEFAULTS };
