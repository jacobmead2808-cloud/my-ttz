'use strict';
const { tooMany } = require('./errors');

/** Tiny fixed-window in-memory rate limiter (single process). */
function createLimiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const t = Date.now();
    for (const [k, v] of hits) if (v.reset < t) hits.delete(k);
  }, windowMs).unref();
  return function check(key) {
    const t = Date.now();
    let e = hits.get(key);
    if (!e || e.reset < t) {
      e = { count: 0, reset: t + windowMs };
      hits.set(key, e);
    }
    e.count++;
    return e.count <= max;
  };
}

/** Express middleware factory. keyFn(req) decides the bucket. */
function limit({ windowMs, max, key = (req) => req.ip, message }) {
  const check = createLimiter({ windowMs, max });
  return (req, _res, next) => {
    if (check(key(req))) return next();
    require('./security').record('ratelimit.hit', req, message || null, { severity: 'info' });
    return next(tooMany(message));
  };
}

module.exports = { createLimiter, limit };
