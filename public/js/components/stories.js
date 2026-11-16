// Stories: 24-hour photos & videos. Tray (avatars with rings), full-screen viewer, and posting.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { timeAgo } from '../lib/format.js';
import { BRAND } from '../brand.js';
import { toast, toastError, avatar, actionSheet, confirmDialog, openModal, loadingBlock, requireLogin } from './ui.js';

const IMAGE_MS = 5000;

/** Pick a photo/video and post it as a story. */
export function addStory(onDone) {
  if (!requireLogin('Log in to post stories')) return;
  const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime' });
  input.onchange = () => {
    const f = input.files[0];
    if (!f) return;
    openModal((close) => {
      const url = URL.createObjectURL(f);
      const isVideo = f.type.startsWith('video');
      const media = isVideo ? h('video.story-compose-media', { src: url, autoplay: true, muted: true, loop: true, playsInline: true }) : h('img.story-compose-media', { src: url, alt: '' });
      const caption = h('input.input', { placeholder: 'Add a caption (optional)', maxlength: 150 });
      const bar = h('div.up-progress-fill');
      const btn = h('button.btn.btn-primary.btn-block', { onclick: async () => {
        btn.disabled = true;
        const fd = new FormData();
        fd.append('media', f, f.name);
        fd.append('caption', caption.value.trim());
        try {
          await api.upload('/stories', fd, (p) => { bar.style.width = `${Math.round(p * 100)}%`; }).promise;
          toast('Story posted · visible for 24 hours', { type: 'success' });
          URL.revokeObjectURL(url);
          close();
          onDone && onDone();
        } catch (e) { toastError(e); btn.disabled = false; }
      } }, 'Share to story');
      return h('div.stack', media, caption, h('div.up-progress-track', bar), btn);
    }, { title: 'New story', className: 'modal-sm' });
  };
  input.click();
}

