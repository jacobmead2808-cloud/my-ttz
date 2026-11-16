// Search results with Top / Accounts / Videos / Hashtags tabs.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { fmtCount } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { emptyState, loadingBlock, errorState, tabs } from '../components/ui.js';
import { searchBox, videoGrid, userRow } from '../components/social.js';

export default function searchPage(ctx) {
  const q = (ctx.query.get('q') || '').trim();
  const type = ctx.query.get('type') || 'top';
  const results = h('div.search-results');
  const box = searchBox({ initial: q, autofocus: !q });

  const tagRow = (t) => h('a.tag-row', { href: `/tag/${encodeURIComponent(t.tag)}` }, h('span.tag-icon', icon('hash', { size: 22 })),
    h('div', h('b', t.tag), h('div.muted.small', `${fmtCount(t.videos)} videos · ${fmtCount(t.views)} views`)));

  async function load(t) {
    if (!q) { results.replaceChildren(emptyState({ iconName: 'search', title: 'Search for creators, videos and hashtags' })); return; }
    results.replaceChildren(loadingBlock());
    try {
      const r = await api.get(`/search?q=${encodeURIComponent(q)}&type=${t}`);
      const parts = [];
      if (t === 'top') {
        if (r.users.length) parts.push(h('h3.sr-title', 'Accounts'), h('div.user-list', r.users.map((u) => userRow(u))));
        if (r.hashtags.length) parts.push(h('h3.sr-title', 'Hashtags'), h('div.tag-list', r.hashtags.map(tagRow)));
        if (r.videos.length) parts.push(h('h3.sr-title', 'Videos'), videoGrid(r.videos));
      } else if (t === 'users') { if (r.users.length) parts.push(h('div.user-list', r.users.map((u) => userRow(u)))); }
      else if (t === 'videos') { if (r.videos.length) parts.push(videoGrid(r.videos)); }
      else if (r.hashtags.length) parts.push(h('div.tag-list', r.hashtags.map(tagRow)));
      results.replaceChildren(...(parts.length ? parts : [emptyState({ iconName: 'search', title: 'No results found', text: `Nothing matched “${q}”. Try different keywords.` })]));
    } catch (e) { results.replaceChildren(errorState(e, () => load(t))); }
  }

  const bar = tabs([
    { value: 'top', label: 'Top' }, { value: 'users', label: 'Accounts' }, { value: 'videos', label: 'Videos' }, { value: 'hashtags', label: 'Hashtags' },
  ], type, (t) => { history.replaceState({}, '', `/search?q=${encodeURIComponent(q)}&type=${t}`); load(t); });
  load(type);
  return { el: h('div.search-page', h('div.ex-search', box), q ? bar : null, results), title: q ? `“${q}”` : 'Search' };
}
