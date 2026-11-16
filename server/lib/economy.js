'use strict';
/**
 * Virtual economy: coins (bought by viewers), gifts (sent in LIVE), diamonds (earned by creators).
 * Prices, packages and discounts live in app_settings ('economy') and are owner-editable.
 */
const { q, tx, now } = require('../db');
const settings = require('./settings');
const { bad } = require('./errors');

/** Gift catalog. Emoji are placeholders — swap `art` for image URLs later. */
const GIFTS = [
  { id: 'rose', name: 'Rose', art: '🌹', coins: 1, tier: 1 },
  { id: 'cloud-heart', name: 'Cloud Heart', art: '💗', coins: 1, tier: 1 },
  { id: 'sparkle', name: 'Sparkle', art: '✨', coins: 1, tier: 1 },
  { id: 'kiss', name: 'Air Kiss', art: '💋', coins: 5, tier: 1 },
  { id: 'gg', name: 'GG', art: '🎮', coins: 10, tier: 1 },
  { id: 'donut', name: 'Donut', art: '🍩', coins: 30, tier: 2 },
  { id: 'dice', name: 'Lucky Dice', art: '🎲', coins: 99, tier: 2 },
  { id: 'disco', name: 'Disco Ball', art: '🪩', coins: 199, tier: 2 },
  { id: 'crown', name: 'Crown', art: '👑', coins: 499, tier: 3 },
  { id: 'rocket', name: 'Rocket', art: '🚀', coins: 999, tier: 3 },
  { id: 'treasure', name: 'Treasure Chest', art: '🧰', coins: 2599, tier: 3 },
  { id: 'galaxy', name: 'Galaxy', art: '🌌', coins: 9999, tier: 4 },
];

const DEFAULT_ECONOMY = {
  currency: 'GBP',
  packages: [
    { coins: 30, priceCents: 29 }, { coins: 100, priceCents: 99 }, { coins: 150, priceCents: 145 }, { coins: 200, priceCents: 195 },
    { coins: 350, priceCents: 339 }, { coins: 500, priceCents: 485 }, { coins: 1000, priceCents: 965 },
  ],
  centsPerCoin: 1, // used for custom amounts
  discountPercent: 0, // owner-set sale, e.g. 25 = 25% off
  discountLabel: '',
  giftsEnabled: true,
  disabledGifts: [],
  diamondRate: 0.5, // diamonds earned per coin gifted
};
settings.DEFAULTS.economy = DEFAULT_ECONOMY;

const economy = () => settings.get('economy');

function priceFor(coins, basePriceCents) {
  const cfg = economy();
  const base = basePriceCents ?? Math.round(coins * cfg.centsPerCoin);
  const pct = Math.min(Math.max(Number(cfg.discountPercent) || 0, 0), 90);
  return Math.max(1, Math.round(base * (1 - pct / 100)));
}

function catalog() {
  const cfg = economy();
  return GIFTS.map((g) => ({ ...g, enabled: cfg.giftsEnabled && !cfg.disabledGifts.includes(g.id) }));
}

function packages() {
  const cfg = economy();
  return cfg.packages.map((p) => ({ coins: p.coins, basePriceCents: p.priceCents, priceCents: priceFor(p.coins, p.priceCents) }));
}

function wallet(userId) {
  q.run('INSERT OR IGNORE INTO wallets (user_id, updated_at) VALUES (?, ?)', userId, now());
  return q.get('SELECT coins, diamonds FROM wallets WHERE user_id = ?', userId);
}

/** Atomically adjust balances and record a transaction. Throws if a balance would go negative. */
function adjust(userId, { coins = 0, diamonds = 0, type, ref = null, note = null }) {
  return tx(() => {
    const w = wallet(userId);
    if (w.coins + coins < 0) throw bad('Not enough coins. Recharge to continue.', { needCoins: -coins - w.coins });
    if (w.diamonds + diamonds < 0) throw bad('Not enough diamonds');
    q.run('UPDATE wallets SET coins = coins + ?, diamonds = diamonds + ?, updated_at = ? WHERE user_id = ?', coins, diamonds, now(), userId);
    q.run('INSERT INTO coin_transactions (user_id, type, coins, diamonds, ref, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      userId, type, coins, diamonds, ref, note, now());
    return wallet(userId);
  });
}

/** Send `count` of a gift from sender to receiver. Returns { gift, totalCoins, diamonds, senderWallet }. */
function sendGift({ senderId, receiverId, giftId, count = 1, streamId = null }) {
  const gift = catalog().find((g) => g.id === giftId);
  if (!gift) throw bad('Unknown gift');
  if (!gift.enabled) throw bad('This gift is currently unavailable');
  if (senderId === receiverId) throw bad('You can’t send gifts to yourself');
  count = Math.min(Math.max(parseInt(count, 10) || 1, 1), 99);
  const totalCoins = gift.coins * count;
  const diamonds = Math.floor(totalCoins * (economy().diamondRate || 0.5));
  return tx(() => {
    const senderWallet = adjust(senderId, { coins: -totalCoins, type: 'gift_sent', ref: `${giftId}x${count}`, note: streamId ? `LIVE #${streamId}` : null });
    if (diamonds) adjust(receiverId, { diamonds, type: 'gift_received', ref: `${giftId}x${count}`, note: streamId ? `LIVE #${streamId}` : null });
    q.run('INSERT INTO gift_events (sender_id, receiver_id, stream_id, gift_id, count, coins, diamonds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      senderId, receiverId, streamId, giftId, count, totalCoins, diamonds, now());
    if (streamId) q.run('UPDATE live_streams SET diamonds = diamonds + ? WHERE id = ?', diamonds, streamId);
    return { gift, count, totalCoins, diamonds, senderWallet };
  });
}

function topGifters(streamId, limit = 5) {
  return q.all(`SELECT u.id, u.username, u.display_name, u.avatar_url, SUM(g.coins) AS coins FROM gift_events g JOIN users u ON u.id = g.sender_id
    WHERE g.stream_id = ? GROUP BY u.id ORDER BY coins DESC LIMIT ?`, streamId, limit)
    .map((r) => ({ id: r.id, username: r.username, displayName: r.display_name || r.username, avatarUrl: r.avatar_url, coins: r.coins }));
}

module.exports = { GIFTS, catalog, packages, priceFor, wallet, adjust, sendGift, topGifters, economy, DEFAULT_ECONOMY };
