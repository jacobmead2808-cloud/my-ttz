# Putting Clipzy online

There are two ways. **Option A** takes 2 minutes and runs from your PC (good for testing with
friends). **Option B** puts it on a real server so it stays up 24/7.

---

## Option A — share it from your PC (quick test)

Your PC must stay on and the app must be running.

1. Install Cloudflare's tunnel tool (free, no account needed):
   ```bash
   winget install --id Cloudflare.cloudflared
   ```
2. Start Clipzy as usual (`npm start`), then in a second terminal:
   ```bash
   cloudflared tunnel --url http://localhost:4000
   ```
3. It prints a link like `https://random-words.trycloudflare.com`. Send that to your friends.

Notes: the link changes every time you restart the tunnel; uploads over ~100 MB are blocked by
Cloudflare's free tunnel; anyone with the link can sign up, so **change the admin password first**
(Settings → Security).

---

## Option B — host it properly (always online)

Clipzy needs a host that runs Node.js **and** keeps files on a persistent disk (the SQLite database
and uploaded videos). Good fits: **Railway**, **Render** (paid plan with a disk), **Fly.io**, or any
VPS (Hetzner, DigitalOcean). Steps below use **Railway** (~$5/month).

### 1. Put the code on GitHub
```bash
git init
git add .
git commit -m "Clipzy"
```
Create an empty **private** repo on github.com, then follow its “push an existing repository” commands.
(`.gitignore` already keeps your database, uploads and `.env` out of Git.)

### 2. Create the service
1. railway.app → **New Project → Deploy from GitHub repo** → pick your repo. It detects the `Dockerfile`.
2. In the service → **Settings → Volumes → Add volume**, mount path **`/data`**.
3. **Settings → Networking → Generate domain** (gives you `https://something.up.railway.app`).

### 3. Set environment variables (service → Variables)
| Variable | Value |
|---|---|
| `BASE_URL` | your domain, e.g. `https://clipzy.up.railway.app` |
| `ADMIN_EMAIL` | your email |
| `ADMIN_USERNAME` | the username you want |
| `ADMIN_PASSWORD` | a strong password (10+ chars) — used once to create your owner account |
| `VERIFY_KEY` | your secret key for verifying accounts |
| `COINS_DEMO_MODE` | `true` for free test coins (until Stripe is set up) |
| `SEED_DEMO` | `true` only if you want the demo accounts and videos |

Optional: `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (real coin sales), `AI_MODERATION=openai` +
`OPENAI_API_KEY` (AI moderation / auto-captions), `ICE_SERVERS` (TURN server, see below).

Redeploy. On first start it creates your owner account; log in at your domain.

### 4. Custom domain (optional)
Buy a domain (Namecheap, Cloudflare…), add it in Railway → Networking → Custom domain, create the
DNS record it shows you, and update `BASE_URL`.

### 5. LIVE for everyone: add a TURN server
Peer-to-peer LIVE works for most people, but some mobile/office networks need a relay. Create a free
TURN account (e.g. metered.ca or Cloudflare Calls) and set:
```
ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:YOUR_HOST:443","username":"USER","credential":"PASS"}]
```
One host streaming to many viewers uses a lot of upload bandwidth; for big audiences use an SFU
(LiveKit) — see README.

### Running on your own server instead (Docker)
```bash
docker build -t clipzy .
docker run -d --name clipzy -p 4000:4000 -v clipzy-data:/data \
  -e BASE_URL=https://your-domain -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD='a-strong-password' clipzy
```
Put Caddy or nginx in front for HTTPS (HTTPS is required for camera, LIVE and installing the app).

---

## Checklist before inviting people
- [ ] Changed the admin password (never use the example one)
- [ ] `BASE_URL` matches the real address (password-reset links and sharing use it)
- [ ] Email for password resets: set `MAIL_PROVIDER=resend` + `RESEND_API_KEY` + `MAIL_FROM`, otherwise reset links only appear in the server logs
- [ ] Backups: download the `/data` volume regularly (Railway → Volume → Backups)
- [ ] Friends can install it as an app: open the site on their phone → Share → **Add to Home Screen**
