'use strict';
const { bad } = require('./errors');

const RESERVED = new Set(['admin', 'api', 'login', 'signup', 'logout', 'settings', 'upload', 'explore', 'live', 'inbox',
  'messages', 'search', 'tag', 'sound', 'video', 'media', 'following', 'foryou', 'support', 'help', 'root', 'system', 'moderator',
  'suggested', 'reset', 'forgot', 'me']);

function str(v, { name, min = 0, max = 1000, required = false, trim = true } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw bad(`${name} must be text`);
  if (trim) v = v.trim();
  // strip control chars except newlines/tabs
  v = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (required && !v) throw bad(`${name} is required`);
  if (v.length < min) throw bad(`${name} must be at least ${min} characters`);
  if (v.length > max) throw bad(`${name} must be at most ${max} characters`);
  return v;
}

function username(v, { allowReserved = false } = {}) {
  v = str(v, { name: 'Username', required: true, min: 2, max: 24 }).toLowerCase();
  if (!/^[a-z0-9_][a-z0-9_.]*$/.test(v) || v.endsWith('.') || v.includes('..'))
    throw bad('Username can only contain letters, numbers, underscores and dots');
  if (!allowReserved && RESERVED.has(v)) throw bad('That username is reserved');
  return v;
}

// Phones and browsers often autofill an email into the username box; the '@' gets stripped and the
// username ends up revealing the address (e.g. "jane.doe92gmail.com"). Usernames and display names
// are public, so anything that looks like an email address is refused.
const MAIL_DOMAINS = /(gmail|googlemail|hotmail|outlook|yahoo|ymail|icloud|aol|protonmail|proton|gmx|yandex|msn|btinternet|sky|virginmedia|live|mail)\.?(com|co\.?uk|net|org|me|de|fr|ru|ca|ie)(?![a-z0-9])/;
function assertNoEmail(value, accountEmail, what = 'Username') {
  const s = String(value || '').toLowerCase();
  if (!s) return;
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/.test(s) || MAIL_DOMAINS.test(s.replace(/[\s_]/g, ''))) throw bad(`${what} can’t contain an email address — it’s shown publicly.`);
  if (accountEmail) {
    const [local, domain = ''] = String(accountEmail).toLowerCase().split('@');
    const squash = (x) => x.replace(/[^a-z0-9]/g, '');
    const site = squash(domain.split('.')[0] || '');
    if (site && squash(s).includes(squash(local) + site))
      throw bad(`${what} can’t contain your email address — it’s shown publicly.`);
  }
}

function email(v) {
  v = str(v, { name: 'Email', required: true, max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) throw bad('Please enter a valid email address');
  return v;
}

// The most common passwords seen in breaches (letters+digits variants that pass the basic rules).
const COMMON_PASSWORDS = new Set(['password1', 'password12', 'password123', 'passw0rd', 'passw0rd1', 'qwerty123', 'qwerty1', 'abc12345', 'abcd1234',
  'iloveyou1', 'welcome1', 'welcome123', 'letmein1', 'monkey123', 'dragon123', 'football1', 'baseball1', 'sunshine1', 'princess1',
  'admin123', 'admin1234', 'login123', 'master123', 'hello123', 'charlie1', 'trustno1', 'superman1', 'batman123', 'starwars1',
  '1q2w3e4r', '1qaz2wsx', 'zaq12wsx', 'q1w2e3r4', 'a1b2c3d4', 'test1234', 'changeme1', 'secret123', 'p4ssword', 'pa55word',
  'clipzy123', 'clipzy1234', 'tiktok123', 'qwertyuiop1', 'asdfgh123', 'loveyou1', 'freedom1', 'computer1', 'whatever1', 'shadow123']);

function password(v) {
  if (typeof v !== 'string' || v.length < 8) throw bad('Password must be at least 8 characters');
  if (v.length > 200) throw bad('Password is too long');
  if (!/[a-zA-Z]/.test(v) || !/[0-9]/.test(v)) throw bad('Password must contain at least one letter and one number');
  if (COMMON_PASSWORDS.has(v.toLowerCase())) throw bad('That password is too common. Please choose something harder to guess.');
  return v;
}

function oneOf(v, options, name) {
  if (!options.includes(v)) throw bad(`${name} must be one of: ${options.join(', ')}`);
  return v;
}

function int(v, name = 'id') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad(`Invalid ${name}`);
  return n;
}

function bool(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
}

const HASHTAG_RE = /#([\p{L}\p{N}_]{1,50})/gu;
const MENTION_RE = /(^|[^\w@])@([a-zA-Z0-9_][a-zA-Z0-9_.]{1,23})/g;

function extractHashtags(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(HASHTAG_RE)) out.add(m[1].toLowerCase());
  return [...out].slice(0, 30);
}

function extractMentions(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(MENTION_RE)) out.add(m[2].toLowerCase().replace(/\.+$/, ''));
  return [...out].slice(0, 20);
}

function likeEscape(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

module.exports = { str, username, assertNoEmail, email, password, oneOf, int, bool, extractHashtags, extractMentions, likeEscape };
