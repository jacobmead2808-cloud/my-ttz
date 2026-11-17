'use strict';
/**
 * First-boot setup for a fresh server (runs before the app starts in Docker / `npm run start:prod`).
 * If the database has no users, creates the owner account from ADMIN_EMAIL / ADMIN_USERNAME /
 * ADMIN_PASSWORD. Refuses to use the example password in production. In development only,
 * SEED_DEMO=true adds the demo accounts, sounds and videos (ignored when NODE_ENV=production).
 */
const { execFileSync } = require('child_process');
const path = require('path');
const config = require('../config');
const { q, now } = require('../db');
const { hashPassword } = require('../lib/auth');

async function main() {
  if (q.get('SELECT COUNT(*) AS n FROM users').n > 0) return console.log('[bootstrap] database ready');
  if (process.env.SEED_DEMO === 'true' && config.isProd) {
    console.error('[bootstrap] SEED_DEMO is ignored in production — demo accounts are never created on a live site.');
  }
  if (process.env.SEED_DEMO === 'true' && !config.isProd) {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'seed.js')], { stdio: 'inherit' });
    return;
  }
  const pw = process.env.ADMIN_PASSWORD || '';
  if (config.isProd && (!pw || pw === 'ChangeMe-Admin1!' || pw.length < 10)) {
    console.error('[bootstrap] Set a strong ADMIN_PASSWORD (10+ characters, not the example one) before the first start.');
    process.exit(1);
  }
  if (config.isProd && (!process.env.ADMIN_EMAIL || /@(example\.com|clipzy\.local)$/i.test(process.env.ADMIN_EMAIL))) {
    console.error('[bootstrap] Set ADMIN_EMAIL to your real email address (used for password resets) before the first start.');
    process.exit(1);
  }
  const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
  const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  q.run(`INSERT INTO users (username, email, password_hash, display_name, role, is_owner, is_verified, created_at)
    VALUES (?, ?, ?, ?, 'admin', 1, 1, ?)`, username, email, await hashPassword(pw || 'ChangeMe-Admin1!'), config.appName, now());
  console.log(`[bootstrap] created owner account @${username} (${email})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
