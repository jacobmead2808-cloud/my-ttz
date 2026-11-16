#!/usr/bin/env bash
# One-time server setup for Clipzy on a fresh Ubuntu 24.04 VM (Oracle Cloud Always Free, or any VPS).
# Run as root:  sudo bash setup.sh your-domain
# Installs Node.js 24 (official build, checksum-verified) and Caddy (automatic HTTPS), opens ports
# 80/443, creates a locked-down "clipzy" service user and systemd service. Safe to run again.
set -euo pipefail
DOMAIN="${1:?usage: sudo bash setup.sh your-domain (e.g. clipzy-jj.duckdns.org)}"
[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "== packages"
apt-get update -q
apt-get install -y -q curl ca-certificates xz-utils caddy sqlite3 netfilter-persistent iptables-persistent unattended-upgrades >/dev/null

echo "== Node.js 24"
case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64) ARCH=arm64 ;; *) echo "unsupported CPU $(uname -m)"; exit 1 ;; esac
if ! command -v node >/dev/null || ! node -v | grep -q '^v24\.'; then
  TMP=$(mktemp -d)
  curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$TMP/SHASUMS256.txt"
  FILE=$(grep -o "node-v24[^ ]*-linux-${ARCH}\.tar\.xz" "$TMP/SHASUMS256.txt" | head -1)
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/${FILE}" -o "$TMP/$FILE"
  (cd "$TMP" && grep " ${FILE}\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$TMP/$FILE" -C /usr/local --strip-components=1
  rm -rf "$TMP"
fi
node -v

echo "== swap (small VMs)"
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 2000000 ] && ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== firewall (Oracle images block everything except SSH by default)"
for p in 80 443; do
  iptables -C INPUT -p tcp --dport "$p" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport "$p" -m conntrack --ctstate NEW -j ACCEPT
done
netfilter-persistent save >/dev/null

echo "== user and folders"
id clipzy >/dev/null 2>&1 || useradd --system --home /opt/clipzy --shell /usr/sbin/nologin clipzy
mkdir -p /opt/clipzy/releases /var/lib/clipzy/db /var/lib/clipzy/uploads /etc/clipzy
chown -R clipzy:clipzy /var/lib/clipzy
chmod 750 /var/lib/clipzy
touch /etc/clipzy/clipzy.env && chmod 600 /etc/clipzy/clipzy.env
# Non-secret settings (secrets are added by configure.sh, typed by the owner).
set_env() { grep -q "^$1=" /etc/clipzy/clipzy.env && sed -i "s|^$1=.*|$1=$2|" /etc/clipzy/clipzy.env || echo "$1=$2" >> /etc/clipzy/clipzy.env; }
set_env NODE_ENV production
set_env HOST 127.0.0.1
set_env PORT 4000
set_env TRUST_PROXY 1
set_env BASE_URL "https://${DOMAIN}"
set_env DATA_DIR /var/lib/clipzy/db
set_env UPLOAD_DIR /var/lib/clipzy/uploads

echo "== systemd service"
cat > /etc/systemd/system/clipzy.service <<'UNIT'
[Unit]
Description=Clipzy
After=network-online.target
Wants=network-online.target

[Service]
User=clipzy
Group=clipzy
WorkingDirectory=/opt/clipzy/current
EnvironmentFile=/etc/clipzy/clipzy.env
ExecStartPre=/usr/local/bin/node server/scripts/bootstrap.js
ExecStart=/usr/local/bin/node server/index.js
Restart=always
RestartSec=3
TimeoutStopSec=15
# Hardening: the app can only write to its data folder.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ReadWritePaths=/var/lib/clipzy
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable clipzy >/dev/null

echo "== Caddy (HTTPS certificate is issued automatically on first visit)"
cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
	encode zstd gzip
	reverse_proxy 127.0.0.1:4000
	log {
		output file /var/log/caddy/clipzy.log {
			roll_size 20MiB
			roll_keep 5
		}
	}
}
CADDY
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

echo "== automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

echo
echo "Setup done for https://${DOMAIN}"
echo "Next: run configure.sh (you type the owner password and email settings), then deploy."
