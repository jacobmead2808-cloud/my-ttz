'use strict';
/**
 * Push notifications to phones and installed web apps.
 *
 *  - Web Push (installed PWA / Chrome / Edge / Firefox): standard VAPID + aes128gcm encryption
 *    (RFC 8291 / RFC 8292). Works with no third-party account. Keys come from VAPID_PUBLIC_KEY /
 *    VAPID_PRIVATE_KEY, or are generated once and stored in the database.
 *  - Android app (Capacitor): Firebase Cloud Messaging HTTP v1. Needs FIREBASE_SERVICE_ACCOUNT
 *    (the service-account JSON, or a path to it) and google-services.json in the Android build.
 *
 * Delivery is best-effort and never blocks the request that triggered it.
 */
const crypto = require('crypto');
const fs = require('fs');
const config = require('../config');
const { q, now } = require('../db');
const settings = require('./settings');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

// ---------- VAPID keys ----------
let vapid = null;
function vapidKeys() {
  if (vapid) return vapid;
  let pub = process.env.VAPID_PUBLIC_KEY;
  let priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const stored = settings.get('vapid');
    if (stored && stored.publicKey) ({ publicKey: pub, privateKey: priv } = stored);
    else {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const jwk = privateKey.export({ format: 'jwk' });
      const pj = publicKey.export({ format: 'jwk' });
      pub = b64u(Buffer.concat([Buffer.from([4]), fromB64u(pj.x), fromB64u(pj.y)]));
      priv = jwk.d;
      settings.set('vapid', { publicKey: pub, privateKey: priv });
    }
  }
  const raw = fromB64u(pub);
  const key = crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: priv, x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) } });
  vapid = { publicKey: pub, key };
  return vapid;
}
settings.DEFAULTS.vapid = null;

function jwt(header, claims, sign) {
  const data = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  return `${data}.${b64u(sign(Buffer.from(data)))}`;
}

function vapidAuth(endpoint) {
  const { publicKey, key } = vapidKeys();
  const sub = config.contactEmail ? `mailto:${config.contactEmail}` : config.baseUrl;
  const token = jwt({ typ: 'JWT', alg: 'ES256' }, { aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub },
    (d) => crypto.sign('sha256', d, { key, dsaEncoding: 'ieee-p1363' }));
  return `vapid t=${token}, k=${publicKey}`;
}

