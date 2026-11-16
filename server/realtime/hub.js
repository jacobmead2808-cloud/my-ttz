'use strict';
/** Registry of connected WebSocket clients, keyed by user id. */
const byUser = new Map(); // userId -> Set<ws>

function add(ws) {
  if (!ws.user) return;
  let set = byUser.get(ws.user.id);
  if (!set) byUser.set(ws.user.id, (set = new Set()));
  set.add(ws);
}

function remove(ws) {
  if (!ws.user) return;
  const set = byUser.get(ws.user.id);
  if (!set) return;
  set.delete(ws);
  if (!set.size) byUser.delete(ws.user.id);
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

function sendToUser(userId, msg) {
  const set = byUser.get(userId);
  if (!set) return;
  const data = JSON.stringify(msg);
  for (const ws of set) send(ws, data);
}

/** Force-close every socket of a user (e.g. after a ban). */
function disconnectUser(userId) {
  const set = byUser.get(userId);
  if (!set) return;
  for (const ws of set) ws.close(4001, 'Session ended');
}

const isOnline = (userId) => byUser.has(userId);

module.exports = { add, remove, send, sendToUser, disconnectUser, isOnline };
