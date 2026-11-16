// For You / Following feeds.
import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { emptyState } from '../components/ui.js';
import { feed } from '../components/feed.js';

export default function home(ctx) {
  const following = ctx.key === 'following';
  const header = h('div.feed-tabs',
    h('a.feed-tab', { href: '/following', class: following ? 'active' : '' }, 'Following'),
    h('a.feed-tab', { href: '/', class: following ? '' : 'active' }, 'For You'),
    h('a.feed-tab.feed-tab-live', { href: '/live' }, 'LIVE'));

  if (following && !store.me) {
    return {
      title: 'Following',
      el: h('div.page-center', header, emptyState({ iconName: 'users', title: 'See videos from creators you follow', text: 'Log in to build your Following feed.', action: h('a.btn.btn-primary', { href: '/login?next=/following' }, 'Log in') })),
    };
  }

  const VIBES = [['', 'All'], ['chill', 'Chill'], ['hype', 'Hype'], ['funny', 'Funny'], ['learn', 'Learn'], ['explore', 'Explore']];
  const vibe = following ? '' : (ctx.query.get('vibe') || '');
  const vibeBar = following ? null : h('div.vibe-bar', VIBES.map(([k, label]) => h(`a.vibe-chip${k === vibe ? '.active' : ''}`, { href: k ? `/?vibe=${k}` : '/' }, label)));
  let cursor = null;
  const fetchPage = following
    ? async () => { const r = await api.get(`/videos/feed/following?limit=6${cursor ? `&before=${cursor}` : ''}`); cursor = r.next; return r; }
    : ({ ids }) => api.get(`/videos/feed/foryou?limit=6${vibe ? `&vibe=${vibe}` : ''}&exclude=${ids.slice(-400).join(',')}`);

  const el = feed(fetchPage, {
    header: h('div.feed-header', header, vibeBar),
    source: following ? 'following' : 'foryou',
    empty: following
      ? emptyState({ iconName: 'users', title: 'No videos from people you follow', text: 'Follow creators to see their latest videos here.', action: h('a.btn.btn-primary', { href: '/explore' }, 'Discover creators') })
      : emptyState({ iconName: 'film', title: 'No videos yet', text: 'Be the first to post something!', action: h('a.btn.btn-primary', { href: '/upload' }, 'Upload a video') }),
  });
  return { el, cleanup: el.cleanup, title: following ? 'Following' : 'For You' };
}
