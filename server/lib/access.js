'use strict';
const { q } = require('../db');

/** SQL: true when users a and b have blocked each other in either direction. */
const blockedEither = (a, b) =>
  `EXISTS (SELECT 1 FROM blocks bk WHERE (bk.blocker_id = ${a} AND bk.blocked_id = ${b}) OR (bk.blocker_id = ${b} AND bk.blocked_id = ${a}))`;

/**
 * SQL WHERE fragment (aliases: v = videos, u = author) selecting videos the viewer :me may see.
 * Pass me = 0 for anonymous visitors.
 */
const VISIBLE_VIDEO = `v.status = 'active' AND v.is_draft = 0 AND v.publish_at IS NULL AND u.status = 'active' AND (
  v.user_id = :me OR (
    v.visibility <> 'private'
    AND NOT ${blockedEither(':me', 'v.user_id')}
    AND (
      (v.visibility = 'public' AND u.is_private = 0)
      OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = :me AND f.followee_id = v.user_id AND f.status = 'accepted')
    )
  )
)`;

/** SQL fragment hiding users that block / are blocked by :me, and inactive users (alias u). */
const VISIBLE_USER = `u.status = 'active' AND NOT ${blockedEither(':me', 'u.id')}`;

function isBlocked(a, b) {
  if (!a || !b) return false;
  return !!q.get('SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)', a, b, b, a);
}

function followStatus(follower, followee) {
  if (!follower || !followee) return null;
  const r = q.get('SELECT status FROM follows WHERE follower_id = ? AND followee_id = ?', follower, followee);
  return r ? r.status : null;
}

const isFollowing = (a, b) => followStatus(a, b) === 'accepted';
const isFriends = (a, b) => isFollowing(a, b) && isFollowing(b, a);

/** Can viewer see the content (videos, lists) of owner's profile? */
function canViewProfile(viewer, owner) {
  if (viewer && (viewer.id === owner.id || viewer.role === 'admin')) return true;
  if (owner.status !== 'active') return false;
  if (viewer && isBlocked(viewer.id, owner.id)) return false;
  if (!owner.is_private) return true;
  return !!viewer && isFollowing(viewer.id, owner.id);
}

/** Can viewer watch this video? video must include author fields (u_status, u_is_private). */
function canViewVideo(viewer, video) {
  if (viewer && viewer.role === 'admin') return true;
  if (viewer && viewer.id === video.user_id) return video.status === 'active';
  if (video.status !== 'active' || video.u_status !== 'active') return false;
  if (video.is_draft || video.publish_at) return false;
  if (video.visibility === 'private') return false;
  if (viewer && isBlocked(viewer.id, video.user_id)) return false;
  if (video.visibility === 'public' && !video.u_is_private) return true;
  return !!viewer && isFollowing(viewer.id, video.user_id);
}

/** Can actor comment on the video (respects video toggle + author's comment privacy). */
function canComment(actor, video) {
  if (!actor) return false;
  if (!video.allow_comments) return false;
  if (actor.id === video.user_id) return true;
  if (isBlocked(actor.id, video.user_id)) return false;
  const pref = video.u_allow_comments || 'everyone';
  if (pref === 'none') return false;
  if (pref === 'followers') return isFollowing(actor.id, video.user_id);
  return true;
}

/** Can sender start/continue a DM with recipient? */
function canMessage(sender, recipient) {
  if (!sender || !recipient || sender.id === recipient.id) return { ok: false, reason: 'You cannot message yourself' };
  if (recipient.status !== 'active') return { ok: false, reason: 'This account is unavailable' };
  if (isBlocked(sender.id, recipient.id)) return { ok: false, reason: 'You cannot message this account' };
  if (sender.role === 'admin') return { ok: true };
  if (recipient.allow_messages === 'none') return { ok: false, reason: 'This user does not accept messages' };
  if (recipient.allow_messages === 'friends' && !isFriends(sender.id, recipient.id))
    return { ok: false, reason: 'This user only accepts messages from friends (people who follow each other)' };
  return { ok: true };
}

module.exports = { VISIBLE_VIDEO, VISIBLE_USER, blockedEither, isBlocked, followStatus, isFollowing, isFriends, canViewProfile, canViewVideo, canComment, canMessage };
