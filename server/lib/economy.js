'use strict';
/**
 * Virtual economy: coins (bought by viewers), gifts (sent in LIVE), diamonds (earned by creators).
 * Prices, packages and discounts live in app_settings ('economy') and are owner-editable.
 */
const { q, tx, now } = require('../db');
const settings = require('./settings');
const { bad } = require('./errors');

/**
 * Gift catalogue: original Clipzy gifts. Artwork lives in public/assets/gifts/<id>.svg.
 * tier 1-5 sets how big the on-screen effect is; `effect` picks the animation in the viewer.
 * Ids are permanent (past gift records refer to them); names, art and effects can change.
 */
const G = (id, name, coins, category, effect, description) => {
  const tier = coins <= 10 ? 1 : coins <= 199 ? 2 : coins <= 999 ? 3 : coins <= 4999 ? 4 : 5;
  return { id, name, coins, tier, category, effect, description, art: `/assets/gifts/${id}.svg` };
};
const GIFTS = [
  G('rose', 'Petal', 1, 'Classic', 'float', 'A single petal to say hi.'),
  G('cloud-heart', 'Cloud Heart', 1, 'Classic', 'float', 'A soft heart that drifts up.'),
  G('sparkle', 'Spark', 1, 'Classic', 'float', 'A quick spark of appreciation.'),
  G('kiss', 'Wave Hello', 5, 'Classic', 'float', 'Wave at the host.'),
  G('gg', 'Good Game', 10, 'Classic', 'pop', 'For a great play.'),
  G('donut', 'Sprinkle Ring', 30, 'Fun', 'pop', 'A sweet treat with sprinkles.'),
  G('dice', 'Lucky Dice', 99, 'Fun', 'pop', 'Roll for luck.'),
  G('disco', 'Mirror Ball', 199, 'Fun', 'burst', 'Light up the room.'),
  G('crown', 'Royal Crown', 499, 'Premium', 'burst', 'Crown the host for the night.'),
  G('rocket', 'Liftoff', 999, 'Premium', 'burst', 'Send the stream into orbit.'),
  G('comet', 'Comet Trail', 1999, 'Premium', 'takeover', 'A comet streaks across the screen.'),
  G('treasure', 'Treasure Chest', 2599, 'Premium', 'takeover', 'Opens with a shower of coins.'),
  G('aurora', 'Aurora Sky', 4999, 'Legendary', 'takeover', 'Northern lights fill the screen.'),
  G('galaxy', 'Nebula', 9999, 'Legendary', 'legendary', 'A whole nebula, just for the host.'),
  G('orbit', 'Clipzy Orbit', 19999, 'Legendary', 'legendary', 'The rarest gift: planets in orbit around the host.'),
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

const MAX_GIFT_COUNT = 99;
const GIFT_ALERT_COINS = Number(process.env.GIFT_ALERT_COINS) || 50000;

/**
 * Send `count` of a gift from sender to receiver. Price and diamonds always come from the server
 * catalog. `clientRef` (a random id the sender's device makes per tap) makes retries safe: the same
 * ref is never charged twice. Returns { gift, count, totalCoins, diamonds, senderWallet, duplicate }.
 */
function sendGift({ senderId, receiverId, giftId, count = 1, streamId = null, clientRef = null }) {
  const gift = catalog().find((g) => g.id === giftId);
  if (!gift) throw bad('Unknown gift');
  if (!gift.enabled) throw bad('This gift is currently unavailable');
  if (senderId === receiverId) throw bad('You can’t send gifts to yourself');
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > MAX_GIFT_COUNT) throw bad(`You can send between 1 and ${MAX_GIFT_COUNT} at a time`);
  if (clientRef != null && !/^[A-Za-z0-9_-]{8,64}$/.test(String(clientRef))) throw bad('Invalid request id');
  const totalCoins = gift.coins * n;
  const diamonds = Math.floor(totalCoins * (economy().diamondRate || 0.5));
  return tx(() => {
    if (clientRef) {
      const prev = q.get('SELECT * FROM gift_events WHERE sender_id = ? AND client_ref = ?', senderId, String(clientRef));
      if (prev) return { gift: GIFTS.find((g) => g.id === prev.gift_id), count: prev.count, totalCoins: prev.coins, diamonds: prev.diamonds, senderWallet: wallet(senderId), duplicate: true };
    }
    const senderWallet = adjust(senderId, { coins: -totalCoins, type: 'gift_sent', ref: `${giftId}x${n}`, note: streamId ? `LIVE #${streamId}` : null });
    if (diamonds) adjust(receiverId, { diamonds, type: 'gift_received', ref: `${giftId}x${n}`, note: streamId ? `LIVE #${streamId}` : null });
    q.run('INSERT INTO gift_events (sender_id, receiver_id, stream_id, gift_id, count, coins, diamonds, client_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      senderId, receiverId, streamId, giftId, n, totalCoins, diamonds, clientRef ? String(clientRef) : null, now());
    if (streamId) q.run('UPDATE live_streams SET diamonds = diamonds + ? WHERE id = ?', diamonds, streamId);
    const lastHour = q.get('SELECT COALESCE(SUM(coins), 0) AS c FROM gift_events WHERE sender_id = ? AND created_at > ?', senderId, now() - 3600000).c;
    if (lastHour >= GIFT_ALERT_COINS && lastHour - totalCoins < GIFT_ALERT_COINS) {
      require('./security').record('gift.velocity', { userId: senderId, path: streamId ? `/live/${streamId}` : null }, `${lastHour} coins of gifts in the last hour`, { severity: 'info' });
    }
    return { gift, count: n, totalCoins, diamonds, senderWallet, duplicate: false };
  });
}

function topGifters(streamId, limit = 5) {
  return q.all(`SELECT u.id, u.username, u.display_name, u.avatar_url, SUM(g.coins) AS coins FROM gift_events g JOIN users u ON u.id = g.sender_id
    WHERE g.stream_id = ? GROUP BY u.id ORDER BY coins DESC LIMIT ?`, streamId, limit)
    .map((r) => ({ id: r.id, username: r.username, displayName: r.display_name || r.username, avatarUrl: r.avatar_url, coins: r.coins }));
}

module.exports = { MAX_GIFT_COUNT, GIFTS, catalog, packages, priceFor, wallet, adjust, sendGift, topGifters, economy, DEFAULT_ECONOMY };
