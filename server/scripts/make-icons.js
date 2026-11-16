'use strict';
// Generates PNG app icons (no image libraries needed): node server/scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, maskable) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const r = maskable ? 0 : size * 0.22;
  const pad = maskable ? 0 : size * 0.04;
  const inside = (x, y) => {
    const x0 = pad, y0 = pad, x1 = size - pad, y1 = size - pad;
    if (x < x0 || y < y0 || x > x1 || y > y1) return false;
    const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
    const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  // play triangle
  const s = maskable ? 0.62 : 0.72;
  const tx0 = size * (0.5 - 0.17 * s / 0.72 * 1.1), tx1 = size * (0.5 + 0.24 * s / 0.72);
  const ty0 = size * (0.5 - 0.26 * s / 0.72), ty1 = size * (0.5 + 0.26 * s / 0.72);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      if (!inside(x + 0.5, y + 0.5)) { raw[o + 3] = 0; continue; }
      const t = (x + y) / (2 * size);
      let R = Math.round(31 + (26 - 31) * t), G = Math.round(111 + (95 - 111) * t), B = Math.round(235 + (208 - 235) * t);
      const midY = (ty0 + ty1) / 2;
      const half = (ty1 - ty0) / 2;
      const inTri = x >= tx0 && x <= tx1 && Math.abs(y - midY) <= half * (1 - (x - tx0) / (tx1 - tx0));
      if (inTri) { R = 255; G = 255; B = 255; }
      const dot = Math.hypot(x - size * 0.3, y - size * 0.7) < size * 0.06;
      if (dot) { R = 14; G = 165; B = 233; }
      raw[o] = R; raw[o + 1] = G; raw[o + 2] = B; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const out = path.join(__dirname, '..', '..', 'public', 'assets', 'brand');
for (const [name, size, mask] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-maskable-512.png', 512, true], ['apple-touch-icon.png', 180, true]]) {
  fs.writeFileSync(path.join(out, name), png(size, mask));
}
console.log('Icons written to public/assets/brand');
