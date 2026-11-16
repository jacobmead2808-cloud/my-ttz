'use strict';
/**
 * Auto-moderation engine. Applies platform rules (owner/admin configured) and creator rules
 * (each user's own keyword filters) to comments, LIVE chat, DMs, captions and profiles.
 *
 * check() returns { action: 'allow' | 'hold' | 'block', rule, message }.
 *   hold  -> content is saved but hidden from everyone except its author (creator can review)
 *   block -> content is rejected with an error
 */
const { q, now } = require('../db');
const settings = require('./settings');

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };

/** Lowercase, undo common leetspeak and collapse letter repeats ("fr333 f0llowers" -> "free followers"). */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[013457@$!]/g, (c) => LEET[c] || c)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/(.)\1{2,}/g, '$1$1')
    .replace(/[^\p{L}\p{N}\s*]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Return the first word/phrase from list found in text (whole-word; "word*" matches prefixes). */
function findWord(text, list) {
  if (!list || !list.length) return null;
  const norm = ` ${normalize(text)} `;
  const squashed = norm.replace(/ /g, '');
  for (const raw of list) {
    const w = normalize(raw).replace(/\*/g, '');
    if (!w) continue;
    const prefix = String(raw).trim().endsWith('*');
    const re = new RegExp(`(^|\\s)${escapeRe(w)}${prefix ? '' : '(?=\\s|$)'}`);
    if (re.test(norm)) return raw;
    // catch spaced-out evasion like "s c a m" for single words of 4+ letters
    if (!w.includes(' ') && w.length >= 4 && !prefix && squashed.includes(w) && /(\b\w\b\s){3,}/.test(norm)) return raw;
  }
  return null;
}

const LINK_RE = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|net|org|io|gg|ly|me|co|xyz|link|shop|app)\b/i;
const recent = new Map(); // userId -> [{ t, text }]
setInterval(() => {
  const cut = Date.now() - 120000;
  for (const [k, arr] of recent) {
    const kept = arr.filter((x) => x.t > cut);
    if (kept.length) recent.set(k, kept); else recent.delete(k);
  }
}, 60000).unref();

function log(user, context, content, rule, action, targetOwnerId = null) {
  q.run('INSERT INTO automod_log (user_id, context, content, rule, action, target_owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    user ? user.id : null, context, String(content).slice(0, 500), rule, action, targetOwnerId, now());
  if (user && user.id) require('./aiMod').observe(user.id, 'automod');
}

/**
 * @param {string} text
 * @param {object} opts { user, context: 'comment'|'live_chat'|'dm'|'caption'|'profile', owner: user whose filters apply }
 */
function check(text, { user, context, owner = null } = {}) {
  const cfg = settings.get('automod');
  const result = (action, rule, message) => {
    if (action !== 'allow') log(user, context, text, rule, action, owner ? owner.id : null);
    return { action, rule, message };
  };
  if (!text || !user) return { action: 'allow' };
  const privileged = user.role === 'admin';

  if (user.comment_banned && ['comment', 'live_chat', 'dm'].includes(context))
    return result('block', 'restricted', 'Your account is restricted from commenting and messaging.');

  if (cfg.enabled && !privileged) {
    const strict = ['caption', 'profile', 'dm'].includes(context) ? 'block' : cfg.action;

    if (cfg.newAccountMinutes > 0 && ['comment', 'live_chat'].includes(context) && Date.now() - user.created_at < cfg.newAccountMinutes * 60000)
      return result('block', 'new_account', `New accounts can comment after ${cfg.newAccountMinutes} minutes.`);

    const word = findWord(text, cfg.blockedWords);
    if (word) return result(strict, 'blocked_word', 'This contains words that aren’t allowed on this platform.');

    if (cfg.blockLinks && ['comment', 'live_chat'].includes(context) && LINK_RE.test(text)
      && Date.now() - user.created_at < (cfg.linkMinAgeHours || 0) * 3600000)
      return result(strict, 'link', 'Links aren’t allowed from new accounts.');

    const mentions = (String(text).match(/@[a-z0-9_.]{2,}/gi) || []).length;
    if (cfg.maxMentions && mentions > cfg.maxMentions) return result(strict, 'mass_mention', `You can mention at most ${cfg.maxMentions} people at once.`);

    if (cfg.capsFilter && ['comment', 'live_chat'].includes(context)) {
      const letters = String(text).replace(/[^A-Za-z]/g, '');
      if (letters.length >= 12 && letters.replace(/[^A-Z]/g, '').length / letters.length >= 0.8) return result(strict, 'caps', 'Please don’t shout (too many capital letters).');
    }

    if (cfg.repeatLimit && ['comment', 'live_chat', 'dm'].includes(context)) {
      const norm = normalize(text);
      const arr = recent.get(user.id) || [];
      const same = arr.filter((x) => x.text === norm && x.t > Date.now() - 120000).length;
      arr.push({ t: Date.now(), text: norm });
      recent.set(user.id, arr.slice(-30));
      if (same >= cfg.repeatLimit) return result('block', 'spam_repeat', 'You’re sending the same message too often.');
    }
  }

  // Creator-level filters (comments on their videos, chat in their LIVE)
  if (owner && owner.id !== user.id && ['comment', 'live_chat'].includes(context)) {
    let keywords = [];
    try { keywords = JSON.parse(owner.filter_keywords || '[]'); } catch { /* ignore */ }
    if (findWord(text, keywords)) return result('hold', 'creator_keyword', 'Your comment is only visible to you.');
    if (owner.filter_links && LINK_RE.test(text)) return result('hold', 'creator_links', 'Your comment is only visible to you.');
  }
  return { action: 'allow' };
}

/** Throw-style helper for contexts where holding makes no sense (captions, profiles, DMs). */
function assertAllowed(text, opts) {
  const r = check(text, opts);
  if (r.action !== 'allow') {
    const { bad } = require('./errors');
    throw bad(r.message || 'This content isn’t allowed.');
  }
}

module.exports = { check, assertAllowed, normalize, findWord, log };
