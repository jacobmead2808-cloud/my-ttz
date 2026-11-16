'use strict';
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const bad = (msg, extra) => new HttpError(400, msg, extra);
const unauthorized = (msg = 'Please log in to continue') => new HttpError(401, msg);
const forbidden = (msg = 'You do not have permission to do that') => new HttpError(403, msg);
const notFound = (msg = 'Not found') => new HttpError(404, msg);
const conflict = (msg) => new HttpError(409, msg);
const tooMany = (msg = 'Too many requests, slow down a little') => new HttpError(429, msg);

module.exports = { HttpError, bad, unauthorized, forbidden, notFound, conflict, tooMany };
