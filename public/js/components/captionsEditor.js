// Timed captions editor. Works against a <video> element for "add at current time" and preview.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { fmtDuration } from '../lib/format.js';
import { linesToVtt, vttToLines } from '../lib/videoFx.js';

export function captionsEditor(videoEl, initialVtt = '', { onChange } = {}) {
  let lines = vttToLines(initialVtt);
  const list = h('div.cc-list');
  const changed = () => { onChange && onChange(linesToVtt(lines)); paint(); };

  function paint() {
    list.replaceChildren(...(lines.length ? lines.map((l, i) => {
      const start = h('input.input.input-sm.cc-time', { type: 'number', step: '0.1', min: 0, value: l.start.toFixed(1), 'aria-label': 'Start (seconds)' });
      const end = h('input.input.input-sm.cc-time', { type: 'number', step: '0.1', min: 0, value: l.end.toFixed(1), 'aria-label': 'End (seconds)' });
      const text = h('input.input.input-sm.cc-text', { value: l.text, maxlength: 120, placeholder: 'Caption text' });
      start.addEventListener('change', () => { l.start = Number(start.value) || 0; changed(); });
      end.addEventListener('change', () => { l.end = Number(end.value) || l.start + 2; changed(); });
      text.addEventListener('input', () => { l.text = text.value; onChange && onChange(linesToVtt(lines)); });
      return h('div.cc-row',
        h('button.icon-btn.sm', { type: 'button', title: 'Jump here', onclick: () => { if (videoEl) videoEl.currentTime = l.start; } }, icon('play', { size: 14 })),
        start, h('span.muted', '→'), end, text,
        h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Remove line', onclick: () => { lines.splice(i, 1); changed(); } }, icon('trash', { size: 14 })));
    }) : [h('p.muted.small', 'No captions yet. Play the video and press “Add line” at each moment someone speaks.')]));
  }

  const add = h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: () => {
    const t = videoEl ? videoEl.currentTime || 0 : 0;
    lines.push({ start: Math.round(t * 10) / 10, end: Math.round((t + 2.5) * 10) / 10, text: '' });
    changed();
    setTimeout(() => { const inputs = list.querySelectorAll('.cc-text'); inputs[inputs.length - 1]?.focus(); }, 0);
  } }, icon('plus', { size: 14 }), ' Add line at ', h('span.cc-now', '0:00'));
  if (videoEl) videoEl.addEventListener('timeupdate', () => { add.querySelector('.cc-now').textContent = fmtDuration(videoEl.currentTime); });

  paint();
  const el = h('div.cc-editor', list, h('div.row.gap', add));
  el.getVtt = () => linesToVtt(lines);
  el.setVtt = (vtt) => { lines = vttToLines(vtt); paint(); };
  return el;
}
