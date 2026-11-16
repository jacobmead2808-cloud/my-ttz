'use strict';
// Side effects when a video goes public (immediately, from a draft, or when its schedule fires),
// plus the background scheduler for scheduled posts and expiring stories.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { q, now } = require('../db');
const { notify, notifyMentions } = require('./notify');
require('./liveRules'); // registers liveRules defaults

function onPublished(videoId) {
  const v = q.get('SELECT * FROM videos WHERE id = ?', videoId);
  if (!v || v.status !== 'active' || v.is_draft || v.publish_at) return;
  const notified = [v.user_id];
  if (v.remix_of) {
    const orig = q.get('SELECT user_id FROM videos WHERE id = ?', v.remix_of);
    if (orig) { notify({ userId: orig.user_id, actorId: v.user_id, type: v.remix_type === 'stitch' ? 'stitch' : 'duet', videoId: v.id }); notified.push(orig.user_id); }
  }
  if (v.reply_comment_id) {
    const c = q.get('SELECT user_id, body FROM comments WHERE id = ?', v.reply_comment_id);
    if (c) { notify({ userId: c.user_id, actorId: v.user_id, type: 'video_reply', videoId: v.id, body: c.body.slice(0, 140) }); notified.push(c.user_id); }
  }
  if (v.visibility !== 'private') notifyMentions(`${v.caption} ${v.description}`, { actorId: v.user_id, videoId: v.id, exclude: notified });
}

/** Publish due scheduled videos and delete expired stories. Returns counts (useful in tests). */
function tick() {
  const due = q.all('SELECT id FROM videos WHERE publish_at IS NOT NULL AND publish_at <= ? AND is_draft = 0', now());
  for (const d of due) {
    q.run('UPDATE videos SET publish_at = NULL, created_at = ?, updated_at = ? WHERE id = ?', now(), now(), d.id);
    onPublished(d.id);
  }
  const expired = q.all('SELECT id, media_file FROM stories WHERE expires_at <= ?', now());
  for (const s of expired) {
    q.run('DELETE FROM stories WHERE id = ?', s.id);
    fs.rm(path.join(config.dirs.stories, path.basename(s.media_file)), { force: true }, () => {});
  }
  const minutes = require('./settings').get('liveRules').trialMinutes || 30;
  const trials = q.all("SELECT id FROM live_streams WHERE status = 'live' AND is_trial = 1 AND started_at < ?", now() - minutes * 60000);
  for (const t of trials) require('../realtime/live').endStream(t.id, 'trial_ended');
  return { published: due.length, expired: expired.length, trialsEnded: trials.length };
}

function startScheduler() {
  tick();
  setInterval(() => { try { tick(); } catch (e) { console.error('[scheduler]', e); } }, 15000).unref();
}

module.exports = { onPublished, tick, startScheduler };
