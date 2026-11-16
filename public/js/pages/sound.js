// Sound page: preview the track and browse videos that use it.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { fmtCount } from '../lib/format.js';
import { emptyState } from '../components/ui.js';
import { videoGrid } from '../components/social.js';

export default async function soundPage(ctx) {
  const { sound, videos } = await api.get(`/sounds/${encodeURIComponent(ctx.params.id)}`);
  const audio = h('audio', { src: sound.url, preload: 'none', loop: true });
  const btn = h('button.collection-art.sound-art', { 'aria-label': 'Play sound', onclick: () => { if (audio.paused) audio.play(); else audio.pause(); } }, icon('play', { size: 48 }));
  audio.addEventListener('play', () => btn.replaceChildren(icon('pause', { size: 48 })));
  audio.addEventListener('pause', () => btn.replaceChildren(icon('play', { size: 48 })));
  const el = h('div.collection-page',
    h('div.collection-head', btn, audio,
      h('div', h('h1', sound.title), h('p.muted', sound.artist), h('p.muted', `${fmtCount(videos.length)} videos`),
        h('a.btn.btn-primary', { href: `/upload?sound=${sound.id}` }, icon('music', { size: 16 }), ' Use this sound'))),
    videos.length ? videoGrid(videos) : emptyState({ iconName: 'music', title: 'No videos with this sound yet', action: h('a.btn.btn-primary', { href: `/upload?sound=${sound.id}` }, 'Be the first') }));
  return { el, title: sound.title, cleanup: () => audio.pause() };
}
