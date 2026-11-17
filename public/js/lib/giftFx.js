// Gift effects for LIVE: every gift gets a visible presentation that scales with its value.
//   tier 1  "float"     small artwork drifts up the right side
//   tier 2  "pop"       artwork pops in beside the chat with a short chime
//   tier 3  "burst"     artwork in the centre with a radial particle burst
//   tier 4  "takeover"  dimmed screen, large artwork, particle rain and a sender banner
//   tier 5  "legendary" full-screen show with orbit rings, shockwave and a longer sound
// Big effects play one at a time, most valuable first; repeats from the same sender are grouped into
// combos. Particles run on a single canvas, pause in background tabs, and are disabled for
// prefers-reduced-motion. Sounds are synthesised (no audio files) and can be muted.
import { h } from './dom.js';

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const SOUND_KEY = 'giftSound';
const PALETTE = { 1: ['#ffffff', '#fde68a'], 2: ['#7dd3fc', '#ffffff', '#fde68a'], 3: ['#fde047', '#f59e0b', '#ffffff', '#38bdf8'], 4: ['#5eead4', '#38bdf8', '#a7f3d0', '#ffffff'], 5: ['#fde68a', '#fbbf24', '#7dd3fc', '#ffffff', '#5eead4'] };
const EFFECT_MS = { pop: 1500, burst: 2400, takeover: 3800, legendary: 5600 };

export const soundEnabled = () => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; } };
export const setSoundEnabled = (on) => { try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* private mode */ } };

// ---------- sound ----------
let audio = null;
function ctx() {
  if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; } }
  if (audio && audio.state === 'suspended') audio.resume().catch(() => {});
  return audio;
}
function tone(ac, freq, start, dur, { type = 'sine', gain = 0.06 } = {}) {
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, ac.currentTime + start);
  g.gain.linearRampToValueAtTime(gain, ac.currentTime + start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + start + dur);
  o.connect(g).connect(ac.destination);
  o.start(ac.currentTime + start);
  o.stop(ac.currentTime + start + dur + 0.05);
}
const SOUNDS = {
  1: (ac) => tone(ac, 880, 0, 0.18, { gain: 0.035 }),
  2: (ac) => { tone(ac, 784, 0, 0.25); tone(ac, 1175, 0.09, 0.3); },
  3: (ac) => [659, 784, 988, 1319].forEach((f, i) => tone(ac, f, i * 0.07, 0.4, { type: 'triangle' })),
  4: (ac) => { [523, 659, 784].forEach((f) => tone(ac, f, 0, 1.2, { type: 'triangle', gain: 0.04 })); [1047, 1319, 1568, 2093].forEach((f, i) => tone(ac, f, 0.25 + i * 0.08, 0.6, { gain: 0.04 })); },
  5: (ac) => {
    [[392, 494, 587], [440, 554, 659], [523, 659, 784]].forEach((chord, i) => chord.forEach((f) => tone(ac, f, i * 0.45, 1.1, { type: 'triangle', gain: 0.035 })));
    [1568, 1760, 2093, 2637].forEach((f, i) => tone(ac, f, 1.3 + i * 0.09, 0.8, { gain: 0.03 }));
  },
};
function playSound(tier) {
  if (!soundEnabled()) return;
  const ac = ctx();
  if (ac) try { SOUNDS[Math.min(Math.max(tier, 1), 5)](ac); } catch { /* audio unavailable */ }
}

