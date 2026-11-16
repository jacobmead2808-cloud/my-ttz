'use strict';
const express = require('express');
const config = require('../config');
const { q, now } = require('../db');
const v = require('../lib/validate');
const { bad, unauthorized, forbidden, conflict } = require('../lib/errors');
const auth = require('../lib/auth');
const { limit } = require('../lib/rateLimit');
const { sendMail } = require('../lib/mailer');
const { unreadCount } = require('../lib/notify');
const { meJson } = require('./me');
const settings = require('../lib/settings');
const automod = require('../lib/automod');

const router = express.Router();

const loginLimit = limit({ windowMs: 15 * 60 * 1000, max: 20, key: (req) => `login:${req.ip}`, message: 'Too many login attempts. Try again in a few minutes.' });
const registerLimit = limit({ windowMs: 60 * 60 * 1000, max: 15, key: (req) => `reg:${req.ip}`, message: 'Too many sign-ups from this network. Try again later.' });
const resetLimit = limit({ windowMs: 60 * 60 * 1000, max: 8, key: (req) => `reset:${req.ip}` });

router.post('/register', registerLimit, async (req, res) => {
  if (!settings.get('platform').registrationsOpen) throw forbidden('New sign-ups are currently closed.');
  const email = v.email(req.body.email);
  const username = v.username(req.body.username);
  const password = v.password(req.body.password);
  const displayName = v.str(req.body.displayName, { name: 'Display name', max: 40 }) || username;
  const cfg = settings.get('automod');
  if (cfg.enabled && automod.findWord(`${username.replace(/[._]/g, ' ')} ${displayName}`, cfg.blockedWords)) throw bad('That username or name is not allowed.');
  if (q.get('SELECT 1 FROM users WHERE email = ?', email)) throw conflict('An account with this email already exists');
  if (q.get('SELECT 1 FROM users WHERE username = ?', username)) throw conflict('That username is taken');
  const hash = await auth.hashPassword(password);
  const r = q.run('INSERT INTO users (username, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)',
    username, email, hash, displayName, now());
  auth.createSession(res, Number(r.lastInsertRowid), req.get('user-agent'));
  const user = q.get('SELECT * FROM users WHERE id = ?', r.lastInsertRowid);
  res.status(201).json({ user: meJson(user) });
});

function statusMessage(u) {
  if (u.status === 'banned') return `This account has been banned.${u.status_reason ? ' Reason: ' + u.status_reason : ''}`;
  if (u.status === 'suspended') {
    const until = u.suspended_until ? new Date(u.suspended_until).toUTCString() : 'further notice';
    return `This account is suspended until ${until}.${u.status_reason ? ' Reason: ' + u.status_reason : ''}`;
  }
  return null;
}

router.post('/login', loginLimit, async (req, res) => {
  const login = v.str(req.body.login, { name: 'Email or username', required: true, max: 254 }).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!password) throw bad('Password is required');
  const user = q.get('SELECT * FROM users WHERE email = ? OR username = ?', login, login);
  // Always run a hash comparison so response time does not reveal whether the account exists.
  const ok = await auth.verifyPassword(password, user ? user.password_hash : 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
  if (!user || !ok) throw unauthorized('Incorrect email/username or password');
  auth.refreshStatus(user);
  const blocked = statusMessage(user);
  if (blocked) throw forbidden(blocked);
  auth.createSession(res, user.id, req.get('user-agent'));
  res.json({ user: meJson(user) });
});

router.post('/logout', (req, res) => {
  auth.destroySession(req, res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null, config: { appName: config.appName, platform: settings.get('platform') } });
  const unreadMessages = q.get(`SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE (c.user_a = ? OR c.user_b = ?) AND m.sender_id <> ? AND m.read_at IS NULL`, req.user.id, req.user.id, req.user.id).n;
  res.json({
    user: meJson(req.user),
    unread: { notifications: unreadCount(req.user.id), messages: unreadMessages, cases: req.user.role === 'admin' ? q.get("SELECT COUNT(*) AS n FROM mod_cases WHERE status = 'open'").n : 0 },
    config: { appName: config.appName, iceServers: config.iceServers, platform: settings.get('platform') },
  });
});

router.post('/forgot', resetLimit, async (req, res) => {
  const email = v.email(req.body.email);
  const user = q.get('SELECT * FROM users WHERE email = ?', email);
  let devNote = null;
  if (user && user.status !== 'banned') {
    const token = auth.randomToken();
    q.run('DELETE FROM password_resets WHERE user_id = ?', user.id);
    q.run('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)', auth.sha256(token), user.id, now() + 60 * 60 * 1000);
    const link = `${config.baseUrl}/reset?token=${encodeURIComponent(token)}`;
    const result = await sendMail({
      to: user.email,
      subject: `Reset your ${config.appName} password`,
      text: `Hi @${user.username},\n\nSomeone requested a password reset for your ${config.appName} account.\nUse this link within 1 hour:\n\n${link}\n\nIf this wasn't you, you can ignore this email.`,
    }).catch((e) => { console.error('[mail] failed', e.message); return { delivered: false }; });
    if (!result.delivered) devNote = 'Email delivery is not configured. In development the reset link is printed in the server console and saved in data/outbox/.';
  } else if (!config.mail.provider) {
    devNote = 'Email delivery is not configured. In development the reset link is printed in the server console and saved in data/outbox/.';
  }
  // Same response whether or not the email exists (prevents account enumeration).
  res.json({ ok: true, message: 'If an account exists for that email, a reset link has been sent.', devNote: config.isProd ? null : devNote });
});

router.post('/reset', resetLimit, async (req, res) => {
  const token = v.str(req.body.token, { name: 'Token', required: true, max: 200 });
  const password = v.password(req.body.password);
  const row = q.get('SELECT * FROM password_resets WHERE token_hash = ?', auth.sha256(token));
  if (!row || row.used || row.expires_at < now()) throw bad('This reset link is invalid or has expired. Please request a new one.');
  const hash = await auth.hashPassword(password);
  q.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, row.user_id);
  q.run('UPDATE password_resets SET used = 1 WHERE token_hash = ?', row.token_hash);
  q.run('DELETE FROM sessions WHERE user_id = ?', row.user_id); // log out everywhere
  res.json({ ok: true });
});

module.exports = router;
