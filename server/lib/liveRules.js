'use strict';
/**
 * Who can go LIVE:
 *   500+ followers  OR  verified  OR  good standing (account age, clean record, a few videos)
 *   OR a manual grant from staff. Everyone else with a clean record gets a periodic "trial LIVE"
 *   (benefit of the doubt) with a time limit. Thresholds are owner-editable ('liveRules').
 */
const { q, now } = require('../db');
const settings = require('./settings');

settings.DEFAULTS.liveRules = {
  minFollowers: 500,
  goodStandingDays: 7,
  goodStandingMaxRisk: 20,
  goodStandingMinVideos: 3,
  goodStandingMinFollowers: 20,
  trialEveryDays: 7,
  trialMinutes: 30,
  trialMaxRisk: 40,
};
const DAY = 86400000;

function eligibility(user) {
  const r = settings.get('liveRules');
  const followers = q.get("SELECT COUNT(*) AS n FROM follows WHERE followee_id = ? AND status = 'accepted'", user.id).n;
  const videos = q.get("SELECT COUNT(*) AS n FROM videos WHERE user_id = ? AND status = 'active' AND is_draft = 0 AND publish_at IS NULL", user.id).n;
  const recentStrikes = q.get("SELECT COUNT(*) AS n FROM user_strikes WHERE user_id = ? AND kind IN ('warning','suspension','ban','restriction') AND created_at > ?", user.id, now() - 30 * DAY).n;
  const granted = !!q.get('SELECT 1 FROM live_access WHERE user_id = ?', user.id);
  const ageDays = (now() - user.created_at) / DAY;
  const risk = user.risk_score || 0;
  const goodStanding = ageDays >= r.goodStandingDays && risk <= r.goodStandingMaxRisk && recentStrikes === 0
    && videos >= r.goodStandingMinVideos && followers >= r.goodStandingMinFollowers;

  const checks = [
    { key: 'followers', label: `${r.minFollowers}+ followers`, met: followers >= r.minFollowers, detail: `${followers} followers` },
    { key: 'verified', label: 'Verified account', met: !!user.is_verified },
    { key: 'standing', label: 'Good standing', met: goodStanding,
      detail: `${r.goodStandingDays}+ day old account, ${r.goodStandingMinVideos}+ videos, ${r.goodStandingMinFollowers}+ followers, no warnings in 30 days` },
  ];
  let via = null;
  if (user.role === 'admin') via = 'staff';
  else if (granted) via = 'granted';
  else if (checks[0].met) via = 'followers';
  else if (checks[1].met) via = 'verified';
  else if (checks[2].met) via = 'standing';
  if (user.live_banned) via = null;

  const lastTrial = q.get('SELECT MAX(started_at) AS t FROM live_streams WHERE user_id = ? AND is_trial = 1', user.id).t;
  const nextTrialAt = lastTrial ? lastTrial + r.trialEveryDays * DAY : 0;
  let trialReason = null;
  if (user.live_banned) trialReason = 'Your LIVE access is restricted';
  else if (recentStrikes) trialReason = 'Trials need a clean record for 30 days';
  else if (risk > r.trialMaxRisk) trialReason = 'Your account is under review';
  else if (ageDays < 1) trialReason = 'Your account must be at least 1 day old';
  else if (nextTrialAt > now()) trialReason = 'You’ve used your trial for now';
  return {
    eligible: !!via,
    via,
    banned: !!user.live_banned,
    checks,
    trial: { available: !via && !trialReason, minutes: r.trialMinutes, nextAt: nextTrialAt > now() ? nextTrialAt : null, reason: trialReason },
  };
}

module.exports = { eligibility };
