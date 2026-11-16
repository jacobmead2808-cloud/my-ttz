'use strict';
/**
 * Deletes the demo accounts created by `npm run seed` (emails ending @demo.clipzy.local) together
 * with their videos, stories, avatars and every row that references them. Real accounts are untouched.
 *   npm run purge-demo            -> shows what would be deleted
 *   npm run purge-demo -- --yes   -> deletes it
 */
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { q, tx } = require('../db');

const demo = q.all("SELECT id, username, avatar_url FROM users WHERE email LIKE '%@demo.clipzy.local'");
if (!demo.length) { console.log('No demo accounts found.'); process.exit(0); }
const ids = demo.map((u) => u.id);
const marks = ids.map(() => '?').join(',');
const videos = q.all(`SELECT video_file, thumb_file FROM videos WHERE user_id IN (${marks})`, ...ids);
const stories = q.all(`SELECT media_file FROM stories WHERE user_id IN (${marks})`, ...ids);
console.log(`Demo accounts: ${demo.map((u) => '@' + u.username).join(', ')}`);
console.log(`Their videos: ${videos.length}, stories: ${stories.length}`);
if (!process.argv.includes('--yes')) {
  console.log('\nNothing deleted. Run again with --yes to delete them permanently.');
  process.exit(0);
}
tx(() => {
  q.run(`DELETE FROM notifications WHERE actor_id IN (${marks})`, ...ids);
  q.run(`DELETE FROM users WHERE id IN (${marks})`, ...ids);
});
const rm = (dir, f) => f && fs.rm(path.join(dir, path.basename(f)), { force: true }, () => {});
videos.forEach((v) => { rm(config.dirs.videos, v.video_file); rm(config.dirs.thumbs, v.thumb_file); });
stories.forEach((s) => rm(config.dirs.stories, s.media_file));
demo.forEach((u) => { if (u.avatar_url && u.avatar_url.startsWith('/media/a/')) rm(config.dirs.avatars, u.avatar_url.slice(9)); });
console.log(`Deleted ${demo.length} demo accounts and their content.`);
