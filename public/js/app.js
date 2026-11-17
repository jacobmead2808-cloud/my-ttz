// App entry: shell layout (top bar, sidebar, mobile tab bar), routing and session bootstrap.
import { h, clear } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { api, onUnauthorized } from './lib/api.js';
import { store, on, setMe, setUnread, setTheme, getTheme } from './lib/store.js';
import { ws } from './lib/ws.js';
import { route, routeRegex, onRender, startRouter, navigate } from './lib/router.js';
import { BRAND } from './brand.js';
import { avatar, loadingBlock, errorState, toast, actionSheet, emptyState } from './components/ui.js';
import { fmtCount } from './lib/format.js';
import { searchBox } from './components/social.js';
import { resumePush, disablePush, initNativePushTaps, isNativeApp } from './lib/push.js';

// ---------- Routes ----------
const page = (name) => () => import(`./pages/${name}.js`);
route('/', page('home'), { shell: 'feed', key: 'foryou' });
route('/foryou', page('home'), { shell: 'feed', key: 'foryou' });
route('/following', page('home'), { shell: 'feed', key: 'following' });
route('/explore', page('explore'), { key: 'explore' });
route('/search', page('search'), { key: 'explore' });
route('/tag/:tag', page('tag'), { key: 'explore' });
route('/sound/:id', page('sound'), { key: 'explore' });
route('/video/:id', page('video'), { shell: 'video' });
route('/upload', page('upload'), { auth: true, key: 'upload' });
route('/inbox', page('inbox'), { auth: true, key: 'inbox' });
route('/messages', page('messages'), { auth: true, key: 'messages', shell: 'messages' });
route('/messages/:id', page('messages'), { auth: true, key: 'messages', shell: 'messages' });
route('/live', page('live'), { key: 'live' });
route('/live/studio', page('liveStudio'), { auth: true, key: 'live', shell: 'live' });
route('/live/:id', page('liveWatch'), { key: 'live', shell: 'live' });
route('/settings', page('settings'), { auth: true, key: 'settings' });
route('/analytics', page('analytics'), { auth: true, key: 'analytics' });
route('/coins', page('coins'), { auth: true, key: 'coins' });
route('/download', page('download'), { key: 'download' });
route('/party/:code', page('party'), { auth: true, key: 'party', shell: 'party' });
route('/admin/user/:id', page('adminUser'), { auth: true, admin: true, key: 'admin' });
route('/remix/:id', page('remix'), { auth: true, key: 'upload', shell: 'live' });
route('/admin', page('admin'), { auth: true, admin: true, key: 'admin' });
route('/login', page('auth'), { guest: true, shell: 'bare', mode: 'login' });
route('/signup', page('auth'), { guest: true, shell: 'bare', mode: 'signup' });
route('/forgot', page('auth'), { shell: 'bare', mode: 'forgot' });
route('/reset', page('auth'), { shell: 'bare', mode: 'reset' });
route('/verify-email', page('auth'), { shell: 'bare', mode: 'verify' });
route('/setup', page('auth'), { shell: 'bare', mode: 'setup' });
route('/terms', page('legal'), { mode: 'terms' });
route('/privacy', page('legal'), { mode: 'privacy' });
route('/guidelines', page('legal'), { mode: 'guidelines' });
route('/safety', page('legal'), { mode: 'safety' });
routeRegex(/^\/@([^/]+)\/?$/, ['username'], page('profile'), { key: 'profile' });
routeRegex(/^.*$/, [], async () => ({ default: () => ({ el: emptyState({ iconName: 'alert', title: 'Page not found', text: "This page doesn't exist or was removed.", action: h('a.btn.btn-primary', { href: '/' }, 'Go home') }), title: 'Not found' }) }), { notFound: true });

// ---------- Shell ----------
const view = h('main.view#view', { tabindex: -1 });
const badge = (key) => {
  const b = h('span.nav-badge.hidden');
  const paint = () => { const n = store.unread[key] || 0; b.textContent = n > 99 ? '99+' : String(n); b.classList.toggle('hidden', !n); };
  on('unread', paint);
  paint();
  return b;
};

