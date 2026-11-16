// Social building blocks: follow buttons, share sheet, report dialog, user lists, video grids, edit/delete video.
import { h, clear, debounce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { store, emit } from '../lib/store.js';
import { fmtCount, fmtDuration } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { BRAND } from '../brand.js';
import { FILTERS, filterCss } from '../lib/videoFx.js';
import { captionsEditor } from './captionsEditor.js';
import { toast, toastError, openModal, confirmDialog, avatar, userName, loadingBlock, emptyState, errorState, requireLogin, spinner } from './ui.js';

// ---------- Follow ----------
const followLabel = (s, followsYou) => (s === 'accepted' ? 'Following' : s === 'pending' ? 'Requested' : followsYou ? 'Follow back' : 'Follow');

/** Follow button that keeps itself in sync with the server. status: null | 'pending' | 'accepted' */
export function followButton(username, status, { small = false, followsYou = false, onChange } = {}) {
  let state = status;
  const btn = h('button', { type: 'button' });
  const paint = () => {
    btn.className = `btn ${small ? 'btn-sm' : ''} ${state ? 'btn-secondary' : 'btn-primary'} follow-btn`;
    btn.textContent = followLabel(state, followsYou);
  };
  paint();
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!requireLogin('Log in to follow creators')) return;
    if (store.me && store.me.username === username) return;
    if (state === 'accepted') {
      const ok = await confirmDialog({ title: `Unfollow @${username}?`, confirmText: 'Unfollow', danger: true });
      if (!ok) return;
    }
    btn.disabled = true;
    try {
      const r = state ? await api.del(`/users/${encodeURIComponent(username)}/follow`) : await api.post(`/users/${encodeURIComponent(username)}/follow`);
      state = r.followStatus;
      paint();
      emit('follow', { username, status: state, stats: r.stats });
      onChange && onChange(state, r);
    } catch (err) { toastError(err); } finally { btn.disabled = false; }
  });
  return btn;
}

// ---------- Share ----------
export function shareVideo(video, onShared) {
  const url = `${location.origin}/video/${video.id}`;
  const record = () => api.post(`/videos/${video.id}/share`).then((r) => onShared && onShared(r.shares)).catch(() => {});
  openModal((close) => {
    const list = h('div.share-dm-list', loadingBlock());
    if (store.me) {
      api.get('/conversations').then(({ conversations }) => {
        clear(list);
        if (!conversations.length) { list.appendChild(h('p.muted.small', 'Start a conversation to send videos directly.')); return; }
        conversations.slice(0, 12).forEach((c) => list.appendChild(h('button.share-dm', {
          onclick: async (e) => {
            const b = e.currentTarget;
            b.disabled = true;
            try {
              await api.post(`/conversations/${c.id}/messages`, { videoId: video.id });
              b.classList.add('sent');
              b.querySelector('.share-dm-name').textContent = 'Sent';
              record();
            } catch (err) { toastError(err); b.disabled = false; }
          },
        }, avatar(c.user, 48, { link: false }), h('span.share-dm-name', c.user.displayName))));
      }).catch(() => { clear(list); list.appendChild(h('p.muted.small', 'Could not load conversations.')); });
    } else {
      clear(list);
      list.appendChild(h('p.muted.small', 'Log in to send videos to friends.'));
    }
    const enc = encodeURIComponent;
    const text = enc(video.caption || `Watch this on ${BRAND.name}`);
    const external = [
      ['Copy link', 'link', async () => {
        try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { prompt('Copy this link:', url); }
        record(); close();
      }],
      navigator.share ? ['More…', 'share', async () => {
        try { await navigator.share({ title: BRAND.name, text: video.caption, url }); record(); close(); } catch { /* cancelled */ }
      }] : null,
      ['X / Twitter', 'globe', () => { window.open(`https://twitter.com/intent/tweet?url=${enc(url)}&text=${text}`, '_blank', 'noopener'); record(); }],
      ['WhatsApp', 'message', () => { window.open(`https://wa.me/?text=${text}%20${enc(url)}`, '_blank', 'noopener'); record(); }],
      ['Email', 'send', () => { location.href = `mailto:?subject=${text}&body=${enc(url)}`; record(); }],
    ].filter(Boolean);
    const repostBtn = !video.isOwner && video.visibility === 'public' ? h('button.share-repost', { onclick: () => toggleRepost(video, () => { close(); }) },
      icon('refresh', { size: 18 }), video.reposted ? 'Remove repost' : 'Repost to your followers', h('span.muted.small', ` · ${fmtCount(video.reposts || 0)}`)) : null;
    return h('div.share-sheet',
      repostBtn,
      h('h4.share-sub', 'Send to'), list,
      h('h4.share-sub', 'Share to'),
      h('div.share-targets', external.map(([label, ic, fn]) => h('button.share-target', { onclick: fn }, h('span.share-icon', icon(ic)), h('span', label)))),
      h('div.share-url', h('input.input', { value: url, readonly: true, onclick: (e) => e.target.select() })));
  }, { title: 'Share', sheet: true });
}

