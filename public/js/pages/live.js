// LIVE discovery page.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { ws } from '../lib/ws.js';
import { fmtCount, timeAgo } from '../lib/format.js';
import { store } from '../lib/store.js';
import { BRAND } from '../brand.js';
import { avatar, emptyState } from '../components/ui.js';

export function liveCard(s) {
  return h('a.live-card', { href: `/live/${s.id}` },
    h('div.live-card-media',
      s.previewUrl ? h('img', { src: s.previewUrl, alt: '', loading: 'lazy' }) : h('div.live-card-placeholder', avatar(s.host, 72, { link: false })),
      h('span.live-badge', 'LIVE'),
      s.goal ? h('span.live-card-goal', icon('target', { size: 11 }), ` ${s.goal.label || s.goal.type}`) : null,
      h('span.live-card-viewers', icon('eye', { size: 12 }), fmtCount(s.viewers))),
    h('div.live-card-info', avatar(s.host, 32, { link: false }),
      h('div', h('div.live-card-title', s.title), h('div.muted.small', `@${s.host.username} · started ${timeAgo(s.startedAt)}`))));
}

export default async function livePage() {
  const grid = h('div.live-grid');
  async function load() {
    const { streams } = await api.get('/live');
    grid.replaceChildren(...(streams.length ? streams.map(liveCard)
      : [emptyState({ iconName: 'live', title: 'No one is LIVE right now', text: `Go LIVE to connect with your followers in real time on ${BRAND.name}.`, action: h('a.btn.btn-primary', { href: store.me ? '/live/studio' : '/login?next=/live/studio' }, 'Go LIVE') })]));
  }
  await load();
  const timer = setInterval(() => load().catch(() => {}), 15000);
  const off = ws.on('notification', (m) => { if (m.kind === 'live') load().catch(() => {}); });
  const el = h('div.live-page',
    h('div.page-head', h('h1.page-title', icon('live', { size: 28 }), ' LIVE'),
      h('a.btn.btn-primary', { href: store.me ? '/live/studio' : '/login?next=/live/studio' }, icon('live', { size: 18 }), ' Go LIVE')),
    h('p.muted', 'Watch creators broadcasting right now. Previews refresh automatically.'),
    grid);
  return { el, title: 'LIVE', cleanup: () => { clearInterval(timer); off(); } };
}
