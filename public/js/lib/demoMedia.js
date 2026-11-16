// Generates placeholder demo videos in the browser (canvas animation -> MediaRecorder) and uploads
// them via the admin-only endpoint. Lets you populate the feed without any external media.
import { api } from './api.js';

const SCENES = [
  { name: 'Sunset Vibes', caption: 'Golden hour hits different #sunset #aesthetic #fyp', hue: 20 },
  { name: 'Neon Dreams', caption: 'POV: you found the neon side of the city #neon #citylife #fyp', hue: 300 },
  { name: 'Ocean Calm', caption: 'Take a breath with me #relax #ocean #mindfulness', hue: 195 },
  { name: 'Dance Break', caption: 'New choreo just dropped try it with @maya.moves #dance #challenge', hue: 330 },
  { name: 'Quick Recipe', caption: '60 second pasta that changed my life #recipe #foodtok #cooking', hue: 40 },
  { name: 'Code Tips', caption: 'Stop writing loops like this #coding #programming #techtips', hue: 140 },
  { name: 'Travel Diary', caption: 'Day 12 in the mountains #travel #wanderlust #adventure', hue: 210 },
  { name: 'Workout', caption: '5 minute no-equipment burner #fitness #workout #homeworkout', hue: 0 },
  { name: 'Pixel Art', caption: 'Animating a tiny pixel world, frame by frame #pixelart #art #animation', hue: 260 },
  { name: 'Comedy Skit', caption: 'When the group project is due tomorrow #comedy #relatable #fyp', hue: 55 },
  { name: 'Plant Care', caption: 'My monstera finally gave me a new leaf #plants #plantmom #houseplants', hue: 110 },
  { name: 'Beat Making', caption: 'Made a beat using only kitchen sounds #music #producer #beats', hue: 280 },
];

function pickMime() {
  const opts = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4'];
  return opts.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

function drawScene(ctx, w, hgt, t, scene, variant) {
  const g = ctx.createLinearGradient(0, 0, w * Math.cos(t * 0.3), hgt);
  g.addColorStop(0, `hsl(${scene.hue + Math.sin(t) * 20}, 85%, 55%)`);
  g.addColorStop(1, `hsl(${scene.hue + 60}, 75%, 22%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, hgt);
  if (variant % 3 === 0) {
    for (let i = 0; i < 14; i++) {
      const x = (w / 2) + Math.sin(t * 1.3 + i) * (w * 0.35) * Math.cos(i);
      const y = (hgt / 2) + Math.cos(t * 0.9 + i * 1.7) * (hgt * 0.35);
      ctx.beginPath();
      ctx.fillStyle = `hsla(${scene.hue + i * 18}, 90%, 70%, 0.55)`;
      ctx.arc(x, y, 18 + (i % 5) * 10 + Math.sin(t * 3 + i) * 6, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (variant % 3 === 1) {
    const bars = 18;
    for (let i = 0; i < bars; i++) {
      const bh = (Math.sin(t * 4 + i * 0.6) * 0.5 + 0.5) * hgt * 0.4 + 30;
      ctx.fillStyle = `hsla(${scene.hue + i * 8}, 95%, 75%, 0.8)`;
      ctx.fillRect(i * (w / bars) + 4, hgt * 0.72 - bh, w / bars - 8, bh);
    }
  } else {
    ctx.save();
    ctx.translate(w / 2, hgt / 2);
    for (let i = 0; i < 8; i++) {
      ctx.rotate(t * 0.4 + i * 0.1);
      ctx.strokeStyle = `hsla(${scene.hue + i * 25}, 90%, 75%, 0.7)`;
      ctx.lineWidth = 6;
      const s = 60 + i * 34 + Math.sin(t * 2) * 10;
      ctx.strokeRect(-s / 2, -s / 2, s, s);
    }
    ctx.restore();
  }
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(0, hgt * 0.18 - 60, w, 110);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.font = `bold ${Math.round(w * 0.09)}px system-ui, sans-serif`;
  ctx.fillText(scene.name, w / 2, hgt * 0.18 + 12);
  ctx.font = `${Math.round(w * 0.04)}px system-ui, sans-serif`;
  ctx.fillText('demo clip · replace me', w / 2, hgt * 0.92);
}

function recordClip(scene, variant, seconds, previewEl) {
  return new Promise((resolve, reject) => {
    const w = 540;
    const hgt = 960;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = hgt;
    canvas.className = 'demo-canvas';
    if (previewEl) previewEl.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const mime = pickMime();
    if (!mime) return reject(new Error('This browser cannot record video (MediaRecorder unsupported).'));
    const stream = canvas.captureStream(30);
    let audioCtx = null;
    try {
      audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = 220 + variant * 30;
      gain.gain.value = 0.02;
      osc.connect(gain).connect(dest);
      osc.start();
      dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    } catch { /* silent video is fine */ }
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1_500_000 });
    const chunks = [];
    let thumb = null;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (audioCtx) audioCtx.close();
      canvas.remove();
      resolve({ blob: new Blob(chunks, { type: mime.split(';')[0] }), thumb, mime: mime.split(';')[0] });
    };
    const start = performance.now();
    let raf;
    const frame = (now) => {
      const t = (now - start) / 1000;
      drawScene(ctx, w, hgt, t, scene, variant);
      if (!thumb && t > 1) canvas.toBlob((b) => { thumb = b; }, 'image/jpeg', 0.8);
      if (t < seconds) raf = requestAnimationFrame(frame);
      else { cancelAnimationFrame(raf); rec.stop(); }
    };
    rec.start(500);
    raf = requestAnimationFrame(frame);
  });
}

export async function generateDemoVideos(n, { onLog = () => {}, previewEl } = {}) {
  const { sounds } = await api.get('/sounds');
  let made = 0;
  for (let i = 0; i < n; i += 2) {
    const batch = [i, i + 1].filter((x) => x < n);
    onLog(`Recording clip${batch.length > 1 ? 's' : ''} ${batch.map((x) => x + 1).join(' & ')} of ${n}…`);
    const clips = await Promise.all(batch.map((x) => recordClip(SCENES[x % SCENES.length], x, 6, previewEl)));
    for (let k = 0; k < clips.length; k++) {
      const x = batch[k];
      const scene = SCENES[x % SCENES.length];
      const fd = new FormData();
      fd.append('video', clips[k].blob, `demo-${x}.${clips[k].mime.includes('mp4') ? 'mp4' : 'webm'}`);
      if (clips[k].thumb) fd.append('thumbnail', clips[k].thumb, `demo-${x}.jpg`);
      fd.append('caption', scene.caption);
      fd.append('duration', '6');
      fd.append('width', '540');
      fd.append('height', '960');
      if (sounds.length && Math.random() < 0.7) fd.append('soundId', String(sounds[x % sounds.length].id));
      const r = await api.upload('/admin/demo-videos', fd).promise;
      made++;
      onLog(` Uploaded “${scene.name}” as @${r.video.author.username}`);
    }
  }
  return made;
}