// ---------- Report ----------
const REASON_LABELS = {
  spam: 'Spam or scam', harassment: 'Harassment or bullying', hate: 'Hate speech', violence: 'Violence or dangerous acts',
  nudity: 'Nudity or sexual content', self_harm: 'Suicide or self-harm', misinformation: 'Misinformation', impersonation: 'Impersonation',
  intellectual_property: 'Intellectual property', minor_safety: 'Minor safety', other: 'Something else',
};

export function reportDialog(targetType, targetId) {
  if (!requireLogin('Log in to report content')) return;
  let reason = null;
  openModal((close) => {
    const details = h('textarea.input', { placeholder: 'Add details (optional)', rows: 3, maxlength: 1000 });
    const submit = h('button.btn.btn-primary.btn-block', { disabled: true }, 'Submit report');
    const list = h('div.reason-list', Object.entries(REASON_LABELS).map(([k, label]) => h('label.reason',
      h('input', { type: 'radio', name: 'reason', value: k, onchange: () => { reason = k; submit.disabled = false; } }), h('span', label))));
    submit.addEventListener('click', async () => {
      submit.disabled = true;
      try {
        const r = await api.post('/reports', { targetType, targetId, reason, details: details.value });
        toast(r.message || 'Report submitted', { type: 'success' });
        close();
      } catch (e) { toastError(e); submit.disabled = false; }
    });
    return h('div.stack', h('p.muted', 'Why are you reporting this?'), list, details, submit);
  }, { title: 'Report', className: 'modal-sm' });
}

// ---------- User list (followers / following) ----------
export function userRow(u, { showFollow = true, extra } = {}) {
  return h('div.user-row',
    avatar(u, 44),
    h('a.user-row-text', { href: `/@${u.username}` }, h('div.user-row-name', u.displayName, u.verified ? icon('checkCircle', { size: 14, cls: 'verified' }) : null),
      h('div.user-row-sub.muted', `@${u.username}${u.followers !== undefined ? ' · ' + fmtCount(u.followers) + ' followers' : ''}`)),
    extra || null,
    showFollow && store.me && u.username !== store.me.username && u.followStatus !== 'self' ? followButton(u.username, u.followStatus, { small: true }) : null);
}

export function userListModal(username, which) {
  openModal(() => {
    const box = h('div.user-list', loadingBlock());
    api.get(`/users/${encodeURIComponent(username)}/${which}`).then(({ users }) => {
      clear(box);
      if (!users.length) box.appendChild(emptyState({ iconName: 'users', title: which === 'followers' ? 'No followers yet' : 'Not following anyone yet' }));
      users.forEach((u) => box.appendChild(userRow(u)));
    }).catch((e) => { clear(box); box.appendChild(errorState(e)); });
    return box;
  }, { title: which === 'followers' ? 'Followers' : 'Following', className: 'modal-md' });
}

