'use strict';
/**
 * LIVE rooms: WebRTC signaling (host fans out one peer connection per viewer), viewer counts,
 * chat with auto-moderation, likes, reactions and host/moderator tools (mute, remove, delete,
 * pin, slow mode, followers-only chat). Room state lives in memory; streams, chat, moderators,
 * removals and totals are persisted to SQLite.
 */
const { q, now } = require('../db');
const hub = require('./hub');
const { isBlocked, isFollowing } = require('../lib/access');
const { createLimiter } = require('../lib/rateLimit');
const automod = require('../lib/automod');
const settings = require('../lib/settings');

const rooms = new Map(); // streamId -> room
const HOST_GRACE_MS = 20000;
const REACTIONS = ['❤️', '😂', '🔥', '👏', '😮', '🎉', '🌹', '💎'];
const SLOW_OPTIONS = [0, 3, 10, 30, 60];
const chatLimit = createLimiter({ windowMs: 10000, max: 12 });
const likeLimit = createLimiter({ windowMs: 1000, max: 10 });

function getRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    const s = q.get('SELECT * FROM live_streams WHERE id = ?', id);
    r = {
      hostId: s ? s.user_id : null,
      host: null,
      viewers: new Map(),
      likes: s ? s.total_likes : 0,
      peak: s ? s.peak_viewers : 0,
      slowMode: s ? s.slow_mode : 0,
      goal: s && s.goal_type ? { type: s.goal_type, target: s.goal_target, label: s.goal_label || '' } : null,
      giftCoins: s ? (q.get('SELECT COALESCE(SUM(coins), 0) AS n FROM gift_events WHERE stream_id = ?', id).n) : 0,
      newFollowers: s ? s.new_followers : 0,
      followersOnly: s ? !!s.followers_only : false,
      pinned: null,
      mutes: new Map(), // userId -> until (ms) ; Infinity = rest of LIVE
      lastChat: new Map(),
      endTimer: null,
      likeFlush: null,
    };
    rooms.set(id, r);
  }
  return r;
}

const viewerCount = (id) => (rooms.get(id) ? rooms.get(id).viewers.size : 0);

function broadcast(room, msg, except) {
  const data = JSON.stringify(msg);
  if (room.host && room.host !== except) hub.send(room.host, data);
  for (const v of room.viewers.values()) if (v !== except) hub.send(v, data);
}

function system(room, id, text) {
  broadcast(room, { type: 'live:system', streamId: id, text });
}

function broadcastViewers(id, room) {
  const n = room.viewers.size;
  if (n > room.peak) {
    room.peak = n;
    q.run('UPDATE live_streams SET peak_viewers = ? WHERE id = ? AND peak_viewers < ?', n, id, n);
  }
  broadcast(room, { type: 'live:viewers', streamId: id, count: n });
}

function liveStream(id) {
  return q.get("SELECT ls.*, u.username, u.filter_keywords, u.filter_links FROM live_streams ls JOIN users u ON u.id = ls.user_id WHERE ls.id = ? AND ls.status = 'live'", id);
}

/** 'host' | 'mod' | 'admin' | 'viewer' */
function roleOf(user, room) {
  if (!user) return 'viewer';
  if (user.id === room.hostId) return 'host';
  if (q.get('SELECT 1 FROM live_moderators WHERE host_id = ? AND mod_id = ?', room.hostId, user.id)) return 'mod';
  if (user.role === 'admin') return 'admin';
  return 'viewer';
}
const canModerate = (role) => role === 'host' || role === 'mod' || role === 'admin';

function goalProgress(room) {
  if (!room.goal) return null;
  const progress = room.goal.type === 'likes' ? room.likes : room.goal.type === 'gifts' ? room.giftCoins : room.newFollowers;
  return { ...room.goal, progress };
}

function settingsPayload(id, room) {
  return { type: 'live:settings', streamId: id, slowMode: room.slowMode, followersOnly: room.followersOnly, pinned: room.pinned, goal: goalProgress(room) };
}

/** Called by REST routes when a gift is sent. */
function onGift(id, { sender, gift, count, coins, leaders }) {
  const room = rooms.get(id);
  if (!room) return;
  room.giftCoins += coins;
  broadcast(room, { type: 'live:gift', streamId: id, gift: { id: gift.id, name: gift.name, art: gift.art, coins: gift.coins, tier: gift.tier }, count, coins,
    user: { id: sender.id, username: sender.username, displayName: sender.display_name || sender.username, avatarUrl: sender.avatar_url }, leaders, giftCoins: room.giftCoins });
  if (room.goal && room.goal.type === 'gifts') broadcast(room, settingsPayload(id, room));
}

