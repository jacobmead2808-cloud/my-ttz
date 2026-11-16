'use strict';
/**
 * Account safety helpers: email verification and age rules.
 *   - Everyone must be 13+ to sign up.
 *   - Under-18 accounts start private with DMs limited to friends, and can't go LIVE, buy coins or send gifts.
 *   - When email verification is required (always in production unless REQUIRE_EMAIL_VERIFICATION=false),
 *     unverified accounts can browse but can't post, comment, message, go LIVE or buy coins.
 */
const config = require('../config');
const { q, now } = require('../db');
const { bad, forbidden } = require('./errors');
const { sha256, randomToken } = require('./auth');
const { sendMail } = require('./mailer');

const MIN_AGE = 13;
const ADULT_AGE = 18;

/** Parse YYYY-MM-DD into a valid past date string, or throw. */
function parseBirthDate(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw bad('Please enter your date of birth');
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (Number.isNaN(d.getTime()) || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw bad('Please enter a real date of birth');
  if (+m[1] < 1900 || d.getTime() > Date.now()) throw bad('Please enter a real date of birth');
  return s;
}

function ageOn(birthDate, at = new Date()) {
  if (!birthDate) return null;
  const [y, mo, d] = birthDate.split('-').map(Number);
  let age = at.getUTCFullYear() - y;
  if (at.getUTCMonth() + 1 < mo || (at.getUTCMonth() + 1 === mo && at.getUTCDate() < d)) age--;
  return age;
}

const isAdult = (user) => { const a = ageOn(user.birth_date); return a === null ? null : a >= ADULT_AGE; };

/** Throws unless the user is a confirmed adult (LIVE, coins, gifts). */
function requireAdult(user, what) {
  const adult = isAdult(user);
  if (adult === null) throw forbidden(`Add your date of birth in Settings → Account to ${what}.`);
  if (!adult) throw forbidden(`You must be ${ADULT_AGE} or older to ${what}.`);
}

/** Express middleware: block content creation until the email address is verified. */
function requireVerified(req, _res, next) {
  if (config.requireEmailVerification && req.user && !req.user.email_verified)
    return next(forbidden('Please verify your email address first — check your inbox, or resend the link from the banner.'));
  next();
}

async function sendVerification(user) {
  const token = randomToken();
  q.run('DELETE FROM email_verifications WHERE user_id = ?', user.id);
  q.run('INSERT INTO email_verifications (token_hash, user_id, email, expires_at) VALUES (?, ?, ?, ?)', sha256(token), user.id, user.email, now() + 48 * 3600000);
  const link = `${config.baseUrl}/verify-email?token=${encodeURIComponent(token)}`;
  return sendMail({
    to: user.email,
    subject: `Confirm your ${config.appName} email`,
    text: `Hi @${user.username},\n\nConfirm your email address to start posting on ${config.appName}:\n\n${link}\n\nThis link expires in 48 hours. If you didn't create an account, you can ignore this email.`,
  }).catch((e) => { console.error('[mail] verification failed', e.message); return { delivered: false }; });
}

/** Mark the email verified if the token is valid and still matches the account's current email. */
function confirmVerification(token) {
  const row = q.get('SELECT * FROM email_verifications WHERE token_hash = ?', sha256(String(token || '')));
  if (!row || row.expires_at < now()) throw bad('This verification link is invalid or has expired. Request a new one from the banner.');
  const u = q.get('SELECT * FROM users WHERE id = ?', row.user_id);
  if (!u || u.email !== row.email) throw bad('This link was for a different email address. Request a new one.');
  q.run('UPDATE users SET email_verified = 1 WHERE id = ?', u.id);
  q.run('DELETE FROM email_verifications WHERE user_id = ?', u.id);
  return u;
}

module.exports = { MIN_AGE, ADULT_AGE, parseBirthDate, ageOn, isAdult, requireAdult, requireVerified, sendVerification, confirmVerification };
