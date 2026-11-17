# Putting Clipzy online

This guide takes Clipzy from your PC to a real public website with HTTPS, a domain, email,
persistent storage, backups and automatic restarts. Read [AUDIT.md](AUDIT.md) first for what is
finished and what still needs your accounts.

**Free option (no monthly cost):** Oracle Cloud Always Free + a free DuckDNS address + Gmail for
emails. See [deploy/oracle/README.md](deploy/oracle/README.md). The rest of this guide covers Railway (paid).

**Paid setup:** Railway (hosting + storage) + a domain from Cloudflare Registrar + Resend (email)
+ Stripe (only if you sell coins) + a TURN service (for LIVE). Costs are listed at the end.

> Production safety is enforced in code: with `NODE_ENV=production` (set by the Dockerfile) the server
> **refuses to start** without an `https://` `BASE_URL` and an email provider, the first boot refuses a
> weak owner password or a fake owner email, demo accounts/coins are disabled, and `npm run seed` won't run.

---

## 1. Put the code on GitHub (private)

Your repo is already set up. Commit and push:
```bash
git add -A
git commit -m "Production readiness"
git push
```
Make sure the GitHub repo is **Private** (github.com → repo → Settings → General → Danger zone).
`.env`, `data/` and `uploads/` are git-ignored, so no passwords or user data are uploaded.

## 2. Create the Railway service

1. Sign up at railway.com (the Hobby plan is recommended: the free trial has tiny volume limits).
2. **New Project → Deploy from GitHub repo** → pick this repo. It builds the `Dockerfile` and uses
   `railway.json` (health check on `/api/health`, restart on failure).
3. Service → **Volumes → Add volume**, mount path **`/data`**. This holds the database, daily backups
   and uploaded videos. Without it, everything is lost on every deploy.
4. Service → **Settings → Networking → Generate domain**. You now have `https://<name>.up.railway.app`
   with HTTPS handled for you.

## 3. Email (required: sign-up confirmation and password resets)

1. Sign up at resend.com → **Domains → Add domain** (use your own domain from step 6, or a subdomain
   like `mail.yourdomain.com`).
2. Add the DNS records Resend shows you (TXT/MX for SPF and DKIM) at your domain's DNS provider, wait
   for "Verified".
3. **API Keys → Create** (sending access only). Copy it straight into Railway in the next step.

Until your domain exists you can't verify Resend. If you want to test online before buying a domain,
set `REQUIRE_EMAIL_VERIFICATION=false` temporarily, and remove it once email works.

## 4. Environment variables (Railway → service → Variables)

| Variable | Value | Required |
|---|---|---|
| `BASE_URL` | `https://<name>.up.railway.app`, later your own domain | yes |
| `ADMIN_EMAIL` | your real email (password resets go here) | first boot |
| `ADMIN_USERNAME` | your username | first boot |
| `ADMIN_PASSWORD` | strong, 10+ characters, used once to create the owner account | first boot |
| `MAIL_PROVIDER` | `resend` | yes |
| `RESEND_API_KEY` | from Resend | yes |
| `MAIL_FROM` | `Clipzy <no-reply@yourdomain.com>` (the verified domain) | yes |
| `CONTACT_EMAIL` | address shown on Terms/Privacy/Safety pages | recommended |
| `VERIFY_KEY` | long random secret, needed to give verification badges | recommended |
| `ICE_SERVERS` | TURN config, see step 7 | for LIVE |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | see step 8 | only to sell coins |
| `AI_MODERATION=openai`, `OPENAI_API_KEY` | AI text moderation + auto-captions | optional |
| `FIREBASE_SERVICE_ACCOUNT` | push notifications in the Android app (see APPS.md); browser push needs nothing | for Android push |

Already set by the Dockerfile: `NODE_ENV=production`, `DATA_DIR=/data/db`, `UPLOAD_DIR=/data/uploads`,
`TRUST_PROXY=1`, `PORT=4000`. `SEED_DEMO` is ignored in production. There is no demo-coins mode.

Generate a random `VERIFY_KEY` locally with:
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Deploy. Watch **Deployments → Logs**: you should see `created owner account`, then
`Clipzy is running at https://...`. Any `[config] ERROR` line tells you exactly which variable to fix.
`[config] warning` lines are features that still need setting up.

After the first successful start you can delete `ADMIN_PASSWORD` from the variables.

## 5. First login