/** Called when someone follows the host while they are LIVE. */
function onFollow(hostId, follower) {
  for (const [id, room] of rooms) {
    if (room.hostId !== hostId) continue;
    room.newFollowers++;
    q.run('UPDATE live_streams SET new_followers = new_followers + 1 WHERE id = ?', id);
    broadcast(room, { type: 'live:system', streamId: id, text: `@${follower.username} followed the host` });
    if (room.goal && room.goal.type === 'followers') broadcast(room, settingsPayload(id, room));
  }
}

function setGoal(id, goal) {
  const room = rooms.get(id);
  if (!room) return;
  room.goal = goal;
  broadcast(room, settingsPayload(id, room));
}

/** End a stream in the DB and tell everyone in the room. */
function endStream(id, reason = 'ended') {
  const room = rooms.get(id);
  q.run("UPDATE live_streams SET status = 'ended', ended_at = ?, ended_reason = ?, total_likes = MAX(total_likes, ?) WHERE id = ? AND status = 'live'",
    now(), reason, room ? room.likes : 0, id);
  if (room) {
    clearTimeout(room.endTimer);
    clearTimeout(room.likeFlush);
    broadcast(room, { type: 'live:ended', streamId: id, reason });
    for (const v of room.viewers.values()) v.liveRooms && v.liveRooms.delete(id);
    if (room.host && room.host.liveRooms) room.host.liveRooms.delete(id);
    rooms.delete(id);
  }
}

function leave(ws, id) {
  const room = rooms.get(id);
  if (!room) return;
  if (room.host === ws) {
    room.host = null;
    broadcast(room, { type: 'live:host-away', streamId: id });
    room.endTimer = setTimeout(() => endStream(id, 'host_disconnected'), HOST_GRACE_MS);
  } else if (room.viewers.delete(ws.connId)) {
    hub.send(room.host, { type: 'live:peer-leave', streamId: id, peerId: ws.connId });
    broadcastViewers(id, room);
  }
  ws.liveRooms && ws.liveRooms.delete(id);
}

/** Remove every connection of userId from the room (used by "remove from LIVE"). */
function evict(id, room, userId) {
  for (const [connId, v] of [...room.viewers]) {
    if (v.user && v.user.id === userId) {
      hub.send(v, { type: 'live:kicked', streamId: id });
      room.viewers.delete(connId);
      v.liveRooms && v.liveRooms.delete(id);
      hub.send(room.host, { type: 'live:peer-leave', streamId: id, peerId: connId });
    }
  }
  broadcastViewers(id, room);
}