// ---------- particles ----------
function particleCanvas(host) {
  const canvas = h('canvas.gfx-canvas', { 'aria-hidden': 'true' });
  host.appendChild(canvas);
  const c2d = canvas.getContext('2d');
  const parts = [];
  const max = matchMedia('(max-width: 720px)').matches ? 140 : 260;
  let raf = 0;
  let w = 0; let hgt = 0; let dpr = 1;
  const resize = () => {
    const r = host.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = r.width; hgt = r.height;
    canvas.width = Math.max(1, Math.round(w * dpr)); canvas.height = Math.max(1, Math.round(hgt * dpr));
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();
  let last = 0;
  const frame = (t) => {
    const dt = Math.min(0.05, (t - (last || t)) / 1000);
    last = t;
    c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    c2d.clearRect(0, 0, w, hgt);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life -= dt;
      if (p.life <= 0) { parts.splice(i, 1); continue; }
      p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      const a = Math.min(1, p.life / p.fade);
      c2d.globalAlpha = a;
      c2d.fillStyle = p.color;
      c2d.save();
      c2d.translate(p.x, p.y);
      c2d.rotate(p.rot);
      if (p.shape === 'star') {
        c2d.beginPath();
        for (let k = 0; k < 8; k++) { const r = k % 2 ? p.size * 0.4 : p.size; const ang = (k * Math.PI) / 4; c2d.lineTo(Math.cos(ang) * r, Math.sin(ang) * r); }
        c2d.closePath(); c2d.fill();
      } else if (p.shape === 'rect') c2d.fillRect(-p.size, -p.size / 2.5, p.size * 2, p.size / 1.25);
      else { c2d.beginPath(); c2d.arc(0, 0, p.size, 0, Math.PI * 2); c2d.fill(); }
      c2d.restore();
    }
    c2d.globalAlpha = 1;
    raf = parts.length && !document.hidden ? requestAnimationFrame(frame) : 0;
    if (!raf) { last = 0; c2d.clearRect(0, 0, w, hgt); }
  };
  const kick = () => { if (!raf && !document.hidden) raf = requestAnimationFrame(frame); };
  const add = (p) => { if (parts.length < max) parts.push(p); };
  return {
    burst(cx, cy, n, colors, { speed = 260, spread = Math.PI * 2, angle = 0, g = 140, life = 1.6, shapes = ['circle', 'star', 'rect'] } = {}) {
      for (let i = 0; i < n; i++) {
        const a = angle + (Math.random() - 0.5) * spread;
        const s = speed * (0.35 + Math.random() * 0.75);
        add({ x: cx, y: cy, vx: Math.cos(a) * s, vy: Math.sin(a) * s, g, life: life * (0.6 + Math.random() * 0.6), fade: 0.5,
          size: 2 + Math.random() * 4, color: colors[i % colors.length], shape: shapes[i % shapes.length], rot: Math.random() * 6, vr: (Math.random() - 0.5) * 8 });
      }
      kick();
    },
    rain(n, colors, { life = 3 } = {}) {
      for (let i = 0; i < n; i++) {
        add({ x: Math.random() * w, y: -20 - Math.random() * hgt * 0.5, vx: (Math.random() - 0.5) * 40, vy: 120 + Math.random() * 160, g: 40, life: life * (0.6 + Math.random() * 0.5), fade: 0.6,
          size: 2 + Math.random() * 3.5, color: colors[i % colors.length], shape: i % 3 ? 'rect' : 'star', rot: Math.random() * 6, vr: (Math.random() - 0.5) * 6 });
      }
      kick();
    },
    size: () => ({ w, h: hgt }),
    destroy() { cancelAnimationFrame(raf); ro.disconnect(); canvas.remove(); },
  };
}

