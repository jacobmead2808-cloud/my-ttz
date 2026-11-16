// Clipzy LIVE Studio: eligibility gate (500+ followers / verified / good standing / trial), scene
// composer (camera, screen, screen + camera, test pattern) with on-screen text, goals, and a live
// dashboard with stats, gift feed, top gifters and moderation.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { ws } from '../lib/ws.js';
import { store } from '../lib/store.js';
import { fmtCount, fmtDuration } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { toast, toastError, confirmDialog, avatar } from '../components/ui.js';
import { liveRoom } from '../components/liveRoom.js';
import { createBroadcaster, testPatternStream, stopStream } from '../lib/livestream.js';
import { coinIcon } from '../components/coins.js';

const SIZES = { portrait: [720, 1280], landscape: [1280, 720] };

function drawCover(ctx, el, x, y, w, hh) {
  const vw = el.videoWidth;
  const vh = el.videoHeight;
  if (!vw || !vh) return;
  const s = Math.max(w / vw, hh / vh);
  const sw = w / s;
  const sh = hh / s;
  ctx.drawImage(el, (vw - sw) / 2, (vh - sh) / 2, sw, sh, x, y, w, hh);
}
function drawContain(ctx, el, x, y, w, hh) {
  const vw = el.videoWidth;
  const vh = el.videoHeight;
  if (!vw || !vh) return;
  const s = Math.min(w / vw, hh / vh);
  ctx.drawImage(el, x + (w - vw * s) / 2, y + (hh - vh * s) / 2, vw * s, vh * s);
}

function gate(elig, onTrial) {
  const checks = elig.checks.map((c) => h(`div.elig-row${c.met ? '.ok' : ''}`, h('span.elig-dot', c.met ? icon('check', { size: 12 }) : ''), h('div', h('b', c.label), c.detail ? h('div.muted.small', c.detail) : null)));
  return h('div.studio-gate',
    h('div.gate-icon', icon('live', { size: 40 })),
    h('h1', 'Unlock LIVE'),
    h('p.muted', 'Meet any one of these to go LIVE whenever you like:'),
    h('div.elig-list', checks),
    elig.banned ? h('p.form-error', 'Your LIVE access has been restricted by a moderator.')
      : elig.trial.available ? h('div.trial-card', h('b', 'Try LIVE now'), h('p.small', `New here? We’ll give you the benefit of the doubt: a ${elig.trial.minutes}-minute trial LIVE. Be kind and keep it safe — good behaviour unlocks LIVE for good.`),
        h('button.btn.btn-primary', { onclick: onTrial }, `Start a ${elig.trial.minutes}-min trial`))
        : h('p.muted.small', elig.trial.reason ? `Trial: ${elig.trial.reason}${elig.trial.nextAt ? ` (next one ${new Date(elig.trial.nextAt).toLocaleDateString()})` : ''}.` : ''),
    h('a.btn.btn-ghost', { href: '/live' }, 'Watch LIVE instead'));
}

