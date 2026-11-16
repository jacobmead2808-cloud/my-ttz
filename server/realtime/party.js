'use strict';
/**
 * Watch Parties — a Clipzy original: watch a queue of videos together, perfectly in sync,
 * with live chat and reactions. The host controls playback (or lets everyone control it).
 * Rooms live in memory and disappear 10 minutes after the last person leaves.
 */
const crypto = require('crypto');
const { q, now } = require('../db');
const hub = require('./hub');
const automod = require('../lib/automod');
const { createLimiter } = require('../lib/rateLimit');

const parties = new Map(); // code -> party
const chatLimit = createLimiter({ windowMs: 10000, max: 15 });
const REACTIONS = ['😂', '🔥', '😮', '😍', '👏', '💀'];

function create(host, videoIds) {
  let code;
  do code = crypto.randomBytes(4).toString('base64url').replace(/[-_]/g, 'x').slice(0, 6).toUpperCase(); while (parties.has(code));
  const party = {
    code, hostId: host.id, hostName: host.username, queue: videoIds.slice(0, 50), index: 0,
    playing: false, position: 0, updatedAt: now(), everyoneControls: false,
    members: new Map(), // connId -> ws
    cleanup: null, createdAt: now(),
  };
  parties.set(code, party);
  return party;
}

const get = (code) => parties.get(String(code || '').toUpperCase());

/** Current playback position accounting for elapsed time while playing. */
function position(p) {
  return p.playing ? p.position + (now() - p.updatedAt) / 1000 : p.position;
}

function members(p) {
  const seen = new Map();
  for (const ws of p.members.values()) if (ws.user && !seen.has(ws.user.id)) seen.set(ws.user.id, { id: ws.user.id, username: ws.user.username, displayName: ws.user.display_name || ws.user.username, avatarUrl: ws.user.avatar_url, isHost: ws.user.id === p.hostId });
  return [...seen.values()];
}

function state(p) {
  return { type: 'party:state', code: p.code, queue: p.queue, index: p.index, playing: p.playing, position: position(p), serverTime: now(), hostId: p.hostId, everyoneControls: p.everyoneControls, members: members(p) };
}

function broadcast(p, msg) {
  const data = JSON.stringify(msg);
  for (const ws of p.members.values()) hub.send(ws, data);
}

function leave(ws, code) {
  const p = parties.get(code);
  if (!p) return;
  p.members.delete(ws.connId);
  ws.parties && ws.parties.delete(code);
  if (ws.user && ws.user.id === p.hostId) {
    const next = [...p.members.values()].find((m) => m.user);
    if (next) { p.hostId = next.user.id; p.hostName = next.user.username; broadcast(p, { type: 'party:system', code, text: `@${next.user.username} is now the host` }); }
  }
  if (!p.members.size) { p.cleanup = setTimeout(() => parties.delete(code), 10 * 60000); p.cleanup.unref(); }
  broadcast(p, state(p));
}

function handle(ws, msg) {
  const p = get(msg.code);
  const err = (message) => hub.send(ws, { type: 'party:error', code: msg.code, message });
  if (!p) return err('This watch party has ended');
  if (!ws.user) return err('Log in to join watch parties');
  ws.parties = ws.parties || new Set();
  const canControl = ws.user.id === p.hostId || p.everyoneControls;

  switch (msg.type) {
    case 'party:join':
      clearTimeout(p.cleanup);
      p.members.set(ws.connId, ws);
      ws.parties.add(p.code);
      broadcast(p, state(p));
      broadcast(p, { type: 'party:system', code: p.code, text: `@${ws.user.username} joined` });
      return;
    case 'party:leave':
      return leave(ws, p.code);
    case 'party:control': {
      if (!p.members.has(ws.connId)) return;
      if (!canControl) return err('Only the host controls playback');
      const a = msg.action;
      if (a === 'play' || a === 'pause') { p.position = Number(msg.position) >= 0 ? Number(msg.position) : position(p); p.playing = a === 'play'; }
      else if (a === 'seek') p.position = Math.max(0, Number(msg.position) || 0);
      else if (a === 'next' || a === 'prev' || a === 'select') {
        const target = a === 'next' ? p.index + 1 : a === 'prev' ? p.index - 1 : Number(msg.index);
        if (!Number.isInteger(target) || target < 0 || target >= p.queue.length) return;
        p.index = target; p.position = 0; p.playing = true;
      } else if (a === 'everyone' && ws.user.id === p.hostId) p.everyoneControls = !!msg.value;
      else return;
      p.updatedAt = now();
      broadcast(p, { ...state(p), by: ws.user.username, action: a });
      return;
    }
    case 'party:queue': {
      if (!p.members.has(ws.connId)) return;
      const id = Number(msg.videoId);
      if (!Number.isInteger(id) || p.queue.length >= 50 || p.queue.includes(id)) return;
      const ok = q.get("SELECT 1 FROM videos WHERE id = ? AND status = 'active' AND visibility = 'public' AND is_draft = 0 AND publish_at IS NULL", id);
      if (!ok) return err('That video can’t be added');
      p.queue.push(id);
      broadcast(p, state(p));
      broadcast(p, { type: 'party:system', code: p.code, text: `@${ws.user.username} added a video to the queue` });
      return;
    }
    case 'party:chat': {
      if (!p.members.has(ws.connId) || !chatLimit(`p${ws.user.id}`)) return;
      const text = String(msg.text || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 200);
      if (!text) return;
      const user = q.get('SELECT * FROM users WHERE id = ?', ws.user.id) || ws.user;
      const mod = automod.check(text, { user, context: 'live_chat' });
      if (mod.action !== 'allow') return err(mod.message || 'Message not allowed');
      broadcast(p, { type: 'party:chat', code: p.code, message: { text, createdAt: now(), user: { id: ws.user.id, username: ws.user.username, displayName: ws.user.display_name || ws.user.username, avatarUrl: ws.user.avatar_url } } });
      return;
    }
    case 'party:react':
      if (p.members.has(ws.connId) && REACTIONS.includes(msg.emoji)) broadcast(p, { type: 'party:react', code: p.code, emoji: msg.emoji, user: ws.user.username });
      return;
  }
}

function onClose(ws) {
  if (!ws.parties) return;
  for (const code of [...ws.parties]) leave(ws, code);
}

module.exports = { create, get, handle, onClose, state, REACTIONS };
