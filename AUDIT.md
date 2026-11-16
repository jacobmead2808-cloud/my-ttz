# Clipzy production-readiness audit

Date: 16 November 2026. Scope: the whole repository (server, web app, desktop/mobile wrappers, Docker
and deploy config). Everything marked **Fixed** was changed in the code and covered by a test or a
recorded manual check. Everything marked **Needs you** needs your accounts, money or a decision.

How it was tested:
* Automated: `npm test` runs **41 end-to-end tests** (4 existing files + new `test/accounts.test.js`), all passing.
* Production start (temp data folder, `NODE_ENV=production`): bad config refused, weak owner refused,
  `SEED_DEMO` ignored, health check, sign-up, secure cookie flags, CSRF rejection, HSTS/CSP headers,
  demo endpoint gone (404), coins disabled without Stripe, daily backup + integrity check. All passed.
* Browser: sign-up with date of birth and terms, teen restrictions, legal pages, email banner,
  confirmation link. All worked.
* **Not tested:** Docker build (Docker isn't installed on this PC), real email delivery (needs a
  Resend key), real Stripe payments (needs keys), TURN relay, graceful SIGTERM shutdown (Windows can't
  send SIGTERM; standard Node behaviour on Linux hosts).

---

## 1. Problems found

| # | Problem | Status |
|---|---|---|
| 1 | Demo accounts, demo coins and demo content could exist or be switched on in production | **Fixed** (see list 3) |
| 2 | No email verification: anyone could sign up with someone else's address | **Fixed**: confirmation link (48h, single use, tied to the address); changing email needs re-confirming |
| 3 | No age check, no terms acceptance | **Fixed**: date of birth required, 13+ only, terms checkbox stored with a timestamp |
| 4 | No legal pages | **Fixed**: `/terms`, `/privacy`, `/guidelines`, `/safety` (templates, need legal review) |
| 5 | Coin purchase could be credited twice if Stripe retried a webhook while another was processing | **Fixed**: single atomic "mark paid" + credit |
| 6 | Diamond-to-coin exchange wasn't atomic | **Fixed**: one transaction |
| 7 | Two people registering the same username at the same moment returned a 500 error | **Fixed**: returns 409 "already exists" |
| 8 | Deleting an account left story files and LIVE previews on disk | **Fixed** |
| 9 | Server started on a production host with insecure or missing settings | **Fixed**: startup check refuses http `BASE_URL`, missing email provider, Stripe without webhook secret |
| 10 | Health check didn't check the database | **Fixed**: `/api/health` queries the DB, returns 503 on failure |
| 11 | No request log | **Fixed**: one line per API request, query strings stripped |
| 12 | No backups | **Fixed**: daily `VACUUM INTO` snapshots kept 7 days; `npm run backup`, `npm run db:check` |
| 13 | No graceful shutdown on redeploy | **Fixed**: SIGTERM finishes requests then closes the DB |
| 14 | Dockerfile used `VOLUME`, which Railway rejects | **Fixed**: removed; volume attached in dashboard |
| 15 | Production startup said "Email: dev mode" when email was missing | **Fixed**: now says "NOT configured" |
| 16 | Junk files in the repo root (accidental terminal output) | **Fixed**: deleted after inspection |
| 17 | `.env.example` contained a real-looking admin password and the verify key | **Fixed**: blank placeholders |

## 2. Security vulnerabilities

