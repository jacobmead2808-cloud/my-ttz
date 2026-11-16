'use strict';
const express = require('express');
const v = require('../lib/validate');
const { notFound, bad } = require('../lib/errors');
const { requireAuth } = require('../lib/auth');
const { limit } = require('../lib/rateLimit');
const access = require('../lib/access');
const party = require('../realtime/party');
const { serializeVideo, getVideoRow } = require('../lib/serialize');

const router = express.Router();
router.use(requireAuth);

router.post('/', limit({ windowMs: 3600000, max: 20, key: (req) => `party:${req.user.id}` }), (req, res) => {
  const id = v.int(req.body.videoId, 'video');
  const row = getVideoRow(id, req.user.id);
  if (!row || !access.canViewVideo(req.user, row) || row.visibility !== 'public') throw bad('Only public videos can be watched in a party');
  const p = party.create(req.user, [id]);
  res.status(201).json({ code: p.code });
});

router.get('/:code', (req, res) => {
  const p = party.get(req.params.code);
  if (!p) throw notFound('This watch party has ended');
  const videos = p.queue.map((id) => getVideoRow(id, req.user.id)).filter(Boolean).filter((r) => access.canViewVideo(req.user, r)).map((r) => serializeVideo(r, req.user));
  res.json({ ...party.state(p), videos, reactions: party.REACTIONS });
});

module.exports = router;