// ---------- Video grid ----------
export function videoTile(v, { showViews = true, badge, showPinned = false } = {}) {
  const img = h('img.tile-thumb', { src: v.thumbUrl || BRAND.placeholderThumb, alt: v.caption || 'Video', loading: 'lazy', style: { filter: filterCss(v.filter) }, onerror: (e) => { e.target.src = BRAND.placeholderThumb; } });
  let preview = null;
  const tile = h('a.video-tile', {
    href: `/video/${v.id}`,
    onmouseenter: () => {
      if (matchMedia('(hover: none)').matches) return;
      preview = h('video.tile-preview', { src: v.videoUrl, muted: true, autoplay: true, loop: true, playsInline: true, preload: 'none' });
      preview.muted = true;
      tile.querySelector('.tile-media').appendChild(preview);
      preview.play().catch(() => {});
    },
    onmouseleave: () => { if (preview) { preview.pause(); preview.removeAttribute('src'); preview.load(); preview.remove(); preview = null; } },
  },
  h('div.tile-media', img, h('span.tile-play', icon('play', { size: 26 })),
    badge ? h('span.tile-badge', badge) : null,
    showPinned && v.pinned ? h('span.tile-badge.tile-pinned', 'Pinned') : null,
    v.draft ? h('span.tile-badge.tile-private', icon('edit', { size: 12 }), 'Draft') : v.publishAt ? h('span.tile-badge.tile-private', icon('clock', { size: 12 }), new Date(v.publishAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) : null,
    v.remix ? h('span.tile-badge.tile-remix', v.remix.type === 'duet' ? 'Duet' : 'Stitch') : null,
    v.visibility && v.visibility !== 'public' && v.isOwner ? h('span.tile-badge.tile-private', icon(v.visibility === 'private' ? 'lock' : 'users', { size: 12 }), v.visibility === 'private' ? 'Only me' : 'Followers') : null,
    showViews ? h('span.tile-views', icon('play', { size: 14 }), fmtCount(v.views)) : null,
    v.duration ? h('span.tile-duration', fmtDuration(v.duration)) : null),
  v.caption !== undefined ? h('div.tile-caption', v.caption || ' ') : null,
  h('div.tile-meta', avatar(v.author, 20, { link: false }), h('span.tile-author', v.author.username), h('span.tile-likes', icon('heart', { size: 14 }), fmtCount(v.likes))));
  return tile;
}

export function videoGrid(videos, opts = {}) {
  return h('div.video-grid', { class: opts.cls || '' }, videos.map((v) => videoTile(v, opts)));
}

/** Paginated grid that loads more on scroll. fetchPage(offset) => { videos, hasMore } */
export function pagedGrid(fetchPage, { empty, tileOpts } = {}) {
  const wrap = h('div.paged-grid');
  const grid = h('div.video-grid');
  const sentinel = h('div.sentinel');
  let offset = 0;
  let loading = false;
  let done = false;
  const load = async () => {
    if (loading || done) return;
    loading = true;
    sentinel.replaceChildren(spinner());
    try {
      const r = await fetchPage(offset);
      if (r.private) { wrap.replaceChildren(emptyState({ iconName: 'lock', title: 'This account is private', text: 'Follow this account to see their videos.' })); done = true; return; }
      if (r.hidden) { wrap.replaceChildren(emptyState({ iconName: 'lock', title: "This user's liked videos are private" })); done = true; return; }
      r.videos.forEach((v) => grid.appendChild(videoTile(v, tileOpts)));
      offset += r.videos.length;
      done = !r.hasMore || !r.videos.length;
      if (offset === 0 && done) wrap.replaceChildren(empty || emptyState({ title: 'No videos yet' }));
    } catch (e) {
      wrap.replaceChildren(errorState(e, () => { wrap.replaceChildren(grid, sentinel); loading = false; load(); }));
      done = true;
    } finally {
      loading = false;
      sentinel.replaceChildren();
    }
  };
  wrap.append(grid, sentinel);
  const io = new IntersectionObserver((es) => es.some((x) => x.isIntersecting) && load(), { rootMargin: '400px' });
  io.observe(sentinel);
  load();
  wrap.cleanup = () => io.disconnect();
  return wrap;
}

// ---------- Edit / delete video ----------
export function editVideoModal(video, onSaved) {
  openModal((close) => {
    const caption = h('textarea.input', { rows: 2, maxlength: 300, value: video.caption });
    const description = h('textarea.input', { rows: 3, maxlength: 2000, value: video.description || '' });
    const vis = h('select.input', ['public', 'followers', 'private'].map((x) => h('option', { value: x, selected: video.visibility === x }, { public: 'Everyone', followers: 'Followers', private: 'Only me' }[x])));
    const allow = h('input', { type: 'checkbox', checked: video.allowComments });
    const remix = h('input', { type: 'checkbox', checked: video.allowRemix });
    const thumbInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'hidden' });
    const thumbImg = h('img.edit-thumb', { src: video.thumbUrl || BRAND.placeholderThumb, alt: 'Cover', style: { filter: filterCss(video.filter) } });
    thumbInput.addEventListener('change', async () => {
      const f = thumbInput.files[0];
      if (!f) return;
      const fd = new FormData();
      fd.append('thumbnail', f);
      try {
        const r = await api.upload(`/videos/${video.id}/thumbnail`, fd).promise;
        thumbImg.src = r.video.thumbUrl;
        Object.assign(video, r.video);
        toast('Cover updated', { type: 'success' });
      } catch (e) { toastError(e); }
    });
    let filter = video.filter || '';
    const filterRow = h('div.filter-row', [['', 'Original'], ...Object.entries(FILTERS).map(([k, f]) => [k, f.label])].map(([k, label]) =>
      h(`button.filter-chip${filter === k ? '.active' : ''}`, { type: 'button', onclick: (e) => {
        filter = k;
        filterRow.querySelectorAll('.filter-chip').forEach((b) => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        thumbImg.style.filter = filterCss(k);
      } }, h('span.filter-swatch', { style: { filter: filterCss(k), backgroundImage: video.thumbUrl ? `url("${video.thumbUrl}")` : '' } }), label)));

    // captions
    const ccVideo = h('video.cc-preview', { src: video.videoUrl, controls: true, muted: true, playsInline: true, preload: 'metadata' });
    let vtt = null;
    const cc = captionsEditor(ccVideo, '', { onChange: (x) => { vtt = x; } });
    if (video.captionsUrl) fetch(video.captionsUrl).then((r) => r.text()).then((t) => { cc.setVtt(t); }).catch(() => {});
    const autoBtn = h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: async () => {
      autoBtn.disabled = true;
      autoBtn.textContent = 'Transcribing…';
      try {
        const r = await api.post(`/videos/${video.id}/captions/auto`);
        cc.setVtt(r.captions);
        vtt = r.captions;
        Object.assign(video, r.video);
        toast('Captions generated', { type: 'success' });
      } catch (e) { toastError(e); } finally { autoBtn.disabled = false; autoBtn.replaceChildren(icon('wand', { size: 14 }), ' Auto-generate'); }
    } }, icon('wand', { size: 14 }), ' Auto-generate');
    const ccBox = h('details.cc-details', h('summary', icon('comment', { size: 14 }), ' Captions', video.captionsUrl ? h('span.pill', 'on') : null),
      h('div.stack-sm', ccVideo, cc, h('div.row.gap', autoBtn, h('span.muted.small', 'Auto-captions need a speech-to-text provider (see README).'))));

    const pending = video.draft || video.publishAt;
    const save = h('button.btn.btn-primary', { type: 'submit' }, 'Save');
    async function submit(extra = {}) {
      save.disabled = true;
      try {
        const body = { caption: caption.value, description: description.value, visibility: vis.value, allowComments: allow.checked, allowRemix: remix.checked, filter, ...extra };
        if (vtt !== null) body.captions = vtt;
        const r = await api.patch(`/videos/${video.id}`, body);
        Object.assign(video, r.video);
        toast(extra.publish ? 'Published!' : 'Video updated', { type: 'success' });
        onSaved && onSaved(r.video);
        close();
      } catch (err) { toastError(err); save.disabled = false; }
    }
    return h('form.stack', { onsubmit: (e) => { e.preventDefault(); submit(); } },
      pending ? h('div.draft-banner', icon(video.draft ? 'edit' : 'clock', { size: 16 }),
        h('span', video.draft ? 'This video is a draft — only you can see it.' : `Scheduled for ${new Date(video.publishAt).toLocaleString()}`),
        h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => submit({ publish: true }) }, 'Publish now')) : null,
      h('div.edit-thumb-row', thumbImg, h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: () => thumbInput.click() }, icon('image', { size: 16 }), ' Change cover'), thumbInput),
      h('label.field', h('span.label', 'Caption'), caption, h('span.hint', 'Use #hashtags and @mentions')),
      h('label.field', h('span.label', 'Description'), description),
      h('div.field', h('span.label', 'Filter'), filterRow),
      ccBox,
      h('label.field', h('span.label', 'Who can watch'), vis),
      h('label.check', allow, ' Allow comments'),
      h('label.check', remix, ' Allow Duet & Stitch'),
      h('div.row.end.gap', h('button.btn.btn-ghost', { type: 'button', onclick: close }, 'Cancel'), save));
  }, { title: 'Edit video', className: 'modal-md' });
}