// ---------- the effects layer ----------
export function createGiftFx(host) {
  const lane = h('div.gfx-lane', { 'aria-live': 'polite' });
  const floats = h('div.gfx-floats', { 'aria-hidden': 'true' });
  const stage = h('div.gfx-stage', { 'aria-hidden': 'true' });
  host.append(lane, floats, stage);
  const particles = particleCanvas(host);
  const combos = new Map();
  const queue = [];
  let playing = false;
  let destroyed = false;
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (!destroyed) fn(); }, ms); timers.add(t); return t; };
  const art = (g, cls = '') => h(`img.gfx-art${cls}`, { src: g.art, alt: '', draggable: false });

  function comboPill(m) {
    const key = `${m.user.id}:${m.gift.id}`;
    let c = combos.get(key);
    if (c) {
      c.count += m.count;
      c.countEl.textContent = `×${c.count}`;
      c.el.classList.remove('bump'); void c.el.offsetWidth; c.el.classList.add('bump');
      clearTimeout(c.t);
    } else {
      const countEl = h('b.gfx-count', `×${m.count}`);
      const el = h(`div.gfx-pill.t${m.gift.tier}`,
        m.user.avatarUrl ? h('img.gfx-avatar', { src: m.user.avatarUrl, alt: '' }) : h('span.gfx-avatar.gfx-initial', (m.user.displayName || m.user.username || '?')[0].toUpperCase()),
        h('div.gfx-who', h('b', m.user.displayName || m.user.username), h('span', `sent ${m.gift.name}`)),
        art(m.gift, '.gfx-pill-art'), countEl);
      c = { count: m.count, el, countEl };
      combos.set(key, c);
      lane.appendChild(el);
      while (lane.children.length > 3) lane.firstChild.remove();
    }
    c.t = later(() => { c.el.classList.add('out'); later(() => c.el.remove(), 350); combos.delete(key); }, 3600 + Math.min(m.gift.tier, 5) * 400);
  }

  function floatUp(m) {
    const n = Math.min(m.count, 6);
    for (let i = 0; i < n; i++) {
      later(() => {
        const el = art(m.gift, '.gfx-float');
        el.style.setProperty('--x', `${Math.round(Math.random() * 40 - 20)}px`);
        el.style.setProperty('--r', `${Math.round(Math.random() * 40 - 20)}deg`);
        floats.appendChild(el);
        later(() => el.remove(), 2400);
      }, i * 140);
    }
  }

  function enqueue(m) {
    const prio = m.gift.tier * 1e7 + m.gift.coins * Math.min(m.count, 99);
    const same = queue.find((q) => q.user.id === m.user.id && q.gift.id === m.gift.id);
    if (same) { same.count += m.count; same.prio = prio; } else queue.push({ ...m, prio });
    queue.sort((a, b) => b.prio - a.prio);
    // Keep the queue short: drop the least valuable small effects first.
    while (queue.length > 6) queue.pop();
    if (!playing) next();
  }

  function next() {
    const m = queue.shift();
    if (!m || destroyed) { playing = false; return; }
    playing = true;
    const effect = m.gift.effect || ({ 1: 'pop', 2: 'pop', 3: 'burst', 4: 'takeover', 5: 'legendary' })[m.gift.tier];
    playSound(m.gift.tier);
    const ms = reduceMotion() ? 1800 : EFFECT_MS[effect] || 1500;
    const { w, h: hh } = particles.size();
    const colors = PALETTE[m.gift.tier] || PALETTE[3];
    const qty = m.count > 1 ? h('b.gfx-qty', `×${m.count}`) : null;
    const banner = h('div.gfx-banner', h('b', m.user.displayName || m.user.username), h('span', ` sent ${m.gift.name}`), qty,
      m.recipient ? h('span.gfx-to', ` to ${m.recipient}`) : null);
    let node;
    if (effect === 'pop') {
      node = h('div.gfx-pop', art(m.gift), qty ? h('b.gfx-qty', `×${m.count}`) : null);
    } else if (effect === 'burst') {
      node = h('div.gfx-burst', h('div.gfx-ring'), art(m.gift), banner);
      if (!reduceMotion()) later(() => particles.burst(w / 2, hh * 0.42, 70, colors, { speed: 300 }), 250);
    } else {
      node = h(`div.gfx-takeover.${effect}`, h('div.gfx-dim'), effect === 'legendary' ? h('div.gfx-orbits', h('i'), h('i'), h('i')) : null,
        h('div.gfx-shock'), art(m.gift, '.gfx-hero'), banner);
      if (!reduceMotion()) {
        later(() => particles.burst(w / 2, hh * 0.42, effect === 'legendary' ? 120 : 80, colors, { speed: effect === 'legendary' ? 420 : 340, life: 2 }), 300);
        later(() => particles.rain(effect === 'legendary' ? 120 : 70, colors, { life: 3.2 }), 700);
        if (effect === 'legendary') later(() => particles.burst(w / 2, hh * 0.42, 90, colors, { speed: 480, life: 2.2 }), 2200);
      }
    }
    if (reduceMotion()) node.classList.add('still');
    stage.appendChild(node);
    later(() => { node.classList.add('out'); later(() => { node.remove(); next(); }, 380); }, ms);
  }

  return {
    /** m: { gift: {id,name,art,coins,tier,effect}, count, user: {id,username,displayName,avatarUrl}, recipient? } */
    push(m) {
      if (destroyed || !m || !m.gift) return;
      comboPill(m);
      if (m.gift.tier <= 1 && (m.gift.effect || 'float') === 'float') { floatUp(m); playSound(1); return; }
      enqueue(m);
    },
    destroy() {
      destroyed = true;
      timers.forEach(clearTimeout);
      particles.destroy();
      lane.remove(); floats.remove(); stage.remove();
    },
  };
}
