# Clipzy revamp: phase reports

## Phase 0: demo functionality removed, real paid features restored

**1. Demo / simulated systems found**
| Where | What it did |
|---|---|
| `server/routes/coins.js` (`paymentMode` = `demo`) | In development, "buying" coins credited them instantly with no payment ("demo coins"). |
| `public/js/components/coins.js`, `pages/admin.js` | "Demo mode" banners and "Get N demo coins" buttons. |
| `server/routes/admin.js` | A built-in verification key in development (`weluvjj`). |
| `server/scripts/bootstrap.js` | Production first boot generated a "placeholder" sound library (synthesised loops). |
| `server/lib/economy.js` | Gift catalogue marked "Emoji are placeholders" (gift artwork is replaced in Phase 2). |
| Gift sending | Quantities outside 1–99 were silently clamped instead of rejected; a retried request could charge twice. |
| Stripe webhook | Handled only `checkout.session.completed`: no refunds, disputes, failed or expired payments, no amount check, no event de-duplication. |

**2. Features intended to be paid:** coin purchases (coins are then spent on gifts). Creator diamonds are
earned from gifts and can be exchanged for coins. Cash withdrawals were never built (they need Stripe
Connect and business/tax setup), so nothing simulated them.

**3. Restored / rebuilt**
- Coin purchases use **Stripe Checkout only**:
  - the order is created on the server, and the price always comes from the server
  - Stripe is called with an idempotency key per order
  - coins are credited **only** from a webhook whose signature verifies (any `v1`, 5-minute tolerance), for a session this server created, when the charged amount and currency match the order
  - every Stripe event is processed once (`stripe_events` table)
- Payment states handled: paid, processing (bank payments), failed, expired, cancelled by the buyer,
  **refunded** and **disputed**. Refunds and disputes take the coins back, never below zero; a
  shortfall is recorded on the order and logged for staff.
- Gifts: price and diamonds always come from the server catalogue. Quantity must be a whole number
  1–99 (otherwise rejected). Each tap carries a random request id, so a retried request is never
  charged twice. All balance changes happen in one database transaction.
- Verification badges need your own `VERIFY_KEY` everywhere (no built-in key); the key is compared in
  constant time.

**4. Removed:** demo coin mode (and `COINS_DEMO_MODE`), demo banners and buttons, the built-in verify
key, and placeholder sounds on production first boot. The demo seed (`npm run seed`) stays as a
development tool; it refuses to run in production.

**5. Real payment integrations working:** Stripe Checkout + webhooks. Tested end to end against a local
stand-in for Stripe's API using Stripe's exact signing scheme. **Not yet tested with a real Stripe
account** (needs your keys).

**6. Configuration still required (you):**
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
- a Stripe webhook to `https://<your-site>/api/coins/webhook` with these events:
  - `checkout.session.completed`
  - `checkout.session.async_payment_succeeded`
  - `checkout.session.async_payment_failed`
  - `checkout.session.expired`
  - `charge.refunded`
  - `charge.dispute.created`

Until both keys are set, buying coins shows "isn't available yet"; balances and gifts keep working.

**7. Tests:** 53 automated tests pass. New ones cover:
- no coins without Stripe
- the server-side price is sent to Stripe
- returning from checkout credits nothing
- forged signature, wrong session or wrong amount credit nothing
- triple-delivered and re-sent events credit once
- cancel and expiry
- refunds, once, never below zero
- gift quantity validation
- client-sent prices ignored
- retried gift requests charged once
- balances unchanged after a failed gift

The local database was backed up first (`data/manual-backups/app-before-phase0-*.db`).

## Phase 1: design, typography and layout

**Changed**
- New design system `public/css/design.css`, loaded last so every page shares it:
  - one neutral graphite palette with the Clipzy blue accent (no purple or pink tokens left in use)
  - light and dark themes
  - spacing, radius and type scales
  - consistent buttons (primary, secondary, ghost, danger; 3 sizes), inputs, selects, switches, cards,
    chips, tabs, segmented controls, tables, modals and toasts
  - visible keyboard focus rings
  - `prefers-reduced-motion` support
- **Typography:** Inter (self-hosted variable font, SIL OFL licence in `public/fonts/`), with a single
  type scale and weights. Long names, captions and comments wrap or truncate instead of overflowing.
