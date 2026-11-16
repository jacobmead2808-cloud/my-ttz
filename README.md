# Clipzy — short-video social platform

A full-stack, TikTok-style app: vertical autoplay feed, uploads, profiles, follows, likes, threaded comments,
shares, favourites, hashtags, mentions, search/discovery, notifications, real-time DMs, WebRTC LIVE streaming,
block/report, and an admin dashboard. Everything is stored in a real database; nothing important lives in
front-end arrays.

## Quick start

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`). Tested on Node 24.

```bash
npm install
npm run seed        # admin + 10 demo users, 5 placeholder sounds, 12 demo videos
npm start           # http://localhost:4000
```

* Admin login: `admin` / the `ADMIN_PASSWORD` value in `.env.example`
* Demo logins: e.g. `maya.moves` / the `SEED_PASSWORD` value in `.env.example`
* `npm run dev` restarts on file changes, `npm test` runs the end-to-end API tests,
  `npm run seed -- --reset` wipes and reseeds, `npm run make-admin -- <username>` promotes a user.

Copy `.env.example` to `.env` to change the port, name, passwords, limits, email and LIVE settings.

## What is real vs. what needs configuration

| Feature | Status |
|---|---|
| Accounts, sessions, profiles, privacy, follows, likes, comments, saves, shares, search, notifications, DMs, reports, admin | Fully working (SQLite + WebSockets) |
| Video/image uploads | Working, stored on local disk in `uploads/`, type-checked by magic bytes, access-controlled |
| LIVE streaming | Working WebRTC (camera, screen, or test pattern). Host sends a peer connection to each viewer. |
| Password reset email | **Dev mode by default**: the reset link is printed in the server console and saved in `data/outbox/`. To send real email set `MAIL_PROVIDER=resend`, `RESEND_API_KEY`, `MAIL_FROM` (needs a [Resend](https://resend.com) account with a verified domain). This integration has not been tested against a live Resend account. |
| Music | Five synthesized placeholder loops. Add real tracks by dropping files in `uploads/sounds/` and inserting rows into the `sounds` table. |

### LIVE in production
STUN-only WebRTC works on most home networks and on localhost. For reliability you need:
1. **HTTPS** — browsers only allow camera/microphone on `https://` or `localhost`.
2. **A TURN server** for viewers behind strict NATs: set `ICE_SERVERS` in `.env` (coturn, Twilio, Metered, Cloudflare Calls…).
3. **An SFU for big audiences** — the built-in mesh uploads one stream per viewer from the host, fine for
   small groups (~10–20 viewers). For larger LIVEs, swap `public/js/lib/livestream.js` for LiveKit/mediasoup/Cloudflare Stream; signaling, chat, likes and viewer counts can stay as they are.

## Creator features
* **Duet & Stitch** — video menu → Duet/Stitch opens a studio that composes the original with your camera, a clip from
  your device, or a test pattern, recorded in the browser. Creators can turn remixing off per video.
* **Reply with video** — on your own videos, “Reply with video” under a comment posts a video with that comment as a sticker.
* **Editor** — trim, 8 colour filters, cover picker and timed captions (non-destructive: applied at playback).
* **Drafts & scheduling** — save drafts or schedule up to 30 days ahead; Profile → Drafts lists them.
* **Reposts** — share sheet / menu → Repost; reposts show in followers’ Following feed and on your profile.
* **Not interested** — hides a video and down-ranks that creator in For You.
* **Collections** — “Add to collection”; Profile → Favorites shows them (private).
* **Stories** — 24-hour photos/videos with view counts, DM replies, rings on avatars (Explore, Messages, profiles).
* **Analytics** — `/analytics`: views, likes, comments, shares, followers, traffic sources and top videos (7/28/60 days).
* **Auto-captions** — needs `STT_PROVIDER=openai` + `OPENAI_API_KEY` (untested without a key); otherwise write captions by hand.
* Not included: LIVE gifts/coins (needs a payment provider such as Stripe) and server-side video transcoding.

## Coins, gifts & LIVE
* **Coins** — `/coins` wallet + Recharge sheet (packs 30–1,000 or custom). With `STRIPE_SECRET_KEY` and
  `STRIPE_WEBHOOK_SECRET` set, purchases go through Stripe Checkout (webhook: `/api/coins/webhook`, event
  `checkout.session.completed`). Without them, development builds hand out **demo coins** (no money moves).
  Untested against a live Stripe account.
* **Gifts** — 12 placeholder gifts (emoji art in `server/lib/economy.js`) sent from the LIVE gift bar; creators earn
  diamonds (default 50%) they can exchange for coins. Gift gallery on every profile (🎁). Cash-out needs a payout
  provider (e.g. Stripe Connect) — not built.
* **Owner economy controls** — Moderation centre → Coins & gifts: discounts, gift on/off, creator share, packs.
* **Who can go LIVE** — 500+ followers, verified, or good standing (owner-editable). Others with a clean record get a
  30-minute **trial LIVE** once a week. Staff can grant access per user.
* **LIVE Studio** (`/live/studio`) — scenes (camera, screen, screen + camera bubble, test pattern), on-screen text,
  goals (likes / gift coins / followers), live stats, gift feed, top gifters, moderation.