// ---------- Reposts ----------
export async function toggleRepost(video, after) {
  if (!requireLogin('Log in to repost')) return;
  try {
    const r = video.reposted ? await api.del(`/videos/${video.id}/repost`) : await api.post(`/videos/${video.id}/repost`);
    video.reposted = r.reposted;
    video.reposts = r.reposts;
    toast(r.reposted ? 'Reposted to your followers' : 'Repost removed');
    after && after();
  } catch (e) { toastError(e); }
}

// ---------- Collections ----------
export function collectionsModal(video, onSaved) {
  openModal((close) => {
    const list = h('div.coll-list', loadingBlock());
    const load = () => api.get(`/library/video/${video.id}/collections`).then(({ collections }) => {
      list.replaceChildren(...(collections.length ? collections.map((c) => {
        const cb = h('input', { type: 'checkbox', checked: c.contains });
        cb.addEventListener('change', async () => {
          try {
            if (cb.checked) await api.post(`/library/collections/${c.id}/videos`, { videoId: video.id });
            else await api.del(`/library/collections/${c.id}/videos/${video.id}`);
            toast(cb.checked ? `Added to “${c.name}”` : `Removed from “${c.name}”`);
            if (cb.checked) onSaved && onSaved();
          } catch (e) { cb.checked = !cb.checked; toastError(e); }
        });
        return h('label.coll-item', cb, icon('bookmark', { size: 16 }), h('span', c.name));
      }) : [h('p.muted.small', 'No collections yet — create one below.')]));
    }).catch((e) => list.replaceChildren(errorState(e)));
    load();
    const name = h('input.input', { placeholder: 'New collection name', maxlength: 40 });
    return h('div.stack', list, h('form.row.gap', {
      onsubmit: async (e) => {
        e.preventDefault();
        if (!name.value.trim()) return;
        try {
          await api.post('/library/collections', { name: name.value.trim(), videoId: video.id });
          toast(`Saved to “${name.value.trim()}”`, { type: 'success' });
          name.value = '';
          onSaved && onSaved();
          load();
        } catch (err) { toastError(err); }
      },
    }, name, h('button.btn.btn-primary', { type: 'submit' }, 'Create')));
  }, { title: 'Save to collection', className: 'modal-sm' });
}

