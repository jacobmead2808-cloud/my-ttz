// Watch a LIVE stream: WebRTC playback with the LIVE room overlay (chat, gifts, likes, statistics).
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { ws } from '../lib/ws.js';
import { store } from '../lib/store.js';
import { fmtCount } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { avatar, emptyState, spinner, actionSheet, toast, toastError, confirmDialog } from '../components/ui.js';
import { followButton, reportDialog } from '../components/social.js';
import { liveRoom } from '../components/liveRoom.js';
import { createViewer } from '../lib/livestream.js';
import { soundEnabled, setSoundEnabled } from '../lib/giftFx.js';

function endedView(s) {
  return h('div.live-ended-card',
    avatar(s.host, 88),
    h('h1', 'This LIVE has ended'),
    h('p.muted', `@${s.host.username}${s.title ? ` · ${s.title}` : ''}`),
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
  const video = h('video.lv-video', { autoplay: true, playsInline: true, muted: true });
  const overlay = h('div.lv-status', spinner(), h('p', 'Connecting to LIVE…'));
  const unmute = h('button.lv-unmute', { type: 'button', onclick: () => { video.muted = false; unmute.remove(); } }, icon('volume', { size: 16 }), ' Tap to unmute');

  const viewer = createViewer(id, {
    onStream: (ms) => { video.srcObject = ms; video.play().catch(() => {}); overlay.classList.add('hidden'); },
    onState: (st) => {
      if (st === 'failed') { overlay.replaceChildren(icon('alert', { size: 30 }), h('p', 'Couldn’t connect to this LIVE.'), h('p.small', 'Your network may be blocking it. Try another connection.'), h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: () => location.reload() }, 'Try again')); overlay.classList.remove('hidden'); }
      if (st === 'disconnected') { overlay.replaceChildren(spinner(), h('p', 'Reconnecting…')); overlay.classList.remove('hidden'); }
      if (st === 'connected') overlay.classList.add('hidden');
    },
  });

  const leaders = h('div.lv-leaders', { 'aria-label': 'Top gifters' });
  const paintLeaders = (list) => leaders.replaceChildren(...(list || []).slice(0, 3).map((u, i) => h('span.lv-leader', { title: `${u.displayName} · ${fmtCount(u.coins)} coins` },
    avatar({ username: u.username, avatarUrl: u.avatarUrl }, 28, { link: false }), h('i', String(i + 1)))));
  paintLeaders(data.leaders);

  const room = liveRoom(id, {
    role: data.role, slowOptions: data.slowOptions, gifts: data.gifts || [], hostName: s.host.displayName,
    startedAt: s.startedAt || Date.now(), onLeaders: paintLeaders,
  });

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
    page.replaceChildren(h('div.live-ended-card', icon('block', { size: 40 }), h('h1', 'You were removed from this LIVE'), h('p.muted', 'The host or a moderator removed you. You can’t rejoin this creator’s LIVEs.'), h('a.btn.btn-primary', { href: '/live' }, 'Browse LIVE')));
  }));
  subs.push(ws.on('live:host-away', (m) => { if (m.streamId === id) { overlay.replaceChildren(spinner(), h('p', 'The host is reconnecting…')); overlay.classList.remove('hidden'); } }));
  subs.push(ws.on('live:host-back', (m) => { if (m.streamId === id) overlay.replaceChildren(spinner(), h('p', 'Reconnecting…')); }));
  subs.push(ws.on('live:state', (m) => {
    if (m.streamId === id && m.hostOnline === false) { overlay.replaceChildren(spinner(), h('p', 'Waiting for the host…')); overlay.classList.remove('hidden'); }
  }));

  const menu = () => actionSheet([
    { label: soundEnabled() ? 'Turn gift sounds off' : 'Turn gift sounds on', icon: soundEnabled() ? 'mute' : 'volume', onClick: () => { setSoundEnabled(!soundEnabled()); toast(soundEnabled() ? 'Gift sounds on' : 'Gift sounds off'); } },
    { label: 'Copy link', icon: 'link', onClick: () => navigator.clipboard.writeText(location.href).then(() => toast('Link copied')) },
    { label: 'Report LIVE', icon: 'flag', danger: true, onClick: () => reportDialog('live', id) },
    store.me && store.me.role === 'admin' ? { label: 'End this LIVE (staff)', icon: 'shield', danger: true, onClick: async () => {
      if (!(await confirmDialog({ title: 'End this LIVE?', confirmText: 'End LIVE', danger: true }))) return;
      try { await api.post(`/live/${id}/end`); } catch (e) { toastError(e); }
    } } : null,
  ].filter(Boolean));

  const head = h('div.lv-head',
    h('div.lv-host',
      h('a.lv-host-link', { href: `/@${s.host.username}` }, avatar(s.host, 38, { link: false }),
        h('div.lv-host-text', h('b', s.host.displayName), h('span', s.title || 'LIVE now'))),
      store.me && store.me.id !== s.host.id ? followButton(s.host.username, s.followStatus, { small: true }) : null),
    h('div.lv-head-right', leaders,
      h('button.lv-icon', { type: 'button', 'aria-label': 'More options', onclick: menu }, icon('more', { size: 20 })),
      h('button.lv-icon', { type: 'button', 'aria-label': 'Leave LIVE', onclick: () => (history.length > 1 ? history.back() : navigate('/live')) }, icon('close', { size: 22 }))));

  page.append(h('div.lv-stage', video, h('div.lv-shade'), overlay, head,
    h('span.lv-live-pill', h('i'), s.isTrial ? 'Trial LIVE' : 'LIVE'), unmute, room.el));
  return { el: page, title: `${s.host.displayName} is LIVE`, cleanup: () => { viewer.stop(); room.destroy(); subs.forEach((u) => u()); } };
}