/** Full-screen viewer. entries: [{ user, stories[], isSelf }] */
export function openStoryViewer(entries, startIndex = 0, { onClose } = {}) {
  if (!entries.length) return;
  let ui = startIndex;
  let si = 0;
  let timer = null;
  let startedAt = 0;
  let elapsed = 0;
  let duration = IMAGE_MS;
  let paused = false;
  let mediaEl = null;

  const bars = h('div.story-bars');
  const head = h('div.story-head');
  const stage = h('div.story-media');
  const captionEl = h('div.story-caption');
  const foot = h('div.story-foot');
  const box = h('div.story-box', bars, head, stage, captionEl, foot,
    h('button.story-nav.prev', { 'aria-label': 'Previous', onclick: (e) => { e.stopPropagation(); prev(); } }),
    h('button.story-nav.next', { 'aria-label': 'Next', onclick: (e) => { e.stopPropagation(); next(); } }));
  const overlay = h('div.story-overlay', { role: 'dialog', 'aria-label': 'Stories' }, box,
    h('button.icon-btn.story-close', { 'aria-label': 'Close', onclick: close }, icon('close')));
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  box.addEventListener('pointerdown', (e) => { if (!e.target.closest('button, input, a')) pause(true); });
  box.addEventListener('pointerup', () => pause(false));

  const entry = () => entries[ui];
  const story = () => entry().stories[si];

  function paintBars() {
    bars.replaceChildren(...entry().stories.map((_, i) => h('div.story-bar', h('div.story-bar-fill', { style: { width: i < si ? '100%' : '0%' } }))));
  }

  function show() {
    clearInterval(timer);
    const s = story();
    const u = entry().user;
    paintBars();
    head.replaceChildren(avatar(u, 32), h('a.story-name', { href: `/@${u.username}` }, u.displayName), h('span.story-time', timeAgo(s.createdAt)));
    captionEl.textContent = s.caption || '';
    captionEl.classList.toggle('hidden', !s.caption);
    if (s.type === 'video') {
      mediaEl = h('video', { src: s.mediaUrl, autoplay: true, playsInline: true, muted: store.muted });
      mediaEl.addEventListener('loadedmetadata', () => { duration = Math.min(Number.isFinite(mediaEl.duration) ? mediaEl.duration * 1000 : 15000, 60000); });
      mediaEl.addEventListener('ended', next);
      duration = 15000;
    } else {
      mediaEl = h('img', { src: s.mediaUrl, alt: s.caption || 'Story', onerror: (e) => { e.target.src = BRAND.placeholderThumb; } });
      duration = IMAGE_MS;
    }
    stage.replaceChildren(mediaEl);
    elapsed = 0;
    startedAt = Date.now();
    timer = setInterval(progress, 50);
    if (!entry().isSelf && !s.seen && store.me) { s.seen = true; api.post(`/stories/${s.id}/view`).catch(() => {}); }
    paintFoot();
  }

  function paintFoot() {
    const s = story();
    if (entry().isSelf) {
      foot.replaceChildren(
        h('button.story-chip', { onclick: (e) => { e.stopPropagation(); viewers(s); } }, icon('eye', { size: 16 }), ` ${s.views ?? 0} viewers`),
        h('button.story-chip', { onclick: async (e) => {
          e.stopPropagation();
          pause(true);
          if (!(await confirmDialog({ title: 'Delete this story?', confirmText: 'Delete', danger: true }))) { pause(false); return; }
          try {
            await api.del(`/stories/${s.id}`);
            entry().stories.splice(si, 1);
            toast('Story deleted');
            if (!entry().stories.length) { entries.splice(ui, 1); if (!entries.length) return close(); if (ui >= entries.length) ui = entries.length - 1; si = 0; }
            else if (si >= entry().stories.length) si = entry().stories.length - 1;
            pause(false);
            show();
          } catch (err) { toastError(err); pause(false); }
        } }, icon('trash', { size: 16 }), ' Delete'));
    } else if (store.me) {
      const input = h('input.story-reply', { placeholder: `Reply to ${entry().user.displayName}…`, maxlength: 500 });
      input.addEventListener('focus', () => pause(true));
      input.addEventListener('blur', () => pause(false));
      foot.replaceChildren(h('form.story-reply-form', { onsubmit: async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        try {
          const c = await api.post('/conversations', { username: entry().user.username });
          await api.post(`/conversations/${c.id}/messages`, { body: ` Replied to your story: ${text}` });
          input.value = '';
          input.blur();
          toast('Reply sent');
        } catch (err) { toastError(err); }
      } }, input, h('button.icon-btn', { type: 'submit', 'aria-label': 'Send' }, icon('send', { size: 20 }))));
    } else foot.replaceChildren();
  }

  function viewers(s) {
    pause(true);
    openModal(() => {
      const list = h('div.user-list', loadingBlock());
      api.get(`/stories/${s.id}/viewers`).then(({ viewers: vs }) => list.replaceChildren(...(vs.length
        ? vs.map((u) => h('div.user-row', avatar(u, 36), h('div.user-row-text', h('div.user-row-name', u.displayName), h('div.user-row-sub.muted', `@${u.username} · ${timeAgo(u.seenAt)}`))))
        : [h('p.muted', 'No views yet')]))).catch((e) => list.replaceChildren(h('p.form-error', e.message)));
      return list;
    }, { title: 'Viewers', className: 'modal-sm', onClose: () => pause(false) });
  }

  function progress() {
    if (paused) return;
    const t = elapsed + (Date.now() - startedAt);
    const fill = bars.children[si] && bars.children[si].firstChild;
    if (fill) fill.style.width = `${Math.min(100, (t / duration) * 100)}%`;
    if (t >= duration) next();
  }

  function pause(on) {
    if (on === paused) return;
    paused = on;
    if (on) { elapsed += Date.now() - startedAt; if (mediaEl && mediaEl.pause) mediaEl.pause(); }
    else { startedAt = Date.now(); if (mediaEl && mediaEl.play) mediaEl.play().catch(() => {}); }
  }

  function next() {
    if (si < entry().stories.length - 1) si++;
    else if (ui < entries.length - 1) { ui++; si = 0; }
    else return close();
    show();
  }
  function prev() {
    if (si > 0) si--;
    else if (ui > 0) { ui--; si = entries[ui].stories.length - 1; }
    else { elapsed = 0; startedAt = Date.now(); }
    show();
  }
  function onKey(e) {
    if (e.target.closest('input')) return;
    if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') prev();
    else if (e.key === 'Escape') close();
  }
  function close() {
    clearInterval(timer);
    document.removeEventListener('keydown', onKey);
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 200);
    onClose && onClose();
  }

  document.addEventListener('keydown', onKey);
  document.getElementById('modal-root').appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  show();
}

/** Horizontal tray of story rings. */
export function storyTray({ title = 'Stories' } = {}) {
  const row = h('div.story-tray');
  const wrap = h('section.story-section', h('h3.story-title', title), row);
  async function load() {
    if (!store.me) { wrap.classList.add('hidden'); return; }
    let users = [];
    try { ({ users } = await api.get('/stories/feed')); } catch { /* ignore */ }
    const mine = users.find((u) => u.isSelf);
    const items = [];
    items.push(h('button.story-ring-item', { onclick: () => (mine ? openStoryViewer(users, users.indexOf(mine), { onClose: load }) : addStory(load)) },
      h(`span.story-ring${mine ? (mine.allSeen ? '.seen' : '') : '.add'}`, avatar(store.me, 60, { link: false }), h('span.story-add', { onclick: (e) => { e.stopPropagation(); addStory(load); } }, icon('plus', { size: 14 }))),
      h('span.story-label', 'Your story')));
    users.filter((u) => !u.isSelf).forEach((u) => items.push(h('button.story-ring-item', { onclick: () => openStoryViewer(users, users.indexOf(u), { onClose: load }) },
      h(`span.story-ring${u.allSeen ? '.seen' : ''}`, avatar(u.user, 60, { link: false })), h('span.story-label', u.user.displayName))));
    row.replaceChildren(...items);
  }
  load();
  wrap.reload = load;
  return wrap;
}
