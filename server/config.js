'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Minimal .env loader (avoids a dependency). Existing env vars win.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const env = process.env;
const port = Number(env.PORT) || 4000;
const dataDir = path.resolve(ROOT, env.DATA_DIR || 'data');
const uploadDir = path.resolve(ROOT, env.UPLOAD_DIR || 'uploads');

let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
if (env.ICE_SERVERS) {
  try { iceServers = JSON.parse(env.ICE_SERVERS); } catch { console.warn('[config] ICE_SERVERS is not valid JSON, using default STUN'); }
}

const baseUrl = (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');

module.exports = {
  ROOT,
  isProd: env.NODE_ENV === 'production',
  port,
  host: env.HOST || '0.0.0.0',
  appName: env.APP_NAME || 'Clipzy',
  baseUrl,
  secureCookies: baseUrl.startsWith('https://'),
  trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  // Email verification: required in production unless explicitly turned off; opt-in in development.
  contactEmail: env.CONTACT_EMAIL || '',
  requireEmailVerification: env.REQUIRE_EMAIL_VERIFICATION === 'true' || (env.NODE_ENV === 'production' && env.REQUIRE_EMAIL_VERIFICATION !== 'false'),
  dataDir,
  dbFile: path.join(dataDir, 'app.db'),
  outboxDir: path.join(dataDir, 'outbox'),
  uploadDir,
  dirs: {
    tmp: path.join(uploadDir, 'tmp'),
    videos: path.join(uploadDir, 'videos'),
    thumbs: path.join(uploadDir, 'thumbs'),
    avatars: path.join(uploadDir, 'avatars'),
    sounds: path.join(uploadDir, 'sounds'),
    live: path.join(uploadDir, 'live'),
    stories: path.join(uploadDir, 'stories'),
  },
  maxVideoBytes: (Number(env.MAX_VIDEO_MB) || 200) * 1024 * 1024,
  maxImageBytes: 8 * 1024 * 1024,
  sessionDays: Number(env.SESSION_DAYS) || 30,
  mail: {
    provider: (env.MAIL_PROVIDER || '').toLowerCase(),
    resendKey: env.RESEND_API_KEY || '',
    from: env.MAIL_FROM || `${env.APP_NAME || 'Clipzy'} <${env.SMTP_USER && env.SMTP_USER.includes('@') ? env.SMTP_USER : 'no-reply@example.com'}>`,
    // MAIL_PROVIDER=smtp: any mail server, e.g. Gmail (smtp.gmail.com, an app password).
    smtp: {
      host: env.SMTP_HOST || '',
      port: Number(env.SMTP_PORT) || 465,
      user: env.SMTP_USER || '',
      pass: (env.SMTP_PASS || '').replace(/\s+/g, ''),
      secure: env.SMTP_SECURE || ((Number(env.SMTP_PORT) || 465) === 465 ? 'tls' : 'starttls'),
    },
  },
  iceServers,
};

for (const d of [dataDir, uploadDir, ...Object.values(module.exports.dirs)]) fs.mkdirSync(d, { recursive: true });
