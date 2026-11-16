#!/usr/bin/env bash
# Private settings for the Clipzy server. YOU type these; they are stored only in
# /etc/clipzy/clipzy.env on the server (readable by root only) and are never shown or logged.
# Run on the server:  sudo bash configure.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
ENV=/etc/clipzy/clipzy.env
[ -f "$ENV" ] || { echo "Run setup.sh first"; exit 1; }

set_env() { local k="$1" v="$2"; sed -i "/^${k}=/d" "$ENV"; printf "%s='%s'\n" "$k" "$v" >> "$ENV"; }
safe() { case "$1" in *"'"*|*'\'*) return 1 ;; *) return 0 ;; esac; }
ask() { local p="$1" v; read -r -p "$p" v; printf '%s' "$v"; }
ask_secret() { local p="$1" v; read -r -s -p "$p" v; echo >&2; printf '%s' "$v"; }

echo "Clipzy server settings (press Enter to keep a value that is already set)."
echo

if grep -q '^ADMIN_EMAIL=' "$ENV" && [ -s /var/lib/clipzy/db/app.db ]; then
  echo "Owner account: already created on this server."
else
  echo "-- Owner account (you). Created once on first start."
  E=$(ask "Your email (for password resets, never shown publicly): ")
  U=$(ask "Your username (public, not your email): ")
  while :; do
    P=$(ask_secret "Owner password (10+ characters): ")
    P2=$(ask_secret "Repeat password: ")
    [ "$P" = "$P2" ] || { echo "Passwords don't match."; continue; }
    [ ${#P} -ge 10 ] || { echo "Too short."; continue; }
    safe "$P" || { echo "Please avoid ' and \\ characters."; continue; }
    break
  done
  set_env ADMIN_EMAIL "$E"; set_env ADMIN_USERNAME "$U"; set_env ADMIN_PASSWORD "$P"
fi

echo
echo "-- Email for sign-up confirmation and password resets (free with Gmail)."
echo "   Needs a Gmail app password: myaccount.google.com -> Security -> 2-Step Verification -> App passwords."
G=$(ask "Gmail address to send from (Enter to skip): ")
if [ -n "$G" ]; then
  A=$(ask_secret "16-letter app password: ")
  safe "$A" || { echo "Invalid characters"; exit 1; }
  set_env MAIL_PROVIDER smtp; set_env SMTP_HOST smtp.gmail.com; set_env SMTP_PORT 465
  set_env SMTP_USER "$G"; set_env SMTP_PASS "$A"; set_env MAIL_FROM "Clipzy <$G>"
  sed -i '/^REQUIRE_EMAIL_VERIFICATION=/d' "$ENV"
elif ! grep -q '^MAIL_PROVIDER=' "$ENV"; then
  echo "   Skipped: new accounts won't need to confirm their email and password reset won't work."
  set_env REQUIRE_EMAIL_VERIFICATION false
fi

echo
C=$(ask "Public contact email for the Terms/Privacy pages (Enter to skip): ")
[ -n "$C" ] && set_env CONTACT_EMAIL "$C"

if ! grep -q '^VERIFY_KEY=' "$ENV"; then
  echo
  K=$(ask_secret "Secret key for giving verification badges (Enter to generate one): ")
  if [ -z "$K" ]; then K=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 28); echo "Your verify key: $K   <- save it in your password manager"; fi
  set_env VERIFY_KEY "$K"
fi

chmod 600 "$ENV"
echo
echo "Saved. Restarting Clipzy..."
systemctl restart clipzy 2>/dev/null || true
sleep 3
systemctl is-active clipzy >/dev/null && echo "Clipzy is running." || { echo "Clipzy did not start. Last log lines:"; journalctl -u clipzy -n 15 --no-pager; }
