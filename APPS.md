# Clipzy apps: installable website, Android app, desktop app

Every version opens your **hosted** site (see [DEPLOY.md](DEPLOY.md)), so they all share the same
accounts, videos, messages and database. Updating the website updates every app; the Android app
only needs rebuilding when its native parts change (icon, permissions, plugins).

| | Where people get it | Status |
|---|---|---|
| 1. Installable website (PWA) | "Install" on your site | Built and tested |
| 2. Android app (APK + Google Play AAB) | APK download link / Google Play | Built and tested on an Android 17 emulator |
| 3. Desktop app (Windows `.exe`) | download link | Built earlier (`apps/desktop`) |

---

## 1. Installable website (PWA)

Nothing to build. On your `https://` site:
- **Android (Chrome):** an **Install Clipzy** bar appears at the bottom, or ⋮ → **Install app**.
- **Windows / Mac / ChromeOS (Chrome, Edge):** the install bar, or the install icon in the address bar.
- **iPhone (Safari):** Share → **Add to Home Screen** (`/download` shows these steps).

It opens in its own window with the Clipzy icon, shows an **offline** screen when there's no connection,
and supports **push notifications** (Settings → Notifications → Turn on).

Tested: manifest and installability report no errors in Chrome; offline screen served by the service
worker when the server is down; real push delivered through Microsoft's push service and shown by Edge.
Through Google's push service the message was accepted, but a temporary automated Chrome profile
didn't display it, so test once on a real phone after you deploy.

## 2. Android app (`apps/mobile`)

A Capacitor app (`com.clipzy.app`) that opens your site, with:
- Clipzy icon (adaptive + themed) and splash screen
- camera, microphone and gallery uploads (system photo picker, no storage permission)
- Android back button, safe areas for gesture/notch phones
- push notifications through Firebase
- phones and tablets

Coins can't be bought inside the Android app, because Google Play requires its own billing for digital
items. Balances and gifts work normally, and purchases stay available on the website.

### One-time setup
Requirements on your PC (already present on this machine): Android Studio (SDK) and JDK 21.
```bash
cd apps/mobile
npm install
```

### Build the release APK + AAB
1. **Create your signing key** (once; you pick the password):
   ```bash
   npm run keystore
   ```
   Back up `apps/mobile/android/clipzy-release.jks` and the password (password manager). Google Play
   only accepts updates signed with this key.
2. **Build** with your live address:
   ```bash
   npm run build:android -- --url https://your-domain
   ```
   You get `apps/mobile/dist/clipzy-1.0.0.apk` (install directly) and `clipzy-1.0.0.aab` (Google Play).
   The build refuses `localhost`, `http://` and placeholder addresses.
3. For every new version, raise `versionCode` (and `version`) in `apps/mobile/package.json`.

### Push notifications in the Android app (needs a free Firebase project)
1. console.firebase.google.com → **Add project** → **Add app → Android**, package name `com.clipzy.app`.
2. Download `google-services.json` → put it in `apps/mobile/android/app/`.
3. Project settings → **Service accounts → Generate new private key** → put that JSON in the server
   variable `FIREBASE_SERVICE_ACCOUNT` (Railway → Variables, paste as one line).
4. Rebuild the app (step 2 above). Push is only included when `google-services.json` is present.

Browser and installed-website push needs none of this.

### Sharing the APK
Upload `clipzy-x.y.z.apk` (e.g. GitHub → Releases) and put the link in `public/js/brand.js` →
`downloads.android`. People must allow "Install unknown apps" for their browser.

### Google Play
1. play.google.com/console, one-time $25 developer registration (identity verification).
2. Create app → fill the store listing, content rating, data safety (see `/privacy`), target audience
   13+ → **Production / Internal testing → Create release** → upload the `.aab`.
3. Use **Play App Signing** (default). Your key becomes the upload key.

### Testing on this PC
```bash
npm run build:android:dev
```
This builds `dist/clipzy-dev.apk` ("Clipzy Dev"), which talks to `http://localhost:4000` on your PC.
Start an emulator from Android Studio and run Clipzy (`npm run dev`) on port 4000, then:
```bash
adb reverse tcp:4000 tcp:4000
```
```bash
adb install -r dist/clipzy-dev.apk
```

Tested on the emulator (Android 17):
- launch with icon and splash
- the feed plays
- login works
- gallery upload, posting and playback all worked
- camera + microphone permission prompts work and grant access
- back button navigation works
- layout fits under the status bar and above the gesture bar

### Regenerating icons / splash
`npm run assets` (Android) and `node server/scripts/make-icons.js` (web) redraw everything from the logo.

## 3. Desktop app (`apps/desktop`)
Set `"url"` in `apps/desktop/config.json` to your `https://` address, then `npm run dist:win`.
See the comments in that folder.
