// Creator analytics dashboard.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { fmtCount, timeAgo } from '../lib/format.js';
import { BRAND } from '../brand.js';
import { loadingBlock, errorState, emptyState } from '../components/ui.js';

const SOURCE_LABEL = { foryou: 'For You', following: 'Following', profile: 'Profile', search: 'Search', share: 'Shared links', other: 'Other' };

function change(cur, prev) {
  if (!prev) return cur ? h('span.delta.up', '▲ new') : h('span.delta', '—');
  const pct = Math.round(((cur - prev) / prev) * 100);
  return h(`span.delta${pct > 0 ? '.up' : pct < 0 ? '.down' : ''}`, `${pct > 0 ? '▲' : pct < 0 ? '▼' : ''} ${Math.abs(pct)}%`);
}

function barChart(daily, key, cls) {
  const max = Math.max(1, ...daily.map((d) => d[key]));
  return h('div.bar-chart.an-chart', daily.map((d) => h('div.bar-col', { title: `${new Date(d.day).toLocaleDateString()}: ${d[key]}` },
    h('div.bars', h(`div.bar.${cls}`, { style: { width: '70%', height: `${(d[key] / max) * 100}%` } })),
    daily.length <= 14 ? h('span.bar-label', new Date(d.day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })) : null)));
}

export default function analyticsPage(ctx) {
  let days = Number(ctx.query.get('days')) || 7;
  const body = h('div.stack', loadingBlock());
  const seg = h('div.seg');
  const paintSeg = () => seg.replaceChildren(...[7, 28, 60].map((d) => h(`button.seg-btn${d === days ? '.active' : ''}`, { onclick: () => { days = d; history.replaceState({}, '', `/analytics?days=${d}`); paintSeg(); load(); } }, `Last ${d} days`)));
  paintSeg();

  async function load() {
    body.replaceChildren(loadingBlock());
    try {
      const a = await api.get(`/analytics?days=${days}`);
      const card = (label, ic, key) => h('div.stat-card', icon(ic, { size: 20 }), h('b', fmtCount(a.current[key])), h('span.muted', label), change(a.current[key], a.previous[key]));
      const totalSrc = a.sources.reduce((s, x) => s + x.views, 0) || 1;
      body.replaceChildren(
        h('div.stat-grid',
          card('Video views', 'eye', 'views'), card('Likes', 'heart', 'likes'), card('Comments', 'comment', 'comments'),
          card('Shares', 'share', 'shares'), card('New followers', 'users', 'followers'), card('Views from profile', 'user', 'profileViews')),
        h('div.an-grid',
          h('section.settings-card', h('h2', 'Video views'), barChart(a.daily, 'views', 'bar-users')),
          h('section.settings-card', h('h2', 'New followers'), barChart(a.daily, 'followers', 'bar-videos')),
          h('section.settings-card', h('h2', 'Likes'), barChart(a.daily, 'likes', 'bar-users')),
          h('section.settings-card', h('h2', 'Traffic sources'),
            a.sources.length ? h('div.src-list', a.sources.map((s) => h('div.src-row', h('span', SOURCE_LABEL[s.source] || s.source),
              h('div.src-bar', h('div.src-fill', { style: { width: `${(s.views / totalSrc) * 100}%` } })), h('b', `${Math.round((s.views / totalSrc) * 100)}%`))))
              : h('p.muted', 'No views in this period yet.'))),
        h('section.settings-card', h('h2', 'Top videos'),
          a.topVideos.length ? h('div.top-videos', a.topVideos.map((v, i) => h('a.top-video', { href: `/video/${v.id}` },
            h('span.top-rank', String(i + 1)),
            h('img', { src: v.thumbUrl || BRAND.placeholderThumb, alt: '' }),
            h('div.top-info', h('div.top-cap', v.caption || '(no caption)'), h('div.muted.small', `Posted ${timeAgo(v.createdAt)}`)),
            h('div.top-stats', h('span', icon('eye', { size: 14 }), fmtCount(v.views), h('span.muted.small', ` (${fmtCount(v.totalViews)} all-time)`)),
              h('span', icon('heart', { size: 14 }), fmtCount(v.likes)), h('span', icon('comment', { size: 14 }), fmtCount(v.comments)),
              h('span.pill', `${v.engagement}% engagement`)))))
            : emptyState({ iconName: 'chart', title: 'Post a video to see analytics' })),
        h('p.muted.small', `All time: ${fmtCount(a.totals.views)} views · ${fmtCount(a.totals.likes)} likes · ${fmtCount(a.totals.followers)} followers · ${a.totals.videos} videos. Views are counted after 2 seconds of watching; your own views are excluded.`));
    } catch (e) { body.replaceChildren(errorState(e, load)); }
  }
  load();
  return { el: h('div.admin-page', h('div.page-head', h('h1.page-title', icon('chart', { size: 28 }), ' Creator analytics'), seg), body), title: 'Analytics' };
}