function navLinks() {
  const me = store.me;
  return [
    { href: '/', key: 'foryou', label: 'For You', ic: 'home' },
    { href: '/explore', key: 'explore', label: 'Explore', ic: 'compass' },
    { href: '/following', key: 'following', label: 'Following', ic: 'users' },
    { href: '/live', key: 'live', label: 'LIVE', ic: 'live' },
    { href: me ? '/messages' : '/login', key: 'messages', label: 'Messages', ic: 'send', badge: 'messages' },
    { href: me ? '/inbox' : '/login', key: 'inbox', label: 'Activity', ic: 'inbox', badge: 'notifications' },
    { href: '/upload', key: 'upload', label: 'Upload', ic: 'upload' },
    { href: me ? `/@${me.username}` : '/login', key: 'profile', label: 'Profile', ic: 'user', avatar: !!me },
    me && me.role === 'admin' ? { href: '/admin', key: 'admin', label: 'Moderation', ic: 'shield', badge: 'cases' } : null,
  ].filter(Boolean);
}

const sidebar = h('nav.sidebar', { 'aria-label': 'Main' });
const topActions = h('div.top-actions');
const tabbar = h('nav.tabbar', { 'aria-label': 'Main' });
const topbar = h('header.topbar',
  h('a.brand.brand-mobile', { href: '/', 'aria-label': `${BRAND.name} home` }, h('img', { src: BRAND.logo, alt: '', width: 30, height: 30 }), h('span.brand-name', BRAND.name)),
  topActions);

function renderSidebar() {
  clear(sidebar);
  const me = store.me;
  sidebar.append(
    h('a.brand', { href: '/', 'aria-label': `${BRAND.name} home` }, h('img', { src: BRAND.logo, alt: '', width: 34, height: 34 }), h('span.brand-name', BRAND.name)),
    h('div.side-search', searchBox({ placeholder: 'Search' })),
    h('div.side-links',
      navLinks().map((l) => h('a.side-link', { href: l.href, dataset: { key: l.key } },
        h('span.side-icon', l.avatar ? avatar(me, 30, { link: false }) : icon(l.ic, { size: 26 }), l.badge ? badge(l.badge) : null), h('span.side-label', l.label))),
      h('button.side-link', { onclick: moreMenu }, h('span.side-icon', icon('more', { size: 26 })), h('span.side-label', 'More'))));
  if (me) {
    const coinsVal = h('b', fmtCount((store.wallet && store.wallet.coins) || 0));
    on('wallet', (w) => { coinsVal.textContent = fmtCount((w && w.coins) || 0); });
    if (!store.wallet) api.get('/coins').then((r) => { store.wallet = r.wallet; coinsVal.textContent = fmtCount(r.wallet.coins); }).catch(() => {});
    sidebar.append(h('div.side-account-box',
      h('button.side-me', { onclick: accountMenu, 'aria-label': 'Account menu' }, avatar(me, 36, { link: false }),
        h('span.side-me-text', h('b', me.displayName), h('span.muted', `@${me.username}`)), icon('more', { size: 18 })),
      h('div.side-quick',
        h('a.side-quick-btn', { href: '/coins' }, h('span.coin', 'C'), coinsVal),
        h('a.side-quick-btn.primary', { href: '/live/studio' }, icon('live', { size: 16 }), 'Go LIVE'))));
  }
  if (!me) {
    sidebar.append(h('div.side-login',
      h('p.muted', 'Log in to follow creators, like videos, and view comments.'),
      h('a.btn.btn-primary.btn-block', { href: '/login' }, 'Log in')));
  }
  const box = h('div.side-accounts', h('h4.side-title', me ? 'Following accounts' : 'Popular creators'));
  sidebar.append(box);
  const url = me ? `/users/${encodeURIComponent(me.username)}/following?limit=10` : '/users/suggested?limit=8';
  api.get(url).then(({ users }) => {
    if (!users.length && me) {
      return api.get('/users/suggested?limit=6').then((r) => {
        box.querySelector('.side-title').textContent = 'Suggested accounts';
        r.users.forEach((u) => box.appendChild(accountRow(u)));
        if (!r.users.length) box.remove();
      });
    }
    users.forEach((u) => box.appendChild(accountRow(u)));
    if (!users.length) box.remove();
  }).catch(() => box.remove());
  sidebar.append(h('div.side-footer',
    h('div.side-footer-links', h('a', { href: '/download' }, 'Get the app'), h('a', { href: '/explore' }, 'Explore'), h('a', { href: '/live' }, 'LIVE'), h('a', { href: me ? '/settings' : '/login' }, 'Settings'),
      h('button.link-btn', { onclick: cycleTheme }, icon(getTheme() === 'dark' ? 'moon' : 'sun', { size: 13 }), ` ${getTheme()[0].toUpperCase()}${getTheme().slice(1)} mode`)),
    h('div.side-footer-links', h('a', { href: '/terms' }, 'Terms'), h('a', { href: '/privacy' }, 'Privacy'), h('a', { href: '/guidelines' }, 'Guidelines'), h('a', { href: '/safety' }, 'Safety')),
    h('p.muted.small', `© ${new Date().getFullYear()} ${BRAND.name}`)));
  markActive();
}

