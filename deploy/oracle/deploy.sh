#!/usr/bin/env bash
# Deploy Clipzy from this PC to your server (Git Bash / macOS / Linux):
#   bash deploy/oracle/deploy.sh <server-ip> <path-to-ssh-key> <domain> [--setup]
# --setup runs the one-time server setup first. Every deploy uploads the current code, installs
# dependencies, switches over, checks /api/health and rolls back automatically if it fails.
set -euo pipefail
IP="${1:?usage: deploy.sh <ip> <ssh-key> <domain> [--setup]}"
KEY="${2:?ssh key path}"
DOMAIN="${3:?domain}"
SETUP="${4:-}"
USER_NAME="${SSH_USER:-ubuntu}"
cd "$(dirname "$0")/../.."
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "$USER_NAME@$IP")
SCP=(scp -i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)

if [ "$SETUP" = "--setup" ]; then
  echo "== server setup"
  "${SCP[@]}" deploy/oracle/setup.sh deploy/oracle/configure.sh "$USER_NAME@$IP:/tmp/"
  "${SSH[@]}" "sudo bash /tmp/setup.sh '$DOMAIN' && sudo install -m 700 /tmp/configure.sh /opt/clipzy/configure.sh"
fi

echo "== packaging"
REL=$(date +%Y%m%d%H%M%S)
TAR=$(mktemp -t clipzy-XXXX).tgz
git ls-files -co --exclude-standard \
  | grep -Ev '^(apps/|test/|deploy/|server/seed/media/|data/|uploads/|\.claude/)' \
  | tar -czf "$TAR" -T -
echo "   $(du -h "$TAR" | cut -f1) release $REL"

echo "== upload + install"
"${SCP[@]}" "$TAR" "$USER_NAME@$IP:/tmp/clipzy-$REL.tgz"
rm -f "$TAR"
"${SSH[@]}" "sudo bash -s" <<REMOTE
set -euo pipefail
R=/opt/clipzy/releases/$REL
mkdir -p "\$R" && tar -xzf /tmp/clipzy-$REL.tgz -C "\$R" && rm -f /tmp/clipzy-$REL.tgz
cd "\$R" && /usr/local/bin/npm ci --omit=dev --no-audit --no-fund --loglevel=error
PREV=\$(readlink -f /opt/clipzy/current 2>/dev/null || true)
ln -sfn "\$R" /opt/clipzy/current
systemctl restart clipzy
ok=
for i in \$(seq 1 30); do curl -fsS http://127.0.0.1:4000/api/health >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
if [ -z "\$ok" ]; then
  echo "!! new version failed its health check:"; journalctl -u clipzy -n 25 --no-pager
  if [ -n "\$PREV" ] && [ -d "\$PREV" ]; then ln -sfn "\$PREV" /opt/clipzy/current; systemctl restart clipzy; echo "!! rolled back to \$(basename "\$PREV")"; fi
  exit 1
fi
# The owner exists now, so the one-time password no longer needs to sit in the settings file.
if [ "\$(sqlite3 /var/lib/clipzy/db/app.db 'SELECT COUNT(*) FROM users WHERE is_owner = 1' 2>/dev/null || echo 0)" -ge 1 ]; then
  sed -i '/^ADMIN_PASSWORD=/d' /etc/clipzy/clipzy.env
fi
ls -1dt /opt/clipzy/releases/* | tail -n +4 | xargs -r rm -rf
echo "== live: release $REL"
REMOTE
echo "== public check"
curl -fsS --max-time 20 "https://$DOMAIN/api/health" && echo || echo "HTTPS not answering yet (first certificate can take a minute, or ports 80/443 aren't open in Oracle's Security List)."
