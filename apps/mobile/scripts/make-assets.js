'use strict';
/**
 * Writes Clipzy's Android launcher icons (legacy, round, adaptive + themed), splash screens and the
 * notification icon into android/app/src/main/res. Run: npm run assets
 */
const fs = require('fs');
const path = require('path');
const { render, square, BRAND_BLUE, SPLASH_BG } = require('../../../server/scripts/icon-art');

const res = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');
if (!fs.existsSync(res)) { console.error('No Android project yet. Run: npx cap add android'); process.exit(1); }
const put = (dir, name, buf) => { fs.mkdirSync(path.join(res, dir), { recursive: true }); fs.writeFileSync(path.join(res, dir, name), buf); };
const DENS = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

for (const [d, k] of Object.entries(DENS)) {
  const launcher = Math.round(48 * k);
  put(`mipmap-${d}`, 'ic_launcher.png', square(launcher, { pad: 0.04 }));
  put(`mipmap-${d}`, 'ic_launcher_round.png', square(launcher, { shape: 'circle', pad: 0.02 }));
  // Adaptive foreground: 108dp canvas, glyph inside the 66dp safe zone (also used as the themed/monochrome icon).
  put(`mipmap-${d}`, 'ic_launcher_foreground.png', square(Math.round(108 * k), { shape: 'none', fill: 0.78 }));
  put(`mipmap-${d}`, 'ic_launcher_monochrome.png', square(Math.round(108 * k), { shape: 'none', fill: 0.78, mono: true }));
  // Status-bar notification icon: white silhouette, 24dp.
  put(`drawable-${d}`, 'ic_stat_notify.png', square(Math.round(24 * k), { shape: 'none', fill: 1.5, mono: true }));
  // Android 12+ splash icon: 288dp canvas, logo inside the 192dp circle.
  put(`drawable-${d}`, 'splash_icon.png', square(Math.round(288 * k), { fill: 0.44 }));
  // Pre-Android 12 full-screen splash images.
  for (const [orient, w, h] of [['port', 320, 480], ['land', 480, 320]]) {
    const W = Math.round(w * k), H = Math.round(h * k), t = Math.min(W, H) * 0.24;
    put(`drawable-${orient}-${d}`, 'splash.png', render({ w: W, h: H, bg: SPLASH_BG, tile: { x: (W - t) / 2, y: (H - t) / 2, size: t } }));
  }
}
{
  const t = 320 * 0.24;
  put('drawable', 'splash.png', render({ w: 480, h: 320, bg: SPLASH_BG, tile: { x: (480 - t) / 2, y: (320 - t) / 2, size: t } }));
}

fs.writeFileSync(path.join(res, 'values', 'ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BRAND_BLUE}</color>\n</resources>\n`);
const adaptive = (fg) => `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/${fg}"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
`;
put('mipmap-anydpi-v26', 'ic_launcher.xml', Buffer.from(adaptive('ic_launcher_foreground')));
put('mipmap-anydpi-v26', 'ic_launcher_round.xml', Buffer.from(adaptive('ic_launcher_foreground')));
// Remove Capacitor's stock vector logo (replaced by the PNG foregrounds above).
for (const f of ['drawable-v24/ic_launcher_foreground.xml', 'drawable/ic_launcher_background.xml']) fs.rmSync(path.join(res, f), { force: true });
console.log('Android icons, splash screens and notification icon written.');
