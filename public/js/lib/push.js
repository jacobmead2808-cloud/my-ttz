// Push notifications on this device: Web Push in browsers / the installed web app, and
// Firebase (FCM) inside the Android app. The server decides what to send; this only registers.
import { api } from './api.js';

const KEY = 'pushEnabled';
const TOKEN = 'pushNativeToken';
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const cap = () => window.Capacitor;
export const isNativeApp = () => !!(cap() && cap().isNativePlatform && cap().isNativePlatform());
const nativePush = () => (isNativeApp() && cap().isPluginAvailable && cap().isPluginAvailable('PushNotifications') ? cap().Plugins.PushNotifications : null);

let cfg = null;
const config = async () => (cfg ||= await api.get('/push/config'));

/** 'unsupported' | 'unavailable' (server not set up) | 'denied' | 'on' | 'off' */
export async function pushStatus() {
  if (isNativeApp()) {
    const P = nativePush();
    if (!P) return 'unsupported';
    if (!(await config()).fcm) return 'unavailable';
    const perm = await P.checkPermissions().catch(() => ({ receive: 'prompt' }));
    if (perm.receive === 'denied') return 'denied';
    return store.get(KEY) === '1' && perm.receive === 'granted' ? 'on' : 'off';
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

const b64ToBytes = (s) => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };

let nativeListeners = false;
async function setupNative(P) {
  if (nativeListeners) return;
  nativeListeners = true;
  await P.createChannel?.({ id: 'clipzy', name: 'Clipzy', description: 'Likes, comments, follows, messages and LIVE', importance: 4, visibility: 0 }).catch(() => {});
  P.addListener('registration', async ({ value }) => {
    store.set(TOKEN, value);
    await api.post('/push/subscribe', { type: 'fcm', token: value }).catch(() => {});
  });
  P.addListener('registrationError', (e) => console.warn('push registration failed', e));
  P.addListener('pushNotificationActionPerformed', (a) => {
    const url = a.notification && a.notification.data && a.notification.data.url;
    if (url && url.startsWith('/')) import('./router.js').then((m) => m.navigate(url));
  });
}

/** Ask permission and register this device. Throws with a readable message on failure. */
export async function enablePush() {
  if (isNativeApp()) {
    const P = nativePush();
    if (!P || !(await config()).fcm) throw new Error('Push notifications are not set up for this app yet.');
    await setupNative(P);
    const perm = await P.requestPermissions();
    if (perm.receive !== 'granted') throw new Error('Notifications are blocked. Allow them in Android Settings → Apps → Clipzy → Notifications.');
    await P.register();
    store.set(KEY, '1');
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in your browser’s site settings.');
  const reg = await navigator.serviceWorker.ready;
  const { webPushKey } = await config();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(webPushKey) });
  await api.post('/push/subscribe', { type: 'web', subscription: sub.toJSON() });
  store.set(KEY, '1');
}

/** Stop push on this device (also used on logout so the next person doesn't get your alerts). */
export async function disablePush() {
  store.set(KEY, null);
  if (isNativeApp()) {
    const token = store.get(TOKEN);
    if (token) await api.post('/push/unsubscribe', { token }).catch(() => {});
    store.set(TOKEN, null);
    await nativePush()?.unregister?.().catch(() => {});
    return;
  }
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
  const sub = reg && (await reg.pushManager.getSubscription().catch(() => null));
  if (sub) {
    await api.post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
}

/** After login / app start: refresh the registration if this device had push on (tokens rotate). */
export async function resumePush() {
  try {
    if (store.get(KEY) !== '1') return;
    if (isNativeApp()) {
      const P = nativePush();
      if (!P || !(await config()).fcm) return;
      await setupNative(P);
      if ((await P.checkPermissions()).receive === 'granted') await P.register();
    } else if ((await pushStatus()) === 'on') {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await api.post('/push/subscribe', { type: 'web', subscription: sub.toJSON() });
    }
  } catch (e) { console.warn('push resume failed', e); }
}

/** Taps on notifications in the Android app should open the right screen even before login. */
export function initNativePushTaps() {
  const P = nativePush();
  if (P) setupNative(P).catch(() => {});
}