1. Open your URL, log in as the owner.
2. **Settings → Account → Date of birth**: set it (needed for LIVE, coins and gifts; 18+).
3. **Settings → Security**: confirm you're signed in only where you expect.
4. Read `/terms`, `/privacy`, `/guidelines` and adjust the text in `public/js/pages/legal.js`
   (have a lawyer review it before a public launch).

## 6. Your own domain

1. Buy a domain (Cloudflare Registrar sells at cost, about $10/year for a `.com`).
2. Railway → service → **Networking → Custom domain** → enter `yourdomain.com` (and/or `www.`).
3. Railway shows a **CNAME** record (and a TXT for verification). Add them in Cloudflare → DNS. Set the
   Cloudflare proxy (orange cloud) to **DNS only** at first so Railway can issue the certificate.
4. When Railway shows the domain as active (HTTPS certificate issued automatically), set
   `BASE_URL=https://yourdomain.com` and redeploy.

## 7. LIVE for everyone: TURN server

LIVE is peer-to-peer WebRTC. It works on most home Wi-Fi, but many mobile and office networks need a
relay (TURN). Create an account at a TURN provider (e.g. metered.ca, Twilio, Cloudflare Calls) and set:
```
ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:YOUR_HOST:443?transport=tcp","username":"USER","credential":"PASS"}]
```
Limit: each viewer receives the stream directly from the host's device, so one LIVE comfortably handles
roughly 5-20 viewers depending on the host's upload speed. Bigger audiences need a media server (SFU)
such as LiveKit; this is not built yet (see AUDIT.md).

## 8. Selling coins (optional)

1. stripe.com → complete business verification.
2. Developers → API keys → copy the **secret key** into `STRIPE_SECRET_KEY`.
3. Developers → Webhooks → Add endpoint `https://yourdomain.com/api/coins/webhook`, event
   events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created` → copy the **signing secret** into `STRIPE_WEBHOOK_SECRET`.
4. Test with `sk_test_` keys and card `4242 4242 4242 4242` first, then switch to live keys.

Without Stripe keys, coin purchases are simply turned off in production.
Creator cash-outs (diamonds to money) are **not** automated. Paying creators involves tax and
identity rules; get advice before promising payouts.

## 9. Backups, logs and maintenance

* **Database snapshots:** taken automatically once a day to `/data/db/backups/` (kept 7 days).
  Take one by hand with `npm run backup` (run it on the server with the Railway CLI: `railway ssh`).
* **Off-site copies:** Railway → Volume → **Backups** (schedule them). Snapshots in the same volume don't
  protect against losing the volume itself. Uploaded videos are only covered by volume backups.
* **Integrity check:** `npm run db:check`.
* **Restore:** stop the service, replace `/data/db/app.db` with a snapshot (delete `app.db-wal` and
  `app.db-shm`), start again.
* **Logs:** every API request is logged as `[http] METHOD /path status time user ip` (no query strings,
  so one-time links never reach the logs). Errors print as `[error]`.
* **Health:** `/api/health` checks the database. Railway restarts the service if it fails.
* **Updates:** push to GitHub; Railway rebuilds and swaps over. The database migrates itself on boot.
* **Scale:** run **one** instance only. The database is SQLite on a volume, and rate limits and LIVE
  rooms are held in memory.

## 10. Costs (check each site for current prices)

| Item | What for | Typical cost |
|---|---|---|
| Railway Hobby | hosting, HTTPS, volume | about $5/month base + usage; storage is billed per GB |
| Domain | yourdomain.com | about $10-15/year |
| Resend | emails | free tier (3,000 emails/month), then paid |
| TURN (e.g. metered.ca) | LIVE on mobile networks | free tier, then pay per GB relayed |
| Stripe | coin payments | no monthly fee, a percentage per payment |
| OpenAI | optional AI moderation/captions | moderation endpoint is free; captions are pay per minute |

---

## Quick test from your PC (not for real users)

`cloudflared tunnel --url http://localhost:4000` gives a temporary public link to the app running on
your PC. That runs the **development** setup: before sharing it, remove demo accounts with
`npm run purge-demo -- --yes` and change the admin password. Use Railway for anything real.

## Android app, installable website, desktop app

All of them use this same server and database. Once the site is live, build the Android APK/AAB with
`npm run build:android -- --url https://your-domain` in `apps/mobile`. Full steps are in [APPS.md](APPS.md).
