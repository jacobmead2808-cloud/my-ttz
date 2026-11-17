// Duet & Stitch studio. Composes the original video with your camera or a clip from your device on a
// canvas and records the result in the browser (MediaRecorder), then hands it to the upload page.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { fmtDuration } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { toast, toastError, emptyState } from '../components/ui.js';
import { stopStream } from '../lib/livestream.js';
import { setPendingUpload } from '../lib/pendingUpload.js';
import { filterCss } from '../lib/videoFx.js';

const W = 720;
const H = 1280;

function drawContain(ctx, el, x, y, w, hh, filter = 'none') {
  const vw = el.videoWidth || el.width;
  const vh = el.videoHeight || el.height;
  if (!vw || !vh) return;
  const s = Math.min(w / vw, hh / vh);
  const dw = vw * s;
  const dh = vh * s;
  ctx.filter = filter;
  ctx.drawImage(el, x + (w - dw) / 2, y + (hh - dh) / 2, dw, dh);
  ctx.filter = 'none';
}

function drawCover(ctx, el, x, y, w, hh, filter = 'none') {
  const vw = el.videoWidth || el.width;
  const vh = el.videoHeight || el.height;
  if (!vw || !vh) return;
  const s = Math.max(w / vw, hh / vh);
  const sw = w / s;
  const sh = hh / s;
  ctx.filter = filter;
  ctx.drawImage(el, (vw - sw) / 2, (vh - sh) / 2, sw, sh, x, y, w, hh);
  ctx.filter = 'none';
}