/** RFC 8291 aes128gcm content encryption for one push message. */
function encrypt(payload, p256dh, authSecret) {
  const uaPublic = fromB64u(p256dh);
  const auth = fromB64u(authSecret);
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const prkKey = hmac(auth, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const salt = crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

async function sendWeb(sub, message) {
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { Authorization: vapidAuth(sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' },
    body: encrypt(JSON.stringify(message), sub.p256dh, sub.auth),
  });
  if (res.status === 404 || res.status === 410) return 'gone';
  if (!res.ok) throw new Error(`web push ${res.status}`);
  return 'ok';
}

// ---------- Firebase Cloud Messaging (Android app) ----------
let fcmAccount;
function fcmConfig() {
  if (fcmAccount !== undefined) return fcmAccount;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  fcmAccount = null;
  if (!raw) return null;
  try {
    const json = raw.trim().startsWith('{') ? raw : fs.readFileSync(raw, 'utf8');
    const a = JSON.parse(json);
    if (a.client_email && a.private_key && a.project_id) fcmAccount = a;
    else console.error('[push] FIREBASE_SERVICE_ACCOUNT is missing client_email/private_key/project_id');
  } catch (e) { console.error('[push] FIREBASE_SERVICE_ACCOUNT could not be read:', e.message); }
  return fcmAccount;
}

let fcmToken = null;
async function fcmAccessToken(a) {
  if (fcmToken && fcmToken.exp > Date.now() + 60000) return fcmToken.value;
  const iat = Math.floor(Date.now() / 1000);
  const tokenUri = a.token_uri || 'https://oauth2.googleapis.com/token';
  const assertion = jwt({ alg: 'RS256', typ: 'JWT' }, { iss: a.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: tokenUri, iat, exp: iat + 3600 },
    (d) => crypto.sign('sha256', d, a.private_key));
  const res = await fetch(tokenUri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  if (!res.ok) throw new Error(`FCM auth ${res.status}`);
  const j = await res.json();
  fcmToken = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return fcmToken.value;
}

async function sendFcm(sub, message) {
  const a = fcmConfig();
  if (!a) return 'skip';
  const base = process.env.FCM_API_BASE || 'https://fcm.googleapis.com';
  const res = await fetch(`${base}/v1/projects/${a.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await fcmAccessToken(a)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: {
      token: sub.endpoint,
      notification: { title: message.title, body: message.body },
      data: { url: message.url || '/' },
      android: { priority: 'high', notification: { icon: 'ic_stat_notify', color: '#1f6feb', tag: message.tag || undefined, channel_id: 'clipzy' } },
    } }),
  });
  if (res.status === 404 || res.status === 400) {
    const t = await res.text();
    if (/UNREGISTERED|INVALID_ARGUMENT|not a valid FCM registration token/i.test(t)) return 'gone';
    throw new Error(`FCM ${res.status}: ${t.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`FCM ${res.status}`);
  return 'ok';
}

// ---------- Subscriptions ----------
function subscribe(userId, { type, endpoint, p256dh = null, auth = null, userAgent = null }) {
  q.run(`INSERT INTO push_subscriptions (user_id, kind, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, kind = excluded.kind, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
  userId, type, endpoint, p256dh, auth, userAgent, now());
}

function unsubscribe(userId, endpoint) {
  return q.run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', userId, endpoint).changes;
}

/** Send to every device of a user. Resolves with per-device results (used by tests). */
async function sendToUser(userId, message) {
  const subs = q.all('SELECT * FROM push_subscriptions WHERE user_id = ?', userId);
  return Promise.all(subs.map(async (s) => {
    try {
      const r = s.kind === 'fcm' ? await sendFcm(s, message) : await sendWeb(s, message);
      if (r === 'gone') q.run('DELETE FROM push_subscriptions WHERE id = ?', s.id);
      return r;
    } catch (e) {
      console.error('[push]', s.kind, e.message);
      return 'error';
    }
  }));
}

const TEXT = {
  like: 'liked your video', comment_like: 'liked your comment', comment: 'commented on your video', reply: 'replied to your comment',
  mention: 'mentioned you', follow: 'started following you', follow_request: 'requested to follow you', follow_accept: 'accepted your follow request',
  live: 'is LIVE now', repost: 'reposted your video', duet: 'made a Duet with your video', stitch: 'Stitched your video',
  video_reply: 'replied to your comment with a video', gift_received: 'sent you a gift',
};

/** Build and send the push for a new in-app notification (fire-and-forget). */
function forNotification({ userId, actorId, type, videoId, streamId, body }) {
  if (!q.get('SELECT 1 FROM push_subscriptions WHERE user_id = ? LIMIT 1', userId)) return;
  const actor = actorId ? q.get('SELECT username, display_name FROM users WHERE id = ?', actorId) : null;
  const who = actor ? actor.display_name || `@${actor.username}` : config.appName;
  const text = TEXT[type] ? `${who} ${TEXT[type]}` : (body || 'You have a new notification');
  const url = streamId ? `/live/${streamId}` : videoId ? `/video/${videoId}` : actor && ['follow', 'follow_request', 'follow_accept'].includes(type) ? `/@${actor.username}` : '/inbox';
  sendToUser(userId, { title: config.appName, body: body && TEXT[type] && ['comment', 'reply', 'live'].includes(type) ? `${text}: ${body.slice(0, 100)}` : text, url, tag: `${type}:${videoId || streamId || actorId || ''}` }).catch(() => {});
}

function forMessage({ toUserId, from, conversationId, text }) {
  if (!q.get('SELECT 1 FROM push_subscriptions WHERE user_id = ? LIMIT 1', toUserId)) return;
  sendToUser(toUserId, { title: from.display_name || `@${from.username}`, body: text ? text.slice(0, 120) : 'Sent you a video', url: `/messages/${conversationId}`, tag: `dm:${conversationId}` }).catch(() => {});
}

const publicConfig = () => ({ webPushKey: vapidKeys().publicKey, fcm: !!fcmConfig() });

module.exports = { subscribe, unsubscribe, sendToUser, forNotification, forMessage, publicConfig, encrypt, _reset: () => { vapid = null; fcmAccount = undefined; fcmToken = null; } };
