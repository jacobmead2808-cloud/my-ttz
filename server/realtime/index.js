'use strict';
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const config = require('../config');
const { q, now } = require('../db');
const { userFromRequest } = require('../lib/auth');
const hub = require('./hub');
const live = require('./live');
const party = require('./party');
const { createLimiter } = require('../lib/rateLimit');
const wsLimit = createLimiter({ windowMs: 10000, max: 150 });

function attach(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    // Reject cross-site WebSocket hijacking: Origin must match our host.
    const origin = req.headers.origin;
    if (origin) {
      try {
        const o = new URL(origin);
        const fwd = config.trustProxy ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
        const allowed = o.host === req.headers.host || (fwd && o.host === fwd) || origin === config.baseUrl;
        if (!allowed) return socket.destroy();
      } catch {
        return socket.destroy();
      }
    }
    const user = userFromRequest(req);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = user;
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      ws.ip = (require('../config').trustProxy && fwd) || req.socket.remoteAddress;
      ws.connId = crypto.randomBytes(8).toString('hex');
      ws.isAlive = true;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    hub.add(ws);
    hub.send(ws, { type: 'hello', connId: ws.connId, userId: ws.user ? ws.user.id : null });
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      if (!wsLimit(ws.connId)) { // drop floods (max 150 messages / 10s per connection)
        if (!ws.floodLogged) { ws.floodLogged = true; require('../lib/security').record('ws.flood', { ip: ws.ip, userId: ws.user && ws.user.id, path: '/ws' }, 'over 150 messages in 10s'); }
        return;
      }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      try {
        if (msg.type.startsWith('live:')) return live.handle(ws, msg);
        if (msg.type.startsWith('party:')) return party.handle(ws, msg);
        if (msg.type === 'dm:typing') return onTyping(ws, msg);
        if (msg.type === 'ping') return hub.send(ws, { type: 'pong' });
      } catch (e) {
        console.error('[ws] handler error', e);
      }
    });
    ws.on('close', () => {
      hub.remove(ws);
      live.onClose(ws);
      party.onClose(ws);
    });
  });

  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  interval.unref();
  wss.on('close', () => clearInterval(interval));
  server.on('close', () => { clearInterval(interval); for (const ws of wss.clients) ws.terminate(); });
  return wss;
}

function onTyping(ws, msg) {
  if (!ws.user) return;
  const c = q.get('SELECT * FROM conversations WHERE id = ?', Number(msg.conversationId));
  if (!c || (c.user_a !== ws.user.id && c.user_b !== ws.user.id)) return;
  const other = c.user_a === ws.user.id ? c.user_b : c.user_a;
  hub.sendToUser(other, { type: 'dm:typing', conversationId: c.id, userId: ws.user.id, at: now() });
}

module.exports = { attach };
