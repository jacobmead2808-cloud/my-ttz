'use strict';
// Copies current videos (+ thumbnails) into server/seed/media with a manifest, so `npm run seed`
// recreates them on a fresh install. Usage: node server/scripts/export-seed-media.js [maxVideos]
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { q } = require('../db');

const out = path.join(__dirname, '..', 'seed', 'media');
fs.mkdirSync(out, { recursive: true });
const max = Number(process.argv[2]) || 30;
const rows = q.all("SELECT * FROM videos WHERE status = 'active' AND visibility = 'public' ORDER BY id LIMIT ?", max);
const manifest = [];
rows.forEach((v, i) => {
  const src = path.join(config.dirs.videos, v.video_file);
  if (!fs.existsSync(src)) return;
  fs.copyFileSync(src, path.join(out, v.video_file));
  if (v.thumb_file && fs.existsSync(path.join(config.dirs.thumbs, v.thumb_file))) fs.copyFileSync(path.join(config.dirs.thumbs, v.thumb_file), path.join(out, v.thumb_file));
  manifest.push({ file: v.video_file, thumb: v.thumb_file, mime: v.video_mime, caption: v.caption, description: v.description, duration: v.duration, width: v.width, height: v.height, owner: i, sound: v.sound_id });
});
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Exported ${manifest.length} videos to ${out}`);
