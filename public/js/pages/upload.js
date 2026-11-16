// Upload & edit: pick a video, trim it, apply a filter, add captions, choose a cover, caption, sound,
// visibility, and post now, schedule it, or save it as a draft. Also used for Duets, Stitches and
// video replies to comments.
import { h, clear } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { fmtBytes, fmtDuration } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { FILTERS, filterCss, bindTrim } from '../lib/videoFx.js';
import { takePendingUpload } from '../lib/pendingUpload.js';
import { toast, toastError, confirmDialog, field, toggle, avatar } from '../components/ui.js';
import { captionsEditor } from '../components/captionsEditor.js';

const MAX_MB = 200;
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v', 'video/ogg'];

/** Read duration/dimensions; works around Chrome reporting Infinity for MediaRecorder WebM files. */
function probe(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.src = url;
    const done = () => resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
    v.onloadedmetadata = () => {
      if (Number.isFinite(v.duration)) return done();
      v.ontimeupdate = () => { v.ontimeupdate = null; v.currentTime = 0; done(); };
      v.currentTime = 1e101;
    };
    v.onerror = () => reject(new Error('This video format is not supported by your browser.'));
  });
}

function captureFrame(video, filter) {
  const c = document.createElement('canvas');
  const w = video.videoWidth || 720;
  const hgt = video.videoHeight || 1280;
  const scale = Math.min(1, 720 / Math.max(w, hgt));
  c.width = Math.round(w * scale);
  c.height = Math.round(hgt * scale);
  const ctx = c.getContext('2d');
  ctx.filter = filterCss(filter);
  ctx.drawImage(video, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
}

export default async function uploadPage(ctx) {
  let file = null;
  let objectUrl = null;
  let meta = null;
  let customThumb = null;
  let uploading = null;
  let filter = '';
  let trim = { start: 0, end: null };
  let captionsVtt = '';
  const preselectedSound = Number(ctx.query.get('sound')) || null;
  const pending = takePendingUpload();
  const remix = pending && pending.remixOf ? { of: pending.remixOf, type: pending.remixType, username: pending.username } : null;
  const replyToId = Number(ctx.query.get('replyTo')) || null;

  const [{ sounds }, discover, replyInfo] = await Promise.all([
    api.get('/sounds'),
    api.get('/discover').catch(() => ({ tags: [] })),
    replyToId ? api.get(`/videos/comment-info/${replyToId}`).catch(() => null) : Promise.resolve(null),
  ]);
  const replyTo = replyInfo && replyInfo.comment;

  // ---------- step 1: pick ----------
  const fileInput = h('input.hidden', { type: 'file', accept: VIDEO_TYPES.join(',') });
  const drop = h('div.dropzone', {
    tabindex: 0, role: 'button', 'aria-label': 'Select video to upload',
    onclick: () => fileInput.click(),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); },
    ondragover: (e) => { e.preventDefault(); drop.classList.add('drag'); },
    ondragleave: () => drop.classList.remove('drag'),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove('drag'); if (e.dataTransfer.files[0]) pick(e.dataTransfer.files[0]); },
  },
  icon('cloudUpload', { size: 56 }),
  h('h2', 'Select video to upload'),
  h('p.muted', 'Or drag and drop a file'),
  h('ul.drop-rules.muted.small', h('li', 'MP4, WebM or MOV'), h('li', `Up to ${MAX_MB} MB and 10 minutes`), h('li', 'Vertical 9:16 looks best (720×1280 or higher)')),
  h('span.btn.btn-primary', 'Select file'));
  fileInput.addEventListener('change', () => fileInput.files[0] && pick(fileInput.files[0]));

  // ---------- editor ----------
  const preview = h('video.up-preview', { controls: true, playsInline: true, muted: true, loop: true });
  const unbindTrim = bindTrim(preview, () => trim);
  const fileInfo = h('div.up-fileinfo.muted.small');

  const trimStartIn = h('input.trim-range', { type: 'range', min: 0, max: 1000, value: 0, 'aria-label': 'Trim start' });
  const trimEndIn = h('input.trim-range', { type: 'range', min: 0, max: 1000, value: 1000, 'aria-label': 'Trim end' });
  const trimLabel = h('span.small.muted');
  const trimFill = h('div.trim-fill');
  function paintTrim() {
    const d = meta ? meta.duration : 0;
    const s = (trimStartIn.value / 1000) * d;
    const e = (trimEndIn.value / 1000) * d;
    trim = { start: s > 0.05 ? s : 0, end: e < d - 0.05 ? e : null };
    trimFill.style.left = `${trimStartIn.value / 10}%`;
    trimFill.style.right = `${100 - trimEndIn.value / 10}%`;
    trimLabel.textContent = `${fmtDuration(s)} – ${fmtDuration(e)} · ${Math.max(0, e - s).toFixed(1)}s`;
  }
  const onTrim = (which) => () => {
    if (Number(trimEndIn.value) - Number(trimStartIn.value) < 20) {
      if (which === 'start') trimStartIn.value = Number(trimEndIn.value) - 20; else trimEndIn.value = Number(trimStartIn.value) + 20;
    }
    paintTrim();
    if (meta) preview.currentTime = which === 'start' ? trim.start : Math.max(trim.start, (trim.end || meta.duration) - 1);
  };
  trimStartIn.addEventListener('input', onTrim('start'));
  trimEndIn.addEventListener('input', onTrim('end'));
  const trimBox = h('div.trim-box', h('div.trim-track', trimFill, trimStartIn, trimEndIn), trimLabel);

  const filterRow = h('div.filter-row');
  function paintFilters() {
    filterRow.replaceChildren(...[['', 'Original'], ...Object.entries(FILTERS).map(([k, f]) => [k, f.label])].map(([k, label]) =>
      h(`button.filter-chip${filter === k ? '.active' : ''}`, { type: 'button', onclick: () => { filter = k; preview.style.filter = filterCss(k); coverImg.style.filter = filterCss(k); paintFilters(); } },
        h('span.filter-swatch', { style: { filter: filterCss(k), backgroundImage: coverImg.src ? `url("${coverImg.src}")` : '' } }), label)));
  }

  const cc = captionsEditor(preview, '', { onChange: (v) => { captionsVtt = v; } });

  const caption = h('textarea.input', { rows: 3, maxlength: 300, placeholder: 'Describe your video. Add #hashtags and @mention friends' });
  const capCount = h('span.hint', '0/300');
  caption.addEventListener('input', () => { capCount.textContent = `${caption.value.length}/300`; });
  const tagChips = h('div.chip-row.small-chips', (discover.tags || []).slice(0, 8).map((t) => h('button.chip', { type: 'button', onclick: () => {
    if (!caption.value.includes('#' + t.tag)) { caption.value = `${caption.value.trim()} #${t.tag}`.trim(); caption.dispatchEvent(new Event('input')); }
  } }, '#' + t.tag)));
  const description = h('textarea.input', { rows: 2, maxlength: 2000, placeholder: 'Longer description (optional)' });

  const soundSel = h('select.input', h('option', { value: '' }, 'Original sound (from your video)'),
    sounds.map((s) => h('option', { value: s.id, selected: s.id === preselectedSound }, `${s.title} — ${s.artist}`)));
  const soundAudio = h('audio', { loop: true });
  const soundPreviewBtn = h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: () => {
    const s = sounds.find((x) => String(x.id) === soundSel.value);
    if (!s) return;
    if (!soundAudio.paused) { soundAudio.pause(); return; }
    soundAudio.src = s.url;
    soundAudio.play();
  } }, icon('play', { size: 14 }), ' Preview');
  soundAudio.addEventListener('play', () => soundPreviewBtn.replaceChildren(icon('pause', { size: 14 }), ' Stop'));
  soundAudio.addEventListener('pause', () => soundPreviewBtn.replaceChildren(icon('play', { size: 14 }), ' Preview'));
  soundSel.addEventListener('change', () => { soundAudio.pause(); soundPreviewBtn.disabled = !soundSel.value; });
  soundPreviewBtn.disabled = !soundSel.value;

  const visibility = h('select.input', h('option', { value: 'public' }, 'Everyone'), h('option', { value: 'followers' }, 'Followers'), h('option', { value: 'private' }, 'Only me'));
  let allowComments = true;
  let allowRemix = true;
  let scheduleOn = false;
  const when = h('input.input', { type: 'datetime-local' });
  const pad = (n) => String(n).padStart(2, '0');
  const toLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  when.min = toLocal(new Date(Date.now() + 2 * 60000));
  when.max = toLocal(new Date(Date.now() + 30 * 86400000));
  when.value = toLocal(new Date(Date.now() + 3600000));
  const whenWrap = h('div.hidden', when, h('span.hint', 'Up to 30 days ahead. Your followers see it when it goes live.'));

  // cover picker
  const coverImg = h('img.cover-img', { alt: 'Cover preview' });
  const frameVideo = h('video.hidden', { muted: true, playsInline: true, preload: 'auto' });
  const slider = h('input.cover-slider', { type: 'range', min: 0, max: 1000, value: 0, 'aria-label': 'Choose cover frame' });
  const thumbInput = h('input.hidden', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
  const coverMode = h('div.muted.small', 'Drag to choose a frame, or upload an image');
  function renderFrame() {
    if (customThumb || !meta) return;
    frameVideo.currentTime = (slider.value / 1000) * Math.max(0, (meta.duration || 0) - 0.1);
  }
  frameVideo.addEventListener('seeked', async () => {
    if (customThumb) return;
    const blob = await captureFrame(frameVideo, '');
    if (blob) { if (coverImg.dataset.url) URL.revokeObjectURL(coverImg.dataset.url); coverImg.dataset.url = URL.createObjectURL(blob); coverImg.src = coverImg.dataset.url; paintFilters(); }
  });
  slider.addEventListener('input', renderFrame);
  thumbInput.addEventListener('change', () => {
    const f = thumbInput.files[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) return toastError(new Error('Cover image must be under 8 MB'));
    customThumb = f;
    coverImg.src = URL.createObjectURL(f);
    coverMode.textContent = 'Custom cover selected';
    slider.disabled = true;
    resetCover.classList.remove('hidden');
  });
  const resetCover = h('button.btn.btn-ghost.btn-sm.hidden', { type: 'button', onclick: () => {
    customThumb = null; slider.disabled = false; coverMode.textContent = 'Drag to choose a frame, or upload an image'; resetCover.classList.add('hidden'); renderFrame();
  } }, 'Use video frame');

  const progressBar = h('div.up-progress-fill');
  const progressText = h('span.small', '0%');
  const progressBox = h('div.up-progress.hidden', h('div.up-progress-track', progressBar), progressText,
    h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => uploading && uploading.abort() }, 'Cancel'));
  const postBtn = h('button.btn.btn-primary.btn-lg', { type: 'submit' }, 'Post');
  const draftBtn = h('button.btn.btn-secondary.btn-lg', { type: 'button', onclick: () => submit({ draft: true }) }, icon('edit', { size: 16 }), ' Save draft');
  const errBox = h('div.form-error.hidden', { role: 'alert' });

  const contextBanner = remix
    ? h('div.context-banner', icon(remix.type === 'duet' ? 'users' : 'film', { size: 18 }), h('span', `${remix.type === 'duet' ? 'Duet' : 'Stitch'} with @${remix.username}`))
    : replyTo ? h('div.context-banner.reply', avatar({ username: replyTo.username, avatarUrl: replyTo.avatarUrl }, 28, { link: false }),
      h('div', h('b', `Replying to @${replyTo.username}’s comment`), h('div.small', replyTo.body))) : null;

  const tabsEl = h('div.editor-tabs');
  const panes = {
    trim: h('div.editor-pane', h('p.muted.small', 'Drag the handles to choose which part of your video to post.'), trimBox),
    filters: h('div.editor-pane.hidden', filterRow),
    captions: h('div.editor-pane.hidden', h('p.muted.small', 'Add timed captions so everyone can follow along. You can auto-generate them after posting (Edit video).'), cc),
    cover: h('div.editor-pane.hidden', h('div.cover-row', coverImg, h('div.cover-controls', slider, coverMode,
      h('div.row.gap', h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: () => thumbInput.click() }, icon('image', { size: 14 }), ' Upload cover'), resetCover))), frameVideo, thumbInput),
  };
  const tabDefs = [['trim', 'scissors', 'Trim'], ['filters', 'sparkles', 'Filters'], ['captions', 'comment', 'Captions'], ['cover', 'image', 'Cover']];
  function showPane(k) {
    tabsEl.replaceChildren(...tabDefs.map(([key, ic, label]) => h(`button.editor-tab${key === k ? '.active' : ''}`, { type: 'button', onclick: () => showPane(key) }, icon(ic, { size: 16 }), label)));
    Object.entries(panes).forEach(([key, el]) => el.classList.toggle('hidden', key !== k));
  }
  showPane('trim');

  const form = h('form.upload-form', { onsubmit: (e) => { e.preventDefault(); submit(); } },
    h('div.up-left', preview, fileInfo, h('div.editor', tabsEl, ...Object.values(panes))),
    h('div.up-right',
      contextBanner,
      errBox,
      field('Caption', caption), capCount, tagChips,
      field('Description', description),
      h('label.field', h('span.label', 'Sound'), h('div.row.gap', soundSel, soundPreviewBtn), h('span.hint', 'Placeholder tracks — add your own in the sounds table / uploads/sounds')), soundAudio,
      field('Who can watch this video', visibility),
      toggle(true, (v) => { allowComments = v; }, 'Allow comments'),
      toggle(true, (v) => { allowRemix = v; }, 'Allow Duet & Stitch'),
      toggle(false, (v) => { scheduleOn = v; whenWrap.classList.toggle('hidden', !v); postBtn.textContent = v ? 'Schedule' : 'Post'; }, 'Schedule post'),
      whenWrap,
      progressBox,
      h('div.row.gap.end.wrap', h('button.btn.btn-ghost.btn-lg', { type: 'button', onclick: discard }, 'Discard'), draftBtn, postBtn)));

  const heading = remix ? `${remix.type === 'duet' ? 'Duet' : 'Stitch'} with @${remix.username}` : replyTo ? 'Reply with a video' : 'Upload video';
  const root = h('div.upload-page', h('div.up-card', h('h1', heading), h('p.muted', `Post a video to @${store.me.username}`), contextBanner && !pending ? contextBanner : null, drop, fileInput));

  async function pick(f) {
    if (!VIDEO_TYPES.includes(f.type.split(';')[0]) && !/\.(mp4|webm|mov|m4v|ogv)$/i.test(f.name)) return toastError(new Error('Unsupported format. Please choose an MP4, WebM or MOV file.'));
    if (f.size > MAX_MB * 1024 * 1024) return toastError(new Error(`File is too large (${fmtBytes(f.size)}). The limit is ${MAX_MB} MB.`));
    try {
      objectUrl = URL.createObjectURL(f);
      meta = await probe(objectUrl);
      if (meta.duration > 600) { URL.revokeObjectURL(objectUrl); return toastError(new Error('Videos can be at most 10 minutes long.')); }
    } catch (e) { return toastError(e); }
    file = f;
    preview.src = objectUrl;
    frameVideo.src = objectUrl;
    frameVideo.addEventListener('loadeddata', () => { slider.value = 0; renderFrame(); }, { once: true });
    fileInfo.textContent = `${f.name} · ${fmtBytes(f.size)} · ${fmtDuration(meta.duration)} · ${meta.width}×${meta.height}`;
    paintTrim();
    paintFilters();
    if (pending && pending.caption && !caption.value) { caption.value = pending.caption; caption.dispatchEvent(new Event('input')); }
    const card = root.querySelector('.up-card');
    clear(card).append(h('h1', heading), h('p.muted', `Post a video to @${store.me.username}`), form);
  }

  async function discard() {
    if (uploading) return;
    if (file && !(await confirmDialog({ title: 'Discard this post?', message: 'The video and all edits will be discarded.', confirmText: 'Discard', danger: true }))) return;
    navigate('/upload', { replace: true });
  }

  async function submit({ draft = false } = {}) {
    if (!file || uploading) return;
    errBox.classList.add('hidden');
    postBtn.disabled = true;
    draftBtn.disabled = true;
    const fd = new FormData();
    fd.append('video', file, file.name);
    try {
      if (trim.start && !customThumb) frameVideo.currentTime = trim.start;
      const thumb = customThumb || (await captureFrame(frameVideo, filter));
      if (thumb) fd.append('thumbnail', thumb, customThumb ? customThumb.name : 'cover.jpg');
    } catch { /* cover optional */ }
    fd.append('caption', caption.value.trim());
    fd.append('description', description.value.trim());
    fd.append('visibility', visibility.value);
    fd.append('allowComments', allowComments ? '1' : '0');
    fd.append('allowRemix', allowRemix ? '1' : '0');
    fd.append('duration', String(Math.round((meta.duration || 0) * 10) / 10));
    fd.append('width', String(meta.width || ''));
    fd.append('height', String(meta.height || ''));
    fd.append('trimStart', String(trim.start || 0));
    fd.append('trimEnd', trim.end ? String(trim.end) : '');
    if (filter) fd.append('filter', filter);
    if (captionsVtt) fd.append('captions', captionsVtt);
    if (soundSel.value) fd.append('soundId', soundSel.value);
    if (remix) { fd.append('remixOf', String(remix.of)); fd.append('remixType', remix.type); }
    if (replyTo) fd.append('replyCommentId', String(replyTo.id));
    if (draft) fd.append('draft', '1');
    else if (scheduleOn) fd.append('publishAt', String(new Date(when.value).getTime()));
    progressBox.classList.remove('hidden');
    uploading = api.upload('/videos', fd, (p) => {
      progressBar.style.width = `${Math.round(p * 100)}%`;
      progressText.textContent = p >= 1 ? 'Processing…' : `${Math.round(p * 100)}%`;
    });
    try {
      const r = await uploading.promise;
      if (draft) { toast('Saved to your drafts', { type: 'success' }); navigate(`/@${store.me.username}?tab=drafts`, { replace: true }); }
      else if (r.video.publishAt) { toast(`Scheduled for ${new Date(r.video.publishAt).toLocaleString()}`, { type: 'success' }); navigate(`/@${store.me.username}?tab=drafts`, { replace: true }); }
      else { toast('Your video is live!', { type: 'success' }); navigate(`/video/${r.video.id}`, { replace: true }); }
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.remove('hidden');
      progressBox.classList.add('hidden');
      postBtn.disabled = false;
      draftBtn.disabled = false;
    } finally { uploading = null; }
  }

  const onBeforeUnload = (e) => { if (uploading) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onBeforeUnload);
  if (pending && pending.file) setTimeout(() => pick(pending.file), 0);
  return {
    el: root,
    title: heading,
    cleanup: () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (uploading) uploading.abort();
      soundAudio.pause();
      unbindTrim();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    },
  };
}
