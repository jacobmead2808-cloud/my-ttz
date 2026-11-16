// Watch Party: watch a queue of videos together in sync, with chat and reactions.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { ws } from '../lib/ws.js';
import { store } from '../lib/store.js';
import { navigate } from '../lib/router.js';
import { BRAND } from '../brand.js';
import { toast, avatar, emptyState, toastError } from '../components/ui.js';
import { filterCss } from '../lib/videoFx.js';

export default async function partyPage(ctx) {
  const code = ctx.params.code.toUpperCase();
  let data;
  try { data = await api.get(`/party/${code}`); } catch (e) {
    return { title: 'Watch party', el: emptyState({ iconName: 'users', title: 'This watch party has ended', text: e.message, action: h('a.btn.btn-primary', { href: '/' }, 'Back to For You') }) };
  }
  const subs = [];
  let videos = data.videos;
  let st = data;
  let applying = false;
  const video = h('video.party-video', { playsInline: true, controls: false });
  video.muted = false;
  const queueEl = h('div.party-queue');
  const membersEl = h('div.party-members');
  const chat = h('div.party-chat', { role: 'log' });
  const floatLayer = h('div.float-layer');
  const isHost = () => st.hostId === store.me.id;
  const canControl = () => isHost() || st.everyoneControls;
  const link = `${location.origin}/party/${code}`;

  function addChat(node) { chat.appendChild(node); while (chat.children.length > 150) chat.firstChild.remove(); chat.scrollTop = chat.scrollHeight; }

  async function ensureVideos() {
    if (st.queue.every((id) => videos.some((v) => v.id === id))) return;
    try { videos = (await api.get(`/party/${code}`)).videos; } catch { /* ignore */ }
  }

  async function apply() {
    await ensureVideos();
    const v = videos.find((x) => x.id === st.queue[st.index]);
    paintQueue();
    paintMembers();
    if (!v) return;
    applying = true;
    if (!video.src.includes(`/media/v/${v.id}`)) { video.src = v.videoUrl; video.style.filter = filterCss(v.filter); nowTitle.textContent = v.caption || `Video by @${v.author.username}`; }
    const target = st.position + (st.playing ? (Date.now() - st.serverTime) / 1000 : 0);
    if (Math.abs(video.currentTime - target) > 0.6) { try { video.currentTime = Math.max(0, target % (v.duration || 1e9)); } catch { /* not ready */ } }
    if (st.playing && video.paused) video.play().catch(() => { tapToStart.classList.remove('hidden'); });
    if (!st.playing && !video.paused) video.pause();
    playBtn.replaceChildren(icon(st.playing ? 'pause' : 'play', { size: 22 }));
    setTimeout(() => { applying = false; }, 150);
  }
  video.addEventListener('loadedmetadata', () => apply());
  video.addEventListener('ended', () => { if (canControl() && st.index < st.queue.length - 1) control('next'); else if (canControl()) control('seek', 0); });

  function control(action, position) {
    if (!canControl()) { toast('Only the host controls playback'); return; }
    ws.send('party:control', { code, action, position: position ?? video.currentTime });
  }

  const playBtn = h('button.party-btn', { 'aria-label': 'Play/pause', onclick: () => control(st.playing ? 'pause' : 'play') }, icon('play', { size: 22 }));
  const nowTitle = h('div.party-now');
  const tapToStart = h('button.btn.btn-primary.party-tap.hidden', { onclick: () => { video.play(); tapToStart.classList.add('hidden'); } }, icon('volume', { size: 16 }), ' Tap to join the watch');
  const seek = h('input.party-seek', { type: 'range', min: 0, max: 1000, value: 0, 'aria-label': 'Seek' });
  seek.addEventListener('change', () => { const d = video.duration || 0; if (d) control('seek', (seek.value / 1000) * d); });
  video.addEventListener('timeupdate', () => { const d = video.duration || 0; if (d && document.activeElement !== seek) seek.value = String((video.currentTime / d) * 1000); });

  function paintQueue() {
    queueEl.replaceChildren(...st.queue.map((id, i) => {
      const v = videos.find((x) => x.id === id);
      return h(`button.party-q${i === st.index ? '.active' : ''}`, { onclick: () => canControl() && ws.send('party:control', { code, action: 'select', index: i }) },
        h('img', { src: (v && v.thumbUrl) || BRAND.placeholderThumb, alt: '' }), h('span', v ? (v.caption || `@${v.author.username}`).slice(0, 40) : 'Loading…'));
    }));
  }
  function paintMembers() {
    membersEl.replaceChildren(...(st.members || []).map((m) => h('span.party-member', { title: `@${m.username}${m.isHost ? ' (host)' : ''}` }, avatar(m, 30, { link: false }), m.isHost ? h('span.party-crown', '') : null)));
    everyone.checked = !!st.everyoneControls;
    everyoneWrap.classList.toggle('hidden', !isHost());
  }

  const everyone = h('input', { type: 'checkbox', onchange: (e) => ws.send('party:control', { code, action: 'everyone', value: e.target.checked }) });
  const everyoneWrap = h('label.check.small', everyone, ' Let everyone control playback');

  subs.push(ws.on('party:state', (m) => { if (m.code !== code) return; st = m; apply(); }));
  subs.push(ws.on('party:chat', (m) => { if (m.code === code) addChat(h('div.chat-row', avatar(m.message.user, 20, { link: false }), h('b.chat-user', ` ${m.message.user.displayName} `), h('span', m.message.text))); }));
  subs.push(ws.on('party:system', (m) => { if (m.code === code) addChat(h('div.chat-row.system', m.text)); }));
  subs.push(ws.on('party:react', (m) => {
    if (m.code !== code) return;
    const el = h('span.float-emoji', m.emoji);
    el.style.left = `${20 + Math.random() * 50}%`;
    el.style.setProperty('--drift', `${Math.random() * 60 - 30}px`);
    floatLayer.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }));
  subs.push(ws.on('party:error', (m) => { if (m.code === code) toast(m.message, { type: 'error' }); }));
  const join = () => ws.send('party:join', { code });
  subs.push(ws.onOpen(join));
  if (ws.connected) join();

  const input = h('input.live-input', { placeholder: 'Say something…', maxlength: 200 });
  const addInput = h('input.input.input-sm', { placeholder: 'Paste a video link to add it to the queue' });

  const el = h('div.party-page',
    h('div.party-stage', video, floatLayer, tapToStart,
      h('div.party-controls',
        h('button.party-btn', { 'aria-label': 'Previous', onclick: () => control('prev') }, icon('chevronLeft', { size: 22 })),
        playBtn,
        h('button.party-btn', { 'aria-label': 'Next', onclick: () => control('next') }, icon('chevronRight', { size: 22 })),
        seek)),
    h('aside.party-side',
      h('div.party-head', h('h1', 'Watch Party'), h('span.party-code', code)),
      nowTitle,
      h('div.row.gap', h('button.btn.btn-primary.btn-sm', { onclick: () => navigator.clipboard.writeText(link).then(() => toast('Invite link copied')) }, icon('link', { size: 14 }), ' Invite'),
        h('button.btn.btn-secondary.btn-sm', { onclick: () => { ws.send('party:leave', { code }); navigate('/'); } }, 'Leave')),
      membersEl, everyoneWrap,
      h('h3.panel-title', 'Up next'), queueEl,
      h('form.row.gap', { onsubmit: (e) => {
        e.preventDefault();
        const m = addInput.value.match(/video\/(\d+)/) || addInput.value.match(/^(\d+)$/);
        if (!m) { toastError(new Error('Paste a link like …/video/123')); return; }
        ws.send('party:queue', { code, videoId: Number(m[1]) });
        addInput.value = '';
      } }, addInput, h('button.btn.btn-secondary.btn-sm', { type: 'submit' }, 'Add')),
      h('h3.panel-title', 'Chat'), chat,
      h('form.live-composer', { onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) { ws.send('party:chat', { code, text: input.value }); input.value = ''; } } }, input)));
  apply();
  return { el, title: 'Watch Party', cleanup: () => { ws.send('party:leave', { code }); subs.forEach((u) => u()); video.pause(); } };
}

/** Start a watch party for a video and navigate to it. */
export async function startParty(videoId) {
  try { const r = await api.post('/party', { videoId }); navigate(`/party/${r.code}`); } catch (e) { toastError(e); }
}
