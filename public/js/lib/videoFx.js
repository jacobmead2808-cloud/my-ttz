// Non-destructive video effects: colour filters (CSS filters) and trimming, applied at playback.
export const FILTERS = {
  vivid: { label: 'Vivid', css: 'saturate(1.6) contrast(1.1)' },
  warm: { label: 'Warm', css: 'sepia(.25) saturate(1.3) hue-rotate(-10deg)' },
  cool: { label: 'Cool', css: 'saturate(1.1) hue-rotate(18deg) brightness(1.03)' },
  mono: { label: 'B&W', css: 'grayscale(1) contrast(1.15)' },
  vintage: { label: 'Vintage', css: 'sepia(.55) contrast(.95) brightness(1.05) saturate(.9)' },
  fade: { label: 'Fade', css: 'contrast(.85) brightness(1.1) saturate(.8)' },
  drama: { label: 'Drama', css: 'contrast(1.35) saturate(1.2) brightness(.92)' },
  dream: { label: 'Dream', css: 'saturate(1.3) brightness(1.08) hue-rotate(-25deg) blur(.3px)' },
};

export const filterCss = (name) => (name && FILTERS[name] ? FILTERS[name].css : 'none');

/** Keep playback inside [trimStart, trimEnd] and loop within it. Returns an unbind function. */
export function bindTrim(videoEl, get) {
  const onTime = () => {
    const { start, end } = get();
    if (end && videoEl.currentTime >= end - 0.05) {
      videoEl.currentTime = start || 0;
      if (videoEl.paused === false) videoEl.play().catch(() => {});
    } else if (start && videoEl.currentTime < start - 0.25) videoEl.currentTime = start;
  };
  const onLoaded = () => { const { start } = get(); if (start) videoEl.currentTime = start; };
  videoEl.addEventListener('timeupdate', onTime);
  videoEl.addEventListener('loadedmetadata', onLoaded);
  return () => { videoEl.removeEventListener('timeupdate', onTime); videoEl.removeEventListener('loadedmetadata', onLoaded); };
}

// ---------- WebVTT helpers ----------
const ts = (sec) => {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(3).padStart(6, '0');
  return `${String(m).padStart(2, '0')}:${s}`;
};

export function linesToVtt(lines) {
  const body = lines.filter((l) => l.text.trim()).sort((a, b) => a.start - b.start)
    .map((l) => `${ts(l.start)} --> ${ts(Math.max(l.end, l.start + 0.5))}\n${l.text.trim()}`).join('\n\n');
  return body ? `WEBVTT\n\n${body}\n` : '';
}

export function vttToLines(vtt) {
  if (!vtt) return [];
  const parse = (t) => { const p = t.trim().split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
  const out = [];
  for (const block of vtt.replace(/\r/g, '').split(/\n\n+/)) {
    const m = block.match(/([\d:.]+)\s*-->\s*([\d:.]+)[^\n]*\n([\s\S]+)/);
    if (m) out.push({ start: parse(m[1]), end: parse(m[2]), text: m[3].trim() });
  }
  return out;
}
