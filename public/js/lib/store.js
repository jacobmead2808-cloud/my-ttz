// Global client state + tiny event emitter. Server is the source of truth; this only caches session info.
const handlers = new Map();

export const store = {
  me: null,
  unread: { notifications: 0, messages: 0 },
  config: { appName: 'Clipzy', iceServers: [] },
  muted: true,
};

try { store.muted = localStorage.getItem('muted') !== '0'; } catch { /* ignore */ }

export function on(evt, fn) {
  if (!handlers.has(evt)) handlers.set(evt, new Set());
  handlers.get(evt).add(fn);
  return () => handlers.get(evt).delete(fn);
}

export function emit(evt, data) {
  (handlers.get(evt) || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });
}

export function setMe(me) {
  store.me = me;
  emit('me', me);
}

export function setUnread(part) {
  Object.assign(store.unread, part);
  emit('unread', store.unread);
}

export function setMuted(m) {
  store.muted = m;
  try { localStorage.setItem('muted', m ? '1' : '0'); } catch { /* ignore */ }
  emit('muted', m);
}

export function getTheme() {
  try { return localStorage.getItem('theme') || 'light'; } catch { return 'light'; }
}

export function setTheme(t) {
  try { localStorage.setItem('theme', t); } catch { /* ignore */ }
  const eff = t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
  document.documentElement.setAttribute('data-theme', eff);
  emit('theme', t);
}
