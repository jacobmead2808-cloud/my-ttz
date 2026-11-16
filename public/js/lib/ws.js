// Auto-reconnecting WebSocket client. ws.on(type, fn) -> unsubscribe; ws.send(type, payload)
const handlers = new Map();
let sock = null;
let retry = 0;
let timer = null;
let queue = [];
let connId = null;
const openHandlers = new Set();

function connect() {
  clearTimeout(timer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  sock = new WebSocket(`${proto}://${location.host}/ws`);
  sock.onopen = () => {
    retry = 0;
    const q = queue;
    queue = [];
    q.forEach((m) => sock.send(m));
  };
  sock.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'hello') {
      connId = msg.connId;
      openHandlers.forEach((fn) => fn(msg));
    }
    (handlers.get(msg.type) || []).forEach((fn) => { try { fn(msg); } catch (err) { console.error(err); } });
    (handlers.get('*') || []).forEach((fn) => fn(msg));
  };
  sock.onclose = () => {
    sock = null;
    connId = null;
    retry = Math.min(retry + 1, 6);
    timer = setTimeout(connect, 500 * 2 ** retry);
  };
}

export const ws = {
  start() { if (!sock) connect(); },
  /** Reconnect (e.g. after login/logout so the server sees the new session). */
  restart() {
    if (sock) { sock.onclose = null; sock.close(); sock = null; }
    connect();
  },
  send(type, payload = {}) {
    const data = JSON.stringify({ type, ...payload });
    if (sock && sock.readyState === 1) sock.send(data);
    else { queue.push(data); if (!sock) connect(); }
  },
  on(type, fn) {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(fn);
    return () => handlers.get(type).delete(fn);
  },
  /** Called each time a (re)connection is established. */
  onOpen(fn) { openHandlers.add(fn); return () => openHandlers.delete(fn); },
  get connected() { return !!sock && sock.readyState === 1 && !!connId; },
  get connId() { return connId; },
};
