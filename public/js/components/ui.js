// Shared UI primitives: toasts, modals, confirm dialogs, action sheets, avatars, buttons, empty/loading states.
import { h, clear } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { BRAND } from '../brand.js';
import { store } from '../lib/store.js';
import { navigate } from '../lib/router.js';

// ---------- Toast ----------
export function toast(message, { type = 'info', timeout = 3200 } = {}) {
  const root = document.getElementById('toast-root');
  const el = h(`div.toast.toast-${type}`, { role: type === 'error' ? 'alert' : 'status' }, message);
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, timeout);
}
export const toastError = (e) => toast(e && e.message ? e.message : String(e), { type: 'error', timeout: 4500 });

// ---------- Modal ----------
const openModals = [];
export function openModal(content, { title, className = '', onClose, dismissible = true, sheet = false } = {}) {
  const root = document.getElementById('modal-root');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.classList.remove('show');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => overlay.remove(), 220);
    openModals.splice(openModals.indexOf(close), 1);
    if (!openModals.length) document.body.classList.remove('modal-open');
    onClose && onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape' && dismissible && openModals[openModals.length - 1] === close) close(); };
  const box = h(`div.modal${sheet ? '.modal-sheet' : ''}`, { class: className, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
    title || dismissible ? h('div.modal-head', h('h2.modal-title', title || ''), dismissible ? h('button.icon-btn.modal-close', { 'aria-label': 'Close', onclick: close }, icon('close')) : null) : null,
    h('div.modal-body', typeof content === 'function' ? content(close) : content));
  const overlay = h('div.modal-overlay', { onmousedown: (e) => { if (e.target === overlay && dismissible) close(); } }, box);
  root.appendChild(overlay);
  document.body.classList.add('modal-open');
  document.addEventListener('keydown', onKey);
  openModals.push(close);
  requestAnimationFrame(() => overlay.classList.add('show'));
  setTimeout(() => { const f = box.querySelector('input, textarea, select'); if (f && !sheet) f.focus(); }, 60);
  return { close, el: box };
}

export function confirmDialog({ title = 'Are you sure?', message = '', confirmText = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const m = openModal((close) => h('div.confirm',
      message ? h('p.muted', message) : null,
      h('div.row.end.gap',
        h('button.btn.btn-ghost', { onclick: () => { answered = true; resolve(false); close(); } }, 'Cancel'),
        h(`button.btn${danger ? '.btn-danger' : '.btn-primary'}`, { onclick: () => { answered = true; resolve(true); close(); } }, confirmText))),
    { title, className: 'modal-sm', onClose: () => { if (!answered) resolve(false); } });
    return m;
  });
}

/** Simple prompt with a text input. Resolves to string or null. */
export function promptDialog({ title, label, placeholder = '', confirmText = 'OK', initial = '', multiline = false, danger = false, type = 'text' }) {
  return new Promise((resolve) => {
    let done = false;
    const input = multiline ? h('textarea.input', { placeholder, rows: 3, value: initial }) : h('input.input', { placeholder, value: initial, type });
    openModal((close) => h('form.stack', {
      onsubmit: (e) => { e.preventDefault(); done = true; resolve(input.value.trim()); close(); },
    }, label ? h('label.label', label) : null, input,
    h('div.row.end.gap', h('button.btn.btn-ghost', { type: 'button', onclick: () => close() }, 'Cancel'), h(`button.btn${danger ? '.btn-danger' : '.btn-primary'}`, { type: 'submit' }, confirmText))),
    { title, className: 'modal-sm', onClose: () => { if (!done) resolve(null); } });
  });
}

/** Action sheet / menu: items = [{ label, icon, danger, onClick }] */
export function actionSheet(items, { title } = {}) {
  openModal((close) => h('div.action-list', items.filter(Boolean).map((it) =>
    h(`button.action-item${it.danger ? '.danger' : ''}`, { onclick: () => { close(); it.onClick(); } }, it.icon ? icon(it.icon, { size: 20 }) : null, h('span', it.label)))),
  { title, className: 'modal-sm', sheet: true });
}

