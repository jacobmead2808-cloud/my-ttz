// A single full-screen video in the vertical feed: player, overlay info and the action rail.
import { h, richText } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { store, on, setMuted } from '../lib/store.js';
import { fmtCount, timeAgo } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { toast, toastError, avatar, requireLogin, actionSheet, spinner } from './ui.js';
import { shareVideo, reportDialog, editVideoModal, deleteVideo, collectionsModal, toggleRepost } from './social.js';
import { filterCss, bindTrim } from '../lib/videoFx.js';
import { openCommentsDrawer } from './comments.js';

export function videoItem(video, { onRemoved, onCommentsOpen, inlineComments = false, source = 'other' } = {}) {
  const subs = [];
  let srcLoaded = false;
  let active = false;
  let viewSent = false;
  let watched = 0;
  let lastT = null;
  let userPaused = false;

  // ---------- media ----------
  const vid = h('video.player-video', { playsInline: true, loop: true, preload: 'none', poster: video.thumbUrl || '', 'aria-label': video.caption || 'Video' });
  vid.muted = true;
  vid.setAttribute('playsinline', '');
  vid.setAttribute('webkit-playsinline', '');
  const audio = video.sound && video.sound.url ? h('audio', { loop: true, preload: 'none' }) : null;
  const applyFx = () => { vid.style.filter = filterCss(video.filter); };
  applyFx();
  subs.push(bindTrim(vid, () => ({ start: video.trimStart, end: video.trimEnd })));
  let ccBtn = null;
  if (video.captionsUrl) {
    vid.appendChild(h('track', { kind: 'captions', src: video.captionsUrl, srclang: 'en', label: 'Captions', default: true }));
    let ccOn = true;
    ccBtn = h('button.player-btn.cc-btn.active', { 'aria-label': 'Toggle captions', title: 'Captions', onclick: (e) => {
      e.stopPropagation();
      ccOn = !ccOn;
      if (vid.textTracks[0]) vid.textTracks[0].mode = ccOn ? 'showing' : 'hidden';
      ccBtn.classList.toggle('active', ccOn);
    } }, 'CC');
  }

  const loader = h('div.player-loading.hidden', spinner());
  const errorBox = h('div.player-error.hidden', icon('alert', { size: 36 }), h('p', 'This video could not be played'),
    h('button.btn.btn-secondary.btn-sm', { onclick: (e) => { e.stopPropagation(); retry(); } }, icon('refresh', { size: 16 }), ' Retry'));
  const playIcon = h('div.player-center-icon.hidden', icon('play', { size: 64 }));
  const heartLayer = h('div.heart-layer');

  const muteBtn = h('button.player-btn.mute-btn', { 'aria-label': 'Toggle sound', onclick: (e) => { e.stopPropagation(); setMuted(!store.muted); } });
  const paintMute = () => { muteBtn.replaceChildren(icon(store.muted ? 'mute' : 'volume', { size: 22 })); applyMute(); };

  const progressFill = h('div.progress-fill');
  const progressThumb = h('div.progress-thumb');
  const progress = h('div.progress', { role: 'slider', 'aria-label': 'Seek', tabindex: 0 }, h('div.progress-track', progressFill, progressThumb));

  function duration() {
    return Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : video.duration || 0;
  }
  const rangeStart = () => video.trimStart || 0;
  const rangeEnd = () => video.trimEnd || duration();

  function applyMute() {
    if (audio) { vid.muted = true; audio.muted = store.muted; } else vid.muted = store.muted;
  }

  function ensureSrc() {
    if (srcLoaded) return;
    srcLoaded = true;
    vid.preload = 'auto';
    vid.src = video.videoUrl;
    if (audio) audio.src = video.sound.url;
  }

  function unload() {
    if (!srcLoaded) return;
    srcLoaded = false;
    vid.pause();
    vid.removeAttribute('src');
    vid.load();
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
  }

  async function play() {
    ensureSrc();
    applyMute();
    try {
      await vid.play();
      if (audio) { audio.currentTime = vid.currentTime % (audio.duration || Infinity) || 0; audio.play().catch(() => {}); }
      playIcon.classList.add('hidden');
    } catch (e) {
      if (e.name === 'NotAllowedError' && !vid.muted) { setMuted(true); return play(); }
      if (e.name !== 'AbortError') playIcon.classList.remove('hidden');
    }
  }

  function pause(showIcon = false) {
    vid.pause();
    if (audio) audio.pause();
    if (showIcon) playIcon.classList.remove('hidden');
  }

  function retry() {
    errorBox.classList.add('hidden');
    unload();
    play();
  }

  vid.addEventListener('waiting', () => loader.classList.remove('hidden'));
  vid.addEventListener('playing', () => { loader.classList.add('hidden'); errorBox.classList.add('hidden'); });
  vid.addEventListener('canplay', () => loader.classList.add('hidden'));
  vid.addEventListener('error', () => { if (!srcLoaded) return; loader.classList.add('hidden'); errorBox.classList.remove('hidden'); });
  vid.addEventListener('timeupdate', () => {
    const span = rangeEnd() - rangeStart();
    const pct = span > 0 ? Math.max(0, Math.min(100, ((vid.currentTime - rangeStart()) / span) * 100)) : 0;
    progressFill.style.width = pct + '%';
    progressThumb.style.left = pct + '%';
    if (lastT !== null && vid.currentTime > lastT) watched += vid.currentTime - lastT;
    lastT = vid.currentTime;
    if (!viewSent && watched > 2) {
      viewSent = true;
      api.post(`/videos/${video.id}/view`, { source }).then((r) => { video.views = r.views; }).catch(() => {});
    }
    if (audio && audio.duration && Math.abs((audio.currentTime % audio.duration) - (vid.currentTime % audio.duration)) > 0.5 && vid.currentTime < audio.duration) audio.currentTime = vid.currentTime;
  });
  vid.addEventListener('seeked', () => { lastT = vid.currentTime; });

  // seek by dragging the progress bar
  let scrubbing = false;
  const seekTo = (clientX) => {
    const rect = progress.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const span = rangeEnd() - rangeStart();
    if (span > 0) {
      vid.currentTime = rangeStart() + ratio * span;
      progressFill.style.width = ratio * 100 + '%';
      progressThumb.style.left = ratio * 100 + '%';
    }
  };
  progress.addEventListener('pointerdown', (e) => { e.stopPropagation(); scrubbing = true; progress.setPointerCapture(e.pointerId); progress.classList.add('scrubbing'); seekTo(e.clientX); });
  progress.addEventListener('pointermove', (e) => scrubbing && seekTo(e.clientX));
  progress.addEventListener('pointerup', (e) => { scrubbing = false; progress.classList.remove('scrubbing'); e.stopPropagation(); });
  progress.addEventListener('click', (e) => e.stopPropagation());
  progress.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { vid.currentTime = Math.min(rangeEnd(), vid.currentTime + 5); e.preventDefault(); e.stopPropagation(); }
    if (e.key === 'ArrowLeft') { vid.currentTime = Math.max(rangeStart(), vid.currentTime - 5); e.preventDefault(); e.stopPropagation(); }
  });

  // tap = play/pause, double-tap = like
  let tapTimer = null;
  const stage = h('div.player-stage', {
    onclick: (e) => {
      if (tapTimer) {
        clearTimeout(tapTimer);
        tapTimer = null;
        burstHeart(e);
        if (!video.liked) toggleLike();
        return;
      }
      tapTimer = setTimeout(() => {
        tapTimer = null;
        if (vid.paused) { userPaused = false; play(); } else { userPaused = true; pause(true); }
      }, 240);
    },
  }, vid, loader, errorBox, playIcon, heartLayer);

  function burstHeart(e) {
    const rect = stage.getBoundingClientRect();
    const heart = h('span.burst-heart', icon('heart', { size: 96, filled: true }));
    heart.style.left = (e.clientX - rect.left) + 'px';
    heart.style.top = (e.clientY - rect.top) + 'px';
    heart.style.setProperty('--rot', `${Math.random() * 40 - 20}deg`);
    heartLayer.appendChild(heart);
    setTimeout(() => heart.remove(), 900);
    for (let i = 0; i < 10; i++) {
      const a = (Math.PI * 2 * i) / 10;
      const spark = h('span.burst-spark');
      spark.style.left = heart.style.left;
      spark.style.top = heart.style.top;
      spark.style.setProperty('--dx', `${Math.cos(a) * 90}px`);
      spark.style.setProperty('--dy', `${Math.sin(a) * 90}px`);
      spark.style.background = ['#ef4444', '#f59e0b', '#1f6feb', '#0ea5e9'][i % 4];
      heartLayer.appendChild(spark);
      setTimeout(() => spark.remove(), 750);
    }
  }

  // ---------- actions ----------
  const likeCount = h('span.action-count', fmtCount(video.likes));
  const likeBtn = h('button.action-btn.like-btn', { 'aria-label': 'Like', 'aria-pressed': String(video.liked), onclick: () => toggleLike() },
    h('span.action-icon', icon('heart', { size: 30, filled: video.liked })), likeCount);
  const paintLike = () => {
    likeBtn.classList.toggle('active', video.liked);
    likeBtn.setAttribute('aria-pressed', String(video.liked));
    likeBtn.querySelector('.action-icon').replaceChildren(icon('heart', { size: 30, filled: video.liked }));
    likeCount.textContent = fmtCount(video.likes);
  };
  async function toggleLike() {
    if (!requireLogin('Log in to like videos')) return;
    const was = video.liked;
    video.liked = !was;
    video.likes += was ? -1 : 1;
    paintLike();
    if (!was) { likeBtn.classList.remove('pop'); void likeBtn.offsetWidth; likeBtn.classList.add('pop'); }
    try {
      const r = was ? await api.del(`/videos/${video.id}/like`) : await api.post(`/videos/${video.id}/like`);
      video.likes = r.likes;
      paintLike();
    } catch (e) { video.liked = was; video.likes += was ? 1 : -1; paintLike(); toastError(e); }
  }

  const commentCount = h('span.action-count', fmtCount(video.comments));
  const commentBtn = h('button.action-btn', { 'aria-label': 'Comments', onclick: () => openComments() }, h('span.action-icon', icon('comment', { size: 30, filled: true })), commentCount);
  function openComments() {
    if (onCommentsOpen) return onCommentsOpen(video);
    openCommentsDrawer(video, { onCount: (n) => { video.comments = n; commentCount.textContent = fmtCount(n); } });
  }

  const saveCount = h('span.action-count', fmtCount(video.saves));
  const saveBtn = h('button.action-btn.save-btn', { 'aria-label': 'Save', onclick: () => toggleSave() }, h('span.action-icon', icon('bookmark', { size: 28, filled: video.saved })), saveCount);
  const paintSave = () => {
    saveBtn.classList.toggle('active', video.saved);
    saveBtn.querySelector('.action-icon').replaceChildren(icon('bookmark', { size: 28, filled: video.saved }));
    saveCount.textContent = fmtCount(video.saves);
  };
  paintSave();
  async function toggleSave() {
    if (!requireLogin('Log in to save videos')) return;
    const was = video.saved;
    video.saved = !was;
    video.saves += was ? -1 : 1;
    paintSave();
    try {
      const r = was ? await api.del(`/videos/${video.id}/save`) : await api.post(`/videos/${video.id}/save`);
      video.saves = r.saves;
      paintSave();
      toast(r.saved ? 'Added to Favorites' : 'Removed from Favorites');
    } catch (e) { video.saved = was; video.saves += was ? 1 : -1; paintSave(); toastError(e); }
  }

  const shareCount = h('span.action-count', fmtCount(video.shares));
  const shareBtn = h('button.action-btn', { 'aria-label': 'Share', onclick: () => shareVideo(video, (n) => { video.shares = n; shareCount.textContent = fmtCount(n); }) },
    h('span.action-icon', icon('share', { size: 28, filled: true })), shareCount);

  const followPlus = h('button.follow-plus', { 'aria-label': `Follow @${video.author.username}` }, icon('plus', { size: 14 }));
  const paintFollow = () => followPlus.classList.toggle('hidden', !!video.author.followStatus || video.isOwner);
  paintFollow();
  followPlus.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!requireLogin('Log in to follow creators')) return;
    followPlus.disabled = true;
    try {
      const r = await api.post(`/users/${encodeURIComponent(video.author.username)}/follow`);
      video.author.followStatus = r.followStatus;
      followPlus.classList.add('done');
      followPlus.replaceChildren(icon('check', { size: 14 }));
      setTimeout(paintFollow, 700);
      toast(r.followStatus === 'pending' ? 'Follow request sent' : `Following @${video.author.username}`);
    } catch (err) { toastError(err); } finally { followPlus.disabled = false; }
  });
  subs.push(on('follow', ({ username, status }) => {
    if (username === video.author.username) { video.author.followStatus = status; followPlus.replaceChildren(icon('plus', { size: 14 })); followPlus.classList.remove('done'); paintFollow(); }
  }));

  const moreBtn = h('button.action-btn.more-btn', { 'aria-label': 'More options', onclick: () => actionSheet([
    video.isOwner ? { label: 'Edit details', icon: 'edit', onClick: () => editVideoModal(video, (v) => { Object.assign(video, v); paintInfo(); applyFx(); }) } : null,
    video.isOwner && !video.draft && !video.publishAt ? { label: video.pinned ? 'Unpin from profile' : 'Pin to profile', icon: 'flag', onClick: async () => {
      try { const r = await api.patch(`/videos/${video.id}`, { pinned: !video.pinned }); video.pinned = r.video.pinned; toast(video.pinned ? 'Pinned to your profile' : 'Unpinned'); } catch (e) { toastError(e); }
    } } : null,
    video.isOwner ? { label: 'Delete video', icon: 'trash', danger: true, onClick: () => deleteVideo(video, () => { onRemoved && onRemoved(video); }) } : null,
    !video.isOwner && video.visibility === 'public' ? { label: video.reposted ? 'Remove repost' : 'Repost', icon: 'refresh', onClick: () => toggleRepost(video, paintInfo) } : null,
    video.allowRemix || video.isOwner ? { label: 'Duet', icon: 'users', onClick: () => requireLogin('Log in to make a duet') && navigate(`/remix/${video.id}?type=duet`) } : null,
    video.allowRemix || video.isOwner ? { label: 'Stitch', icon: 'film', onClick: () => requireLogin('Log in to stitch') && navigate(`/remix/${video.id}?type=stitch`) } : null,
    video.visibility === 'public' ? { label: 'Watch together (party)', icon: 'users', onClick: () => requireLogin('Log in to start a watch party') && import('../pages/party.js').then((m) => m.startParty(video.id)) } : null,
    { label: 'Add to collection', icon: 'bookmark', onClick: () => requireLogin('Log in to save videos') && collectionsModal(video, () => { video.saved = true; paintSave(); }) },
    store.me && !video.isOwner ? { label: 'Not interested', icon: 'block', onClick: async () => {
      try {
        await api.post(`/videos/${video.id}/not-interested`);
        toast('We’ll show you fewer videos like this');
        onRemoved && onRemoved(video);
      } catch (e) { toastError(e); }
    } } : null,
    { label: 'Copy link', icon: 'link', onClick: () => navigator.clipboard.writeText(`${location.origin}/video/${video.id}`).then(() => toast('Link copied')) },
    { label: 'Open video page', icon: 'film', onClick: () => navigate(`/video/${video.id}`) },
    !video.isOwner ? { label: 'Report video', icon: 'flag', danger: true, onClick: () => reportDialog('video', video.id) } : null,
  ]) }, h('span.action-icon', icon('more', { size: 26 })));

  const actions = h('div.action-rail',
    h('div.rail-avatar', avatar(video.author, 48), followPlus),
    likeBtn, inlineComments ? null : commentBtn, saveBtn, shareBtn, moreBtn);

  // ---------- info overlay ----------
  const info = h('div.player-info');
  function paintInfo() {
    const capText = [video.caption, video.description].filter(Boolean).join('\n');
    const caption = h('div.caption', richText(capText));
    const long = capText.length > 110 || capText.includes('\n');
    let expanded = false;
    const moreLink = long ? h('button.caption-more', { onclick: (e) => { e.stopPropagation(); expanded = !expanded; caption.classList.toggle('expanded', expanded); moreLink.textContent = expanded ? 'less' : 'more'; } }, 'more') : null;
    const soundLabel = `${video.sound.title}${video.sound.original ? '' : ' · ' + video.sound.artist}`;
    const soundEl = video.sound.id
      ? h('a.sound-line', { href: `/sound/${video.sound.id}` }, icon('music', { size: 14 }), h('span.marquee', h('span', soundLabel)))
      : h('div.sound-line', icon('music', { size: 14 }), h('span.marquee', h('span', soundLabel)));
    info.replaceChildren(...[
      video.reposted ? h('span.info-chip.repost-chip', icon('refresh', { size: 12 }), ' You reposted') : video.repostedBy ? h('a.info-chip.repost-chip', { href: `/@${video.repostedBy.username}` }, icon('refresh', { size: 12 }), ` ${video.repostedBy.displayName} reposted`) : null,
      video.remix ? h(video.remix.username ? 'a.info-chip' : 'span.info-chip', video.remix.username ? { href: `/video/${video.remix.videoId}` } : {},
        icon(video.remix.type === 'duet' ? 'users' : 'film', { size: 12 }), video.remix.type === 'duet' ? ' Duet' : ' Stitch', video.remix.username ? ` with @${video.remix.username}` : '') : null,
      video.publishAt ? h('span.info-chip', icon('clock', { size: 12 }), ` Scheduled · ${new Date(video.publishAt).toLocaleString()}`) : null,
      video.draft ? h('span.info-chip', icon('edit', { size: 12 }), ' Draft') : null,
      h('a.info-author', { href: `/@${video.author.username}` }, h('b', video.author.username), video.author.verified ? icon('checkCircle', { size: 14, cls: 'verified' }) : null,
        h('span.info-time', ` · ${timeAgo(video.createdAt)}`)),
      capText ? caption : null, moreLink, soundEl].filter(Boolean));
  }
  paintInfo();
  const disc = h('a.sound-disc', { href: video.sound.id ? `/sound/${video.sound.id}` : `/@${video.author.username}`, 'aria-label': 'Sound' }, avatar(video.author, 28, { link: false }));

  const replySticker = video.replyTo ? h('div.reply-sticker', avatar({ username: video.replyTo.username, avatarUrl: video.replyTo.avatarUrl }, 22, { link: false }),
    h('div', h('span.reply-sticker-head', `Reply to @${video.replyTo.username}’s comment`), h('span.reply-sticker-body', video.replyTo.body))) : null;
  const player = h('div.player', stage, h('div.player-gradient'), replySticker, h('div.player-top', muteBtn, ccBtn),
    info, disc, progress, audio);
  const ambient = video.thumbUrl ? h('div.ambient', { style: { backgroundImage: `url("${video.thumbUrl}")` } }) : null;
  const el = h('section.feed-item', { dataset: { id: video.id } }, ambient, h('div.feed-item-inner', player, actions));

  paintMute();
  subs.push(on('muted', paintMute));

  el.api = {
    video,
    el,
    preload: ensureSrc,
    unload,
    activate() {
      active = true;
      lastT = null;
      if (!userPaused) play();
    },
    deactivate() {
      active = false;
      userPaused = false;
      pause(false);
      if (srcLoaded) { try { vid.currentTime = 0; } catch { /* ignore */ } }
    },
    suspend() { pause(false); },
    togglePlay() { if (vid.paused) { userPaused = false; play(); } else { userPaused = true; pause(true); } },
    toggleLike,
    openComments,
    destroy() { subs.forEach((u) => u()); unload(); },
    get isActive() { return active; },
  };
  return el;
}
