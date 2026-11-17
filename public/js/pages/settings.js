// Settings: account, privacy, blocked accounts, display, sessions, delete account.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { ws } from '../lib/ws.js';
import { store, setMe, getTheme, setTheme } from '../lib/store.js';
import { fullDate } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { toast, toastError, confirmDialog, toggle, field, avatar, emptyState, loadingBlock } from '../components/ui.js';
import { editProfileModal } from './profile.js';

export default function settingsPage(ctx) {
  const sections = [
    ['account', 'Account', 'user'],
    ['privacy', 'Privacy', 'lock'],
    ['moderation', 'Moderation & filters', 'shield'],
    ['blocked', 'Blocked accounts', 'block'],
    ['notifications', 'Notifications', 'bell'],
    ['display', 'Display', 'moon'],
    ['security', 'Security & sessions', 'shield'],
  ];
  let current = ctx.query.get('tab') || 'account';
  const nav = h('nav.settings-nav');
  const body = h('div.settings-body');

  function paintNav() {
    nav.replaceChildren(...sections.map(([k, label, ic]) => h(`button.settings-link${k === current ? '.active' : ''}`, { onclick: () => show(k) }, icon(ic, { size: 20 }), h('span', label))));
  }

  const card = (title, ...children) => h('section.settings-card', h('h2', title), ...children);
  const row = (title, desc, control) => h('div.setting-row', h('div', h('div.setting-title', title), desc ? h('div.muted.small', desc) : null), control);

  async function savePrivacy(patch, input) {
    try { const r = await api.patch('/me/settings', patch); setMe(r.user); toast('Saved'); } catch (e) { toastError(e); if (input) input.checked = !input.checked; }
  }

  function show(k) {
    current = k;
    history.replaceState({}, '', `/settings?tab=${k}`);
    paintNav();
    const me = store.me;
    const s = me.settings;
    if (k === 'account') {
      const email = h('input.input', { type: 'email', value: me.email });
      const pw = h('input.input', { type: 'password', placeholder: 'Current password', autocomplete: 'current-password' });
      body.replaceChildren(
        card('Profile', h('div.setting-row', h('div.row.gap', avatar(me, 56, { link: false }), h('div', h('b', me.displayName), h('div.muted', `@${me.username}`))),
          h('button.btn.btn-secondary', { onclick: () => editProfileModal(() => show('account')) }, 'Edit profile'))),
        me.birthDateSet ? null : card('Date of birth', h('p.muted.small', 'Needed for LIVE, coins and gifts (18+). It is never shown on your profile and can only be set once.'),
          h('form.row.gap', {
            onsubmit: async (e) => {
              e.preventDefault();
              const val = e.target.elements.dob.value;
              try { await api.patch('/me/settings', { birthDate: val }); const r = await api.get('/auth/me'); setMe(r.user); toast('Saved', { type: 'success' }); show('account'); } catch (err) { toastError(err); }
            },
          }, h('input.input', { type: 'date', name: 'dob', required: true, max: new Date().toISOString().slice(0, 10), min: '1900-01-01' }), h('button.btn.btn-primary', { type: 'submit' }, 'Save'))),
        card('Email address', me.emailVerified ? null : h('p.small.warn-text', 'Not confirmed yet. Use the link we emailed you, or the Resend button at the top of the page.'), h('form.stack', {
          onsubmit: async (e) => {
            e.preventDefault();
            try { const r = await api.post('/me/email', { email: email.value, password: pw.value }); setMe(r.user); pw.value = ''; toast('Email updated', { type: 'success' }); } catch (err) { toastError(err); }
          },
        }, field('Email', email), field('Confirm with password', pw), h('div', h('button.btn.btn-primary', { type: 'submit' }, 'Update email')))),
        card('Your data', h('p.muted', 'Download a copy of the information Clipzy holds about you: profile, videos, comments, messages you sent, follows, coins and gifts.'),
          h('div', h('a.btn.btn-secondary', { href: '/api/me/export', download: '' }, icon('upload', { size: 16 }), ' Download my data'))),
        card('Delete account', h('p.muted', 'Permanently delete your account, videos, comments, likes and messages. This cannot be undone.'),
          h('button.btn.btn-danger', { onclick: deleteAccount }, icon('trash', { size: 16 }), ' Delete account')));
    } else if (k === 'privacy') {
      const sel = (value, options, onChange) => {
        const el = h('select.input.input-sm', options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
        el.addEventListener('change', () => onChange(el.value));
        return el;
      };
      body.replaceChildren(
        card('Discoverability',
          row('Private account', 'With a private account, only users you approve can follow you and watch your videos. Existing followers are not affected.',
            toggle(s.isPrivate, (v, inp) => savePrivacy({ isPrivate: v }, inp))),
          row('Show liked videos', 'Let others see the Liked tab on your profile.', toggle(s.showLiked, (v, inp) => savePrivacy({ showLiked: v }, inp)))),
        card('Interactions',
          row('Direct messages', 'Who can send you messages', sel(s.allowMessages, [['everyone', 'Everyone'], ['friends', 'Friends (mutual follows)'], ['none', 'No one']], (v) => savePrivacy({ allowMessages: v }))),
          row('Comments', 'Who can comment on your videos', sel(s.allowComments, [['everyone', 'Everyone'], ['followers', 'Followers'], ['none', 'No one']], (v) => savePrivacy({ allowComments: v })))));
    } else if (k === 'moderation') {
      let words = [...(s.filterKeywords || [])];
      const chips = h('div.word-chips');
      const paintWords = () => chips.replaceChildren(...(words.length ? words.map((w) => h('span.word-chip', w, h('button', { 'aria-label': `Remove ${w}`, onclick: () => { words = words.filter((x) => x !== w); saveWords(); } }, icon('close', { size: 12 })))) : [h('span.muted.small', 'No keywords yet')]));
      const saveWords = async () => { try { const r = await api.patch('/me/settings', { filterKeywords: words }); setMe(r.user); words = r.user.settings.filterKeywords; paintWords(); } catch (e) { toastError(e); } };
      const wordInput = h('input.input', { placeholder: 'Add a word or phrase (use word* for prefixes)', maxlength: 40 });
      const addWord = (e) => { e.preventDefault(); const w = wordInput.value.trim().toLowerCase(); if (!w) return; if (!words.includes(w)) words.push(w); wordInput.value = ''; saveWords(); };
      paintWords();

      const queue = h('div.stack-sm', loadingBlock());
      const loadQueue = () => api.get('/me/filtered-comments').then(({ comments }) => {
        queue.replaceChildren(...(comments.length ? comments.map((c) => {
          const row = h('div.user-row', avatar(c.author, 36),
            h('div.user-row-text', h('div.user-row-name', c.author.displayName, h('span.muted.small', ` · ${c.reason ? c.reason.replace(/_/g, ' ') : 'filtered'}`)),
              h('div.small', c.body), h('a.muted.small', { href: `/video/${c.videoId}` }, `on “${(c.videoCaption || 'your video').slice(0, 40)}”`)),
            h('div.row.gap',
              h('button.btn.btn-primary.btn-sm', { onclick: async () => { try { await api.post(`/me/filtered-comments/${c.id}/approve`); row.remove(); toast('Comment approved'); } catch (e) { toastError(e); } } }, 'Approve'),
              h('button.btn.btn-secondary.btn-sm', { onclick: async () => { try { await api.post(`/me/filtered-comments/${c.id}/delete`); row.remove(); toast('Comment deleted'); } catch (e) { toastError(e); } } }, 'Delete')));
          return row;
        }) : [emptyState({ iconName: 'check', title: 'Nothing to review', text: 'Comments caught by your filters or auto-moderation appear here.' })]));
      }).catch((e) => queue.replaceChildren(h('p.form-error', e.message)));
      loadQueue();

      const mods = h('div.user-list', loadingBlock());
      const banned = h('div.user-list');
      const modInput = h('input.input', { placeholder: 'Username to make a LIVE moderator' });
      const loadMods = () => api.get('/me/live-moderators').then(({ moderators, banned: b }) => {
        mods.replaceChildren(...(moderators.length ? moderators.map((u) => {
          const r = h('div.user-row', avatar(u, 36), h('div.user-row-text', h('div.user-row-name', u.displayName), h('div.user-row-sub.muted', '@' + u.username)),
            h('button.btn.btn-secondary.btn-sm', { onclick: async () => { try { await api.del(`/me/live-moderators/${u.id}`); r.remove(); } catch (e) { toastError(e); } } }, 'Remove'));
          return r;
        }) : [h('p.muted.small', 'No moderators yet. Moderators can pin, delete, mute and remove people in your LIVE chat.')]));
        banned.replaceChildren(...(b.length ? b.map((u) => {
          const r = h('div.user-row', avatar(u, 36), h('div.user-row-text', h('div.user-row-name', u.displayName), h('div.user-row-sub.muted', '@' + u.username)),
            h('button.btn.btn-secondary.btn-sm', { onclick: async () => { try { await api.del(`/me/live-bans/${u.id}`); r.remove(); toast('They can join your LIVEs again'); } catch (e) { toastError(e); } } }, 'Allow back'));
          return r;
        }) : [h('p.muted.small', 'Nobody has been removed from your LIVEs.')]));
      }).catch((e) => mods.replaceChildren(h('p.form-error', e.message)));
      loadMods();

      body.replaceChildren(
        card('Comment filters',
          h('p.muted.small', 'Comments on your videos and chat in your LIVEs that contain these keywords are hidden (only the sender can see them) until you approve them.'),
          h('form.row.gap', { onsubmit: addWord }, wordInput, h('button.btn.btn-primary', { type: 'submit' }, 'Add')),
          chips,
          row('Filter links', 'Hide comments that contain links until you review them.', toggle(s.filterLinks, (v, inp) => savePrivacy({ filterLinks: v }, inp)))),
        card('Review filtered comments', queue),
        card('LIVE moderators', h('form.row.gap', {
          onsubmit: async (e) => {
            e.preventDefault();
            try { await api.post('/me/live-moderators', { username: modInput.value.trim() }); modInput.value = ''; toast('Moderator added', { type: 'success' }); loadMods(); } catch (err) { toastError(err); }
          },
        }, modInput, h('button.btn.btn-primary', { type: 'submit' }, 'Add')), mods),
        card('Removed from your LIVEs', banned));
    } else if (k === 'blocked') {
      const list = h('div.user-list', loadingBlock());
      body.replaceChildren(card('Blocked accounts', h('p.muted.small', "Blocked people can't find your profile, watch your videos, comment or message you."), list));
      api.get('/me/blocks').then(({ users }) => {
        list.replaceChildren(...(users.length ? users.map((u) => {
          const r = h('div.user-row', avatar(u, 40), h('div.user-row-text', h('div.user-row-name', u.displayName), h('div.user-row-sub.muted', '@' + u.username)),
            h('button.btn.btn-secondary.btn-sm', { onclick: async () => { try { await api.del(`/users/${encodeURIComponent(u.username)}/block`); r.remove(); toast(`Unblocked @${u.username}`); } catch (e) { toastError(e); } } }, 'Unblock'));
          return r;
        }) : [emptyState({ iconName: 'block', title: "You haven't blocked anyone" })]));
      }).catch((e) => list.replaceChildren(h('p.form-error', e.message)));
    } else if (k === 'notifications') {
      const state = h('p.muted.small', 'Checking this device...');
      const actions = h('div.row.gap');
      const paint = async () => {
        const { pushStatus, enablePush, disablePush } = await import('../lib/push.js');
        const st = await pushStatus().catch(() => 'unsupported');
        const msg = {
          on: 'Push notifications are on for this device.',
          off: 'Get notified about follows, comments, mentions, messages and LIVEs, even when Clipzy is closed.',
          denied: 'Notifications are blocked for Clipzy on this device. Allow them in your browser or phone settings, then come back here.',
          unsupported: 'This browser can’t receive push notifications. On iPhone, add Clipzy to your Home Screen first; on Android use Chrome.',
          unavailable: 'Push notifications aren’t set up for the app on this server yet.',
        }[st];
        state.textContent = msg;
        const btn = (label, cls, fn) => h(`button.btn.${cls}`, { onclick: async (e) => {
          e.currentTarget.disabled = true;
          try { await fn(); } catch (err) { toastError(err); }
          paint();
        } }, label);
        actions.replaceChildren(...[
          st === 'off' ? btn('Turn on', 'btn-primary', async () => { await enablePush(); toast('Notifications turned on', { type: 'success' }); }) : null,
          st === 'on' ? btn('Send a test', 'btn-secondary', async () => { const r = await api.post('/push/test'); toast(r.delivered ? 'Test sent' : 'No device could be reached', { type: r.delivered ? 'success' : 'error' }); }) : null,
          st === 'on' ? btn('Turn off', 'btn-secondary', async () => { await disablePush(); toast('Notifications turned off'); }) : null,
        ].filter(Boolean));
      };
      body.replaceChildren(card('Push notifications', state, actions));
      paint();
    } else if (k === 'display') {
      const themeSeg = h('div.seg', ['dark', 'light', 'system'].map((t) => h(`button.seg-btn${getTheme() === t ? '.active' : ''}`, { onclick: () => { setTheme(t); show('display'); } }, icon(t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'monitor', { size: 16 }), ' ', t[0].toUpperCase() + t.slice(1))));
      body.replaceChildren(card('Appearance', row('Theme', 'Dark mode is the default. System follows your device setting.', themeSeg)),
        card('Playback', row('Start videos muted', 'Browsers require videos to start muted; tap the speaker icon to unmute.', toggle(store.muted, (v) => { import('../lib/store.js').then((m) => m.setMuted(v)); }))));
    } else if (k === 'security') {
      const cur = h('input.input', { type: 'password', autocomplete: 'current-password' });
      const next = h('input.input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
      const sessions = h('div.session-list', loadingBlock());
      body.replaceChildren(
        card('Change password', h('form.stack', {
          onsubmit: async (e) => {
            e.preventDefault();
            try { await api.post('/me/password', { currentPassword: cur.value, newPassword: next.value }); cur.value = ''; next.value = ''; toast('Password changed. Other devices were logged out.', { type: 'success' }); } catch (err) { toastError(err); }
          },
        }, field('Current password', cur), field('New password', next, 'At least 8 characters with a letter and a number'), h('div', h('button.btn.btn-primary', { type: 'submit' }, 'Change password')))),
        card('Active sessions', sessions, h('button.btn.btn-danger', { onclick: async () => {
          if (!(await confirmDialog({ title: 'Log out of all devices?', confirmText: 'Log out everywhere', danger: true }))) return;
          try { await api.post('/me/logout-all'); setMe(null); ws.restart(); navigate('/login'); } catch (e) { toastError(e); }
        } }, icon('logout', { size: 16 }), ' Log out of all devices')));
      api.get('/me/sessions').then(({ sessions: list }) => sessions.replaceChildren(...list.map((x) => h('div.session', icon('monitor', { size: 20 }),
        h('div', h('div.small', (x.userAgent || 'Unknown device').slice(0, 90)), h('div.muted.small', `Signed in ${fullDate(x.createdAt)}`)))))).catch(() => sessions.replaceChildren());
    }
  }

  async function deleteAccount() {
    const ok = await confirmDialog({ title: 'Delete your account?', message: 'All your videos, comments, likes, followers and messages will be permanently deleted.', confirmText: 'Continue', danger: true });
    if (!ok) return;
    const { promptDialog } = await import('../components/ui.js');
    const pw = await promptDialog({ title: 'Confirm with your password', label: 'Password', confirmText: 'Delete forever', danger: true, type: 'password' });
    if (!pw) return;
    try { await api.del('/me', { password: pw }); setMe(null); ws.restart(); toast('Your account was deleted'); navigate('/'); } catch (e) { toastError(e); }
  }

  paintNav();
  show(sections.some(([k]) => k === current) ? current : 'account');
  return { el: h('div.settings-page', h('h1.page-title', 'Settings and privacy'), h('div.settings-layout', nav, body)), title: 'Settings' };
}