// ---------- Small building blocks ----------
export function avatar(user, size = 40, { link = true, live = false } = {}) {
  const img = h('img.avatar', {
    src: (user && user.avatarUrl) || BRAND.defaultAvatar, alt: user ? `@${user.username}` : '', width: size, height: size, loading: 'lazy',
    style: { width: size + 'px', height: size + 'px' },
    onerror: (e) => { if (!e.target.src.endsWith(BRAND.defaultAvatar)) e.target.src = BRAND.defaultAvatar; },
  });
  const inner = live ? h('span.avatar-live-ring', img, h('span.live-badge-sm', 'LIVE')) : img;
  return link && user ? h('a.avatar-link', { href: `/@${user.username}`, 'aria-label': `@${user.username}` }, inner) : inner;
}

export function verifiedBadge(user) {
  return user && user.verified ? h('span.verified', { title: 'Verified' }, icon('checkCircle', { size: 14 })) : null;
}

export function userName(user, { link = true } = {}) {
  const content = [h('span.uname', user.username), verifiedBadge(user)];
  return link ? h('a.user-name', { href: `/@${user.username}` }, content) : h('span.user-name', content);
}

export function spinner(size = '') { return h(`div.spinner${size ? '.spinner-' + size : ''}`, { role: 'status', 'aria-label': 'Loading' }); }
export function loadingBlock(text = '') { return h('div.loading-block', spinner(), text ? h('p.muted', text) : null); }

export function emptyState({ iconName = 'film', title, text, action }) {
  return h('div.empty-state', icon(iconName, { size: 48 }), h('h3', title), text ? h('p.muted', text) : null, action || null);
}

export function errorState(err, retry) {
  return h('div.empty-state.error-state', icon('alert', { size: 44 }), h('h3', 'Something went wrong'),
    h('p.muted', err && err.message ? err.message : 'Please try again.'),
    retry ? h('button.btn.btn-secondary', { onclick: retry }, icon('refresh', { size: 18 }), ' Retry') : null);
}

/** Button that shows a spinner while its async handler runs. */
export function asyncButton(label, handler, cls = 'btn btn-primary', attrs = {}) {
  const btn = h('button', { class: cls, type: attrs.type || 'button', ...attrs });
  const set = (l) => { clear(btn); btn.append(...[].concat(l).map((x) => (x instanceof Node ? x : document.createTextNode(x)))); };
  set(label);
  btn.addEventListener('click', async (e) => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('loading');
    try { await handler(e, set); } catch (err) { toastError(err); } finally { btn.disabled = false; btn.classList.remove('loading'); }
  });
  return btn;
}

/** Ensures user is logged in; otherwise opens a login prompt. Returns true when logged in. */
export function requireLogin(reason = 'Log in to continue') {
  if (store.me) return true;
  openModal((close) => h('div.auth-prompt',
    h('img', { src: BRAND.logo, width: 56, height: 56, alt: '' }),
    h('h3', reason),
    h('p.muted', `Join ${BRAND.name} to like, comment, follow creators and more.`),
    h('div.stack',
      h('button.btn.btn-primary.btn-block', { onclick: () => { close(); navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`); } }, 'Log in'),
      h('button.btn.btn-secondary.btn-block', { onclick: () => { close(); navigate(`/signup?next=${encodeURIComponent(location.pathname + location.search)}`); } }, 'Sign up'))),
  { className: 'modal-sm' });
  return false;
}

export function tabs(items, active, onChange, cls = '') {
  const bar = h('div.tabs', { class: cls, role: 'tablist' });
  const render = (val) => {
    clear(bar);
    items.forEach((it) => bar.appendChild(h(`button.tab${it.value === val ? '.active' : ''}`, {
      role: 'tab', 'aria-selected': String(it.value === val),
      onclick: () => { render(it.value); onChange(it.value); },
    }, it.icon ? icon(it.icon, { size: 18 }) : null, it.label, it.badge ? h('span.badge', String(it.badge)) : null)));
  };
  render(active);
  bar.setActive = render;
  return bar;
}

export function field(label, input, hint) {
  return h('label.field', h('span.label', label), input, hint ? h('span.hint', hint) : null);
}

export function toggle(checked, onChange, labelText) {
  const input = h('input', { type: 'checkbox', checked: !!checked, onchange: (e) => onChange(e.target.checked, e.target) });
  return h('label.switch', input, h('span.slider'), labelText ? h('span.switch-label', labelText) : null);
}