function accountRow(u) {
  return h('a.side-account', { href: `/@${u.username}` }, avatar(u, 32, { link: false }),
    h('span.side-account-text', h('b', u.displayName, u.verified ? icon('checkCircle', { size: 12, cls: 'verified' }) : null), h('span.muted', u.username)));
}

function cycleTheme() {
  const order = ['light', 'dark', 'system'];
  setTheme(order[(order.indexOf(getTheme()) + 1) % order.length]);
  renderSidebar();
  toast(`Theme: ${getTheme()}`);
}

function moreMenu() {
  const me = store.me;
  actionSheet([
    me ? { label: 'Wallet & coins', icon: 'sparkles', onClick: () => navigate('/coins') } : null,
    me ? { label: 'Creator analytics', icon: 'chart', onClick: () => navigate('/analytics') } : null,
    { label: 'Get the app', icon: 'upload', onClick: () => navigate('/download') },
    me ? { label: 'Drafts & scheduled', icon: 'clock', onClick: () => navigate(`/@${me.username}?tab=drafts`) } : null,
    me ? { label: 'Go LIVE', icon: 'live', onClick: () => navigate('/live/studio') } : null,
    me ? { label: 'Settings and privacy', icon: 'settings', onClick: () => navigate('/settings') } : null,
    me && me.role === 'admin' ? { label: 'Admin dashboard', icon: 'shield', onClick: () => navigate('/admin') } : null,
    { label: `Appearance: ${getTheme()}`, icon: getTheme() === 'dark' ? 'moon' : 'sun', onClick: cycleTheme },
    me ? { label: 'Log out', icon: 'logout', danger: true, onClick: logout } : { label: 'Log in', icon: 'user', onClick: () => navigate('/login') },
  ], { title: 'More' });
}

function renderTopActions() {
  clear(topActions);
  const me = store.me;
  topActions.append(
    h('a.top-pill-link.mobile-only', { href: '/search', 'aria-label': 'Search' }, icon('search', { size: 22 })),
    h('a.top-pill-link.desktop-only', { href: me ? '/live/studio' : '/login?next=/live/studio' }, icon('live', { size: 18 }), h('span', 'Go LIVE')),
    h('a.top-pill-link.desktop-only', { href: '/upload' }, icon('plus', { size: 18 }), h('span', 'Upload')),
    me ? h('a.top-pill-link.desktop-only.coins-link', { href: '/coins', title: 'Wallet' }, h('span.coin', 'C'), h('span', 'Coins')) : null);
  if (me) {
    topActions.append(
      h('a.top-pill-link.icon-only.mobile-only', { href: '/messages', 'aria-label': 'Messages' }, icon('send', { size: 22 }), badge('messages')),
      h('span.top-divider.desktop-only'),
      h('button.avatar-btn', { 'aria-label': 'Account menu', onclick: accountMenu }, avatar(me, 32, { link: false })));
  } else {
    topActions.append(h('a.btn.btn-primary.btn-sm', { href: '/login' }, 'Log in'));
  }
}

function accountMenu() {
  const me = store.me;
  actionSheet([
    { label: 'View profile', icon: 'user', onClick: () => navigate(`/@${me.username}`) },
    { label: 'Wallet & coins', icon: 'sparkles', onClick: () => navigate('/coins') },
    { label: 'Go LIVE', icon: 'live', onClick: () => navigate('/live/studio') },
    { label: 'Creator analytics', icon: 'chart', onClick: () => navigate('/analytics') },
    { label: 'Drafts & scheduled', icon: 'clock', onClick: () => navigate(`/@${me.username}?tab=drafts`) },
    { label: 'Settings and privacy', icon: 'settings', onClick: () => navigate('/settings') },
    me.role === 'admin' ? { label: 'Admin dashboard', icon: 'shield', onClick: () => navigate('/admin') } : null,
    { label: `Appearance: ${getTheme()}`, icon: 'moon', onClick: cycleTheme },
    { label: 'Log out', icon: 'logout', danger: true, onClick: logout },
  ], { title: `@${me.username}` });
}

