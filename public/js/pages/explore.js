// Discover: search, trending hashtags, LIVE now, popular creators, trending + recommended videos.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { fmtCount } from '../lib/format.js';
import { store } from '../lib/store.js';
import { avatar, emptyState } from '../components/ui.js';
import { searchBox, videoGrid, followButton } from '../components/social.js';
import { liveCard } from './live.js';
import { storyTray } from '../components/stories.js';

export default async function explore() {
  const d = await api.get('/discover');
  const section = (title, iconName, body, link) => h('section.ex-section',
    h('div.ex-head', h('h2', icon(iconName, { size: 20 }), ' ', title), link || null), body);

  const tagChips = h('div.chip-row', d.tags.map((t) => h('a.chip.chip-lg', { href: `/tag/${encodeURIComponent(t.tag)}` }, icon('hash', { size: 16 }), t.tag, h('span.muted.small', ` ${fmtCount(t.videos)}`))));

  const creators = h('div.creator-row', d.creators.map((u) => h('div.creator-card',
    avatar(u, 72),
    h('a.creator-name', { href: `/@${u.username}` }, u.displayName),
    h('span.muted.small', `@${u.username}`),
    h('span.small', `${fmtCount(u.followers)} followers · ${fmtCount(u.likes)} likes`),
    store.me ? followButton(u.username, u.followStatus, { small: true }) : h('a.btn.btn-primary.btn-sm', { href: `/@${u.username}` }, 'View'))));

  const tagSections = d.tagPreviews.filter((t) => t.items.length).map((t) => section(`#${t.tag}`, 'hash',
    h('div', h('p.muted.small', `${fmtCount(t.videos)} videos · ${fmtCount(t.views)} views`), videoGrid(t.items, { cls: 'grid-row' })),
    h('a.link', { href: `/tag/${encodeURIComponent(t.tag)}` }, 'See all')));

  const hasAny = d.trending.length || d.creators.length || d.tags.length;
  const el = h('div.explore-page',
    h('section.hero',
      h('div.hero-blob', { style: { background: '#ff2d6f', top: '-80px', right: '10%' } }),
      h('h1', 'Discover ', h('span.grad-text', 'what\u2019s hot')),
      h('p', 'Trending hashtags, rising creators and videos picked for you.'),
      searchBox()),
    storyTray({ title: 'Stories from people you follow' }),
    !hasAny ? emptyState({ iconName: 'compass', title: 'Nothing to explore yet', text: 'Once people start posting, trending content shows up here.', action: h('a.btn.btn-primary', { href: '/upload' }, 'Upload a video') }) : null,
    d.tags.length ? section('Trending hashtags', 'sparkles', tagChips) : null,
    d.live.length ? section('LIVE now', 'live', h('div.live-row', d.live.map(liveCard)), h('a.link', { href: '/live' }, 'See all')) : null,
    d.creators.length ? section('Popular creators', 'users', creators) : null,
    d.trending.length ? section('Trending videos', 'chart', videoGrid(d.trending)) : null,
    ...tagSections,
    d.recommended.length ? section('Recommended for you', 'film', videoGrid(d.recommended)) : null);
  return { el, title: 'Explore' };
}