| Area | Finding | Status |
|---|---|---|
| Privilege escalation | Default verify key worked in production, so anyone who knew it could verify accounts | **Fixed**: production needs your own `VERIFY_KEY` |
| Privilege escalation | An admin could LIVE-ban the owner or other admins | **Fixed**: owner protected; only the owner can restrict admins |
| Account takeover | Login limit was per IP only, so a botnet could guess one account's password | **Fixed**: added 10 tries / 15 min per account |
| Account safety | The owner could delete the owner account and lock everyone out of admin | **Fixed**: blocked |
| Abuse / DoS | No message limit on the realtime (WebSocket) connection | **Fixed**: 150 messages / 10s per connection |
| Payments | Demo (free) coins could be turned on in production | **Fixed**: production is Stripe-or-off |
| Payments | Webhook double credit (race) | **Fixed** (list 1 #5) |
| Secrets | Password-reset links were printed to logs in production without an email provider | **Fixed**: never logged in production |
| SQL injection | All queries use bound parameters; the few interpolated pieces are code constants | OK, no change needed |
| XSS | All user text is inserted as text nodes; `innerHTML` only for built-in icons; strict CSP (`script-src 'self'`) | OK |
| CSRF | Mutating API calls need the `X-Requested-With` header plus SameSite=Lax cookies; WebSocket origin check | OK (verified: 403 without the header) |
| Cookies | HttpOnly, SameSite=Lax, Secure on https, session tokens stored hashed | OK (verified in production run) |
| Uploads | Files checked by magic bytes (not extension), size limits, random names, served with nosniff; private videos access-checked | OK |
| Private data | Public profile/feed responses don't include email, password hash, date of birth or risk scores | OK |
| Passwords | scrypt with per-user salt; resetting logs out all devices | OK |
| Known limit | Rate limits are in memory, so they reset on restart and only work with one instance | **Needs you** only if you scale beyond one server (would need Redis) |

## 3. Demo / fake items removed or locked

* `/api/admin/demo-videos` endpoint and the admin "Demo content" tab: **removed**.
* `public/js/lib/demoMedia.js` (in-browser fake video generator): **removed**.
* `npm run seed` (demo accounts): **refuses to run** when `NODE_ENV=production`.
* `SEED_DEMO=true`: **ignored** in production (logged as an error).
* Demo coins: **off** in production regardless of `COINS_DEMO_MODE`.
* Default verify key: **development only**.
* `server/seed/media` (sample videos): **excluded** from the Docker image.
* Example admin password / fake owner email: **refused** at first production boot.
* **Needs you:** your local database still has 10 demo accounts and 13 demo videos. They never go to
  the server (the database isn't in Git or Docker), but if you ever copy it, first run:
  `npm run purge-demo -- --yes`

## 4. Broken, incomplete or limited features

| Feature | State | What it needs |
|---|---|---|
| Email (confirmation, password reset) | Code done, tested with the dev outbox | **Needs you:** Resend account + verified domain |
| Coin purchases | Code done; webhook signature check and exactly-once crediting tested with signed test events | **Needs you:** Stripe account and keys; test end to end with test keys |
| Creator payouts (diamonds to money) | **Not built**. Diamonds accumulate but can't be cashed out | Business/tax decision; Stripe Connect would be the route |
| LIVE | Works (real WebRTC, chat, gifts, moderation) | **Needs you:** a TURN service for mobile networks. Peer-to-peer limits a stream to roughly 5-20 viewers; large audiences need a LiveKit SFU (not built) |
| Video processing | Videos are served as uploaded (no transcoding or compression); phones may upload large HEVC files that some browsers can't play | Adding ffmpeg transcoding is the next big feature; not done because it couldn't be tested here |
| Auto-captions / AI moderation | Optional, off by default (rules-based moderation always on) | OpenAI key if wanted |
| Legal pages | Templates written to match the real features | **Needs you:** lawyer review, your contact email |
| Desktop / mobile apps | Wrap the website | **Needs you:** set your https URL, rebuild |
| Scaling | Single server only (SQLite, in-memory rate limits and LIVE rooms) | Fine for thousands of users; beyond that, Postgres + Redis |

## 5. Hosting and domain recommendation

* **Hosting: Railway** (Hobby plan, about $5/month plus usage) with a **volume at `/data`**. It builds
  the included Dockerfile, gives free HTTPS, restarts on failure using the health check in
  `railway.json`, and offers scheduled volume backups. Alternatives: Fly.io (similar), or a VPS
  (Hetzner about €5/month) with Docker + Caddy if you're comfortable running a server.
* **Domain:** Cloudflare Registrar (sold at cost, about $10/year for `.com`), DNS at Cloudflare.
* **Email:** Resend (free tier is enough to start).
* **LIVE relay:** a TURN provider such as metered.ca (free tier to start).
* **Payments:** Stripe, only when you're ready to sell coins.

Nothing needs buying to test on Railway's generated `*.up.railway.app` address. The domain is the
first real purchase, and it's needed before email can be verified.

## 6. Step-by-step plan

Done (in this codebase, tested):
1. Demo access removed or locked out of production.
2. Security fixes (list 2) and race-condition fixes.
3. Email verification, age rules, terms, teen safeguards, legal pages.
4. Production checks, logging, health, backups, graceful shutdown, Railway config.

Needs you, in order (full instructions in [DEPLOY.md](DEPLOY.md)):
1. Commit and push to your **private** GitHub repo.
2. Create the Railway project from the repo and add a volume at `/data`.
3. Buy a domain; connect it to Railway.
4. Create a Resend account, verify the domain, create an API key.
5. Set the variables in Railway (`BASE_URL`, `ADMIN_*`, `MAIL_*`, `RESEND_API_KEY`, `CONTACT_EMAIL`, `VERIFY_KEY`).
6. Deploy, check the logs for `[config]` lines, log in, set your date of birth.
7. Add a TURN service (`ICE_SERVERS`) and test LIVE from a phone on mobile data.
8. Have the legal pages reviewed; edit `public/js/pages/legal.js`.
9. Optional: Stripe (test keys first), then OpenAI moderation.
10. Turn on Railway volume backups; try a restore once.

---

## Update: apps, push notifications, mobile fixes (16 November 2026)

Tests: **47 automated tests** pass (new `test/push.test.js` decrypts real Web Push payloads and checks
the VAPID and Firebase signatures against local mock services).

| Area | Result |
|---|---|
| Demo data | Local demo accounts, their videos and a leftover duet test video deleted (database backed up first to `data/manual-backups/`). |
| Bug: phones | Single-video page showed a black screen on phones (player was 0px wide). **Fixed.** |
| Bug: phones | Sound/caption buttons overlapped the For You category chips. **Fixed.** |
| Bug: notch / gesture phones | Bottom tab bar was cut off under the Android gesture bar; content went under the status bar. **Fixed** (safe-area insets). |
| PWA | Manifest + installability: 0 errors in Chrome. Maskable and monochrome icons, install bar, offline screen (tested with the server stopped). |
| Push | Web Push built in (no account needed). Tested end to end in Edge (Microsoft push service → notification shown). Google's push service accepted messages; display wasn't observed in a temporary automated Chrome profile, so check on a real phone. Android app push uses Firebase (**needs you**: free Firebase project). |
| Android app | Real Android Studio project committed (`apps/mobile/android`): icon, splash, permissions, back button, push plugin, signing, version codes. Release builds refuse localhost/http/placeholder URLs (checked in both the build script and Gradle). Tested on the Android 17 emulator: login, feed, gallery upload, posting, playback, camera/mic permission, back button. |
| Google Play rule | Coin purchases are hidden inside the Android app (Play requires its own billing for digital goods). |

Still **needs you**:
- Approve and run the Railway deployment.
- Choose the owner email and password.
- Buy a domain.
- Set up email (Resend).
- Create the signing key (`npm run keystore`, your password).
- Optional: a Firebase project for Android push.
- Optional: a Google Play developer account ($25).
