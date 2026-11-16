// "Get the app": install Clipzy on this device (PWA) or download the desktop / phone apps.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { BRAND } from '../brand.js';
import { toast } from '../components/ui.js';

function platform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  if (/Mac/.test(ua)) return 'mac';
  return 'linux';
}

export default function downloadPage() {
  const os = platform();
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const d = BRAND.downloads || {};

  const installBtn = h('button.btn.btn-primary.btn-lg', { onclick: async () => {
    const p = window.__installPrompt;
    if (!p) { toast('Use your browser’s install option — see the steps below.'); return; }
    p.prompt();
    const r = await p.userChoice.catch(() => null);
    if (r && r.outcome === 'accepted') { window.__installPrompt = null; toast(`${BRAND.name} installed`, { type: 'success' }); }
  } }, icon('upload', { size: 18 }), ` Install ${BRAND.name}`);

  const steps = {
    ios: ['Open this site in Safari', 'Tap the Share button (square with an arrow)', 'Tap “Add to Home Screen”, then “Add”'],
    android: ['Open this site in Chrome', 'Tap the ⋮ menu', 'Tap “Install app” (or “Add to Home screen”)'],
    windows: ['Open this site in Chrome or Edge', 'Click the install icon at the right end of the address bar', 'Click “Install” — it opens in its own window and appears in the Start menu'],
    mac: ['Open this site in Chrome or Edge (or Safari: File → Add to Dock)', 'Click the install icon in the address bar', 'Click “Install” — it appears in Launchpad and the Dock'],
    linux: ['Open this site in Chrome or Edge', 'Click the install icon in the address bar', 'Click “Install”'],
  };

  const card = (key, ic, title, body, current) => h(`div.getapp-card${current ? '.current' : ''}`, h('h3', icon(ic, { size: 20 }), title, current ? h('span.getapp-badge', 'This device') : null), ...body);
  const dl = (url, label) => (url ? h('a.btn.btn-primary', { href: url, rel: 'noopener' }, icon('upload', { size: 16 }), ` ${label}`) : h('button.btn.btn-secondary', { disabled: true }, 'Coming soon'));

  const el = h('div.settings-page.getapp',
    h('div.getapp-hero', h('img', { src: '/assets/brand/icon-192.png', width: 72, height: 72, alt: '' }),
      h('div', h('h1', `Get the ${BRAND.name} app`), h('p.muted', 'Install it on your phone or computer — it opens in its own window, gets its own icon, and stays signed in.'))),
    installed ? h('div.form-success', h('p', `You’re already using the installed ${BRAND.name} app.`)) : null,
    h('div.getapp-grid',
      card('pwa', 'sparkles', 'Install from your browser (instant)', [
        h('p.muted.small', 'Works on every phone and computer. No app store needed, always up to date.'),
        installBtn,
        h('ol', (steps[os] || steps.windows).map((x) => h('li', x))),
      ], true),
      card('windows', 'monitor', 'Windows', [h('p.muted.small', 'Desktop app with its own window, taskbar icon and auto-start option.'), dl(d.windows, 'Download for Windows')], os === 'windows'),
      card('mac', 'monitor', 'macOS', [h('p.muted.small', 'For Apple Silicon and Intel Macs.'), dl(d.mac, 'Download for Mac')], os === 'mac'),
      card('android', 'video', 'Android', [h('p.muted.small', 'Get it on Google Play or install the APK.'), dl(d.android, 'Get it for Android')], os === 'android'),
      card('ios', 'video', 'iPhone & iPad', [h('p.muted.small', 'On the App Store. Until then, use “Install from your browser” above.'), dl(d.ios, 'Get it on the App Store')], os === 'ios'),
      card('linux', 'monitor', 'Linux', [h('p.muted.small', 'AppImage — runs on most distributions.'), dl(d.linux, 'Download for Linux')], os === 'linux')));
  return { el, title: 'Get the app' };
}
