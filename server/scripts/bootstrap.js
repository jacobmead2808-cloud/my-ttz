'use strict';
/**
 * First-boot setup for a fresh server (runs before the app starts in Docker / `npm run start:prod`).
 * If the database has no users, creates the owner account from ADMIN_EMAIL / ADMIN_USERNAME /
 * ADMIN_PASSWORD. Refuses to use the example password in production. Set SEED_DEMO=true to also
 * add the demo accounts, sounds and videos.
 */
const { execFileSync } = require('child_process');
const path = require('path');
const config = require('../config');
const { q, now } = require('../db');
const { hashPassword } = require('../lib/auth');

async function main() {
  if (q.get('SELECT COUNT(*) AS n FROM users').n > 0) return console.log('[bootstrap] database ready');
  if (process.env.SEED_DEMO === 'true') {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'seed.js')], { stdio: 'inherit' });
    return;
  }
  const pw = process.env.ADMIN_PASSWORD || '';
  if (config.isProd && (!pw || pw === 'ChangeMe-Admin1!' || pw.length < 10)) {
    console.error('[bootstrap] Set a strong ADMIN_PASSWORD (10+ characters, not the example one) before the first start.');
    process.exit(1);
  }
  const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
  const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  q.run(`INSERT INTO users (username, email, password_hash, display_name, role, is_owner, is_verified, created_at)
    VALUES (?, ?, ?, ?, 'admin', 1, 1, ?)`, username, email, await hashPassword(pw || 'ChangeMe-Admin1!'), config.appName, now());
  // placeholder sounds so the upload page has a library
  execFileSync(process.execPath, [path.join(__dirname, 'make-sounds.js')], { stdio: 'inherit' });
  console.log(`[bootstrap] created owner account @${username} (${email})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