export default async function liveStudio() {
  const elig = await api.get('/live/eligibility');
  let trialMode = false;
  const root = h('div.studio-root');
  if (!elig.eligible) {
    if (elig.banned || !elig.trial.available) return { title: 'Go LIVE', el: h('div.studio-page.gated', gate(elig, () => {})) };
    root.appendChild(gate(elig, () => { trialMode = true; root.replaceChildren(); build(); }));
    const page = h('div.studio-page.gated', root);
    return { title: 'Go LIVE', el: page, cleanup: () => cleanup && cleanup() };
  }
  let cleanup = null;
  build();
  return { title: 'LIVE Studio', el: h('div.studio-page', root), cleanup: () => cleanup && cleanup() };

  function build() {
    let scene = 'camera';
    let orientation = 'portrait';
    let cam = null; // MediaStream
    let screen = null; // MediaStream
    let live = null;
    let startedAt = 0;
    let raf = 0;
    let giftCoins = 0;
    let audioCtx = null;
    const subs = [];
    const camEl = h('video', { autoplay: true, muted: true, playsInline: true });
    const screenEl = h('video', { autoplay: true, muted: true, playsInline: true });
    const canvas = h('canvas.studio-canvas', { width: 720, height: 1280 });
    const ctx = canvas.getContext('2d');
    const overlayIn = h('input.input', { maxlength: 60, placeholder: 'On-screen text (optional), e.g. “Q&A — ask me anything!”' });
    const title = h('input.input', { maxlength: 80, value: `${store.me.displayName}'s LIVE` });
    const goalType = h('select.input', h('option', { value: '' }, 'No goal'), h('option', { value: 'likes' }, 'Likes goal'), h('option', { value: 'gifts' }, 'Gift goal (coins)'), h('option', { value: 'followers' }, 'New followers goal'));
    const goalTarget = h('input.input', { type: 'number', min: 1, value: 1000, placeholder: 'Target' });
    const goalLabel = h('input.input', { maxlength: 40, placeholder: 'Goal name (e.g. New mic)' });
    const errorEl = h('div.form-error.hidden', { role: 'alert' });

    // ----- compositor -----
    function draw() {
      const [W, H] = SIZES[orientation];
      if (canvas.width !== W) { canvas.width = W; canvas.height = H; }
      ctx.fillStyle = '#0d0d12';
      ctx.fillRect(0, 0, W, H);
      if (!cam && !screen) {
        ctx.fillStyle = 'rgba(255,255,255,.55)';
        ctx.font = `600 ${Math.round(W * 0.04)}px system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('', W / 2, H / 2);
        raf = requestAnimationFrame(draw);
        return;
      }
      const main = scene === 'screen' || scene === 'pip' ? screenEl : camEl;
      if (scene === 'screen' || scene === 'pip') drawContain(ctx, main, 0, 0, W, H); else drawCover(ctx, main, 0, 0, W, H);
      if (scene === 'pip' && camEl.videoWidth) {
        const d = Math.round(Math.min(W, H) * 0.32);
        const x = W - d - 24;
        const y = H - d - 24;
        ctx.save();
        ctx.beginPath(); ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
        drawCover(ctx, camEl, x, y, d, d);
        ctx.restore();
        ctx.lineWidth = 6; ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2); ctx.stroke();
      }
      const text = overlayIn.value.trim();
      if (text) {
        ctx.font = `bold ${Math.round(W * 0.045)}px system-ui, sans-serif`;
        const tw = ctx.measureText(text).width + 40;
        ctx.fillStyle = 'rgba(17, 19, 24, .78)';
        ctx.beginPath(); ctx.roundRect((W - tw) / 2, Math.round(H * 0.08), tw, Math.round(W * 0.075), 16); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(text, W / 2, Math.round(H * 0.08) + Math.round(W * 0.0375));
      }
      raf = requestAnimationFrame(draw);
    }

    let camId = '';
    let micId = '';
    async function getCam(force = false) {
      if (cam && !force) return cam;
      if (cam) stopStream(cam);
      cam = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...(camId ? { deviceId: { exact: camId } } : { facingMode: 'user' }) },
        audio: { echoCancellation: true, noiseSuppression: true, ...(micId ? { deviceId: { exact: micId } } : {}) },
      });
      camEl.srcObject = cam;
      fillDevices();
      return cam;
    }
    const camSel = h('select.input.input-sm');
    const micSel = h('select.input.input-sm');
    async function fillDevices() {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        const opts = (kind, sel, current) => sel.replaceChildren(...list.filter((d) => d.kind === kind).map((d, i) =>
          h('option', { value: d.deviceId, selected: d.deviceId === current }, d.label || `${kind === 'videoinput' ? 'Camera' : 'Microphone'} ${i + 1}`)));
        const vt = cam && cam.getVideoTracks()[0];
        const at = cam && cam.getAudioTracks()[0];
        opts('videoinput', camSel, camId || (vt && vt.getSettings().deviceId));
        opts('audioinput', micSel, micId || (at && at.getSettings().deviceId));
        devicesRow.classList.toggle('hidden', !cam || cam.stopPattern);
      } catch { /* ignore */ }
    }
    camSel.addEventListener('change', async () => { camId = camSel.value; try { await getCam(true); if (live) rebuildAudio(); paintReady(); } catch (e) { toastError(e); } });
    micSel.addEventListener('change', async () => { micId = micSel.value; try { await getCam(true); if (live) rebuildAudio(); paintReady(); } catch (e) { toastError(e); } });
    const devicesRow = h('div.device-row.hidden', h('label.field', h('span.small.muted', 'Camera'), camSel), h('label.field', h('span.small.muted', 'Microphone'), micSel));
    async function useScene(k) {
      errorEl.classList.add('hidden');
      try {
        if (k === 'test') {
          if (cam) stopStream(cam);
          cam = testPatternStream(`@${store.me.username}`);
          camEl.srcObject = cam;
        } else {
          if (!navigator.mediaDevices) throw new Error('Camera access needs https or localhost.');
          if (k === 'camera' || k === 'pip') { if (cam && cam.stopPattern) { stopStream(cam); cam = null; } await getCam(); }
          if (k === 'screen' || k === 'pip') {
            if (!screen) {
              screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
              screenEl.srcObject = screen;
              screen.getVideoTracks()[0].addEventListener('ended', () => { screen = null; if (scene === 'screen' || scene === 'pip') { toast('Screen sharing stopped'); scene = cam ? 'camera' : 'test'; paintScenes(); } });
            }
            if (k === 'pip' || !cam) orientation = 'landscape';
          }
        }
        scene = k;
        if (k === 'screen' || k === 'pip') orientation = 'landscape';
        paintScenes();
        paintReady();
        if (live) rebuildAudio();
      } catch (e) {
        errorEl.textContent = e.name === 'NotAllowedError' ? 'Camera or microphone blocked. Click the camera icon in your browser’s address bar, choose Allow, then try again — or share your screen instead.' : e.name === 'NotFoundError' ? 'No camera found. You can share your screen instead.' : e.message;
        errorEl.classList.remove('hidden');
        paintReady();
      }
    }

    /** Output stream = canvas video + mixed audio (mic + screen audio). */
    let outStream = null;
    function rebuildAudio() {
      if (!outStream) return;
      outStream.getAudioTracks().forEach((t) => { outStream.removeTrack(t); });
      if (audioCtx) audioCtx.close();
      audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      [cam, scene === 'screen' || scene === 'pip' ? screen : null].forEach((s) => { if (s && s.getAudioTracks().length) audioCtx.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(dest); });
      dest.stream.getAudioTracks().forEach((t) => outStream.addTrack(t));
      if (live) live.broadcaster.replaceTracks(outStream);
    }
    function buildOutput() {
      outStream = canvas.captureStream(30);
      rebuildAudio();
      return outStream;
    }

    const sceneBtns = h('div.scene-grid');
    function paintScenes() {
      sceneBtns.replaceChildren(...[['camera', 'camera', 'Camera'], ['screen', 'monitor', 'Screen'], ['pip', 'video', 'Screen + camera'], ['test', 'sparkles', 'Test pattern']].map(([k, ic, label]) =>
        h(`button.scene-btn${scene === k && (cam || screen) ? '.active' : ''}`, { type: 'button', onclick: () => useScene(k) }, icon(ic, { size: 20 }), h('span', label))));
      orientBtns.replaceChildren(...['portrait', 'landscape'].map((o) => h(`button.seg-btn${orientation === o ? '.active' : ''}`, { type: 'button', onclick: () => { orientation = o; paintScenes(); } }, o === 'portrait' ? 'Vertical 9:16' : 'Horizontal 16:9')));
    }
    const orientBtns = h('div.seg');

    const micBtn = h('button.icon-btn.studio-toggle', { type: 'button', 'aria-label': 'Toggle microphone', onclick: () => { if (cam) cam.getAudioTracks().forEach((t) => { t.enabled = !t.enabled; }); paintToggles(); } });
    const camBtn = h('button.icon-btn.studio-toggle', { type: 'button', 'aria-label': 'Toggle camera', onclick: () => { if (cam) cam.getVideoTracks().forEach((t) => { t.enabled = !t.enabled; }); paintToggles(); } });
    function paintToggles() {
      const a = cam && cam.getAudioTracks()[0];
      const v = cam && cam.getVideoTracks()[0];
      micBtn.replaceChildren(icon(a && a.enabled ? 'mic' : 'micOff', { size: 20 }));
      camBtn.replaceChildren(icon(v && v.enabled ? 'video' : 'videoOff', { size: 20 }));
      micBtn.classList.toggle('off', !(a && a.enabled));
      camBtn.classList.toggle('off', !(v && v.enabled));
    }

    // ----- dashboard -----
    const timerEl = h('b', '0:00');
    const statViewers = h('b', '0');
    const statLikes = h('b', '0');
    const statGifts = h('b', '0');
    const statDiamonds = h('b', '0');
    const statFollowers = h('b', '0');
    const giftFeed = h('div.gift-feed', h('p.muted.small', 'Gifts will appear here.'));
    const leadersList = h('div.leader-list', h('p.muted.small', 'No gifters yet.'));
    const trialNote = h('div.trial-banner.hidden');
    const goalField = h('div.field', h('span.label', 'LIVE goal'), h('div.goal-form', goalType, goalTarget), goalLabel);
    const textField = h('label.field', h('span.label', 'On-screen text'), overlayIn);
    const textSlot = h('div', textField);
    const goalSlot = h('div', goalField);
    const dashGoalSlot = h('div');
    const dashTextSlot = h('div');
    const goLiveBtn = h('button.btn.btn-primary.btn-lg.btn-block', { type: 'button', onclick: start }, icon('live', { size: 20 }), trialMode ? ' Start trial LIVE' : ' Go LIVE');
    const stat = (label, el, ic) => h('div.studio-stat', h('span.muted.small', ic, ' ', label), el);

    const ready = h('div.ready-list');
    function paintReady() {
      const v = cam && cam.getVideoTracks()[0];
      const a = cam && cam.getAudioTracks()[0];
      const hasVideo = !!(v && v.readyState === 'live') || !!screen;
      const item = (ok, label, hint) => h(`div.ready-item${ok ? '.ok' : ''}`, h('span.ready-dot', ok ? icon('check', { size: 12 }) : ''), h('span', label), h('span.muted.small', hint));
      ready.replaceChildren(
        item(hasVideo, 'Video', hasVideo ? (screen ? 'Screen' : cam && cam.stopPattern ? 'Test pattern' : 'Camera on') : 'Not on yet'),
        item(!!(a && a.readyState === 'live'), 'Microphone', a ? (a.enabled ? 'On' : 'Muted') : 'Not on yet'),
        item(ws.connected, 'Connection', ws.connected ? 'Good' : 'Connecting…'));
      emptyStage.classList.toggle('hidden', hasVideo);
      goLiveBtn.disabled = false;
      fillDevices();
    }
    const connTimer = setInterval(paintReady, 2000);

    const setupPanel = h('aside.studio-panel.setup',
      h('h2', trialMode ? 'Trial LIVE' : 'Go LIVE'),
      h('p.muted.small', trialMode ? `Your trial lasts ${elig.trial.minutes} minutes. Your followers get notified.` : 'Two steps: turn on your camera, then press Go LIVE. Your followers get notified.'),
      ready,
      devicesRow,
      h('label.field', h('span.label', 'Title'), title),
      errorEl, goLiveBtn,
      h('details.more-options', h('summary', icon('settings', { size: 14 }), ' More options'),
        h('div.stack', h('span.label', 'Scene'), sceneBtns, h('span.label', 'Shape'), orientBtns, textSlot, goalSlot)));
    const emptyStage = h('div.stage-empty',
      h('button.btn.btn-primary.btn-lg', { type: 'button', onclick: () => useScene('camera') }, icon('camera', { size: 20 }), ' Turn on camera'),
      h('div.row.gap.center',
        h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: () => useScene('screen') }, icon('monitor', { size: 14 }), ' Share screen'),
        h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => useScene('test') }, 'Test pattern')),
      h('p.small', 'Your browser will ask for permission — choose Allow.'));

    const dashPanel = h('aside.studio-panel.dash.hidden',
      h('div.studio-live-head', h('span.live-badge', 'LIVE'), timerEl, h('button.btn.btn-danger.btn-sm', { type: 'button', onclick: () => end() }, 'End')),
      trialNote,
      h('div.studio-stats', stat('Viewers', statViewers, icon('eye', { size: 13 })), stat('Likes', statLikes, icon('heart', { size: 13 })), stat('Gift coins', statGifts, icon('gift', { size: 13 })), stat('Diamonds', statDiamonds, icon('diamond', { size: 13 })), stat('New followers', statFollowers, icon('users', { size: 13 }))),
      dashGoalSlot, h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: updateGoal }, 'Update goal'), dashTextSlot,
      h('h3.panel-title', icon('trophy', { size: 14 }), ' Top gifters'), leadersList,
      h('h3.panel-title', icon('gift', { size: 14 }), ' Gift feed'), giftFeed);

    const roomSlot = h('div.studio-room-slot');
    const stage = h(`div.studio-stage.${orientation}`, canvas, emptyStage, roomSlot, h('div.studio-toggles', micBtn, camBtn));
    root.replaceChildren(h('div.studio-layout', setupPanel, dashPanel, h('div.studio-center', stage)));
    paintScenes();
    paintToggles();
    paintReady();
    raf = requestAnimationFrame(draw);
    const orientObs = setInterval(() => { stage.className = `studio-stage ${orientation}`; }, 500);

    const goalPayload = () => (goalType.value ? { type: goalType.value, target: Number(goalTarget.value) || 1, label: goalLabel.value } : null);

    async function updateGoal() {
      if (!live) return;
      try { await api.patch(`/live/${live.id}`, { goal: goalPayload() }); toast('Goal updated'); } catch (e) { toastError(e); }
    }

    async function start() {
      if (!cam && !screen) {
        await useScene('camera');
        if (!cam && !screen) return;
      }
      goLiveBtn.disabled = true;
      try {
        const { stream: s } = await api.post('/live', { title: title.value, goal: goalPayload(), trial: trialMode });
        startedAt = Date.now();
        const out = buildOutput();
        const broadcaster = createBroadcaster(s.id, () => out);
        const room = liveRoom(s.id, { isHost: true, onGift: (m) => {
          giftCoins = m.giftCoins;
          statGifts.textContent = fmtCount(giftCoins);
          if (giftFeed.querySelector('p')) giftFeed.replaceChildren();
          giftFeed.prepend(h('div.gift-feed-row', avatar({ username: m.user.username, avatarUrl: m.user.avatarUrl }, 28, { link: false }),
            h('span', h('b', m.user.displayName), ` sent ${m.gift.art} ${m.gift.name}${m.count > 1 ? ` ×${m.count}` : ''}`), h('span.muted.small', coinIcon(12), ` ${fmtCount(m.coins)}`)));
          leadersList.replaceChildren(...m.leaders.map((u, i) => h('div.leader-row', h('span.rank', `#${i + 1}`), avatar({ username: u.username, avatarUrl: u.avatarUrl }, 28, { link: false }), h('span', u.displayName), h('b', coinIcon(12), ` ${fmtCount(u.coins)}`))));
        } });
        roomSlot.replaceChildren(room.el);
        dashGoalSlot.appendChild(goalField);
        dashTextSlot.appendChild(textField);
        setupPanel.classList.add('hidden');
        dashPanel.classList.remove('hidden');
        root.closest('.studio-page')?.classList.add('is-live');
        subs.push(ws.on('live:viewers', (m) => { if (m.streamId === s.id) statViewers.textContent = fmtCount(m.count); }));
        subs.push(ws.on('live:like', (m) => { if (m.streamId === s.id) statLikes.textContent = fmtCount(m.total); }));
        subs.push(ws.on('live:ended', (m) => { if (live && m.streamId === live.id) finish(m.reason); }));
        subs.push(ws.on('live:replaced', (m) => { if (live && m.streamId === live.id) { toast('This LIVE was opened in another tab.', { type: 'error' }); finish('replaced', false); } }));
        const tick = setInterval(() => {
          const el = (Date.now() - startedAt) / 1000;
          timerEl.textContent = fmtDuration(el);
          if (s.trialEndsAt) {
            const left = Math.max(0, (s.trialEndsAt - Date.now()) / 1000);
            trialNote.textContent = `Trial LIVE · ${fmtDuration(left)} left`;
            trialNote.classList.remove('hidden');
          }
        }, 1000);
        const refresh = async () => {
          try {
            const c = document.createElement('canvas');
            const sc = 360 / canvas.width;
            c.width = 360; c.height = Math.round(canvas.height * sc);
            c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
            const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.75));
            if (b && live) { const fd = new FormData(); fd.append('preview', b, 'preview.jpg'); api.upload(`/live/${s.id}/preview`, fd).promise.catch(() => {}); }
            const { stream: info } = await api.get(`/live/${s.id}`);
            statDiamonds.textContent = fmtCount(info.diamonds || 0);
            statFollowers.textContent = fmtCount(info.newFollowers || 0);
          } catch { /* ignore */ }
        };
        setTimeout(refresh, 1500);
        const refreshTimer = setInterval(refresh, 10000);
        live = { id: s.id, broadcaster, room, timers: [tick, refreshTimer] };
        toast(trialMode ? 'Trial LIVE started' : "You're LIVE", { type: 'success' });
      } catch (e) { toastError(e); goLiveBtn.disabled = false; }
    }

    async function end(skipConfirm = false) {
      if (!live) return;
      if (!skipConfirm && !(await confirmDialog({ title: 'End LIVE?', message: 'Viewers will be disconnected.', confirmText: 'End now', danger: true }))) return;
      try { await api.post(`/live/${live.id}/end`); } catch (e) { toastError(e); }
      finish('ended');
    }

    function finish(reason, showSummary = true) {
      if (!live) return;
      const { broadcaster, room, timers, id } = live;
      live = null;
      timers.forEach(clearInterval);
      broadcaster.stop();
      room.destroy();
      stopAll();
      if (!showSummary) return;
      const duration = fmtDuration((Date.now() - startedAt) / 1000);
      api.get(`/live/${id}`).then(({ stream: s }) => {
        root.closest('.studio-page')?.classList.remove('is-live');
        root.replaceChildren(h('div.live-ended-card',
          h('h1', reason === 'trial_ended' ? 'Trial LIVE finished' : 'LIVE ended'),
          reason === 'ended_by_admin' ? h('p.form-error', 'This LIVE was ended by a moderator.') : null,
          h('div.ended-stats', h('div', h('b', duration), h('span', 'Duration')), h('div', h('b', fmtCount(s.peakViewers)), h('span', 'Peak viewers')),
            h('div', h('b', fmtCount(s.likes)), h('span', 'Likes')), h('div', h('b', fmtCount(s.diamonds)), h('span', 'Diamonds')), h('div', h('b', fmtCount(s.newFollowers)), h('span', 'New followers'))),
          h('div.row.gap.center', h('a.btn.btn-primary', { href: '/coins' }, 'View rewards'), h('a.btn.btn-secondary', { href: '/live' }, 'Back to LIVE'))));
      }).catch(() => navigate('/live'));
    }

    function stopAll() {
      cancelAnimationFrame(raf);
      clearInterval(orientObs);
      clearInterval(connTimer);
      stopStream(cam); stopStream(screen);
      cam = null; screen = null;
      if (outStream) outStream.getTracks().forEach((t) => t.stop());
      if (audioCtx) { audioCtx.close(); audioCtx = null; }
    }

    const onBeforeUnload = (e) => { if (live) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', onBeforeUnload);
    cleanup = () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (live) { const id = live.id; api.post(`/live/${id}/end`).catch(() => {}); finish('ended', false); }
      stopAll();
      subs.forEach((u) => u());
    };
  }
}

