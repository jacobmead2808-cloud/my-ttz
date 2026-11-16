// Hashtag page.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { fmtCount } from '../lib/format.js';
import { toast, emptyState } from '../components/ui.js';
import { pagedGrid } from '../components/social.js';

export default async function tagPage(ctx) {
  const tag = ctx.params.tag.toLowerCase();
  const first = await api.get(`/tags/${encodeURIComponent(tag)}?limit=1`);
  const grid = pagedGrid((offset) => api.get(`/tags/${encodeURIComponent(tag)}?offset=${offset}`),
    { empty: emptyState({ iconName: 'hash', title: `No videos with #${tag} yet`, action: h('a.btn.btn-primary', { href: '/upload' }, 'Be the first') }) });
  const el = h('div.collection-page',
    h('div.collection-head',
      h('div.collection-art.tag-art', icon('hash', { size: 64 })),
      h('div', h('h1', `#${first.tag.tag}`), h('p.muted', `${fmtCount(first.tag.videos)} videos · ${fmtCount(first.tag.views)} views`),
        h('div.row.gap',
          h('a.btn.btn-primary', { href: '/upload' }, icon('plus', { size: 16 }), ' Post with this hashtag'),
          h('button.btn.btn-secondary', { onclick: () => navigator.clipboard.writeText(location.href).then(() => toast('Link copied')) }, icon('link', { size: 16 }), ' Copy link')))),
    grid);
  return { el, title: `#${tag}`, cleanup: grid.cleanup };
}
