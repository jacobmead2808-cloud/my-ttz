// Shared LIVE room UI (used by viewers and by the host's studio): chat with roles + moderation,
// pinned message, goal, gift effects, likes, the gift sheet, and the bottom statistics bar.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { ws } from '../lib/ws.js';
import { store } from '../lib/store.js';
import { fmtCount } from '../lib/format.js';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';
import { createGiftFx } from '../lib/giftFx.js';
import { requireLogin, toast, toastError, actionSheet, openModal } from './ui.js';
import { reportDialog } from './social.js';
import { coinIcon, coinBalance, openRecharge, setWallet } from './coins.js';

const ROLE_LABEL = { host: 'Host', mod: 'Mod', admin: 'Staff' };
const MAX_CHAT = 120;
const QUANTITIES = [1, 5, 10, 99];
const requestId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

export function liveRoom(streamId, { isHost = false, role: initialRole = isHost ? 'host' : 'viewer', slowOptions = [0, 3, 10, 30, 60], gifts = [], leaders: initialLeaders = [], hostName = '', startedAt = Date.now(), onGift, onLeaders } = {}) {
  const subs = [];
  let role = initialRole;
  let settings = { slowMode: 0, followersOnly: false, pinned: null };
  let mutedUntil = null;
  const canMod = () => role === 'host' || role === 'mod' || role === 'admin';
  const send = (type, data = {}) => ws.send(type, { streamId, ...data });
  const mod = (action, data = {}) => send('live:mod', { action, ...data });

  // ---------- bottom statistics ----------
  const stat = (ic, label) => {
    const val = h('b', '0');
    return { el: h('div.lv-stat', { title: label }, icon(ic, { size: 14, filled: ic === 'heart' }), val, h('span.lv-stat-label', label)), set: (n) => { val.textContent = fmtCount(n); } };
  };
  const sViewers = stat('eye', 'watching');
  const sLikes = stat('heart', 'likes');
  const sGifts = h('div.lv-stat', { title: 'Gift coins received' }, coinIcon(14), h('b', '0'), h('span.lv-stat-label', 'gift coins'));
  const setGiftCoins = (n) => { sGifts.querySelector('b').textContent = fmtCount(n || 0); };
  const sTime = h('div.lv-stat.lv-time', icon('clock', { size: 14 }), h('b', '0:00'));
  const tick = () => {
    const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const hh = Math.floor(s / 3600); const mm = Math.floor((s % 3600) / 60); const ss = String(s % 60).padStart(2, '0');
    sTime.querySelector('b').textContent = hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  };
  tick();
  const clock = setInterval(tick, 1000);
  const statsBar = h('div.lv-stats', { role: 'group', 'aria-label': 'LIVE statistics' }, sViewers.el, sLikes.el, sGifts, sTime);

  // ---------- overlays ----------
  const fxHost = h('div.lv-fx');
  const fx = createGiftFx(fxHost);
  const hearts = h('div.lv-hearts', { 'aria-hidden': 'true' });
  const chat = h('div.lv-chat', { role: 'log', 'aria-live': 'polite', 'aria-label': 'LIVE chat' });
  const pinnedEl = h('div.lv-pinned.hidden');
  const flags = h('div.lv-flags');
  const goalEl = h('div.lv-goal.hidden');

  function paintGoal(goal) {
    if (!goal) { goalEl.classList.add('hidden'); return; }
    const pct = Math.min(100, Math.round((goal.progress / Math.max(goal.target, 1)) * 100));
    const label = goal.label || (goal.type === 'likes' ? 'Like goal' : goal.type === 'gifts' ? 'Gift goal' : 'Follower goal');
    const unit = goal.type === 'gifts' ? ' coins' : goal.type === 'likes' ? ' likes' : ' followers';
    goalEl.replaceChildren(h('div.lv-goal-top', h('b', icon('target', { size: 13 }), pct >= 100 ? ` ${label} reached` : ` ${label}`), h('span', `${fmtCount(goal.progress)} / ${fmtCount(goal.target)}${unit}`)),
      h('div.lv-goal-bar', h('div.lv-goal-fill', { style: { width: `${pct}%` } })));
    goalEl.classList.remove('hidden');
    goalEl.classList.toggle('done', pct >= 100);
  }

  function paintSettings() {
    if (settings.pinned) {
      pinnedEl.replaceChildren(icon('flag', { size: 14 }), h('div.lv-pinned-text', h('b', `${settings.pinned.user.displayName} `), settings.pinned.text),
        canMod() ? h('button.lv-pinned-x', { type: 'button', 'aria-label': 'Unpin', onclick: () => mod('unpin') }, icon('close', { size: 14 })) : null);
      pinnedEl.classList.remove('hidden');
    } else pinnedEl.classList.add('hidden');
    flags.replaceChildren(...[
      settings.slowMode ? h('span.lv-flag', icon('clock', { size: 11 }), ` Slow mode · ${settings.slowMode}s`) : null,
      settings.followersOnly ? h('span.lv-flag', icon('users', { size: 11 }), ' Followers-only chat') : null,
      mutedUntil ? h('span.lv-flag.warn', icon('mute', { size: 11 }), ' You are muted') : null,
      canMod() ? h('span.lv-flag', icon('shield', { size: 11 }), ` ${ROLE_LABEL[role]}`) : null].filter(Boolean));
    input.placeholder = !store.me ? 'Log in to chat' : mutedUntil ? 'You are muted' : 'Say something…';
    input.disabled = !!mutedUntil;
    modBtn.classList.toggle('hidden', !canMod());
  }

  function messageActions(m) {
    const self = store.me && m.user.id === store.me.id;
    const targetIsHost = m.user.role === 'host';
    const items = [{ label: `View @${m.user.username}`, icon: 'user', onClick: () => window.open(`/@${m.user.username}`, '_blank', 'noopener') }];
    if (canMod() && m.id) {
      items.push({ label: 'Pin message', icon: 'flag', onClick: () => mod('pin', { messageId: m.id }) });
      items.push({ label: 'Delete message', icon: 'trash', danger: true, onClick: () => mod('delete', { messageId: m.id }) });
    }
    if (canMod() && !self && !targetIsHost && m.user.id) {
      items.push({ label: 'Mute for 5 minutes', icon: 'micOff', onClick: () => mod('mute', { userId: m.user.id, minutes: 5 }) });
      items.push({ label: 'Mute for this LIVE', icon: 'micOff', onClick: () => mod('mute', { userId: m.user.id, minutes: 0 }) });
      items.push({ label: 'Remove from LIVE', icon: 'block', danger: true, onClick: () => mod('kick', { userId: m.user.id }) });
      if (role === 'host' || role === 'admin') {
        items.push(m.user.role === 'mod'
          ? { label: 'Remove as moderator', icon: 'shield', onClick: () => mod('remove_mod', { userId: m.user.id }) }
          : { label: 'Make moderator', icon: 'shield', onClick: () => mod('add_mod', { userId: m.user.id }) });
      }
    }
    if (!self && store.me && m.user.id) items.push({ label: 'Report user', icon: 'flag', danger: true, onClick: () => reportDialog('user', m.user.id) });
    actionSheet(items, { title: `@${m.user.username}` });
  }

  /** kind: 'msg' | 'system' | 'join' | 'follow' | 'gift' */
  function addChat(m, kind = 'msg') {
    let row;
    if (kind === 'msg') {
      const badge = ROLE_LABEL[m.user.role] ? h(`span.lv-badge.${m.user.role}`, ROLE_LABEL[m.user.role]) : null;
      row = h(`div.lv-msg${m.filtered ? '.filtered' : ''}`, { dataset: { id: m.id || '' } },
        badge, h('b.lv-name', m.user.displayName || m.user.username), h('span.lv-text', m.text),
        m.filtered ? h('div.lv-note', 'Only you can see this (filtered)') : null);
      if (!m.filtered) { row.tabIndex = 0; row.addEventListener('click', () => messageActions(m)); row.addEventListener('keydown', (e) => { if (e.key === 'Enter') messageActions(m); }); }
    } else if (kind === 'gift') {
      row = h('div.lv-msg.lv-gift-msg', h('b.lv-name', m.user.displayName), h('span.lv-text', `sent ${m.gift.name}${m.count > 1 ? ` ×${m.count}` : ''}`), h('img.lv-gift-icon', { src: m.gift.art, alt: '' }));
    } else {
      row = h(`div.lv-msg.lv-${kind}`, kind === 'follow' ? icon('users', { size: 12 }) : null, h('span.lv-text', m));
    }
    const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
    chat.appendChild(row);
    while (chat.children.length > MAX_CHAT) chat.firstChild.remove();
    if (nearBottom) chat.scrollTop = chat.scrollHeight;
  }

  // Joins are summarised so a busy room doesn't flood the chat.
  let joinBuf = [];
  let joinTimer = null;
  const flushJoins = () => {
    if (!joinBuf.length) return;
    addChat(joinBuf.length === 1 ? `@${joinBuf[0]} joined` : `@${joinBuf[0]} and ${joinBuf.length - 1} other${joinBuf.length > 2 ? 's' : ''} joined`, 'join');
    joinBuf = []; joinTimer = null;
  };

  function floatHeart() {
    if (hearts.childElementCount > 24) return;
    const el = h('span.lv-heart', icon('heart', { size: 26, filled: true }));
    el.style.setProperty('--x', `${Math.round(Math.random() * 36 - 18)}px`);
    el.style.setProperty('--hue', String(Math.round(Math.random() * 3)));
    hearts.appendChild(el);
    setTimeout(() => el.remove(), 2000);
  }

  const mine = (m) => m.streamId === streamId;
  subs.push(ws.on('live:viewers', (m) => mine(m) && sViewers.set(m.count)));
  subs.push(ws.on('live:state', (m) => {
    if (!mine(m)) return;
    sViewers.set(m.viewers); sLikes.set(m.likes); setGiftCoins(m.giftCoins);
    if (m.role) role = m.role;
    mutedUntil = m.mutedUntil || null;
    paintSettings();
  }));
  subs.push(ws.on('live:settings', (m) => { if (mine(m)) { settings = m; paintSettings(); paintGoal(m.goal); } }));
  subs.push(ws.on('live:gift', (m) => {
    if (!mine(m)) return;
    setGiftCoins(m.giftCoins);
    fx.push({ gift: m.gift, count: m.count, user: m.user, recipient: hostName || null });
    addChat(m, 'gift');
    onLeaders && onLeaders(m.leaders);
    onGift && onGift(m);
  }));
  subs.push(ws.on('live:chat', (m) => mine(m) && addChat(m.message)));
  subs.push(ws.on('live:system', (m) => mine(m) && addChat(m.text, /follow/i.test(m.text) ? 'follow' : 'system')));
  subs.push(ws.on('live:chat-deleted', (m) => { if (mine(m)) chat.querySelector(`.lv-msg[data-id="${m.messageId}"]`)?.remove(); }));
  subs.push(ws.on('live:joined', (m) => {
    if (!mine(m)) return;
    joinBuf.push(m.user.username);
    if (!joinTimer) joinTimer = setTimeout(flushJoins, 1500);
  }));
  subs.push(ws.on('live:muted', (m) => { if (mine(m)) { mutedUntil = m.until || -1; paintSettings(); toast(m.until ? 'A moderator muted you for a few minutes' : 'You were muted for this LIVE', { type: 'error' }); } }));
  subs.push(ws.on('live:unmuted', (m) => { if (mine(m)) { mutedUntil = null; paintSettings(); toast('You can chat again'); } }));
  subs.push(ws.on('live:role', (m) => { if (mine(m)) { role = m.role; paintSettings(); toast(m.role === 'mod' ? 'You are now a moderator of this LIVE' : 'You are no longer a moderator'); } }));
  subs.push(ws.on('live:like', (m) => {
    if (!mine(m)) return;
    sLikes.set(m.total);
    if (m.from === ws.connId) return; // already animated locally
    for (let i = 0; i < Math.min(m.count, 4); i++) setTimeout(floatHeart, i * 140);
  }));
  subs.push(ws.on('live:react', (m) => mine(m) && floatHeart()));
  subs.push(ws.on('live:error', (m) => mine(m) && toast(m.message, { type: 'error' })));

  // ---------- composer + actions ----------
  const input = h('input.lv-input', { placeholder: store.me ? 'Say something…' : 'Log in to chat', maxlength: 200, 'aria-label': 'Chat message', enterkeyhint: 'send' });
  input.addEventListener('focus', () => { if (!store.me) { input.blur(); requireLogin('Log in to chat in LIVE'); } });
  const form = h('form.lv-composer', {
    onsubmit: (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || !store.me) return;
      send('live:chat', { text });
      input.value = '';
    },
  }, input);

  let pendingLikes = 0;
  let likeTimer = null;
  const likeBtn = h('button.lv-action.lv-like', { type: 'button', 'aria-label': 'Like', title: 'Like', onclick: () => {
    if (!requireLogin('Log in to like')) return;
    floatHeart();
    pendingLikes++;
    if (!likeTimer) likeTimer = setTimeout(() => { send('live:like', { count: pendingLikes }); pendingLikes = 0; likeTimer = null; }, 400);
  } }, icon('heart', { size: 24, filled: true }));

  const shareBtn = h('button.lv-action', { type: 'button', 'aria-label': 'Share', title: 'Share', onclick: async () => {
    const url = `${location.origin}/live/${streamId}`;
    try {
      if (navigator.share) await navigator.share({ title: `${hostName || 'Someone'} is LIVE on Clipzy`, url });
      else { await navigator.clipboard.writeText(url); toast('Link copied'); }
    } catch { /* share sheet closed */ }
  } }, icon('share', { size: 22 }));

  function openModPanel() {
    openModal((close) => {
      const slow = h('div.seg', slowOptions.map((s) => h(`button.seg-btn${settings.slowMode === s ? '.active' : ''}`, { type: 'button', onclick: () => { mod('slow', { seconds: s }); close(); } }, s ? `${s}s` : 'Off')));
      const fo = h('label.switch', h('input', { type: 'checkbox', checked: settings.followersOnly, onchange: (e) => mod('followers_only', { value: e.target.checked }) }), h('span.slider'), h('span.switch-label', 'Followers-only chat'));
      return h('div.mod-panel.stack',
        h('h4', 'Slow mode'), slow,
        h('h4', 'Chat'), fo,
        settings.pinned ? h('button.btn.btn-secondary', { type: 'button', onclick: () => { mod('unpin'); close(); } }, 'Unpin message') : null,
        h('p.muted.small', 'Tap any chat message to pin, delete, mute or remove its sender. Keyword filters and your moderator list are in Settings → Moderation.'),
        role === 'host' ? h('button.btn.btn-ghost', { type: 'button', onclick: () => { close(); navigate('/settings?tab=moderation'); } }, icon('settings', { size: 16 }), ' Moderation settings') : null);
    }, { title: 'LIVE moderation', className: 'modal-sm' });
  }
  const modBtn = h('button.lv-action.hidden', { type: 'button', 'aria-label': 'Moderation tools', title: 'Moderation tools', onclick: openModPanel }, icon('shield', { size: 22 }));

  api.get(`/live/${streamId}/chat`).then(({ messages }) => messages.forEach((m) => addChat(m))).catch(() => {});

  // ---------- gifts ----------
  let sending = false;
  async function sendGift(g, count = 1) {
    if (!requireLogin('Log in to send gifts')) return false;
    if (sending) return false;
    sending = true;
    try {
      const r = await api.post(`/live/${streamId}/gift`, { giftId: g.id, count, clientRef: requestId() });
      setWallet(r.wallet);
      return true;
    } catch (e) {
      if (e.data && e.data.needCoins) { toast(e.message, { type: 'error' }); openRecharge({ need: e.data.needCoins }); } else toastError(e);
      return false;
    } finally { sending = false; }
  }

  function giftSheet() {
    if (!requireLogin('Log in to send gifts')) return;
    openModal((close) => {
      const cats = [...new Set(gifts.map((g) => g.category || 'Gifts'))];
      let cat = cats[0];
      let picked = gifts.find((g) => (g.category || 'Gifts') === cat);
      let count = 1;
      const tabs = h('div.gs-tabs', { role: 'tablist' });
      const grid = h('div.gs-grid');
      const detail = h('div.gs-detail');
      const qty = h('div.seg.gs-qty');
      const sendBtn = h('button.btn.btn-primary.gs-send', { type: 'button' });
      const paint = () => {
        tabs.replaceChildren(...cats.map((c) => h(`button.gs-tab${c === cat ? '.active' : ''}`, { type: 'button', role: 'tab', 'aria-selected': String(c === cat), onclick: () => { cat = c; picked = gifts.find((g) => (g.category || 'Gifts') === c); paint(); } }, c)));
        grid.replaceChildren(...gifts.filter((g) => (g.category || 'Gifts') === cat).map((g) => h(`button.gs-cell.t${g.tier}${g === picked ? '.active' : ''}`, { type: 'button', 'aria-pressed': String(g === picked), 'aria-label': `${g.name}, ${g.coins} coins`, onclick: () => { picked = g; paint(); } },
          h('img.gs-art', { src: g.art, alt: '', loading: 'lazy' }), h('span.gs-name', g.name), h('span.gs-price', coinIcon(11), fmtCount(g.coins)))));
        detail.replaceChildren(h('img', { src: picked.art, alt: '' }), h('div', h('b', picked.name), h('p.muted.small', picked.description || ''), h('span.gs-tier', ['', 'Classic', 'Popular', 'Premium', 'Spectacular', 'Legendary'][picked.tier] || '')));
        qty.replaceChildren(...QUANTITIES.map((n) => h(`button.seg-btn${n === count ? '.active' : ''}`, { type: 'button', onclick: () => { count = n; paint(); } }, `×${n}`)));
        sendBtn.replaceChildren(h('span', 'Send'), h('span.gs-cost', coinIcon(14), fmtCount(picked.coins * count)));
      };
      sendBtn.addEventListener('click', async () => {
        sendBtn.disabled = true;
        const ok = await sendGift(picked, count);
        sendBtn.disabled = false;
        if (ok && picked.tier >= 3) close();
      });
      paint();
      return h('div.gift-sheet', tabs, grid, detail,
        h('div.gs-foot', coinBalance({ onClick: () => { close(); openRecharge(); } }), qty, sendBtn),
        h('p.gs-note', 'Gifts are sent straight away and support the creator. They can’t be undone.'));
    }, { title: 'Send a gift', className: 'modal-md gift-modal', sheet: true });
  }
  const giftBtn = !isHost && gifts.length ? h('button.lv-action.lv-gift-btn', { type: 'button', 'aria-label': 'Send a gift', title: 'Gifts', onclick: giftSheet }, icon('gift', { size: 22 })) : null;
  // Quick strip of the cheapest gifts for one-tap sending
  const quick = !isHost && gifts.length ? h('div.lv-quick', gifts.slice(0, 4).map((g) => h('button.lv-quick-gift', { type: 'button', title: `${g.name} · ${g.coins} coin${g.coins === 1 ? '' : 's'}`, 'aria-label': `Send ${g.name} for ${g.coins} coins`, onclick: () => sendGift(g) },
    h('img', { src: g.art, alt: '' }), h('span', coinIcon(10), fmtCount(g.coins))))) : null;

  const actions = h('div.lv-actions', modBtn, giftBtn, isHost ? null : likeBtn, shareBtn);
  const el = h('div.lv-room', fxHost, hearts,
    h('div.lv-top-extra', goalEl, pinnedEl),
    h('div.lv-bottom', flags, chat, quick, statsBar, h('div.lv-bar', form, actions)));
  paintSettings();

  return {
    el,
    stats: statsBar,
    addChat,
    setViewers: sViewers.set,
    paintLeaders: () => {},
    destroy() { subs.forEach((u) => u()); clearTimeout(likeTimer); clearTimeout(joinTimer); clearInterval(clock); fx.destroy(); },
  };
}
