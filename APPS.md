# Clipzy as an app (phone + computer)

Clipzy can be installed three ways. All of them show your **hosted** site (see DEPLOY.md), so put it
online first and use its `https://` address below. Every app updates automatically when you update
the website — no re-downloads needed.

| | Effort | Where people get it |
|---|---|---|
| 1. Install from the browser (PWA) | none — already built in | `/download` page → **Install** |
| 2. Desktop app (.exe / .dmg) like Discord | ~10 min | a download link on your site |
| 3. Phone apps (Android / iPhone) like TikTok | ~30 min + store accounts | Google Play / App Store (or an APK) |

---

## 1. Install from the browser (works today)
Open your site → sidebar **Get the app** (or `/download`). It shows the right steps for each device:
- **Windows / Mac / Chromebook:** Chrome or Edge → **Install** button (or the install icon in the address bar).
- **Android:** Chrome → ⋮ → **Install app**.
- **iPhone / iPad:** Safari → Share → **Add to Home Screen**.

It gets its own icon, opens in its own window and stays signed in. Requires HTTPS (any host in DEPLOY.md).

## 2. Desktop app — Windows `.exe`, Mac `.dmg`, Linux `.AppImage`
The project is in `apps/desktop` (Electron).

1. Install Node.js (you already have it). In VS Code open a terminal:
   ```bash
   cd apps/desktop
   npm install
   ```
2. Edit `apps/desktop/config.json` → set `"url"` to your hosted address (e.g. `https://clipzy.up.railway.app`).
3. Try it: `npm start` (opens Clipzy in its own window).
4. Build the installer:
   ```bash
   npm run dist:win
   ```
   → `apps/desktop/dist/Clipzy-Setup.exe`. (Build the Mac `.dmg` on a Mac with `npm run dist:mac`; Linux with `npm run dist:linux`.)
5. Upload the file somewhere public (easiest: your GitHub repo → **Releases → New release → attach file**),
   then paste the link into `public/js/brand.js` → `downloads.windows`. The **Get the app** page now shows a
   *Download for Windows* button.

Notes: Windows SmartScreen shows “unknown publisher” until you buy a code-signing certificate (~$100–300/yr);
users click **More info → Run anyway**. Mac apps need an Apple Developer account ($99/yr) to sign/notarise,
otherwise users right-click → Open.

## 3. Phone apps — Android & iPhone
The project is in `apps/mobile` (Capacitor wraps your site in a real native app with camera/mic access).

1. Edit `apps/mobile/capacitor.config.json` → `"server": { "url": "https://your-domain" }`.
2. ```bash
   cd apps/mobile
   npm install
   ```
3. **Android** (Windows/Mac/Linux): install **Android Studio**, then:
   ```bash
   npm run android
   ```
   Android Studio opens → plug in your phone (USB debugging on) and press ▶ to test, or
   **Build → Generate Signed App Bundle/APK** to make an `.apk` (share directly) or `.aab` (Google Play).
   Publishing on Google Play: one-time $25 developer account → Play Console → create app → upload the `.aab`.
4. **iPhone** (needs a Mac with Xcode): `npm run ios` → Xcode opens → choose your team → ▶ to test.
   Publishing: Apple Developer Program ($99/yr) → Product → Archive → upload to App Store Connect → submit for review.

The `permissions` script automatically adds camera/microphone permissions (needed for LIVE and Duets).
After changing `capacitor.config.json`, run `npm run sync`.

Then paste your store links into `public/js/brand.js` → `downloads.android` / `downloads.ios`.

---

**Not tested here:** the desktop and phone projects are set up, but building them requires downloading
Electron / Android Studio / Xcode on your machine, so they haven’t been built or run in this environment.