- **Fixes found while testing at 1440×900 (desktop), 834×1112 (tablet) and 390×844 (phone):**
  - login and sign-up had a blank top half
  - profile tab labels overlapped their icons on phones
  - profile buttons wrapped into 3 rows on phones (now one row, with icon buttons)
  - sidebar search placeholder was cut off
  - counts on the single-video page were nearly invisible
  - wallet cards were misaligned
  - settings cards had uneven spacing
  - name and handle were cramped on phones
- **Privacy:** emails no longer appear next to usernames anywhere, including the admin user list; staff
  see the account email only on the account's detail page. Public API responses contain no emails
  (checked).
- **Demo functionality also found and removed in this phase:** the "test pattern" fake camera in LIVE
  Studio and Duet/Stitch. You now need a real camera, screen share or a clip from your device.
- The development seed's sample avatars use muted colours to match.

**Files:**
- `public/css/design.css` (new), `public/fonts/*` (new)
- `public/index.html`, `public/sw.js`, `public/js/app.js`
- `public/js/components/social.js`, `public/js/pages/profile.js`, `public/js/pages/admin.js`,
  `public/js/pages/adminUser.js`
- `public/js/pages/liveStudio.js`, `public/js/pages/remix.js`, `public/js/lib/livestream.js`
- `server/seed.js`

**Tests:** 53 automated tests pass. I reviewed full-resolution screenshots of feed, profile, settings,
explore, activity, messages, upload, wallet, video page, admin, search and login, in light and dark
themes, at three screen sizes.

**Not finished:** the older stylesheets still exist underneath. `design.css` overrides them, but merging
them into one file is cleanup left for later. The LIVE screens are redesigned in Phase 2.

## Phase 2: LIVE and virtual gifting

**Research:** popular platforms price gifts from 1 coin up to tens of thousands of coins (for example
29,999 and 44,999 for the top gifts on TikTok). Higher-value gifts get larger, longer on-screen
effects. Clipzy's gifts are original: own names, own vector artwork, own animations and synthesised
sounds. No third-party gift assets are used.

**Gift catalogue** (`server/lib/economy.js`, art in `public/assets/gifts/`): 15 gifts in 4 categories, 5 tiers.
| Tier | Price range (coins) | Effect |
|---|---|---|
| 1 | 1–10 | artwork floats up the side, soft blip |
| 2 | 11–199 | artwork pops in with a chime |
| 3 | 200–999 | centre burst with particles, ring and sender banner |
| 4 | 1,000–4,999 | full-screen takeover: dimmed stage, hero artwork, particle burst and rain, banner |
| 5 | 5,000+ | legendary: orbit rings, shockwave, double burst, gold banner, longer sound |

- Every gift also shows a combo pill: sender, gift and a ×count that grows with repeats.
- Existing gift ids and prices are unchanged, so past gift records and galleries still work.
- Three new gifts: Comet Trail (1,999), Aurora Sky (4,999) and Clipzy Orbit (19,999).

**Effects engine** (`public/js/lib/giftFx.js`):
- Big effects play one at a time, most valuable first; the queue is capped at 6.
- Repeats from the same sender merge into one effect.
- Particles run on one canvas, capped at 260 (140 on phones), and pause in background tabs.
- Reduced-motion users get static presentations.
- Sounds are synthesised in the browser (no audio files). They can be switched off in the LIVE menu,
  and the setting is remembered.

**LIVE screen redesign** (`public/js/pages/liveWatch.js`, `public/js/components/liveRoom.js`, `public/css/live.css`):
- **Top:** host avatar, name and title, follow button, top-3 gifters, menu (gift sounds, copy link,
  report, staff end) and a clear exit (✕).
- **Bottom statistics bar:** watching, likes, gift coins received, duration. It sits above the comment
  bar, so it never covers the video centre, chat or controls.
- **Chat:**
  - messages animate in and fade out at the top
  - role badges (Host, Mod, Staff)
  - follow notices, gift messages, grouped join notices ("@a and 3 others joined")
  - tap a message for moderation actions
  - slow mode, followers-only, mute and kick as before
- **Composer row:** comment box, gift, like (floating hearts) and share.
- **Gifts:** quick one-tap gifts above the stats, and a full gift sheet with category tabs, artwork, price,
  description, tier, quantity (×1/5/10/99), balance with recharge, and a Send button showing the exact
  coin cost.
- **Phones:** full screen, with the tab bar hidden and safe areas respected.
- **LIVE Studio (host):** same room overlay and effects; gift feed with artwork; diamonds update instantly.

