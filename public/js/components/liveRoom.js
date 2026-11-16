// Shared LIVE room UI: chat with roles + moderation, pinned message, floating hearts/reactions,
// viewer + like counters, and the host/moderator control panel.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { ws } from '../lib/ws.js';
import { store } from '../lib/store.js';
import { fmtCount } from '../lib/format.js';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';
import { requireLogin, toast, toastError, actionSheet, openModal, avatar } from './ui.js';
import { reportDialog } from './social.js';
import { coinIcon, coinBalance, openRecharge, setWallet } from './coins.js';

const ROLE_LABEL = { host: 'Host', mod: 'Mod', admin: 'Staff' };

export function liveRoom(streamId, { isHost = false, role: initialRole = isHost ? 'host' : 'viewer', reactions = ['', '', '', '', '', ''], slowOptions = [0, 3, 10, 30, 60], gifts = [], leaders: initialLeaders = [], onGift } = {}) {
  const subs = [];
  let role = initialRole;
  let settings = { slowMode: 0, followersOnly: false, pinned: null };
  let mutedUntil = null;
  const canMod = () => role === 'host' || role === 'mod' || role === 'admin';
  const send = (type, data = {}) => ws.send(type, { streamId, ...data });
  const mod = (action, data = {}) => send('live:mod', { action, ...data });

  const viewers = h('span.live-viewers', icon('eye', { size: 14 }), h('b', '0'));
  const likes = h('span.live-likes', icon('heart', { size: 14, filled: true }), h('b', '0'));
  const chat = h('div.live-chat', { role: 'log', 'aria-live': 'polite' });
  const floatLayer = h('div.float-layer');
  const pinnedEl = h('div.live-pinned.hidden');
  const flags = h('div.live-flags');
  const goalEl = h('div.live-goal.hidden');
  const leadersEl = h('div.live-leaders');
  const giftLayer = h('div.gift-layer');
  const bigGift = h('div.big-gift');
  const paintLeaders = (list) => leadersEl.replaceChildren(...(list || []).slice(0, 3).map((u, i) => h('span.leader', { title: `${u.displayName}: ${u.coins} coins` },
    avatar({ username: u.username, avatarUrl: u.avatarUrl }, 26, { link: false }), h('span.leader-rank', String(i + 1)))));
  paintLeaders(initialLeaders);
  function paintGoal(goal) {
    if (!goal) { goalEl.classList.add('hidden'); return; }
    const pct = Math.min(100, Math.round((goal.progress / Math.max(goal.target, 1)) * 100));
    const label = goal.label || (goal.type === 'likes' ? 'Like goal' : goal.type === 'gifts' ? 'Gift goal' : 'Follower goal');
    const unit = goal.type === 'gifts' ? ' coins' : goal.type === 'likes' ? ' likes' : ' followers';
    goalEl.replaceChildren(h('div.goal-top', h('b', icon('target', { size: 13 }), pct >= 100 ? ` ${label} reached` : ` ${label}`), h('span', `${fmtCount(goal.progress)}/${fmtCount(goal.target)}${unit}`)),
      h('div.goal-bar', h('div.goal-fill', { style: { width: `${pct}%` } })));
    goalEl.classList.remove('hidden');
    goalEl.classList.toggle('done', pct >= 100);
  }
  const combos = new Map();
  function showGift(m) {
    if (m.gift.tier >= 3) {
      const el = h('div.big-gift-inner', h('span.big-gift-art', m.gift.art), h('b', `${m.user.displayName} sent ${m.gift.name}${m.count > 1 ? ` ×${m.count}` : ''}`));
      bigGift.replaceChildren(el);
      bigGift.classList.remove('show'); void bigGift.offsetWidth; bigGift.classList.add('show');
      setTimeout(() => bigGift.classList.remove('show'), 3200);
    }
    const key = `${m.user.id}:${m.gift.id}`;
    let c = combos.get(key);
    if (c) { c.count += m.count; c.el.querySelector('.combo-count').textContent = `×${c.count}`; c.el.classList.remove('bump'); void c.el.offsetWidth; c.el.classList.add('bump'); clearTimeout(c.t); }
    else {
      c = { count: m.count, el: h('div.gift-combo', avatar({ username: m.user.username, avatarUrl: m.user.avatarUrl }, 30, { link: false }),
        h('div.combo-text', h('b', m.user.displayName), h('span', `sent ${m.gift.name}`)), h('span.combo-art', m.gift.art), h('b.combo-count', `×${m.count}`)) };
      combos.set(key, c);
      giftLayer.appendChild(c.el);
      while (giftLayer.children.length > 3) giftLayer.firstChild.remove();
    }
    c.t = setTimeout(() => { c.el.classList.add('out'); setTimeout(() => c.el.remove(), 400); combos.delete(key); }, 3500);
    addChat({ id: null, text: `sent ${m.gift.art} ${m.gift.name}${m.count > 1 ? ` ×${m.count}` : ''}`, user: { ...m.user, role: 'gift' }, gift: true });
  }

  const setViewers = (n) => { viewers.querySelector('b').textContent = fmtCount(n); };
  const setLikes = (n) => { likes.querySelector('b').textContent = fmtCount(n); };

  function paintSettings() {
    if (settings.pinned) {
      pinnedEl.replaceChildren(icon('flag', { size: 14 }), h('div', h('b', `${settings.pinned.user.displayName}: `), settings.pinned.text),
        canMod() ? h('button', { 'aria-label': 'Unpin', onclick: () => mod('unpin') }, icon('close', { size: 14 })) : '');
      pinnedEl.classList.remove('hidden');
    } else pinnedEl.classList.add('hidden');
    flags.replaceChildren(...[
      settings.slowMode ? h('span.live-flag', icon('clock', { size: 11 }), ` Slow mode ${settings.slowMode}s`) : null,
      settings.followersOnly ? h('span.live-flag', icon('users', { size: 11 }), ' Followers-only chat') : null,
      mutedUntil ? h('span.live-flag', icon('mute', { size: 11 }), ' You are muted') : null,
      canMod() ? h('span.live-flag', icon('shield', { size: 11 }), ` ${ROLE_LABEL[role]}`) : null].filter(Boolean));
    input.placeholder = !store.me ? 'Log in to chat' : mutedUntil ? 'You are muted' : 'Add comment...';
    modBtn.classList.toggle('hidden', !canMod());
  }

  function messageActions(m) {
    const self = store.me && m.user.id === store.me.id;
    const targetIsHost = m.user.role === 'host';
    const items = [
      { label: `View @${m.user.username}`, icon: 'user', onClick: () => window.open(`/@${m.user.username}`, '_blank') },
    ];
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

  function addChat(m, system = false) {
    let row;
    if (system) row = h('div.chat-row.system', m);
    else {
      const badge = ROLE_LABEL[m.user.role] ? h(`span.role-badge.${m.user.role}`, ROLE_LABEL[m.user.role]) : null;
      row = h(`div.chat-row${m.filtered ? '.filtered' : ''}${m.gift ? '.gift-row' : ''}`, { dataset: { id: m.id || '' } },
        badge, h('b.chat-user', m.user.displayName || m.user.username), ' ', h('span', m.text),
        m.filtered ? h('div.small', { style: { color: 'var(--brand-3)' } }, 'Only visible to you (filtered)') : null);
      if (!m.filtered && !m.gift) {
        row.classList.add('clickable');
        row.addEventListener('click', () => messageActions(m));
      }
    }
    chat.appendChild(row);
    while (chat.children.length > 150) chat.firstChild.remove();
    chat.scrollTop = chat.scrollHeight;
  }

  function floatEmoji() {
    const el = h('span.float-emoji.float-heart', icon('heart', { size: 26, filled: true }));
    el.style.left = `${20 + Math.random() * 50}%`;
    el.style.setProperty('--drift', `${Math.random() * 60 - 30}px`);
    floatLayer.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  const mine = (m) => m.streamId === streamId;
  subs.push(ws.on('live:viewers', (m) => mine(m) && setViewers(m.count)));
  subs.push(ws.on('live:state', (m) => {
    if (!mine(m)) return;
    setViewers(m.viewers);
    setLikes(m.likes);
    if (m.role) role = m.role;
    mutedUntil = m.mutedUntil || null;
    paintSettings();
  }));
  subs.push(ws.on('live:settings', (m) => { if (mine(m)) { settings = m; paintSettings(); paintGoal(m.goal); } }));
  subs.push(ws.on('live:gift', (m) => { if (!mine(m)) return; paintLeaders(m.leaders); showGift(m); onGift && onGift(m); }));
  subs.push(ws.on('live:chat', (m) => mine(m) && addChat(m.message)));
  subs.push(ws.on('live:system', (m) => mine(m) && addChat(m.text, true)));
  subs.push(ws.on('live:chat-deleted', (m) => { if (mine(m)) chat.querySelector(`.chat-row[data-id="${m.messageId}"]`)?.remove(); }));
  subs.push(ws.on('live:joined', (m) => mine(m) && addChat(`@${m.user.username} joined`, true)));
  subs.push(ws.on('live:muted', (m) => { if (mine(m)) { mutedUntil = m.until || -1; paintSettings(); toast(m.until ? 'You were muted for a few minutes by a moderator' : 'You were muted for this LIVE', { type: 'error' }); } }));
  subs.push(ws.on('live:unmuted', (m) => { if (mine(m)) { mutedUntil = null; paintSettings(); toast('You can chat again'); } }));
  subs.push(ws.on('live:role', (m) => { if (mine(m)) { role = m.role; paintSettings(); toast(m.role === 'mod' ? 'You are now a moderator of this LIVE' : 'You are no longer a moderator'); } }));
  subs.push(ws.on('live:like', (m) => {
    if (!mine(m)) return;
    setLikes(m.total);
    if (m.from === ws.connId) return; // already animated locally
    for (let i = 0; i < Math.min(m.count, 5); i++) setTimeout(() => floatEmoji(), i * 120);
  }));
  subs.push(ws.on('live:react', (m) => mine(m) && floatEmoji()));
  subs.push(ws.on('live:error', (m) => mine(m) && toast(m.message, { type: 'error' })));

  // composer
  const input = h('input.live-input', { placeholder: store.me ? 'Add comment...' : 'Log in to chat', maxlength: 200, 'aria-label': 'Chat message' });
  input.addEventListener('focus', () => { if (!store.me) { input.blur(); requireLogin('Log in to chat in LIVE'); } });
  const form = h('form.live-composer', {
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
  const likeBtn = h('button.live-action.live-like-btn', { type: 'button', 'aria-label': 'Send likes', onclick: () => {
    floatEmoji();
    pendingLikes++;
    if (!likeTimer) likeTimer = setTimeout(() => { send('live:like', { count: pendingLikes }); pendingLikes = 0; likeTimer = null; }, 400);
  } }, icon('heart', { size: 26, filled: true }));
  const reactBar = null; // emoji reactions removed — likes (hearts) and gifts only

  function openModPanel() {
    openModal((close) => {
      const slow = h('div.seg', slowOptions.map((s) => h(`button.seg-btn${settings.slowMode === s ? '.active' : ''}`, { onclick: () => { mod('slow', { seconds: s }); close(); } }, s ? `${s}s` : 'Off')));
      const fo = h('label.switch', h('input', { type: 'checkbox', checked: settings.followersOnly, onchange: (e) => mod('followers_only', { value: e.target.checked }) }), h('span.slider'), h('span.switch-label', 'Followers-only chat'));
      return h('div.mod-panel',
        h('h4', 'Slow mode'), slow,
        h('h4', 'Chat'), fo,
        settings.pinned ? h('button.btn.btn-secondary', { onclick: () => { mod('unpin'); close(); } }, 'Unpin message') : null,
        h('p.muted.small', 'Tap any chat message to pin, delete, mute or remove its sender. Keyword filters and your moderator list live in Settings → Moderation.'),
        role === 'host' ? h('button.btn.btn-ghost', { onclick: () => { close(); navigate('/settings?tab=moderation'); } }, icon('settings', { size: 16 }), ' Moderation settings') : null);
    }, { title: 'LIVE moderation', className: 'modal-sm' });
  }
  const modBtn = h('button.live-action.hidden', { type: 'button', 'aria-label': 'Moderation tools', title: 'Moderation tools', onclick: openModPanel }, icon('shield', { size: 22 }));

  // seed recent chat history
  api.get(`/live/${streamId}/chat`).then(({ messages }) => messages.forEach((m) => addChat(m))).catch(() => {});

  // ---------- gift bar ----------
  let giftBar = null;
  const balance = !isHost && store.me ? coinBalance({ onClick: () => openRecharge() }) : null;
  async function sendGift(g, count = 1) {
    if (!requireLogin('Log in to send gifts')) return;
    try {
      const r = await api.post(`/live/${streamId}/gift`, { giftId: g.id, count });
      setWallet(r.wallet);
    } catch (e) {
      if (e.data && e.data.needCoins) { toast(e.message, { type: 'error' }); openRecharge({ need: e.data.needCoins }); } else toastError(e);
    }
  }
  function giftGallery() {
    openModal((close) => {
      let picked = gifts[0];
      let count = 1;
      const grid = h('div.gift-grid');
      const sendBtn = h('button.btn.btn-primary.btn-block');
      const paint = () => {
        grid.replaceChildren(...gifts.map((g) => h(`button.gift-cell${g === picked ? '.active' : ''}`, { type: 'button', onclick: () => { picked = g; paint(); } },
          h('span.gift-art', g.art), h('span.gift-name', g.name), h('span.gift-price', coinIcon(12), fmtCount(g.coins)))));
        sendBtn.textContent = `Send ${picked.name}${count > 1 ? ` ×${count}` : ''} · ${fmtCount(picked.coins * count)} coins`;
      };
      const counts = h('div.seg', [1, 5, 10, 99].map((n) => h(`button.seg-btn${n === count ? '.active' : ''}`, { type: 'button', onclick: (e) => {
        count = n; counts.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active')); e.currentTarget.classList.add('active'); paint();
      } }, `×${n}`)));
      sendBtn.addEventListener('click', async () => { await sendGift(picked, count); close(); });
      paint();
      return h('div.stack', grid, h('div.row.gap', h('span.muted.small', 'Quantity'), counts), sendBtn, coinBalance({ onClick: () => { close(); openRecharge(); } }));
    }, { title: 'Gifts', className: 'modal-md', sheet: true });
  }
  if (!isHost && gifts.length) {
    giftBar = h('div.gift-bar',
      h('p.gift-note', 'Gifts are sent immediately and support the creator. Each coin costs about £0.01.'),
      h('div.gift-strip', gifts.slice(0, 6).map((g) => h('button.gift-btn', { type: 'button', title: `${g.name} · ${g.coins} coins`, onclick: () => sendGift(g) },
        h('span.gift-art', g.art), h('span.gift-name', g.name), h('span.gift-price', coinIcon(12), fmtCount(g.coins))))),
      h('button.gift-more', { type: 'button', onclick: giftGallery }, icon('chevronUp', { size: 18 }), h('span', 'More')),
      balance);
  }

  const actions = h('div.live-actions', modBtn, isHost ? null : likeBtn);
  const el = h('div.live-room', floatLayer, giftLayer, bigGift, h('div.live-top-extra', goalEl), h('div.live-bottom', flags, pinnedEl, chat, h('div.live-bottom-row', form, actions), reactBar));
  paintSettings();

  return {
    el,
    stats: h('div.live-stats', leadersEl, viewers, likes),
    giftBar,
    addChat,
    setViewers,
    destroy() { subs.forEach((u) => u()); clearTimeout(likeTimer); if (balance && balance.cleanup) balance.cleanup(); },
  };
}
