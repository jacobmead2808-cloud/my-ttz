'use strict';
// Usage: npm run make-admin -- <username>   (promotes an existing account to administrator)
const { q } = require('../db');

const name = (process.argv[2] || '').toLowerCase();
if (!name) {
  console.error('Usage: npm run make-admin -- <username>');
  process.exit(1);
}
const u = q.get('SELECT id, username FROM users WHERE username = ?', name);
if (!u) {
  console.error(`No user named "${name}"`);
  process.exit(1);
}
q.run("UPDATE users SET role = 'admin', status = 'active', suspended_until = NULL WHERE id = ?", u.id);
console.log(`@${u.username} is now an administrator.`);