function pickMime() {
  const opts = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return opts.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

export default async function remixPage(ctx) {
  const type = ctx.query.get('type') === 'stitch' ? 'stitch' : 'duet';
  let video;
  try { ({ video } = await api.get(`/videos/${encodeURIComponent(ctx.params.id)}`)); } catch (e) {
    return { title: 'Unavailable', el: emptyState({ iconName: 'lock', title: 'Video unavailable', text: e.message }) };
  }
  if (!video.allowRemix && !video.isOwner) {
    return { title: 'Not allowed', el: emptyState({ iconName: 'block', title: `${type === 'duet' ? 'Duets' : 'Stitches'} are turned off`, text: 'The creator doesn’t allow remixes of this video.' }) };
  }

  const original = h('video', { src: video.videoUrl, playsInline: true, preload: 'auto', crossOrigin: 'anonymous' });
  original.muted = false;
  const canvas = h('canvas.remix-canvas', { width: W, height: H });
  const c2d = canvas.getContext('2d');
  let source = null; // { kind, el, stream }
  let raf = 0;
  let recording = null;
  let audioCtx = null;
  let phase = 'preview';
  const origStart = video.trimStart || 0;
  let stitchLen = 5;

  const status = h('div.remix-status', 'Choose your side: your camera or a clip from your device.');
  const timer = h('span.remix-timer', '0:00');

  async function useSource(kind) {
    stopSource();
    try {
      if (kind === 'camera') {
        if (!navigator.mediaDevices) throw new Error('Camera access needs https or localhost.');
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 720 }, height: { ideal: 1280 }, facingMode: 'user' }, audio: { echoCancellation: true } });
        const el = h('video', { autoplay: true, playsInline: true, muted: true });
        el.srcObject = stream;
        await el.play();
        source = { kind, el, stream, mirror: true };
      } else {
        const input = h('input', { type: 'file', accept: 'video/*' });
        const f = await new Promise((res) => { input.onchange = () => res(input.files[0]); input.click(); });
        if (!f) return;
        const el = h('video', { src: URL.createObjectURL(f), playsInline: true, preload: 'auto' });
        await new Promise((res, rej) => { el.onloadeddata = res; el.onerror = () => rej(new Error('Could not read that video')); });
        source = { kind: 'file', el };
      }
      status.textContent = type === 'duet' ? 'Ready. Recording plays the original alongside you.' : `Ready. The first ${stitchLen}s of the original play, then your part.`;
      recBtn.disabled = false;
      paintSources();
    } catch (e) {
      toastError(e.name === 'NotAllowedError' ? new Error('Camera permission denied. Allow camera access, or use a clip from your device.') : e);
    }
  }

  function stopSource() {
    if (!source) return;
    if (source.stream) stopStream(source.stream);
    if (source.kind === 'file') { source.el.pause(); URL.revokeObjectURL(source.el.src); }
    source = null;
  }

  function draw() {
    c2d.fillStyle = '#0b0b12';
    c2d.fillRect(0, 0, W, H);
    const of = filterCss(video.filter);
    if (type === 'duet') {
      drawContain(c2d, original, 0, 0, W / 2, H, of);
      if (source) {
        if (source.mirror) { c2d.save(); c2d.translate(W, 0); c2d.scale(-1, 1); drawContain(c2d, source.el, 0, 0, W / 2, H); c2d.restore(); }
        else drawContain(c2d, source.el, W / 2, 0, W / 2, H);
      }
      c2d.fillStyle = 'rgba(255,255,255,.15)';
      c2d.fillRect(W / 2 - 1, 0, 2, H);
    } else if (phase === 'stitch-original' || (!source && phase === 'preview')) {
      drawCover(c2d, original, 0, 0, W, H, of);
      c2d.fillStyle = 'rgba(0,0,0,.45)';
      c2d.fillRect(24, 24, 300, 56);
      c2d.fillStyle = '#fff';
      c2d.font = 'bold 26px system-ui, sans-serif';
      c2d.fillText(`Stitch with @${video.author.username}`, 40, 62);
    } else if (source) {
      if (source.mirror) { c2d.save(); c2d.translate(W, 0); c2d.scale(-1, 1); drawCover(c2d, source.el, 0, 0, W, H); c2d.restore(); }
      else drawCover(c2d, source.el, 0, 0, W, H);
    }
    raf = requestAnimationFrame(draw);
  }

  async function record() {
    if (!source || recording) return;
    const mime = pickMime();
    if (!mime) return toastError(new Error('This browser cannot record video.'));
    audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    const origNode = audioCtx.createMediaElementSource(original);
    origNode.connect(dest);
    origNode.connect(audioCtx.destination);
    if (source.stream && source.stream.getAudioTracks().length) audioCtx.createMediaStreamSource(source.stream).connect(dest);
    if (source.kind === 'file') { const n = audioCtx.createMediaElementSource(source.el); n.connect(dest); n.connect(audioCtx.destination); }
    const out = canvas.captureStream(30);
    dest.stream.getAudioTracks().forEach((t) => out.addTrack(t));
    const chunks = [];
    const rec = new MediaRecorder(out, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const started = Date.now();
    const tick = setInterval(() => { timer.textContent = fmtDuration((Date.now() - started) / 1000); if (Date.now() - started > 60000) finish(); }, 250);
    recording = { rec, tick };
    rec.onstop = () => {
      clearInterval(tick);
      const blob = new Blob(chunks, { type: mime.split(';')[0] });
      const ext = mime.includes('mp4') ? 'mp4' : 'webm';
      setPendingUpload({
        file: new File([blob], `${type}-${video.id}.${ext}`, { type: blob.type }),
        remixOf: video.id, remixType: type, username: video.author.username,
        caption: `#${type} with @${video.author.username} `,
      });
      cleanupMedia();
      navigate('/upload');
    };
    rec.start(500);
    recBtn.classList.add('recording');
    recBtn.replaceChildren(h('span.rec-dot'), 'Stop');
    original.currentTime = origStart;
    if (type === 'duet') {
      status.textContent = 'Recording… it stops when the original ends.';
      if (source.kind === 'file') { source.el.currentTime = 0; source.el.play(); }
      original.onended = finish;
      const end = video.trimEnd;
      if (end) original.ontimeupdate = () => { if (original.currentTime >= end) finish(); };
      await original.play();
    } else {
      phase = 'stitch-original';
      status.textContent = `Playing ${stitchLen}s of the original…`;
      await original.play();
      setTimeout(() => {
        original.pause();
        phase = 'stitch-you';
        status.textContent = source.kind === 'file' ? 'Recording your clip…' : 'Your turn! Tap Stop when you’re done.';
        if (source.kind === 'file') { source.el.currentTime = 0; source.el.onended = finish; source.el.play(); }
      }, stitchLen * 1000);
    }
  }

  function finish() {
    if (!recording) return;
    original.pause();
    if (source && source.kind === 'file') source.el.pause();
    recording.rec.stop();
  }

  function cleanupMedia() {
    cancelAnimationFrame(raf);
    original.pause();
    stopSource();
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
  }

  const srcBtns = h('div.seg');
  function paintSources() {
    srcBtns.replaceChildren(...[['camera', 'camera', 'Camera'], ['file', 'upload', 'From device']].map(([k, ic, label]) =>
      h(`button.seg-btn${source && (source.kind === k) ? '.active' : ''}`, { type: 'button', onclick: () => useSource(k) }, icon(ic, { size: 16 }), ' ', label)));
  }
  paintSources();

  const recBtn = h('button.btn.btn-primary.btn-lg.rec-btn', { disabled: true, onclick: () => (recording ? finish() : record()) }, h('span.rec-dot'), 'Record');
  const lenSel = type === 'stitch' ? h('label.field', h('span.label', 'Length of the original to include'),
    h('div.seg', [1, 2, 3, 4, 5].map((n) => h(`button.seg-btn${n === stitchLen ? '.active' : ''}`, { type: 'button', onclick: (e) => {
      stitchLen = n; e.currentTarget.parentNode.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active')); e.currentTarget.classList.add('active');
    } }, `${n}s`)))) : null;

  original.addEventListener('loadeddata', () => { original.currentTime = origStart; });
  raf = requestAnimationFrame(draw);

  const el = h('div.remix-page',
    h('div.remix-stage', canvas, h('div.remix-top', h('span.live-badge', type === 'duet' ? 'DUET' : 'STITCH'), timer)),
    h('div.remix-panel',
      h('h1', type === 'duet' ? 'Duet' : 'Stitch', h('span.muted', ` with @${video.author.username}`)),
      h('p.muted', type === 'duet' ? 'Record yourself side-by-side with this video.' : 'Clip up to 5 seconds of this video, then add your own take.'),
      h('span.label', 'Your side'), srcBtns, lenSel, status, recBtn,
      h('p.muted.small', 'Recording happens in your browser. When you stop, you’ll go to the editor to add a caption, filter and captions before posting.'),
      h('button.btn.btn-ghost', { onclick: () => history.back() }, 'Cancel')));
  return { el, title: type === 'duet' ? 'Duet' : 'Stitch', cleanup: () => { if (recording) { recording.rec.onstop = null; recording.rec.stop(); clearInterval(recording.tick); } cleanupMedia(); } };
}
