'use strict';
const express = require('express');
const { q, tx, now } = require('../db');
const v = require('../lib/validate');
const { bad, notFound, forbidden } = require('../lib/errors');
const { requireAuth } = require('../lib/auth');
const { limit } = require('../lib/rateLimit');
const access = require('../lib/access');
const hub = require('../realtime/hub');
const { userBrief, getVideoRow } = require('../lib/serialize');
const automod = require('../lib/automod');

const router = express.Router();
router.use(requireAuth);
const { requireVerified } = require('../lib/accounts');
const sendLimit = limit({ windowMs: 60 * 1000, max: 40, key: (req) => `dm:${req.user.id}`, message: 'You are sending messages too quickly' });

function getConversation(req) {
  const c = q.get('SELECT * FROM conversations WHERE id = ?', v.int(req.params.id, 'conversation'));
  if (!c || (c.user_a !== req.user.id && c.user_b !== req.user.id)) throw notFound('Conversation not found');
  c.otherId = c.user_a === req.user.id ? c.user_b : c.user_a;
  return c;
}

function unreadTotal(userId) {
  return q.get(`SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE (c.user_a = ? OR c.user_b = ?) AND m.sender_id <> ? AND m.read_at IS NULL`, userId, userId, userId).n;
}

function serializeMessage(m, viewer) {
  let video = null;
  if (m.video_id) {
    const row = getVideoRow(m.video_id, viewer.id);
    if (row && access.canViewVideo(viewer, row))
      video = { id: row.id, caption: row.caption, thumbUrl: row.thumb_file ? `/media/t/${row.id}?t=${row.updated_at}` : null, author: row.username };
    else video = { id: m.video_id, unavailable: true };
  }
  return { id: m.id, conversationId: m.conversation_id, senderId: m.sender_id, body: m.body, video, readAt: m.read_at, createdAt: m.created_at };
}

router.get('/', (req, res) => {
  const me = req.user.id;
  const rows = q.all(`SELECT c.*, u.id AS uid, u.username, u.display_name, u.avatar_url, u.is_verified, u.status AS ustatus,
      (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
      (SELECT video_id FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_video,
      (SELECT sender_id FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_sender,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id <> :me AND m.read_at IS NULL) AS unread
    FROM conversations c JOIN users u ON u.id = CASE WHEN c.user_a = :me THEN c.user_b ELSE c.user_a END
    WHERE (c.user_a = :me OR c.user_b = :me) AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
    ORDER BY c.last_message_at DESC LIMIT 100`, { me });
  res.json({
    conversations: rows.map((r) => ({
      id: r.id,
      user: { ...userBrief({ id: r.uid, username: r.username, display_name: r.display_name, avatar_url: r.avatar_url, is_verified: r.is_verified }), online: hub.isOnline(r.uid), active: r.ustatus === 'active' },
      lastMessage: { body: r.last_video && !r.last_body ? 'Shared a video' : r.last_body, fromMe: r.last_sender === me },
      lastMessageAt: r.last_message_at,
      unread: r.unread,
    })),
    unreadTotal: unreadTotal(me),
  });
});

/** Open (or create) a conversation with a user. */
router.post('/', requireVerified, (req, res) => {
  const other = q.get('SELECT * FROM users WHERE username = ?', v.username(req.body.username, { allowReserved: true }));
  if (!other) throw notFound('User not found');
  const existing = q.get('SELECT * FROM conversations WHERE user_a = ? AND user_b = ?', Math.min(req.user.id, other.id), Math.max(req.user.id, other.id));
  if (existing) return res.json({ id: existing.id });
  const check = access.canMessage(req.user, other);
  if (!check.ok) throw forbidden(check.reason);
  const r = q.run('INSERT INTO conversations (user_a, user_b, created_at, last_message_at) VALUES (?, ?, ?, ?)',
    Math.min(req.user.id, other.id), Math.max(req.user.id, other.id), now(), now());
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

router.get('/:id', (req, res) => {
  const c = getConversation(req);
  const other = q.get('SELECT * FROM users WHERE id = ?', c.otherId);
  const check = access.canMessage(req.user, other);
  res.json({
    id: c.id,
    user: { ...userBrief(other), online: hub.isOnline(other.id), active: other.status === 'active' },
    canSend: check.ok,
    reason: check.ok ? null : check.reason,
  });
});

router.get('/:id/messages', (req, res) => {
  const c = getConversation(req);
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = q.all('SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT 50', c.id, before);
  res.json({ messages: rows.reverse().map((m) => serializeMessage(m, req.user)), hasMore: rows.length === 50 });
});

router.post('/:id/messages', requireVerified, sendLimit, (req, res) => {
  const c = getConversation(req);
  const other = q.get('SELECT * FROM users WHERE id = ?', c.otherId);
  const check = access.canMessage(req.user, other);
  if (!check.ok) throw forbidden(check.reason);
  const body = v.str(req.body.body, { name: 'Message', max: 2000 });
  let videoId = null;
  if (req.body.videoId) {
    videoId = v.int(req.body.videoId, 'video');
    const row = getVideoRow(videoId, req.user.id);
    if (!row || !access.canViewVideo(req.user, row)) throw bad('That video cannot be shared');
  }
  if (!body && !videoId) throw bad('Message cannot be empty');
  if (body) automod.assertAllowed(body, { user: req.user, context: 'dm' });
  const t = now();
  const m = tx(() => {
    const r = q.run('INSERT INTO messages (conversation_id, sender_id, body, video_id, created_at) VALUES (?, ?, ?, ?, ?)', c.id, req.user.id, body, videoId, t);
    q.run('UPDATE conversations SET last_message_at = ? WHERE id = ?', t, c.id);
    return q.get('SELECT * FROM messages WHERE id = ?', r.lastInsertRowid);
  });
  require('../lib/aiMod').observe(req.user.id, 'dm');
  const forSender = serializeMessage(m, req.user);
  hub.sendToUser(other.id, {
    type: 'dm:new',
    message: serializeMessage(m, other),
    from: userBrief(req.user),
    unreadTotal: unreadTotal(other.id),
  });
  hub.sendToUser(req.user.id, { type: 'dm:sent', message: forSender });
  require('../lib/push').forMessage({ toUserId: other.id, from: req.user, conversationId: c.id, text: body });
  res.status(201).json({ message: forSender });
});

router.post('/:id/read', (req, res) => {
  const c = getConversation(req);
  const t = now();
  const r = q.run('UPDATE messages SET read_at = ? WHERE conversation_id = ? AND sender_id <> ? AND read_at IS NULL', t, c.id, req.user.id);
  if (r.changes) hub.sendToUser(c.otherId, { type: 'dm:read', conversationId: c.id, readAt: t });
  const total = unreadTotal(req.user.id);
  hub.sendToUser(req.user.id, { type: 'dm:unread', unreadTotal: total });
  res.json({ unreadTotal: total });
});

module.exports = router;
