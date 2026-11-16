// User profile: header with stats, follow/message/edit, and Videos / Liked / Favorites tabs.
import { h, richText } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { store, on, setMe } from '../lib/store.js';
import { fmtCount } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { BRAND } from '../brand.js';
import { avatar, toast, toastError, openModal, actionSheet, confirmDialog, promptDialog, emptyState, tabs, requireLogin, verifiedBadge } from '../components/ui.js';
import { followButton, userListModal, pagedGrid, reportDialog } from '../components/social.js';
import { addStory, openStoryViewer } from '../components/stories.js';
import { openGiftGallery } from '../components/coins.js';

export function editProfileModal(onSaved) {
  const me = store.me;
  openModal((close) => {
    let pendingAvatar = null;
    const img = h('img.edit-avatar', { src: me.avatarUrl || BRAND.defaultAvatar, alt: 'Profile photo' });
    const file = h('input.hidden', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif' });
    file.addEventListener('change', () => {
      const f = file.files[0];
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) { toastError(new Error('Image must be under 8 MB')); return; }
      pendingAvatar = f;
      img.src = URL.createObjectURL(f);
    });
    const username = h('input.input', { value: me.username, maxlength: 24, minlength: 2, required: true });
    username.addEventListener('input', () => { username.value = username.value.toLowerCase().replace(/[^a-z0-9_.]/g, ''); });
    const name = h('input.input', { value: me.displayName, maxlength: 40 });
    const bio = h('textarea.input', { rows: 3, maxlength: 160, value: me.bio });
    const bioCount = h('span.hint', `${me.bio.length}/160`);
    bio.addEventListener('input', () => { bioCount.textContent = `${bio.value.length}/160`; });
    const save = h('button.btn.btn-primary', { type: 'submit' }, 'Save');
    return h('form.stack.edit-profile', {
      onsubmit: async (e) => {
        e.preventDefault();
        save.disabled = true;
        try {
          if (pendingAvatar) {
            const fd = new FormData();
            fd.append('avatar', pendingAvatar);
            await api.upload('/me/avatar', fd).promise;
          }
          const r = await api.patch('/me', { username: username.value, displayName: name.value, bio: bio.value });
          setMe(r.user);
          toast('Profile updated', { type: 'success' });
          close();
          onSaved && onSaved(r.user);
        } catch (err) { toastError(err); save.disabled = false; }
      },
    },
    h('div.edit-avatar-row', img, h('div.stack-sm',
      h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: () => file.click() }, icon('camera', { size: 16 }), ' Change photo'),
      me.avatarUrl ? h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: async () => {
        try { const r = await api.del('/me/avatar'); setMe(r.user); img.src = BRAND.defaultAvatar; toast('Photo removed'); } catch (err) { toastError(err); }
      } }, 'Remove') : null), file),
    h('label.field', h('span.label', 'Username'), username, h('span.hint', `${location.host}/@${me.username} · letters, numbers, underscores and dots`)),
    h('label.field', h('span.label', 'Name'), name),
    h('label.field', h('span.label', 'Bio'), bio, bioCount),
    h('div.row.end.gap', h('button.btn.btn-ghost', { type: 'button', onclick: close }, 'Cancel'), save));
  }, { title: 'Edit profile', className: 'modal-md' });
}

