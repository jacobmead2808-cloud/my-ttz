// Wallet page: balance, diamonds, recharge, transaction history, Stripe return handling.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { fmtCount, fullDate } from '../lib/format.js';
import { store } from '../lib/store.js';
import { toast, toastError, loadingBlock, emptyState } from '../components/ui.js';
import { openRecharge, setWallet, coinIcon, openGiftGallery } from '../components/coins.js';

const TYPE = { purchase: 'Recharge', gift_sent: 'Gift sent', gift_received: 'Gift received', exchange: 'Exchange', admin_grant: 'Added by staff', admin_remove: 'Removed by staff' };

export default async function coinsPage(ctx) {
  const orderId = Number(ctx.query.get('order')) || null;
  const body = h('div.stack', loadingBlock());
  async function load() {
    const r = await api.get('/coins/transactions');
    setWallet(r.wallet);
    body.replaceChildren(
      h('div.wallet-cards',
        h('div.wallet-card.coins', h('span.muted', 'Coins'), h('b', coinIcon(26), fmtCount(r.wallet.coins)), h('button.btn.btn-primary', { onclick: () => openRecharge({ onDone: load }) }, 'Recharge')),
        h('div.wallet-card.diamonds', h('span.muted', 'LIVE rewards'), h('b', icon('diamond', { size: 26 }), fmtCount(r.wallet.diamonds)),
          h('div.row.gap', h('button.btn.btn-secondary', { disabled: !r.wallet.diamonds, onclick: async () => {
            try { const x = await api.post('/coins/exchange', { diamonds: r.wallet.diamonds }); setWallet(x.wallet); toast('Exchanged for coins', { type: 'success' }); load(); } catch (e) { toastError(e); }
          } }, 'Exchange for coins'), h('button.btn.btn-ghost', { onclick: () => openGiftGallery(store.me.username) }, icon('gift', { size: 16 }), ' My gift gallery')),
          h('p.muted.small', 'LIVE rewards can be exchanged for coins. Cash withdrawals aren’t available.'))));
  }
  const cancelled = Number(ctx.query.get('cancelled')) || null;
  if (cancelled) {
    api.post(`/coins/orders/${cancelled}/cancel`).catch(() => {});
    toast('Payment cancelled. You have not been charged.');
  }
  if (orderId) {
    // Stripe tells our server about the payment separately; wait briefly for that confirmation.
    (async () => {
      for (let i = 0; i < 12; i++) {
        let r;
        try { r = await api.get(`/coins/orders/${orderId}`); } catch { return; }
        const st = r.order.status;
        if (st === 'paid') { setWallet(r.wallet); toast(`${fmtCount(r.order.coins)} coins added`, { type: 'success' }); load(); return; }
        if (['failed', 'expired', 'cancelled', 'refunded', 'disputed'].includes(st)) { toast('The payment didn’t go through. You have not been charged.', { type: 'error' }); return; }
        await new Promise((res) => setTimeout(res, 2500));
      }
      toast('Your payment is still being confirmed. Coins appear automatically once it is.', { type: 'info' });
    })();
  }
  await load();
  return { el: h('div.settings-page', h('h1.page-title', coinIcon(28), ' Wallet'), body), title: 'Wallet' };
}
