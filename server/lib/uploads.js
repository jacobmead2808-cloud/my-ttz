'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');
const { bad } = require('./errors');

const storage = multer.diskStorage({
  destination: config.dirs.tmp,
  filename: (_req, _file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
});

const VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v', 'video/ogg'];
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function fileFilter(_req, file, cb) {
  const isVideo = file.fieldname === 'video';
  const mime = file.mimetype.split(';')[0];
  const ok = file.fieldname === 'media' ? VIDEO_MIMES.includes(mime) || IMAGE_MIMES.includes(mime)
    : isVideo ? VIDEO_MIMES.includes(mime) : IMAGE_MIMES.includes(mime);
  cb(ok ? null : bad(isVideo ? 'Unsupported video format. Use MP4, WebM or MOV.' : 'Unsupported image format. Use JPG, PNG, WebP or GIF.'), ok);
}

const videoUpload = multer({ storage, fileFilter, limits: { fileSize: config.maxVideoBytes, files: 2, fields: 40 } })
  .fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]);
const storyUpload = multer({ storage, fileFilter, limits: { fileSize: 60 * 1024 * 1024, files: 1, fields: 10 } }).single('media');
const imageUpload = (field) => multer({ storage, fileFilter, limits: { fileSize: config.maxImageBytes, files: 1, fields: 10 } }).single(field);

/** Detect real file type from magic bytes (never trust the client-provided mimetype). */
function sniff(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(16);
  fs.readSync(fd, b, 0, 16, 0);
  fs.closeSync(fd);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', mime: 'image/jpeg', ext: '.jpg' };
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image', mime: 'image/png', ext: '.png' };
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp', ext: '.webp' };
  if (b.toString('ascii', 0, 4) === 'GIF8') return { kind: 'image', mime: 'image/gif', ext: '.gif' };
  if (b.readUInt32BE(0) === 0x1a45dfa3) return { kind: 'video', mime: 'video/webm', ext: '.webm' };
  if (b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12);
    if (brand.startsWith('qt')) return { kind: 'video', mime: 'video/quicktime', ext: '.mov' };
    return { kind: 'video', mime: 'video/mp4', ext: '.mp4' };
  }
  if (b.toString('ascii', 0, 4) === 'OggS') return { kind: 'video', mime: 'video/ogg', ext: '.ogv' };
  return null;
}

function discard(...files) {
  for (const f of files.flat()) if (f && f.path) fs.rm(f.path, { force: true }, () => {});
}

/** Validate an uploaded temp file and move it into its permanent folder. Returns the stored file name. */
function store(file, kind, dir) {
  const info = sniff(file.path);
  if (!info || info.kind !== kind) {
    discard(file);
    throw bad(kind === 'video' ? 'That file is not a valid video' : 'That file is not a valid image');
  }
  const name = crypto.randomBytes(16).toString('hex') + info.ext;
  fs.renameSync(file.path, path.join(dir, name));
  return { name, mime: info.mime };
}

function removeStored(dir, name) {
  if (!name) return;
  const p = path.join(dir, path.basename(name));
  fs.rm(p, { force: true }, () => {});
}

module.exports = { videoUpload, imageUpload, storyUpload, store, discard, removeStored, sniff };
