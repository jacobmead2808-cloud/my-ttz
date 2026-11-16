// Activity inbox: notifications with filters + follow requests.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { ws } from '../lib/ws.js';
import { setUnread } from '../lib/store.js';
import { timeAgo } from '../lib/format.js';
import { avatar, emptyState, errorState, loadingBlock, tabs, toastError, spinner } from '../components/ui.js';
import { followButton } from '../components/social.js';

const TEXT = {
  like: 'liked your video.',
  comment_like: 'liked your comment.',
  comment: 'commented:',
  reply: 'replied to your comment:',
  mention: 'mentioned you.',
  follow: 'started following you.',
  follow_request: 'requested to follow you.',
  follow_accept: 'accepted your follow request.',
  live: 'is LIVE now:',
  live_mod: '',
  repost: 'reposted your video.',
  mod_case: '',
  duet: 'made a Duet with your video.',
  stitch: 'Stitched your video.',
  video_reply: 'replied to your comment with a video:',
  announcement: '',
  verified: '',
  moderation: '',
};

const TYPE_ICON = {
  like: 'heart', comment_like: 'heart', comment: 'comment', reply: 'comment', mention: 'comment', follow: 'user', follow_request: 'user',
  follow_accept: 'check', live: 'live', mod_case: 'shield', repost: 'refresh', duet: 'users', stitch: 'film', video_reply: 'video', live_mod: 'shield', announcement: 'sparkles', verified: 'checkCircle', moderation: 'shield',
};

export default function inbox() {
  let filter = 'all';
  let before = null;
  let hasMore = false;
  const list = h('div.notif-list');
  const more = h('div.notif-more');
  const requestsBox = h('div.requests');

  function row(n) {
    const target = n.type === 'live_mod' ? '/settings?tab=moderation' : n.type === 'live' && n.streamId ? `/live/${n.streamId}` : n.videoId ? `/video/${n.videoId}` : n.actor ? `/@${n.actor.username}` : null;
    const right = n.thumbUrl ? h('a.notif-thumb', { href: target }, h('img', { src: n.thumbUrl, alt: '', loading: 'lazy' }))
      : (n.type === 'follow' || n.type === 'follow_accept') && n.actor ? followButton(n.actor.username, n.actor.followStatus, { small: true, followsYou: true }) : null;
    return h(`div.notif${n.read ? '' : '.unread'}`,
      h('span.notif-avatar', n.actor ? avatar(n.actor, 48) : h('span.notif-system', icon(n.type === 'verified' ? 'checkCircle' : 'shield', { size: 24 })),
        h(`span.notif-type.t-${n.type}`, icon(TYPE_ICON[n.type] || 'bell', { size: 12 }))),
      h(target ? 'a.notif-text' : 'div.notif-text', target ? { href: target } : {},
        n.actor ? h('b', n.actor.displayName) : h('b', n.type === 'verified' ? 'Verification' : n.type === 'mod_case' ? 'Guardian' : 'Moderation'),
        ' ', TEXT[n.type] || '',
        n.body ? h('span.notif-body', ` ${n.body}`) : null,
        h('div.muted.small', timeAgo(n.createdAt))),
      right);
  }

  async function load(reset) {
    if (reset) { before = null; list.replaceChildren(loadingBlock()); }
    more.replaceChildren(reset ? '' : spinner('sm'));
    try {
      const r = await api.get(`/notifications?filter=${filter}${before ? `&before=${before}` : ''}`);
      if (reset) list.replaceChildren();
      r.notifications.forEach((n) => list.appendChild(row(n)));
      if (reset && !r.notifications.length) list.appendChild(emptyState({ iconName: 'bell', title: 'No activity yet', text: 'Likes, comments, mentions and new followers will show up here.' }));
      hasMore = r.notifications.length === 40;
      before = r.notifications.length ? r.notifications[r.notifications.length - 1].id : before;
      more.replaceChildren(hasMore ? h('button.btn.btn-ghost.btn-sm', { onclick: () => load(false) }, 'Load more') : '');
      if (reset && filter === 'all') { await api.post('/notifications/read'); setUnread({ notifications: 0 }); }
    } catch (e) { list.replaceChildren(errorState(e, () => load(true))); }
  }

  async function loadRequests() {
    try {
      const { requests } = await api.get('/me/follow-requests');
      requestsBox.replaceChildren();
      if (!requests.length) return;
      requestsBox.append(h('h3.sr-title', `Follow requests (${requests.length})`), ...requests.map((r) => {
        const el = h('div.notif', avatar(r.user, 44), h('a.notif-text', { href: `/@${r.user.username}` }, h('b', r.user.displayName), h('div.muted.small', `@${r.user.username} · ${timeAgo(r.requestedAt)}`)),
          h('div.row.gap',
            h('button.btn.btn-primary.btn-sm', { onclick: () => act(r, 'accept', el) }, 'Confirm'),
            h('button.btn.btn-secondary.btn-sm', { onclick: () => act(r, 'decline', el) }, 'Delete')));
        return el;
      }));
    } catch { /* ignore */ }
  }
  async function act(r, action, el) {
    try { await api.post(`/me/follow-requests/${r.user.id}/${action}`); el.remove(); } catch (e) { toastError(e); }
  }

  const bar = tabs([
    { value: 'all', label: 'All activity' }, { value: 'likes', label: 'Likes' }, { value: 'comments', label: 'Comments' },
    { value: 'mentions', label: 'Mentions' }, { value: 'followers', label: 'Followers' }, { value: 'live', label: 'LIVE' },
  ], filter, (f) => { filter = f; load(true); }, 'scroll-tabs');

  const off = ws.on('notification', (m) => { if (m.kind) load(true); });
  load(true);
  loadRequests();
  return { el: h('div.inbox-page', h('h1.page-title', 'Activity'), requestsBox, bar, list, more), title: 'Activity', cleanup: off };
}
