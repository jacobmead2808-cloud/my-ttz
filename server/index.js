'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const config = require('./config');
require('./db');
const { loadUser, csrfGuard } = require('./lib/auth');
const { HttpError } = require('./lib/errors');
const access = require('./lib/access');
const { getVideoRow } = require('./lib/serialize');
const realtime = require('./realtime');
const liveRt = require('./realtime/live');

// Refuse to start a production server with an unsafe or broken configuration.
{
  const { errors, warnings } = require('./lib/prodCheck').checkProductionConfig();
  for (const w of warnings) console.warn(`[config] warning: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`[config] ERROR: ${e}`);
    console.error('[config] Fix the settings above (environment variables) and restart.');
    process.exit(1);
  }
}

const app = express();
app.disable('x-powered-by');

// ---------- Access log (no query strings: they can contain one-time tokens) ----------
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const p = req.originalUrl.split('?')[0];
    if (p === '/api/health') return;
    const isAsset = !p.startsWith('/api/') && !p.startsWith('/media/v/');
    if (isAsset && res.statusCode < 400) return;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`[http] ${req.method} ${p} ${res.statusCode} ${ms.toFixed(0)}ms${req.user ? ` u${req.user.id}` : ''} ${req.ip}`);
  });
  next();
});
if (config.trustProxy) app.set('trust proxy', 1);

// ---------- Security headers ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self' ws: wss:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '));
  if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

app.post('/api/coins/webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => require('./routes/coins').stripeWebhook(req, res));
app.use(express.json({ limit: '200kb' }));
app.use((req, _res, next) => { if (!req.body) req.body = {}; next(); });
app.use(loadUser);

// ---------- API ----------
const api = express.Router();
api.use(csrfGuard);
api.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
api.get('/health', (_req, res) => {
  try {
    require('./db').q.get('SELECT 1 AS ok');
    res.json({ ok: true, app: config.appName, uptime: Math.round(process.uptime()) });
  } catch (e) {
    console.error('[health] database check failed:', e.message);
    res.status(503).json({ ok: false, error: 'database unavailable' });
  }
});
api.use('/auth', require('./routes/auth'));
api.use('/me', require('./routes/me'));
api.use('/users', require('./routes/users'));
api.use('/videos', require('./routes/videos'));
api.use('/conversations', require('./routes/messages'));
api.use('/live', require('./routes/live'));
api.use('/admin', require('./routes/admin'));
api.use('/library', require('./routes/library'));
api.use('/stories', require('./routes/stories'));
api.use('/analytics', require('./routes/analytics'));
api.use('/coins', require('./routes/coins'));
api.use('/party', require('./routes/party'));
api.use('/push', require('./routes/push'));
api.use('/', require('./routes/discover'));
api.use('/', require('./routes/notifications'));
api.use((_req, _res, next) => next(new HttpError(404, 'API route not found')));
app.use('/api', api);

// ---------- Media (access-controlled for videos & thumbnails) ----------
function sendMedia(res, dir, file, cache = 'private, max-age=3600') {
  if (!file) return res.status(404).end();
  res.setHeader('Cache-Control', cache);
  res.sendFile(path.basename(file), { root: dir, dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) res.status(err.statusCode || 404).end();
  });
}

app.get('/media/v/:id', (req, res) => {
  const row = getVideoRow(Number(req.params.id) || 0, req.user ? req.user.id : 0);
  if (!row || !access.canViewVideo(req.user, row)) return res.status(404).end();
  res.type(row.video_mime);
  sendMedia(res, config.dirs.videos, row.video_file);
});

app.get('/media/t/:id', (req, res) => {
  const row = getVideoRow(Number(req.params.id) || 0, req.user ? req.user.id : 0);
  if (!row || !access.canViewVideo(req.user, row)) return res.status(404).end();
  if (!row.thumb_file) return res.redirect('/assets/placeholder-thumb.svg');
  sendMedia(res, config.dirs.thumbs, row.thumb_file);
});

app.get('/media/cc/:id', (req, res) => {
  const row = getVideoRow(Number(req.params.id) || 0, req.user ? req.user.id : 0);
  if (!row || !row.captions || !access.canViewVideo(req.user, row)) return res.status(404).end();
  res.type('text/vtt').setHeader('Cache-Control', 'private, max-age=600');
  res.send(row.captions);
});

app.get('/media/st/:id', (req, res) => {
  let s;
  try { s = require('./routes/stories').getStoryForMedia(req); } catch { return res.status(404).end(); }
  res.type(s.mime);
  sendMedia(res, config.dirs.stories, s.media_file);
});

const staticMedia = (dir, maxAge) => express.static(dir, { dotfiles: 'deny', index: false, maxAge, fallthrough: false });
app.use('/media/a', staticMedia(config.dirs.avatars, '7d'));
app.use('/media/s', staticMedia(config.dirs.sounds, '7d'));
app.use('/media/l', staticMedia(config.dirs.live, 0));

// ---------- Frontend (SPA) ----------
const publicDir = path.join(config.ROOT, 'public');
app.use(express.static(publicDir, { index: false, maxAge: config.isProd ? '1h' : 0 }));
const indexHtml = path.join(publicDir, 'index.html');
app.get(/^\/(?!api\/|media\/|ws$).*/, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(indexHtml);
});

// ---------- Errors ----------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  let status = 500;
  let message = 'Something went wrong. Please try again.';
  if (err instanceof HttpError) { status = err.status; message = err.message; }
  else if (err instanceof multer.MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? `File is too large (max ${Math.round(config.maxVideoBytes / 1048576)} MB for videos, 8 MB for images)` : err.message;
  } else if (err.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(err.message)) { status = 409; message = 'That already exists. Please refresh and try again.'; }
  else if (err.type === 'entity.parse.failed') { status = 400; message = 'Invalid JSON body'; }
  else if (err.type === 'entity.too.large') { status = 413; message = 'Request is too large'; }
  else if (err.status === 404) { status = 404; message = 'Not found'; }
  else console.error('[error]', req.method, req.originalUrl, err);
  if (res.headersSent) return;
  if (req.originalUrl.startsWith('/api/')) res.status(status).json({ error: message, ...(err.extra || {}) });
  else res.status(status).type('text').send(message);
});

// ---------- Boot ----------
liveRt.cleanupStale();
require('./lib/publish').startScheduler();
require('./lib/aiMod').startGuardian();
if (config.isProd || process.env.BACKUPS === 'true') require('./lib/backup').startBackups();
for (const f of fs.readdirSync(config.dirs.tmp)) fs.rm(path.join(config.dirs.tmp, f), { force: true }, () => {});
const server = http.createServer(app);
realtime.attach(server);

function start() {
  server.listen(config.port, config.host, () => {
    console.log(`\n  ${config.appName} is running at ${config.baseUrl}`);
    if (!config.mail.provider) console.log(config.isProd
      ? '  Email: NOT configured. Password-reset and confirmation emails cannot be sent.'
      : '  Email: dev mode (reset links are printed here and saved in data/outbox/)');
    console.log('');
  });

  // Graceful shutdown: hosts send SIGTERM on redeploy/restart. Finish in-flight requests, then close the DB.
  let stopping = false;
  const shutdown = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`[server] ${sig} received, shutting down`);
    const done = () => { try { require('./db').db.close(); } catch { /* already closed */ } process.exit(0); };
    server.close(done);
    setTimeout(() => { server.closeAllConnections?.(); done(); }, 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) start();

module.exports = { app, server, start };