async function logout() {
  await disablePush().catch(() => {});
  try { await api.post('/auth/logout'); } catch { /* ignore */ }
  setMe(null);
  setUnread({ notifications: 0, messages: 0 });
  ws.restart();
  toast('Logged out');
  navigate('/');
}

function renderTabbar() {
  clear(tabbar);
  const me = store.me;
  const items = [
    { href: '/', key: 'foryou', label: 'Home', ic: 'home' },
    { href: '/explore', key: 'explore', label: 'Discover', ic: 'compass' },
    { href: '/upload', key: 'upload', label: '', ic: 'plus', create: true },
    { href: me ? '/inbox' : '/login', key: 'inbox', label: 'Inbox', ic: 'inbox', badge: 'notifications' },
    { href: me ? `/@${me.username}` : '/login', key: 'profile', label: 'Profile', ic: 'user' },
  ];
  items.forEach((it) => tabbar.appendChild(h(`a.tab-link${it.create ? '.tab-create' : ''}`, { href: it.href, dataset: { key: it.key }, 'aria-label': it.label || 'Create' },
    it.create ? h('span.create-btn', icon('plus', { size: 22 })) : h('span.tab-icon', icon(it.ic, { size: 24 }), it.badge ? badge(it.badge) : null),
    it.label ? h('span.tab-label', it.label) : null)));
  markActive();
}

let activeKey = null;
function markActive() {
  document.querySelectorAll('[data-key]').forEach((a) => {
    let k = activeKey;
    if (k === 'profile' && store.me && location.pathname.toLowerCase() !== `/@${store.me.username}`) k = null;
    a.classList.toggle('active', a.dataset.key === k);
  });
}

const shell = h('div.app-shell', topbar, sidebar, view, tabbar);

function renderAnnouncement() {
  const me = store.me;
  document.querySelector('.announce-bar')?.remove();
  if (me && store.config.requireEmailVerification && !me.emailVerified) {
    const btn = h('button.verify-resend', { type: 'button', onclick: async () => {
      btn.disabled = true;
      try { const r = await api.post('/auth/resend-verification', {}); toast(r.devNote || `Sent. Check ${me.email}.`, { type: 'success' }); } catch (e) { toast(e.message, { type: 'error' }); btn.disabled = false; }
    } }, 'Resend link');
    document.body.classList.add('has-announce');
    document.getElementById('app').prepend(h('div.announce-bar.verify-bar', { role: 'status' }, icon('alert', { size: 16 }), h('span', `Confirm your email (${me.email}) to post, comment and message.`), btn));
    return;
  }
  const text = store.config.platform && store.config.platform.announcement;
  let dismissed = '';
  try { dismissed = localStorage.getItem('announceDismissed') || ''; } catch { /* ignore */ }
  document.querySelector('.announce-bar')?.remove();
  if (!text || dismissed === text) { document.body.classList.remove('has-announce'); return; }
  const bar = h('div.announce-bar', { role: 'status' }, icon('sparkles', { size: 16 }), h('span', text),
    h('button', { 'aria-label': 'Dismiss', onclick: () => { try { localStorage.setItem('announceDismissed', text); } catch { /* ignore */ } renderAnnouncement(); } }, icon('close', { size: 14 })));
  document.body.classList.add('has-announce');
  document.getElementById('app').prepend(bar);
}

// ---------- Rendering ----------
onRender(async (r, ctx, isCurrent, setCurrent) => {
  const opts = r.opts;
  if (opts.auth && !store.me) return navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
  if (opts.guest && store.me) return navigate(ctx.query.get('next') || '/', { replace: true });
  if (opts.admin && store.me.role !== 'admin') {
    clear(view).appendChild(emptyState({ iconName: 'shield', title: 'Administrators only', text: 'You do not have access to this page.' }));
    return;
  }
  activeKey = opts.key || null;
  document.body.dataset.shell = opts.shell || 'page';
  markActive();
  clear(view).appendChild(loadingBlock());
  try {
    const mod = await r.loader();
    if (!isCurrent()) return;
    const pg = await mod.default({ ...ctx, mode: opts.mode, key: opts.key });
    if (!isCurrent()) { pg && pg.cleanup && pg.cleanup(); return; }
    setCurrent(pg);
    clear(view).appendChild(pg.el);
    document.title = pg.title ? `${pg.title} | ${BRAND.name}` : `${BRAND.name} - ${BRAND.tagline}`;
    if (opts.shell !== 'feed') view.scrollTop = 0;
  } catch (e) {
    console.error(e);
    if (isCurrent()) clear(view).appendChild(errorState(e, () => location.reload()));
  }
});

