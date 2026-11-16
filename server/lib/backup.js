'use strict';
/**
 * Database snapshots. `VACUUM INTO` writes a consistent copy of the live database without
 * stopping the app. One snapshot per day is kept for BACKUP_KEEP_DAYS (default 7).
 * Uploaded media is not included — snapshot the storage volume itself for that.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { db } = require('../db');

const dir = path.resolve(config.ROOT, process.env.BACKUP_DIR || path.join(config.dataDir, 'backups'));
const keep = Number(process.env.BACKUP_KEEP_DAYS) || 7;

function backupNow() {
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `app-${day}.db`);
  const tmp = `${file}.tmp`;
  fs.rmSync(tmp, { force: true });
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  fs.renameSync(tmp, file);
  const old = fs.readdirSync(dir).filter((f) => /^app-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(keep);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}

function hasToday() {
  return fs.existsSync(path.join(dir, `app-${new Date().toISOString().slice(0, 10)}.db`));
}

/** Take a snapshot now if there isn't one for today, then check every hour. */
function startBackups() {
  const run = () => {
    if (hasToday()) return;
    try { console.log(`[backup] saved ${backupNow()}`); } catch (e) { console.error('[backup] failed:', e.message); }
  };
  setTimeout(run, 30 * 1000).unref();
  setInterval(run, 60 * 60 * 1000).unref();
}

module.exports = { backupNow, startBackups, dir };
