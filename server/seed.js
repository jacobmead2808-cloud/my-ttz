'use strict';
/**
 * Seeds the database with an admin, demo users, follows, placeholder sounds and (if present)
 * demo videos from server/seed/media. Usage:
 *   npm run seed            -> seeds an empty database
 *   npm run seed -- --reset -> wipes data/ and uploads/ first
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

const reset = process.argv.includes('--reset');
if (reset) {
  for (const f of ['app.db', 'app.db-wal', 'app.db-shm']) fs.rmSync(path.join(config.dataDir, f), { force: true });
  for (const d of Object.values(config.dirs)) {
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
  }
  console.log('Reset data/ and uploads/');
}

const { q, tx, now } = require('./db');
const { hashPassword } = require('./lib/auth');
const v = require('./lib/validate');
const { notify } = require('./lib/notify');

const SEED_MEDIA = path.join(__dirname, 'seed', 'media');
const DAY = 86400000;
const rand = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rand(arr.length)];

// ---------- Placeholder avatars (SVG with initials) ----------
const COLORS = [['#ff0050', '#ff7a00'], ['#00f2ea', '#0077ff'], ['#0f766e', '#14b8a6'], ['#00c853', '#64dd17'], ['#ff6d00', '#ffd600'],
  ['#2962ff', '#00b8d4'], ['#b91c1c', '#f97316'], ['#00bfa5', '#1de9b6'], ['#ff1744', '#ff9100'], ['#1d4ed8', '#0ea5e9']];
function avatarSvg(name, i) {
  const [a, b] = COLORS[i % COLORS.length];
  const initials = name.replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase() || '?';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="128" height="128" fill="url(#g)"/><text x="64" y="64" dy=".35em" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="52" font-weight="700" fill="#fff">${initials}</text></svg>`;
}

const DEMO_USERS = [
  ['maya.moves', 'Maya Moves', 'Dancer | choreo every Friday | NYC'],
  ['chef_leo', 'Chef Leo', 'Quick recipes under 60 seconds'],
  ['techwithtara', 'Tara Codes', 'Software engineer sharing dev tips'],
  ['wanderjay', 'Jay Wanders', 'Travel • 42 countries and counting'],
  ['fitwithsam', 'Sam Fitness', 'Home workouts, no equipment needed'],
  ['pixelpete', 'Pixel Pete', 'Digital art & pixel animations'],
  ['laughlab', 'Laugh Lab', 'Sketch comedy duo new skit daily'],
  ['plantmom.ana', 'Ana', 'Plant care tips from a very crowded apartment'],
  ['beatsbyrio', 'Rio Beats', 'Producer. Making beats from random sounds'],
  ['quietcorner', 'Quiet Corner', 'Private account — cozy reading vlogs'],
];

const COMMENTS = ['This is so good', 'How did you do that?!', 'Watching this on repeat', 'Tutorial please', 'The editing',
  'Okay this made my day', 'Not me watching this at 3am', 'Instant follow', 'Part 2 when??', 'I need this energy', 'Underrated creator fr',
  'The sound choice is perfect', 'Saved for later!', 'Teach me your ways', 'This deserves way more views'];

async function main() {
  if (!reset && q.get('SELECT COUNT(*) AS n FROM users').n > 0) {
    console.log('Database already has users. Run `npm run seed -- --reset` to wipe and reseed.');
    return;
  }
  const env = process.env;
  const adminPw = env.ADMIN_PASSWORD || 'ChangeMe-Admin1!';
  const seedPw = env.SEED_PASSWORD || 'Demo-Pass123!';
  const adminHash = await hashPassword(adminPw);
  const userHash = await hashPassword(seedPw);

  // sounds
  const soundIds = require('./lib/placeholderSounds').createPlaceholderSounds();

  // users
  const t0 = now() - 30 * DAY;
  const adminUsername = (env.ADMIN_USERNAME || 'admin').toLowerCase();
  const writeAvatar = (username, i) => {
    const file = `seed-${username.replace(/[^a-z0-9_]/g, '_')}.svg`;
    fs.writeFileSync(path.join(config.dirs.avatars, file), avatarSvg(username, i));
    return `/media/a/${file}`;
  };
  q.run(`INSERT INTO users (username, email, password_hash, display_name, bio, avatar_url, role, is_verified, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'admin', 1, ?)`, adminUsername, (env.ADMIN_EMAIL || 'admin@clipzy.local').toLowerCase(), adminHash,
  'Clipzy Team', 'Official account • Platform updates & moderation', writeAvatar(adminUsername, 9), t0);
  q.run('UPDATE users SET is_owner = 1 WHERE username = ?', adminUsername);

  const ids = [];
  DEMO_USERS.forEach(([username, name, bio], i) => {
    const r = q.run(`INSERT INTO users (username, email, password_hash, display_name, bio, avatar_url, is_private, is_verified, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, username, `${username.replace(/\./g, '')}@demo.clipzy.local`, userHash, name, bio,
    writeAvatar(username, i), username === 'quietcorner' ? 1 : 0, i < 2 ? 1 : 0, t0 + i * DAY);
    ids.push(Number(r.lastInsertRowid));
  });

  // follows (random graph)
  for (const a of ids) {
    for (const b of ids) {
      if (a !== b && Math.random() < 0.45) q.run("INSERT OR IGNORE INTO follows (follower_id, followee_id, status, created_at) VALUES (?, ?, 'accepted', ?)", a, b, now() - rand(20) * DAY);
    }
  }

  // demo videos
  let videoCount = 0;
  const manifestFile = path.join(SEED_MEDIA, 'manifest.json');
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    tx(() => {
      manifest.forEach((m, i) => {
        const src = path.join(SEED_MEDIA, m.file);
        if (!fs.existsSync(src)) return;
        fs.copyFileSync(src, path.join(config.dirs.videos, m.file));
        if (m.thumb && fs.existsSync(path.join(SEED_MEDIA, m.thumb))) fs.copyFileSync(path.join(SEED_MEDIA, m.thumb), path.join(config.dirs.thumbs, m.thumb));
        const owner = ids[(m.owner ?? i) % (ids.length - 1)]; // never the private demo account
        const created = now() - rand(14 * 24) * 3600000;
        const r = q.run(`INSERT INTO videos (user_id, caption, description, video_file, video_mime, thumb_file, sound_id, duration, width, height, views, share_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, owner, m.caption, m.description || '', m.file, m.mime, m.thumb || null,
        m.sound ? soundIds[(m.sound - 1) % soundIds.length] : (Math.random() < 0.6 ? pick(soundIds) : null), m.duration || 0, m.width || 720, m.height || 1280,
        200 + rand(20000), rand(40), created, created);
        const vid = Number(r.lastInsertRowid);
        for (const tag of v.extractHashtags(`${m.caption} ${m.description || ''}`)) {
          q.run('INSERT OR IGNORE INTO hashtags (tag) VALUES (?)', tag);
          q.run('INSERT OR IGNORE INTO video_hashtags (video_id, hashtag_id) SELECT ?, id FROM hashtags WHERE tag = ?', vid, tag);
        }
        for (const uid of ids) {
          if (uid !== owner && Math.random() < 0.5) q.run('INSERT OR IGNORE INTO likes (user_id, video_id, created_at) VALUES (?, ?, ?)', uid, vid, created + rand(DAY));
          if (uid !== owner && Math.random() < 0.15) q.run('INSERT OR IGNORE INTO saves (user_id, video_id, created_at) VALUES (?, ?, ?)', uid, vid, created + rand(DAY));
        }
        const nComments = rand(6);
        for (let c = 0; c < nComments; c++) {
          const author = pick(ids.filter((x) => x !== owner));
          const cr = q.run('INSERT INTO comments (video_id, user_id, body, created_at) VALUES (?, ?, ?, ?)', vid, author, pick(COMMENTS), created + rand(DAY));
          if (Math.random() < 0.35) q.run('INSERT INTO comments (video_id, user_id, parent_id, body, created_at) VALUES (?, ?, ?, ?, ?)', vid, owner, cr.lastInsertRowid, 'Thank you!!', created + DAY);
        }
        videoCount++;
      });
    });
  }

  // a few notifications so the inbox isn't empty for the first demo user
  notify({ userId: ids[0], actorId: ids[1], type: 'follow' });
  notify({ userId: ids[0], actorId: ids[2], type: 'mention', body: 'Check out @maya.moves!' });

  console.log(`\nSeed complete: 1 admin, ${ids.length} demo users, ${soundIds.length} sounds, ${videoCount} videos.`);
  console.log(`Admin login:  ${env.ADMIN_EMAIL || 'admin@clipzy.local'}  (password from ADMIN_PASSWORD in .env / .env.example)`);
  console.log(`Demo logins:  e.g. mayamoves@demo.clipzy.local or username "maya.moves"  (password from SEED_PASSWORD)`);
  if (!videoCount) console.log('No demo videos found in server/seed/media. Log in as admin -> Admin -> "Demo content" to generate some.');
}

main().catch((e) => { console.error(e); process.exit(1); });
