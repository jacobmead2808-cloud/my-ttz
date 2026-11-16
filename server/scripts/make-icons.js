'use strict';
// Generates the web app / PWA icons into public/assets/brand: node server/scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const { square } = require('./icon-art');

const out = path.join(__dirname, '..', '..', 'public', 'assets', 'brand');
const files = {
  'icon-192.png': square(192, { pad: 0.04 }),
  'icon-512.png': square(512, { pad: 0.04 }),
  // Maskable: full-bleed tile; the glyph sits well inside the 80% safe zone.
  'icon-maskable-192.png': square(192, { shape: 'full' }),
  'icon-maskable-512.png': square(512, { shape: 'full' }),
  'apple-touch-icon.png': square(180, { shape: 'full' }),
  // Monochrome badge for Android notification bars (white glyph on transparent).
  'badge-96.png': square(96, { shape: 'none', fill: 1.5, mono: true }),
};
for (const [name, buf] of Object.entries(files)) fs.writeFileSync(path.join(out, name), buf);
console.log(`Icons written to public/assets/brand (${Object.keys(files).join(', ')})`);
