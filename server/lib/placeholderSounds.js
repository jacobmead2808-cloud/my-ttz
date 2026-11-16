'use strict';
// Synthesised placeholder music loops (WAV). Replace with real tracks in uploads/sounds + the sounds table.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { q, now } = require('../db');

function makeWav(file, { bpm, notes, wave, seconds = 8 }) {
  const rate = 22050;
  const len = rate * seconds;
  const data = Buffer.alloc(len * 2);
  const beat = 60 / bpm;
  const step = beat / 2;
  for (let i = 0; i < len; i++) {
    const t = i / rate;
    const idx = Math.floor(t / step);
    const local = t - idx * step;
    const freq = 440 * Math.pow(2, (notes[idx % notes.length] - 69) / 12);
    const env = Math.exp(-local * 6) * Math.min(1, local * 200);
    let s;
    const ph = 2 * Math.PI * freq * t;
    if (wave === 'square') s = Math.sign(Math.sin(ph)) * 0.35;
    else if (wave === 'saw') s = ((freq * t) % 1) * 2 - 1;
    else s = Math.sin(ph) + 0.3 * Math.sin(2 * ph);
    s *= 0.28 * env;
    // kick on every beat
    const bt = t % beat;
    s += Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-bt * 30)) * bt) * Math.exp(-bt * 12) * 0.5;
    // hat on off-beats
    const ht = (t + beat / 2) % beat;
    s += (Math.random() * 2 - 1) * Math.exp(-ht * 60) * 0.08;
    data.writeInt16LE(Math.max(-1, Math.min(1, s)) * 32000 | 0, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return seconds;
}

const SOUNDS = [
  { title: 'Sunny Side Loop', artist: 'Clipzy Sounds', bpm: 118, wave: 'sine', notes: [72, 76, 79, 76, 74, 77, 81, 77, 72, 76, 79, 84, 83, 79, 76, 74] },
  { title: 'Night Drive', artist: 'Clipzy Sounds', bpm: 100, wave: 'saw', notes: [57, 60, 64, 60, 55, 59, 62, 59, 53, 57, 60, 57, 55, 59, 62, 67] },
  { title: 'Pixel Party', artist: 'Clipzy Sounds', bpm: 128, wave: 'square', notes: [76, 76, 79, 81, 79, 76, 74, 72, 74, 76, 79, 76, 74, 72, 71, 72] },
  { title: 'Lo-fi Study Beat', artist: 'Clipzy Sounds', bpm: 84, wave: 'sine', notes: [64, 67, 71, 74, 72, 71, 67, 64, 62, 65, 69, 72, 71, 69, 65, 62] },
  { title: 'Victory Lap', artist: 'Clipzy Sounds', bpm: 140, wave: 'square', notes: [72, 72, 79, 79, 81, 81, 79, 77, 77, 76, 76, 74, 74, 72, 67, 72] },
];


/** Writes the loops and inserts sound rows (once). Returns the sound ids. */
function createPlaceholderSounds() {
  const existing = q.all("SELECT id FROM sounds WHERE file_name LIKE 'seed-sound-%' ORDER BY id");
  if (existing.length) return existing.map((r) => r.id);
  return SOUNDS.map((s, i) => {
    const file = `seed-sound-${i + 1}.wav`;
    const dur = makeWav(path.join(config.dirs.sounds, file), s);
    return Number(q.run('INSERT INTO sounds (title, artist, file_name, duration, created_at) VALUES (?, ?, ?, ?, ?)', s.title, s.artist, file, dur, now()).lastInsertRowid);
  });
}

module.exports = { createPlaceholderSounds };
