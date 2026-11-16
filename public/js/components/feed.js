// Vertical, snap-scrolling feed with autoplay/pause via IntersectionObserver and infinite loading.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { spinner, errorState } from './ui.js';
import { videoItem } from './videoItem.js';

/**
 * fetchPage(state) => Promise<{ videos, hasMore }> where state = { ids: number[], last: video|null }
 * Returns an element with .cleanup()
 */
export function feed(fetchPage, { empty, header, source = 'other' } = {}) {
  const items = [];
  const ids = new Set();
  let loading = false;
  let done = false;
  let activeIdx = -1;

  const scroller = h('div.feed', { tabindex: 0, 'aria-label': 'Video feed' });
  const status = h('div.feed-status');
  const upBtn = h('button.feed-nav-btn', { 'aria-label': 'Previous video', onclick: () => go(-1) }, icon('chevronUp'));
  const downBtn = h('button.feed-nav-btn', { 'aria-label': 'Next video', onclick: () => go(1) }, icon('chevronDown'));
  const wrap = h('div.feed-wrap', header || null, scroller, h('div.feed-nav', upBtn, downBtn));
  scroller.appendChild(status);

  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const idx = items.findIndex((it) => it.el === en.target);
      if (idx < 0) continue;
      if (en.isIntersecting && en.intersectionRatio >= 0.6) setActive(idx);
      else if (items[idx].isActive && en.intersectionRatio < 0.6) items[idx].deactivate();
    }
  }, { root: scroller, threshold: [0, 0.6, 1] });

  function setActive(idx) {
    if (idx === activeIdx && items[idx].isActive) return;
    items.forEach((it, i) => { if (i !== idx && it.isActive) it.deactivate(); });
    activeIdx = idx;
    items[idx].activate();
    // keep decoders bounded: preload neighbours, unload far-away items
    items.forEach((it, i) => {
      if (Math.abs(i - idx) === 1) it.preload();
      else if (Math.abs(i - idx) > 3) it.unload();
    });
    upBtn.disabled = idx <= 0;
    downBtn.disabled = idx >= items.length - 1 && done;
    if (items.length - idx <= 3) loadMore();
  }

  function go(delta) {
    const target = items[Math.max(0, Math.min(items.length - 1, activeIdx + delta))];
    if (target) target.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function onKey(e) {
    if (e.target.closest('input, textarea, select, [contenteditable]') || document.body.classList.contains('modal-open')) return;
    if (document.querySelector('.drawer-overlay')) return;
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); go(-1); }
    else if (e.key === ' ' && items[activeIdx]) { e.preventDefault(); items[activeIdx].togglePlay(); }
    else if (e.key === 'l' && items[activeIdx]) items[activeIdx].toggleLike();
  }
  document.addEventListener('keydown', onKey);

  function remove(video) {
    const idx = items.findIndex((it) => it.video.id === video.id);
    if (idx < 0) return;
    const [it] = items.splice(idx, 1);
    io.unobserve(it.el);
    it.destroy();
    it.el.remove();
    if (activeIdx >= items.length) activeIdx = items.length - 1;
    if (!items.length) showEmpty();
  }

  function showEmpty() {
    status.replaceChildren(empty || h('div.empty-state', h('h3', 'No videos yet')));
    status.className = 'feed-status feed-status-full';
  }

  async function loadMore() {
    if (loading || done) return;
    loading = true;
    status.className = items.length ? 'feed-status' : 'feed-status feed-status-full';
    status.replaceChildren(spinner());
    try {
      const r = await fetchPage({ ids: [...ids], last: items.length ? items[items.length - 1].video : null });
      const fresh = r.videos.filter((v) => !ids.has(v.id));
      const wasEmpty = !items.length;
      fresh.forEach((v) => {
        ids.add(v.id);
        const el = videoItem(v, { onRemoved: remove, source });
        scroller.insertBefore(el, status);
        items.push(el.api);
        io.observe(el);
      });
      done = !r.hasMore || !fresh.length;
      // Scroll-snap would otherwise stay locked onto the loading indicator below the new items.
      if (wasEmpty && items.length) { status.className = 'feed-status'; scroller.scrollTop = 0; requestAnimationFrame(() => { scroller.scrollTop = 0; }); }
      if (!items.length) showEmpty();
      else if (done) { status.className = 'feed-status feed-end'; status.replaceChildren(h('p.muted', "You're all caught up")); }
      else status.replaceChildren();
    } catch (e) {
      status.className = items.length ? 'feed-status' : 'feed-status feed-status-full';
      status.replaceChildren(errorState(e, () => { loading = false; loadMore(); }));
    } finally {
      loading = false;
    }
  }

  // Pause when the tab is hidden.
  const onVis = () => {
    const it = items[activeIdx];
    if (!it) return;
    if (document.hidden) it.suspend(); else it.activate();
  };
  document.addEventListener('visibilitychange', onVis);

  loadMore();
  wrap.cleanup = () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
    io.disconnect();
    items.forEach((it) => it.destroy());
  };
  setTimeout(() => scroller.focus({ preventScroll: true }), 50);
  return wrap;
}
