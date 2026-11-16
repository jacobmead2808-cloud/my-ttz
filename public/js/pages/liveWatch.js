// Watch a LIVE stream: WebRTC playback, live chat, likes and reactions.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { ws } from '../lib/ws.js';
import { store } from '../lib/store.js';
import { fmtCount, timeAgo } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { avatar, emptyState, spinner, actionSheet, toast, toastError, confirmDialog } from '../components/ui.js';
import { followButton, reportDialog } from '../components/social.js';
import { liveRoom } from '../components/liveRoom.js';
import { createViewer } from '../lib/livestream.js';

function endedView(s) {
  return h('div.live-ended-card',
    avatar(s.host, 88),
    h('h1', 'LIVE has ended'),
    h('p.muted', `@${s.host.username} · ${s.title}`),
    h('div.ended-stats', h('div', h('b', fmtCount(s.peakViewers)), h('span', 'Peak viewers')), h('div', h('b', fmtCount(s.likes)), h('span', 'Likes'))),
    h('div.row.gap.center', h('a.btn.btn-primary', { href: `/@${s.host.username}` }, 'View profile'), h('a.btn.btn-secondary', { href: '/live' }, 'More LIVE')));
}

export default async function liveWatch(ctx) {
  const id = Number(ctx.params.id);
  let data;
  try { data = await api.get(`/live/${id}`); } catch (e) {
    if (e.status === 404) return { title: 'LIVE', el: emptyState({ iconName: 'live', title: 'This LIVE is unavailable', action: h('a.btn.btn-primary', { href: '/live' }, 'Browse LIVE') }) };
    throw e;
  }
  const s = data.stream;
  if (s.isHost && s.status === 'live') { navigate('/live/studio', { replace: true }); return { el: h('div') }; }
  if (s.status !== 'live') return { title: 'LIVE ended', el: h('div.live-page', endedView(s)) };

  const subs = [];
  const video = h('video.live-video', { autoplay: true, playsInline: true, muted: true });
  const overlay = h('div.live-overlay', spinner(), h('p', 'Connecting to LIVE…'));
  const unmute = h('button.btn.btn-secondary.btn-sm.unmute-btn', { onclick: () => { video.muted = false; unmute.remove(); } }, icon('volume', { size: 16 }), ' Tap to unmute');

  const viewer = createViewer(id, {
    onStream: (ms) => {
      video.srcObject = ms;
      video.play().catch(() => {});
      overlay.classList.add('hidden');
    },
    onState: (st) => {
      if (st === 'failed') { overlay.replaceChildren(icon('alert', { size: 32 }), h('p', 'Connection failed. Your network may need a TURN server.'), h('button.btn.btn-secondary.btn-sm', { onclick: () => location.reload() }, 'Retry')); overlay.classList.remove('hidden'); }
      if (st === 'disconnected') { overlay.replaceChildren(spinner(), h('p', 'Reconnecting…')); overlay.classList.remove('hidden'); }
      if (st === 'connected') overlay.classList.add('hidden');
    },
  });
  const room = liveRoom(id, { reactions: data.reactions, role: data.role, slowOptions: data.slowOptions, gifts: data.gifts || [], leaders: data.leaders || [] });

  const page = h('div.live-watch');
  function showEnded(reason) {
    viewer.stop();
    room.destroy();
    api.get(`/live/${id}`).then((r) => page.replaceChildren(endedView(r.stream))).catch(() => page.replaceChildren(endedView(s)));
    if (reason === 'ended_by_admin') toast('This LIVE was ended by a moderator');
  }
  subs.push(ws.on('live:ended', (m) => m.streamId === id && showEnded(m.reason)));
  subs.push(ws.on('live:kicked', (m) => {
    if (m.streamId !== id) return;
    viewer.stop();
    room.destroy();
    page.replaceChildren(h('div.live-ended-card', icon('block', { size: 40 }), h('h1', 'You were removed from this LIVE'), h('p.muted', 'The host or a moderator removed you. You cannot rejoin this creator’s LIVEs.'), h('a.btn.btn-primary', { href: '/live' }, 'Browse LIVE')));
  }));
  subs.push(ws.on('live:host-away', (m) => { if (m.streamId === id) { overlay.replaceChildren(spinner(), h('p', 'The host is reconnecting…')); overlay.classList.remove('hidden'); } }));
  subs.push(ws.on('live:host-back', (m) => { if (m.streamId === id) overlay.replaceChildren(spinner(), h('p', 'Reconnecting…')); }));
  subs.push(ws.on('live:state', (m) => {
    if (m.streamId === id && m.hostOnline === false) { overlay.replaceChildren(spinner(), h('p', 'Waiting for the host…')); overlay.classList.remove('hidden'); }
  }));

  const head = h('div.live-head',
    h('a.live-host', { href: `/@${s.host.username}` }, avatar(s.host, 40, { link: false }), h('div', h('b', s.host.displayName), h('div.small.muted-light', s.title))),
    store.me && store.me.id !== s.host.id ? followButton(s.host.username, s.followStatus, { small: true }) : null,
    room.stats,
    h('button.icon-btn.live-more', { 'aria-label': 'More', onclick: () => actionSheet([
      { label: 'Copy link', icon: 'link', onClick: () => navigator.clipboard.writeText(location.href).then(() => toast('Link copied')) },
      { label: 'Report LIVE', icon: 'flag', danger: true, onClick: () => reportDialog('live', id) },
      store.me && store.me.role === 'admin' ? { label: 'End this LIVE (admin)', icon: 'shield', danger: true, onClick: async () => {
        if (!(await confirmDialog({ title: 'End this LIVE?', confirmText: 'End', danger: true }))) return;
        try { await api.post(`/live/${id}/end`); } catch (e) { toastError(e); }
      } } : null,
    ]) }, icon('more', { size: 20 })),
    h('button.icon-btn.live-close', { 'aria-label': 'Close', onclick: () => (history.length > 1 ? history.back() : navigate('/live')) }, icon('close', { size: 20 })));

  page.append(h('div.live-watch-col', h('div.live-stage', video, overlay, h('div.live-top-gradient'), head, unmute, room.el, h('span.live-started.small', s.isTrial ? ' Trial LIVE' : `Started ${timeAgo(s.startedAt)}`)), room.giftBar));
  return { el: page, title: `${s.host.displayName} is LIVE`, cleanup: () => { viewer.stop(); room.destroy(); subs.forEach((u) => u()); } };
}