// ---------- Realtime badges ----------
ws.on('notification', (m) => setUnread({ notifications: m.unread }));
ws.on('dm:new', (m) => {
  setUnread({ messages: m.unreadTotal });
  if (!location.pathname.startsWith('/messages')) toast(` ${m.from.displayName}: ${m.message.body || 'sent a video'}`);
});
ws.on('dm:unread', (m) => setUnread({ messages: m.unreadTotal }));
ws.on('mod:case', () => { setUnread({ cases: (store.unread.cases || 0) + 1 }); toast(' Guardian needs a human decision — see Moderation → Cases'); });

// Installable app (PWA)
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); window.__installPrompt = e; showInstallBar(); });
window.addEventListener('appinstalled', () => { window.__installPrompt = null; document.querySelector('.install-bar')?.remove(); });

/** "Install Clipzy" bar where the browser supports installing (Chrome/Edge on Android and desktop). */
function showInstallBar() {
  let dismissed = 0;
  try { dismissed = Number(localStorage.getItem('installDismissed')) || 0; } catch { /* ignore */ }
  if (Date.now() - dismissed < 14 * 86400000 || document.querySelector('.install-bar') || isNativeApp()) return;
  const bar = h('div.install-bar', { role: 'dialog', 'aria-label': `Install ${BRAND.name}` },
    h('img', { src: '/assets/brand/icon-192.png', alt: '', width: 40, height: 40 }),
    h('div.install-text', h('b', `Install ${BRAND.name}`), h('span', 'Full screen, faster, with notifications')),
    h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: async () => {
      const p = window.__installPrompt;
      bar.remove();
      if (!p) return;
      p.prompt();
      const r = await p.userChoice.catch(() => null);
      if (r && r.outcome === 'accepted') window.__installPrompt = null;
    } }, 'Install'),
    h('button.icon-btn', { type: 'button', 'aria-label': 'Not now', onclick: () => { try { localStorage.setItem('installDismissed', String(Date.now())); } catch { /* ignore */ } bar.remove(); } }, icon('close', { size: 16 })));
  document.body.appendChild(bar);
}

onUnauthorized(() => {
  if (store.me) {
    setMe(null);
    toast('Your session has ended. Please log in again.', { type: 'error' });
  }
});

on('me', () => { renderSidebar(); renderTopActions(); renderTabbar(); renderAnnouncement(); });

// ---------- Boot ----------
async function boot() {
  try {
    const r = await api.get('/auth/me');
    store.me = r.user;
    if (r.unread) store.unread = r.unread;
    if (r.config) store.config = r.config;
  } catch { /* offline: continue as guest */ }
  const app = document.getElementById('app');
  clear(app).appendChild(shell);
  renderSidebar();
  renderTopActions();
  renderTabbar();
  renderAnnouncement();
  ws.start();
  if (isNativeApp()) {
    document.documentElement.classList.add('native-app');
    // Android back button: close the open sheet/modal, else go back a screen, else minimise (like other apps).
    const App = window.Capacitor.Plugins.App;
    App?.addListener('backButton', ({ canGoBack }) => {
      if (document.getElementById('modal-root')?.childElementCount) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      else if (canGoBack && location.pathname !== '/') history.back();
      else App.minimizeApp();
    });
  }
  initNativePushTaps();
  if (store.me) resumePush();
  await startRouter();
}

/** Called by auth pages after a successful login/registration. */
export function afterLogin(user, next) {
  setMe(user);
  ws.restart();
  resumePush();
  api.get('/auth/me').then((r) => { if (r.unread) setUnread(r.unread); }).catch(() => {});
  navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true });
}

window.addEventListener('error', (e) => console.error('Unhandled', e.error));
boot();
