// Single video page (shareable link): player + details + comments side by side on desktop.
import { h, richText } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { fmtCount, timeAgo } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { avatar, emptyState, toast } from '../components/ui.js';
import { followButton } from '../components/social.js';
import { videoItem } from '../components/videoItem.js';
import { commentsPanel, openCommentsDrawer } from '../components/comments.js';

export default async function videoPage(ctx) {
  let video;
  try {
    ({ video } = await api.get(`/videos/${encodeURIComponent(ctx.params.id)}`));
  } catch (e) {
    if (e.status === 404) return { title: 'Video unavailable', el: emptyState({ iconName: 'lock', title: 'Video unavailable', text: 'This video may be private, removed, or the link is wrong.', action: h('a.btn.btn-primary', { href: '/' }, 'Back to For You') }) };
    throw e;
  }
  const isDesktop = matchMedia('(min-width: 1024px)').matches;
  let panel = null;
  const item = videoItem(video, {
    inlineComments: isDesktop,
    onRemoved: () => navigate(store.me ? `/@${store.me.username}` : '/'),
    onCommentsOpen: isDesktop ? () => panel && panel.focusInput() : (v) => openCommentsDrawer(v, { onCount: (n) => { v.comments = n; } }),
  });

  const details = h('div.video-details',
    h('div.vd-author', avatar(video.author, 48),
      h('a.vd-names', { href: `/@${video.author.username}` }, h('b', video.author.username), h('span.muted', `${video.author.displayName} · ${timeAgo(video.createdAt)}`)),
      !video.isOwner ? followButton(video.author.username, video.author.followStatus === 'self' ? null : video.author.followStatus, { small: true }) : null),
    h('div.vd-caption', richText(video.caption)),
    video.description ? h('div.vd-desc.muted', richText(video.description)) : null,
    h('div.vd-sound', icon('music', { size: 14 }), video.sound.id ? h('a', { href: `/sound/${video.sound.id}` }, video.sound.title) : h('span', video.sound.title)),
    h('div.vd-stats.muted', `${fmtCount(video.views)} views · ${fmtCount(video.likes)} likes`, video.visibility !== 'public' ? ` · ${video.visibility === 'private' ? 'Only you' : 'Followers only'}` : ''),
    h('div.vd-link', h('input.input', { value: `${location.origin}/video/${video.id}`, readonly: true, onclick: (e) => e.target.select() }),
      h('button.btn.btn-secondary.btn-sm', { onclick: () => navigator.clipboard.writeText(`${location.origin}/video/${video.id}`).then(() => toast('Link copied')) }, 'Copy link')));

  if (isDesktop) panel = commentsPanel(video);
  const el = h('div.video-page',
    h('button.icon-btn.vp-back', { 'aria-label': 'Back', onclick: () => (history.length > 1 ? history.back() : navigate('/')) }, icon('chevronLeft')),
    h('div.vp-stage', item),
    isDesktop ? h('aside.vp-side', details, panel) : h('div.vp-below', details));

  requestAnimationFrame(() => item.api.activate());
  return { el, title: video.caption ? video.caption.slice(0, 60) : `Video by @${video.author.username}`, cleanup: () => item.api.destroy() };
}