export async function deleteVideo(video, after) {
  const ok = await confirmDialog({ title: 'Delete this video?', message: 'This permanently removes the video, its likes and comments.', confirmText: 'Delete', danger: true });
  if (!ok) return false;
  try {
    await api.del(`/videos/${video.id}`);
    toast('Video deleted');
    after && after();
    return true;
  } catch (e) { toastError(e); return false; }
}

// ---------- Search box with suggestions ----------
export function searchBox({ autofocus = false, initial = '' } = {}) {
  const input = h('input.search-input', { type: 'search', placeholder: 'Search accounts, videos and #hashtags', value: initial, 'aria-label': 'Search', autocomplete: 'off', maxlength: 100 });
  const pop = h('div.search-pop.hidden');
  const go = (q) => { pop.classList.add('hidden'); if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`); };
  const suggest = debounce(async () => {
    const q = input.value.trim();
    if (!q) { pop.classList.add('hidden'); return; }
    try {
      const r = await api.get(`/search/suggest?q=${encodeURIComponent(q)}`);
      clear(pop);
      pop.appendChild(h('button.sug-item', { onmousedown: (e) => { e.preventDefault(); go(q); } }, icon('search', { size: 16 }), h('span', `Search “${q}”`)));
      r.hashtags.forEach((t) => pop.appendChild(h('button.sug-item', { onmousedown: (e) => { e.preventDefault(); pop.classList.add('hidden'); navigate(`/tag/${encodeURIComponent(t.tag)}`); } },
        icon('hash', { size: 16 }), h('span', '#' + t.tag), h('span.muted.small', `${fmtCount(t.videos)} videos`))));
      r.users.forEach((u) => pop.appendChild(h('button.sug-item', { onmousedown: (e) => { e.preventDefault(); pop.classList.add('hidden'); navigate(`/@${u.username}`); } },
        avatar(u, 24, { link: false }), h('span', u.displayName), h('span.muted.small', '@' + u.username))));
      pop.classList.remove('hidden');
    } catch { /* ignore */ }
  }, 200);
  input.addEventListener('input', suggest);
  input.addEventListener('focus', () => input.value.trim() && suggest());
  input.addEventListener('blur', () => setTimeout(() => pop.classList.add('hidden'), 150));
  const form = h('form.search-box', { role: 'search', onsubmit: (e) => { e.preventDefault(); go(input.value); } },
    input, h('button.search-btn', { type: 'submit', 'aria-label': 'Search' }, icon('search', { size: 20 })), pop);
  if (autofocus) setTimeout(() => input.focus(), 50);
  form.input = input;
  return form;
}
