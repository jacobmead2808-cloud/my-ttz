// Coins: wallet state, recharge sheet, gift gallery.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { ws } from '../lib/ws.js';
import { store, emit, on } from '../lib/store.js';
import { fmtCount } from '../lib/format.js';
import { toast, toastError, openModal, loadingBlock, errorState, avatar, requireLogin } from './ui.js';
import { isNativeApp } from '../lib/push.js';

export const coinIcon = (size = 16) => h('span.coin', { style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.6)}px` } }, 'C');

export function money(cents, currency = 'GBP') {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100); } catch { return `${(cents / 100).toFixed(2)} ${currency}`; }
}

export function setWallet(w) { store.wallet = w; emit('wallet', w); }
export async function loadWallet() {
  if (!store.me) return null;
  try { const r = await api.get('/coins'); setWallet(r.wallet); return r; } catch { return null; }
}
ws.on('wallet', (m) => setWallet(m.wallet));

/** Small live-updating coin balance pill. */
export function coinBalance({ onClick } = {}) {
  const val = h('b', fmtCount((store.wallet && store.wallet.coins) || 0));
  const el = h('button.coin-balance', { type: 'button', onclick: onClick || (() => openRecharge()) }, coinIcon(16), val, h('span.coin-recharge', 'Recharge'));
  const off = on('wallet', (w) => { val.textContent = fmtCount((w && w.coins) || 0); });
  el.cleanup = off;
  if (!store.wallet) loadWallet();
  return el;
}

/** Recharge sheet: packages, custom amount, owner discount, exchange LIVE rewards. */
export function openRecharge({ onDone, need = 0 } = {}) {
  if (!requireLogin('Log in to buy coins')) return;
  openModal((close) => {
    const body = h('div.recharge', loadingBlock());
    (async () => {
      let info;
      try { info = await api.get('/coins'); setWallet(info.wallet); } catch (e) { body.replaceChildren(errorState(e)); return; }
      const inApp = isNativeApp() && info.paymentMode === 'stripe';
      let selected = info.packages.find((p) => p.coins >= Math.max(need, 1)) || info.packages[0];
      let custom = null;
      const buyBtn = h('button.btn.btn-primary.btn-lg.btn-block.buy-btn');
      const paintBuy = () => {
        const cents = custom ? Math.max(1, Math.round(custom * info.centsPerCoin * (1 - (info.discount ? info.discount.percent : 0) / 100))) : selected.priceCents;
        buyBtn.replaceChildren(icon('shield', { size: 18 }), ` Buy for ${money(cents, info.currency)}`);
        buyBtn.disabled = inApp || info.paymentMode === 'disabled' || (custom !== null && (custom < 30 || custom > 250000));
      };
      const grid = h('div.pkg-grid');
      const customInput = h('input.input.pkg-custom-input.hidden', { type: 'number', min: 30, max: 250000, placeholder: 'Coins (30–250,000)' });
      customInput.addEventListener('input', () => { custom = Number(customInput.value) || 0; paintBuy(); });
      const paintGrid = () => grid.replaceChildren(
        ...info.packages.map((p) => h(`button.pkg${!custom && selected === p ? '.active' : ''}`, { type: 'button', onclick: () => { selected = p; custom = null; customInput.classList.add('hidden'); paintGrid(); paintBuy(); } },
          h('span.pkg-coins', coinIcon(18), fmtCount(p.coins)),
          h('span.pkg-price', p.basePriceCents !== p.priceCents ? h('s.muted', money(p.basePriceCents, info.currency)) : null, ' ', money(p.priceCents, info.currency)))),
        h(`button.pkg.pkg-custom${custom !== null ? '.active' : ''}`, { type: 'button', onclick: () => { custom = custom || 1500; customInput.value = custom; customInput.classList.remove('hidden'); customInput.focus(); paintGrid(); paintBuy(); } }, h('b', 'Custom')));
      paintGrid();
      paintBuy();
      buyBtn.addEventListener('click', async () => {
        buyBtn.disabled = true;
        try {
          const r = await api.post('/coins/checkout', { coins: custom || selected.coins });
          // Coins are added only after Stripe confirms the payment to our server.
          location.href = r.url;
        } catch (e) { toastError(e); paintBuy(); }
      });
      const w = info.wallet;
      body.replaceChildren(...[
        h('div.recharge-head', h('div', h('h3', 'Recharge'), h('div.muted.small', 'Balance: ', coinIcon(14), ` ${fmtCount(w.coins)} coins`)),
          h('a.link.small', { href: '/coins', onclick: () => close() }, 'Open wallet ', icon('chevronRight', { size: 12 }))),
        info.discount ? h('div.recharge-sale', `${info.discount.label || 'Sale'}: save ${info.discount.percent}% on every pack`) : null,
        info.paymentMode === 'disabled' ? h('div.recharge-note', icon('alert', { size: 14 }), ' Buying coins isn’t available yet. Your balance and gifts still work.') : null,
        inApp ? h('div.recharge-note', icon('alert', { size: 14 }), ' Coins can’t be bought inside the Android app. Your balance and gifts work as normal.') : null,
        grid, customInput,
        w.diamonds ? h('button.recharge-row', { type: 'button', onclick: async () => {
          try { const r = await api.post('/coins/exchange', { diamonds: w.diamonds }); setWallet(r.wallet); toast(`Exchanged ${w.diamonds} diamonds for coins`, { type: 'success' }); close(); } catch (e) { toastError(e); }
        } }, h('span', 'Exchange LIVE rewards'), h('span.muted', `${fmtCount(w.diamonds)} diamonds → ${fmtCount(w.diamonds)} coins`), icon('chevronRight', { size: 14 })) : null,
        h('p.muted.small', 'Coins are used to send Gifts in LIVE. Gifts are sent immediately and can’t be refunded.'),
        buyBtn].filter(Boolean));
    })();
    return body;
  }, { title: '', className: 'modal-sm recharge-modal', sheet: true });
}

/** Gift gallery modal for a creator. */
export function openGiftGallery(username) {
  openModal(() => {
    const box = h('div.gallery', loadingBlock());
    api.get(`/coins/gallery/${encodeURIComponent(username)}`).then((g) => {
      box.replaceChildren(
        h('div.gallery-head', h('b', `${g.collected}/${g.total} gifts collected`), h('div.gallery-bar', h('div', { style: { width: `${(g.collected / g.total) * 100}%` } }))),
        h('div.gallery-grid', g.gifts.map((x) => h(`div.gallery-item${x.received ? '' : '.locked'}`, h('img.gift-art', { src: x.art, alt: '' }), h('b', x.name),
          h('span.small', x.received ? `×${fmtCount(x.received)}` : 'Not yet'), h('span.muted.small', coinIcon(12), ` ${fmtCount(x.coins)}`)))),
        g.supporters.length ? h('div', h('h4.share-sub', 'Top supporters'), h('div.user-list', g.supporters.map((u, i) => h('a.user-row', { href: `/@${u.username}` },
          h('span.rank', `#${i + 1}`), avatar(u, 36, { link: false }), h('div.user-row-text', h('div.user-row-name', u.displayName), h('div.user-row-sub.muted', `${fmtCount(u.coins)} coins gifted`)))))) : h('p.muted.small', 'No gifts yet — send one in their next LIVE!'));
    }).catch((e) => box.replaceChildren(errorState(e)));
    return box;
  }, { title: `Gift gallery · @${username}`, className: 'modal-md' });
}
