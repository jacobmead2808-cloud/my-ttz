'use strict';
/**
 * Speech-to-text for auto-captions. Not configured by default.
 * Set STT_PROVIDER=openai and OPENAI_API_KEY (optional STT_MODEL, default "whisper-1").
 * The provider must accept the uploaded file (mp4/webm, max 25 MB) and return WebVTT.
 */
const fs = require('fs');
const path = require('path');
const { HttpError } = require('./errors');

async function transcribe(file, mime) {
  const provider = (process.env.STT_PROVIDER || '').toLowerCase();
  if (provider !== 'openai' || !process.env.OPENAI_API_KEY) {
    throw new HttpError(501, 'Auto-captions need a speech-to-text provider. Set STT_PROVIDER=openai and OPENAI_API_KEY in .env, or add captions manually.');
  }
  const stat = fs.statSync(file);
  if (stat.size > 25 * 1024 * 1024) throw new HttpError(400, 'Video is too large for auto-captions (25 MB limit). Add captions manually.');
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: mime }), path.basename(file));
  form.append('model', process.env.STT_MODEL || 'whisper-1');
  form.append('response_format', 'vtt');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!r.ok) throw new HttpError(502, `Speech-to-text failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  const vtt = (await r.text()).trim();
  if (!vtt.startsWith('WEBVTT')) throw new HttpError(502, 'Speech-to-text returned an unexpected format');
  return vtt.slice(0, 20000);
}

module.exports = { transcribe };
