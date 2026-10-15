import { HttpError } from "../lib/errors.js";

// At most `max` requests per `windowMs` per signed-in account (or address,
// before sign-in) — so one client can't use up the server's TMDB quota.
// Counts are kept in memory, which is fine for a single server.
export const rateLimit = ({ windowMs = 60 * 1000, max = 120 } = {}) => {
  const hits = new Map(); // key → { count, resetAt }
  return (req, res, next) => {
    const now = Date.now();
    const key = req.userId ?? req.ip;
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
      if (hits.size > 10_000) {
        for (const [other, value] of hits) if (value.resetAt <= now) hits.delete(other);
      }
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return next(new HttpError(429, "Too many requests — slow down a little"));
    }
    next();
  };
};

export default rateLimit;
