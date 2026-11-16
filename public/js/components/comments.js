// Comments panel (threaded one level deep), used in the feed drawer and on the video page.
import { h, clear, richText } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { fmtCount, timeAgo } from '../lib/format.js';
import { toastError, avatar, spinner, emptyState, errorState, requireLogin, actionSheet, confirmDialog, toast } from './ui.js';
import { reportDialog } from './social.js';
import { navigate } from '../lib/router.js';

export function commentsPanel(video, { onCount, compactHeader = false } = {}) {
  let sort = 'top';
  let offset = 0;
  let hasMore = false;
  let total = video.comments;
  let replyTo = null;
  let canComment = false;

  const countEl = h('span', `${fmtCount(total)} comments`);
  const sortBtn = h('button.chip', { onclick: () => { sort = sort === 'top' ? 'new' : 'top'; sortBtn.textContent = sort === 'top' ? 'Top' : 'Newest'; reload(); } }, 'Top');
  const list = h('div.comment-list');
  const more = h('div.comment-more');
  const input = h('textarea.comment-input', { rows: 1, placeholder: 'Add comment...', maxlength: 500, 'aria-label': 'Add a comment' });
  const replyChip = h('div.reply-chip.hidden');
  const postBtn = h('button.comment-post', { type: 'submit', disabled: true, 'aria-label': 'Post comment' }, icon('send', { size: 20 }));
  const form = h('form.comment-form', { onsubmit: (e) => { e.preventDefault(); post(); } }, replyChip, h('div.comment-form-row', input, postBtn));
  const disabledNote = h('div.comment-disabled.hidden');

  input.addEventListener('input', () => {
    postBtn.disabled = !input.value.trim();
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (input.value.trim()) post(); } });
  input.addEventListener('focus', () => { if (!store.me) { input.blur(); requireLogin('Log in to comment'); } });

  const setTotal = (n) => { total = n; countEl.textContent = `${fmtCount(n)} comments`; onCount && onCount(n); };

  function setReply(c) {
    replyTo = c;
    clear(replyChip);
    if (!c) { replyChip.classList.add('hidden'); return; }
    replyChip.classList.remove('hidden');
    replyChip.append(h('span', 'Replying to ', h('b', '@' + c.author.username)), h('button.icon-btn.sm', { type: 'button', onclick: () => setReply(null), 'aria-label': 'Cancel reply' }, icon('close', { size: 16 })));
    input.focus();
  }

  function commentEl(c, { isReply = false } = {}) {
    const likeBtn = h(`button.comment-like${c.liked ? '.liked' : ''}`, { 'aria-label': 'Like comment' }, icon('heart', { size: 18, filled: c.liked }), h('span', fmtCount(c.likes)));
    likeBtn.addEventListener('click', async () => {
      if (!requireLogin('Log in to like comments')) return;
      const was = c.liked;
      c.liked = !was;
      c.likes += was ? -1 : 1;
      paintLike();
      try {
        const r = was ? await api.del(`/videos/comments/${c.id}/like`) : await api.post(`/videos/comments/${c.id}/like`);
        c.likes = r.likes;
        paintLike();
      } catch (e) { c.liked = was; c.likes += was ? 1 : -1; paintLike(); toastError(e); }
    });
    function paintLike() {
      likeBtn.classList.toggle('liked', c.liked);
      likeBtn.replaceChildren(icon('heart', { size: 18, filled: c.liked }), h('span', fmtCount(c.likes)));
    }
    const repliesBox = h('div.replies');
    const el = h(`div.comment${isReply ? '.reply' : ''}${c.held ? '.held' : ''}`,
      avatar(c.author, isReply ? 28 : 36),
      h('div.comment-main',
        h('div.comment-head', h('a.comment-author', { href: `/@${c.author.username}` }, c.author.displayName),
          c.byCreator ? h('span.creator-badge', 'Creator') : null,
          c.held ? h('span.held-note', icon('eye', { size: 12 }), 'Only visible to you') : null),
        h('div.comment-body', richText(c.body)),
        h('div.comment-meta',
          h('span.muted', timeAgo(c.createdAt)),
          canComment ? h('button.link-btn', { onclick: () => setReply(c) }, 'Reply') : null,
          store.me && store.me.id === video.author.id ? h('button.link-btn', { onclick: () => navigate(`/upload?replyTo=${c.id}`) }, icon('video', { size: 13 }), 'Reply with video') : null,
          h('button.icon-btn.sm.comment-more-btn', { 'aria-label': 'More', onclick: () => actionSheet([
            c.canDelete ? { label: 'Delete', icon: 'trash', danger: true, onClick: async () => {
              if (!(await confirmDialog({ title: 'Delete comment?', confirmText: 'Delete', danger: true }))) return;
              try {
                await api.del(`/videos/comments/${c.id}`);
                el.remove();
                setTotal(Math.max(0, total - 1 - (isReply ? 0 : c.replies)));
                toast('Comment deleted');
              } catch (e) { toastError(e); }
            } } : null,
            store.me && store.me.id !== c.author.id ? { label: 'Report', icon: 'flag', onClick: () => reportDialog('comment', c.id) } : null,
            { label: 'Copy text', icon: 'copy', onClick: () => navigator.clipboard.writeText(c.body).then(() => toast('Copied')) },
          ]) }, icon('more', { size: 16 }))),
        !isReply && c.replies > 0 ? h('button.view-replies', {
          onclick: async (e) => {
            const b = e.currentTarget;
            if (b.dataset.open === '1') { clear(repliesBox); b.dataset.open = '0'; b.textContent = `View ${c.replies} replies`; return; }
            b.replaceChildren(spinner('sm'));
            try {
              const r = await api.get(`/videos/comments/${c.id}/replies`);
              clear(repliesBox);
              r.comments.forEach((x) => repliesBox.appendChild(commentEl(x, { isReply: true })));
              b.dataset.open = '1';
              b.textContent = 'Hide replies';
            } catch (err) { toastError(err); b.textContent = `View ${c.replies} replies`; }
          },
        }, `View ${c.replies} replies`) : null,
        repliesBox),
      likeBtn);
    el.repliesBox = repliesBox;
    el.dataset.id = c.id;
    return el;
  }

  async function load() {
    more.replaceChildren(spinner('sm'));
    try {
      const r = await api.get(`/videos/${video.id}/comments?sort=${sort}&offset=${offset}`);
      canComment = r.canComment;
      if (offset === 0) {
        clear(list);
        setTotal(r.total);
        form.classList.toggle('hidden', !canComment && !!store.me);
        disabledNote.classList.toggle('hidden', canComment || !store.me);
        disabledNote.textContent = r.commentsDisabled ? 'Comments are turned off for this video' : 'Only certain people can comment on this video';
        if (!store.me) form.classList.remove('hidden');
        if (!r.comments.length) list.appendChild(emptyState({ iconName: 'comment', title: 'No comments yet', text: 'Be the first to comment.' }));
      }
      r.comments.forEach((c) => list.appendChild(commentEl(c)));
      offset += r.comments.length;
      hasMore = r.hasMore;
      more.replaceChildren(hasMore ? h('button.btn.btn-ghost.btn-sm', { onclick: load }, 'Load more') : '');
    } catch (e) {
      more.replaceChildren(errorState(e, () => load()));
    }
  }

  function reload() { offset = 0; clear(list); load(); }

  async function post() {
    if (!requireLogin('Log in to comment')) return;
    const body = input.value.trim();
    if (!body) return;
    postBtn.disabled = true;
    try {
      const r = await api.post(`/videos/${video.id}/comments`, { body, parentId: replyTo ? replyTo.id : undefined });
      if (r.notice) toast(r.notice);
      input.value = '';
      input.style.height = 'auto';
      const empty = list.querySelector('.empty-state');
      if (empty) empty.remove();
      if (r.comment.parentId) {
        const parentEl = list.querySelector(`.comment[data-id="${r.comment.parentId}"]`);
        if (parentEl) parentEl.repliesBox.appendChild(commentEl(r.comment, { isReply: true }));
      } else {
        list.prepend(commentEl(r.comment));
        list.scrollTop = 0;
      }
      setReply(null);
      if (!r.comment.held) setTotal(total + 1);
    } catch (e) { toastError(e); } finally { postBtn.disabled = !input.value.trim(); }
  }

  const panel = h('div.comments-panel',
    h('div.comments-head', h('h3', countEl), sortBtn),
    h('div.comments-scroll', list, more),
    disabledNote, form);
  load();
  panel.focusInput = () => input.focus();
  return panel;
}

/** Slide-in drawer (desktop: right side, mobile: bottom sheet). */
export function openCommentsDrawer(video, opts = {}) {
  const root = document.getElementById('modal-root');
  const close = () => {
    overlay.classList.remove('show');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => overlay.remove(), 250);
    opts.onClose && opts.onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const panel = commentsPanel(video, opts);
  const drawer = h('aside.drawer', { role: 'dialog', 'aria-label': 'Comments' },
    h('button.icon-btn.drawer-close', { onclick: close, 'aria-label': 'Close comments' }, icon('close')), panel);
  const overlay = h('div.drawer-overlay', { onmousedown: (e) => { if (e.target === overlay) close(); } }, drawer);
  root.appendChild(overlay);
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => overlay.classList.add('show'));
  return { close };
}
