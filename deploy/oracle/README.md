# Free hosting on Oracle Cloud (Always Free)

24/7 server with storage, free. Oracle asks for a card at sign-up only to verify identity; Always
Free resources are not charged.

## 1. You: create the server (about 15 minutes)
1. cloud.oracle.com → **Sign up** (Free Tier). Choose a home region near you (e.g. UK South).
2. Menu → **Compute → Instances → Create instance**
   - Image: **Ubuntu 24.04**
   - Shape: **VM.Standard.A1.Flex** (Ampere), 2 OCPU / 12 GB. If "out of capacity", use **VM.Standard.E2.1.Micro**.
   - SSH keys: **Generate a key pair for me → Save private key**
   - **Create**, then copy the **Public IP address**.
3. Instance page → **Subnet** → **Security List** → **Add Ingress Rules**:
   source `0.0.0.0/0`, IP protocol TCP, destination port `80`. Repeat for `443`.
4. Free web address: duckdns.org → sign in → add a subdomain (e.g. `clipzy-jj`) → set its IP to the
   server's IP → **update ip**. Your site will be `https://clipzy-jj.duckdns.org`.
   (No account at all: use `<ip-with-dashes>.sslip.io`, e.g. `140-238-1-2.sslip.io`.)

## 2. Deploy (from Git Bash in the project folder)
```bash
bash deploy/oracle/deploy.sh <server-ip> <path-to-key> <your-domain> --setup
```
This installs:
- Node.js 24, checksum-verified
- Caddy, which gets the HTTPS certificate automatically
- the firewall rules
- a locked-down system service

## 3. Your private settings (owner password, Gmail for emails)
```bash
ssh -t -i <path-to-key> ubuntu@<server-ip> sudo bash /opt/clipzy/configure.sh
```
Asks for:
- your owner email, username and password
- optionally a Gmail address plus an **app password**, so confirmation and reset emails work for free
- a contact email

They're stored only on the server (root-only file).

Gmail app password: myaccount.google.com → Security → turn on 2-Step Verification → **App passwords**
→ create one named "Clipzy".

## 4. Updates
Run the same deploy command without `--setup`. It switches over with no data loss. If the new
version fails its health check, it rolls back automatically.

## Looking after it
| Task | Command (on the server) |
|---|---|
| Status / logs | `systemctl status clipzy` · `journalctl -u clipzy -f` |
| Restart | `sudo systemctl restart clipzy` |
| Database check + backup now | `cd /opt/clipzy/current && sudo -u clipzy env $(sudo cat /etc/clipzy/clipzy.env \| xargs) node server/scripts/db-check.js --backup` |
| Change settings | `sudo bash /opt/clipzy/configure.sh` (or edit `/etc/clipzy/clipzy.env`, then restart) |

- **Backups:** the app saves a database snapshot daily to `/var/lib/clipzy/db/backups` (7 days).
  For off-server copies, use Oracle's free boot-volume backups (Instance → Boot volume → Backups), or
  copy files down with `scp`.
- **Updates:** Ubuntu security updates install automatically.

Data lives in `/var/lib/clipzy`: the database, backups and uploaded videos.