function moderate(ws, id, msg) {
  const room = rooms.get(id);
  if (!room || !ws.user) return;
  const role = roleOf(ws.user, room);
  const err = (message) => hub.send(ws, { type: 'live:error', streamId: id, message });
  if (!canModerate(role)) return err('Only the host and moderators can do that');
  const target = msg.userId ? q.get('SELECT id, username, role FROM users WHERE id = ?', Number(msg.userId)) : null;
  const targetRole = target ? roleOf(target, room) : null;
  const protectedTarget = target && (targetRole === 'host' || (targetRole === 'mod' && role === 'mod') || (target.role === 'admin' && role !== 'admin'));
  const me = `@${ws.user.username}`;

  switch (msg.action) {
    case 'delete': {
      const r = q.run('UPDATE live_messages SET deleted = 1 WHERE id = ? AND stream_id = ?', Number(msg.messageId), id);
      if (r.changes) broadcast(room, { type: 'live:chat-deleted', streamId: id, messageId: Number(msg.messageId) });
      if (room.pinned && room.pinned.id === Number(msg.messageId)) { room.pinned = null; broadcast(room, settingsPayload(id, room)); }
      return;
    }
    case 'mute': {
      if (!target || protectedTarget) return err('You cannot mute this person');
      const minutes = Number(msg.minutes) || 0;
      room.mutes.set(target.id, minutes > 0 ? Date.now() + minutes * 60000 : Infinity);
      hub.sendToUser(target.id, { type: 'live:muted', streamId: id, until: minutes > 0 ? Date.now() + minutes * 60000 : null });
      system(room, id, `@${target.username} was muted ${minutes > 0 ? `for ${minutes} min` : 'for this LIVE'} by ${me}`);
      return;
    }
    case 'unmute': {
      if (!target) return;
      room.mutes.delete(target.id);
      hub.sendToUser(target.id, { type: 'live:unmuted', streamId: id });
      return;
    }
    case 'kick': {
      if (!target || protectedTarget) return err('You cannot remove this person');
      q.run('INSERT OR IGNORE INTO live_bans (host_id, user_id, created_at) VALUES (?, ?, ?)', room.hostId, target.id, now());
      evict(id, room, target.id);
      system(room, id, `@${target.username} was removed from the LIVE`);
      return;
    }
    case 'pin': {
      const m = q.get('SELECT m.*, u.username, u.display_name FROM live_messages m JOIN users u ON u.id = m.user_id WHERE m.id = ? AND m.stream_id = ? AND m.deleted = 0', Number(msg.messageId), id);
      if (!m) return;
      room.pinned = { id: m.id, text: m.body, user: { username: m.username, displayName: m.display_name || m.username } };
      broadcast(room, settingsPayload(id, room));
      return;
    }
    case 'unpin':
      room.pinned = null;
      broadcast(room, settingsPayload(id, room));
      return;
    case 'slow': {
      const sec = Number(msg.seconds);
      if (!SLOW_OPTIONS.includes(sec)) return;
      room.slowMode = sec;
      q.run('UPDATE live_streams SET slow_mode = ? WHERE id = ?', sec, id);
      broadcast(room, settingsPayload(id, room));
      system(room, id, sec ? `Slow mode on: one message every ${sec}s` : 'Slow mode off');
      return;
    }
    case 'followers_only': {
      room.followersOnly = !!msg.value;
      q.run('UPDATE live_streams SET followers_only = ? WHERE id = ?', room.followersOnly ? 1 : 0, id);
      broadcast(room, settingsPayload(id, room));
      system(room, id, room.followersOnly ? 'Chat is now followers-only' : 'Everyone can chat');
      return;
    }
    case 'add_mod':
    case 'remove_mod': {
      if (role !== 'host' && role !== 'admin') return err('Only the host can manage moderators');
      if (!target || target.id === room.hostId) return;
      if (msg.action === 'add_mod') q.run('INSERT OR IGNORE INTO live_moderators (host_id, mod_id, created_at) VALUES (?, ?, ?)', room.hostId, target.id, now());
      else q.run('DELETE FROM live_moderators WHERE host_id = ? AND mod_id = ?', room.hostId, target.id);
      hub.sendToUser(target.id, { type: 'live:role', streamId: id, role: msg.action === 'add_mod' ? 'mod' : 'viewer' });
      system(room, id, msg.action === 'add_mod' ? `@${target.username} is now a moderator` : `@${target.username} is no longer a moderator`);
      return;
    }
  }
}