export default async function profilePage(ctx) {
  const username = ctx.params.username.replace(/^@/, '').toLowerCase();
  let user;
  try {
    ({ user } = await api.get(`/users/${encodeURIComponent(username)}`));
  } catch (e) {
    if (e.status === 404) return { title: "Couldn't find this account", el: emptyState({ iconName: 'user', title: "Couldn't find this account", text: 'Looking for videos? Try browsing our trending creators, hashtags, and sounds.', action: h('a.btn.btn-primary', { href: '/explore' }, 'Explore') }) };
    throw e;
  }
  const subs = [];
  let grid = null;
  const stats = { ...user.stats };
  const statEl = (label, key, onClick) => h(`button.stat${onClick ? '' : '.static'}`, { onclick: onClick }, h('b', { dataset: { stat: key } }, fmtCount(stats[key])), h('span', label));
  const paintStats = () => header.querySelectorAll('[data-stat]').forEach((b) => { b.textContent = fmtCount(stats[b.dataset.stat]); });
  const canList = user.canView;

  const rel = user.relationship;
  const buttons = h('div.profile-actions');
  if (user.isSelf) {
    buttons.append(
      h('button.btn.btn-primary', { onclick: () => editProfileModal(() => navigate(`/@${store.me.username}`, { replace: true })) }, 'Edit profile'),
      h('a.btn.btn-secondary', { href: '/live/studio' }, icon('live', { size: 16 }), ' Go LIVE'),
      h('a.btn.btn-secondary', { href: '/analytics' }, icon('chart', { size: 16 }), ' Analytics'),
      h('button.btn.btn-secondary', { onclick: () => addStory(() => navigate(location.pathname, { replace: true })) }, icon('plus', { size: 16 }), ' Story'),
      h('a.btn.btn-secondary.icon-only', { href: '/settings', 'aria-label': 'Settings' }, icon('settings', { size: 18 })));
  } else if (rel && rel.blockedByYou) {
    buttons.append(h('button.btn.btn-secondary', { onclick: async () => {
      try { await api.del(`/users/${encodeURIComponent(user.username)}/block`); toast('Unblocked'); navigate(location.pathname, { replace: true }); } catch (e) { toastError(e); }
    } }, 'Unblock'));
  } else {
    buttons.append(followButton(user.username, rel ? rel.followStatus : null, {
      followsYou: rel && rel.followsYou,
      onChange: (_s, r) => { if (r.stats) { Object.assign(stats, r.stats); paintStats(); } },
    }));
    if (!rel || rel.canMessage) {
      buttons.append(h('button.btn.btn-secondary', { onclick: async () => {
        if (!requireLogin('Log in to send messages')) return;
        try { const r = await api.post('/conversations', { username: user.username }); navigate(`/messages/${r.id}`); } catch (e) { toastError(e); }
      } }, icon('message', { size: 16 }), ' Message'));
    }
  }
  buttons.append(h('button.btn.btn-secondary.icon-only', { 'aria-label': 'Gift gallery', title: 'Gift gallery', onclick: () => openGiftGallery(user.username) }, icon('gift', { size: 18 })));
  buttons.append(h('button.btn.btn-secondary.icon-only', { 'aria-label': 'Share profile', title: 'Share profile', onclick: async () => {
    const url = `${location.origin}/@${user.username}`;
    if (navigator.share) { try { await navigator.share({ title: user.displayName, url }); return; } catch { /* cancelled */ } }
    navigator.clipboard.writeText(url).then(() => toast('Profile link copied'));
  } }, icon('share', { size: 18, filled: true })));
  if (!user.isSelf) {
    buttons.append(h('button.btn.btn-secondary.icon-only', { 'aria-label': 'More', onclick: () => actionSheet([
      { label: 'Copy profile link', icon: 'link', onClick: () => navigator.clipboard.writeText(`${location.origin}/@${user.username}`).then(() => toast('Link copied')) },
      store.me && rel && rel.followsYou ? { label: 'Remove follower', icon: 'users', onClick: async () => {
        if (!(await confirmDialog({ title: `Remove @${user.username} as a follower?`, confirmText: 'Remove', danger: true }))) return;
        try { await api.del(`/users/${encodeURIComponent(user.username)}/follower`); toast('Follower removed'); stats.followers--; paintStats(); } catch (e) { toastError(e); }
      } } : null,
      store.me && !(rel && rel.blockedByYou) ? { label: 'Block', icon: 'block', danger: true, onClick: async () => {
        if (!(await confirmDialog({ title: `Block @${user.username}?`, message: "They won't be able to find your profile, see your videos, message you, or interact with you. They won't be notified.", confirmText: 'Block', danger: true }))) return;
        try { await api.post(`/users/${encodeURIComponent(user.username)}/block`); toast(`Blocked @${user.username}`); navigate(location.pathname, { replace: true }); } catch (e) { toastError(e); }
      } } : null,
      { label: 'Report account', icon: 'flag', danger: true, onClick: () => reportDialog('user', user.id) },
    ]) }, icon('more', { size: 18 })));
  }

  const avatarWrap = h('div.profile-avatar', avatar(user, matchMedia('(max-width: 767px)').matches ? 110 : 180, { link: false }));
  if (user.canView) {
    api.get(`/stories/user/${encodeURIComponent(user.username)}`).then(({ stories }) => {
      if (!stories.length) return;
      const allSeen = stories.every((s) => s.seen);
      avatarWrap.classList.add('has-story');
      avatarWrap.classList.toggle('seen', allSeen && !user.isSelf);
      avatarWrap.title = 'View story';
      avatarWrap.addEventListener('click', () => openStoryViewer([{ user: { ...user }, stories, isSelf: user.isSelf }], 0));
    }).catch(() => {});
  }
  const header = h('div.profile-header',
    avatarWrap,
    h('div.profile-info',
      h('div.profile-title',
        h('h1.profile-username', user.displayName, user.owner ? h('span.owner-badge', 'Owner') : null),
        h('span.profile-handle', user.username, verifiedBadge(user), user.isPrivate ? h('span.private-pill', icon('lock', { size: 12 }), 'Private') : null)),
      h('div.profile-stats',
        statEl('Following', 'following', canList ? () => userListModal(user.username, 'following') : null),
        statEl('Followers', 'followers', canList ? () => userListModal(user.username, 'followers') : null),
        statEl('Likes', 'likes')),
      buttons,
      user.bio ? h('p.profile-bio', richText(user.bio)) : h('p.profile-bio.muted', user.isSelf ? 'No bio yet.' : ''),
      user.status && user.status !== 'active' ? h('p.status-pill', `Account ${user.status}`) : null));

  const content = h('div.profile-content');
  const base = `/users/${encodeURIComponent(user.username)}`;
  const EMPTY = {
    videos: () => emptyState({ iconName: 'film', title: user.isSelf ? 'Upload your first video' : 'No videos yet', text: user.isSelf ? 'Your videos will appear here.' : 'This user has not posted any videos.', action: user.isSelf ? h('a.btn.btn-primary', { href: '/upload' }, 'Upload now') : null }),
    reposts: () => emptyState({ iconName: 'refresh', title: 'No reposts yet', text: user.isSelf ? 'Videos you repost show up here and in your followers’ Following feed.' : '' }),
    liked: () => emptyState({ iconName: 'heart', title: 'No liked videos yet' }),
    drafts: () => emptyState({ iconName: 'edit', title: 'No drafts or scheduled posts', text: 'Save a draft or schedule a post from the upload page.' }),
  };
  function favorites() {
    const chips = h('div.coll-chips');
    const area = h('div');
    let active = 'all';
    const show = (id) => {
      active = id;
      if (grid && grid.cleanup) grid.cleanup();
      grid = id === 'all'
        ? pagedGrid((offset) => api.get(`${base}/saved?offset=${offset}`), { empty: emptyState({ iconName: 'bookmark', title: 'No favorites yet', text: 'Save videos to watch them later. Only you can see your favorites.' }) })
        : pagedGrid(() => api.get(`/library/collections/${id}/videos`), { empty: emptyState({ iconName: 'bookmark', title: 'This collection is empty', text: 'Use “Add to collection” on any video.' }) });
      area.replaceChildren(grid);
      paint();
    };
    let cols = [];
    const paint = () => chips.replaceChildren(
      h(`button.coll-chip${active === 'all' ? '.active' : ''}`, { onclick: () => show('all') }, icon('bookmark', { size: 14 }), ' All favorites'),
      ...cols.map((c) => h(`button.coll-chip${active === c.id ? '.active' : ''}`, {
        onclick: () => show(c.id),
        oncontextmenu: (e) => { e.preventDefault(); manage(c); },
      }, c.name, h('span.muted.small', ` ${c.count}`), active === c.id ? h('span.coll-more', { onclick: (e) => { e.stopPropagation(); manage(c); } }, icon('more', { size: 14 })) : null)),
      h('button.coll-chip.add', { onclick: async () => {
        const name = await promptDialog({ title: 'New collection', label: 'Name', confirmText: 'Create' });
        if (!name) return;
        try { await api.post('/library/collections', { name }); await loadCols(); } catch (e) { toastError(e); }
      } }, icon('plus', { size: 14 }), ' New collection'));
    const manage = (c) => actionSheet([
      { label: 'Rename', icon: 'edit', onClick: async () => {
        const name = await promptDialog({ title: 'Rename collection', initial: c.name, confirmText: 'Save' });
        if (!name) return;
        try { await api.patch(`/library/collections/${c.id}`, { name }); await loadCols(); } catch (e) { toastError(e); }
      } },
      { label: 'Delete collection', icon: 'trash', danger: true, onClick: async () => {
        if (!(await confirmDialog({ title: `Delete “${c.name}”?`, message: 'Videos stay in your favorites.', confirmText: 'Delete', danger: true }))) return;
        try { await api.del(`/library/collections/${c.id}`); await loadCols(); show('all'); } catch (e) { toastError(e); }
      } },
    ], { title: c.name });
    const loadCols = async () => { try { cols = (await api.get('/library/collections')).collections; } catch { cols = []; } paint(); };
    loadCols();
    show('all');
    return h('div.stack-sm', chips, area);
  }
  let sort = 'latest';
  let currentTab = 'videos';
  const sortSeg = h('div.seg.profile-sort', ['latest', 'popular', 'oldest'].map((k) => h(`button.seg-btn${k === sort ? '.active' : ''}`, { onclick: (e) => {
    sort = k;
    sortSeg.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
    mount(currentTab);
  } }, k[0].toUpperCase() + k.slice(1))));
  const mount = (tab) => {
    currentTab = tab;
    if (grid && grid.cleanup) grid.cleanup();
    grid = null;
    if (tab !== 'videos') sortSeg.classList.add('hidden');
    if (tab === 'saved') { content.replaceChildren(favorites()); return; }
    if (tab === 'drafts') {
      grid = pagedGrid(() => api.get('/library/drafts'), { empty: EMPTY.drafts() });
      content.replaceChildren(h('p.muted.small.drafts-note', 'Only you can see drafts and scheduled posts. Open one and use “Edit details” to publish or change it.'), grid);
      return;
    }
    const path = tab === 'liked' ? `${base}/liked` : tab === 'reposts' ? `${base}/reposts` : `${base}/videos`;
    const sortQ = tab === 'videos' ? `&sort=${sort}` : '';
    sortSeg.classList.toggle('hidden', tab !== 'videos');
    grid = pagedGrid((offset) => api.get(`${path}?offset=${offset}${sortQ}`), { empty: (EMPTY[tab] || EMPTY.videos)(), tileOpts: { showPinned: tab === 'videos' && sort === 'latest' } });
    content.replaceChildren(grid);
  };
  const tabItems = [{ value: 'videos', label: 'Videos', icon: 'grid' }, { value: 'reposts', label: 'Reposts', icon: 'refresh' }];
  if (user.isSelf || user.showLiked) tabItems.push({ value: 'liked', label: 'Liked', icon: 'heart' });
  if (user.isSelf) tabItems.push({ value: 'saved', label: 'Favorites', icon: 'bookmark' }, { value: 'drafts', label: 'Drafts', icon: 'edit' });
  const startTab = tabItems.some((t) => t.value === ctx.query.get('tab')) ? ctx.query.get('tab') : 'videos';

  let body;
  if (rel && rel.blockedByYou) body = emptyState({ iconName: 'block', title: `You blocked @${user.username}`, text: 'Unblock to see their content.' });
  else if (!user.canView) body = emptyState({ iconName: 'lock', title: 'This account is private', text: 'Follow this account to see their videos and likes.' });
  else {
    body = h('div', h('div.profile-bar', tabs(tabItems, startTab, (t) => { history.replaceState({}, '', `${location.pathname}${t === 'videos' ? '' : `?tab=${t}`}`); mount(t); }, 'profile-tabs scroll-tabs'), sortSeg), content);
    mount(startTab);
  }

  subs.push(on('follow', ({ username: u, stats: s }) => { if (u === user.username && s) { Object.assign(stats, s); paintStats(); } }));
  const el = h('div.profile-page', h('div.profile-cover'), header, body);
  return { el, title: `${user.displayName} (@${user.username})`, cleanup: () => { subs.forEach((u) => u()); if (grid && grid.cleanup) grid.cleanup(); } };
}