**Coin and diamond integrity** (server-side, from Phase 0, re-tested):
- price from the catalogue only; quantity 1–99
- balance checked in the same transaction that deducts coins and credits 50% diamonds
- the gift event is recorded and stream totals updated
- duplicate requests are ignored
- a failed gift leaves balances unchanged

**Tests:** 54 automated tests pass. New: every gift has artwork, its tier matches its price, and the
price shown is exactly what's deducted (checked across tiers).
Visual QA in headless Chrome:
- viewer on phone (390×844) and desktop (1440×900): idle, gift sheet, and each tier's effect captured mid-animation
- host studio with a test camera: went LIVE, received gifts, takeover effect, live stats

**Limits:**
- LIVE video is peer-to-peer WebRTC. It needs a TURN server for strict networks, and a media server
  (SFU) for large audiences (see DEPLOY.md).
- Gift sounds play only after the viewer has interacted with the page (browser autoplay rules).

## Phase 3: security, data protection and platform protection

**Authentication**
- **Passwords:** scrypt at OWASP's recommended setting (N=2^15, r=8, p=3) with a random salt. Older
  hashes still work and are upgraded automatically at the next login. The 50 most common breached
  passwords are refused.
- **Login:**
  - constant-time checks; unknown accounts take the same time, so timing can't reveal which accounts exist
  - limited per IP and per account
  - failed attempts are logged
- **Sessions:** random tokens stored only as hashes; HttpOnly, SameSite=Lax and Secure cookies; 30-day
  expiry; password changes and resets sign out other devices. Expired sessions are deleted hourly.

**Database:** every query is parameterised (re-checked). Foreign keys are on. Money and balance changes
run in single transactions. Payment webhooks and gifts can't be applied twice.

**API**
- every staff route is checked on the server
- input validation, rate limits and size limits (JSON 200 KB, sockets 128 KB, uploads capped)
- errors never show stack traces or internals; blocked traversal attempts no longer log as server errors

**Common attacks**
| Attack | Protection | Tested |
|---|---|---|
| SQL injection | parameterised queries | review |
| XSS | text-only rendering, strict CSP (`script-src 'self'`), no SVG/HTML uploads | yes |
| CSRF | app header on every write + SameSite cookies; attempts logged | yes |
| Broken access control / IDOR | other people's chats, messages, orders and staff actions refused | yes |
| Privilege escalation | profile edits can't set role, owner or verified | yes |
| Brute force | per-IP and per-account login limits, logged | yes |
| Path traversal | `/media` paths fixed to their folder; the database is never served | yes |
| Malicious uploads | file type checked from the bytes, not the name; disguised files rejected and deleted | yes |
| WebSocket abuse | origin check, size cap, flood limit (logged) | review |
| Payment forgery | signed webhooks only; forged ones logged | yes |

**Monitoring (new):** a security log covering:
- failed logins and forged requests
- refused staff access and rate-limit hits
- forged payment webhooks
- socket floods
- unusual gifting (over 50,000 coins in an hour, configurable)

It's in Moderation centre → Security, staff only. Privacy: no passwords, tokens, cookies or emails are
stored, IPs are kept only as an anonymised key, entries are deleted after 30 days, and repeated
identical events are throttled.

**Privacy and UK GDPR / DPA 2018 (new)**
- Settings → Account → **Download my data**: a JSON copy of your account, content, messages you sent,
  follows, coins, gifts, LIVEs, reports and sessions. It never includes password hashes, tokens or
  other people's private data.
- Hourly retention clean-up removes:
  - expired sessions, email and reset links
  - security events after 30 days
  - payment webhook ids after 90 days
  - expired stories and their files
- Account deletion (from earlier) removes the account, its content and files.
- Emails are never shown publicly (Phase 1).

**Admin security:** staff checks run on the server; only the owner can verify accounts, change roles or
set coin prices. Admin actions go to the audit log. Refused staff access is logged.

**Dependencies:**
- **Server:** `npm audit` reports 0 vulnerabilities.
- **Android project:** 0.
- **Desktop app build tools:** 6 moderate advisories in `minimatch`, used only by the installer builder
  on your PC (not shipped, not on the server). Safe patch updates are applied; the remaining fix needs a
  breaking downgrade of electron-builder, so it's left documented, not forced.

**Tests:** 62 automated tests pass, including 8 new attacker-style security tests. The production
startup check passes.

**Limits (honest):**
- No website is immune.
- Rate limits are in memory (one server).
- There's no 2-factor login yet.
- Video files aren't scanned for malware beyond type checks.
- Legal pages still need a lawyer's review.
