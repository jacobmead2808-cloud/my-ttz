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
          h('p.muted.small', 'Cash withdrawals need a payout provider (e.g. Stripe Connect) — not configured.'))));
  }
  if (orderId) {
    try {
      const r = await api.get(`/coins/orders/${orderId}`);
      toast(r.order.status === 'paid' ? `${fmtCount(r.order.coins)} coins added!` : 'Payment is processing — coins appear once it’s confirmed.', { type: r.order.status === 'paid' ? 'success' : 'info' });
    } catch { /* ignore */ }
  }
  await load();
  return { el: h('div.settings-page', h('h1.page-title', coinIcon(28), ' Wallet'), body), title: 'Wallet' };
}
