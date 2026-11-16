'use strict';
// Database health check: `npm run db:check`. Add `--backup` to also write a snapshot now.
const { db } = require('../db');

const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
const fks = db.prepare('PRAGMA foreign_key_check').all();
const counts = Object.fromEntries(['users', 'videos', 'comments', 'messages', 'live_streams'].map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));

console.log('integrity:', integrity.join(', '));
console.log('foreign key problems:', fks.length);
for (const f of fks.slice(0, 20)) console.log('  ', JSON.stringify(f));
console.log('rows:', JSON.stringify(counts));
if (process.argv.includes('--backup')) console.log('backup:', require('../lib/backup').backupNow());
process.exit(integrity[0] === 'ok' && !fks.length ? 0 : 1);
