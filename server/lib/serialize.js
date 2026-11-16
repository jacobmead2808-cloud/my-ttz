'use strict';
const { q } = require('../db');

/** Columns for a video row joined with its author (u) and sound (s). Requires :me. */
const VIDEO_COLUMNS = `
  v.*, u.username, u.display_name, u.avatar_url, u.is_verified, u.status AS u_status, u.is_private AS u_is_private,
  u.allow_comments AS u_allow_comments,
  s.title AS sound_title, s.artist AS sound_artist, s.file_name AS sound_file,
  (SELECT COUNT(*) FROM likes l WHERE l.video_id = v.id) AS like_count,
  (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id AND c.status = 'active' AND c.held = 0) AS comment_count,
  (SELECT COUNT(*) FROM saves sv WHERE sv.video_id = v.id) AS save_count,
  EXISTS (SELECT 1 FROM likes l WHERE l.video_id = v.id AND l.user_id = :me) AS liked,
  EXISTS (SELECT 1 FROM saves sv WHERE sv.video_id = v.id AND sv.user_id = :me) AS saved,
  (SELECT f.status FROM follows f WHERE f.follower_id = :me AND f.followee_id = v.user_id) AS follow_status,
  (SELECT group_concat(h.tag, ' ') FROM video_hashtags vh JOIN hashtags h ON h.id = vh.hashtag_id WHERE vh.video_id = v.id) AS tags,
  (SELECT COUNT(*) FROM reposts rp WHERE rp.video_id = v.id) AS repost_count,
  EXISTS (SELECT 1 FROM reposts rp WHERE rp.video_id = v.id AND rp.user_id = :me) AS reposted,
  (SELECT ru.username || char(31) || COALESCE(NULLIF(ru.display_name, ''), ru.username) FROM reposts rpf JOIN users ru ON ru.id = rpf.user_id
    JOIN follows ff ON ff.followee_id = rpf.user_id AND ff.follower_id = :me AND ff.status = 'accepted'
    WHERE rpf.video_id = v.id ORDER BY rpf.created_at DESC LIMIT 1) AS rp_follow,
  (SELECT u2.username FROM videos v2 JOIN users u2 ON u2.id = v2.user_id WHERE v2.id = v.remix_of) AS remix_username,
  (SELECT c2.body FROM comments c2 WHERE c2.id = v.reply_comment_id) AS reply_body,
  (SELECT u3.username FROM comments c3 JOIN users u3 ON u3.id = c3.user_id WHERE c3.id = v.reply_comment_id) AS reply_username,
  (SELECT u4.avatar_url FROM comments c4 JOIN users u4 ON u4.id = c4.user_id WHERE c4.id = v.reply_comment_id) AS reply_avatar`;

const VIDEO_FROM = 'FROM videos v JOIN users u ON u.id = v.user_id LEFT JOIN sounds s ON s.id = v.sound_id';

function userBrief(r) {
  if (!r) return null;
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name || r.username,
    avatarUrl: r.avatar_url || null,
    verified: !!r.is_verified,
    owner: !!r.is_owner,
  };
}

function serializeVideo(r, me) {
  const isOwner = !!me && me.id === r.user_id;
  return {
    id: r.id,
    caption: r.caption,
    description: r.description,
    videoUrl: `/media/v/${r.id}?t=${r.updated_at}`,
    mime: r.video_mime,
    thumbUrl: r.thumb_file ? `/media/t/${r.id}?t=${r.updated_at}` : null,
    duration: r.duration,
    width: r.width,
    height: r.height,
    visibility: r.visibility,
    allowComments: !!r.allow_comments,
    status: r.status,
    views: r.views,
    likes: r.like_count,
    comments: r.comment_count,
    saves: r.save_count,
    shares: r.share_count,
    liked: !!r.liked,
    saved: !!r.saved,
    hashtags: r.tags ? r.tags.split(' ') : [],
    reposts: r.repost_count || 0,
    reposted: !!r.reposted,
    repostedBy: r.reposted_by ? { username: r.reposted_by, displayName: r.reposted_by_name || r.reposted_by }
      : r.rp_follow ? { username: r.rp_follow.split('')[0], displayName: r.rp_follow.split('')[1] } : null,
    draft: !!r.is_draft,
    pinned: !!r.pinned_at,
    publishAt: r.publish_at || null,
    allowRemix: r.allow_remix !== 0,
    remix: r.remix_of ? { type: r.remix_type, videoId: r.remix_of, username: r.remix_username || null } : null,
    replyTo: r.reply_comment_id && r.reply_body ? { commentId: r.reply_comment_id, body: r.reply_body, username: r.reply_username, avatarUrl: r.reply_avatar } : null,
    trimStart: r.trim_start || 0,
    trimEnd: r.trim_end || null,
    filter: r.filter || null,
    captionsUrl: r.captions ? `/media/cc/${r.id}?t=${r.updated_at}` : null,
    sound: r.sound_id
      ? { id: r.sound_id, title: r.sound_title, artist: r.sound_artist, url: `/media/s/${r.sound_file}`, original: false }
      : { id: null, title: `original sound - ${r.username}`, artist: r.display_name || r.username, url: null, original: true },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    isOwner,
    author: {
      id: r.user_id,
      username: r.username,
      displayName: r.display_name || r.username,
      avatarUrl: r.avatar_url || null,
      verified: !!r.is_verified,
      isPrivate: !!r.u_is_private,
      followStatus: isOwner ? 'self' : r.follow_status || null,
    },
  };
}

/** Fetch one video row (joined) regardless of visibility. */
function getVideoRow(id, meId = 0) {
  return q.get(`SELECT ${VIDEO_COLUMNS} ${VIDEO_FROM} WHERE v.id = :id`, { id, me: meId });
}

function userProfile(r) {
  return {
    ...userBrief(r),
    bio: r.bio,
    isPrivate: !!r.is_private,
    createdAt: r.created_at,
  };
}

module.exports = { VIDEO_COLUMNS, VIDEO_FROM, serializeVideo, getVideoRow, userBrief, userProfile };
