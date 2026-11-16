'use strict';
const { q, now } = require('../db');
const hub = require('../realtime/hub');
const { isBlocked } = require('./access');
const { extractMentions } = require('./validate');

/**
 * Create a notification and push the new unread count over WebSocket.
 * Repeated likes/follows from the same actor on the same target are collapsed.
 */
function notify({ userId, actorId, type, videoId = null, commentId = null, streamId = null, body = null }) {
  if (!userId || userId === actorId) return;
  if (actorId && isBlocked(userId, actorId)) return;
  if (['like', 'follow', 'follow_request', 'comment_like'].includes(type)) {
    const existing = q.get(
      'SELECT id FROM notifications WHERE user_id = ? AND actor_id IS ? AND type = ? AND video_id IS ? AND comment_id IS ?',
      userId, actorId, type, videoId, commentId);
    if (existing) {
      q.run('UPDATE notifications SET is_read = 0, created_at = ? WHERE id = ?', now(), existing.id);
      pushCount(userId);
      return;
    }
  }
  q.run('INSERT INTO notifications (user_id, actor_id, type, video_id, comment_id, stream_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    userId, actorId, type, videoId, commentId, streamId, body, now());
  pushCount(userId, type);
}

function unnotify({ userId, actorId, type, videoId = null, commentId = null }) {
  q.run('DELETE FROM notifications WHERE user_id = ? AND actor_id IS ? AND type = ? AND video_id IS ? AND comment_id IS ?',
    userId, actorId, type, videoId, commentId);
  pushCount(userId);
}

function unreadCount(userId) {
  return q.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', userId).n;
}

function pushCount(userId, type) {
  hub.sendToUser(userId, { type: 'notification', unread: unreadCount(userId), kind: type || null });
}

/** Notify every @mentioned user in text (skips the actor and unknown usernames). */
function notifyMentions(text, { actorId, videoId = null, commentId = null, exclude = [] }) {
  for (const name of extractMentions(text)) {
    const u = q.get("SELECT id FROM users WHERE username = ? AND status = 'active'", name);
    if (u && !exclude.includes(u.id)) notify({ userId: u.id, actorId, type: 'mention', videoId, commentId });
  }
}

module.exports = { notify, unnotify, unreadCount, notifyMentions };