function handle(ws, msg) {
  const id = Number(msg.streamId);
  if (!Number.isInteger(id)) return;
  ws.liveRooms = ws.liveRooms || new Set();
  const err = (message) => hub.send(ws, { type: 'live:error', streamId: id, message });

  switch (msg.type) {
    case 'live:host': {
      const s = liveStream(id);
      if (!s || !ws.user || s.user_id !== ws.user.id) return err('You are not the host of this stream');
      const room = getRoom(id);
      clearTimeout(room.endTimer);
      if (room.host && room.host !== ws) hub.send(room.host, { type: 'live:replaced', streamId: id });
      room.host = ws;
      ws.liveRooms.add(id);
      hub.send(ws, { type: 'live:state', streamId: id, viewers: room.viewers.size, likes: room.likes, role: 'host' });
      hub.send(ws, settingsPayload(id, room));
      for (const peerId of room.viewers.keys()) hub.send(ws, { type: 'live:peer-join', streamId: id, peerId });
      broadcast(room, { type: 'live:host-back', streamId: id }, ws);
      return;
    }
    case 'live:join': {
      const s = liveStream(id);
      if (!s) return hub.send(ws, { type: 'live:ended', streamId: id, reason: 'not_live' });
      if (ws.user && isBlocked(ws.user.id, s.user_id)) return err('This LIVE is unavailable');
      if (ws.user && ws.user.id === s.user_id) return err('You are the host of this LIVE');
      if (ws.user && q.get('SELECT 1 FROM live_bans WHERE host_id = ? AND user_id = ?', s.user_id, ws.user.id))
        return hub.send(ws, { type: 'live:kicked', streamId: id });
      const room = getRoom(id);
      room.viewers.set(ws.connId, ws);
      ws.liveRooms.add(id);
      const role = roleOf(ws.user, room);
      const until = ws.user ? room.mutes.get(ws.user.id) : null;
      hub.send(ws, { type: 'live:state', streamId: id, viewers: room.viewers.size, likes: room.likes, hostOnline: !!room.host, role, mutedUntil: until && until > Date.now() ? (until === Infinity ? -1 : until) : null });
      hub.send(ws, settingsPayload(id, room));
      hub.send(room.host, { type: 'live:peer-join', streamId: id, peerId: ws.connId });
      broadcastViewers(id, room);
      if (ws.user) broadcast(room, { type: 'live:joined', streamId: id, user: { id: ws.user.id, username: ws.user.username } }, ws);
      return;
    }
    case 'live:leave':
      return leave(ws, id);
    case 'live:signal': {
      const room = rooms.get(id);
      if (!room || !msg.data || typeof msg.data !== 'object') return;
      if (room.host === ws) {
        const target = room.viewers.get(String(msg.to));
        hub.send(target, { type: 'live:signal', streamId: id, from: 'host', data: msg.data });
      } else if (room.viewers.get(ws.connId) === ws) {
        hub.send(room.host, { type: 'live:signal', streamId: id, from: ws.connId, data: msg.data });
      }
      return;
    }
    case 'live:chat': {
      const room = rooms.get(id);
      if (!room || !ws.liveRooms.has(id)) return;
      if (!ws.user) return err('Log in to chat');
      const role = roleOf(ws.user, room);
      const privileged = canModerate(role);
      const until = room.mutes.get(ws.user.id);
      if (until && until > Date.now()) return err(until === Infinity ? 'You have been muted for this LIVE' : `You are muted for ${Math.ceil((until - Date.now()) / 60000)} more min`);
      if (room.followersOnly && !privileged && !isFollowing(ws.user.id, room.hostId)) return err('Only followers can chat in this LIVE');
      if (room.slowMode && !privileged) {
        const last = room.lastChat.get(ws.user.id) || 0;
        const wait = room.slowMode * 1000 - (Date.now() - last);
        if (wait > 0) return err(`Slow mode: wait ${Math.ceil(wait / 1000)}s`);
      }
      if (!chatLimit(`c${ws.user.id}`)) return err('You are sending messages too fast');
      const text = String(msg.text || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 200);
      if (!text) return;
      const fresh = q.get('SELECT * FROM users WHERE id = ?', ws.user.id) || ws.user;
      const host = q.get('SELECT * FROM users WHERE id = ?', room.hostId);
      const mod = automod.check(text, { user: fresh, context: 'live_chat', owner: host });
      if (mod.action === 'block') return err(mod.message);
      room.lastChat.set(ws.user.id, Date.now());
      const user = { id: ws.user.id, username: ws.user.username, displayName: ws.user.display_name, avatarUrl: ws.user.avatar_url, role };
      if (mod.action === 'hold') {
        // Filtered: only the sender sees it (like TikTok's "only visible to you").
        hub.send(ws, { type: 'live:chat', streamId: id, message: { id: null, text, createdAt: now(), user, filtered: true } });
        return;
      }
      const r = q.run('INSERT INTO live_messages (stream_id, user_id, body, created_at) VALUES (?, ?, ?, ?)', id, ws.user.id, text, now());
      broadcast(room, { type: 'live:chat', streamId: id, message: { id: Number(r.lastInsertRowid), text, createdAt: now(), user } });
      return;
    }
    case 'live:like': {
      const room = rooms.get(id);
      if (!room || !ws.liveRooms.has(id)) return;
      if (!likeLimit(`l${ws.connId}`)) return;
      const n = Math.min(Math.max(parseInt(msg.count, 10) || 1, 1), 20);
      room.likes += n;
      broadcast(room, { type: 'live:like', streamId: id, total: room.likes, count: n, from: ws.connId });
      if (room.goal && room.goal.type === 'likes' && (room.likes % 10 < n || room.likes >= room.goal.target)) broadcast(room, settingsPayload(id, room));
      if (!room.likeFlush) {
        room.likeFlush = setTimeout(() => {
          room.likeFlush = null;
          q.run('UPDATE live_streams SET total_likes = ? WHERE id = ?', room.likes, id);
        }, 3000);
      }
      return;
    }
    case 'live:react': {
      const room = rooms.get(id);
      if (!room || !ws.liveRooms.has(id) || !REACTIONS.includes(msg.emoji)) return;
      if (!likeLimit(`r${ws.connId}`)) return;
      broadcast(room, { type: 'live:react', streamId: id, emoji: msg.emoji, user: ws.user ? ws.user.username : null });
      return;
    }
    case 'live:mod':
      return moderate(ws, id, msg);
  }
}

function onClose(ws) {
  if (!ws.liveRooms) return;
  for (const id of [...ws.liveRooms]) leave(ws, id);
}

/** On boot, any stream still marked live has no host connection anymore. */
function cleanupStale() {
  q.run("UPDATE live_streams SET status = 'ended', ended_at = ?, ended_reason = 'server_restart' WHERE status = 'live'", now());
}

const liveAllowed = () => settings.get('platform').liveEnabled;

module.exports = { handle, onClose, endStream, viewerCount, cleanupStale, REACTIONS, SLOW_OPTIONS, liveAllowed, onGift, onFollow, setGoal };
