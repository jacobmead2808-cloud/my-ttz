'use strict';
/**
 * Clipzy logo renderer (no image libraries): blue tile, white play triangle, sky-blue dot.
 * Draws anti-aliased PNGs for web icons, Android launcher icons, splash screens and
 * notification icons. Used by server/scripts/make-icons.js and apps/mobile/scripts/make-assets.js.
 */
const zlib = require('zlib');

const BLUE_A = [31, 111, 235];  // #1f6feb
const BLUE_B = [26, 95, 208];   // #1a5fd0
const DOT = [14, 165, 233];     // #0ea5e9

function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
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
function encode(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));

// Glyph in "tile units" (the tile is the unit square).
const TRI = { x0: 0.39, x1: 0.74, half: 0.215 };
const inTri = (u, v) => u >= TRI.x0 && u <= TRI.x1 && Math.abs(v - 0.5) <= TRI.half * (1 - (u - TRI.x0) / (TRI.x1 - TRI.x0));
const inDot = (u, v) => Math.hypot(u - 0.297, v - 0.703) < 0.07;
function inShape(shape, u, v, pad = 0) {
  if (shape === 'full') return u >= 0 && u <= 1 && v >= 0 && v <= 1;
  if (shape === 'circle') return Math.hypot(u - 0.5, v - 0.5) <= 0.5 - pad;
  const r = 0.22, x0 = pad, x1 = 1 - pad;
  if (u < x0 || v < x0 || u > x1 || v > x1) return false;
  const cx = u < x0 + r ? x0 + r : u > x1 - r ? x1 - r : u;
  const cy = v < x0 + r ? x0 + r : v > x1 - r ? x1 - r : v;
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
}

/**
 * @param {object} o
 *   w, h        canvas size in px
 *   bg          null (transparent) or '#rrggbb' canvas background
 *   tile        { x, y, size, shape: 'rounded'|'circle'|'full', pad } where the logo tile is drawn (px);
 *               shape 'none' draws only the glyph (for adaptive foregrounds / notification icons)
 *   mono        draw the glyph all-white (notification / badge icons)
 */
function render({ w, h, bg = null, tile, mono = false, ss = 4 }) {
  const out = Buffer.alloc(w * h * 4);
  const back = bg ? hex(bg) : null;
  const shape = tile.shape || 'rounded';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss, py = y + (sy + 0.5) / ss;
          const u = (px - tile.x) / tile.size, v = (py - tile.y) / tile.size;
          let c = back, alpha = back ? 1 : 0;
          const glyphTri = inTri(u, v), glyphDot = inDot(u, v);
          if (shape === 'none') {
            if (glyphTri || glyphDot) { c = mono ? [255, 255, 255] : glyphDot ? DOT : [255, 255, 255]; alpha = 1; }
          } else if (inShape(shape, u, v, tile.pad || 0)) {
            const t = (u + v) / 2;
            c = BLUE_A.map((k, i) => k + (BLUE_B[i] - k) * t);
            if (glyphTri) c = [255, 255, 255];
            else if (glyphDot) c = mono ? [255, 255, 255] : DOT;
            alpha = 1;
          }
          if (alpha) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
        }
      }
      const o = (y * w + x) * 4;
      const n = ss * ss;
      if (a) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return encode(w, h, out);
}

/** Convenience: a square icon whose tile fills `fill` of the canvas, centred. */
function square(size, { shape = 'rounded', fill = 1, pad = 0, bg = null, mono = false } = {}) {
  const t = size * fill;
  return render({ w: size, h: size, bg, mono, tile: { x: (size - t) / 2, y: (size - t) / 2, size: t, shape, pad } });
}

module.exports = { render, square, BRAND_BLUE: '#1f6feb', SPLASH_BG: '#0e0e10' };