## Clipzy originals
* **Watch Parties** — ⋯ → “Watch together”: synced playback of a video queue with chat and reactions (`/party/CODE`).
* **Vibes** — mood filters on For You (Chill, Hype, Funny, Learn, Explore).

## Guardian (automatic moderation)
Scores every active account from behaviour (auto-mod hits, reports, removed content, spam/follow/DM bursts, history).
It warns at 30, opens a case for a human at 55, and auto-suspends for 24h at 85 (thresholds are owner-editable).
Verified users, admins and the owner are never auto-actioned — they’re escalated. Staff are notified in real time and
work cases in Moderation centre → Cases. Optional AI text classification: `AI_MODERATION=openai` + `OPENAI_API_KEY`.
Every account has a moderation profile (`/admin/user/:id`) with content, behaviour, risk, reports, history, LIVE and
wallet, plus all actions. **Verifying** an account is owner-only and requires the key in `VERIFY_KEY` (default `weluvjj`).

## Turning it into an app
1. **Installable now (PWA):** deploy on HTTPS, open it on a phone → “Add to Home Screen” (or the browser’s Install
   button / More → Install the app on desktop). It runs full-screen with its own icon.
2. **App Store / Play Store:** wrap the hosted site with Capacitor:
   `npm i -D @capacitor/cli && npm i @capacitor/core @capacitor/android @capacitor/ios`, `npx cap init Clipzy com.yourname.clipzy`,
   set `server.url` to your HTTPS domain in `capacitor.config`, then `npx cap add android` / `npx cap add ios` and build in
   Android Studio / Xcode. You need a Google Play ($25) / Apple Developer ($99/yr) account to publish.
3. Hosting: any Node host with a persistent disk (Render, Railway, Fly.io, a VPS). Put it behind HTTPS (needed for
   camera, LIVE and installing). Set `BASE_URL`, `TRUST_PROXY=1` and a TURN server for LIVE.

## Roles & moderation
* **Owner** (the seeded `admin`, or the earliest admin on an existing database): everything admins can do, plus
  verified badges, promoting/demoting admins, and platform switches (sign-ups, uploads, LIVE, site banner).
  Nobody can moderate the owner.
* **Admins**: Admin dashboard → reports, users (suspend, ban, restrict comments/LIVE, force logout, purge comments,
  reset profile), videos, comments, LIVE, **Auto-mod**, announcements, audit log.
* **Auto-mod** (Admin → Auto-mod): blocked words with leetspeak/stretched-letter detection, link filter for new
  accounts, shouting filter, mass-mention limit, repeat-spam limit, new-account cooldown, auto-hide after N reports.
  Screens comments, LIVE chat, DMs, captions and profiles; flagged comments are "only visible to you".
* **Creators** (Settings → Moderation & filters): own keyword/link filters, a review queue for filtered comments,
  LIVE moderators and removed viewers.
* **LIVE**: host, moderators and staff tap a chat message to pin, delete, mute (5 min / whole LIVE), remove the
  sender, or make them a moderator; the shield button sets slow mode and followers-only chat.

## Security
scrypt password hashing · HttpOnly SameSite session cookies (sliding expiry, hashed in the DB) · CSRF header check
on all writes · WebSocket origin check · rate limits on login/sign-up/reset/comments/DMs/uploads · strict CSP and
security headers · all user text rendered with `textContent` (no HTML injection) · upload type sniffing + size limits ·
video/thumbnail files served only to users allowed to view them · every admin route checked server-side · audit log.

## Branding / placeholders
* Name, tagline, logo paths: `public/js/brand.js` (and `APP_NAME` in `.env` for emails)
* Colours: `--brand`, `--brand-2` at the top of `public/css/app.css`
* Logo/favicon: `public/assets/brand/`, default avatar & thumbnail: `public/assets/`
* Demo videos: Admin → **Demo content** generates more in the browser; `node server/scripts/export-seed-media.js`
  saves the current videos into `server/seed/media` for future seeds. Delete that folder to seed without videos.

## Project layout
```
server/
  index.js            Express app, security headers, media serving, SPA fallback
  config.js  db.js    env loading, SQLite schema
  lib/                auth, access rules, validation, uploads, notifications, rate limiting, mailer
  routes/             auth, me, users, videos(+comments), discover, notifications(+reports), messages, live, admin
  realtime/           WebSocket hub, LIVE rooms & WebRTC signaling
  seed.js  scripts/   seeding and admin tools
public/
  index.html  css/app.css
  js/app.js           shell, routes, session boot
  js/lib/             api, router, store, ws, dom helpers, icons, WebRTC, demo media generator
  js/components/      feed, video player, comments, social widgets, LIVE room, UI primitives
  js/pages/           home, explore, search, tag, sound, video, profile, upload, inbox, messages, live*, settings, admin, auth
test/api.test.js      end-to-end tests (auth, reset, uploads, feed, likes, comments, follows, DMs, WS, LIVE, search, blocks, admin)
```

## Scaling notes
SQLite + local disk are great for a single server. For multi-server deployments move to Postgres, put media in
object storage (S3/R2) behind a CDN, transcode uploads (e.g. ffmpeg/Mux) to H.264 MP4 + HLS, and replace the
in-memory rate limiter / WebSocket hub with Redis.
